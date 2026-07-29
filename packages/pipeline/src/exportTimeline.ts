import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAssFile } from "./captions.js";
import { mustRun } from "./binaries.js";
import {
  clipDurationMs,
  clipSpeed,
  getCaptionsTrack,
  getVideoTrack,
  type Timeline,
  type TransitionType,
  type VideoClip,
} from "./timeline.js";
import type {
  ExportFormat,
  ExportQuality,
  Resolution,
} from "./types.js";
import { qualitySettings } from "./types.js";
import { exportHorizontal, exportVertical } from "./aspect.js";

export interface ExportTimelineOptions {
  resolution?: Resolution;
  exportHorizontal?: boolean;
  exportVertical?: boolean;
  verticalMode?: "crop" | "blur";
  /** 0 = left, 0.5 = center, 1 = right */
  cropFocusX?: number;
  burnCaptions?: boolean;
  fps?: number;
  format?: ExportFormat;
  quality?: ExportQuality;
  audioBitrate?: "128k" | "192k" | "320k";
}

function assetPath(assetsDir: string, assetId: string, filename: string): string {
  return path.join(assetsDir, assetId, filename);
}

/** Build atempo chain for speeds outside [0.5, 2]. */
function atempoChain(speed: number): string {
  const parts: string[] = [];
  let s = speed;
  while (s > 2.0001) {
    parts.push("atempo=2.0");
    s /= 2;
  }
  while (s < 0.5 - 1e-6) {
    parts.push("atempo=0.5");
    s /= 0.5;
  }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

async function renderClipSegment(
  input: string,
  out: string,
  clip: VideoClip,
  fps: number,
  quality: ExportQuality,
  audioBitrate: string,
): Promise<void> {
  const start = (clip.inMs / 1000).toFixed(3);
  const end = (clip.outMs / 1000).toFixed(3);
  const speed = clipSpeed(clip);
  const { crf, preset } = qualitySettings(quality);
  const muted = Boolean(clip.muted) || (clip.volume ?? 1) <= 0.001;
  const volume = muted ? 0 : Math.min(2, Math.max(0, clip.volume ?? 1));

  const vf: string[] = [];
  const af: string[] = [];
  if (Math.abs(speed - 1) > 0.001) {
    vf.push(`setpts=PTS/${speed}`);
    af.push(atempoChain(speed));
  }
  if (muted) {
    af.push("volume=0");
  } else if (Math.abs(volume - 1) > 0.001) {
    af.push(`volume=${volume.toFixed(3)}`);
  }

  const args = [
    "-y",
    "-ss",
    start,
    "-to",
    end,
    "-i",
    input,
  ];
  if (vf.length) {
    args.push("-vf", vf.join(","));
  }
  if (af.length) {
    args.push("-af", af.join(","));
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    "-movflags",
    "+faststart",
    out,
  );
  await mustRun("ffmpeg", args);
}

/** True when we can split with stream copy (no re-encode). */
function canStreamCopyClip(clip: VideoClip): boolean {
  const speed = clipSpeed(clip);
  const volume = clip.volume ?? 1;
  return (
    Math.abs(speed - 1) < 0.001 &&
    !clip.muted &&
    Math.abs(volume - 1) < 0.001
  );
}

/**
 * Fast keyframe-aligned cut via stream copy — seconds, not minutes, per chunk.
 */
async function cutClipSegmentCopy(
  input: string,
  out: string,
  clip: VideoClip,
): Promise<void> {
  const start = (clip.inMs / 1000).toFixed(3);
  const duration = Math.max(0.05, (clip.outMs - clip.inMs) / 1000).toFixed(3);
  await mustRun("ffmpeg", [
    "-y",
    "-ss",
    start,
    "-i",
    input,
    "-t",
    duration,
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    "-movflags",
    "+faststart",
    out,
  ]);
}

async function renderGapSegment(
  out: string,
  durationMs: number,
  width: number,
  height: number,
  fps: number,
  quality: ExportQuality,
  audioBitrate: string,
): Promise<void> {
  const dur = Math.max(0.04, durationMs / 1000);
  const { crf, preset } = qualitySettings(quality);
  await mustRun("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${width}x${height}:r=${fps}:d=${dur.toFixed(3)}`,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=stereo:sample_rate=44100`,
    "-t",
    dur.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    "-shortest",
    "-movflags",
    "+faststart",
    out,
  ]);
}

