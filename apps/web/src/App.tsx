import { useEffect, useState } from "react";
import { fetchHealth } from "./api";
import { AuthPage } from "./auth/AuthPage";
import { EditorPage } from "./editor/EditorPage";
import { ImageStudio } from "./editor/ImageStudio";
import { getSession, isDevBypass } from "./lib/supabase";
import { ProjectList } from "./projects/ProjectList";
import type { HealthReport, ProjectKind } from "./types";
import "./styles.css";

type Screen = "auth" | "list" | "editor" | "image";

export default function App() {
  const [screen, setScreen] = useState<Screen>("auth");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);

  useEffect(() => {
    void fetchHealth().then(setHealth).catch(() => undefined);
    void (async () => {
      const session = await getSession();
      if (session || isDevBypass()) setScreen("list");
    })();
  }, []);

  function openProject(id: string, kind: ProjectKind) {
    setProjectId(id);
    setScreen(kind === "image" ? "image" : "editor");
  }

  return (
    <div className="app-shell">
      <div className="atmosphere" aria-hidden />
      {screen === "auth" && (
        <AuthPage onAuthed={() => setScreen("list")} />
      )}
      {screen === "list" && (
        <ProjectList
          onOpen={openProject}
          onLogout={() => setScreen("auth")}
        />
      )}
      {screen === "editor" && projectId && (
        <EditorPage
          projectId={projectId}
          onBack={() => {
            setProjectId(null);
            setScreen("list");
          }}
        />
      )}
      {screen === "image" && projectId && (
        <ImageStudio
          projectId={projectId}
          onBack={() => {
            setProjectId(null);
            setScreen("list");
          }}
        />
      )}
      {health && (
        <footer className="status-foot">
          {health.mode === "dev-bypass" ? "Dev bypass · " : ""}
          OpenAI: {health.openai ? "ok" : "ausente"} · Ferramentas:{" "}
          {health.binaries.filter((b) => !b.available).length === 0
            ? "ok"
            : health.binaries
                .filter((b) => !b.available)
                .map((b) => b.name)
                .join(", ")}
        </footer>
      )}
    </div>
  );
}
