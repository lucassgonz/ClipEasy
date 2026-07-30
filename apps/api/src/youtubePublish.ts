import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { normalizeHashtags } from "./youtube.js";
import { uploadYoutubeVideo } from "./youtubeOAuth.js";
import {
  expandPublishSlots,
  loadPublishQueue,
  loadUserSettings,
  savePublishQueue,
  type PublishQueueItem,
} from "./userSettings.js";
import { outputDir } from "./paths.js";
import type { ClipYoutubeMeta } from "./projects.js";

const processingUsers = new Set<string>();

export function buildYoutubeDescription(
  description: string,
  hashtags: string[],
): string {
  const tags = normalizeHashtags(hashtags, 6);
  const base = description.trim();
  if (!tags.length) return base;
  if (tags.every((t) => base.includes(t))) return base;
  return `${base}\n\n${tags.join(" ")}`;
}

export function tagsFromMeta(meta: ClipYoutubeMeta): string[] {
  const fromTags = (meta.tags ?? [])
    .map((t) => t.replace(/^#/, "").trim())
    .filter(Boolean);
  if (fromTags.length) return [...new Set(fromTags)].slice(0, 30);
  return normalizeHashtags(meta.hashtags, 6).map((h) => h.replace(/^#/, ""));
}

/** Resolve vertical/horizontal export file for a meta filename like parte_001.mp4 */
export async function resolveExportFile(
  projectId: string,
  filename: string,
): Promise<string | null> {
  const root = outputDir(projectId);
  if (!existsSync(root)) return null;
  const stem = path.parse(filename).name; // parte_001
  const candidates = [
    `${stem}_9x16.mp4`,
    `${stem}_16x9.mp4`,
    `${stem}.mp4`,
    filename,
  ];

  // Prefer newest export job folder that contains a match.
  const jobs = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const scored: Array<{ file: string; mtime: number }> = [];
  for (const job of jobs) {
    for (const name of candidates) {
      const full = path.join(root, job, name);
      if (!existsSync(full)) continue;
      const st = await stat(full);
      scored.push({ file: full, mtime: st.mtimeMs });
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.mtime - a.mtime);
  return scored[0]!.file;
}

export async function enqueueYoutubeSchedule(opts: {
  userId: string;
  projectId: string;
  clipMeta: ClipYoutubeMeta[];
}): Promise<{ queued: number; firstAt: string; lastAt: string; items: PublishQueueItem[] }> {
  const settings = await loadUserSettings(opts.userId);
  if (!settings.youtube?.refreshToken) {
    const err = new Error(
      "Conecte sua conta YouTube em Configurações antes de agendar.",
    );
    (err as Error & { statusCode: number }).statusCode = 400;
    throw err;
  }
  const metas = opts.clipMeta.filter((m) => m.title?.trim());
  if (!metas.length) {
    const err = new Error(
      "Gere as sugestões dos clipes antes de agendar no YouTube.",
    );
    (err as Error & { statusCode: number }).statusCode = 400;
    throw err;
  }

  const slots = expandPublishSlots(settings.postingSchedule, metas.length);
  if (slots.length < metas.length) {
    throw new Error("Não foi possível calcular datas suficientes no calendário.");
  }

  const existing = await loadPublishQueue(opts.userId);
  const kept = existing.filter(
    (i) =>
      !(
        i.projectId === opts.projectId &&
        (i.status === "pending" || i.status === "error")
      ),
  );

  const created: PublishQueueItem[] = [];
  for (let i = 0; i < metas.length; i += 1) {
    const meta = metas[i]!;
    const filePath = await resolveExportFile(opts.projectId, meta.filename);
    if (!filePath) {
      const err = new Error(
        `Arquivo não encontrado para ${meta.filename}. Exporte os clipes 9:16 antes de agendar.`,
      );
      (err as Error & { statusCode: number }).statusCode = 400;
      throw err;
    }
    const hashtags = normalizeHashtags(meta.hashtags, 6);
    const tags = tagsFromMeta(meta);
    created.push({
      id: nanoid(10),
      userId: opts.userId,
      projectId: opts.projectId,
      clipId: meta.clipId,
      filename: path.basename(filePath),
      filePath,
      title: meta.title.trim(),
      description: buildYoutubeDescription(meta.description, hashtags),
      tags,
      hashtags,
      scheduledAt: slots[i]!.toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    });
  }

  const next = [...kept, ...created];
  await savePublishQueue(opts.userId, next);
  return {
    queued: created.length,
    firstAt: created[0]!.scheduledAt,
    lastAt: created[created.length - 1]!.scheduledAt,
    items: created,
  };
}

/** Upload items whose publishAt is still in the future — YouTube holds them as private until then.
 *  We upload as soon as they're in the queue (not waiting for the wall-clock slot), with publishAt set.
 */
export async function processPublishQueue(
  userId: string,
  opts?: { limit?: number; onProgress?: (msg: string, pct: number) => void },
): Promise<{ uploaded: number; errors: number }> {
  const queue = await loadPublishQueue(userId);
  const pending = queue.filter((i) => i.status === "pending" || i.status === "error");
  const limit = opts?.limit ?? pending.length;
  let uploaded = 0;
  let errors = 0;
  const slice = pending.slice(0, limit);

  for (let i = 0; i < slice.length; i += 1) {
    const item = slice[i]!;
    opts?.onProgress?.(
      `Enviando ${i + 1}/${slice.length}: ${item.filename}`,
      Math.round(((i + 0.1) / Math.max(1, slice.length)) * 100),
    );
    const idx = queue.findIndex((q) => q.id === item.id);
    if (idx < 0) continue;
    queue[idx] = { ...queue[idx]!, status: "uploading", error: undefined };
    await savePublishQueue(userId, queue);
    try {
      if (!existsSync(item.filePath)) {
        throw new Error(`Arquivo ausente: ${item.filePath}`);
      }
      const { videoId } = await uploadYoutubeVideo({
        userId,
        filePath: item.filePath,
        title: item.title,
        description: item.description,
        tags: item.tags,
        publishAt: new Date(item.scheduledAt),
      });
      queue[idx] = {
        ...queue[idx]!,
        status: "done",
        youtubeVideoId: videoId,
        error: undefined,
      };
      uploaded += 1;
    } catch (err) {
      queue[idx] = {
        ...queue[idx]!,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
      errors += 1;
    }
    await savePublishQueue(userId, queue);
  }
  opts?.onProgress?.("Fila processada", 100);
  return { uploaded, errors };
}

export async function getPublishQueueSummary(userId: string) {
  const items = await loadPublishQueue(userId);
  return {
    total: items.length,
    pending: items.filter((i) => i.status === "pending").length,
    uploading: items.filter((i) => i.status === "uploading").length,
    done: items.filter((i) => i.status === "done").length,
    error: items.filter((i) => i.status === "error").length,
    processing: processingUsers.has(userId),
    items: items
      .slice()
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
      .slice(0, 100),
  };
}

/** Fire-and-forget uploads while the API stays up. */
export function kickPublishQueue(userId: string): void {
  if (processingUsers.has(userId)) return;
  processingUsers.add(userId);
  void (async () => {
    try {
      for (;;) {
        const summary = await getPublishQueueSummary(userId);
        if (summary.pending === 0 && summary.error === 0) break;
        // Only auto-retry pending; leave previous errors for manual process.
        const pendingOnly = (await loadPublishQueue(userId)).filter(
          (i) => i.status === "pending",
        );
        if (!pendingOnly.length) break;
        await processPublishQueue(userId, { limit: 1 });
      }
    } catch (err) {
      console.error("[publish-queue]", userId, err);
    } finally {
      processingUsers.delete(userId);
    }
  })();
}
