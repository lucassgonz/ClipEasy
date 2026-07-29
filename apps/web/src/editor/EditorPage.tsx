import { useEffect, useRef, useState } from "react";
import { getProject, saveProject } from "../api";
import type { Project, Timeline } from "../types";
import { Preview } from "./Preview";
import { SidePanel } from "./SidePanel";
import { TimelineView } from "./Timeline";

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
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    void getProject(projectId)
      .then(setProject)
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  function scheduleSave(next: Project) {
    setProject(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveProject(next.id, {
        title: next.title,
        timeline: next.timeline,
      }).catch((e: Error) => setError(e.message));
    }, 600);
  }

  function onTimeline(timeline: Timeline) {
    if (!project) return;
    scheduleSave({ ...project, timeline, duration_ms: timeline.durationMs });
  }

  if (error && !project) {
    return (
      <div className="editor-page">
        <p className="error">{error}</p>
        <button type="button" onClick={onBack}>
          Voltar
        </button>
      </div>
    );
  }

  if (!project) {
    return <div className="editor-page">Carregando projeto…</div>;
  }

  return (
    <div className="editor-page">
      <header className="editor-top">
        <button type="button" className="ghost" onClick={onBack}>
          ← Projetos
        </button>
        <div className="editor-title">
          <span className="brand-mini">ClipFácil</span>
          <input
            className="title-input"
            value={project.title}
            onChange={(e) =>
              scheduleSave({ ...project, title: e.target.value })
            }
          />
        </div>
      </header>

      <div className="editor-grid">
        <div className="editor-main">
          <Preview
            projectId={project.id}
            timeline={project.timeline}
            timeMs={timeMs}
            playing={playing}
            onTime={setTimeMs}
            onTogglePlay={() => setPlaying((p) => !p)}
          />
          <TimelineView
            timeline={project.timeline}
            timeMs={timeMs}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={onTimeline}
            onSeek={(ms) => {
              setPlaying(false);
              setTimeMs(ms);
            }}
          />
        </div>
        <SidePanel
          project={project}
          onProject={(p) => {
            setProject(p);
          }}
        />
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
