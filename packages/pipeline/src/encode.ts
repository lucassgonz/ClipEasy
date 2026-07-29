import type { ExportFormat, ExportQuality } from "./types.js";
import { qualitySettings } from "./types.js";

export interface EncodeOpts {
  fps?: number;
  quality?: ExportQuality;
  audioBitrate?: string;
  format?: ExportFormat;
  /**
   * Prefer wall-clock speed (batch chunk exports). Same CRF, faster x264 preset.
   * `true` ≈ 3 preset steps; or pass an explicit step count.
   */
  speedBias?: boolean | number;
  /** When true, do not force `-r` (avoids fps resample cost). */
  keepSourceFps?: boolean;
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

function fasterPreset(preset: string, steps = 1): string {
  const i = PRESET_RANK.indexOf(preset as (typeof PRESET_RANK)[number]);
  if (i < 0) return preset;
  return PRESET_RANK[Math.max(0, i - steps)]!;
}

/** CRF + preset for libx264, optionally biased toward throughput. */
export function encodeProfile(opts: EncodeOpts = {}): {
  crf: number;
  preset: string;
} {
  const { crf, preset } = qualitySettings(opts.quality ?? "high");
  if (!opts.speedBias) return { crf, preset };
  // Batch Shorts: jump to ultrafast/superfast at the same CRF (big wall-clock win).
  const steps = typeof opts.speedBias === "number" ? opts.speedBias : 3;
  return { crf, preset: fasterPreset(preset, steps) };
}

/** Common libx264 + AAC tail (without output path). */
export function encodeVideoAudioArgs(opts: EncodeOpts = {}): string[] {
  const { crf, preset } = encodeProfile(opts);
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
  if (opts.fps && opts.fps > 0 && !opts.keepSourceFps) {
    args.push("-r", String(opts.fps));
  }
  return args;
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
