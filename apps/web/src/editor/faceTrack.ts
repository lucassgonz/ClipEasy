import {
  FaceDetector,
  FilesetResolver,
  type Detection,
} from "@mediapipe/tasks-vision";
import {
  clipSpeed,
  findActiveVideoClip,
  type CropFocusKeyframe,
  type Timeline,
} from "../types";

const WASM_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const SAMPLE_MS = 500;
const EMA_ALPHA = 0.35;
const SPARSIFY_MIN_DELTA = 0.025;
const SPARSIFY_MAX_GAP_MS = 2000;

let detectorPromise: Promise<FaceDetector> | null = null;

async function getDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
      try {
        return await FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate: "GPU",
          },
          runningMode: "IMAGE",
          minDetectionConfidence: 0.45,
        });
      } catch {
        return FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate: "CPU",
          },
          runningMode: "IMAGE",
          minDetectionConfidence: 0.45,
        });
      }
    })();
  }
  return detectorPromise;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Map normalized face center X → cropFocusX for 9:16 cover crop (matches exportVertical). */
export function faceXToCropFocus(
  faceX: number,
  srcAspect: number,
  dstAspect = 9 / 16,
): number {
  if (!(srcAspect > dstAspect + 0.001)) return 0.5;
  const focus =
    (faceX * srcAspect - dstAspect / 2) / (srcAspect - dstAspect);
  return clamp01(focus);
}

export function interpolateCropFocus(
  track: CropFocusKeyframe[] | undefined,
  timeMs: number,
  fallback = 0.5,
): number {
  if (!track || track.length === 0) return fallback;
  if (track.length === 1) return clamp01(track[0]!.x);
  if (timeMs <= track[0]!.tMs) return clamp01(track[0]!.x);
  const last = track[track.length - 1]!;
  if (timeMs >= last.tMs) return clamp01(last.x);

  for (let i = 0; i < track.length - 1; i += 1) {
    const a = track[i]!;
    const b = track[i + 1]!;
    if (timeMs >= a.tMs && timeMs <= b.tMs) {
      const span = Math.max(1, b.tMs - a.tMs);
      const t = (timeMs - a.tMs) / span;
      return clamp01(a.x + (b.x - a.x) * t);
    }
  }
  return fallback;
}

function boxArea(d: Detection): number {
  const box = d.boundingBox;
  if (!box) return 0;
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function boxCenterX(d: Detection, frameW: number): number {
  const box = d.boundingBox;
  if (!box || frameW <= 0) return 0.5;
  return clamp01((box.originX + box.width / 2) / frameW);
}

function pickPrimaryFace(
  detections: Detection[],
  frameW: number,
  prevFaceX: number | null,
): number | null {
  if (detections.length === 0) return null;
  if (detections.length === 1) {
    return boxCenterX(detections[0]!, frameW);
  }

  if (prevFaceX != null) {
    let best = detections[0]!;
    let bestDist = Infinity;
    for (const d of detections) {
      const x = boxCenterX(d, frameW);
      const dist = Math.abs(x - prevFaceX);
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    if (bestDist > 0.35) {
      const largest = detections.reduce((a, b) =>
        boxArea(a) >= boxArea(b) ? a : b,
      );
      return boxCenterX(largest, frameW);
    }
    return boxCenterX(best, frameW);
  }

  const largest = detections.reduce((a, b) =>
    boxArea(a) >= boxArea(b) ? a : b,
  );
  return boxCenterX(largest, frameW);
}

function sparsify(track: CropFocusKeyframe[]): CropFocusKeyframe[] {
  if (track.length <= 2) return track;
  const out: CropFocusKeyframe[] = [track[0]!];
  for (let i = 1; i < track.length - 1; i += 1) {
    const prev = out[out.length - 1]!;
    const cur = track[i]!;
    const next = track[i + 1]!;
    const gap = cur.tMs - prev.tMs;
    const delta = Math.abs(cur.x - prev.x);
    const turning =
      (cur.x - prev.x) * (next.x - cur.x) < 0 &&
      Math.abs(cur.x - prev.x) > 0.01;
    if (delta >= SPARSIFY_MIN_DELTA || gap >= SPARSIFY_MAX_GAP_MS || turning) {
      out.push(cur);
    }
  }
  out.push(track[track.length - 1]!);
  return out;
}

function waitSeek(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Falha ao seek no vídeo para rastreio"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    const maxT = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - 0.05)
      : timeSec;
    const target = Math.min(Math.max(0, timeSec), maxT);
    if (Math.abs(video.currentTime - target) < 0.02) {
      cleanup();
      resolve();
      return;
    }
    video.currentTime = target;
  });
}

