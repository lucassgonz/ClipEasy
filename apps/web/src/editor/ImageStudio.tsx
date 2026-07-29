import { useEffect, useMemo, useRef, useState } from "react";
import {
  exportFileUrl,
  exportImageProject,
  getProject,
  mediaUrl,
  saveProject,
  uploadImage,
} from "../api";
import { getSession } from "../lib/supabase";
import type { ImageStudioState, Project, Resolution } from "../types";

function centerCrop(
  srcW: number,
  srcH: number,
  aspect: "16:9" | "9:16",
): ImageStudioState["crop"] {
  const target = aspect === "16:9" ? 16 / 9 : 9 / 16;
  const src = srcW / srcH;
  let w: number;
  let h: number;
  if (src > target) {
    h = 1;
    w = (target * srcH) / srcW;
  } else {
    w = 1;
    h = srcW / target / srcH;
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

export function ImageStudio({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    void getProject(projectId)
      .then(setProject)
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  const studio = project?.timeline.imageStudio;
  const asset = studio
    ? project?.timeline.assets[studio.assetId]
    : undefined;

  useEffect(() => {
    if (!studio?.assetId || !project) {
      setBlobUrl(null);
      return;
    }
    let revoked: string | null = null;
    void (async () => {
      const session = await getSession();
      const res = await fetch(mediaUrl(project.id, studio.assetId), {
        headers: session?.access_token
          ? { Authorization: `Bearer ${session.access_token}` }
          : {},
      });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      revoked = url;
      setBlobUrl(url);
    })();
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [studio?.assetId, project?.id]);

  async function persistStudio(next: ImageStudioState) {
    if (!project) return;
    const timeline = {
      ...project.timeline,
      imageStudio: next,
    };
    const updated = { ...project, timeline };
    setProject(updated);
    await saveProject(project.id, { timeline });
  }

  function setAspect(aspect: "16:9" | "9:16") {
    if (!studio || !asset?.width || !asset.height) return;
    void persistStudio({
      ...studio,
      aspect,
      crop: centerCrop(asset.width, asset.height, aspect),
    });
  }

  const cropStyle = useMemo(() => {
    if (!studio) return {};
    return {
      left: `${studio.crop.x * 100}%`,
      top: `${studio.crop.y * 100}%`,
      width: `${studio.crop.w * 100}%`,
      height: `${studio.crop.h * 100}%`,
    };
  }, [studio]);

  return (
    <div className="editor-page">
      <header className="editor-top">
        <button type="button" className="ghost" onClick={onBack}>
          ← Projetos
        </button>
        <div className="editor-title">
          <span className="brand-mini">clipEasy</span>
          <input
            className="title-input"
            value={project?.title ?? ""}
            onChange={(e) => {
              if (!project) return;
              const next = { ...project, title: e.target.value };
              setProject(next);
              void saveProject(project.id, { title: e.target.value });
            }}
          />
        </div>
      </header>

      <div className="editor-grid">
        <div className="editor-main">
          <div className="preview">
            <div className="preview-stage image-stage">
              {blobUrl ? (
                <div className="image-crop-wrap">
                  <img src={blobUrl} alt="Fonte" className="image-src" />
                  {studio && (
                    <div
                      className="crop-rect"
                      style={cropStyle}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        drag.current = { x: e.clientX, y: e.clientY };
                      }}
                      onPointerMove={(e) => {
                        if (!drag.current || !studio || !asset?.width || !asset.height)
                          return;
                        const wrap = e.currentTarget.parentElement;
                        if (!wrap) return;
                        const rect = wrap.getBoundingClientRect();
                        const dx = (e.clientX - drag.current.x) / rect.width;
                        const dy = (e.clientY - drag.current.y) / rect.height;
                        drag.current = { x: e.clientX, y: e.clientY };
                        const crop = {
                          ...studio.crop,
                          x: Math.min(
                            1 - studio.crop.w,
                            Math.max(0, studio.crop.x + dx),
                          ),
                          y: Math.min(
                            1 - studio.crop.h,
                            Math.max(0, studio.crop.y + dy),
                          ),
                        };
                        setProject({
                          ...project!,
                          timeline: {
                            ...project!.timeline,
                            imageStudio: { ...studio, crop },
                          },
                        });
                      }}
                      onPointerUp={() => {
                        drag.current = null;
                        if (project?.timeline.imageStudio) {
                          void persistStudio(project.timeline.imageStudio);
                        }
                      }}
                    />
                  )}
                </div>
              ) : (
                <div className="preview-empty">Envie uma foto para começar</div>
              )}
            </div>
          </div>
        </div>

        <aside className="side-panel">
          <h2>Importar foto</h2>
          <div className="field">
            <span>Arquivo</span>
            <label className="file-pick">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file || !project) return;
                  setFileName(file.name);
                  setBusy("Upload");
                  setError(null);
                  void uploadImage(project.id, file)
                    .then(setProject)
                    .catch((err: Error) => setError(err.message))
                    .finally(() => setBusy(null));
                }}
              />
              <span className="file-pick-btn">Escolher arquivo</span>
              <span className="file-pick-name">
                {fileName ?? "Nenhum arquivo selecionado"}
              </span>
            </label>
          </div>

          <h2>Proporção</h2>
          <div className="segmented">
            <button
              type="button"
              className={studio?.aspect === "9:16" ? "active" : ""}
              disabled={!studio}
              onClick={() => setAspect("9:16")}
            >
              9:16 vertical
            </button>
            <button
              type="button"
              className={studio?.aspect === "16:9" ? "active" : ""}
              disabled={!studio}
              onClick={() => setAspect("16:9")}
            >
              16:9 horizontal
            </button>
          </div>
          <p className="hint">Arraste o retângulo no preview para reposicionar o crop (padrão: centro).</p>

          <label className="field compact">
            <span>Resolução</span>
            <select
              value={studio?.resolution ?? "1080p"}
              disabled={!studio}
              onChange={(e) => {
                if (!studio) return;
                void persistStudio({
                  ...studio,
                  resolution: e.target.value as Resolution,
                });
              }}
            >
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
              <option value="1440p">1440p</option>
              <option value="2160p">4K (2160p)</option>
            </select>
          </label>

          <label className="field compact">
            <span>Brilho ({studio?.brightness ?? 0})</span>
            <input
              type="range"
              min={-0.3}
              max={0.3}
              step={0.01}
              disabled={!studio}
              value={studio?.brightness ?? 0}
              onChange={(e) => {
                if (!studio) return;
                const brightness = Number(e.target.value);
                setProject({
                  ...project!,
                  timeline: {
                    ...project!.timeline,
                    imageStudio: { ...studio, brightness },
                  },
                });
              }}
              onPointerUp={() => {
                if (project?.timeline.imageStudio) {
                  void persistStudio(project.timeline.imageStudio);
                }
              }}
            />
          </label>

          <label className="field compact">
            <span>Contraste ({(studio?.contrast ?? 1).toFixed(2)})</span>
            <input
              type="range"
              min={0.7}
              max={1.4}
              step={0.01}
              disabled={!studio}
              value={studio?.contrast ?? 1}
              onChange={(e) => {
                if (!studio) return;
                const contrast = Number(e.target.value);
                setProject({
                  ...project!,
                  timeline: {
                    ...project!.timeline,
                    imageStudio: { ...studio, contrast },
                  },
                });
              }}
              onPointerUp={() => {
                if (project?.timeline.imageStudio) {
                  void persistStudio(project.timeline.imageStudio);
                }
              }}
            />
          </label>

          <button
            type="button"
            className="cta"
            disabled={!studio || Boolean(busy)}
            onClick={() => {
              if (!studio || !project) return;
              setBusy("Export");
              setError(null);
              void exportImageProject(project.id, studio)
                .then(async (out) => {
                  setExportUrl(out.url);
                  const session = await getSession();
                  const res = await fetch(exportFileUrl(out.url), {
                    headers: session?.access_token
                      ? { Authorization: `Bearer ${session.access_token}` }
                      : {},
                  });
                  const blob = await res.blob();
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = out.name;
                  a.click();
                  URL.revokeObjectURL(a.href);
                })
                .catch((err: Error) => setError(err.message))
                .finally(() => setBusy(null));
            }}
          >
            Exportar imagem
          </button>

          {busy && <p className="progress-label">{busy}…</p>}
          {error && <p className="error">{error}</p>}
          {exportUrl && <p className="hint">Exportação concluída.</p>}
        </aside>
      </div>
    </div>
  );
}
