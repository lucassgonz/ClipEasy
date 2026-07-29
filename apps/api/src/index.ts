import "./env.js";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  centerCropBox,
  checkBinaries,
  clipDurationMs,
  downloadYoutube,
  exportFromTimeline,
  exportImage,
  exportTimelineChunks,
  imageOutputName,
  mustRun,
  probeDurationSeconds,
  probeImageSize,
  recomputeDuration,
  sliceClipsEverySeconds,
  type CaptionCue,
  type ImageAspect,
  type ImageCropBox,
  type Resolution,
  type Timeline,
  type VideoClip,
} from "@clipfacil/pipeline";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { nanoid } from "nanoid";
import { getEnv, requireUser, supabaseConfigured } from "./auth.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  type ClipYoutubeMeta,
  type ProjectRow,
  type YoutubeMeta,
} from "./projects.js";
import {
  assetsDir,
  DATA_DIR,
  outputDir,
  projectDir,
  workDir,
} from "./paths.js";

await mkdir(DATA_DIR, { recursive: true });

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 * 100 });
await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

function statusError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  const status =
    typeof err === "object" &&
    err &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number"
      ? (err as { statusCode: number }).statusCode
      : 500;
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(status).send({ error: message });
}

function getVideoClips(timeline: Timeline): VideoClip[] {
  const video = timeline.tracks.find((t) => t.type === "video");
  if (!video || video.type !== "video") return [];
  return [...video.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
}

function getCaptionCues(timeline: Timeline): CaptionCue[] {
  const track = timeline.tracks.find((t) => t.type === "captions");
  if (!track || track.type !== "captions") return [];
  return track.cues;
}

function parteFilename(index: number): string {
  return `parte_${String(index + 1).padStart(3, "0")}.mp4`;
}

function transcriptForClip(
  cues: CaptionCue[],
  clip: VideoClip,
): string {
  const start = clip.timelineStartMs;
  const end = start + clipDurationMs(clip);
  return cues
    .filter((c) => c.endMs > start && c.startMs < end)
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Stay safely under OpenAI Whisper's 25MB upload limit. */
const WHISPER_MAX_BYTES = 24 * 1024 * 1024;
/** ~15 min @ 32 kbps mono ≈ 3.6MB per chunk. */
const WHISPER_CHUNK_SECONDS = 15 * 60;

async function whisperTranscribeMp3(
  apiKey: string,
  audioPath: string,
): Promise<Array<{ start: number; end: number; text: string }>> {
  const audioBuf = await readFile(audioPath);
  if (audioBuf.byteLength > WHISPER_MAX_BYTES) {
    throw new Error(
      `Trecho de áudio ainda excede 25MB (${audioBuf.byteLength} bytes). Tente um vídeo menor.`,
    );
  }
  const form = new FormData();
  form.append(
    "file",
    new File([audioBuf], "audio.mp3", { type: "audio/mpeg" }),
  );
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI Whisper falhou: ${text}`);
  }
  const json = (await res.json()) as {
    segments?: Array<{ start: number; end: number; text: string }>;
  };
  return json.segments ?? [];
}

async function extractWhisperAudioChunk(
  mediaPath: string,
  outPath: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  await mustRun("ffmpeg", [
    "-y",
    "-ss",
    startSec.toFixed(3),
    "-t",
    durationSec.toFixed(3),
    "-i",
    mediaPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "32k",
    outPath,
  ]);
}

/** Transcribe first video asset with Whisper and write caption cues. */
async function ensureWhisperCaptions(
  project: ProjectRow,
  timeline: Timeline,
  apiKey: string,
  onProgress?: (step: string, percent?: number) => void,
): Promise<Timeline> {
  const existing = getCaptionCues(timeline);
  if (existing.length > 0) return timeline;

  const clips = getVideoClips(timeline);
  if (clips.length === 0) throw new Error("Sem clipes de vídeo");

  const first = clips[0]!;
  const meta = timeline.assets[first.assetId];
  if (!meta) throw new Error("Asset ausente");

  const mediaPath = path.join(
    assetsDir(project.id),
    first.assetId,
    meta.filename,
  );
  const wdir = path.join(workDir(project.id), "whisper");
  await mkdir(wdir, { recursive: true });

  onProgress?.("Medindo duração do áudio…", 5);
  const durationSec = await probeDurationSeconds(mediaPath);
  const chunkCount = Math.max(
    1,
    Math.ceil(durationSec / WHISPER_CHUNK_SECONDS),
  );

  const sourceSegments: Array<{ start: number; end: number; text: string }> =
    [];

  for (let i = 0; i < chunkCount; i += 1) {
    const startSec = i * WHISPER_CHUNK_SECONDS;
    const len = Math.min(WHISPER_CHUNK_SECONDS, durationSec - startSec);
    if (len < 0.25) break;

    // Transcription phase occupies ~5–55% of the overall meta job.
    const chunkPct = Math.round(5 + ((i + 0.35) / chunkCount) * 50);
    onProgress?.(
      chunkCount === 1
        ? "Extraindo áudio para transcrição…"
        : `Extraindo áudio ${i + 1}/${chunkCount}…`,
      chunkPct,
    );
    const chunkPath = path.join(wdir, `chunk_${String(i).padStart(3, "0")}.mp3`);
    await extractWhisperAudioChunk(mediaPath, chunkPath, startSec, len);

    // If a single chunk is somehow still huge, split further by halving.
    let size = (await stat(chunkPath)).size;
    let pieces: Array<{ path: string; offsetSec: number }> = [
      { path: chunkPath, offsetSec: startSec },
    ];
    if (size > WHISPER_MAX_BYTES && len > 60) {
      await rm(chunkPath, { force: true }).catch(() => undefined);
      const half = len / 2;
      pieces = [];
      for (let p = 0; p < 2; p += 1) {
        const subStart = startSec + p * half;
        const subLen = Math.min(half, durationSec - subStart);
        const subPath = path.join(
          wdir,
          `chunk_${String(i).padStart(3, "0")}_${p}.mp3`,
        );
        await extractWhisperAudioChunk(mediaPath, subPath, subStart, subLen);
        pieces.push({ path: subPath, offsetSec: subStart });
      }
    }

    for (let p = 0; p < pieces.length; p += 1) {
      const piece = pieces[p]!;
      size = (await stat(piece.path)).size;
      if (size > WHISPER_MAX_BYTES) {
        throw new Error(
          `Trecho de áudio excede 25MB mesmo após divisão (${size} bytes).`,
        );
      }
      const doneFrac = (i + (p + 1) / pieces.length) / chunkCount;
      const pct = Math.round(5 + doneFrac * 50);
      onProgress?.(
        chunkCount === 1 && pieces.length === 1
          ? "Transcrevendo com Whisper…"
          : `Transcrevendo trecho ${i + 1}/${chunkCount}${pieces.length > 1 ? ` (${p + 1}/${pieces.length})` : ""}…`,
        pct,
      );
      const segs = await whisperTranscribeMp3(apiKey, piece.path);
      for (const seg of segs) {
        sourceSegments.push({
          start: seg.start + piece.offsetSec,
          end: seg.end + piece.offsetSec,
          text: seg.text,
        });
      }
      await rm(piece.path, { force: true }).catch(() => undefined);
    }
  }

  onProgress?.("Alinhando legendas aos clipes…", 55);

  const mapped: CaptionCue[] = sourceSegments.flatMap((seg, i) => {
    const localStartMs = Math.round(seg.start * 1000);
    const localEndMs = Math.round(seg.end * 1000);
    const host =
      clips.find(
        (c) =>
          c.assetId === first.assetId &&
          localStartMs >= c.inMs &&
          localStartMs < c.outMs,
      ) ?? first;
    const speed = host.speed && host.speed > 0 ? host.speed : 1;
    const startMs =
      host.timelineStartMs + Math.round((localStartMs - host.inMs) / speed);
    const endMs =
      host.timelineStartMs + Math.round((localEndMs - host.inMs) / speed);
    if (endMs <= startMs) return [];
    return [
      {
        id: `cue-${i}-${nanoid(4)}`,
        startMs: Math.max(0, startMs),
        endMs: Math.max(startMs + 1, endMs),
        text: seg.text.trim(),
      },
    ];
  });

  const next = structuredClone(timeline);
  const captions = next.tracks.find((t) => t.type === "captions");
  if (captions && captions.type === "captions") {
    captions.cues = mapped;
  }
  next.durationMs = recomputeDuration(next);
  void rm(wdir, { recursive: true, force: true }).catch(() => undefined);
  return next;
}

const CLIP_META_BATCH = 5;

type ClipMetaDraft = {
  index: number;
  title: string;
  description: string;
  hashtags: string[];
};

function isWeakClipMeta(row: ClipMetaDraft): boolean {
  const title = row.title.trim();
  const desc = row.description.trim();
  if (!title || !desc) return true;
  // Old fallback when GPT omitted an index — treat as incomplete.
  if (/^clipe\s*\d+$/i.test(title)) return true;
  return false;
}

async function generateClipMetaBatchOnce(
  apiKey: string,
  items: Array<{ index: number; filename: string; transcript: string }>,
): Promise<ClipMetaDraft[]> {
  const payload = items.map((it) => ({
    index: it.index,
    filename: it.filename,
    transcript: it.transcript.slice(0, 2500),
  }));

  const prompt = `Você é especialista em SEO e copy para YouTube, TikTok e Instagram Reels no Brasil.
Para CADA item da lista (todos os indexes abaixo), gere metadados com base na transcrição daquele trecho.
Responda APENAS JSON válido (sem markdown):
{
  "items": [
    {
      "index": 0,
      "title": "título ≤ 70 caracteres, chamativo",
      "description": "descrição 1-3 frases com CTA para YouTube/TikTok/Instagram",
      "hashtags": ["#tag1", "#tag2"]
    }
  ]
}
Regras:
- português do Brasil
- 5-10 hashtags por item (nicho + alcance)
- títulos distintos entre si quando possível
- OBRIGATÓRIO: retorne exatamente um objeto em "items" para CADA index enviado (${items.map((i) => i.index).join(", ")})
Itens:
${JSON.stringify(payload)}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Responda somente JSON válido. Inclua todos os indexes pedidos em items.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI falhou: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content) as {
    items?: Array<{
      index?: number;
      title?: string;
      description?: string;
      hashtags?: string[];
    }>;
  };
  const byIndex = new Map(
    (parsed.items ?? []).map((it) => [it.index ?? -1, it]),
  );
  return items.map((it) => {
    const row = byIndex.get(it.index);
    const hashtags = Array.isArray(row?.hashtags)
      ? row!.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`))
      : [];
    return {
      index: it.index,
      title: (row?.title ?? "").trim(),
      description: (row?.description ?? "").trim(),
      hashtags: hashtags.slice(0, 12),
    };
  });
}

async function generateClipMetaBatch(
  apiKey: string,
  items: Array<{ index: number; filename: string; transcript: string }>,
): Promise<ClipMetaDraft[]> {
  const done = new Map<number, ClipMetaDraft>();
  let pending = items.slice();

  for (let attempt = 0; attempt < 3 && pending.length > 0; attempt += 1) {
    const nextPending: typeof pending = [];
    for (let i = 0; i < pending.length; i += CLIP_META_BATCH) {
      const slice = pending.slice(i, i + CLIP_META_BATCH);
      const results = await generateClipMetaBatchOnce(apiKey, slice);
      for (const src of slice) {
        const matched = results.find((x) => x.index === src.index) ?? {
          index: src.index,
          title: "",
          description: "",
          hashtags: [],
        };
        const row: ClipMetaDraft = {
          ...matched,
          index: src.index,
          title: matched.title.slice(0, 100),
        };
        if (isWeakClipMeta(row)) nextPending.push(src);
        else done.set(src.index, row);
      }
    }
    pending = nextPending;
  }

  // Last resort: one clip at a time for anything still missing.
  for (const src of pending) {
    const solo = await generateClipMetaBatchOnce(apiKey, [src]);
    const row = solo[0];
    if (row && !isWeakClipMeta(row)) {
      done.set(src.index, { ...row, title: row.title.slice(0, 100) });
    } else {
      done.set(src.index, {
        index: src.index,
        title: `Clipe ${src.index + 1}`,
        description: src.transcript.slice(0, 280),
        hashtags: [],
      });
    }
  }

  return items.map(
    (it) =>
      done.get(it.index) ?? {
        index: it.index,
        title: `Clipe ${it.index + 1}`,
        description: it.transcript.slice(0, 280),
        hashtags: [],
      },
  );
}

function formatClipMetaTxt(items: ClipYoutubeMeta[]): string {
  return items
    .map((m) => {
      const tags = m.hashtags.join(" ");
      return [
        `=== ${m.filename} ===`,
        `Título: ${m.title}`,
        "Descrição:",
        m.description || "(sem descrição)",
        `Hashtags: ${tags || "(nenhuma)"}`,
        "",
      ].join("\n");
    })
    .join("\n")
    .trimEnd()
    .concat("\n");
}

app.get("/health", async () => {
  const binaries = await checkBinaries();
  return {
    ...binaries,
    supabase: supabaseConfigured() || getEnv("DEV_AUTH_BYPASS") === "1",
    openai: Boolean(getEnv("OPENAI_API_KEY")),
    mode: getEnv("DEV_AUTH_BYPASS") === "1" ? "dev-bypass" : "supabase",
  };
});

app.get("/projects", async (req, reply) => {
  try {
    const { user, token } = await requireUser(req);
    const projects = await listProjects(token, user.id);
    return { projects };
  } catch (err) {
    return statusError(err, reply);
  }
});

app.post("/projects", async (req, reply) => {
  try {
    const { user, token } = await requireUser(req);
    const body = (req.body ?? {}) as { title?: string; kind?: "video" | "image" };
    const project = await createProject(
      token,
      user.id,
      body.title ?? "Sem título",
      body.kind === "image" ? "image" : "video",
    );
    return reply.code(201).send(project);
  } catch (err) {
    return statusError(err, reply);
  }
});

app.get<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
  try {
    const { user, token } = await requireUser(req);
    const project = await getProject(token, user.id, req.params.id);
    if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
    return project;
  } catch (err) {
    return statusError(err, reply);
  }
});

app.patch<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
  try {
    const { user, token } = await requireUser(req);
    const body = (req.body ?? {}) as {
      title?: string;
      timeline?: Timeline;
      metadata?: import("./projects.js").ProjectMetadata;
    };
    const project = await updateProject(token, user.id, req.params.id, body);
    return project;
  } catch (err) {
    return statusError(err, reply);
  }
});

app.delete<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
  try {
    const { user, token } = await requireUser(req);
    await deleteProject(token, user.id, req.params.id);
    await rm(projectDir(req.params.id), { recursive: true, force: true });
    return reply.code(204).send();
  } catch (err) {
    return statusError(err, reply);
  }
});

app.post<{ Params: { id: string } }>(
  "/projects/:id/assets",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });

      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "Nenhum arquivo" });

      const assetId = nanoid(10);
      const dir = path.join(assetsDir(project.id), assetId);
      await mkdir(dir, { recursive: true });
      const safeName =
        path.basename(file.filename).replace(/[^\w.\-()+ ]/g, "_") || "media.mp4";
      const dest = path.join(dir, safeName);
      await pipeline(file.file, createWriteStream(dest));

      const durationSec = await probeDurationSeconds(dest);
      const durationMs = Math.round(durationSec * 1000);
      const timeline = structuredClone(project.timeline) as Timeline;
      timeline.assets[assetId] = {
        id: assetId,
        filename: safeName,
        durationMs,
        kind: "video",
      };

      const video = timeline.tracks.find((t) => t.type === "video");
      const audio = timeline.tracks.find((t) => t.type === "audio");
      const start = timeline.durationMs || 0;
      const clipId = nanoid(8);
      if (video && video.type === "video") {
        video.clips.push({
          id: clipId,
          assetId,
          timelineStartMs: start,
          inMs: 0,
          outMs: durationMs,
          transitionIn: "cut",
        });
      }
      if (audio && audio.type === "audio") {
        audio.clips.push({
          id: `${clipId}-a`,
          assetId,
          timelineStartMs: start,
          inMs: 0,
          outMs: durationMs,
        });
      }
      timeline.durationMs = recomputeDuration(timeline);
      const updated = await updateProject(token, user.id, project.id, { timeline });
      return { assetId, project: updated };
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/projects/:id/import-youtube",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
      const body = (req.body ?? {}) as { url?: string };
      if (!body.url?.trim()) {
        return reply.code(400).send({ error: "URL obrigatória" });
      }

      const assetId = nanoid(10);
      const dir = path.join(assetsDir(project.id), assetId);
      await mkdir(dir, { recursive: true });
      const downloaded = await downloadYoutube(body.url.trim(), dir);
      const filename = path.basename(downloaded);
      const finalPath = path.join(dir, filename);
      if (downloaded !== finalPath) {
        // already in dir
      }

      const durationSec = await probeDurationSeconds(downloaded);
      const durationMs = Math.round(durationSec * 1000);
      const timeline = structuredClone(project.timeline) as Timeline;
      timeline.assets[assetId] = {
        id: assetId,
        filename,
        durationMs,
        kind: "video",
      };
      const video = timeline.tracks.find((t) => t.type === "video");
      const audio = timeline.tracks.find((t) => t.type === "audio");
      const start = timeline.durationMs || 0;
      const clipId = nanoid(8);
      if (video && video.type === "video") {
        video.clips.push({
          id: clipId,
          assetId,
          timelineStartMs: start,
          inMs: 0,
          outMs: durationMs,
          transitionIn: "cut",
        });
      }
      if (audio && audio.type === "audio") {
        audio.clips.push({
          id: `${clipId}-a`,
          assetId,
          timelineStartMs: start,
          inMs: 0,
          outMs: durationMs,
        });
      }
      timeline.durationMs = recomputeDuration(timeline);
      const updated = await updateProject(token, user.id, project.id, { timeline });
      return { assetId, project: updated };
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.get<{ Params: { id: string; assetId: string } }>(
  "/projects/:id/assets/:assetId/media",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
      const meta = project.timeline.assets[req.params.assetId];
      if (!meta) return reply.code(404).send({ error: "Asset não encontrado" });
      const filePath = path.join(
        assetsDir(project.id),
        req.params.assetId,
        meta.filename,
      );
      if (!existsSync(filePath)) {
        return reply.code(404).send({ error: "Arquivo local ausente" });
      }
      reply.header("Content-Type", "video/mp4");
      return reply.send(createReadStream(filePath));
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/projects/:id/captions/generate",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });

      const apiKey = getEnv("OPENAI_API_KEY");
      if (!apiKey) {
        return reply
          .code(503)
          .send({ error: "OPENAI_API_KEY não configurada no .env da API" });
      }

      let timeline = structuredClone(project.timeline) as Timeline;
      // Force re-transcription even if cues exist.
      const captions = timeline.tracks.find((t) => t.type === "captions");
      if (captions && captions.type === "captions") captions.cues = [];

      timeline = await ensureWhisperCaptions(project, timeline, apiKey);
      const updated = await updateProject(token, user.id, project.id, {
        timeline,
      });
      const cues = getCaptionCues(updated.timeline);
      return { cues: cues.length, project: updated };
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

const exportJobs = new Map<
  string,
  {
    status: string;
    progress: { step: string; percent: number };
    outputs: Array<{ name: string; label: string; url: string }>;
    zipUrl?: string;
    error?: string;
    projectId?: string;
  }
>();

const EXPORT_JOB_TTL_MS = 45 * 60 * 1000;

/** Run heavy ffmpeg exports one at a time so they don't starve each other. */
let exportQueue: Promise<void> = Promise.resolve();

function enqueueExport(task: () => Promise<void>): Promise<void> {
  const run = exportQueue.then(task, task);
  exportQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function scheduleJobCleanup(jobId: string, workPath?: string) {
  setTimeout(() => {
    exportJobs.delete(jobId);
    if (workPath) {
      void rm(workPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }, EXPORT_JOB_TTL_MS);
}

function hasRunningExportForProject(projectId: string): boolean {
  for (const job of exportJobs.values()) {
    if (job.projectId === projectId && job.status === "running") return true;
  }
  return false;
}

/** Pack export outputs into a zip (macOS/Linux `zip` CLI). */
async function zipExportFolder(
  folder: string,
  zipPath: string,
): Promise<void> {
  const entries = (await readdir(folder)).filter(
    (name) => !name.startsWith(".") && !name.endsWith(".zip"),
  );
  if (entries.length === 0) {
    throw new Error("Nenhum arquivo para compactar");
  }
  await new Promise<void>((resolve, reject) => {
    // `-x` keeps the cached zip itself out of the archive.
    const child = spawn(
      "zip",
      ["-q", "-r", zipPath, ".", "-x", "*.zip", "-x", ".*"],
      { cwd: folder, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.on("error", (err) => {
      reject(
        new Error(
          `Não foi possível criar o ZIP (${err.message}). Instale o utilitário zip.`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`zip falhou: ${stderr || `código ${code}`}`));
    });
  });
}

app.post<{ Params: { id: string } }>(
  "/projects/:id/export",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
      const body = (req.body ?? {}) as {
        exportHorizontal?: boolean;
        exportVertical?: boolean;
        verticalMode?: "crop" | "blur";
        cropFocusX?: number;
        resolution?: "720p" | "1080p" | "1440p" | "2160p";
        burnCaptions?: boolean;
        fps?: number;
        format?: "mp4" | "mov";
        quality?: "low" | "medium" | "high" | "max";
        audioBitrate?: "128k" | "192k" | "320k";
      };

      const jobId = nanoid(8);
      exportJobs.set(jobId, {
        status: "running",
        progress: { step: "Na fila…", percent: 0 },
        outputs: [],
        projectId: project.id,
      });

      void enqueueExport(async () => {
        const workPath = path.join(workDir(project.id), `export-${jobId}`);
        const jobStart = exportJobs.get(jobId);
        if (jobStart) jobStart.progress = { step: "Iniciando", percent: 1 };
        try {
          const results = await exportFromTimeline({
            timeline: project.timeline,
            assetsDir: assetsDir(project.id),
            workDir: workPath,
            outputDir: path.join(outputDir(project.id), jobId),
            options: body,
            onProgress: (step, percent) => {
              const job = exportJobs.get(jobId);
              if (job) job.progress = { step, percent };
            },
          });
          const job = exportJobs.get(jobId);
          if (!job) return;
          job.status = "done";
          job.progress = { step: "Concluído", percent: 100 };
          job.outputs = results.map((r) => ({
            name: r.name,
            label: r.label,
            url: `/projects/${project.id}/exports/${jobId}/${encodeURIComponent(r.name)}`,
          }));
          job.zipUrl = `/projects/${project.id}/exports/${jobId}/zip`;
        } catch (err) {
          const job = exportJobs.get(jobId);
          if (!job) return;
          job.status = "error";
          job.error = err instanceof Error ? err.message : String(err);
        } finally {
          void rm(workPath, { recursive: true, force: true }).catch(
            () => undefined,
          );
          scheduleJobCleanup(jobId);
        }
      });

      return reply.code(202).send({ jobId });
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/projects/:id/export/chunks",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
      const body = (req.body ?? {}) as {
        everySeconds?: number;
        applyToTimeline?: boolean;
        exportExistingClips?: boolean;
        exportHorizontal?: boolean;
        exportVertical?: boolean;
        verticalMode?: "crop" | "blur";
        cropFocusX?: number;
        resolution?: "720p" | "1080p" | "1440p" | "2160p";
        fps?: number;
        format?: "mp4" | "mov";
        quality?: "low" | "medium" | "high" | "max";
        audioBitrate?: "128k" | "192k" | "320k";
      };
      const exportExistingClips = Boolean(body.exportExistingClips);
      const everySeconds = body.everySeconds ?? 60;
      if (!exportExistingClips && everySeconds < 1) {
        return reply.code(400).send({ error: "everySeconds inválido" });
      }

      if (hasRunningExportForProject(project.id)) {
        return reply.code(409).send({
          error:
            "Já existe uma exportação em andamento neste projeto. Aguarde terminar ou reinicie o servidor para limpar jobs travados.",
        });
      }

      // Always slice from the current timeline for files; optionally mirror onto timeline.
      const sourceTimeline = structuredClone(project.timeline) as Timeline;
      let timeline = sourceTimeline;
      if (!exportExistingClips && body.applyToTimeline !== false) {
        const video = timeline.tracks.find((t) => t.type === "video");
        if (!video || video.type !== "video" || video.clips.length === 0) {
          return reply.code(400).send({ error: "Sem clipes" });
        }
        const pieces = sliceClipsEverySeconds(video.clips, everySeconds);
        timeline = {
          ...timeline,
          tracks: timeline.tracks.map((t) =>
            t.type === "video"
              ? { ...t, clips: pieces }
              : t.type === "audio"
                ? {
                    ...t,
                    clips: pieces.map((c) => ({
                      id: `${c.id}-a`,
                      assetId: c.assetId,
                      timelineStartMs: c.timelineStartMs,
                      inMs: c.inMs,
                      outMs: c.outMs,
                      speed: c.speed,
                      volume: c.volume,
                      muted: c.muted,
                    })),
                  }
                : t,
          ),
        };
        timeline.durationMs = recomputeDuration(timeline);
        await updateProject(token, user.id, project.id, { timeline });
      }

      const jobId = nanoid(8);
      exportJobs.set(jobId, {
        status: "running",
        progress: { step: "Na fila…", percent: 0 },
        outputs: [],
        projectId: project.id,
      });

      void enqueueExport(async () => {
        const workPath = path.join(workDir(project.id), `chunks-${jobId}`);
        const jobStart = exportJobs.get(jobId);
        if (jobStart) {
          jobStart.progress = {
            step: exportExistingClips
              ? "Exportando clipes da timeline"
              : "Iniciando pedaços",
            percent: 1,
          };
        }
        try {
          const results = await exportTimelineChunks({
            timeline: sourceTimeline,
            assetsDir: assetsDir(project.id),
            workDir: workPath,
            outputDir: path.join(outputDir(project.id), jobId),
            everySeconds,
            exportExistingClips,
            options: {
              exportHorizontal: body.exportHorizontal,
              exportVertical: body.exportVertical,
              verticalMode: body.verticalMode,
              cropFocusX: body.cropFocusX,
              resolution: body.resolution,
              fps: body.fps,
              format: body.format,
              quality: body.quality ?? "medium",
              audioBitrate: body.audioBitrate,
              burnCaptions: false,
            },
            onProgress: (step, percent) => {
              const job = exportJobs.get(jobId);
              if (job) job.progress = { step, percent };
            },
          });
          const job = exportJobs.get(jobId);
          if (!job) return;
          job.status = "done";
          job.progress = { step: "Concluído", percent: 100 };
          job.outputs = results.map((r) => ({
            name: r.name,
            label: r.label,
            url: `/projects/${project.id}/exports/${jobId}/${encodeURIComponent(r.name)}`,
          }));
          job.zipUrl = `/projects/${project.id}/exports/${jobId}/zip`;
        } catch (err) {
          const job = exportJobs.get(jobId);
          if (!job) return;
          job.status = "error";
          job.error = err instanceof Error ? err.message : String(err);
        } finally {
          void rm(workPath, { recursive: true, force: true }).catch(
            () => undefined,
          );
          scheduleJobCleanup(jobId);
        }
      });

      return reply.code(202).send({ jobId, projectId: project.id });
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.get<{ Params: { jobId: string } }>(
  "/export-jobs/:jobId",
  async (req, reply) => {
    const job = exportJobs.get(req.params.jobId);
    if (!job) return reply.code(404).send({ error: "Job não encontrado" });
    return job;
  },
);

app.get<{ Params: { id: string; jobId: string } }>(
  "/projects/:id/exports/:jobId/zip",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
      const folder = path.join(outputDir(project.id), req.params.jobId);
      if (!existsSync(folder)) {
        return reply.code(404).send({ error: "Exportação não encontrada" });
      }
      const zipName = `clipEasy-${req.params.jobId}.zip`;
      const zipPath = path.join(workDir(project.id), `${req.params.jobId}-all.zip`);
      if (!existsSync(zipPath)) {
        await mkdir(workDir(project.id), { recursive: true });
        await zipExportFolder(folder, zipPath);
      }
      reply.header("Content-Type", "application/zip");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${zipName}"`,
      );
      return reply.send(createReadStream(zipPath));
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.get<{ Params: { id: string; jobId: string; name: string } }>(
  "/projects/:id/exports/:jobId/:name",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
      const name = path.basename(decodeURIComponent(req.params.name));
      const filePath = path.join(outputDir(project.id), req.params.jobId, name);
      if (!existsSync(filePath)) {
        return reply.code(404).send({ error: "Arquivo não encontrado" });
      }
      reply.header("Content-Type", "video/mp4");
      reply.header("Content-Disposition", `attachment; filename="${name}"`);
      return reply.send(createReadStream(filePath));
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

// Recipe: split first video clip into N-second pieces on the timeline
app.post<{ Params: { id: string } }>(
  "/projects/:id/recipes/split",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
      const body = (req.body ?? {}) as { everySeconds?: number };
      const everyMs = Math.round((body.everySeconds ?? 60) * 1000);
      if (everyMs <= 0) return reply.code(400).send({ error: "everySeconds inválido" });

      const timeline = structuredClone(project.timeline) as Timeline;
      const video = timeline.tracks.find((t) => t.type === "video");
      if (!video || video.type !== "video" || video.clips.length === 0) {
        return reply.code(400).send({ error: "Sem clipes" });
      }

      const newClips = [];
      for (const clip of video.clips) {
        let cursor = clip.inMs;
        let tStart = clip.timelineStartMs;
        while (cursor < clip.outMs - 50) {
          const end = Math.min(clip.outMs, cursor + everyMs);
          newClips.push({
            ...clip,
            id: nanoid(8),
            timelineStartMs: tStart,
            inMs: cursor,
            outMs: end,
            transitionIn: "cut" as const,
          });
          tStart += end - cursor;
          cursor = end;
        }
      }
      video.clips = newClips;
      const audio = timeline.tracks.find((t) => t.type === "audio");
      if (audio && audio.type === "audio") {
        audio.clips = newClips.map((c) => ({
          id: `${c.id}-a`,
          assetId: c.assetId,
          timelineStartMs: c.timelineStartMs,
          inMs: c.inMs,
          outMs: c.outMs,
        }));
      }
      timeline.durationMs = recomputeDuration(timeline);
      const updated = await updateProject(token, user.id, project.id, { timeline });
      return updated;
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/projects/:id/recipes/silence",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });

      const { removeSilence } = await import("@clipfacil/pipeline");
      const { access } = await import("node:fs/promises");
      const timeline = structuredClone(project.timeline) as Timeline;
      const video = timeline.tracks.find((t) => t.type === "video");
      if (!video || video.type !== "video" || video.clips.length === 0) {
        return reply.code(400).send({ error: "Sem clipes na timeline" });
      }

      const first = [...video.clips].sort(
        (a, b) => a.timelineStartMs - b.timelineStartMs,
      )[0]!;
      const meta = timeline.assets[first.assetId];
      if (!meta) return reply.code(400).send({ error: "Asset ausente" });

      const input = path.join(assetsDir(project.id), first.assetId, meta.filename);
      try {
        await access(input);
      } catch {
        return reply.code(400).send({
          error: `Arquivo do 1º clipe não encontrado (${meta.filename}). Reimporte o vídeo.`,
        });
      }

      const wdir = path.join(workDir(project.id), "silence");
      await mkdir(wdir, { recursive: true });
      const silence = await removeSilence(input, wdir, -30, 0.5);

      if (!silence.changed) {
        return {
          project,
          result: {
            changed: false,
            silenceCount: 0,
            originalDurationMs: Math.round(silence.originalDurationSec * 1000),
            newDurationMs: Math.round(silence.newDurationSec * 1000),
            message: silence.message,
          },
        };
      }

      const assetId = nanoid(10);
      const dir = path.join(assetsDir(project.id), assetId);
      await mkdir(dir, { recursive: true });
      const filename = "no_silence.mp4";
      const dest = path.join(dir, filename);
      await import("node:fs/promises").then((fs) =>
        fs.copyFile(silence.path, dest),
      );
      const durationMs = Math.round((await probeDurationSeconds(dest)) * 1000);

      timeline.assets[assetId] = {
        id: assetId,
        filename,
        durationMs,
        kind: "video",
      };
      const clipId = nanoid(8);
      video.clips = [
        {
          id: clipId,
          assetId,
          timelineStartMs: 0,
          inMs: 0,
          outMs: durationMs,
          transitionIn: "cut",
        },
      ];
      const audio = timeline.tracks.find((t) => t.type === "audio");
      if (audio && audio.type === "audio") {
        audio.clips = [
          {
            id: `${clipId}-a`,
            assetId,
            timelineStartMs: 0,
            inMs: 0,
            outMs: durationMs,
          },
        ];
      }
      timeline.durationMs = recomputeDuration(timeline);
      const updated = await updateProject(token, user.id, project.id, {
        timeline,
      });
      return {
        project: updated,
        result: {
          changed: true,
          silenceCount: silence.silenceCount,
          originalDurationMs: Math.round(silence.originalDurationSec * 1000),
          newDurationMs: Math.round(silence.newDurationSec * 1000),
          message: silence.message,
        },
      };
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/projects/:id/image",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
      if (project.kind !== "image") {
        return reply.code(400).send({ error: "Projeto não é do tipo imagem" });
      }

      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "Nenhuma imagem" });

      const assetId = nanoid(10);
      const dir = path.join(assetsDir(project.id), assetId);
      await mkdir(dir, { recursive: true });
      const safeName =
        path.basename(file.filename).replace(/[^\w.\-()+ ]/g, "_") || "image.jpg";
      const dest = path.join(dir, safeName);
      await pipeline(file.file, createWriteStream(dest));

      const { width, height } = await probeImageSize(dest);
      const aspect: ImageAspect = width >= height ? "9:16" : "16:9";
      const crop = centerCropBox(width, height, aspect);

      const timeline = structuredClone(project.timeline) as Timeline;
      timeline.assets[assetId] = {
        id: assetId,
        filename: safeName,
        durationMs: 0,
        width,
        height,
        kind: "image",
      };
      timeline.imageStudio = {
        assetId,
        aspect,
        crop,
        brightness: 0,
        contrast: 1,
        resolution: "1080p",
      };

      const updated = await updateProject(token, user.id, project.id, { timeline });
      return { assetId, project: updated };
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/projects/:id/image/export",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });

      const body = (req.body ?? {}) as {
        aspect?: ImageAspect;
        resolution?: Resolution;
        crop?: ImageCropBox;
        brightness?: number;
        contrast?: number;
      };

      const studio = {
        ...project.timeline.imageStudio,
        ...(body.aspect ? { aspect: body.aspect } : {}),
        ...(body.resolution ? { resolution: body.resolution } : {}),
        ...(body.crop ? { crop: body.crop } : {}),
        ...(body.brightness !== undefined ? { brightness: body.brightness } : {}),
        ...(body.contrast !== undefined ? { contrast: body.contrast } : {}),
      };

      if (!studio?.assetId || !studio.crop || !studio.aspect) {
        return reply.code(400).send({ error: "Imagem / crop não configurados" });
      }

      const meta = project.timeline.assets[studio.assetId];
      if (!meta?.width || !meta.height) {
        return reply.code(400).send({ error: "Asset de imagem inválido" });
      }

      const input = path.join(assetsDir(project.id), studio.assetId, meta.filename);
      const outName = imageOutputName(
        studio.aspect,
        studio.resolution ?? "1080p",
      );
      const outDir = path.join(outputDir(project.id), "image");
      await mkdir(outDir, { recursive: true });
      const outPath = path.join(outDir, outName);

      await exportImage({
        inputPath: input,
        outputPath: outPath,
        sourceWidth: meta.width,
        sourceHeight: meta.height,
        options: {
          aspect: studio.aspect,
          resolution: studio.resolution ?? "1080p",
          crop: studio.crop,
          brightness: studio.brightness ?? 0,
          contrast: studio.contrast ?? 1,
        },
      });

      const timeline = structuredClone(project.timeline) as Timeline;
      timeline.imageStudio = {
        assetId: studio.assetId,
        aspect: studio.aspect,
        crop: studio.crop,
        brightness: studio.brightness ?? 0,
        contrast: studio.contrast ?? 1,
        resolution: studio.resolution ?? "1080p",
      };
      await updateProject(token, user.id, project.id, { timeline });

      return {
        name: outName,
        url: `/projects/${project.id}/exports/image/${encodeURIComponent(outName)}`,
      };
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.get<{ Params: { id: string; name: string } }>(
  "/projects/:id/exports/image/:name",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
      const name = path.basename(decodeURIComponent(req.params.name));
      const filePath = path.join(outputDir(project.id), "image", name);
      if (!existsSync(filePath)) {
        return reply.code(404).send({ error: "Arquivo não encontrado" });
      }
      reply.header("Content-Type", "image/jpeg");
      reply.header("Content-Disposition", `attachment; filename="${name}"`);
      return reply.send(createReadStream(filePath));
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/projects/:id/clips/meta/generate",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });

      const apiKey = getEnv("OPENAI_API_KEY");
      if (!apiKey) {
        return reply
          .code(503)
          .send({ error: "OPENAI_API_KEY não configurada no .env da API" });
      }

      const clips = getVideoClips(project.timeline);
      if (clips.length === 0) {
        return reply.code(400).send({ error: "Sem clipes de vídeo" });
      }

      if (hasRunningExportForProject(project.id)) {
        return reply.code(409).send({
          error:
            "Já existe um job em andamento neste projeto. Aguarde terminar.",
        });
      }

      const jobId = nanoid(8);
      exportJobs.set(jobId, {
        status: "running",
        progress: { step: "Na fila…", percent: 0 },
        outputs: [],
        projectId: project.id,
      });

      void enqueueExport(async () => {
        const job = exportJobs.get(jobId);
        if (!job) return;
        try {
          job.progress = { step: "Preparando legendas…", percent: 2 };
          let timeline = structuredClone(project.timeline) as Timeline;
          timeline = await ensureWhisperCaptions(
            project,
            timeline,
            apiKey,
            (step, percent) => {
              const j = exportJobs.get(jobId);
              if (j) j.progress = { step, percent: percent ?? 8 };
            },
          );
          if (getCaptionCues(timeline).length === 0) {
            // Still empty after whisper — continue with empty transcripts.
          } else {
            await updateProject(token, user.id, project.id, { timeline });
          }

          const cues = getCaptionCues(timeline);
          const videoClips = getVideoClips(timeline);
          const clipMeta: ClipYoutubeMeta[] = [];
          const withSpeech: Array<{
            index: number;
            filename: string;
            transcript: string;
            clipId: string;
          }> = [];

          for (let i = 0; i < videoClips.length; i += 1) {
            const clip = videoClips[i]!;
            const filename = parteFilename(i);
            const transcript = transcriptForClip(cues, clip);
            if (!transcript) {
              clipMeta[i] = {
                clipId: clip.id,
                filename,
                title: `Clipe ${i + 1} (sem fala)`,
                description: "Nenhuma fala detectada neste trecho.",
                hashtags: [],
                transcriptPreview: "",
              };
            } else {
              withSpeech.push({
                index: i,
                filename,
                transcript,
                clipId: clip.id,
              });
            }
          }

          const totalBatches = Math.max(
            1,
            Math.ceil(withSpeech.length / CLIP_META_BATCH),
          );
          for (let b = 0; b < withSpeech.length; b += CLIP_META_BATCH) {
            const batch = withSpeech.slice(b, b + CLIP_META_BATCH);
            const batchNo = Math.floor(b / CLIP_META_BATCH) + 1;
            const doneClips = Math.min(
              videoClips.length,
              clipMeta.filter(Boolean).length + batch.length,
            );
            const j = exportJobs.get(jobId);
            if (j) {
              j.progress = {
                step: `Gerando metadados (lote ${batchNo}/${totalBatches}) — clipe ${doneClips}/${videoClips.length}`,
                percent: Math.round(
                  55 +
                    (40 * Math.min(b + batch.length, withSpeech.length)) /
                      Math.max(1, withSpeech.length),
                ),
              };
            }
            const results = await generateClipMetaBatch(apiKey, batch);
            for (const row of results) {
              const src = batch.find((x) => x.index === row.index)!;
              clipMeta[row.index] = {
                clipId: src.clipId,
                filename: src.filename,
                title: row.title,
                description: row.description,
                hashtags: row.hashtags,
                transcriptPreview: src.transcript.slice(0, 180),
              };
            }
          }

          const ordered = videoClips.map((_, i) => clipMeta[i]!).filter(Boolean);
          const latest = await getProject(token, user.id, project.id);
          if (!latest) throw new Error("Projeto não encontrado ao salvar");
          const updated = await updateProject(token, user.id, project.id, {
            timeline,
            metadata: { ...latest.metadata, clipMeta: ordered },
          });

          const done = exportJobs.get(jobId);
          if (!done) return;
          done.status = "done";
          done.progress = {
            step: `Concluído — ${ordered.length} clipe(s)`,
            percent: 100,
          };
          done.outputs = [
            {
              name: "clip-meta.txt",
              label: "Metadados (TXT)",
              url: `/projects/${updated.id}/clips/meta.txt`,
            },
          ];
        } catch (err) {
          const failed = exportJobs.get(jobId);
          if (!failed) return;
          failed.status = "error";
          failed.error = err instanceof Error ? err.message : String(err);
        } finally {
          scheduleJobCleanup(jobId);
        }
      });

      return reply.code(202).send({ jobId });
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.get<{ Params: { id: string } }>(
  "/projects/:id/clips/meta.txt",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
      const items = project.metadata?.clipMeta ?? [];
      if (items.length === 0) {
        return reply
          .code(404)
          .send({ error: "Gere os metadados por clipe antes de baixar o TXT" });
      }
      const body = formatClipMetaTxt(items);
      reply.header("Content-Type", "text/plain; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="clipEasy-metadados.txt"`,
      );
      return reply.send(body);
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/projects/:id/youtube/suggest",
  async (req, reply) => {
    try {
      const { user, token } = await requireUser(req);
      const project = await getProject(token, user.id, req.params.id);
      if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });

      const apiKey = getEnv("OPENAI_API_KEY");
      if (!apiKey) {
        return reply
          .code(503)
          .send({ error: "OPENAI_API_KEY não configurada no .env da API" });
      }

      const captions = project.timeline.tracks.find((t) => t.type === "captions");
      const transcript =
        captions && captions.type === "captions"
          ? captions.cues.map((c) => c.text).join(" ").trim()
          : "";
      if (!transcript) {
        return reply
          .code(400)
          .send({ error: "Gere legendas antes de sugerir metadados do YouTube" });
      }

      const prompt = `Você é um especialista em SEO para YouTube no Brasil.
Com base na transcrição abaixo, responda APENAS JSON válido (sem markdown) no formato:
{
  "titles": ["titulo1", "titulo2", "titulo3"],
  "description": "descrição com 2-4 parágrafos e CTA",
  "hashtags": ["#tag1", "#tag2"],
  "tags": ["tag1", "tag2", "tag3"]
}
Regras: títulos ≤ 70 caracteres, hashtags 5-12, tags 8-15 (sem #), português do Brasil.
Transcrição:
"""${transcript.slice(0, 12000)}"""`;

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.7,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "Responda somente JSON válido conforme o schema pedido.",
            },
            { role: "user", content: prompt },
          ],
        }),
      });

      if (!res.ok) {
        throw new Error(`OpenAI falhou: ${await res.text()}`);
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as YoutubeMeta;
      const youtube: YoutubeMeta = {
        titles: Array.isArray(parsed.titles) ? parsed.titles.slice(0, 5) : [],
        selectedTitle: parsed.titles?.[0],
        description: parsed.description ?? "",
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      };

      const updated = await updateProject(token, user.id, project.id, {
        metadata: { ...project.metadata, youtube },
      });
      return { youtube, project: updated };
    } catch (err) {
      return statusError(err, reply);
    }
  },
);

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
console.log(`clipEasy API em http://${host}:${port}`);
