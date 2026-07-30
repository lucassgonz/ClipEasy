import path from "node:path";
import { mustRun } from "./binaries.js";
import {
  encodeVideoAudioArgsAsync,
  type EncodeOpts,
} from "./encode.js";
import type { ExportFormat, Resolution, VerticalMode } from "./types.js";
import { resolutionHeight } from "./types.js";

function targetSize(res: Resolution, orientation: "horizontal" | "vertical") {
  const h = resolutionHeight(res);
  if (orientation === "horizontal") {
    return { width: Math.round((h * 16) / 9), height: h };
  }
  return { width: h, height: Math.round((h * 16) / 9) };
}

export type { EncodeOpts };

export interface CropFocusKeyframe {
  tMs: number;
  x: number;
}

async function encodeTail(
  outputPath: string,
  opts: EncodeOpts = {},
): Promise<string[]> {
  const args = await encodeVideoAudioArgsAsync(opts);
  return [...args, outputPath];
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Escape commas inside a filter expression embedded in a comma-joined -vf chain. */
function escExpr(expr: string): string {
  return expr.replace(/,/g, "\\,");
}

/**
 * Drop near-static tracks to a single focus, and cap keypoints so crop exprs stay small.
 */
export function simplifyCropFocusTrack(
  track: CropFocusKeyframe[] | undefined,
  fallback = 0.5,
  maxPts = 16,
): CropFocusKeyframe[] | undefined {
  if (!track || track.length === 0) return undefined;
  const sorted = [...track]
    .map((k) => ({ tMs: Math.max(0, k.tMs), x: clamp01(k.x) }))
    .sort((a, b) => a.tMs - b.tMs);
  const xs = sorted.map((k) => k.x);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  if (max - min < 0.045) {
    const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
    return [{ tMs: 0, x: avg }];
  }
  if (sorted.length <= maxPts) return sorted;
  const used: CropFocusKeyframe[] = [];
  const step = (sorted.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i += 1) {
    used.push(sorted[Math.round(i * step)]!);
  }
  return used.length ? used : [{ tMs: 0, x: fallback }];
}

/**
 * Piecewise-linear focus(t) for ffmpeg crop x expression (uses `t`).
 * `t` is seconds from the start of the input being cropped.
 */
export function buildCropFocusExpr(
  track: CropFocusKeyframe[],
  fallback = 0.5,
): string {
  const pts = (simplifyCropFocusTrack(track, fallback) ?? []).map((k) => ({
    t: k.tMs / 1000,
    x: clamp01(k.x),
  }));
  if (pts.length === 0) return fallback.toFixed(4);
  if (pts.length === 1) return pts[0]!.x.toFixed(4);

  let expr = pts[pts.length - 1]!.x.toFixed(4);
  for (let i = pts.length - 2; i >= 0; i -= 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const span = Math.max(0.001, b.t - a.t);
    const lerp = `${a.x.toFixed(4)}+(${b.x.toFixed(4)}-${a.x.toFixed(4)})*(t-${a.t.toFixed(4)})/${span.toFixed(4)}`;
    expr = `if(lt(t,${b.t.toFixed(4)}),${lerp},${expr})`;
  }
  const first = pts[0]!;
  if (first.t > 0.001) {
    expr = `if(lt(t,${first.t.toFixed(4)}),${first.x.toFixed(4)},${expr})`;
  }
  return expr;
}

/** Shift track so t=0 is `offsetMs` on the original timeline (for per-clip exports). */
export function offsetCropFocusTrack(
  track: CropFocusKeyframe[] | undefined,
  offsetMs: number,
  durationMs?: number,
): CropFocusKeyframe[] | undefined {
  if (!track || track.length === 0) return undefined;
  const end = durationMs != null ? offsetMs + durationMs : Infinity;
  const mapped = track
    .filter((k) => k.tMs >= offsetMs - 1 && k.tMs <= end + 1)
    .map((k) => ({ tMs: Math.max(0, k.tMs - offsetMs), x: clamp01(k.x) }));
  if (mapped.length === 0) {
    // Pick nearest keyframe at the offset.
    let nearest = track[0]!;
    let best = Math.abs(nearest.tMs - offsetMs);
    for (const k of track) {
      const d = Math.abs(k.tMs - offsetMs);
      if (d < best) {
        best = d;
        nearest = k;
      }
    }
    return [{ tMs: 0, x: clamp01(nearest.x) }];
  }
  if (mapped[0]!.tMs > 0) {
    mapped.unshift({ tMs: 0, x: mapped[0]!.x });
  }
  return simplifyCropFocusTrack(mapped);
}

/** Horizontal cover scale + center crop. */
export function buildHorizontalVf(width: number, height: number): string {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
  ].join(",");
}

