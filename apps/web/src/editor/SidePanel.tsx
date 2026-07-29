import { useState } from "react";
import {
  generateCaptions,
  importYoutube,
  recipeSplit,
  recipeSilence,
  uploadAsset,
  suggestYoutube,
  saveProject,
} from "../api";
import type { Project, YoutubeMeta } from "../types";

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

export function SidePanel({
  project,
  onProject,
  onOpenExport,
}: {
  project: Project;
  onProject: (p: Project) => void;
  onOpenExport?: () => void;
}) {
  const [url, setUrl] = useState("");
  const [splitSec, setSplitSec] = useState(60);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
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

      <div className="field">
        <span>Arquivo local</span>
        <label className="file-pick">
          <input
            type="file"
            accept="video/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setFileName(file.name);
              void run("Upload", async () => {
                onProject(await uploadAsset(project.id, file));
              });
            }}
          />
          <span className="file-pick-btn">Escolher arquivo</span>
          <span className="file-pick-name">
            {fileName ?? "Nenhum arquivo selecionado"}
          </span>
        </label>
      </div>

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
          void run("YouTube meta", async () => {
            const result = await suggestYoutube(project.id);
            onProject(result.project);
          })
        }
      >
        Sugerir título, descrição e tags
      </button>

      {youtube && (
        <div className="yt-box">
          <label className="field compact">
            <span>Títulos</span>
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
              void copyText(
                youtube.selectedTitle ?? youtube.titles[0] ?? "",
              ).then(() => setCopied("título"))
            }
          >
            Copiar título
          </button>

          <label className="field compact">
            <span>Descrição</span>
            <textarea
              rows={4}
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
              void copyText(youtube.description).then(() =>
                setCopied("descrição"),
              )
            }
          >
            Copiar descrição
          </button>

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
              void copyText(youtube.tags.join(", ")).then(() =>
                setCopied("tags"),
              )
            }
          >
            Copiar tags
          </button>
          {copied && <p className="hint">Copiado: {copied}</p>}
        </div>
      )}

      <h2>Exportar</h2>
      <p className="hint">
        Escolha resolução, FPS, formato, qualidade e enquadramento vertical.
      </p>
      <button
        type="button"
        className="cta"
        onClick={() => onOpenExport?.()}
      >
        Abrir exportação…
      </button>

      {busy && <p className="progress-label">{busy}…</p>}
      {error && <p className="error">{error}</p>}
    </aside>
  );
}