async function probeSize(
  file: string,
): Promise<{ width: number; height: number }> {
  try {
    const { runCommand } = await import("./binaries.js");
    const result = await runCommand("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ]);
    const [w, h] = result.stdout.trim().split(",").map(Number);
    if (w && h) return { width: w, height: h };
  } catch {
    /* fallback */
  }
  return { width: 1920, height: 1080 };
}

async function concatSegments(
  segments: string[],
  workDir: string,
  output: string,
  quality: ExportQuality,
  audioBitrate: string,
  fps: number,
): Promise<void> {
  if (segments.length === 0) {
    throw new Error("Nenhum clipe na timeline para exportar");
  }
  if (segments.length === 1) {
    await copyFile(segments[0]!, output);
    return;
  }
  const list = path.join(workDir, "concat.txt");
  const body = segments
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(list, body, "utf8");
  const { crf, preset } = qualitySettings(quality);
  // Re-encode for consistent timestamps after mixed gap/clip segments
  await mustRun("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    "-movflags",
    "+faststart",
    output,
  ]);
}

/**
 * Apply xfade between segments when transitions request it.
 * Falls back to hard concat if xfade build fails.
 */
async function concatWithTransitions(
  segments: string[],
  transitions: TransitionType[],
  transitionMs: number[],
  workDir: string,
  output: string,
  quality: ExportQuality,
  audioBitrate: string,
  fps: number,
): Promise<void> {
  const useXfade = transitions.some(
    (t, i) => i > 0 && (t === "crossfade" || t === "fade"),
  );
  if (!useXfade || segments.length < 2) {
    await concatSegments(
      segments,
      workDir,
      output,
      quality,
      audioBitrate,
      fps,
    );
    return;
  }

  try {
    const inputs: string[] = [];
    for (const seg of segments) {
      inputs.push("-i", seg);
    }
    let filter = "";
    let lastV = "[0:v]";
    let lastA = "[0:a]";
    let offset = 0;
    // Approximate offsets from probe durations — use clip durations passed via transitionMs as duration of PREVIOUS visual segment
    for (let i = 1; i < segments.length; i += 1) {
      const td = Math.min(
        1,
        Math.max(0.1, (transitionMs[i] ?? 500) / 1000),
      );
      const prevDur = Math.max(td + 0.05, (transitionMs[i - 1] ?? 1000) / 1000);
      offset += prevDur - td;
      const mode = transitions[i] === "fade" ? "fadeblack" : "fade";
      const outV = i === segments.length - 1 ? "[vout]" : `[v${i}]`;
      const outA = i === segments.length - 1 ? "[aout]" : `[a${i}]`;
      filter += `${lastV}[${i}:v]xfade=transition=${mode}:duration=${td}:offset=${offset.toFixed(3)}${outV};`;
      filter += `${lastA}[${i}:a]acrossfade=d=${td}${outA};`;
      lastV = outV;
      lastA = outA;
    }
    const { crf, preset } = qualitySettings(quality);
    await mustRun("ffmpeg", [
      "-y",
      ...inputs,
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-crf",
      String(crf),
      "-r",
      String(fps),
      "-c:a",
      "aac",
      "-b:a",
      audioBitrate,
      "-movflags",
      "+faststart",
      output,
    ]);
  } catch {
    await concatSegments(
      segments,
      workDir,
      output,
      quality,
      audioBitrate,
      fps,
    );
  }
}

