import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  exportHorizontal,
  exportVertical,
  labeledOutputName,
} from "./aspect.js";
import { downloadYoutube } from "./download.js";
import { removeSilence } from "./silence.js";
import { applyTrim, splitVideo } from "./trim.js";
import {
  DEFAULT_OPTIONS,
  normalizeOptions,
  type JobOptions,
  type JobOutputFile,
  type JobSource,
} from "./types.js";

export interface RunPipelineParams {
  jobId: string;
  workDir: string;
  outputDir: string;
  source: JobSource;
  uploadPath?: string;
  options: JobOptions;
  onProgress: (step: string, percent: number, detail?: string) => void;
}

function mergeOptions(options: JobOptions): JobOptions {
  const normalized = normalizeOptions(options);
  return {
    ...DEFAULT_OPTIONS,
    ...normalized,
    silenceThresholdDb:
      normalized.silenceThresholdDb ?? DEFAULT_OPTIONS.silenceThresholdDb,
    silenceMinDurationSeconds:
      normalized.silenceMinDurationSeconds ??
      DEFAULT_OPTIONS.silenceMinDurationSeconds,
    verticalMode: normalized.verticalMode ?? DEFAULT_OPTIONS.verticalMode,
    resolution: normalized.resolution ?? DEFAULT_OPTIONS.resolution,
  };
}

async function fileInfo(
  filePath: string,
  label: string,
): Promise<JobOutputFile> {
  const info = await stat(filePath);
  return {
    name: path.basename(filePath),
    label,
    sizeBytes: info.size,
  };
}

export async function runPipeline(
  params: RunPipelineParams,
): Promise<JobOutputFile[]> {
  const options = mergeOptions(params.options);
  await mkdir(params.workDir, { recursive: true });
  await mkdir(params.outputDir, { recursive: true });

  params.onProgress("Baixando / preparando mídia", 5);
  let current: string;
  if (params.source.type === "youtube") {
    current = await downloadYoutube(params.source.url, params.workDir, (m) =>
      params.onProgress("Baixando do YouTube", 10, m),
    );
  } else {
    if (!params.uploadPath) {
      throw new Error("Arquivo de upload não encontrado");
    }
    const ext = path.extname(params.uploadPath) || ".mp4";
    current = path.join(params.workDir, `source${ext}`);
    await copyFile(params.uploadPath, current);
  }

  params.onProgress("Aplicando cortes de tempo", 25);
  current = await applyTrim(current, params.workDir, options, () =>
    params.onProgress("Aplicando cortes de tempo", 30),
  );

  if (options.removeSilence) {
    params.onProgress("Removendo silêncios", 45);
    const silence = await removeSilence(
      current,
      params.workDir,
      options.silenceThresholdDb ?? DEFAULT_OPTIONS.silenceThresholdDb,
      options.silenceMinDurationSeconds ??
        DEFAULT_OPTIONS.silenceMinDurationSeconds,
      () => params.onProgress("Removendo silêncios", 50),
    );
    current = silence.path;
  }

  let clips: string[];
  if (options.splitEverySeconds && options.splitEverySeconds > 0) {
    params.onProgress("Dividindo em pedaços", 60);
    clips = await splitVideo(
      current,
      params.workDir,
      options.splitEverySeconds,
      () => params.onProgress("Dividindo em pedaços", 65),
    );
  } else {
    clips = [current];
  }

  const wantH = options.exportHorizontal !== false;
  const wantV = options.exportVertical !== false;
  const wantOriginal = !wantH && !wantV;

  const outputs: JobOutputFile[] = [];
  const totalExports =
    clips.length * ((wantH ? 1 : 0) + (wantV ? 1 : 0) + (wantOriginal ? 1 : 0));
  let done = 0;

  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i]!;
    const baseName =
      clips.length === 1 ? "clip" : `clip_${String(i + 1).padStart(3, "0")}`;

    if (wantOriginal) {
      const name = labeledOutputName(baseName, "original");
      const dest = path.join(params.outputDir, name);
      await copyFile(clip, dest);
      outputs.push(await fileInfo(dest, `Original — ${baseName}`));
      done += 1;
      params.onProgress(
        "Exportando",
        70 + Math.round((done / Math.max(totalExports, 1)) * 25),
      );
    }

    if (wantH) {
      const name = labeledOutputName(baseName, "horizontal");
      const dest = path.join(params.outputDir, name);
      params.onProgress(
        `Gerando horizontal 16:9 (${i + 1}/${clips.length})`,
        70 + Math.round((done / Math.max(totalExports, 1)) * 25),
      );
      await exportHorizontal(clip, dest, options.resolution ?? "1080p");
      outputs.push(await fileInfo(dest, `Horizontal 16:9 — ${baseName}`));
      done += 1;
    }

    if (wantV) {
      const name = labeledOutputName(baseName, "vertical");
      const dest = path.join(params.outputDir, name);
      params.onProgress(
        `Gerando vertical 9:16 (${i + 1}/${clips.length})`,
        70 + Math.round((done / Math.max(totalExports, 1)) * 25),
      );
      await exportVertical(
        clip,
        dest,
        options.resolution ?? "1080p",
        options.verticalMode ?? "crop",
      );
      outputs.push(await fileInfo(dest, `Vertical 9:16 — ${baseName}`));
      done += 1;
    }
  }

  params.onProgress("Concluído", 100);
  return outputs;
}
