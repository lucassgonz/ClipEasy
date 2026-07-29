import { readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { mustRun, runCommand } from "./binaries.js";

/** Remux video without subtitle/data tracks (avoids double captions in preview). */
export async function stripMediaSubtitles(filePath: string): Promise<void> {
  const ext = path.extname(filePath) || ".mp4";
  const tmp = `${filePath}.nosubs${ext}`;
  try {
    await mustRun("ffmpeg", [
      "-y",
      "-i",
      filePath,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-sn",
      "-dn",
      tmp,
    ]);
    await rm(filePath, { force: true });
    await rename(tmp, filePath);
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
    // Keep original if remux fails (e.g. odd codecs).
  }
}

export async function downloadYoutube(
  url: string,
  outputDir: string,
  onProgress?: (message: string) => void,
): Promise<string> {
  const outTemplate = path.join(outputDir, "source.%(ext)s");
  const { code, stderr, stdout } = await runCommand(
    "yt-dlp",
    [
      "-f",
      "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
      "--merge-output-format",
      "mp4",
      "-o",
      outTemplate,
      "--no-playlist",
      "--no-write-subs",
      "--no-write-auto-subs",
      "--newline",
      url,
    ],
    (chunk) => onProgress?.(chunk.trim()),
  );

  if (code !== 0) {
    throw new Error(
      `yt-dlp falhou (código ${code}). Atualize com: brew upgrade yt-dlp\n${stderr || stdout}`,
    );
  }

  const files = await readdir(outputDir);
  const source = files.find(
    (f) =>
      f.startsWith("source.") &&
      !f.endsWith(".part") &&
      !f.endsWith(".ytdl"),
  );
  if (!source) {
    throw new Error("Download concluído, mas o arquivo de origem não foi encontrado");
  }
  const full = path.join(outputDir, source);
  onProgress?.("Removendo legendas embutidas do arquivo…");
  await stripMediaSubtitles(full);
  return full;
}
