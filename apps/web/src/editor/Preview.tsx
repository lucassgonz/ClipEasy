import {
  clipDurationMs,
  clipSpeed,
  findActiveVideoClip,
  formatTimecode,
  type CaptionCue,
  type CropFocusKeyframe,
  type Timeline,
  type VideoClip,
} from "../types";
import { mediaUrl } from "../api";
import { getSession } from "../lib/supabase";
import { useEffect, useMemo, useRef, useState } from "react";
import { getCachedMediaUrl, setCachedMediaUrl } from "./mediaCache";
import { interpolateCropFocus } from "./faceTrack";

export function Preview({
  projectId,
  timeline,
  timeMs,
  playing,
  onTime,
  onTogglePlay,
  onPlayingChange,
  verticalPreview,
  verticalMode,
  cropFocusX,
  framingMode = "manual",
  cropFocusTrack,
  onFramingChange,
  onAutoFrame,
  autoFrameBusy = false,
}: {
  projectId: string;
  timeline: Timeline;
  timeMs: number;
  playing: boolean;
  onTime: (ms: number) => void;
  onTogglePlay: () => void;
  onPlayingChange?: (playing: boolean) => void;
  verticalPreview?: boolean;
  verticalMode?: "crop" | "blur";
  cropFocusX?: number;
  framingMode?: "manual" | "auto";
  cropFocusTrack?: CropFocusKeyframe[];
  onFramingChange?: (opts: {
    mode: "crop" | "blur";
    cropFocusX: number;
    framingMode?: "manual" | "auto";
  }) => void;
  onAutoFrame?: () => void;
  autoFrameBusy?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const blurRef = useRef<HTMLVideoElement>(null);
  const clip = findActiveVideoClip(timeline, timeMs);
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
  const onTogglePlayRef = useRef(onTogglePlay);
  onTogglePlayRef.current = onTogglePlay;
  const cue = useMemo(() => {
    const track = timeline.tracks.find((t) => t.type === "captions");
    if (!track || track.type !== "captions") return null;
    return (
      track.cues.find((c) => timeMs >= c.startMs && timeMs < c.endMs) ?? null
    );
  }, [timeline, timeMs]);

  const sortedClips = useMemo(() => {
    const track = timeline.tracks.find((t) => t.type === "video");
    if (!track || track.type !== "video") return [] as VideoClip[];
    return [...track.clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  }, [timeline]);
  const sortedClipsRef = useRef(sortedClips);
  sortedClipsRef.current = sortedClips;

  const [blobUrl, setBlobUrl] = useState<string | null>(() =>
    clip ? (getCachedMediaUrl(projectId, clip.assetId) ?? null) : null,
  );
  const lastAsset = useRef<string>(clip?.assetId ?? "");
  const lastSyncedClipId = useRef<string | null>(clip?.id ?? null);

  const manualFocus = Math.min(1, Math.max(0, cropFocusX ?? 0.5));
  const focus =
    framingMode === "auto" && cropFocusTrack && cropFocusTrack.length > 0
      ? interpolateCropFocus(cropFocusTrack, timeMs, manualFocus)
      : manualFocus;
  const mode = verticalMode ?? "crop";
  const isVertical = Boolean(verticalPreview);

  useEffect(() => {
    if (!clip) {
      lastAsset.current = "";
      setBlobUrl(null);
      return;
    }
    const cached = getCachedMediaUrl(projectId, clip.assetId);
    if (cached) {
      lastAsset.current = clip.assetId;
      setBlobUrl(cached);
      return;
    }
    if (lastAsset.current === clip.assetId && blobUrl) return;
    let cancelled = false;
    void (async () => {
      const session = await getSession();
      const res = await fetch(mediaUrl(projectId, clip.assetId), {
        headers: session?.access_token
          ? { Authorization: `Bearer ${session.access_token}` }
          : {},
      });
      if (!res.ok || cancelled) return;
      const blob = await res.blob();
      if (cancelled) return;
      const url = URL.createObjectURL(blob);
      setCachedMediaUrl(projectId, clip.assetId, url);
      lastAsset.current = clip.assetId;
      setBlobUrl(url);
    })();
    return () => {
      cancelled = true;
    };
  }, [clip?.assetId, projectId]);

  function syncMedia(el: HTMLVideoElement | null) {
    if (!el || !clip) return;
    const speed = clipSpeed(clip);
    const local =
      clip.inMs / 1000 + ((timeMs - clip.timelineStartMs) / 1000) * speed;
    if (Math.abs(el.currentTime - local) > 0.3) {
      el.currentTime = Math.max(0, local);
    }
    el.playbackRate = speed;
  }

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !clip) {
      lastSyncedClipId.current = null;
      return;
    }
    const clipChanged = lastSyncedClipId.current !== clip.id;
    // While playing, only hard-seek when the active clip changes (or when paused/scrubbing).
    if (!playing || clipChanged) {
      syncMedia(el);
      lastSyncedClipId.current = clip.id;
    } else {
      el.playbackRate = clipSpeed(clip);
    }
    el.volume = clip.muted ? 0 : Math.min(1, Math.max(0, clip.volume ?? 1));
    el.muted = Boolean(clip.muted);
    if (blurRef.current) {
      if (!playing || clipChanged) syncMedia(blurRef.current);
      blurRef.current.muted = true;
      blurRef.current.volume = 0;
    }
  }, [timeMs, clip?.id, clip?.speed, clip?.volume, clip?.muted, isVertical, mode, playing]);

  useEffect(() => {
    const els = [videoRef.current, blurRef.current].filter(
      Boolean,
    ) as HTMLVideoElement[];
    for (const el of els) {
      if (playing) void el.play().catch(() => undefined);
      else el.pause();
    }
  }, [playing, blobUrl, clip?.id, isVertical, mode]);

  // Keep timeline playhead in sync with the video clock every frame while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let stopped = false;

    function advanceOrStop(endedClip: VideoClip) {
      const end = endedClip.timelineStartMs + clipDurationMs(endedClip);
      const next = sortedClipsRef.current.find(
        (c) => c.timelineStartMs >= end - 1,
      );
      if (next) {
        onTimeRef.current(next.timelineStartMs);
        return;
      }
      stopped = true;
      if (onPlayingChangeRef.current) onPlayingChangeRef.current(false);
      else onTogglePlayRef.current();
    }

    const tick = () => {
      if (stopped) return;
      const el = videoRef.current;
      const active = clipRef.current;
      if (el && active && !el.paused) {
        const speed = clipSpeed(active);
        const localMs = el.currentTime * 1000;
        const timelinePos =
          active.timelineStartMs + (localMs - active.inMs) / speed;
        const clipEnd = active.timelineStartMs + clipDurationMs(active);
        if (timelinePos >= clipEnd - 30) {
          advanceOrStop(active);
        } else {
          onTimeRef.current(Math.max(active.timelineStartMs, timelinePos));
        }
        const blur = blurRef.current;
        if (blur && Math.abs(blur.currentTime - el.currentTime) > 0.12) {
          blur.currentTime = el.currentTime;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [playing]);

  function onVideoTimeUpdate(e: React.SyntheticEvent<HTMLVideoElement>) {
    // When paused, still reflect scrubbing / seeks on the timeline.
    if (!clip || playing) return;
    const speed = clipSpeed(clip);
    const localMs = e.currentTarget.currentTime * 1000;
    const timelinePos = clip.timelineStartMs + (localMs - clip.inMs) / speed;
    onTime(Math.max(clip.timelineStartMs, timelinePos));
  }

  const objectPosition = `${(focus * 100).toFixed(1)}% 50%`;
  const cropPreset =
    framingMode === "auto"
      ? "auto"
      : focus <= 0.05
        ? "left"
        : focus >= 0.95
          ? "right"
          : Math.abs(focus - 0.5) < 0.05
            ? "center"
            : "custom";

  return (
    <div className="preview">
      <div
        className={`preview-stage ${isVertical ? "preview-stage-9x16" : ""} ${
          isVertical && mode === "blur" ? "preview-stage-blur" : ""
        }`}
      >
        {blobUrl ? (
          <>
            {isVertical && mode === "blur" && (
              <video
                ref={blurRef}
                className="preview-blur-bg"
                src={blobUrl}
                playsInline
                muted
                aria-hidden
              />
            )}
            <video
              ref={videoRef}
              className={
                isVertical
                  ? mode === "blur"
                    ? "preview-fg-contain"
                    : "preview-fg-cover"
                  : undefined
              }
              style={
                isVertical && mode === "crop" ? { objectPosition } : undefined
              }
              src={blobUrl}
              playsInline
              onTimeUpdate={onVideoTimeUpdate}
              onEnded={() => {
                const active = clipRef.current;
                if (!active) return;
                const end = active.timelineStartMs + clipDurationMs(active);
                const next = sortedClipsRef.current.find(
                  (c) => c.timelineStartMs >= end - 1,
                );
                if (next) onTime(next.timelineStartMs);
                else if (onPlayingChange) onPlayingChange(false);
                else onTogglePlay();
              }}
            />
          </>
        ) : (
          <div className="preview-empty">
            {sortedClips.length
              ? "Gap na timeline — avance o playhead"
              : "Importe um vídeo para começar"}
          </div>
        )}
        {cue && <div className="caption-overlay">{cue.text}</div>}
      </div>

      <div className="preview-controls">
        <button type="button" className="cta small" onClick={onTogglePlay}>
          {playing ? "Pausar" : "Play"}
        </button>
        <span className="timecode">{formatTimecode(timeMs)}</span>
        {clip && (
          <span className="hint">
            {clipSpeed(clip)}x
            {clip.muted ? " · mudo" : ""}
            {isVertical ? " · 9:16" : ""}
            {isVertical && framingMode === "auto" ? " · auto" : ""}
          </span>
        )}
      </div>

      {isVertical && onFramingChange && (
        <div className="framing-bar">
          <label className="field compact framing-field">
            <span>Modo</span>
            <select
              value={mode}
              onChange={(e) =>
                onFramingChange({
                  mode: e.target.value as "crop" | "blur",
                  cropFocusX: focus,
                  framingMode,
                })
              }
            >
              <option value="crop">Recorte</option>
              <option value="blur">Fundo desfocado</option>
            </select>
          </label>

          {mode === "crop" && (
            <>
              <div className="segmented framing-presets">
                {(
                  [
                    ["left", "Esq.", 0],
                    ["center", "Centro", 0.5],
                    ["right", "Dir.", 1],
                  ] as const
                ).map(([key, label, value]) => (
                  <button
                    key={key}
                    type="button"
                    className={cropPreset === key ? "active" : ""}
                    onClick={() =>
                      onFramingChange({
                        mode: "crop",
                        cropFocusX: value,
                        framingMode: "manual",
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="field compact framing-field framing-slider">
                <span>
                  Foco ({Math.round(focus * 100)}%)
                  {framingMode === "auto" ? " · auto" : ""}
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(focus * 100)}
                  onChange={(e) =>
                    onFramingChange({
                      mode: "crop",
                      cropFocusX: Number(e.target.value) / 100,
                      framingMode: "manual",
                    })
                  }
                />
              </label>
              {onAutoFrame && (
                <button
                  type="button"
                  className={`ghost framing-auto-btn${
                    framingMode === "auto" ? " active" : ""
                  }`}
                  disabled={autoFrameBusy}
                  onClick={onAutoFrame}
                  title="Rastrear rostos e ajustar o enquadramento vertical"
                >
                  {autoFrameBusy ? "Rastreando…" : "Auto-enquadrar"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export type { CaptionCue };
