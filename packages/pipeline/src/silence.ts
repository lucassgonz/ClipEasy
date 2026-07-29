import { writeFile } from "node:fs/promises";
import path from "node:path";
import { mustRun, probeDurationSeconds, runCommand } from "./binaries.js";

interface SilenceInterval {
  start: number;
  end: number;
}

export interface SilenceRemovalResult {
  path: string;
  changed: boolean;
  silenceCount: number;
  originalDurationSec: number;
  newDurationSec: number;
  message: string;
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

/** Collect only silencedetect lines — full ffmpeg stderr can exceed the cap. */
async function detectSilences(
  inputPath: string,
  thresholdDb: number,
  minDuration: number,
  onProgress?: (chunk: string) => void,
): Promise<SilenceInterval[]> {
  let silenceLog = "";
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
    (chunk) => {
      onProgress?.(chunk);
      for (const line of chunk.split("\n")) {
        if (line.includes("silence_start") || line.includes("silence_end")) {
          silenceLog += `${line}\n`;
        }
      }
    },
  );
  // Prefer incremental log; fall back to full stderr if callback missed lines.
  const source = silenceLog || detect.stderr;
  return parseSilence(source);
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r.toString().padStart(2, "0")}s` : `${r}s`;
}

export async function removeSilence(
  inputPath: string,
  outputDir: string,
  thresholdDb: number,
  minDuration: number,
  onProgress?: (chunk: string) => void,
): Promise<SilenceRemovalResult> {
  const duration = await probeDurationSeconds(inputPath);
  const silences = await detectSilences(
    inputPath,
    thresholdDb,
    minDuration,
    onProgress,
  );
  const keeps = keepSegments(duration, silences);

  if (keeps.length === 0) {
    throw new Error(
      "Após remover silêncios o vídeo ficaria vazio. Ajuste o limiar ou desative a opção.",
    );
  }

  if (
    silences.length === 0 ||
    (keeps.length === 1 &&
      keeps[0]!.start <= 0.05 &&
      keeps[0]!.end >= duration - 0.05)
  ) {
    return {
      path: inputPath,
      changed: false,
      silenceCount: 0,
      originalDurationSec: duration,
      newDurationSec: duration,
      message: `Nenhum silêncio longo detectado (≥ ${minDuration}s abaixo de ${thresholdDb} dB). Vídeo inalterado (${formatDuration(duration)}).`,
    };
  }

  const segmentPaths: string[] = [];
  await Promise.all(
    keeps.map(async (seg, i) => {
      const out = path.join(outputDir, `silence_seg_${i}.mp4`);
      const segDuration = Math.max(0.1, seg.end - seg.start);
      // Stream-copy cuts are keyframe-aligned and much faster than re-encoding.
      await mustRun(
        "ffmpeg",
        [
          "-y",
          "-ss",
          String(seg.start),
          "-i",
          inputPath,
          "-t",
          String(segDuration),
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          "-movflags",
          "+faststart",
          out,
        ],
        onProgress,
      );
      segmentPaths[i] = out;
    }),
  );

  let outPath: string;
  if (segmentPaths.length === 1) {
    outPath = segmentPaths[0]!;
  } else {
    const listPath = path.join(outputDir, "silence_concat.txt");
    const listBody = segmentPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(listPath, listBody, "utf8");

    outPath = path.join(outputDir, "no_silence.mp4");
    await mustRun(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
      onProgress,
    );
  }

  const newDuration = await probeDurationSeconds(outPath);
  const saved = Math.max(0, duration - newDuration);
  return {
    path: outPath,
    changed: true,
    silenceCount: silences.length,
    originalDurationSec: duration,
    newDurationSec: newDuration,
    message: `Removidos ${silences.length} trecho(s) de silêncio. Duração ${formatDuration(duration)} → ${formatDuration(newDuration)} (economizou ${formatDuration(saved)}).`,
  };
}
