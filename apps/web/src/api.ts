import type {
  ExportJob,
  ExportOptions,
  HealthReport,
  ImageStudioState,
  Project,
  ProjectKind,
  ProjectMetadata,
  Timeline,
  YoutubeMeta,
} from "./types";
import { getSession } from "./lib/supabase";

const API = "/api";

async function authHeaders(): Promise<HeadersInit> {
  const session = await getSession();
  const headers: Record<string, string> = {};
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === "TypeError" ||
    /failed to fetch|networkerror|load failed|econnrefused|err_empty|resposta vazia|502|503|504/.test(
      msg,
    )
  );
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    if (res.status === 404) {
      throw new Error(
        "Export interrompido (servidor reiniciou ou o job expirou). Inicie de novo.",
      );
    }
    if (!res.ok) {
      throw new Error(
        `Servidor indisponível (HTTP ${res.status}). Se estava exportando, tente de novo em alguns segundos.`,
      );
    }
    throw new Error("Resposta vazia do servidor");
  }
  let data: T & { error?: string };
  try {
    data = JSON.parse(text) as T & { error?: string };
  } catch {
    const snippet = text.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(
      `Resposta inválida do servidor (HTTP ${res.status}): ${snippet}`,
    );
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        data.error ||
          "Export interrompido (servidor reiniciou ou o job expirou). Inicie de novo.",
      );
    }
    throw new Error(data.error || `Erro HTTP ${res.status}`);
  }
  return data;
}

/** Fetch with retries for Vite proxy blips when the API restarts mid-export. */
async function fetchJsonWithRetry<T>(
  input: string,
  init?: RequestInit,
  opts?: { retries?: number; notFoundMessage?: string },
): Promise<T> {
  const retries = opts?.retries ?? 8;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetch(input, init);
      if (
        (res.status === 502 || res.status === 503 || res.status === 504) ||
        (res.status === 500 && !(await res.clone().text()).trim())
      ) {
        lastErr = new Error(`Servidor reiniciando (HTTP ${res.status})…`);
        await sleep(400 + attempt * 350);
        continue;
      }
      if (res.status === 404 && opts?.notFoundMessage) {
        throw new Error(opts.notFoundMessage);
      }
      return await parseJson<T>(res);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (
        /interrompido|não encontrado|expir|cancelad|falha ao/i.test(lastErr.message) &&
        !isTransientNetworkError(lastErr)
      ) {
        throw lastErr;
      }
      if (attempt < retries - 1 && isTransientNetworkError(lastErr)) {
        await sleep(400 + attempt * 350);
        continue;
      }
      // Also retry plain "Servidor indisponível" / empty 500 from parseJson
      if (
        attempt < retries - 1 &&
        /indisponível|reiniciando|resposta vazia|failed to fetch/i.test(
          lastErr.message,
        )
      ) {
        await sleep(400 + attempt * 350);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("Falha de rede ao falar com a API");
}

export async function fetchHealth(): Promise<HealthReport> {
  return parseJson(await fetch(`${API}/health`));
}

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(`${API}/projects`, { headers: await authHeaders() });
  const data = await parseJson<{ projects: Project[] }>(res);
  return data.projects;
}

export async function createProject(
  title: string,
  kind: ProjectKind = "video",
): Promise<Project> {
  const res = await fetch(`${API}/projects`, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, kind }),
  });
  return parseJson(res);
}

export async function getProject(id: string): Promise<Project> {
  const res = await fetch(`${API}/projects/${id}`, {
    headers: await authHeaders(),
  });
  return parseJson(res);
}

