import { useState } from "react";
import {
  generateCaptions,
  importYoutube,
  recipeSplit,
  recipeSilence,
  startExport,
  fetchExportJob,
  exportFileUrl,
  uploadAsset,
  suggestYoutube,
  saveProject,
} from "../api";
import { getSession } from "../lib/supabase";
import type { ExportJob, Project, Resolution, YoutubeMeta } from "../types";

async function downloadAuthed(urlPath: string, filename: string) {
  const session = await getSession();
  const res = await fetch(exportFileUrl(urlPath), {
    headers: session?.access_token
      ? { Authorization: `Bearer ${session.access_token}` }
      : {},
  });
  if (!res.ok) throw new Error("Falha no download");
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

export function SidePanel({
  project,
  onProject,
}: {
  project: Project;
  onProject: (p: Project) => void;
}) {
  const [url, setUrl] = useState("");
  const [splitSec, setSplitSec] = useState(60);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [verticalMode, setVerticalMode] = useState<"crop" | "blur">("crop");
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [copied, setCopied] = useState<string | null>(null);

  const youtube = project.metadata?.youtube;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function patchYoutube(next: YoutubeMeta) {
    const updated = {
      ...project,
      metadata: { ...project.metadata, youtube: next },
    };
    onProject(updated);
    void saveProject(project.id, { metadata: updated.metadata });
  }

  return (
    <aside className="side-panel">
      <h2>Importar</h2>
      <label className="field">
        <span>URL do YouTube</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://youtube.com/…"
        />
      </label>
      <button
        type="button"
        className="cta small"
        disabled={Boolean(busy)}
        onClick={() =>
          void run("YouTube", async () => {
            onProject(await importYoutube(project.id, url.trim()));
            setUrl("");
          })
        }
      >
        Baixar e adicionar
      </button>

      <label className="field">
        <span>Arquivo local</span>
        <input
          type="file"
          accept="video/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void run("Upload", async () => {
              onProject(await uploadAsset(project.id, file));
            });
          }}
        />
      </label>

      <h2>Receitas</h2>
      <label className="field compact">
        <span>Dividir a cada (s)</span>
        <input
          type="number"
          min={1}
          value={splitSec}
          onChange={(e) => setSplitSec(Number(e.target.value))}
        />
      </label>
      <button
        type="button"
        className="ghost"
        disabled={Boolean(busy)}
        onClick={() =>
          void run("Split", async () => {
            onProject(await recipeSplit(project.id, splitSec));
          })
        }
      >
        Aplicar divisão na timeline
      </button>

      <button
        type="button"
        className="ghost"
        disabled={Boolean(busy)}
        onClick={() =>
          void run("Silêncios", async () => {
            onProject(await recipeSilence(project.id));
          })
        }
      >
        Cortar silêncios (1º clipe)
      </button>

      <button
        type="button"
        className="ghost"
        disabled={Boolean(busy)}
        onClick={() =>
          void run("Legendas", async () => {
            onProject(await generateCaptions(project.id));
          })
        }
      >
        Gerar legendas (Whisper)
      </button>

      <h2>Para o YouTube</h2>
      <button
        type="button"
        className="ghost"
        disabled={Boolean(busy)}
        onClick={() =>
          void run("Metadados", async () => {
            const { project: updated } = await suggestYoutube(project.id);
            onProject(updated);
          })
        }
      >
        Sugerir título, descrição e tags
      </button>

      {youtube && (
        <div className="yt-box">
          <label className="field compact">
            <span>Título</span>
            <select
              value={youtube.selectedTitle ?? youtube.titles[0] ?? ""}
              onChange={(e) =>
                patchYoutube({ ...youtube, selectedTitle: e.target.value })
              }
            >
              {youtube.titles.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void copyText(youtube.selectedTitle ?? youtube.titles[0] ?? "").then(
                () => setCopied("título"),
              )
            }
          >
            Copiar título
          </button>

          <label className="field compact">
            <span>Descrição</span>
            <textarea
              rows={5}
              value={youtube.description}
              onChange={(e) =>
                patchYoutube({ ...youtube, description: e.target.value })
              }
            />
          </label>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void copyText(youtube.description).then(() => setCopied("descrição"))
            }
          >
            Copiar descrição
          </button>

          <label className="field compact">
            <span>Hashtags</span>
            <textarea
              rows={2}
              value={youtube.hashtags.join(" ")}
              onChange={(e) =>
                patchYoutube({
                  ...youtube,
                  hashtags: e.target.value.split(/\s+/).filter(Boolean),
                })
              }
            />
          </label>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void copyText(youtube.hashtags.join(" ")).then(() =>
                setCopied("hashtags"),
              )
            }
          >
            Copiar hashtags
          </button>

          <label className="field compact">
            <span>Tags</span>
            <textarea
              rows={2}
              value={youtube.tags.join(", ")}
              onChange={(e) =>
                patchYoutube({
                  ...youtube,
                  tags: e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void copyText(youtube.tags.join(", ")).then(() => setCopied("tags"))
            }
          >
            Copiar tags
          </button>
          {copied && <p className="hint">Copiado: {copied}</p>}
        </div>
      )}

      <h2>Exportar</h2>
      <label className="field compact">
        <span>Resolução</span>
        <select
          value={resolution}
          onChange={(e) => setResolution(e.target.value as Resolution)}
        >
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="1440p">1440p</option>
          <option value="2160p">4K (2160p)</option>
        </select>
      </label>
      <label className="field compact">
        <span>Vertical</span>
        <select
          value={verticalMode}
          onChange={(e) => setVerticalMode(e.target.value as "crop" | "blur")}
        >
          <option value="crop">Recorte</option>
          <option value="blur">Fundo desfocado</option>
        </select>
      </label>
      <button
        type="button"
        className="cta"
        disabled={Boolean(busy)}
        onClick={() =>
          void run("Export", async () => {
            const jobId = await startExport(project.id, {
              exportHorizontal: true,
              exportVertical: true,
              verticalMode,
              resolution,
              burnCaptions: true,
            });
            for (;;) {
              const job = await fetchExportJob(jobId);
              setExportJob(job);
              if (job.status === "done" || job.status === "error") break;
              await new Promise((r) => setTimeout(r, 1200));
            }
          })
        }
      >
        Exportar H + V
      </button>

      {busy && <p className="progress-label">{busy}…</p>}
      {error && <p className="error">{error}</p>}
      {exportJob && (
        <div className="export-box">
          <p>
            {exportJob.progress.step} — {exportJob.progress.percent}%
          </p>
          {exportJob.error && <p className="error">{exportJob.error}</p>}
          <ul>
            {exportJob.outputs.map((o) => (
              <li key={o.name}>
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    void downloadAuthed(o.url, o.name).catch((e: Error) =>
                      setError(e.message),
                    )
                  }
                >
                  Baixar {o.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
