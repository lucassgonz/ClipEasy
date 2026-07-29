import { mustRun } from "./binaries.js";
import type { Resolution } from "./types.js";
import { resolutionHeight } from "./types.js";

export type ImageAspect = "16:9" | "9:16";

export interface ImageCropBox {
  /** Normalized 0–1 relative to source image */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageExportOptions {
  aspect: ImageAspect;
  resolution: Resolution;
  crop: ImageCropBox;
  brightness?: number;
  contrast?: number;
}

export function targetImageSize(
  aspect: ImageAspect,
  resolution: Resolution,
): { width: number; height: number } {
  const short = resolutionHeight(resolution);
  if (aspect === "16:9") {
    return { width: Math.round((short * 16) / 9), height: short };
  }
  return { width: Math.round((short * 9) / 16), height: short };
}

/** Center crop box in normalized coords for target aspect */
export function centerCropBox(
  srcW: number,
  srcH: number,
  aspect: ImageAspect,
): ImageCropBox {
  const targetRatio = aspect === "16:9" ? 16 / 9 : 9 / 16;
  const srcRatio = srcW / srcH;
  let w: number;
  let h: number;
  if (srcRatio > targetRatio) {
    h = 1;
    w = (targetRatio * srcH) / srcW;
  } else {
    w = 1;
    h = srcW / targetRatio / srcH;
  }
  return {
    x: (1 - w) / 2,
    y: (1 - h) / 2,
    w,
    h,
  };
}

export async function exportImage(params: {
  inputPath: string;
  outputPath: string;
  sourceWidth: number;
  sourceHeight: number;
  options: ImageExportOptions;
}): Promise<void> {
  const { width: outW, height: outH } = targetImageSize(
    params.options.aspect,
    params.options.resolution,
  );
  const { crop } = params.options;
  const cropW = Math.max(1, Math.round(crop.w * params.sourceWidth));
  const cropH = Math.max(1, Math.round(crop.h * params.sourceHeight));
  const cropX = Math.max(
    0,
    Math.min(
      params.sourceWidth - cropW,
      Math.round(crop.x * params.sourceWidth),
    ),
  );
  const cropY = Math.max(
    0,
    Math.min(
      params.sourceHeight - cropH,
      Math.round(crop.y * params.sourceHeight),
    ),
  );

  const filters = [
    `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
    `scale=${outW}:${outH}`,
  ];
  const b = params.options.brightness ?? 0;
  const c = params.options.contrast ?? 1;
  if (b !== 0 || c !== 1) {
    filters.push(`eq=brightness=${b}:contrast=${c}`);
  }

  await mustRun("ffmpeg", [
    "-y",
    "-i",
    params.inputPath,
    "-vf",
    filters.join(","),
    "-frames:v",
    "1",
    params.outputPath,
  ]);
}

export function imageOutputName(aspect: ImageAspect, resolution: Resolution): string {
  const tag = aspect === "16:9" ? "16x9" : "9x16";
  return `image_${tag}_${resolution}.jpg`;
}
