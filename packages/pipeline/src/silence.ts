import { writeFile } from "node:fs/promises";
import path from "node:path";
import { mustRun, probeDurationSeconds, runCommand } from "./binaries.js";

interface SilenceInterval {
  start: number;
  end: number;
}

function parseSilence(stderr: string): SilenceInterval[] {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) starts.push(Number(startMatch[1]));
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
    if (endMatch) ends.push(Number(endMatch[1]));
  }

  const intervals: SilenceInterval[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!;
    const end = ends[i] ?? start;
    if (end > start) intervals.push({ start, end });
  }
  return intervals;
}

function keepSegments(
  duration: number,
  silences: SilenceInterval[],
): Array<{ start: number; end: number }> {
  const keeps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.start > cursor + 0.05) {
      keeps.push({ start: cursor, end: silence.start });
    }
    cursor = Math.max(cursor, silence.end);
  }
  if (duration > cursor + 0.05) {
    keeps.push({ start: cursor, end: duration });
  }
  return keeps.filter((s) => s.end - s.start >= 0.1);
}

export async function removeSilence(
  inputPath: string,
  outputDir: string,
  thresholdDb: number,
  minDuration: number,
  onProgress?: (chunk: string) => void,
): Promise<string> {
  const duration = await probeDurationSeconds(inputPath);
  const detect = await runCommand(
    "ffmpeg",
    [
      "-i",
      inputPath,
      "-af",
      `silencedetect=noise=${thresholdDb}dB:d=${minDuration}`,
      "-f",
      "null",
      "-",
    ],
    onProgress,
  );

  const silences = parseSilence(detect.stderr);
  const keeps = keepSegments(duration, silences);

  if (keeps.length === 0) {
    throw new Error(
      "Após remover silêncios o vídeo ficaria vazio. Ajuste o limiar ou desative a opção.",
    );
  }

  if (
    keeps.length === 1 &&
    keeps[0]!.start <= 0.05 &&
    keeps[0]!.end >= duration - 0.05
  ) {
    return inputPath;
  }

  const segmentPaths: string[] = [];
  for (let i = 0; i < keeps.length; i += 1) {
    const seg = keeps[i]!;
    const out = path.join(outputDir, `silence_seg_${i}.mp4`);
    await mustRun(
      "ffmpeg",
      [
        "-y",
        "-ss",
        String(seg.start),
        "-to",
        String(seg.end),
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
        out,
      ],
      onProgress,
    );
    segmentPaths.push(out);
  }

  if (segmentPaths.length === 1) {
    return segmentPaths[0]!;
  }

  const listPath = path.join(outputDir, "silence_concat.txt");
  const listBody = segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeFile(listPath, listBody, "utf8");

  const out = path.join(outputDir, "no_silence.mp4");
  await mustRun(
    "ffmpeg",
    ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", out],
    onProgress,
  );
  return out;
}