export async function exportFromTimeline(params: {
  timeline: Timeline;
  assetsDir: string;
  workDir: string;
  outputDir: string;
  options: ExportTimelineOptions;
  onProgress?: (step: string, percent: number) => void;
}): Promise<Array<{ name: string; label: string; path: string }>> {
  const { timeline, assetsDir, workDir, outputDir, options } = params;
  await mkdir(workDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const fps = options.fps ?? timeline.fps ?? 30;
  const quality = options.quality ?? "high";
  const audioBitrate = options.audioBitrate ?? "192k";
  const format: ExportFormat = options.format ?? "mp4";
  const ext = format === "mov" ? "mov" : "mp4";

  const videoTrack = getVideoTrack(timeline);
  const clips = [...videoTrack.clips].sort(
    (a, b) => a.timelineStartMs - b.timelineStartMs,
  );
  if (clips.length === 0) {
    throw new Error("Adicione pelo menos um clipe de vídeo antes de exportar");
  }

  params.onProgress?.("Cortando clipes", 10);
  const segments: string[] = [];
  const transitions: TransitionType[] = [];
  const segDurationsMs: number[] = [];

  let cursor = 0;
  let refSize = { width: 1920, height: 1080 };
  const firstMeta = timeline.assets[clips[0]!.assetId];
  if (firstMeta?.width && firstMeta.height) {
    refSize = { width: firstMeta.width, height: firstMeta.height };
  }

  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i]!;
    const gap = clip.timelineStartMs - cursor;
    if (gap > 40) {
      const gapPath = path.join(
        workDir,
        `gap_${String(segments.length).padStart(3, "0")}.mp4`,
      );
      await renderGapSegment(
        gapPath,
        gap,
        refSize.width,
        refSize.height,
        fps,
        quality,
        audioBitrate,
      );
      segments.push(gapPath);
      transitions.push("cut");
      segDurationsMs.push(gap);
      cursor += gap;
    }

    const meta = timeline.assets[clip.assetId];
    if (!meta) throw new Error(`Asset ausente: ${clip.assetId}`);
    const input = assetPath(assetsDir, clip.assetId, meta.filename);
    const seg = path.join(workDir, `seg_${String(i).padStart(3, "0")}.mp4`);
    await renderClipSegment(input, seg, clip, fps, quality, audioBitrate);
    if (i === 0) {
      refSize = await probeSize(seg);
    }
    segments.push(seg);
    transitions.push(clip.transitionIn ?? "cut");
    const dur = clipDurationMs(clip);
    segDurationsMs.push(dur);
    cursor = clip.timelineStartMs + dur;
  }

  params.onProgress?.("Montando sequência", 45);
  let composed = path.join(workDir, `composed.${ext}`);
  await concatWithTransitions(
    segments,
    transitions,
    segDurationsMs,
    workDir,
    composed,
    quality,
    audioBitrate,
    fps,
  );

  if (options.burnCaptions !== false) {
    const captions = getCaptionsTrack(timeline).cues;
    if (captions.length > 0) {
      params.onProgress?.("Gravando legendas", 60);
      const assPath = path.join(workDir, "captions.ass");
      await writeAssFile(captions, assPath);
      const burned = path.join(workDir, `composed_subs.${ext}`);
      const escaped = assPath
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'");
      const { crf, preset } = qualitySettings(quality);
      await mustRun("ffmpeg", [
        "-y",
        "-i",
        composed,
        "-vf",
        `ass='${escaped}'`,
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        String(crf),
        "-r",
        String(fps),
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        burned,
      ]);
      composed = burned;
    }
  }

  const results: Array<{ name: string; label: string; path: string }> = [];
  const wantH = options.exportHorizontal !== false;
  const wantV = options.exportVertical !== false;
  const resolution = options.resolution ?? "1080p";
  const encode = {
    fps,
    quality,
    audioBitrate,
    format,
  };

  if (!wantH && !wantV) {
    const name = `export.${ext}`;
    const dest = path.join(outputDir, name);
    await copyFile(composed, dest);
    results.push({ name, label: "Exportação", path: dest });
  }

  if (wantH) {
    params.onProgress?.("Export horizontal", 75);
    const name = `export_horizontal_16x9.${ext}`;
    const dest = path.join(outputDir, name);
    await exportHorizontal(composed, dest, resolution, undefined, encode);
    results.push({ name, label: "Horizontal 16:9", path: dest });
  }

  if (wantV) {
    params.onProgress?.("Export vertical", 90);
    const name = `export_vertical_9x16.${ext}`;
    const dest = path.join(outputDir, name);
    await exportVertical(
      composed,
      dest,
      resolution,
      options.verticalMode ?? "crop",
      undefined,
      encode,
      options.cropFocusX ?? 0.5,
    );
    results.push({ name, label: "Vertical 9:16", path: dest });
  }

  params.onProgress?.("Concluído", 100);
  return results;
}

