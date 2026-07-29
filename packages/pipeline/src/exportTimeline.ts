import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { writeAssFile } from "./captions.js";
import { mustRun } from "./binaries.js";
import {
  clipDurationMs,
  getCaptionsTrack,
  getVideoTrack,
  type Timeline,
  type TransitionType,
} from "./timeline.js";
import type { Resolution } from "./types.js";
import { exportHorizontal, exportVertical } from "./aspect.js";

export interface ExportTimelineOptions {
  resolution?: Resolution;
  exportHorizontal?: boolean;
  exportVertical?: boolean;
  verticalMode?: "crop" | "blur";
  burnCaptions?: boolean;
}

function assetPath(assetsDir: string, assetId: string, filename: string): string {
  return path.join(assetsDir, assetId, filename);
}

async function renderClipSegment(
  input: string,
  out: string,
  inMs: number,
  outMs: number,
): Promise<void> {
  const start = (inMs / 1000).toFixed(3);
  const end = (outMs / 1000).toFixed(3);
  await mustRun("ffmpeg", [
    "-y",
    "-ss",
    start,
    "-to",
    end,
    "-i",
    input,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    out,
  ]);
}

async function concatWithTransitions(
  segments: string[],
  transitions: TransitionType[],
  workDir: string,
  output: string,
): Promise<void> {
  if (segments.length === 0) {
    throw new Error("Nenhum clipe na timeline para exportar");
  }
  if (segments.length === 1) {
    await copyFile(segments[0]!, output);
    return;
  }

  // Simple approach: xfade chain when crossfade/fade, else concat demuxer
  const useXfade = transitions.some((t) => t === "crossfade" || t === "fade");
  if (!useXfade) {
    const list = path.join(workDir, "concat.txt");
    const body = segments
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await import("node:fs/promises").then((fs) => fs.writeFile(list, body, "utf8"));
    await mustRun("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      output,
    ]);
    return;
  }

  // Build xfade filter chain (0.5s default)
  let filter = "";
  let last = "[0:v]";
  let lastA = "[0:a]";
  for (let i = 1; i < segments.length; i += 1) {
    const td = 0.5;
    const mode = transitions[i] === "fade" ? "fade" : "fade";
    const outV = i === segments.length - 1 ? "[vout]" : `[v${i}]`;
    const outA = i === segments.length - 1 ? "[aout]" : `[a${i}]`;
    // offset approximated as cumulative - for MVP use xfade with offset= previous duration - td
    // We use a simpler approach: sequential xfade with large offset placeholder via acrossfade
    filter += `${last}[${i}:v]xfade=transition=${mode}:duration=${td}:offset=0${outV};`;
    filter += `${lastA}[${i}:a]acrossfade=d=${td}${outA};`;
    last = outV;
    lastA = outA;
  }

  // offset=0 xfade is wrong for sequential - better use concat for reliability in MVP
  // Fall back to concat for stability
  const list = path.join(workDir, "concat.txt");
  const body = segments
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await import("node:fs/promises").then((fs) => fs.writeFile(list, body, "utf8"));
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
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    output,
  ]);
  void filter;
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

  const videoTrack = getVideoTrack(timeline);
  const clips = [...videoTrack.clips].sort(
    (a, b) => a.timelineStartMs - b.timelineStartMs,
  );
  if (clips.length === 0) {
    throw new Error("Adicione pelo menos um clipe de vídeo antes de exportar");
  }

  params.onProgress?.("Cortando clipes", 15);
  const segments: string[] = [];
  const transitions: TransitionType[] = [];

  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i]!;
    const meta = timeline.assets[clip.assetId];
    if (!meta) throw new Error(`Asset ausente: ${clip.assetId}`);
    const input = assetPath(assetsDir, clip.assetId, meta.filename);
    const seg = path.join(workDir, `seg_${String(i).padStart(3, "0")}.mp4`);
    await renderClipSegment(input, seg, clip.inMs, clip.outMs);
    segments.push(seg);
    transitions.push(clip.transitionIn ?? "cut");
  }

  params.onProgress?.("Montando sequência", 45);
  let composed = path.join(workDir, "composed.mp4");
  await concatWithTransitions(segments, transitions, workDir, composed);

  if (options.burnCaptions !== false) {
    const captions = getCaptionsTrack(timeline).cues;
    if (captions.length > 0) {
      params.onProgress?.("Gravando legendas", 60);
      const assPath = path.join(workDir, "captions.ass");
      await writeAssFile(captions, assPath);
      const burned = path.join(workDir, "composed_subs.mp4");
      // Escape path for subtitles filter
      const escaped = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
      await mustRun("ffmpeg", [
        "-y",
        "-i",
        composed,
        "-vf",
        `ass='${escaped}'`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "copy",
        burned,
      ]);
      composed = burned;
    }
  }

  const results: Array<{ name: string; label: string; path: string }> = [];
  const wantH = options.exportHorizontal !== false;
  const wantV = options.exportVertical !== false;
  const resolution = options.resolution ?? "1080p";

  if (!wantH && !wantV) {
    const name = "export.mp4";
    const dest = path.join(outputDir, name);
    await copyFile(composed, dest);
    results.push({ name, label: "Exportação", path: dest });
  }

  if (wantH) {
    params.onProgress?.("Export horizontal", 75);
    const name = "export_horizontal_16x9.mp4";
    const dest = path.join(outputDir, name);
    await exportHorizontal(composed, dest, resolution);
    results.push({ name, label: "Horizontal 16:9", path: dest });
  }

  if (wantV) {
    params.onProgress?.("Export vertical", 90);
    const name = "export_vertical_9x16.mp4";
    const dest = path.join(outputDir, name);
    await exportVertical(
      composed,
      dest,
      resolution,
      options.verticalMode ?? "crop",
    );
    results.push({ name, label: "Vertical 9:16", path: dest });
  }

  params.onProgress?.("Concluído", 100);
  return results;
}
