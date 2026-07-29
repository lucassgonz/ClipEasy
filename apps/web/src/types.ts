export type TransitionType = "cut" | "crossfade" | "fade";

export interface VideoClip {
  id: string;
  assetId: string;
  timelineStartMs: number;
  inMs: number;
  outMs: number;
  transitionIn?: TransitionType;
  transitionMs?: number;
}

export interface AudioClip {
  id: string;
  assetId: string;
  timelineStartMs: number;
  inMs: number;
  outMs: number;
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

export interface YoutubeMeta {
  titles: string[];
  selectedTitle?: string;
  description: string;
  hashtags: string[];
  tags: string[];
}

export interface ProjectMetadata {
  youtube?: YoutubeMeta;
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
  error?: string;
}

export function clipDurationMs(clip: { inMs: number; outMs: number }): number {
  return Math.max(0, clip.outMs - clip.inMs);
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
  return max;
}