/** Split video clips into fixed-length pieces (source time). */
export function sliceClipsEverySeconds(
  clips: VideoClip[],
  everySeconds: number,
): VideoClip[] {
  const everyMs = Math.round(everySeconds * 1000);
  if (everyMs <= 0) return clips;
  const out: VideoClip[] = [];
  let tStart = 0;
  const sorted = [...clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  for (const clip of sorted) {
    let cursor = clip.inMs;
    while (cursor < clip.outMs - 50) {
      const end = Math.min(clip.outMs, cursor + everyMs);
      const piece: VideoClip = {
        ...clip,
        id: `${clip.id}-${out.length}`,
        timelineStartMs: tStart,
        inMs: cursor,
        outMs: end,
        transitionIn: "cut",
      };
      out.push(piece);
      tStart += clipDurationMs(piece);
      cursor = end;
    }
  }
  return out;
}

/**
 * Export each chunk of `everySeconds` as a separate file.
 * Optionally also applies H/V aspect to each piece.
 */
export async function exportTimelineChunks(params: {
  timeline: Timeline;
  assetsDir: string;
  workDir: string;
  outputDir: string;
  everySeconds: number;
  /** Export each timeline clip as one file (no further slicing). */
  exportExistingClips?: boolean;
  options: ExportTimelineOptions;
  onProgress?: (step: string, percent: number) => void;
}): Promise<Array<{ name: string; label: string; path: string }>> {
  const { timeline, assetsDir, workDir, outputDir, options } = params;
  const everySeconds = Math.max(1, params.everySeconds || 60);
  await mkdir(workDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const fps = options.fps ?? timeline.fps ?? 30;
  const quality = options.quality ?? "high";
  const audioBitrate = options.audioBitrate ?? "192k";
  const format: ExportFormat = options.format ?? "mp4";
  const ext = format === "mov" ? "mov" : "mp4";
  const resolution = options.resolution ?? "1080p";
  const wantH = options.exportHorizontal === true;
  const wantV = options.exportVertical === true;
  // Default: one file per chunk without forced aspect (fast). If H/V asked, apply.
  const plain = !wantH && !wantV;

  const videoTrack = getVideoTrack(timeline);
  if (videoTrack.clips.length === 0) {
    throw new Error("Adicione pelo menos um clipe de vídeo antes de exportar");
  }
  const pieces = params.exportExistingClips
    ? [...videoTrack.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs)
    : sliceClipsEverySeconds(videoTrack.clips, everySeconds);
  if (pieces.length === 0) {
    throw new Error("Nenhum pedaço gerado — verifique a duração do vídeo");
  }

  const results: Array<{ name: string; label: string; path: string }> = [];
  const encode = { fps, quality, audioBitrate, format };
  const total = pieces.length;

  for (let i = 0; i < total; i += 1) {
    const piece = pieces[i]!;
    const pctStart = Math.round((i / total) * 95);
    params.onProgress?.(
      `Exportando pedaço ${i + 1}/${total}`,
      Math.max(1, pctStart),
    );
    const meta = timeline.assets[piece.assetId];
    if (!meta) throw new Error(`Asset ausente: ${piece.assetId}`);
    const input = assetPath(assetsDir, piece.assetId, meta.filename);

    const base = `parte_${String(i + 1).padStart(3, "0")}`;
    const startSec = Math.floor(piece.timelineStartMs / 1000);
    const labelTime = `${Math.floor(startSec / 60)}m${String(startSec % 60).padStart(2, "0")}s`;
    const useCopy = canStreamCopyClip(piece);

    if (plain && useCopy) {
      const name = `${base}.${ext}`;
      const dest = path.join(outputDir, name);
      await cutClipSegmentCopy(input, dest, piece);
      results.push({
        name,
        label: `Parte ${i + 1} (${labelTime})`,
        path: dest,
      });
      params.onProgress?.(
        `Pedaço ${i + 1}/${total} pronto`,
        Math.round(((i + 1) / total) * 95),
      );
      continue;
    }

    const raw = path.join(
      workDir,
      `chunk_${String(i + 1).padStart(3, "0")}.mp4`,
    );
    if (useCopy) {
      await cutClipSegmentCopy(input, raw, piece);
    } else {
      await renderClipSegment(input, raw, piece, fps, quality, audioBitrate);
    }

    if (plain) {
      const name = `${base}.${ext}`;
      const dest = path.join(outputDir, name);
      await copyFile(raw, dest);
      results.push({
        name,
        label: `Parte ${i + 1} (${labelTime})`,
        path: dest,
      });
    }
    if (wantH) {
      const name = `${base}_16x9.${ext}`;
      const dest = path.join(outputDir, name);
      await exportHorizontal(raw, dest, resolution, undefined, encode);
      results.push({
        name,
        label: `Parte ${i + 1} 16:9 (${labelTime})`,
        path: dest,
      });
    }
    if (wantV) {
      const name = `${base}_9x16.${ext}`;
      const dest = path.join(outputDir, name);
      await exportVertical(
        raw,
        dest,
        resolution,
        options.verticalMode ?? "crop",
        undefined,
        encode,
        options.cropFocusX ?? 0.5,
      );
      results.push({
        name,
        label: `Parte ${i + 1} 9:16 (${labelTime})`,
        path: dest,
      });
    }
    await rm(raw, { force: true }).catch(() => undefined);
    params.onProgress?.(
      `Pedaço ${i + 1}/${total} pronto`,
      Math.round(((i + 1) / total) * 95),
    );
  }

  params.onProgress?.("Concluído", 100);
  return results;
}
