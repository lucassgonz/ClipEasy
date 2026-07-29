import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { BinaryStatus, HealthReport } from "./types.js";

const execFileAsync = promisify(execFile);

const activeChildren = new Set<ChildProcess>();

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [cmd]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function versionLine(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 10_000 });
    return `${stdout}\n${stderr}`.trim().split("\n")[0]?.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.split("\n")[0]?.trim();
  }
}

export async function checkBinaries(): Promise<HealthReport> {
  const entries = [
    { name: "ffmpeg", args: ["-version"], hint: "brew install ffmpeg" },
    { name: "ffprobe", args: ["-version"], hint: "brew install ffmpeg" },
    { name: "yt-dlp", args: ["--version"], hint: "brew install yt-dlp" },
  ] as const;

  const binaries: BinaryStatus[] = [];
  for (const entry of entries) {
    const path = await which(entry.name);
    binaries.push({
      name: entry.name,
      available: Boolean(path),
      path: path ?? undefined,
      version: path ? await versionLine(entry.name, [...entry.args]) : undefined,
      installHint: entry.hint,
    });
  }

  return {
    ok: binaries.every((b) => b.available),
    binaries,
  };
}

export function runCommand(
  cmd: string,
  args: string[],
  onStderr?: (chunk: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const STDERR_CAP = 64_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    const cleanup = () => {
      activeChildren.delete(child);
    };
    child.stdout.on("data", (buf: Buffer) => {
      stdout += buf.toString();
      if (stdout.length > STDERR_CAP) stdout = stdout.slice(-STDERR_CAP);
    });
    child.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
      onStderr?.(text);
    });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Kill ffmpeg/ffprobe/etc. spawned by the pipeline (used when a job is cancelled). */
export function killActiveCommands(): void {
  for (const child of [...activeChildren]) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    activeChildren.delete(child);
  }
}

export async function mustRun(
  cmd: string,
  args: string[],
  onStderr?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runCommand(cmd, args, onStderr);
  if (result.code !== 0) {
    throw new Error(`${cmd} falhou: ${result.stderr || result.stdout}`);
  }
  return result;
}

export async function probeDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await mustRun("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const value = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Não foi possível ler a duração do vídeo");
  }
  return value;
}

export async function probeImageSize(
  filePath: string,
): Promise<{ width: number; height: number }> {
  const { stdout } = await mustRun("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=s=x:p=0",
    filePath,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number);
  if (!w || !h) {
    throw new Error("Não foi possível ler as dimensões da imagem");
  }
  return { width: w, height: h };
}
