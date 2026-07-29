import {
  clipDurationMs,
  recomputeDuration,
  type Timeline,
  type TransitionType,
  type VideoClip,
} from "../types";

function roundMs(n: number): number {
  return Math.max(0, Math.round(n));
}

function getVideoClips(timeline: Timeline): VideoClip[] {
  const t = timeline.tracks.find((x) => x.type === "video");
  return t && t.type === "video" ? t.clips : [];
}

export function mirrorAudio(timeline: Timeline, clips: VideoClip[]): Timeline {
  const normalized = clips.map((c) => ({
    ...c,
    timelineStartMs: roundMs(c.timelineStartMs),
    inMs: roundMs(c.inMs),
    outMs: roundMs(c.outMs),
  }));
  const next: Timeline = {
    ...timeline,
    tracks: timeline.tracks.map((t) =>
      t.type === "video" ? { ...t, clips: normalized } : t,
    ),
  };
  next.tracks = next.tracks.map((t) =>
    t.type === "audio"
      ? {
          ...t,
          clips: normalized.map((c) => ({
            id: `${c.id}-a`,
            assetId: c.assetId,
            timelineStartMs: c.timelineStartMs,
            inMs: c.inMs,
            outMs: c.outMs,
            speed: c.speed,
            volume: c.volume,
            muted: c.muted,
          })),
        }
      : t,
  );
  next.durationMs = recomputeDuration(next);
  return next;
}

function speedOf(c: VideoClip): number {
  return c.speed && c.speed > 0 ? c.speed : 1;
}

function localAt(c: VideoClip, timeMs: number): number {
  return roundMs(c.inMs + (timeMs - c.timelineStartMs) * speedOf(c));
}

/** Shallow copy of clips array (clip objects reused unless replaced). */
function copyClips(timeline: Timeline): VideoClip[] {
  return getVideoClips(timeline).slice();
}

export function splitAtPlayhead(
  timeline: Timeline,
  timeMs: number,
): Timeline | null {
  const clips = copyClips(timeline);
  const idx = clips.findIndex((c) => {
    const end = c.timelineStartMs + clipDurationMs(c);
    return timeMs > c.timelineStartMs + 50 && timeMs < end - 50;
  });
  if (idx < 0) return null;
  const c = clips[idx]!;
  const local = localAt(c, timeMs);
  const left: VideoClip = { ...c, outMs: local };
  const right: VideoClip = {
    ...c,
    id: `${c.id}-r-${Date.now()}`,
    timelineStartMs: roundMs(timeMs),
    inMs: local,
    transitionIn: "cut",
  };
  clips.splice(idx, 1, left, right);
  return mirrorAudio(timeline, clips);
}

export function deleteClip(timeline: Timeline, clipId: string): Timeline | null {
  const clips = getVideoClips(timeline);
  const next = clips.filter((c) => c.id !== clipId);
  if (next.length === clips.length) return null;
  return mirrorAudio(timeline, next);
}

export function deleteLeftOfPlayhead(
  timeline: Timeline,
  clipId: string,
  timeMs: number,
): Timeline | null {
  const clips = copyClips(timeline);
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return null;
  const c = clips[idx]!;
  const end = c.timelineStartMs + clipDurationMs(c);
  if (timeMs <= c.timelineStartMs + 50 || timeMs >= end - 50) return null;
  const local = localAt(c, timeMs);
  clips[idx] = {
    ...c,
    inMs: local,
    timelineStartMs: roundMs(timeMs),
  };
  return mirrorAudio(timeline, clips);
}

export function deleteRightOfPlayhead(
  timeline: Timeline,
  clipId: string,
  timeMs: number,
): Timeline | null {
  const clips = copyClips(timeline);
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return null;
  const c = clips[idx]!;
  const end = c.timelineStartMs + clipDurationMs(c);
  if (timeMs <= c.timelineStartMs + 50 || timeMs >= end - 50) return null;
  const local = localAt(c, timeMs);
  clips[idx] = { ...c, outMs: local };
  return mirrorAudio(timeline, clips);
}

