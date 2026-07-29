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

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new Error(`Erro HTTP ${res.status} (resposta vazia)`);
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
    throw new Error(data.error || `Erro HTTP ${res.status}`);
  }
  return data;
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
  return parseJson(await fetch(`${API}/export-jobs/${jobId}`));
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
