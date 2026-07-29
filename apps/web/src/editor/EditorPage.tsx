import { useEffect, useRef, useState } from "react";
import { getProject, saveProject } from "../api";
import { clipDurationMs, type Project, type Timeline, type VideoClip } from "../types";
import { ClipInspector } from "./ClipInspector";
import { EditToolbar } from "./EditToolbar";
import { ExportModal } from "./ExportModal";
import { Preview } from "./Preview";
import { SidePanel } from "./SidePanel";
import { StatusPopup, type StatusPopupState } from "./StatusPopup";
import { TimelineView } from "./Timeline";
import {
  closeGaps,
  deleteAllAfter,
  deleteAllBefore,
  deleteClip,
  deleteLeftOfPlayhead,
  deleteRightOfPlayhead,
  duplicateClip,
  findClipAtTime,
  nudgeClip,
  snapClipsToStart,
  splitAtPlayhead,
  toggleMute,
  updateClip,
} from "./timelineOps";

const HISTORY_MAX = 50;
const FRAME_MS = 1000 / 30;
const SEEK_STEP_MS = 200;
const SEEK_STEP_SHIFT_MS = 1000;
const NUDGE_MS = 100;
const NUDGE_SHIFT_MS = 1000;

export function EditorPage({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusPopupState | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [previewVertical, setPreviewVertical] = useState(false);
  const [cropFocusX, setCropFocusX] = useState(0.5);
  const [verticalMode, setVerticalMode] = useState<"crop" | "blur">("crop");
  const [sideTab, setSideTab] = useState<"clip" | "project">("project");
  const [showShortcuts, setShowShortcuts] = useState(false);

  const saveTimer = useRef<number | null>(null);
  const history = useRef<Timeline[]>([]);
  const future = useRef<Timeline[]>([]);
  const applyingHistory = useRef(false);
  const projectRef = useRef<Project | null>(null);
  const timeRef = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const [histTick, setHistTick] = useState(0);
  projectRef.current = project;
  timeRef.current = timeMs;
  selectedRef.current = selectedId;

  function bumpHistory() {
    setHistTick((n) => n + 1);
  }

  useEffect(() => {
    void getProject(projectId)
      .then((p) => {
        setProject(p);
        history.current = [];
        future.current = [];
      })
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  function scheduleSave(next: Project, pushHistory = true) {
    if (pushHistory && !applyingHistory.current && project) {
      // Timelines are treated as immutable after commit — store ref, no deep clone.
      history.current.push(project.timeline);
      if (history.current.length > HISTORY_MAX) history.current.shift();
      future.current = [];
      bumpHistory();
    }
    setProject(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveProject(next.id, {
        title: next.title,
        timeline: next.timeline,
      }).catch((e: Error) =>
        setStatus({
          kind: "error",
          title: "Falha ao salvar",
          message: e.message,
        }),
      );
    }, 600);
  }

  function applyTimeline(timeline: Timeline, pushHistory = true) {
    const cur = projectRef.current;
    if (!cur) return;
    const durationMs = Math.round(timeline.durationMs);
    scheduleSave(
      {
        ...cur,
        timeline: { ...timeline, durationMs },
        duration_ms: durationMs,
      },
      pushHistory,
    );
  }

  function onTimeline(timeline: Timeline) {
    applyTimeline(timeline, true);
  }

  function undo() {
    const cur = projectRef.current;
    if (!cur || history.current.length === 0) return;
    const prev = history.current.pop()!;
    future.current.push(cur.timeline);
    bumpHistory();
    applyingHistory.current = true;
    applyTimeline(prev, false);
    applyingHistory.current = false;
  }

  function redo() {
    const cur = projectRef.current;
    if (!cur || future.current.length === 0) return;
    const next = future.current.pop()!;
    history.current.push(cur.timeline);
    bumpHistory();
    applyingHistory.current = true;
    applyTimeline(next, false);
    applyingHistory.current = false;
  }

  function selectedClip(): VideoClip | null {
    if (!project || !selectedId) return null;
    const track = project.timeline.tracks.find((t) => t.type === "video");
    if (!track || track.type !== "video") return null;
    return track.clips.find((c) => c.id === selectedId) ?? null;
  }

  function runOp(next: Timeline | null) {
    if (!next) return;
    applyTimeline(next, true);
  }

  function selectClip(id: string | null) {
    setSelectedId(id);
    if (id) setSideTab("clip");
  }

  function targetClipId(): string | null {
    const cur = projectRef.current;
    if (!cur) return null;
    if (selectedRef.current) return selectedRef.current;
    return findClipAtTime(cur.timeline, timeRef.current)?.id ?? null;
  }

  function canTrimAtPlayhead(): boolean {
    const cur = projectRef.current;
    const id = selectedId;
    if (!cur || !id) return false;
    const track = cur.timeline.tracks.find((t) => t.type === "video");
    if (!track || track.type !== "video") return false;
    const c = track.clips.find((x) => x.id === id);
    if (!c) return false;
    const end = c.timelineStartMs + clipDurationMs(c);
    return timeMs > c.timelineStartMs + 50 && timeMs < end - 50;
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const mod = e.metaKey || e.ctrlKey;
      const cur = projectRef.current;
      if (!cur) return;
      const t = timeRef.current;
      const maxT = Math.max(0, cur.timeline.durationMs);

      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        if (mod && selectedRef.current) {
          runOp(
            nudgeClip(
              cur.timeline,
              selectedRef.current,
              -(e.shiftKey ? NUDGE_SHIFT_MS : NUDGE_MS),
            ),
          );
        } else {
          const step = e.shiftKey ? SEEK_STEP_SHIFT_MS : SEEK_STEP_MS;
          setTimeMs((ms) => Math.max(0, ms - step));
        }
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        if (mod && selectedRef.current) {
          runOp(
            nudgeClip(
              cur.timeline,
              selectedRef.current,
              e.shiftKey ? NUDGE_SHIFT_MS : NUDGE_MS,
            ),
          );
        } else {
          const step = e.shiftKey ? SEEK_STEP_SHIFT_MS : SEEK_STEP_MS;
          setTimeMs((ms) => Math.min(maxT, ms + step));
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPlaying(false);
        setTimeMs((ms) => Math.max(0, ms - FRAME_MS));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPlaying(false);
        setTimeMs((ms) => Math.min(maxT, ms + FRAME_MS));
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setPlaying(false);
        setTimeMs(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setPlaying(false);
        setTimeMs(maxT);
        return;
      }
      if (e.key.toLowerCase() === "s" && !mod) {
        e.preventDefault();
        runOp(splitAtPlayhead(cur.timeline, t));
        return;
      }
      if (e.key.toLowerCase() === "q" && !mod) {
        e.preventDefault();
        const id = targetClipId();
        if (!id) return;
        selectClip(id);
        runOp(deleteLeftOfPlayhead(cur.timeline, id, t));
        return;
      }
      if (e.key.toLowerCase() === "w" && !mod) {
        e.preventDefault();
        const id = targetClipId();
        if (!id) return;
        selectClip(id);
        runOp(deleteRightOfPlayhead(cur.timeline, id, t));
        return;
      }
      if (e.key.toLowerCase() === "d" && !mod) {
        e.preventDefault();
        const id = targetClipId();
        if (!id) return;
        const result = duplicateClip(cur.timeline, id);
        if (!result) return;
        applyTimeline(result.timeline, true);
        selectClip(result.newId);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const id = targetClipId();
        if (!id) return;
        e.preventDefault();
        runOp(deleteClip(cur.timeline, id));
        setSelectedId(null);
        return;
      }
      if (e.key.toLowerCase() === "m") {
        const id = targetClipId();
        if (!id) return;
        e.preventDefault();
        selectClip(id);
        runOp(toggleMute(cur.timeline, id));
        return;
      }
      if (e.shiftKey && e.key === "[") {
        e.preventDefault();
        runOp(deleteAllBefore(cur.timeline, t));
        return;
      }
      if (e.shiftKey && e.key === "]") {
        e.preventDefault();
        runOp(deleteAllAfter(cur.timeline, t));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error && !project) {
    return (
      <div className="editor-page">
        <StatusPopup
          status={{
            kind: "error",
            title: "Não foi possível abrir o projeto",
            message: error,
          }}
          onClose={onBack}
        />
        <button type="button" onClick={onBack}>
          Voltar
        </button>
      </div>
    );
  }

  if (!project) {
    return <div className="editor-page">Carregando projeto…</div>;
  }

  const clip = selectedClip();

  return (
    <div className="editor-page">
      <StatusPopup status={status} onClose={() => setStatus(null)} />
      <header className="editor-top">
        <button type="button" className="ghost" onClick={onBack}>
          ← Projetos
        </button>
        <div className="editor-title">
          <span className="brand-mini">clipEasy</span>
          <input
            className="title-input"
            value={project.title}
            onChange={(e) =>
              scheduleSave({ ...project, title: e.target.value }, false)
            }
          />
        </div>
        <button
          type="button"
          className={`ghost ${previewVertical ? "active-toggle" : ""}`}
          onClick={() => setPreviewVertical((v) => !v)}
          title="Ver o corte vertical 9:16 no preview principal"
        >
          {previewVertical ? "Vertical 9:16" : "Prévia 9:16"}
        </button>
        <button
          type="button"
          className="cta small"
          onClick={() => setExportOpen(true)}
        >
          Exportar…
        </button>
      </header>

      <EditToolbar
        canUndo={histTick >= 0 && history.current.length > 0}
        canRedo={histTick >= 0 && future.current.length > 0}
        hasSelection={Boolean(selectedId)}
        canTrimAtPlayhead={canTrimAtPlayhead()}
        onUndo={undo}
        onRedo={redo}
        onSplit={() => runOp(splitAtPlayhead(project.timeline, timeMs))}
        onDelete={() => {
          if (!selectedId) return;
          runOp(deleteClip(project.timeline, selectedId));
          setSelectedId(null);
        }}
        onDuplicate={() => {
          if (!selectedId) return;
          const result = duplicateClip(project.timeline, selectedId);
          if (!result) return;
          applyTimeline(result.timeline, true);
          selectClip(result.newId);
        }}
        onDeleteLeft={() => {
          if (!selectedId) return;
          runOp(deleteLeftOfPlayhead(project.timeline, selectedId, timeMs));
        }}
        onDeleteRight={() => {
          if (!selectedId) return;
          runOp(deleteRightOfPlayhead(project.timeline, selectedId, timeMs));
        }}
        onCloseGaps={() => runOp(closeGaps(project.timeline))}
        onSnapStart={() => {
          runOp(snapClipsToStart(project.timeline));
          setTimeMs(0);
        }}
        onShowShortcuts={() => setShowShortcuts(true)}
      />

      <div className="editor-workspace">
        <div className="editor-grid editor-grid-3">
          <div className="editor-main">
            <Preview
              projectId={project.id}
              timeline={project.timeline}
              timeMs={timeMs}
              playing={playing}
              onTime={setTimeMs}
              onTogglePlay={() => setPlaying((p) => !p)}
              onPlayingChange={setPlaying}
              verticalPreview={previewVertical}
              verticalMode={verticalMode}
              cropFocusX={cropFocusX}
              onFramingChange={(opts) => {
                setVerticalMode(opts.mode);
                setCropFocusX(opts.cropFocusX);
              }}
            />
          </div>

          <aside className="editor-side-panel">
            <div className="side-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === "clip"}
                className={sideTab === "clip" ? "active" : ""}
                onClick={() => setSideTab("clip")}
              >
                Clipe
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === "project"}
                className={sideTab === "project" ? "active" : ""}
                onClick={() => setSideTab("project")}
              >
                Projeto
              </button>
            </div>
            <div className="side-tab-body">
              {sideTab === "clip" ? (
                <ClipInspector
                  clip={clip}
                  timeMs={timeMs}
                  filename={
                    clip
                      ? project.timeline.assets[clip.assetId]?.filename
                      : undefined
                  }
                  onChange={(patch) => {
                    if (!selectedId) return;
                    runOp(updateClip(project.timeline, selectedId, patch));
                  }}
                  onDelete={() => {
                    if (!selectedId) return;
                    runOp(deleteClip(project.timeline, selectedId));
                    setSelectedId(null);
                  }}
                  onDuplicate={() => {
                    if (!selectedId) return;
                    const result = duplicateClip(project.timeline, selectedId);
                    if (!result) return;
                    applyTimeline(result.timeline, true);
                    selectClip(result.newId);
                  }}
                  onToggleMute={() => {
                    if (!selectedId) return;
                    runOp(toggleMute(project.timeline, selectedId));
                  }}
                  onDeleteLeft={() => {
                    if (!selectedId) return;
                    runOp(
                      deleteLeftOfPlayhead(project.timeline, selectedId, timeMs),
                    );
                  }}
                  onDeleteRight={() => {
                    if (!selectedId) return;
                    runOp(
                      deleteRightOfPlayhead(
                        project.timeline,
                        selectedId,
                        timeMs,
                      ),
                    );
                  }}
                  onSplit={() =>
                    runOp(splitAtPlayhead(project.timeline, timeMs))
                  }
                  onSeekStart={() => {
                    if (!clip) return;
                    setPlaying(false);
                    setTimeMs(clip.timelineStartMs);
                  }}
                  onSeekEnd={() => {
                    if (!clip) return;
                    setPlaying(false);
                    setTimeMs(
                      Math.max(
                        0,
                        clip.timelineStartMs + clipDurationMs(clip) - 1,
                      ),
                    );
                  }}
                />
              ) : (
                <SidePanel
                  project={project}
                  selectedClipId={selectedId}
                  onProject={(p) => {
                    scheduleSave(p, true);
                    setSelectedId((id) => {
                      if (!id) return null;
                      const track = p.timeline.tracks.find(
                        (t) => t.type === "video",
                      );
                      if (!track || track.type !== "video") return null;
                      return track.clips.some((c) => c.id === id) ? id : null;
                    });
                    setTimeMs((t) =>
                      Math.min(t, Math.max(0, p.timeline.durationMs || 0)),
                    );
                  }}
                  onOpenExport={() => setExportOpen(true)}
                />
              )}
            </div>
          </aside>
        </div>
        <TimelineView
          timeline={project.timeline}
          timeMs={timeMs}
          playing={playing}
          selectedId={selectedId}
          onSelect={selectClip}
          onChange={onTimeline}
          onSeek={(ms) => {
            setPlaying(false);
            setTimeMs(ms);
          }}
          onSplit={() => runOp(splitAtPlayhead(project.timeline, timeMs))}
        />
      </div>

      <ExportModal
        projectId={project.id}
        defaultFps={project.timeline.fps || 30}
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        initialVerticalMode={verticalMode}
        initialCropFocusX={cropFocusX}
        onPreviewVertical={(opts) => {
          setPreviewVertical(true);
          setVerticalMode(opts.mode);
          setCropFocusX(opts.cropFocusX);
        }}
      />

      {showShortcuts && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setShowShortcuts(false)}
        >
          <div
            className="modal shortcuts-modal"
            role="dialog"
            aria-labelledby="shortcuts-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-head">
              <h2 id="shortcuts-title">Atalhos</h2>
              <button
                type="button"
                className="ghost"
                onClick={() => setShowShortcuts(false)}
              >
                Fechar
              </button>
            </header>
            <ul className="shortcuts-list">
              <li>
                <kbd>Espaço</kbd> Play / pausa
              </li>
              <li>
                <kbd>←</kbd> <kbd>→</kbd> Mover playhead (⇧ = 1s)
              </li>
              <li>
                <kbd>↑</kbd> <kbd>↓</kbd> Frame a frame
              </li>
              <li>
                <kbd>⌘</kbd>+<kbd>←</kbd>/<kbd>→</kbd> Empurrar clipe
              </li>
              <li>
                <kbd>Home</kbd> / <kbd>End</kbd> Início / fim
              </li>
              <li>
                <kbd>S</kbd> Dividir no playhead
              </li>
              <li>
                <kbd>Q</kbd> Apagar à esquerda · <kbd>W</kbd> à direita
              </li>
              <li>
                <kbd>D</kbd> Duplicar · <kbd>M</kbd> Mudo
              </li>
              <li>
                <kbd>Delete</kbd> Apagar clipe
              </li>
              <li>
                <kbd>⇧[</kbd> Apagar tudo antes · <kbd>⇧]</kbd> depois
              </li>
              <li>
                <kbd>⌘Z</kbd> Desfazer · <kbd>⇧⌘Z</kbd> Refazer
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
