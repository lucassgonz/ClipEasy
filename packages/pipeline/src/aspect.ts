import path from "node:path";
import { mustRun } from "./binaries.js";
import type { Resolution, VerticalMode } from "./types.js";
import { resolutionHeight } from "./types.js";

function targetSize(res: Resolution, orientation: "horizontal" | "vertical") {
  const h = resolutionHeight(res);
  if (orientation === "horizontal") {
    return { width: Math.round((h * 16) / 9), height: h };
  }
  return { width: h, height: Math.round((h * 16) / 9) };
}

export async function exportHorizontal(
  inputPath: string,
  outputPath: string,
  resolution: Resolution,
  onProgress?: (chunk: string) => void,
): Promise<void> {
  const { width, height } = targetSize(resolution, "horizontal");
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
  ].join(",");

  await mustRun(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      "-vf",
      filter,
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
      outputPath,
    ],
    onProgress,
  );
}

export async function exportVertical(
  inputPath: string,
  outputPath: string,
  resolution: Resolution,
  mode: VerticalMode,
  onProgress?: (chunk: string) => void,
): Promise<void> {
  const { width, height } = targetSize(resolution, "vertical");
  const commonTail = [
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
    outputPath,
  ];

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
        ...commonTail,
      ],
      onProgress,
    );
    return;
  }

  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
  ].join(",");

  await mustRun(
    "ffmpeg",
    ["-y", "-i", inputPath, "-vf", filter, ...commonTail],
    onProgress,
  );
}

export function labeledOutputName(
  base: string,
  kind: "horizontal" | "vertical" | "original",
): string {
  const stem = path.parse(base).name;
  if (kind === "original") return `${stem}.mp4`;
  if (kind === "horizontal") return `${stem}_horizontal_16x9.mp4`;
  return `${stem}_vertical_9x16.mp4`;
}
