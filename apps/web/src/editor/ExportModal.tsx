import { useEffect, useRef, useState } from "react";
import {
  cancelExportJob,
  exportFileUrl,
  fetchExportJob,
  startExport,
} from "../api";
import { getSession } from "../lib/supabase";
import type {
  ExportFormat,
  ExportJob,
  ExportOptions,
  ExportQuality,
  Resolution,
} from "../types";
import { StatusPopup, type StatusPopupState } from "./StatusPopup";

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

export function ExportModal({
  projectId,
  defaultFps,
  open,
  onClose,
  onPreviewVertical,
  initialVerticalMode = "crop",
  initialCropFocusX = 0.5,
  framingMode = "manual",
  cropFocusTrack,
  captionStyle = "pop",
  captionAvoidFaces = true,
  captionAnchorTrack,
}: {
  projectId: string;
  defaultFps: number;
  open: boolean;
  onClose: () => void;
  onPreviewVertical?: (opts: {
    mode: "crop" | "blur";
    cropFocusX: number;
    framingMode?: "manual" | "auto";
  }) => void;
  initialVerticalMode?: "crop" | "blur";
  initialCropFocusX?: number;
  framingMode?: "manual" | "auto";
  cropFocusTrack?: ExportOptions["cropFocusTrack"];
  captionStyle?: ExportOptions["captionStyle"];
  captionAvoidFaces?: boolean;
  captionAnchorTrack?: ExportOptions["captionAnchorTrack"];
}) {
  const [outputs, setOutputs] = useState<"both" | "h" | "v">("both");
  const [verticalMode, setVerticalMode] = useState<"crop" | "blur">(
    initialVerticalMode,
  );
  const [cropPreset, setCropPreset] = useState<"left" | "center" | "right" | "custom">(
    () =>
      initialCropFocusX <= 0.05
        ? "left"
        : initialCropFocusX >= 0.95
          ? "right"
          : Math.abs(initialCropFocusX - 0.5) < 0.05
            ? "center"
            : "custom",
  );
  const [cropFocusX, setCropFocusX] = useState(initialCropFocusX);
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [fps, setFps] = useState(defaultFps || 30);
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [quality, setQuality] = useState<ExportQuality>("high");
  const [audioBitrate, setAudioBitrate] = useState<"128k" | "192k" | "320k">(
    "192k",
  );
  const [burnCaptions, setBurnCaptions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusPopupState | null>(null);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const activeJobId = useRef<string | null>(null);
  const cancelRequested = useRef(false);

  useEffect(() => {
    if (!open) return;
    setVerticalMode(initialVerticalMode);
    setCropFocusX(initialCropFocusX);
    setCropPreset(
      initialCropFocusX <= 0.05
        ? "left"
        : initialCropFocusX >= 0.95
          ? "right"
          : Math.abs(initialCropFocusX - 0.5) < 0.05
            ? "center"
            : "custom",
    );
  }, [open, initialVerticalMode, initialCropFocusX]);

  useEffect(() => {
    if (!open) return;
    if (outputs === "h") return;
    const focus =
      cropPreset === "left"
        ? 0
        : cropPreset === "right"
          ? 1
          : cropPreset === "center"
            ? 0.5
            : cropFocusX;
    onPreviewVertical?.({ mode: verticalMode, cropFocusX: focus });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, outputs, verticalMode, cropPreset, cropFocusX]);

  if (!open) return null;

  const focusX =
    cropPreset === "left"
      ? 0
      : cropPreset === "right"
        ? 1
        : cropPreset === "center"
          ? 0.5
          : cropFocusX;

  async function runExport() {
    setBusy(true);
    setJob(null);
    cancelRequested.current = false;
    setCancelling(false);
    activeJobId.current = null;
    setStatus({
      kind: "processing",
      title: "Exportando",
      message: "Preparando arquivos…",
      cancelLabel: "Cancelar",
    });
    try {
      const options: ExportOptions = {
        exportHorizontal: outputs === "both" || outputs === "h",
        exportVertical: outputs === "both" || outputs === "v",
        verticalMode,
        cropFocusX: focusX,
        cropFocusTrack:
          framingMode === "auto" && cropFocusTrack && cropFocusTrack.length > 0
            ? cropFocusTrack
            : undefined,
        resolution,
        fps,
        format,
        quality,
        audioBitrate,
        burnCaptions,
        captionStyle,
        captionAvoidFaces,
        captionAnchorTrack:
          captionAvoidFaces && captionAnchorTrack && captionAnchorTrack.length > 0
            ? captionAnchorTrack
            : undefined,
      };
      const jobId = await startExport(projectId, options);
      activeJobId.current = jobId;
      for (;;) {
        if (cancelRequested.current) {
          throw new Error("Cancelado pelo usuário");
        }
        const next = await fetchExportJob(jobId);
        setJob(next);
        if (next.status === "cancelled") {
          throw new Error(next.error || "Cancelado pelo usuário");
        }
        setStatus({
          kind: "processing",
          title: "Exportando",
          message: `${next.progress.step} — ${next.progress.percent}%`,
          cancelLabel: "Cancelar",
        });
        if (next.status === "done") {
          if (next.error) throw new Error(next.error);
          setStatus({
            kind: "success",
            title: "Exportação concluída",
            message: `${next.outputs.length} arquivo(s) prontos para download.`,
          });
          break;
        }
        if (next.status === "error") {
          throw new Error(next.error || "Falha na exportação");
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cancelled = /cancelad/i.test(msg);
      setStatus({
        kind: cancelled ? "success" : "error",
        title: cancelled ? "Exportação cancelada" : "Falha na exportação",
        message: cancelled ? "A exportação foi interrompida." : msg,
      });
      if (cancelled) setJob(null);
    } finally {
      activeJobId.current = null;
      cancelRequested.current = false;
      setCancelling(false);
      setBusy(false);
    }
  }

  async function handleCancelExport() {
    if (cancelRequested.current) return;
    cancelRequested.current = true;
    setCancelling(true);
    const jobId = activeJobId.current;
    setStatus({
      kind: "processing",
      title: "Cancelando…",
      message: "Interrompendo a exportação…",
    });
    if (jobId) {
      try {
        await cancelExportJob(jobId);
      } catch {
        // Client-side cancel still stops polling.
      }
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <StatusPopup
        status={status}
        onClose={() => setStatus(null)}
        onCancel={
          busy && status?.kind === "processing" && !cancelling
            ? () => void handleCancelExport()
            : undefined
        }
      />
      <div
        className="modal export-modal"
        role="dialog"
        aria-labelledby="export-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="export-title">Exportar vídeo</h2>
          <button type="button" className="ghost" onClick={onClose}>
            Fechar
          </button>
        </header>

        <div className="modal-body export-grid">
          <label className="field compact">
            <span>Saídas</span>
            <select
              value={outputs}
              onChange={(e) => setOutputs(e.target.value as "both" | "h" | "v")}
            >
              <option value="both">Horizontal + Vertical</option>
              <option value="h">Só horizontal 16:9</option>
              <option value="v">Só vertical 9:16</option>
            </select>
          </label>

          {(outputs === "both" || outputs === "v") && (
            <>
              <label className="field compact">
                <span>Enquadramento vertical</span>
                <select
                  value={verticalMode}
                  onChange={(e) =>
                    setVerticalMode(e.target.value as "crop" | "blur")
                  }
                >
                  <option value="crop">Recorte</option>
                  <option value="blur">Fundo desfocado</option>
                </select>
              </label>

              {verticalMode === "crop" && (
                <>
                  {framingMode === "auto" &&
                    cropFocusTrack &&
                    cropFocusTrack.length > 0 && (
                      <p className="hint">
                        Auto-enquadramento ativo ({cropFocusTrack.length}{" "}
                        pontos) — o export vertical acompanha os rostos.
                      </p>
                    )}
                  <label className="field compact">
                    <span>Posição do recorte</span>
                    <select
                      value={cropPreset}
                      onChange={(e) =>
                        setCropPreset(
                          e.target.value as "left" | "center" | "right" | "custom",
                        )
                      }
                    >
                      <option value="left">Esquerda</option>
                      <option value="center">Centro</option>
                      <option value="right">Direita</option>
                      <option value="custom">Personalizado</option>
                    </select>
                  </label>
                  {cropPreset === "custom" && (
                    <label className="field compact">
                      <span>Foco horizontal ({Math.round(cropFocusX * 100)}%)</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round(cropFocusX * 100)}
                        onChange={(e) =>
                          setCropFocusX(Number(e.target.value) / 100)
                        }
                      />
                    </label>
                  )}
                </>
              )}
            </>
          )}

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
            <span>FPS</span>
            <select
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
            >
              <option value={24}>24</option>
              <option value={25}>25</option>
              <option value={30}>30</option>
              <option value={60}>60</option>
            </select>
          </label>

          <label className="field compact">
            <span>Formato</span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              <option value="mp4">MP4 (H.264)</option>
              <option value="mov">MOV (H.264)</option>
            </select>
          </label>

          <label className="field compact">
            <span>Qualidade</span>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value as ExportQuality)}
            >
              <option value="low">Baixa (rápido)</option>
              <option value="medium">Média</option>
              <option value="high">Alta</option>
              <option value="max">Máxima</option>
            </select>
          </label>

          <label className="field compact">
            <span>Áudio</span>
            <select
              value={audioBitrate}
              onChange={(e) =>
                setAudioBitrate(e.target.value as "128k" | "192k" | "320k")
              }
            >
              <option value="128k">128 kbps</option>
              <option value="192k">192 kbps</option>
              <option value="320k">320 kbps</option>
            </select>
          </label>

          <label className="field compact check-row">
            <input
              type="checkbox"
              checked={burnCaptions}
              onChange={(e) => setBurnCaptions(e.target.checked)}
            />
            <span>Gravar legendas no vídeo</span>
          </label>

          {burnCaptions && (
            <p className="hint">
              Estilo: {captionStyle}
              {captionAvoidFaces ? " · evita rostos" : ""}
              {" "}(ajuste no preview)
            </p>
          )}
        </div>

        {job && job.outputs.length > 0 && (
          <div className="export-box">
            <p>Downloads ({job.outputs.length} arquivos)</p>
            <button
              type="button"
              className="cta small"
              onClick={() => {
                void (async () => {
                  const zipUrl =
                    job.zipUrl ??
                    job.outputs[0]!.url.replace(/\/[^/]+$/, "/zip");
                  setStatus({
                    kind: "processing",
                    title: "Baixar todos",
                    message: `Compactando ${job.outputs.length} arquivos…`,
                  });
                  try {
                    await downloadAuthed(zipUrl, "clipEasy-export.zip");
                    setStatus({
                      kind: "success",
                      title: "Download concluído",
                      message: `ZIP com ${job.outputs.length} arquivo(s) baixado.`,
                    });
                  } catch (err) {
                    setStatus({
                      kind: "error",
                      title: "Falha no download",
                      message:
                        err instanceof Error ? err.message : String(err),
                    });
                  }
                })();
              }}
            >
              Baixar todos (.zip)
            </button>
            <ul>
              {job.outputs.map((o) => (
                <li key={o.name}>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      void (async () => {
                        setStatus({
                          kind: "processing",
                          title: "Download",
                          message: `Baixando ${o.label}…`,
                        });
                        try {
                          await downloadAuthed(o.url, o.name);
                          setStatus({
                            kind: "success",
                            title: "Download concluído",
                            message: `${o.label} baixado.`,
                          });
                        } catch (err) {
                          setStatus({
                            kind: "error",
                            title: "Falha no download",
                            message:
                              err instanceof Error
                                ? err.message
                                : String(err),
                          });
                        }
                      })();
                    }}
                  >
                    Baixar {o.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <footer className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="cta"
            disabled={busy}
            onClick={() => void runExport()}
          >
            Iniciar exportação
          </button>
        </footer>
      </div>
    </div>
  );
}
