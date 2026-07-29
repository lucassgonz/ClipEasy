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

export function TimelineView({
  timeline,
  timeMs,
  selectedId,
  onSelect,
  onChange,
  onSeek,
}: {
  timeline: Timeline;
  timeMs: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (timeline: Timeline) => void;
  onSeek: (ms: number) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const pxPerMs = PX_PER_MS_BASE * zoom;
  const width = Math.max(800, (timeline.durationMs || 10000) * pxPerMs + 200);
  const railRef = useRef<HTMLDivElement>(null);

  const video = timeline.tracks.find((t) => t.type === "video");
  const audio = timeline.tracks.find((t) => t.type === "audio");
  const captions = timeline.tracks.find((t) => t.type === "captions");

  function seekFromEvent(clientX: number) {
    const el = railRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    onSeek(Math.max(0, x / pxPerMs));
  }

  function updateVideoClips(clips: VideoClip[]) {
    const next: Timeline = {
      ...timeline,
      tracks: timeline.tracks.map((t) =>
        t.type === "video" ? { ...t, clips } : t,
      ),
    };
    // mirror audio
    next.tracks = next.tracks.map((t) =>
      t.type === "audio"
        ? {
            ...t,
            clips: clips.map((c) => ({
              id: `${c.id}-a`,
              assetId: c.assetId,
              timelineStartMs: c.timelineStartMs,
              inMs: c.inMs,
              outMs: c.outMs,
            })),
          }
        : t,
    );
    next.durationMs = recomputeDuration(next);
    onChange(next);
  }

  function updateCues(cues: CaptionCue[]) {
    const next: Timeline = {
      ...timeline,
      tracks: timeline.tracks.map((t) =>
        t.type === "captions" ? { ...t, cues } : t,
      ),
    };
    next.durationMs = recomputeDuration(next);
    onChange(next);
  }

  function splitAtPlayhead() {
    if (!video || video.type !== "video") return;
    const clips = structuredClone(video.clips);
    const idx = clips.findIndex((c) => {
      const end = c.timelineStartMs + clipDurationMs(c);
      return timeMs > c.timelineStartMs + 50 && timeMs < end - 50;
    });
    if (idx < 0) return;
    const c = clips[idx]!;
    const local = timeMs - c.timelineStartMs + c.inMs;
    const left: VideoClip = { ...c, outMs: local };
    const right: VideoClip = {
      ...c,
      id: `${c.id}-r`,
      timelineStartMs: timeMs,
      inMs: local,
      transitionIn: "cut",
    };
    clips.splice(idx, 1, left, right);
    updateVideoClips(clips);
  }

  function setTransition(id: string, transitionIn: TransitionType) {
    if (!video || video.type !== "video") return;
    updateVideoClips(
      video.clips.map((c) => (c.id === id ? { ...c, transitionIn } : c)),
    );
  }

  function onDragClip(id: string, deltaMs: number) {
    if (!video || video.type !== "video") return;
    updateVideoClips(
      video.clips.map((c) =>
        c.id === id
          ? { ...c, timelineStartMs: Math.max(0, c.timelineStartMs + deltaMs) }
          : c,
      ),
    );
  }

  function trimClip(id: string, edge: "in" | "out", deltaMs: number) {
    if (!video || video.type !== "video") return;
    updateVideoClips(
      video.clips.map((c) => {
        if (c.id !== id) return c;
        if (edge === "in") {
          const inMs = Math.min(c.outMs - 100, Math.max(0, c.inMs + deltaMs));
          const shift = inMs - c.inMs;
          return {
            ...c,
            inMs,
            timelineStartMs: c.timelineStartMs + shift,
          };
        }
        return {
          ...c,
          outMs: Math.max(c.inMs + 100, c.outMs + deltaMs),
        };
      }),
    );
  }

  const selectedCue = useMemo(() => {
    if (!captions || captions.type !== "captions" || !selectedId) return null;
    return captions.cues.find((c) => c.id === selectedId) ?? null;
  }, [captions, selectedId]);

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
        {selectedId && video && video.type === "video" && video.clips.some((c) => c.id === selectedId) && (
          <label>
            Transição
            <select
              value={
                video.clips.find((c) => c.id === selectedId)?.transitionIn ?? "cut"
              }
              onChange={(e) =>
                setTransition(selectedId, e.target.value as TransitionType)
              }
            >
              <option value="cut">Corte</option>
              <option value="crossfade">Crossfade</option>
              <option value="fade">Fade</option>
            </select>
          </label>
        )}
      </div>

      <div
        className="timeline-rail"
        ref={railRef}
        onClick={(e) => seekFromEvent(e.clientX)}
      >
        <div className="timeline-inner" style={{ width }}>
          <div
            className="playhead"
            style={{ left: timeMs * pxPerMs }}
          />

          <TrackRow label="Vídeo">
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
                  onDrag={(dx) => onDragClip(c.id, dx / pxPerMs)}
                  onTrimIn={(dx) => trimClip(c.id, "in", dx / pxPerMs)}
                  onTrimOut={(dx) => trimClip(c.id, "out", dx / pxPerMs)}
                />
              ))}
          </TrackRow>

          <TrackRow label="Áudio">
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
          </TrackRow>

          <TrackRow label="Legendas">
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
                  onDrag={(dx) => {
                    const d = dx / pxPerMs;
                    updateCues(
                      captions.cues.map((cue) =>
                        cue.id === c.id
                          ? {
                              ...cue,
                              startMs: Math.max(0, cue.startMs + d),
                              endMs: Math.max(cue.startMs + 100, cue.endMs + d),
                            }
                          : cue,
                      ),
                    );
                  }}
                />
              ))}
          </TrackRow>
        </div>
      </div>

      {selectedCue && (
        <div className="cue-editor">
          <label>
            Texto da legenda
            <textarea
              value={selectedCue.text}
              onChange={(e) =>
                updateCues(
                  (captions && captions.type === "captions"
                    ? captions.cues
                    : []
                  ).map((c) =>
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

function TrackRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="track-row">
      <div className="track-label">{label}</div>
      <div className="track-lane">{children}</div>
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
  onDrag,
  onTrimIn,
  onTrimOut,
}: {
  left: number;
  width: number;
  selected: boolean;
  label: string;
  color: "video" | "audio" | "caption";
  onSelect: () => void;
  onDrag?: (dx: number) => void;
  onTrimIn?: (dx: number) => void;
  onTrimOut?: (dx: number) => void;
}) {
  return (
    <div
      className={`clip ${color} ${selected ? "selected" : ""}`}
      style={{ left, width: Math.max(width, 8) }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        if (!onDrag) return;
        const startX = e.clientX;
        const move = (ev: PointerEvent) => onDrag(ev.clientX - startX);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        // cumulative from origin each move - fix by tracking last
        let last = startX;
        const move2 = (ev: PointerEvent) => {
          onDrag(ev.clientX - last);
          last = ev.clientX;
        };
        window.addEventListener("pointermove", move2);
        window.addEventListener("pointerup", up);
      }}
    >
      {onTrimIn && (
        <span
          className="handle left"
          onPointerDown={(e) => {
            e.stopPropagation();
            let last = e.clientX;
            const move = (ev: PointerEvent) => {
              onTrimIn(ev.clientX - last);
              last = ev.clientX;
            };
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      )}
      <span className="clip-label">{label}</span>
      {onTrimOut && (
        <span
          className="handle right"
          onPointerDown={(e) => {
            e.stopPropagation();
            let last = e.clientX;
            const move = (ev: PointerEvent) => {
              onTrimOut(ev.clientX - last);
              last = ev.clientX;
            };
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      )}
    </div>
  );
}
