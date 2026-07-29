import { useMemo, useRef, useState } from "react";
import {
  clipDurationMs,
  recomputeDuration,
  type CaptionCue,
  type Timeline,
  type TransitionType,
  type VideoClip,
} from "../types";

const PX_PER_MS_BASE = 0.08;

function roundMs(n: number): number {
  return Math.max(0, Math.round(n));
}

export function TimelineView({
  timeline,
  timeMs,
  selectedId,
  onSelect,
  onChange,
  onSeek,
  onSplit,
}: {
  timeline: Timeline;
  timeMs: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (timeline: Timeline) => void;
  onSeek: (ms: number) => void;
  onSplit?: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const pxPerMs = PX_PER_MS_BASE * zoom;
  const width = Math.max(800, (timeline.durationMs || 10000) * pxPerMs + 200);
  const railRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

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
    const t = timelineRef.current.tracks.find((x) => x.type === "video");
    return t && t.type === "video" ? t.clips : [];
  }

  function currentCues(): CaptionCue[] {
    const t = timelineRef.current.tracks.find((x) => x.type === "captions");
    return t && t.type === "captions" ? t.cues : [];
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
      const dur = (base.endMs ?? 0) - (base.startMs ?? 0);
      const startMs = Math.max(0, roundMs((base.startMs ?? 0) + deltaMs));
      commitCues(
        currentCues().map((cue) =>
          cue.id === base.id
            ? { ...cue, startMs, endMs: startMs + Math.max(100, dur) }
            : cue,
        ),
      );
      return;
    }

    commitVideoClips(
      currentVideoClips().map((c) => {
        if (c.id !== base.id) return c;
        if (base.kind === "move") {
          return {
            ...c,
            timelineStartMs: Math.max(
              0,
              roundMs(base.timelineStartMs + deltaMs),
            ),
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
            timelineStartMs: Math.max(
              0,
              roundMs(base.timelineStartMs + shift),
            ),
          };
        }
        return {
          ...c,
          outMs: Math.max(base.inMs + 100, roundMs(base.outMs + deltaMs)),
        };
      }),
    );
  }

  const selectedCue = useMemo(() => {
    if (!captions || captions.type !== "captions" || !selectedId) return null;
    return captions.cues.find((c) => c.id === selectedId) ?? null;
  }, [captions, selectedId]);

  const selectedVideo =
    video && video.type === "video"
      ? video.clips.find((c) => c.id === selectedId)
      : undefined;

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <button type="button" onClick={splitAtPlayhead}>
          Dividir no playhead
        </button>
        <label>
          Zoom
          <input
            type="range"
            min={0.4}
            max={3}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
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
            onSeek(msFromClientX(e.clientX));
          }}
          onPointerUp={() => {
            scrubbing.current = false;
          }}
          onPointerCancel={() => {
            scrubbing.current = false;
          }}
        >
          <div className="timeline-inner" style={{ width }}>
            <div className="playhead" style={{ left: timeMs * pxPerMs }} />

            <div className="track-lane">
              {video &&
                video.type === "video" &&
                video.clips.map((c) => (
                  <ClipBlock
                    key={c.id}
                    left={c.timelineStartMs * pxPerMs}
                    width={clipDurationMs(c) * pxPerMs}
                    selected={selectedId === c.id}
                    label={timeline.assets[c.assetId]?.filename ?? c.assetId}
                    color="video"
                    onSelect={() => onSelect(c.id)}
                    onGestureStart={(kind) => {
                      dragBase.current = {
                        id: c.id,
                        kind,
                        timelineStartMs: c.timelineStartMs,
                        inMs: c.inMs,
                        outMs: c.outMs,
                      };
                    }}
                    onGestureDelta={applyDragDelta}
                    onGestureEnd={() => {
                      dragBase.current = null;
                    }}
                  />
                ))}
            </div>

            <div className="track-lane">
              {audio &&
                audio.type === "audio" &&
                audio.clips.map((c) => (
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
              {captions &&
                captions.type === "captions" &&
                captions.cues.map((c) => (
                  <ClipBlock
                    key={c.id}
                    left={c.startMs * pxPerMs}
                    width={Math.max(8, (c.endMs - c.startMs) * pxPerMs)}
                    selected={selectedId === c.id}
                    label={c.text.slice(0, 24)}
                    color="caption"
                    onSelect={() => onSelect(c.id)}
                    onGestureStart={() => {
                      dragBase.current = {
                        id: c.id,
                        kind: "cue",
                        timelineStartMs: 0,
                        inMs: 0,
                        outMs: 0,
                        startMs: c.startMs,
                        endMs: c.endMs,
                      };
                    }}
                    onGestureDelta={applyDragDelta}
                    onGestureEnd={() => {
                      dragBase.current = null;
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
      style={{ left, width: Math.max(width, 8) }}
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
