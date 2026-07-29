export type TransitionType = "cut" | "crossfade" | "fade";

export interface VideoClip {
  id: string;
  assetId: string;
  timelineStartMs: number;
  inMs: number;
  outMs: number;
  transitionIn?: TransitionType;
  transitionMs?: number;
  /** Playback rate; 1 = normal. Timeline duration = source / speed. */
  speed?: number;
  /** 0–1 linear gain; default 1 */
  volume?: number;
  muted?: boolean;
}

export interface AudioClip {
  id: string;
  assetId: string;
  timelineStartMs: number;
  inMs: number;
  outMs: number;
  speed?: number;
  volume?: number;
  muted?: boolean;
}

export interface CaptionCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface VideoTrack {
  id: string;
  type: "video";
  clips: VideoClip[];
}

export interface AudioTrack {
  id: string;
  type: "audio";
  clips: AudioClip[];
}

export interface CaptionsTrack {
  id: string;
  type: "captions";
  cues: CaptionCue[];
}

export type Track = VideoTrack | AudioTrack | CaptionsTrack;

export interface AssetMeta {
  id: string;
  filename: string;
  durationMs: number;
  width?: number;
  height?: number;
  kind: "video" | "audio" | "image";
}

export interface ImageStudioState {
  assetId: string;
  aspect: "16:9" | "9:16";
  crop: { x: number; y: number; w: number; h: number };
  brightness: number;
  contrast: number;
  resolution: "720p" | "1080p" | "1440p" | "2160p";
}

export interface Timeline {
  fps: number;
  durationMs: number;
  assets: Record<string, AssetMeta>;
  tracks: Track[];
  imageStudio?: ImageStudioState;
}

export type ProjectKind = "video" | "image";
export type Resolution = "720p" | "1080p" | "1440p" | "2160p";
export type ExportQuality = "low" | "medium" | "high" | "max";
export type ExportFormat = "mp4" | "mov";

export interface YoutubeMeta {
  titles: string[];
  selectedTitle?: string;
  description: string;
  hashtags: string[];
  tags: string[];
}

export interface ClipYoutubeMeta {
  clipId: string;
  filename: string;
  title: string;
  description: string;
  hashtags: string[];
  transcriptPreview?: string;
}

export interface CropFocusKeyframe {
  /** Timeline time in ms */
  tMs: number;
  /** 0 = left, 0.5 = center, 1 = right (same as cropFocusX) */
  x: number;
}

export type CaptionStyleId = "clean" | "bold" | "pop" | "boxed";

export interface CaptionAnchorKeyframe {
  tMs: number;
  place: "top" | "bottom";
}

export interface ProjectMetadata {
  youtube?: YoutubeMeta;
  clipMeta?: ClipYoutubeMeta[];
  /** Auto face-tracking crop curve for vertical 9:16 */
  cropFocusTrack?: CropFocusKeyframe[];
  framingMode?: "manual" | "auto";
  captionStyle?: CaptionStyleId;
  captionAvoidFaces?: boolean;
  /** Where to park captions over time (top/bottom) to miss faces */
  captionAnchorTrack?: CaptionAnchorKeyframe[];
}

export interface Project {
  id: string;
  user_id: string;
  title: string;
  kind: ProjectKind;
  duration_ms: number;
  timeline: Timeline;
  metadata: ProjectMetadata;
  created_at: string;
  updated_at: string;
}

export interface HealthReport {
  ok: boolean;
  binaries: Array<{
    name: string;
    available: boolean;
    installHint: string;
  }>;
  supabase?: boolean;
  openai?: boolean;
  mode?: string;
}

export interface ExportJob {
  status: string;
  progress: { step: string; percent: number };
  outputs: Array<{ name: string; label: string; url: string }>;
  /** Download all outputs as a single zip. */
  zipUrl?: string;
  error?: string;
}

export interface ExportOptions {
  exportHorizontal?: boolean;
  exportVertical?: boolean;
  verticalMode?: "crop" | "blur";
  /** 0 = left, 0.5 = center, 1 = right */
  cropFocusX?: number;
  /** Time-varying crop focus for vertical crop mode */
  cropFocusTrack?: CropFocusKeyframe[];
  resolution?: Resolution;
  burnCaptions?: boolean;
  captionStyle?: CaptionStyleId;
  captionAvoidFaces?: boolean;
  captionAnchorTrack?: CaptionAnchorKeyframe[];
  fps?: number;
  format?: ExportFormat;
  quality?: ExportQuality;
  audioBitrate?: "128k" | "192k" | "320k";
}

/** Source media span (ignores speed). */
export function clipSourceDurationMs(clip: {
  inMs: number;
  outMs: number;
}): number {
  return Math.max(0, clip.outMs - clip.inMs);
}

/** Timeline duration accounting for speed. */
export function clipDurationMs(clip: {
  inMs: number;
  outMs: number;
  speed?: number;
}): number {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  return Math.round(clipSourceDurationMs(clip) / speed);
}

export function clipSpeed(clip: { speed?: number }): number {
  return clip.speed && clip.speed > 0 ? clip.speed : 1;
}

export function findActiveVideoClip(
  timeline: Timeline,
  timeMs: number,
): VideoClip | null {
  const track = timeline.tracks.find((t) => t.type === "video");
  if (!track || track.type !== "video") return null;
  for (const clip of track.clips) {
    const end = clip.timelineStartMs + clipDurationMs(clip);
    if (timeMs >= clip.timelineStartMs && timeMs < end) return clip;
  }
  return null;
}

export function recomputeDuration(timeline: Timeline): number {
  let max = 0;
  for (const track of timeline.tracks) {
    if (track.type === "captions") {
      for (const cue of track.cues) max = Math.max(max, cue.endMs);
      continue;
    }
    for (const clip of track.clips) {
      max = Math.max(max, clip.timelineStartMs + clipDurationMs(clip));
    }
  }
  return Math.round(max);
}

export function formatTimecode(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