async function loadVideo(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () =>
      reject(new Error("Não foi possível carregar o vídeo para rastreio"));
  });
  return video;
}

/**
 * Sample faces along the timeline and build a cropFocusTrack (timeline ms → focus X).
 */
export async function analyzeTimelineCropFocusTrack(
  timeline: Timeline,
  resolveMediaUrl: (assetId: string) => Promise<string>,
  onProgress?: (step: string, percent: number) => void,
): Promise<CropFocusKeyframe[]> {
  onProgress?.("Carregando detector de rostos…", 2);
  const detector = await getDetector();

  const durMs = Math.max(1, Math.round(timeline.durationMs || 0));
  if (durMs < 100) {
    throw new Error("Timeline vazia — importe um vídeo antes de auto-enquadrar");
  }

  const videoCache = new Map<string, HTMLVideoElement>();
  async function videoFor(assetId: string): Promise<HTMLVideoElement> {
    const cached = videoCache.get(assetId);
    if (cached) return cached;
    const url = await resolveMediaUrl(assetId);
    const el = await loadVideo(url);
    videoCache.set(assetId, el);
    return el;
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D indisponível");

  const raw: CropFocusKeyframe[] = [];
  let prevFaceX: number | null = null;
  let smoothFocus = 0.5;
  let hadFace = false;

  const steps = Math.max(1, Math.ceil(durMs / SAMPLE_MS));
  for (let i = 0; i < steps; i += 1) {
    const tMs = Math.min(durMs, i * SAMPLE_MS);
    const clip = findActiveVideoClip(timeline, tMs);
    if (!clip) {
      raw.push({ tMs, x: clamp01(smoothFocus) });
    } else {
      const video = await videoFor(clip.assetId);
      const speed = clipSpeed(clip);
      const localSec =
        clip.inMs / 1000 + ((tMs - clip.timelineStartMs) / 1000) * speed;
      await waitSeek(video, localSec);

      const frameW = video.videoWidth || 1;
      const frameH = video.videoHeight || 1;
      const maxW = 640;
      const scale = frameW > maxW ? maxW / frameW : 1;
      const cw = Math.max(1, Math.round(frameW * scale));
      const ch = Math.max(1, Math.round(frameH * scale));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.drawImage(video, 0, 0, cw, ch);
      const result = detector.detect(canvas);
      const faceX = pickPrimaryFace(result.detections, cw, prevFaceX);
      const srcAspect = frameW / frameH;

      if (faceX != null) {
        prevFaceX = faceX;
        const mapped = faceXToCropFocus(faceX, srcAspect);
        smoothFocus = hadFace
          ? smoothFocus * (1 - EMA_ALPHA) + mapped * EMA_ALPHA
          : mapped;
        hadFace = true;
      }
      raw.push({ tMs, x: clamp01(smoothFocus) });
    }

    if (i % 2 === 0 || i === steps - 1) {
      onProgress?.(
        `Rastreando rostos… ${i + 1}/${steps}`,
        Math.round(5 + ((i + 1) / steps) * 90),
      );
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  for (const el of videoCache.values()) {
    el.removeAttribute("src");
    el.load();
  }

  const track = sparsify(raw);
  onProgress?.("Rastreio concluído", 100);
  if (!hadFace) {
    throw new Error(
      "Nenhum rosto detectado. Tente outro trecho ou ajuste o foco manualmente.",
    );
  }
  return track;
}
