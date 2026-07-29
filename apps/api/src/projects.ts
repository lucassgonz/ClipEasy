import { mkdir } from "node:fs/promises";
import {
  emptyTimeline,
  recomputeDuration,
  type Timeline,
} from "@clipfacil/pipeline";
import { getEnv, userClient } from "./auth.js";
import { projectDir } from "./paths.js";

export type ProjectKind = "video" | "image";

export interface YoutubeMeta {
  titles: string[];
  selectedTitle?: string;
  description: string;
  hashtags: string[];
  tags: string[];
}

export interface ProjectMetadata {
  youtube?: YoutubeMeta;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  title: string;
  kind: ProjectKind;
  duration_ms: number;
  timeline: Timeline;
  metadata: ProjectMetadata;
  created_at: string;
  updated_at: string;
}

const memoryProjects = new Map<string, ProjectRow>();

function useMemory(): boolean {
  return getEnv("DEV_AUTH_BYPASS") === "1" || !getEnv("SUPABASE_URL");
}

function normalizeRow(row: ProjectRow): ProjectRow {
  return {
    ...row,
    kind: row.kind === "image" ? "image" : "video",
    metadata: row.metadata ?? {},
    timeline: row.timeline ?? emptyTimeline(),
  };
}

export async function listProjects(
  token: string,
  userId: string,
): Promise<ProjectRow[]> {
  if (useMemory()) {
    return [...memoryProjects.values()]
      .filter((p) => p.user_id === userId)
      .map(normalizeRow)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  const sb = userClient(token);
  const { data, error } = await sb
    .from("projects")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ProjectRow[]).map(normalizeRow);
}

export async function getProject(
  token: string,
  userId: string,
  id: string,
): Promise<ProjectRow | null> {
  if (useMemory()) {
    const p = memoryProjects.get(id);
    if (!p || p.user_id !== userId) return null;
    return normalizeRow(p);
  }
  const sb = userClient(token);
  const { data, error } = await sb
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.user_id !== userId) return null;
  return normalizeRow(data as ProjectRow);
}

export async function createProject(
  token: string,
  userId: string,
  title: string,
  kind: ProjectKind = "video",
): Promise<ProjectRow> {
  const timeline = emptyTimeline();
  const now = new Date().toISOString();
  const projectKind: ProjectKind = kind === "image" ? "image" : "video";

  if (useMemory()) {
    const id = crypto.randomUUID();
    const row: ProjectRow = {
      id,
      user_id: userId,
      title: title || "Sem título",
      kind: projectKind,
      duration_ms: 0,
      timeline,
      metadata: {},
      created_at: now,
      updated_at: now,
    };
    memoryProjects.set(id, row);
    await mkdir(projectDir(id), { recursive: true });
    return row;
  }

  const sb = userClient(token);
  const { data, error } = await sb
    .from("projects")
    .insert({
      user_id: userId,
      title: title || "Sem título",
      kind: projectKind,
      duration_ms: 0,
      timeline,
      metadata: {},
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  await mkdir(projectDir(data.id), { recursive: true });
  return normalizeRow(data as ProjectRow);
}

export async function updateProject(
  token: string,
  userId: string,
  id: string,
  patch: {
    title?: string;
    timeline?: Timeline;
    metadata?: ProjectMetadata;
  },
): Promise<ProjectRow> {
  const existing = await getProject(token, userId, id);
  if (!existing) {
    const err = new Error("Projeto não encontrado");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }

  const timeline = patch.timeline
    ? {
        ...patch.timeline,
        durationMs: recomputeDuration(patch.timeline),
      }
    : existing.timeline;

  const duration_ms = Math.round(
    timeline.durationMs ?? recomputeDuration(timeline),
  );
  const title = patch.title ?? existing.title;
  const metadata = patch.metadata ?? existing.metadata ?? {};
  const now = new Date().toISOString();

  if (useMemory()) {
    const row: ProjectRow = {
      ...existing,
      title,
      timeline,
      metadata,
      duration_ms,
      updated_at: now,
    };
    memoryProjects.set(id, row);
    return row;
  }

  const sb = userClient(token);
  const { data, error } = await sb
    .from("projects")
    .update({ title, timeline, duration_ms, metadata })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return normalizeRow(data as ProjectRow);
}

export async function deleteProject(
  token: string,
  userId: string,
  id: string,
): Promise<void> {
  const existing = await getProject(token, userId, id);
  if (!existing) {
    const err = new Error("Projeto não encontrado");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }
  if (useMemory()) {
    memoryProjects.delete(id);
    return;
  }
  const sb = userClient(token);
  const { error } = await sb.from("projects").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
