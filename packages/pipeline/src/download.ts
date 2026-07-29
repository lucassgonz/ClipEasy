import { readdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./binaries.js";

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
  return path.join(outputDir, source);
}
