import {
  clipDurationMs,
  formatTimecode,
  type TransitionType,
  type VideoClip,
} from "../types";

const SPEEDS = [0.5, 0.75, 1, 1.5, 2];

export function ClipInspector({
  clip,
  filename,
  timeMs,
  onChange,
  onDelete,
  onDuplicate,
  onToggleMute,
  onDeleteLeft,
  onDeleteRight,
  onSplit,
  onSeekStart,
  onSeekEnd,
}: {
  clip: VideoClip | null;
  filename?: string;
  timeMs: number;
  onChange: (patch: Partial<VideoClip>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onToggleMute: () => void;
  onDeleteLeft: () => void;
  onDeleteRight: () => void;
  onSplit: () => void;
  onSeekStart: () => void;
  onSeekEnd: () => void;
}) {
  if (!clip) {
    return (
      <div className="clip-inspector empty-inspector">
        <h2>Clipe</h2>
        <p className="hint">
          Selecione um clipe na timeline. Use ← → para mover o playhead, Q/W
          para apagar à esquerda/direita.
        </p>
      </div>
    );
  }

  const volumePct = Math.round((clip.volume ?? 1) * 100);
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const start = clip.timelineStartMs;
  const end = clip.timelineStartMs + clipDurationMs(clip);
  const playheadInClip = timeMs > start + 50 && timeMs < end - 50;

  return (
    <div className="clip-inspector">
      <h2>Clipe</h2>
      <p className="inspector-name" title={filename}>
        {filename ?? clip.assetId}
      </p>
      <p className="hint">
        {formatTimecode(start)} → {formatTimecode(end)} (
        {formatTimecode(clipDurationMs(clip))})
      </p>

      <div className="inspector-section">
        <p className="inspector-label">Cortes no playhead</p>
        <div className="inspector-actions wrap">
          <button
            type="button"
            className="ghost"
            disabled={!playheadInClip}
            onClick={onDeleteLeft}
            title="Apagar à esquerda (Q)"
          >
            Apagar ←
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!playheadInClip}
            onClick={onSplit}
            title="Dividir (S)"
          >
            Dividir
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!playheadInClip}
            onClick={onDeleteRight}
            title="Apagar à direita (W)"
          >
            Apagar →
          </button>
        </div>
        {!playheadInClip && (
          <p className="hint">Coloque o playhead dentro do clipe para cortar.</p>
        )}
      </div>

      <div className="inspector-actions wrap">
        <button type="button" className="ghost" onClick={onSeekStart} title="Ir ao início do clipe">
          Ir ao início
        </button>
        <button type="button" className="ghost" onClick={onSeekEnd} title="Ir ao fim do clipe">
          Ir ao fim
        </button>
      </div>

      <label className="field compact">
        <span>Velocidade</span>
        <select
          value={String(speed)}
          onChange={(e) => onChange({ speed: Number(e.target.value) })}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </label>

      <div className={`volume-control${clip.muted ? " is-muted" : ""}`}>
        <div className="volume-control-head">
          <span className="volume-control-label">Volume</span>
          <span className="volume-control-value">
            {clip.muted ? "Mudo" : `${volumePct}%`}
          </span>
        </div>
        <div className="volume-control-row">
          <button
            type="button"
            className="volume-mute-btn"
            onClick={onToggleMute}
            title={clip.muted ? "Ativar áudio (M)" : "Mutar (M)"}
            aria-pressed={clip.muted}
            aria-label={clip.muted ? "Ativar áudio" : "Mutar"}
          >
            {clip.muted ? (
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                <path
                  fill="currentColor"
                  d="M4.3 3.3 3 4.6l4.2 4.2H3v6h4l5 5v-6.6l5.7 5.7 1.3-1.3L4.3 3.3zM14 3.5l-2.1 2.1L14 7.7V3.5z"
                />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                <path
                  fill="currentColor"
                  d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.3v7.4a4.5 4.5 0 0 0 2.5-3.7zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"
                />
              </svg>
            )}
          </button>
          <input
            className="volume-slider"
            type="range"
            min={0}
            max={100}
            value={clip.muted ? 0 : volumePct}
            onChange={(e) =>
              onChange({
                volume: Number(e.target.value) / 100,
                muted: Number(e.target.value) === 0,
              })
            }
            aria-label="Volume do clipe"
          />
        </div>
      </div>

      <label className="field compact">
        <span>Transição de entrada</span>
        <select
          value={clip.transitionIn ?? "cut"}
          onChange={(e) =>
            onChange({ transitionIn: e.target.value as TransitionType })
          }
        >
          <option value="cut">Corte</option>
          <option value="crossfade">Crossfade</option>
          <option value="fade">Fade</option>
        </select>
      </label>

      <div className="inspector-actions">
        <button type="button" className="ghost" onClick={onDuplicate} title="D">
          Duplicar
        </button>
        <button type="button" className="ghost danger" onClick={onDelete} title="Delete">
          Apagar
        </button>
      </div>
    </div>
  );
}
