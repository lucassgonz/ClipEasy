import "./env.js";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  centerCropBox,
  checkBinaries,
  downloadYoutube,
  exportFromTimeline,
  exportImage,
  imageOutputName,
  mustRun,
  probeDurationSeconds,
  probeImageSize,
  recomputeDuration,
  type CaptionCue,
  type ImageAspect,
  type ImageCropBox,
  type Resolution,
  type Timeline,
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

      const timeline = structuredClone(project.timeline) as Timeline;
      const video = timeline.tracks.find((t) => t.type === "video");
      if (!video || video.type !== "video" || video.clips.length === 0) {
        return reply.code(400).send({ error: "Sem clipes de vídeo" });
      }

      // Use first video asset audio for transcription (MVP)
      const first = [...video.clips].sort(
        (a, b) => a.timelineStartMs - b.timelineStartMs,
      )[0]!;
      const meta = timeline.assets[first.assetId];
      if (!meta) return reply.code(400).send({ error: "Asset ausente" });
      const mediaPath = path.join(assetsDir(project.id), first.assetId, meta.filename);
      const wdir = workDir(project.id);
      await mkdir(wdir, { recursive: true });
      const audioPath = path.join(wdir, "whisper.mp3");
      await mustRun("ffmpeg", [
        "-y",
        "-i",
        mediaPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        audioPath,
      ]);

      const form = new FormData();
      const audioBuf = await readFile(audioPath);
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
        text?: string;
      };

      const cues: CaptionCue[] = (json.segments ?? []).map((seg, i) => ({
        id: `cue-${i}-${nanoid(4)}`,
        startMs: Math.round(seg.start * 1000) + first.timelineStartMs,
        endMs: Math.round(seg.end * 1000) + first.timelineStartMs,
        text: seg.text.trim(),
      }));

      const captions = timeline.tracks.find((t) => t.type === "captions");
      if (captions && captions.type === "captions") {
        captions.cues = cues;
      }
      timeline.durationMs = recomputeDuration(timeline);
      const updated = await updateProject(token, user.id, project.id, { timeline });
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
    error?: string;
  }
>();

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
        progress: { step: "Iniciando", percent: 1 },
        outputs: [],
      });

      void (async () => {
        try {
          const results = await exportFromTimeline({
            timeline: project.timeline,
            assetsDir: assetsDir(project.id),
            workDir: path.join(workDir(project.id), `export-${jobId}`),
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
        } catch (err) {
          const job = exportJobs.get(jobId);
          if (!job) return;
          job.status = "error";
          job.error = err instanceof Error ? err.message : String(err);
        }
      })();

      return reply.code(202).send({ jobId });
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
      const timeline = structuredClone(project.timeline) as Timeline;
      const video = timeline.tracks.find((t) => t.type === "video");
      if (!video || video.type !== "video" || video.clips.length === 0) {
        return reply.code(400).send({ error: "Sem clipes" });
      }

      const first = [...video.clips].sort(
        (a, b) => a.timelineStartMs - b.timelineStartMs,
      )[0]!;
      const meta = timeline.assets[first.assetId];
      if (!meta) return reply.code(400).send({ error: "Asset ausente" });

      const input = path.join(assetsDir(project.id), first.assetId, meta.filename);
      const wdir = path.join(workDir(project.id), "silence");
      await mkdir(wdir, { recursive: true });
      const cleaned = await removeSilence(input, wdir, -30, 0.5);

      const assetId = nanoid(10);
      const dir = path.join(assetsDir(project.id), assetId);
      await mkdir(dir, { recursive: true });
      const filename = "no_silence.mp4";
      const dest = path.join(dir, filename);
      await import("node:fs/promises").then((fs) => fs.copyFile(cleaned, dest));
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
      const updated = await updateProject(token, user.id, project.id, { timeline });
      return updated;
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
