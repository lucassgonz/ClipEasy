import path from "node:path";
import { mustRun } from "./binaries.js";
import type { ExportFormat, ExportQuality, Resolution, VerticalMode } from "./types.js";
import { qualitySettings, resolutionHeight } from "./types.js";

function targetSize(res: Resolution, orientation: "horizontal" | "vertical") {
  const h = resolutionHeight(res);
  if (orientation === "horizontal") {
    return { width: Math.round((h * 16) / 9), height: h };
  }
  return { width: h, height: Math.round((h * 16) / 9) };
}

export interface EncodeOpts {
  fps?: number;
  quality?: ExportQuality;
  audioBitrate?: string;
  format?: ExportFormat;
}

export interface CropFocusKeyframe {
  tMs: number;
  x: number;
}

function encodeTail(outputPath: string, opts: EncodeOpts = {}): string[] {
  const { crf, preset } = qualitySettings(opts.quality ?? "high");
  const args = [
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-c:a",
    "aac",
    "-b:a",
    opts.audioBitrate ?? "192k",
    "-movflags",
    "+faststart",
  ];
  if (opts.fps && opts.fps > 0) {
    args.push("-r", String(opts.fps));
  }
  args.push(outputPath);
  return args;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Escape commas inside a filter expression embedded in a comma-joined -vf chain. */
function escExpr(expr: string): string {
  return expr.replace(/,/g, "\\,");
}

/**
 * Piecewise-linear focus(t) for ffmpeg crop x expression (uses `t`).
 * `t` is seconds from the start of the input being cropped.
 */
export function buildCropFocusExpr(
  track: CropFocusKeyframe[],
  fallback = 0.5,
): string {
  const pts = track
    .map((k) => ({ t: Math.max(0, k.tMs) / 1000, x: clamp01(k.x) }))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return fallback.toFixed(4);
  if (pts.length === 1) return pts[0]!.x.toFixed(4);

  // Cap expression size for long tracks.
  const maxPts = 60;
  let used = pts;
  if (pts.length > maxPts) {
    const step = (pts.length - 1) / (maxPts - 1);
    used = [];
    for (let i = 0; i < maxPts; i += 1) {
      used.push(pts[Math.round(i * step)]!);
    }
  }

  let expr = used[used.length - 1]!.x.toFixed(4);
  for (let i = used.length - 2; i >= 0; i -= 1) {
    const a = used[i]!;
    const b = used[i + 1]!;
    const span = Math.max(0.001, b.t - a.t);
    const lerp = `${a.x.toFixed(4)}+(${b.x.toFixed(4)}-${a.x.toFixed(4)})*(t-${a.t.toFixed(4)})/${span.toFixed(4)}`;
    expr = `if(lt(t,${b.t.toFixed(4)}),${lerp},${expr})`;
  }
  const first = used[0]!;
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
  return mapped;
}

export async function exportHorizontal(
  inputPath: string,
  outputPath: string,
  resolution: Resolution,
  onProgress?: (chunk: string) => void,
  encode: EncodeOpts = {},
): Promise<void> {
  const { width, height } = targetSize(resolution, "horizontal");
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
  ].join(",");

  await mustRun(
    "ffmpeg",
    ["-y", "-i", inputPath, "-vf", filter, ...encodeTail(outputPath, encode)],
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
): Promise<void> {
  const { width, height } = targetSize(resolution, "vertical");
  const focus = Math.min(1, Math.max(0, cropFocusX));
  const tail = encodeTail(outputPath, encode);

  if (mode === "blur") {
    const filterComplex = [
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=20[bg]`,
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`,
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

  const useTrack = cropFocusTrack && cropFocusTrack.length > 0;
  const xExpr = useTrack
    ? `(iw-${width})*(${escExpr(buildCropFocusExpr(cropFocusTrack!, focus))})`
    : `(iw-${width})*${focus.toFixed(4)}`;

  // Note: some static ffmpeg builds (e.g. 6.0) have no crop `eval=` option;
  // x/y expressions are still timeline-evaluated when they reference `t`.
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}:${xExpr}:(ih-${height})/2`,
    "setsar=1",
  ].join(",");

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
