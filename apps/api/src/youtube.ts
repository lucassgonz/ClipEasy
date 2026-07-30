import { getEnv } from "./auth.js";

export interface RelatedChannelVideo {
  title: string;
  url: string;
  videoId: string;
}

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.replace(/^\//, "").split("/")[0] || null;
    }
    const v = u.searchParams.get("v");
    if (v) return v;
    const shorts = u.pathname.match(/\/shorts\/([^/?#]+)/);
    if (shorts?.[1]) return shorts[1];
    const embed = u.pathname.match(/\/embed\/([^/?#]+)/);
    if (embed?.[1]) return embed[1];
  } catch {
    /* ignore */
  }
  return null;
}

/** Resolve a YouTube channel ID from @handle, /channel/UC…, or /c/… URL. */
export async function resolveYouTubeChannelId(
  channelUrl: string,
  apiKey: string,
): Promise<string | null> {
  const raw = channelUrl.trim();
  if (!raw) return null;

  let pathname = raw;
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    pathname = u.pathname;
  } catch {
    /* treat as handle */
  }

  const byId = pathname.match(/\/channel\/(UC[\w-]+)/i);
  if (byId?.[1]) return byId[1];

  const handleMatch =
    pathname.match(/\/@([\w.-]+)/) ||
    raw.match(/^@([\w.-]+)$/) ||
    pathname.match(/\/c\/([\w.-]+)/) ||
    pathname.match(/\/user\/([\w.-]+)/);
  const handle = handleMatch?.[1];
  if (!handle) return null;

  // forHandle (newer) then fallback search
  const forHandle = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`,
  );
  if (forHandle.ok) {
    const json = (await forHandle.json()) as {
      items?: Array<{ id?: string }>;
    };
    if (json.items?.[0]?.id) return json.items[0].id;
  }

  const search = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(handle)}&key=${apiKey}`,
  );
  if (!search.ok) return null;
  const sjson = (await search.json()) as {
    items?: Array<{ snippet?: { channelId?: string }; id?: { channelId?: string } }>;
  };
  return (
    sjson.items?.[0]?.id?.channelId ??
    sjson.items?.[0]?.snippet?.channelId ??
    null
  );
}

/** Latest public uploads from a channel (needs YOUTUBE_API_KEY). */
export async function fetchChannelRecentVideos(
  channelUrl: string,
  opts?: { max?: number; excludeVideoId?: string },
): Promise<RelatedChannelVideo[]> {
  const apiKey = getEnv("YOUTUBE_API_KEY");
  if (!apiKey) {
    throw new Error(
      "YOUTUBE_API_KEY não configurada. Cole links manuais ou adicione a chave no .env.",
    );
  }
  const channelId = await resolveYouTubeChannelId(channelUrl, apiKey);
  if (!channelId) {
    throw new Error("Não foi possível identificar o canal a partir da URL.");
  }

  const max = Math.min(15, Math.max(1, opts?.max ?? 8));
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&order=date&type=video&maxResults=${max}&key=${apiKey}`,
  );
  if (!res.ok) {
    throw new Error(`YouTube API falhou: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      id?: { videoId?: string };
      snippet?: { title?: string };
    }>;
  };

  const out: RelatedChannelVideo[] = [];
  for (const it of json.items ?? []) {
    const videoId = it.id?.videoId;
    if (!videoId || videoId === opts?.excludeVideoId) continue;
    const title = (it.snippet?.title ?? "").trim();
    if (!title) continue;
    out.push({
      videoId,
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return out;
}

export function parseManualRelatedVideos(
  text: string,
): RelatedChannelVideo[] {
  const out: RelatedChannelVideo[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "Title | https://..." or just URL
    const pipe = trimmed.split("|").map((s) => s.trim());
    let title = "";
    let url = trimmed;
    if (pipe.length >= 2 && /^https?:\/\//i.test(pipe[pipe.length - 1]!)) {
      url = pipe[pipe.length - 1]!;
      title = pipe.slice(0, -1).join(" | ").trim();
    }
    const videoId = extractVideoId(url);
    if (!videoId) continue;
    out.push({
      videoId,
      title: title || `Vídeo ${videoId}`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return out;
}

export function pickRelatedVideo(
  videos: RelatedChannelVideo[],
  index: number,
  excludeUrl?: string,
): RelatedChannelVideo | undefined {
  const excludeId = excludeUrl ? extractVideoId(excludeUrl) : null;
  const pool = videos.filter((v) => v.videoId !== excludeId);
  if (pool.length === 0) return undefined;
  return pool[index % pool.length];
}

/** Normalize to ≤6 unique #tags, always with leading #. */
export function normalizeHashtags(
  tags: string[] | undefined,
  max = 6,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    let t = raw.trim();
    if (!t) continue;
    if (!t.startsWith("#")) t = `#${t}`;
    t = t.replace(/\s+/g, "");
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function hashtagsCsv(tags: string[]): string {
  return normalizeHashtags(tags).join(", ");
}
