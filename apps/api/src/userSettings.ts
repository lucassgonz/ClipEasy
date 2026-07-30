import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./paths.js";

/** 0 = domingo … 6 = sábado */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface PostingSchedule {
  /** IANA timezone — default America/Sao_Paulo */
  timezone: string;
  /** Dias ativos (0=dom … 6=sáb). Vazio = todos. */
  days: Weekday[];
  /** Horários locais HH:MM — ex.: ["12:00","18:00"] */
  times: string[];
}

export interface YoutubeConnection {
  accessToken: string;
  refreshToken: string;
  expiry: string;
  channelId?: string;
  channelTitle?: string;
  connectedAt: string;
}

export interface UserSettings {
  postingSchedule: PostingSchedule;
  youtube?: YoutubeConnection;
}

export const DEFAULT_POSTING_SCHEDULE: PostingSchedule = {
  timezone: "America/Sao_Paulo",
  days: [0, 1, 2, 3, 4, 5, 6],
  times: ["12:00", "18:00"],
};

function settingsPath(userId: string): string {
  return path.join(DATA_DIR, "user-settings", `${userId}.json`);
}

export async function loadUserSettings(userId: string): Promise<UserSettings> {
  try {
    const raw = await readFile(settingsPath(userId), "utf8");
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return {
      postingSchedule: normalizeSchedule(
        parsed.postingSchedule ?? DEFAULT_POSTING_SCHEDULE,
      ),
      youtube: parsed.youtube,
    };
  } catch {
    return { postingSchedule: { ...DEFAULT_POSTING_SCHEDULE } };
  }
}

export async function saveUserSettings(
  userId: string,
  next: UserSettings,
): Promise<UserSettings> {
  const dir = path.join(DATA_DIR, "user-settings");
  await mkdir(dir, { recursive: true });
  const normalized: UserSettings = {
    postingSchedule: normalizeSchedule(next.postingSchedule),
    youtube: next.youtube,
  };
  await writeFile(settingsPath(userId), JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

export function normalizeSchedule(input: Partial<PostingSchedule>): PostingSchedule {
  const times = (input.times ?? DEFAULT_POSTING_SCHEDULE.times)
    .map((t) => t.trim())
    .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .map((t) => {
      const [h, m] = t.split(":").map(Number);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    });
  const days = (input.days ?? DEFAULT_POSTING_SCHEDULE.days)
    .map((d) => Number(d))
    .filter((d) => d >= 0 && d <= 6) as Weekday[];
  return {
    timezone: input.timezone?.trim() || "America/Sao_Paulo",
    days: days.length ? [...new Set(days)].sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6],
    times: times.length ? [...new Set(times)].sort() : ["12:00", "18:00"],
  };
}

/**
 * Expand schedule into `count` future Date slots starting tomorrow (local TZ).
 * Brazil (America/Sao_Paulo) is UTC-3 year-round.
 */
export function expandPublishSlots(
  schedule: PostingSchedule,
  count: number,
  now = new Date(),
): Date[] {
  const s = normalizeSchedule(schedule);
  const offsetMin = tzOffsetMinutes(s.timezone);
  const slots: Date[] = [];
  // Local "today" date parts
  const localNow = new Date(now.getTime() + offsetMin * 60_000);
  let dayOffset = 1; // start tomorrow
  let guard = 0;
  while (slots.length < count && guard < 800) {
    guard += 1;
    const localDay = new Date(
      Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate() + dayOffset,
      ),
    );
    const dow = localDay.getUTCDay() as Weekday;
    if (s.days.includes(dow)) {
      for (const time of s.times) {
        if (slots.length >= count) break;
        const [hh, mm] = time.split(":").map(Number);
        // Build UTC instant: local wall time minus offset
        const utcMs =
          Date.UTC(
            localDay.getUTCFullYear(),
            localDay.getUTCMonth(),
            localDay.getUTCDate(),
            hh,
            mm,
            0,
          ) -
          offsetMin * 60_000;
        const at = new Date(utcMs);
        if (at.getTime() > now.getTime() + 60_000) {
          slots.push(at);
        }
      }
    }
    dayOffset += 1;
  }
  return slots;
}

function tzOffsetMinutes(tz: string): number {
  // Fixed offsets for common BR zones; fallback -180 (São Paulo).
  if (/Manaus|Cuiaba|Porto_Velho|Rio_Branco/i.test(tz)) return -240;
  if (/Noronha/i.test(tz)) return -120;
  if (/Sao_Paulo|Fortaleza|Recife|Bahia|Belem|America\/Sao_Paulo/i.test(tz)) {
    return -180;
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    });
    const parts = fmt.formatToParts(new Date());
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = name.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (m) {
      const h = Number(m[1]);
      const min = Number(m[2] ?? 0);
      return h * 60 + (h < 0 ? -min : min);
    }
  } catch {
    /* ignore */
  }
  return -180;
}

export interface PublishQueueItem {
  id: string;
  userId: string;
  projectId: string;
  clipId: string;
  filename: string;
  filePath: string;
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  scheduledAt: string;
  status: "pending" | "uploading" | "done" | "error" | "cancelled";
  youtubeVideoId?: string;
  error?: string;
  createdAt: string;
}

function queuePath(userId: string): string {
  return path.join(DATA_DIR, "publish-queue", `${userId}.json`);
}

export async function loadPublishQueue(userId: string): Promise<PublishQueueItem[]> {
  try {
    const raw = await readFile(queuePath(userId), "utf8");
    return JSON.parse(raw) as PublishQueueItem[];
  } catch {
    return [];
  }
}

export async function savePublishQueue(
  userId: string,
  items: PublishQueueItem[],
): Promise<void> {
  const dir = path.join(DATA_DIR, "publish-queue");
  await mkdir(dir, { recursive: true });
  await writeFile(queuePath(userId), JSON.stringify(items, null, 2), "utf8");
}
