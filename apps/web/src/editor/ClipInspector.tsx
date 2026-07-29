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

      <label className="field compact">
        <span>Volume {clip.muted ? "(mudo)" : `${volumePct}%`}</span>
        <input
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
        />
      </label>

      <button type="button" className="ghost" onClick={onToggleMute} title="M">
        {clip.muted ? "Ativar áudio" : "Mutar"}
      </button>

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