export async function saveProject(
  id: string,
  patch: {
    title?: string;
    timeline?: Timeline;
    metadata?: ProjectMetadata;
  },
): Promise<Project> {
  const res = await fetch(`${API}/projects/${id}`, {
    method: "PATCH",
    headers: {
      ...(await authHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  return parseJson(res);
}

export async function removeProject(id: string): Promise<void> {
  const res = await fetch(`${API}/projects/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  if (!res.ok && res.status !== 204) {
    await parseJson(res);
  }
}

export async function uploadAsset(
  projectId: string,
  file: File,
): Promise<Project> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API}/projects/${projectId}/assets`, {
    method: "POST",
    headers: await authHeaders(),
    body: form,
  });
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

export async function uploadImage(
  projectId: string,
  file: File,
): Promise<Project> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API}/projects/${projectId}/image`, {
    method: "POST",
    headers: await authHeaders(),
    body: form,
  });
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

export async function exportImageProject(
  projectId: string,
  studio: Partial<ImageStudioState>,
): Promise<{ name: string; url: string }> {
  const res = await fetch(`${API}/projects/${projectId}/image/export`, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(studio),
  });
  return parseJson(res);
}

export async function importYoutube(
  projectId: string,
  url: string,
): Promise<Project> {
  const res = await fetch(`${API}/projects/${projectId}/import-youtube`, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  });
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

export function mediaUrl(projectId: string, assetId: string): string {
  return `${API}/projects/${projectId}/assets/${assetId}/media`;
}

export async function generateCaptions(projectId: string): Promise<Project> {
  const res = await fetch(`${API}/projects/${projectId}/captions/generate`, {
    method: "POST",
    headers: await authHeaders(),
  });
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

export async function suggestYoutube(
  projectId: string,
): Promise<{ youtube: YoutubeMeta; project: Project }> {
  const res = await fetch(`${API}/projects/${projectId}/youtube/suggest`, {
    method: "POST",
    headers: await authHeaders(),
  });
  return parseJson(res);
}

export async function startClipMetaGenerate(projectId: string): Promise<string> {
  const res = await fetch(`${API}/projects/${projectId}/clips/meta/generate`, {
    method: "POST",
    headers: await authHeaders(),
  });
  const data = await parseJson<{ jobId: string }>(res);
  return data.jobId;
}

export function clipMetaTxtUrl(projectId: string): string {
  return `${API}/projects/${projectId}/clips/meta.txt`;
}

export async function startExport(
  projectId: string,
  options: ExportOptions,
): Promise<string> {
  const res = await fetch(`${API}/projects/${projectId}/export`, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options),
  });
  const data = await parseJson<{ jobId: string }>(res);
  return data.jobId;
}

export async function startChunkExport(
  projectId: string,
  options: ExportOptions & {
    everySeconds?: number;
    applyToTimeline?: boolean;
    exportExistingClips?: boolean;
  },
): Promise<string> {
  const res = await fetch(`${API}/projects/${projectId}/export/chunks`, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options),
  });
  const data = await parseJson<{ jobId: string }>(res);
  return data.jobId;
}

export async function fetchExportJob(jobId: string): Promise<ExportJob> {
  return fetchJsonWithRetry<ExportJob>(`${API}/export-jobs/${jobId}`, undefined, {
    retries: 10,
    notFoundMessage:
      "Export interrompido (servidor reiniciou ou o job expirou). Inicie de novo.",
  });
}

export async function cancelExportJob(jobId: string): Promise<void> {
  const res = await fetch(`${API}/export-jobs/${jobId}/cancel`, {
    method: "POST",
    headers: await authHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    await parseJson(res);
  }
}

export async function recipeSplit(
  projectId: string,
  everySeconds: number,
): Promise<Project> {
  const res = await fetch(`${API}/projects/${projectId}/recipes/split`, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ everySeconds }),
  });
  return parseJson(res);
}

export interface SilenceRecipeResult {
  changed: boolean;
  silenceCount: number;
  originalDurationMs: number;
  newDurationMs: number;
  message: string;
}

export async function recipeSilence(
  projectId: string,
): Promise<{ project: Project; result: SilenceRecipeResult }> {
  const res = await fetch(`${API}/projects/${projectId}/recipes/silence`, {
    method: "POST",
    headers: await authHeaders(),
  });
  return parseJson(res);
}

export function exportFileUrl(urlPath: string): string {
  return `${API}${urlPath}`;
}
