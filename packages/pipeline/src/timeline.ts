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

export function emptyTimeline(): Timeline {
  return {
    fps: 30,
    durationMs: 0,
    assets: {},
    tracks: [
      { id: "video-1", type: "video", clips: [] },
      { id: "audio-1", type: "audio", clips: [] },
      { id: "captions-1", type: "captions", cues: [] },
    ],
  };
}

export function clipDurationMs(clip: { inMs: number; outMs: number }): number {
  return Math.max(0, clip.outMs - clip.inMs);
}

export function recomputeDuration(timeline: Timeline): number {
  let max = 0;
  for (const track of timeline.tracks) {
    if (track.type === "captions") {
      for (const cue of track.cues) {
        max = Math.max(max, cue.endMs);
      }
      continue;
    }
    for (const clip of track.clips) {
      max = Math.max(max, clip.timelineStartMs + clipDurationMs(clip));
    }
  }
  return max;
}

export function getVideoTrack(timeline: Timeline): VideoTrack {
  const track = timeline.tracks.find((t): t is VideoTrack => t.type === "video");
  if (!track) throw new Error("Timeline sem faixa de vídeo");
  return track;
}

export function getAudioTrack(timeline: Timeline): AudioTrack {
  const track = timeline.tracks.find((t): t is AudioTrack => t.type === "audio");
  if (!track) throw new Error("Timeline sem faixa de áudio");
  return track;
}

export function getCaptionsTrack(timeline: Timeline): CaptionsTrack {
  const track = timeline.tracks.find(
    (t): t is CaptionsTrack => t.type === "captions",
  );
  if (!track) throw new Error("Timeline sem faixa de legendas");
  return track;
}

export function findActiveVideoClip(
  timeline: Timeline,
  timeMs: number,
): VideoClip | null {
  const track = getVideoTrack(timeline);
  for (const clip of track.clips) {
    const end = clip.timelineStartMs + clipDurationMs(clip);
    if (timeMs >= clip.timelineStartMs && timeMs < end) return clip;
  }
  return null;
}