/** Median focus for a track window (fast static crop per chunk). */
export function medianCropFocus(
  track: CropFocusKeyframe[] | undefined,
  fallback = 0.5,
): number {
  if (!track || track.length === 0) return clamp01(fallback);
  const xs = track.map((k) => clamp01(k.x)).sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)]!;
}

/** Vertical cover scale + focus crop (static or animated). */
export function buildVerticalCropVf(
  width: number,
  height: number,
  cropFocusX = 0.5,
  cropFocusTrack?: CropFocusKeyframe[],
): string {
  const focus = Math.min(1, Math.max(0, cropFocusX));
  const simplified = simplifyCropFocusTrack(cropFocusTrack, focus);
  // Animated crop only when the face actually moves; otherwise a constant is faster.
  const useTrack = simplified && simplified.length > 1;
  const xExpr = useTrack
    ? `(iw-${width})*(${escExpr(buildCropFocusExpr(simplified!, focus))})`
    : `(iw-${width})*${(simplified?.[0]?.x ?? focus).toFixed(4)}`;
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}:${xExpr}:(ih-${height})/2`,
    "setsar=1",
  ].join(",");
}

export function verticalTargetSize(resolution: Resolution): {
  width: number;
  height: number;
} {
  return targetSize(resolution, "vertical");
}

export function horizontalTargetSize(resolution: Resolution): {
  width: number;
  height: number;
} {
  return targetSize(resolution, "horizontal");
}

export async function exportHorizontal(
  inputPath: string,
  outputPath: string,
  resolution: Resolution,
  onProgress?: (chunk: string) => void,
  encode: EncodeOpts = {},
): Promise<void> {
  const { width, height } = targetSize(resolution, "horizontal");
  const filter = buildHorizontalVf(width, height);
  const tail = await encodeTail(outputPath, {
    ...encode,
    resolution,
    orientation: "horizontal",
    copyAudio: encode.copyAudio ?? true,
  });

  await mustRun(
    "ffmpeg",
    ["-y", "-i", inputPath, "-vf", filter, ...tail],
    onProgress,
  );
}

export async function exportVertical(
  inputPath: string,
  outputPath: string,
  resolution: Resolution,
  mode: VerticalMode,
  onProgress?: (chunk: string) => void,
  encode: EncodeOpts = {},
  cropFocusX = 0.5,
  cropFocusTrack?: CropFocusKeyframe[],
  assFilter?: string,
): Promise<void> {
  const { width, height } = targetSize(resolution, "vertical");
  const focus = Math.min(1, Math.max(0, cropFocusX));
  const tail = await encodeTail(outputPath, {
    ...encode,
    resolution,
    orientation: "vertical",
    copyAudio: encode.copyAudio ?? true,
  });
  const assSuffix = assFilter ? `,${assFilter}` : "";

  if (mode === "blur") {
    const filterComplex = [
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=20[bg]`,
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${assFilter ? `,${assFilter}` : ""}[v]`,
    ].join(";");

    await mustRun(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-filter_complex",
        filterComplex,
        "-map",
        "[v]",
        "-map",
        "0:a?",
        ...tail,
      ],
      onProgress,
    );
    return;
  }

  const filter =
    buildVerticalCropVf(width, height, focus, cropFocusTrack) + assSuffix;

  await mustRun(
    "ffmpeg",
    ["-y", "-i", inputPath, "-vf", filter, ...tail],
    onProgress,
  );
}

export async function exportHorizontalWithAss(
  inputPath: string,
  outputPath: string,
  resolution: Resolution,
  assFilter: string,
  onProgress?: (chunk: string) => void,
  encode: EncodeOpts = {},
): Promise<void> {
  const { width, height } = targetSize(resolution, "horizontal");
  const filter = `${buildHorizontalVf(width, height)},${assFilter}`;
  const tail = await encodeTail(outputPath, {
    ...encode,
    resolution,
    orientation: "horizontal",
    copyAudio: encode.copyAudio ?? true,
  });
  await mustRun(
    "ffmpeg",
    ["-y", "-i", inputPath, "-vf", filter, ...tail],
    onProgress,
  );
}

export function labeledOutputName(
  base: string,
  kind: "horizontal" | "vertical" | "original",
  format: ExportFormat = "mp4",
): string {
  const stem = path.parse(base).name;
  const ext = format === "mov" ? "mov" : "mp4";
  if (kind === "original") return `${stem}.${ext}`;
  if (kind === "horizontal") return `${stem}_horizontal_16x9.${ext}`;
  return `${stem}_vertical_9x16.${ext}`;
}
