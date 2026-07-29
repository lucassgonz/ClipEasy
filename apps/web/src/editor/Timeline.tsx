import { useEffect, useMemo, useRef, useState } from "react";
import {
  clipDurationMs,
  recomputeDuration,
  type CaptionCue,
  type Timeline,
  type TransitionType,
  type VideoClip,
} from "../types";

/** Default density for short clips (~80px per second). */
const PX_PER_MS_DEFAULT = 0.08;
const MIN_PX_PER_MS = 0.00015; // fits ~2h in ~1000px

function roundMs(n: number): number {
  return Math.max(0, Math.round(n));
}

export function TimelineView({
  timeline,
  timeMs,
  playing = false,
  selectedId,
  onSelect,
  onChange,
  onSeek,
  onSplit,
}: {
  timeline: Timeline;
  timeMs: number;
  playing?: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (timeline: Timeline) => void;
  onSeek: (ms: number) => void;
  onSplit?: () => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const [railWidth, setRailWidth] = useState(800);
  const [pxPerMs, setPxPerMs] = useState(PX_PER_MS_DEFAULT);
  const fittedForDuration = useRef<number | null>(null);
  /** Local draft while dragging — avoids flooding parent history/save. */
  const draftClips = useRef<VideoClip[] | null>(null);
  const draftCues = useRef<CaptionCue[] | null>(null);
  const [, bumpDraft] = useState(0);
  const seekRaf = useRef(0);

  const durationMs = Math.max(timeline.durationMs || 10000, 1000);
  const fitPxPerMs = Math.max(
    MIN_PX_PER_MS,
    (Math.max(railWidth, 200) - 32) / durationMs,
  );
  const maxPxPerMs = Math.max(PX_PER_MS_DEFAULT * 4, fitPxPerMs * 20);
  const width = Math.max(railWidth - 8, durationMs * pxPerMs + 40);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const apply = () => setRailWidth(el.clientWidth || 800);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the yellow playhead visible while the video plays.
  useEffect(() => {
    if (!playing || scrubbing.current) return;
    const el = railRef.current;
    if (!el) return;
    const x = timeMs * pxPerMs;
    const pad = Math.min(120, el.clientWidth * 0.25);
    const left = el.scrollLeft;
    const right = left + el.clientWidth;
    if (x < left + pad) {
      el.scrollLeft = Math.max(0, x - pad);
    } else if (x > right - pad) {
      el.scrollLeft = Math.max(0, x - el.clientWidth + pad);
    }
  }, [timeMs, playing, pxPerMs]);

  useEffect(() => {
    const fit = Math.max(
      MIN_PX_PER_MS,
      (Math.max(railWidth, 200) - 32) / durationMs,
    );
    const needsFit =
      fittedForDuration.current !== durationMs ||
      durationMs * pxPerMs > railWidth * 1.05;
    if (needsFit && durationMs > 120_000) {
      setPxPerMs(fit);
      fittedForDuration.current = durationMs;
    } else if (fittedForDuration.current === null) {
      fittedForDuration.current = durationMs;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, railWidth]);

  const zoomSlider = useMemo(() => {
    const min = fitPxPerMs;
    const max = maxPxPerMs;
    if (max <= min) return 0;
    const t = (pxPerMs - min) / (max - min);
    return Math.round(Math.min(100, Math.max(0, t * 100)));
  }, [pxPerMs, fitPxPerMs, maxPxPerMs]);

  function setZoomFromSlider(value: number) {
    const t = value / 100;
    const min = fitPxPerMs;
    const max = maxPxPerMs;
    const eased = t * t;
    setPxPerMs(min + (max - min) * eased);
  }

  const dragBase = useRef<{
    id: string;
    kind: "move" | "in" | "out" | "cue";
    timelineStartMs: number;
    inMs: number;
    outMs: number;
    startMs?: number;
    endMs?: number;
  } | null>(null);

  const video = timeline.tracks.find((t) => t.type === "video");
  const audio = timeline.tracks.find((t) => t.type === "audio");
  const captions = timeline.tracks.find((t) => t.type === "captions");

  function msFromClientX(clientX: number): number {
    const el = railRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    return roundMs(Math.max(0, x / pxPerMs));
  }

  function commitVideoClips(clips: VideoClip[]) {
    const normalized = clips.map((c) => ({
      ...c,
      timelineStartMs: roundMs(c.timelineStartMs),
      inMs: roundMs(c.inMs),
      outMs: roundMs(c.outMs),
    }));
    const base = timelineRef.current;
    const next: Timeline = {
      ...base,
      tracks: base.tracks.map((t) =>
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
    onChange(next);
  }

  function commitCues(cues: CaptionCue[]) {
    const base = timelineRef.current;
    const next: Timeline = {
      ...base,
      tracks: base.tracks.map((t) =>
        t.type === "captions"
          ? {
              ...t,
              cues: cues.map((c) => ({
                ...c,
                startMs: roundMs(c.startMs),
                endMs: roundMs(c.endMs),
              })),
            }
          : t,
      ),
    };
    next.durationMs = recomputeDuration(next);
    onChange(next);
  }

  function currentVideoClips(): VideoClip[] {
    if (draftClips.current) return draftClips.current;
    const t = timelineRef.current.tracks.find((x) => x.type === "video");
    return t && t.type === "video" ? t.clips : [];
  }

  function currentCues(): CaptionCue[] {
    if (draftCues.current) return draftCues.current;
    const t = timelineRef.current.tracks.find((x) => x.type === "captions");
    return t && t.type === "captions" ? t.cues : [];
  }

  function beginDraftVideo() {
    if (!draftClips.current) {
      const t = timelineRef.current.tracks.find((x) => x.type === "video");
      draftClips.current =
        t && t.type === "video" ? t.clips.map((c) => ({ ...c })) : [];
    }
  }

  function beginDraftCues() {
    if (!draftCues.current) {
      const t = timelineRef.current.tracks.find((x) => x.type === "captions");
      draftCues.current =
        t && t.type === "captions" ? t.cues.map((c) => ({ ...c })) : [];
    }
  }

  function commitDraft() {
    if (draftClips.current) {
      commitVideoClips(draftClips.current);
      draftClips.current = null;
    }
    if (draftCues.current) {
      commitCues(draftCues.current);
      draftCues.current = null;
    }
  }

  function splitAtPlayhead() {
    if (onSplit) {
      onSplit();
      return;
    }
    const clips = structuredClone(currentVideoClips());
    const idx = clips.findIndex((c) => {
      const end = c.timelineStartMs + clipDurationMs(c);
      return timeMs > c.timelineStartMs + 50 && timeMs < end - 50;
    });
    if (idx < 0) return;
    const c = clips[idx]!;
    const speed = c.speed && c.speed > 0 ? c.speed : 1;
    const local = roundMs(c.inMs + (timeMs - c.timelineStartMs) * speed);
    const left: VideoClip = { ...c, outMs: local };
    const right: VideoClip = {
      ...c,
      id: `${c.id}-r-${Date.now()}`,
      timelineStartMs: roundMs(timeMs),
      inMs: local,
      transitionIn: "cut",
    };
    clips.splice(idx, 1, left, right);
    commitVideoClips(clips);
  }

  function setTransition(id: string, transitionIn: TransitionType) {
    commitVideoClips(
      currentVideoClips().map((c) =>
        c.id === id ? { ...c, transitionIn } : c,
      ),
    );
  }

  function applyDragDelta(totalDxPx: number) {
    const base = dragBase.current;
    if (!base) return;
    const deltaMs = totalDxPx / pxPerMs;

    if (base.kind === "cue") {
      beginDraftCues();
      const cues = draftCues.current!;
      const dur = (base.endMs ?? 0) - (base.startMs ?? 0);
      const startMs = Math.max(0, roundMs((base.startMs ?? 0) + deltaMs));
      draftCues.current = cues.map((cue) =>
        cue.id === base.id
          ? { ...cue, startMs, endMs: startMs + Math.max(100, dur) }
          : cue,
      );
      bumpDraft((n) => n + 1);
      return;
    }

    beginDraftVideo();
    const clips = draftClips.current!;
    draftClips.current = clips.map((c) => {
      if (c.id !== base.id) return c;
      if (base.kind === "move") {
        return {
          ...c,
          timelineStartMs: Math.max(0, roundMs(base.timelineStartMs + deltaMs)),
        };
      }
      if (base.kind === "in") {
        const inMs = Math.min(
          base.outMs - 100,
          Math.max(0, roundMs(base.inMs + deltaMs)),
        );
        const shift = inMs - base.inMs;
        return {
          ...c,
          inMs,
          timelineStartMs: Math.max(0, roundMs(base.timelineStartMs + shift)),
        };
      }
      return {
        ...c,
        outMs: Math.max(base.inMs + 100, roundMs(base.outMs + deltaMs)),
      };
    });
    bumpDraft((n) => n + 1);
  }

  const selectedCue = useMemo(() => {
    if (!captions || captions.type !== "captions" || !selectedId) return null;
    return captions.cues.find((c) => c.id === selectedId) ?? null;
  }, [captions, selectedId]);

  const selectedVideo =
    video && video.type === "video"
      ? video.clips.find((c) => c.id === selectedId)
      : undefined;

  const durationLabel =
    durationMs >= 3_600_000
      ? `${(durationMs / 3_600_000).toFixed(1)}h`
      : durationMs >= 60_000
        ? `${Math.round(durationMs / 60_000)} min`
        : `${Math.round(durationMs / 1000)}s`;

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <button type="button" onClick={splitAtPlayhead}>
          Dividir no playhead
        </button>
        <button
          type="button"
          onClick={() => {
            setPxPerMs(fitPxPerMs);
            fittedForDuration.current = durationMs;
          }}
          title="Mostrar o vídeo inteiro na largura da timeline"
        >
          Ajustar zoom
        </button>
        <label className="timeline-zoom-label">
          Zoom
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={zoomSlider}
            onChange={(e) => setZoomFromSlider(Number(e.target.value))}
          />
          <span className="hint">{durationLabel}</span>
        </label>
        {selectedVideo && (
          <label>
            Transição
            <select
              value={selectedVideo.transitionIn ?? "cut"}
              onChange={(e) =>
                setTransition(
                  selectedVideo.id,
                  e.target.value as TransitionType,
                )
              }
            >
              <option value="cut">Corte</option>
              <option value="crossfade">Crossfade</option>
              <option value="fade">Fade</option>
            </select>
          </label>
        )}
      </div>

      <div className="timeline-body">
        <div className="track-labels-col">
          <div className="track-label">Vídeo</div>
          <div className="track-label">Áudio</div>
          <div className="track-label">Legendas</div>
        </div>

        <div
          className="timeline-rail"
          ref={railRef}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest(".clip")) return;
            scrubbing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            onSeek(msFromClientX(e.clientX));
          }}
          onPointerMove={(e) => {
            if (!scrubbing.current) return;
            const ms = msFromClientX(e.clientX);
            if (seekRaf.current) cancelAnimationFrame(seekRaf.current);
            seekRaf.current = requestAnimationFrame(() => onSeek(ms));
          }}
          onPointerUp={() => {
            scrubbing.current = false;
          }}
          onPointerCancel={() => {
            scrubbing.current = false;
          }}
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            setPxPerMs((p) =>
              Math.min(maxPxPerMs, Math.max(fitPxPerMs, p * factor)),
            );
          }}
        >
          <div className="timeline-inner" style={{ width }}>
            <div className="playhead" style={{ left: timeMs * pxPerMs }} />

            <div className="track-lane">
              {currentVideoClips().map((c) => (
                  <ClipBlock
                    key={c.id}
                    left={c.timelineStartMs * pxPerMs}
                    width={clipDurationMs(c) * pxPerMs}
                    selected={selectedId === c.id}
                    label={timeline.assets[c.assetId]?.filename ?? c.assetId}
                    color="video"
                    onSelect={() => onSelect(c.id)}
                    onGestureStart={(kind) => {
                      beginDraftVideo();
                      const src = draftClips.current!.find((x) => x.id === c.id) ?? c;
                      dragBase.current = {
                        id: c.id,
                        kind,
                        timelineStartMs: src.timelineStartMs,
                        inMs: src.inMs,
                        outMs: src.outMs,
                      };
                    }}
                    onGestureDelta={applyDragDelta}
                    onGestureEnd={() => {
                      dragBase.current = null;
                      commitDraft();
                    }}
                  />
                ))}
            </div>

            <div className="track-lane">
              {(draftClips.current ??
                (audio && audio.type === "audio" ? audio.clips : [])
              ).map((c) => (
                  <ClipBlock
                    key={c.id}
                    left={c.timelineStartMs * pxPerMs}
                    width={clipDurationMs(c) * pxPerMs}
                    selected={false}
                    label="áudio"
                    color="audio"
                    onSelect={() => undefined}
                  />
                ))}
            </div>

            <div className="track-lane">
              {currentCues().map((c) => (
                  <ClipBlock
                    key={c.id}
                    left={c.startMs * pxPerMs}
                    width={Math.max(8, (c.endMs - c.startMs) * pxPerMs)}
                    selected={selectedId === c.id}
                    label={c.text.slice(0, 24)}
                    color="caption"
                    onSelect={() => onSelect(c.id)}
                    onGestureStart={() => {
                      beginDraftCues();
                      const src = draftCues.current!.find((x) => x.id === c.id) ?? c;
                      dragBase.current = {
                        id: c.id,
                        kind: "cue",
                        timelineStartMs: 0,
                        inMs: 0,
                        outMs: 0,
                        startMs: src.startMs,
                        endMs: src.endMs,
                      };
                    }}
                    onGestureDelta={applyDragDelta}
                    onGestureEnd={() => {
                      dragBase.current = null;
                      commitDraft();
                    }}
                  />
                ))}
            </div>
          </div>
        </div>
      </div>

      {selectedCue && (
        <div className="cue-editor">
          <label>
            Texto da legenda
            <textarea
              value={selectedCue.text}
              onChange={(e) =>
                commitCues(
                  currentCues().map((c) =>
                    c.id === selectedCue.id
                      ? { ...c, text: e.target.value }
                      : c,
                  ),
                )
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

function ClipBlock({
  left,
  width,
  selected,
  label,
  color,
  onSelect,
  onGestureStart,
  onGestureDelta,
  onGestureEnd,
}: {
  left: number;
  width: number;
  selected: boolean;
  label: string;
  color: "video" | "audio" | "caption";
  onSelect: () => void;
  onGestureStart?: (kind: "move" | "in" | "out") => void;
  onGestureDelta?: (totalDxPx: number) => void;
  onGestureEnd?: () => void;
}) {
  const originX = useRef(0);
  const active = useRef(false);
  const moved = useRef(false);

  function begin(e: React.PointerEvent, kind: "move" | "in" | "out") {
    if (!onGestureStart || !onGestureDelta) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    active.current = true;
    moved.current = false;
    originX.current = e.clientX;
    onGestureStart(kind);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function move(e: React.PointerEvent) {
    if (!active.current || !onGestureDelta) return;
    const dx = e.clientX - originX.current;
    if (Math.abs(dx) > 2) moved.current = true;
    onGestureDelta(dx);
  }

  function end(e: React.PointerEvent) {
    if (!active.current) return;
    active.current = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (moved.current) onGestureEnd?.();
  }

  const canEdit = Boolean(onGestureStart);
  const canTrim = canEdit && color === "video";

  return (
    <div
      className={`clip ${color} ${selected ? "selected" : ""}`}
      style={{ left, width: Math.max(width, 4) }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (!canEdit) {
          e.stopPropagation();
          onSelect();
          return;
        }
        begin(e, "move");
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {canTrim && (
        <span
          className="handle left"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            begin(e, "in");
          }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      )}
      <span className="clip-label">{label}</span>
      {canTrim && (
        <span
          className="handle right"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            begin(e, "out");
          }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      )}
    </div>
  );
}
