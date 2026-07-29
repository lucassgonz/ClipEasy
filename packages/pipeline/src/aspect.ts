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

  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}:(iw-${width})*${focus.toFixed(4)}:(ih-${height})/2`,
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
