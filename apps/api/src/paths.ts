import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../../..");
export const DATA_DIR = path.join(ROOT, "data");
export const PROJECTS_DIR = path.join(DATA_DIR, "projects");

export function projectDir(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId);
}

export function assetsDir(projectId: string): string {
  return path.join(projectDir(projectId), "assets");
}

export function workDir(projectId: string): string {
  return path.join(projectDir(projectId), "work");
}

export function outputDir(projectId: string): string {
  return path.join(projectDir(projectId), "output");
}
