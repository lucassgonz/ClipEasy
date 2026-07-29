import { useEffect, useState } from "react";
import { createProject, listProjects, removeProject } from "../api";
import type { Project, ProjectKind } from "../types";
import { signOut } from "../lib/supabase";

export function ProjectList({
  onOpen,
  onLogout,
}: {
  onOpen: (id: string, kind: ProjectKind) => void;
  onLogout: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState("Novo projeto");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setProjects(await listProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao listar");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function create(kind: ProjectKind) {
    setBusy(true);
    setError(null);
    try {
      const p = await createProject(title.trim() || "Sem título", kind);
      onOpen(p.id, p.kind ?? kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="projects-page">
      <header className="projects-head">
        <div>
          <h1 className="brand">clipEasy</h1>
          <p className="tagline">Vídeos e fotos para YouTube — no seu PC</p>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={() => void signOut().then(onLogout)}
        >
          Sair
        </button>
      </header>

      <div className="create-row">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Nome do projeto"
        />
        <button
          type="button"
          className="cta"
          disabled={busy}
          onClick={() => void create("video")}
        >
          Novo vídeo
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void create("image")}
        >
          Nova imagem
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="project-item"
              onClick={() => onOpen(p.id, p.kind ?? "video")}
            >
              <strong>
                {p.title}{" "}
                <em className="kind-tag">
                  {p.kind === "image" ? "imagem" : "vídeo"}
                </em>
              </strong>
              <span>
                {p.kind === "image"
                  ? "Editor de foto"
                  : `${Math.round(p.duration_ms / 1000)}s`}{" "}
                · {new Date(p.updated_at).toLocaleString()}
              </span>
            </button>
            <button
              type="button"
              className="ghost danger"
              onClick={() =>
                void removeProject(p.id)
                  .then(refresh)
                  .catch((e: Error) => setError(e.message))
              }
            >
              Apagar
            </button>
          </li>
        ))}
        {projects.length === 0 && (
          <li className="empty">Nenhum projeto ainda. Crie o primeiro.</li>
        )}
      </ul>
    </div>
  );
}
