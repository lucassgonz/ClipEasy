import {
  clipDurationMs,
  clipSpeed,
  findActiveVideoClip,
  formatTimecode,
  type CaptionCue,
  type Timeline,
  type VideoClip,
} from "../types";
import { mediaUrl } from "../api";
import { getSession } from "../lib/supabase";
import { useEffect, useMemo, useRef, useState } from "react";

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
  onFramingChange,
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
  onFramingChange?: (opts: {
    mode: "crop" | "blur";
    cropFocusX: number;
  }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const blurRef = useRef<HTMLVideoElement>(null);
  const clip = findActiveVideoClip(timeline, timeMs);
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

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const lastAsset = useRef<string>("");

  const focus = Math.min(1, Math.max(0, cropFocusX ?? 0.5));
  const mode = verticalMode ?? "crop";
  const isVertical = Boolean(verticalPreview);

  useEffect(() => {
    if (!clip) {
      lastAsset.current = "";
      setBlobUrl(null);
      return;
    }
    if (lastAsset.current === clip.assetId && blobUrl) return;
    let revoked: string | null = null;
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
      revoked = url;
      lastAsset.current = clip.assetId;
      setBlobUrl(url);
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
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
    if (!el || !clip) return;
    syncMedia(el);
    el.volume = clip.muted ? 0 : Math.min(1, Math.max(0, clip.volume ?? 1));
    el.muted = Boolean(clip.muted);
    if (blurRef.current) {
      syncMedia(blurRef.current);
      blurRef.current.muted = true;
      blurRef.current.volume = 0;
    }
  }, [timeMs, clip?.id, clip?.speed, clip?.volume, clip?.muted, isVertical, mode]);

  useEffect(() => {
    const els = [videoRef.current, blurRef.current].filter(Boolean) as HTMLVideoElement[];
    for (const el of els) {
      if (playing) void el.play().catch(() => undefined);
      else el.pause();
    }
  }, [playing, blobUrl, clip?.id, isVertical, mode]);

  function advanceOrStop(endedClip: VideoClip) {
    const end = endedClip.timelineStartMs + clipDurationMs(endedClip);
    const next = sortedClips.find((c) => c.timelineStartMs >= end - 1);
    if (next) {
      onTime(next.timelineStartMs);
      return;
    }
    if (onPlayingChange) onPlayingChange(false);
    else onTogglePlay();
  }

  function onVideoTimeUpdate(e: React.SyntheticEvent<HTMLVideoElement>) {
    if (!clip || !playing) return;
    const speed = clipSpeed(clip);
    const localMs = e.currentTarget.currentTime * 1000;
    const timelinePos = clip.timelineStartMs + (localMs - clip.inMs) / speed;
    const clipEnd = clip.timelineStartMs + clipDurationMs(clip);
    if (timelinePos >= clipEnd - 30) {
      advanceOrStop(clip);
      return;
    }
    onTime(Math.max(clip.timelineStartMs, timelinePos));
    const blur = blurRef.current;
    if (blur && Math.abs(blur.currentTime - e.currentTarget.currentTime) > 0.12) {
      blur.currentTime = e.currentTarget.currentTime;
    }
  }

  const objectPosition = `${(focus * 100).toFixed(1)}% 50%`;

  const cropPreset =
    focus <= 0.05 ? "left" : focus >= 0.95 ? "right" : Math.abs(focus - 0.5) < 0.05 ? "center" : "custom";

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
                isVertical && mode === "crop"
                  ? { objectPosition }
                  : undefined
              }
              src={blobUrl}
              playsInline
              onTimeUpdate={onVideoTimeUpdate}
              onEnded={() => {
                if (clip) advanceOrStop(clip);
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
                      onFramingChange({ mode: "crop", cropFocusX: value })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="field compact framing-field framing-slider">
                <span>Foco ({Math.round(focus * 100)}%)</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(focus * 100)}
                  onChange={(e) =>
                    onFramingChange({
                      mode: "crop",
                      cropFocusX: Number(e.target.value) / 100,
                    })
                  }
                />
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export type { CaptionCue };
