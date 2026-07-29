export type Resolution = "720p" | "1080p" | "1440p" | "2160p";
export type VerticalMode = "crop" | "blur";
export type ExportQuality = "low" | "medium" | "high" | "max";
export type ExportFormat = "mp4" | "mov";

export function qualitySettings(quality: ExportQuality = "high"): {
  crf: number;
  preset: string;
} {
  switch (quality) {
    case "low":
      return { crf: 28, preset: "veryfast" };
    case "medium":
      return { crf: 23, preset: "faster" };
    case "max":
      return { crf: 17, preset: "medium" };
    case "high":
    default:
      return { crf: 20, preset: "fast" };
  }
}

export interface JobOptions {
  trimStartSeconds?: number;
  cutStartSeconds?: number;
  trimEndSeconds?: number;
  cutEndSeconds?: number;
  keepFromSeconds?: number;
  keepToSeconds?: number;
  splitEverySeconds?: number;
  removeSilence?: boolean;
  silenceThresholdDb?: number;
  silenceMinDurationSeconds?: number;
  silenceMinDuration?: number;
  exportHorizontal?: boolean;
  exportVertical?: boolean;
  verticalMode?: VerticalMode;
  resolution?: Resolution;
}

export interface JobSourceYoutube {
  type: "youtube";
  url: string;
}

export interface JobSourceUpload {
  type: "upload";
  filename: string;
}

export type JobSource = JobSourceYoutube | JobSourceUpload;

export type JobStatus =
  | "queued"
  | "downloading"
  | "processing"
  | "done"
  | "error";

export interface JobProgress {
  step: string;
  percent: number;
}

export interface JobOutputFile {
  name: string;
  label: string;
  sizeBytes: number;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  source: JobSource;
  options: JobOptions;
  progress: JobProgress;
  outputs: JobOutputFile[];
  error?: string;
}

export interface BinaryStatus {
  name: string;
  available: boolean;
  version?: string;
  path?: string;
  installHint: string;
}

export interface HealthReport {
  ok: boolean;
  binaries: BinaryStatus[];
}

export const DEFAULT_OPTIONS = {
  silenceThresholdDb: -30,
  silenceMinDurationSeconds: 0.5,
  verticalMode: "crop" as VerticalMode,
  resolution: "1080p" as Resolution,
  exportHorizontal: true,
  exportVertical: true,
  removeSilence: false,
};

export function resolutionHeight(res: Resolution): number {
  switch (res) {
    case "720p":
      return 720;
    case "1080p":
      return 1080;
    case "1440p":
      return 1440;
    case "2160p":
      return 2160;
    default:
      return 1080;
  }
}

export function normalizeOptions(options: JobOptions): JobOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    cutStartSeconds: options.cutStartSeconds ?? options.trimStartSeconds,
    cutEndSeconds: options.cutEndSeconds ?? options.trimEndSeconds,
    trimStartSeconds: options.trimStartSeconds ?? options.cutStartSeconds,
    trimEndSeconds: options.trimEndSeconds ?? options.cutEndSeconds,
    silenceMinDuration:
      options.silenceMinDuration ?? options.silenceMinDurationSeconds,
    silenceMinDurationSeconds:
      options.silenceMinDurationSeconds ?? options.silenceMinDuration,
    silenceThresholdDb:
      options.silenceThresholdDb ?? DEFAULT_OPTIONS.silenceThresholdDb,
    verticalMode: options.verticalMode ?? DEFAULT_OPTIONS.verticalMode,
    resolution: options.resolution ?? DEFAULT_OPTIONS.resolution,
  };
}
