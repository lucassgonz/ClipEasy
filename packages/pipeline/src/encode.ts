import type { ExportFormat, ExportQuality, Resolution } from "./types.js";
import { qualitySettings, resolutionHeight } from "./types.js";

export interface EncodeOpts {
  fps?: number;
  quality?: ExportQuality;
  audioBitrate?: string;
  format?: ExportFormat;
  /**
   * Prefer wall-clock speed for software fallback (same CRF, faster preset).
   * `true` ≈ 1 preset step (mild); number = explicit steps.
   * Avoid large biases — they hurt quality. Prefer hardware encode instead.
   */
  speedBias?: boolean | number;
  /** When true, do not force `-r` (avoids fps resample cost). */
  keepSourceFps?: boolean;
  /** Copy audio bitstream when filters are not needed (same quality, faster). */
  copyAudio?: boolean;
  /**
   * Prefer Apple VideoToolbox when available (same visual target, much faster).
   * Defaults to true on darwin.
   */
  preferHardware?: boolean;
  /** Used to scale hardware bitrate with output size. */
  resolution?: Resolution;
  orientation?: "horizontal" | "vertical";
}

const PRESET_RANK = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;

let videoToolboxCache: boolean | null = null;

function fasterPreset(preset: string, steps = 1): string {
  const i = PRESET_RANK.indexOf(preset as (typeof PRESET_RANK)[number]);
  if (i < 0) return preset;
  return PRESET_RANK[Math.max(0, i - steps)]!;
}

/** One-shot probe: does this ffmpeg build + machine actually encode with VT? */
export async function isVideoToolboxAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") {
    videoToolboxCache = false;
    return false;
  }
  if (videoToolboxCache != null) return videoToolboxCache;
  try {
    const { runCommand } = await import("./binaries.js");
    const result = await runCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=128x128:d=0.2",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      "500k",
      "-f",
      "null",
      "-",
    ]);
    videoToolboxCache = result.code === 0;
  } catch {
    videoToolboxCache = false;
  }
  return videoToolboxCache;
}

/** Target bitrate for VT approximating libx264 CRF ladders at Shorts sizes. */
export function hardwareBitrate(
  quality: ExportQuality = "medium",
  resolution: Resolution = "1080p",
  orientation: "horizontal" | "vertical" = "vertical",
): string {
  const h = resolutionHeight(resolution);
  const w =
    orientation === "vertical" ? h : Math.round((h * 16) / 9);
  const vh =
    orientation === "vertical" ? Math.round((h * 16) / 9) : h;
  const megapixels = (w * vh) / 1_000_000;
  const basePerMp =
    quality === "low"
      ? 2.2
      : quality === "max"
        ? 7.5
        : quality === "high"
          ? 5.5
          : 4.0; // medium
  const mbps = Math.max(2.5, Math.min(24, megapixels * basePerMp));
  // Prefer integer Mbps strings ffmpeg accepts cleanly.
  if (mbps >= 10) return `${Math.round(mbps)}M`;
  return `${mbps.toFixed(1)}M`;
}

/** CRF + preset for libx264, optionally biased toward throughput. */
export function encodeProfile(opts: EncodeOpts = {}): {
  crf: number;
  preset: string;
} {
  const { crf, preset } = qualitySettings(opts.quality ?? "high");
  if (!opts.speedBias) return { crf, preset };
  const steps = typeof opts.speedBias === "number" ? opts.speedBias : 1;
  return { crf, preset: fasterPreset(preset, steps) };
}

function audioArgs(opts: EncodeOpts): string[] {
  if (opts.copyAudio) return ["-c:a", "copy"];
  return ["-c:a", "aac", "-b:a", opts.audioBitrate ?? "192k"];
}

function fpsArgs(opts: EncodeOpts): string[] {
  if (opts.fps && opts.fps > 0 && !opts.keepSourceFps) {
    return ["-r", String(opts.fps)];
  }
  return [];
}

/** Sync software encode args (no VT probe). Prefer `encodeVideoAudioArgsAsync`. */
export function encodeVideoAudioArgs(opts: EncodeOpts = {}): string[] {
  const { crf, preset } = encodeProfile(opts);
  return [
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    ...audioArgs(opts),
    "-movflags",
    "+faststart",
    ...fpsArgs(opts),
  ];
}

/**
 * Prefer VideoToolbox on Apple Silicon/macOS when the encoder session works.
 * Falls back to libx264 with mild/no speed bias (quality-preserving).
 */
export async function encodeVideoAudioArgsAsync(
  opts: EncodeOpts = {},
): Promise<string[]> {
  const wantHw = opts.preferHardware !== false && process.platform === "darwin";
  if (wantHw && (await isVideoToolboxAvailable())) {
    const bitrate = hardwareBitrate(
      opts.quality ?? "medium",
      opts.resolution ?? "1080p",
      opts.orientation ?? "vertical",
    );
    return [
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      bitrate,
      "-profile:v",
      "high",
      "-prio_speed",
      "true",
      ...audioArgs(opts),
      "-movflags",
      "+faststart",
      ...fpsArgs(opts),
    ];
  }
  // Software path: keep quality — at most one preset notch if speedBias set.
  return encodeVideoAudioArgs({
    ...opts,
    speedBias:
      opts.speedBias === true
        ? 1
        : typeof opts.speedBias === "number"
          ? Math.min(1, opts.speedBias)
          : false,
  });
}

/** Parse ffmpeg stderr `time=` into seconds. */
export function parseFfmpegTimeSeconds(chunk: string): number | null {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (![h, min, sec].every(Number.isFinite)) return null;
  return h * 3600 + min * 60 + sec;
}

export function makeFfmpegProgressHandler(
  durationSec: number,
  onRatio?: (ratio: number) => void,
): ((chunk: string) => void) | undefined {
  if (!onRatio || !(durationSec > 0)) return undefined;
  let last = -1;
  return (chunk: string) => {
    const t = parseFfmpegTimeSeconds(chunk);
    if (t == null) return;
    const ratio = Math.min(0.99, Math.max(0, t / durationSec));
    const bucket = Math.floor(ratio * 20);
    if (bucket === last) return;
    last = bucket;
    onRatio(ratio);
  };
}
