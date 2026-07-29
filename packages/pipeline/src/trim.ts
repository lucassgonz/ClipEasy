import path from "node:path";
import { mustRun, probeDurationSeconds } from "./binaries.js";
import type { JobOptions } from "./types.js";

export async function applyTrim(
  inputPath: string,
  outputDir: string,
  options: JobOptions,
  onProgress?: (chunk: string) => void,
): Promise<string> {
  const duration = await probeDurationSeconds(inputPath);
  let start = 0;
  let end = duration;

  if (
    options.keepFromSeconds !== undefined ||
    options.keepToSeconds !== undefined
  ) {
    start = Math.max(0, options.keepFromSeconds ?? 0);
    end = Math.min(duration, options.keepToSeconds ?? duration);
  } else {
    start = Math.max(0, options.cutStartSeconds ?? options.trimStartSeconds ?? 0);
    end =
      duration -
      Math.max(0, options.cutEndSeconds ?? options.trimEndSeconds ?? 0);
  }

  if (end <= start + 0.1) {
    throw new Error("Intervalo de corte inválido: o vídeo ficaria vazio");
  }

  if (start <= 0.05 && end >= duration - 0.05) {
    return inputPath;
  }

  const out = path.join(outputDir, "trimmed.mp4");
  await mustRun(
    "ffmpeg",
    [
      "-y",
      "-ss",
      String(start),
      "-to",
      String(end),
      "-i",
      inputPath,
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
    ],
    onProgress,
  );
  return out;
}

export async function splitVideo(
  inputPath: string,
  outputDir: string,
  everySeconds: number,
  onProgress?: (chunk: string) => void,
): Promise<string[]> {
  if (everySeconds <= 0) {
    throw new Error("Duração do pedaço deve ser maior que zero");
  }

  const duration = await probeDurationSeconds(inputPath);
  const parts: string[] = [];
  let index = 0;

  for (let start = 0; start < duration - 0.05; start += everySeconds) {
    const end = Math.min(duration, start + everySeconds);
    const out = path.join(
      outputDir,
      `part_${String(index + 1).padStart(3, "0")}.mp4`,
    );
    await mustRun(
      "ffmpeg",
      [
        "-y",
        "-ss",
        String(start),
        "-to",
        String(end),
        "-i",
        inputPath,
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
      ],
      onProgress,
    );
    parts.push(out);
    index += 1;
  }

  if (parts.length === 0) {
    throw new Error("Não foi possível dividir o vídeo");
  }
  return parts;
}