export function deleteAllBefore(
  timeline: Timeline,
  timeMs: number,
): Timeline | null {
  const clips = getVideoClips(timeline);
  const kept = clips.filter(
    (c) => c.timelineStartMs + clipDurationMs(c) > timeMs + 1,
  );
  if (kept.length === clips.length) {
    const overlaps = clips.some(
      (c) =>
        c.timelineStartMs < timeMs &&
        c.timelineStartMs + clipDurationMs(c) > timeMs,
    );
    if (!overlaps) return null;
  }
  const trimmed = kept.map((c) => {
    if (
      c.timelineStartMs < timeMs &&
      c.timelineStartMs + clipDurationMs(c) > timeMs
    ) {
      const local = localAt(c, timeMs);
      return { ...c, inMs: local, timelineStartMs: roundMs(timeMs) };
    }
    return c;
  });
  return mirrorAudio(timeline, trimmed);
}

export function deleteAllAfter(
  timeline: Timeline,
  timeMs: number,
): Timeline | null {
  const clips = getVideoClips(timeline);
  const overlaps = clips.some(
    (c) =>
      c.timelineStartMs < timeMs &&
      c.timelineStartMs + clipDurationMs(c) > timeMs,
  );
  const kept = clips.filter((c) => c.timelineStartMs < timeMs);
  if (kept.length === clips.length && !overlaps) return null;
  const trimmed = kept.map((c) => {
    if (c.timelineStartMs + clipDurationMs(c) > timeMs) {
      return { ...c, outMs: localAt(c, timeMs) };
    }
    return c;
  });
  return mirrorAudio(timeline, trimmed);
}

export function duplicateClip(
  timeline: Timeline,
  clipId: string,
): { timeline: Timeline; newId: string } | null {
  const clips = copyClips(timeline);
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return null;
  const c = clips[idx]!;
  const newId = `${c.id}-dup-${Date.now()}`;
  const copy: VideoClip = {
    ...c,
    id: newId,
    timelineStartMs: roundMs(c.timelineStartMs + clipDurationMs(c)),
    transitionIn: "cut",
  };
  clips.splice(idx + 1, 0, copy);
  return { timeline: mirrorAudio(timeline, clips), newId };
}

export function snapClipsToStart(timeline: Timeline): Timeline | null {
  const clips = getVideoClips(timeline);
  if (clips.length === 0) return null;
  const minStart = Math.min(...clips.map((c) => c.timelineStartMs));
  if (minStart === 0) return null;
  return mirrorAudio(
    timeline,
    clips.map((c) => ({
      ...c,
      timelineStartMs: Math.max(0, c.timelineStartMs - minStart),
    })),
  );
}

export function closeGaps(timeline: Timeline): Timeline | null {
  const clips = getVideoClips(timeline)
    .slice()
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  if (clips.length === 0) return null;
  let t = 0;
  let changed = false;
  const next = clips.map((c) => {
    if (c.timelineStartMs !== t) {
      changed = true;
      const moved = { ...c, timelineStartMs: t };
      t += clipDurationMs(moved);
      return moved;
    }
    t += clipDurationMs(c);
    return c;
  });
  if (!changed) return null;
  return mirrorAudio(timeline, next);
}

export function nudgeClip(
  timeline: Timeline,
  clipId: string,
  deltaMs: number,
): Timeline | null {
  const clips = getVideoClips(timeline);
  const c = clips.find((x) => x.id === clipId);
  if (!c) return null;
  return updateClip(timeline, clipId, {
    timelineStartMs: Math.max(0, roundMs(c.timelineStartMs + deltaMs)),
  });
}

export function updateClip(
  timeline: Timeline,
  clipId: string,
  patch: Partial<VideoClip>,
): Timeline | null {
  const clips = getVideoClips(timeline);
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return null;
  const next = clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c));
  return mirrorAudio(timeline, next);
}

export function setTransition(
  timeline: Timeline,
  clipId: string,
  transitionIn: TransitionType,
): Timeline | null {
  return updateClip(timeline, clipId, { transitionIn });
}

export function toggleMute(
  timeline: Timeline,
  clipId: string,
): Timeline | null {
  const clips = getVideoClips(timeline);
  const c = clips.find((x) => x.id === clipId);
  if (!c) return null;
  return updateClip(timeline, clipId, { muted: !c.muted });
}

export function findClipAtTime(
  timeline: Timeline,
  timeMs: number,
): VideoClip | null {
  for (const c of getVideoClips(timeline)) {
    const end = c.timelineStartMs + clipDurationMs(c);
    if (timeMs >= c.timelineStartMs && timeMs < end) return c;
  }
  return null;
}
