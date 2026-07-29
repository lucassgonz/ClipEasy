import { useEffect, useRef, useState } from "react";
import {
  generateCaptions,
  importYoutube,
  recipeSplit,
  recipeSilence,
  uploadAsset,
  suggestYoutube,
  saveProject,
  startChunkExport,
  fetchExportJob,
  exportFileUrl,
  getProject,
  startClipMetaGenerate,
} from "../api";
import { getSession } from "../lib/supabase";
import type { ClipYoutubeMeta, ExportJob, Project, YoutubeMeta } from "../types";
import { StatusPopup, type StatusPopupState } from "./StatusPopup";

async function downloadAuthed(urlPath: string, filename: string) {
  const session = await getSession();
  const res = await fetch(exportFileUrl(urlPath), {
    headers: session?.access_token
      ? { Authorization: `Bearer ${session.access_token}` }
      : {},
  });
  if (!res.ok) {
    let detail = "Falha no download";
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
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
  onOpenExport,
  selectedClipId = null,
}: {
  project: Project;
  onProject: (p: Project) => void;
  onOpenExport?: () => void;
  selectedClipId?: string | null;
}) {
  const [url, setUrl] = useState("");
  const [splitSec, setSplitSec] = useState(60);
  const [status, setStatus] = useState<StatusPopupState | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [chunkJob, setChunkJob] = useState<ExportJob | null>(null);
  const [metaClipId, setMetaClipId] = useState<string>("");
  const pendingExport = useRef<ExportJob | null>(null);

  const youtube = project.metadata?.youtube;
  const clipMeta = project.metadata?.clipMeta ?? [];
  const videoTrack = project.timeline.tracks.find((t) => t.type === "video");
  const videoClipCount =
    videoTrack && videoTrack.type === "video" ? videoTrack.clips.length : 0;
  const alreadyDivided = videoClipCount >= 2;
  const busy = status?.kind === "processing";

  useEffect(() => {
    if (selectedClipId && clipMeta.some((m) => m.clipId === selectedClipId)) {
      setMetaClipId(selectedClipId);
      return;
    }
    if (!metaClipId && clipMeta[0]) setMetaClipId(clipMeta[0].clipId);
  }, [selectedClipId, clipMeta, metaClipId]);

  const activeMeta: ClipYoutubeMeta | null =
    clipMeta.find((m) => m.clipId === metaClipId) ?? clipMeta[0] ?? null;

  async function run(
    title: string,
    fn: (update: (message: string) => void) => Promise<string | void>,
  ) {
    setStatus({
      kind: "processing",
      title,
      message: "Iniciando…",
    });
    try {
      const message = await fn((msg) => {
        setStatus((prev) =>
          prev?.kind === "processing" ? { ...prev, message: msg } : prev,
        );
      });
      setStatus({
        kind: "success",
        title: "Concluído",
        message: message || `${title} finalizado com sucesso.`,
      });
    } catch (err) {
      setStatus({
        kind: "error",
        title: "Algo deu errado",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function pollChunkJob(
    jobId: string,
    update: (message: string) => void,
  ): Promise<ExportJob> {
    for (;;) {
      const job = await fetchExportJob(jobId);
      setChunkJob(job);
      update(`${job.progress.step} — ${job.progress.percent}%`);
      if (job.status === "done") {
        if (job.error) throw new Error(job.error);
        return job;
      }
      if (job.status === "error") {
        throw new Error(job.error || "Falha ao exportar clipes");
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  function zipUrlOf(job: ExportJob): string {
    return (
      job.zipUrl ?? job.outputs[0]!.url.replace(/\/[^/]+$/, "/zip")
    );
  }

  async function exportClipsThenAsk(opts: {
    exportExistingClips?: boolean;
    everySeconds?: number;
    applyToTimeline?: boolean;
    title: string;
  }) {
    setStatus({
      kind: "processing",
      title: opts.title,
      message: "Preparando exportação…",
    });
    pendingExport.current = null;
    try {
      setChunkJob(null);
      const jobId = await startChunkExport(project.id, {
        everySeconds: opts.everySeconds ?? splitSec,
        applyToTimeline: opts.applyToTimeline,
        exportExistingClips: opts.exportExistingClips,
      });
      if (opts.applyToTimeline) {
        onProject(await getProject(project.id));
      }
      const job = await pollChunkJob(jobId, (msg) => {
        setStatus((prev) =>
          prev?.kind === "processing" ? { ...prev, message: msg } : prev,
        );
      });
      pendingExport.current = job;
      setStatus({
        kind: "confirm",
        title: "Sugestões de postagem",
        message:
          "Você deseja sugestões para postagem dos vídeos? (YouTube, TikTok e Instagram)",
        yesLabel: "Sim",
        noLabel: "Não",
      });
    } catch (err) {
      pendingExport.current = null;
      setStatus({
        kind: "error",
        title: "Algo deu errado",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function finishExportWithoutSuggestions() {
    const job = pendingExport.current;
    pendingExport.current = null;
    if (!job || job.outputs.length === 0) {
      setStatus(null);
      return;
    }
    await run("Baixar vídeos", async (update) => {
      update(`Compactando ${job.outputs.length} vídeos…`);
      await downloadAuthed(zipUrlOf(job), "clipEasy-clipes.zip");
      return `ZIP com ${job.outputs.length} vídeo(s) baixado.`;
    });
  }

  async function finishExportWithSuggestions() {
    const job = pendingExport.current;
    pendingExport.current = null;
    if (!job || job.outputs.length === 0) {
      setStatus(null);
      return;
    }
    setStatus({
      kind: "processing",
      title: "Sugestões + download",
      message: "Baixando vídeos…",
    });
    try {
      await downloadAuthed(zipUrlOf(job), "clipEasy-clipes.zip");
      setStatus((prev) =>
        prev?.kind === "processing"
          ? { ...prev, message: "Gerando sugestões com IA…" }
          : prev,
      );
      const metaJobId = await startClipMetaGenerate(project.id);
      for (;;) {
        const metaJob = await fetchExportJob(metaJobId);
        setStatus((prev) =>
          prev?.kind === "processing"
            ? {
                ...prev,
                message: `${metaJob.progress.step} — ${metaJob.progress.percent}%`,
              }
            : prev,
        );
        if (metaJob.status === "done") {
          if (metaJob.error) throw new Error(metaJob.error);
          break;
        }
        if (metaJob.status === "error") {
          throw new Error(metaJob.error || "Falha ao gerar sugestões");
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      const next = await getProject(project.id);
      onProject(next);
      if (next.metadata?.clipMeta?.[0]) {
        setMetaClipId(next.metadata.clipMeta[0].clipId);
      }
      setStatus((prev) =>
        prev?.kind === "processing"
          ? { ...prev, message: "Baixando TXT de sugestões…" }
          : prev,
      );
      await downloadAuthed(
        `/projects/${project.id}/clips/meta.txt`,
        "clipEasy-sugestoes-postagem.txt",
      );
      const n = next.metadata?.clipMeta?.length ?? 0;
      setStatus({
        kind: "success",
        title: "Concluído",
        message: `ZIP com ${job.outputs.length} vídeo(s) e TXT com ${n} sugestão(ões) para YouTube/TikTok/Instagram.`,
      });
    } catch (err) {
      setStatus({
        kind: "error",
        title: "Algo deu errado",
        message: err instanceof Error ? err.message : String(err),
      });
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

  function patchActiveMeta(patch: Partial<ClipYoutubeMeta>) {
    if (!activeMeta) return;
    const nextList = clipMeta.map((m) =>
      m.clipId === activeMeta.clipId ? { ...m, ...patch } : m,
    );
    const updated = {
      ...project,
      metadata: { ...project.metadata, clipMeta: nextList },
    };
    onProject(updated);
    void saveProject(project.id, { metadata: updated.metadata });
  }

  return (
    <aside className="side-panel">
      <StatusPopup
        status={status}
        onClose={() => setStatus(null)}
        onYes={() => void finishExportWithSuggestions()}
        onNo={() => void finishExportWithoutSuggestions()}
      />

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
        disabled={busy}
        onClick={() =>
          void run("Baixar do YouTube", async (update) => {
            update("Baixando e importando o vídeo…");
            onProject(await importYoutube(project.id, url.trim()));
            setUrl("");
            return "Vídeo do YouTube adicionado à timeline.";
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
              void run("Enviar arquivo", async (update) => {
                update(`Enviando ${file.name}…`);
                onProject(await uploadAsset(project.id, file));
                return `${file.name} adicionado à timeline.`;
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

      {alreadyDivided ? (
        <>
          <p className="hint">
            Timeline com {videoClipCount} clipes. Exporte todos de uma vez.
          </p>
          <button
            type="button"
            className="cta small"
            disabled={busy}
            onClick={() =>
              void exportClipsThenAsk({
                title: "Exportar clipes",
                exportExistingClips: true,
                applyToTimeline: false,
              })
            }
          >
            Exportar todos os clipes
          </button>
          <details className="recipe-more">
            <summary>Dividir de novo</summary>
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
              disabled={busy}
              onClick={() =>
                void run("Dividir timeline", async (update) => {
                  update(`Dividindo a cada ${splitSec}s…`);
                  onProject(await recipeSplit(project.id, splitSec));
                  return `Timeline dividida a cada ${splitSec}s.`;
                })
              }
            >
              Aplicar divisão na timeline
            </button>
          </details>
        </>
      ) : (
        <>
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
            disabled={busy}
            onClick={() =>
              void run("Dividir timeline", async (update) => {
                update(`Dividindo a cada ${splitSec}s…`);
                onProject(await recipeSplit(project.id, splitSec));
                return `Timeline dividida a cada ${splitSec}s.`;
              })
            }
          >
            Aplicar divisão na timeline
          </button>
          <button
            type="button"
            className="cta small"
            disabled={busy}
            onClick={() =>
              void exportClipsThenAsk({
                title: "Dividir e exportar",
                everySeconds: splitSec,
                applyToTimeline: true,
              })
            }
          >
            Dividir e exportar pedaços
          </button>
          <p className="hint">
            Corta o vídeo em arquivos de {splitSec}s e pergunta se deseja
            sugestões de postagem ao terminar.
          </p>
        </>
      )}

      {chunkJob && chunkJob.outputs.length > 0 && (
        <div className="export-box">
          <p>Última exportação — {chunkJob.outputs.length} arquivo(s)</p>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run("Baixar ZIP", async (update) => {
                update(`Compactando ${chunkJob.outputs.length} arquivos…`);
                await downloadAuthed(zipUrlOf(chunkJob), "clipEasy-clipes.zip");
                return `ZIP com ${chunkJob.outputs.length} vídeo(s) baixado.`;
              })
            }
          >
            Baixar ZIP novamente
          </button>
        </div>
      )}

      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() =>
          void run("Cortar silêncios", async (update) => {
            update("Detectando e removendo pausas longas…");
            const { project: next, result } = await recipeSilence(project.id);
            onProject(next);
            return result.message;
          })
        }
      >
        Cortar silêncios (1º clipe)
      </button>
      <p className="hint">
        Analisa o 1º clipe e remove pausas longas. Pode demorar em vídeos
        longos.
      </p>

      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() =>
          void run("Gerar legendas", async (update) => {
            update("Transcrevendo áudio com Whisper…");
            onProject(await generateCaptions(project.id));
            return "Legendas geradas e adicionadas à timeline.";
          })
        }
      >
        Gerar legendas (Whisper)
      </button>

      <h2>Para o YouTube</h2>
      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() =>
          void run("Sugestões YouTube", async (update) => {
            update("Gerando título, descrição e tags…");
            const result = await suggestYoutube(project.id);
            onProject(result.project);
            return "Sugestões de título, descrição e tags prontas.";
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

          <label className="field compact">
            <span>Hashtags</span>
            <input
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
            <input
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

      <h3 className="side-subhead">Sugestões de postagem</h3>
      <p className="hint">
        Após exportar os clipes, você pode gerar título, descrição e hashtags
        para YouTube, TikTok e Instagram. Também é possível regenerar aqui.
      </p>
      <button
        type="button"
        className="ghost"
        disabled={busy || !alreadyDivided}
        onClick={() =>
          void run("Sugestões por clipe", async (update) => {
            update("Gerando sugestões com IA…");
            const jobId = await startClipMetaGenerate(project.id);
            for (;;) {
              const job = await fetchExportJob(jobId);
              update(`${job.progress.step} — ${job.progress.percent}%`);
              if (job.status === "done") {
                if (job.error) throw new Error(job.error);
                const next = await getProject(project.id);
                onProject(next);
                const n = next.metadata?.clipMeta?.length ?? 0;
                if (next.metadata?.clipMeta?.[0]) {
                  setMetaClipId(next.metadata.clipMeta[0].clipId);
                }
                return `Sugestões geradas para ${n} clipe(s).`;
              }
              if (job.status === "error") {
                throw new Error(job.error || "Falha ao gerar sugestões");
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
          })
        }
      >
        Gerar / regenerar sugestões (IA)
      </button>

      {clipMeta.length > 0 && activeMeta && (
        <div className="yt-box clip-meta-box">
          <label className="field compact">
            <span>Clipe</span>
            <select
              value={activeMeta.clipId}
              onChange={(e) => setMetaClipId(e.target.value)}
            >
              {clipMeta.map((m) => (
                <option key={m.clipId} value={m.clipId}>
                  {m.filename}
                </option>
              ))}
            </select>
          </label>

          <label className="field compact">
            <span>Arquivo</span>
            <input value={activeMeta.filename} readOnly />
          </label>

          <label className="field compact">
            <span>Título</span>
            <input
              value={activeMeta.title}
              onChange={(e) => patchActiveMeta({ title: e.target.value })}
            />
          </label>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void copyText(activeMeta.title).then(() => setCopied("título"))
            }
          >
            Copiar título
          </button>

          <label className="field compact">
            <span>Descrição</span>
            <textarea
              rows={4}
              value={activeMeta.description}
              onChange={(e) =>
                patchActiveMeta({ description: e.target.value })
              }
            />
          </label>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void copyText(activeMeta.description).then(() =>
                setCopied("descrição"),
              )
            }
          >
            Copiar descrição
          </button>

          <label className="field compact">
            <span>Hashtags</span>
            <input
              value={activeMeta.hashtags.join(" ")}
              onChange={(e) =>
                patchActiveMeta({
                  hashtags: e.target.value.split(/\s+/).filter(Boolean),
                })
              }
            />
          </label>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void copyText(activeMeta.hashtags.join(" ")).then(() =>
                setCopied("hashtags"),
              )
            }
          >
            Copiar hashtags
          </button>

          <button
            type="button"
            className="cta small"
            disabled={busy}
            onClick={() =>
              void run("Baixar TXT", async (update) => {
                update("Baixando metadados…");
                await downloadAuthed(
                  `/projects/${project.id}/clips/meta.txt`,
                  "clipEasy-metadados.txt",
                );
                return `TXT com ${clipMeta.length} clipe(s) baixado.`;
              })
            }
          >
            Baixar TXT de todos
          </button>
          {copied && <p className="hint">Copiado: {copied}</p>}
        </div>
      )}

      <h2>Exportar</h2>
      <p className="hint">
        Escolha resolução, FPS, formato, qualidade e enquadramento vertical.
      </p>
      <button type="button" className="cta" onClick={() => onOpenExport?.()}>
        Abrir exportação…
      </button>
    </aside>
  );
}
