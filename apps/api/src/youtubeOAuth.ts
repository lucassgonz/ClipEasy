import { readFile } from "node:fs/promises";
import { getEnv } from "./auth.js";
import {
  loadUserSettings,
  saveUserSettings,
  type YoutubeConnection,
} from "./userSettings.js";

const YT_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const YT_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

/** OAuth CSRF state → userId (in-memory; fine for local single-user). */
const pendingOAuth = new Map<string, { userId: string; expiresAt: number }>();

export function youtubeOAuthConfigured(): boolean {
  return Boolean(getEnv("GOOGLE_CLIENT_ID") && getEnv("GOOGLE_CLIENT_SECRET"));
}

export function youtubeRedirectUri(): string {
  return (
    getEnv("YOUTUBE_OAUTH_REDIRECT_URI") ||
    `http://127.0.0.1:${getEnv("PORT") || "8787"}/auth/youtube/callback`
  );
}

export function webOrigin(): string {
  return getEnv("WEB_ORIGIN") || "http://127.0.0.1:5173";
}

export function rememberOAuthState(state: string, userId: string): void {
  pendingOAuth.set(state, {
    userId,
    expiresAt: Date.now() + 15 * 60_000,
  });
}

export function takeOAuthState(state: string): string | null {
  const row = pendingOAuth.get(state);
  pendingOAuth.delete(state);
  if (!row || row.expiresAt < Date.now()) return null;
  return row.userId;
}

export function buildYoutubeAuthUrl(state: string): string {
  const clientId = getEnv("GOOGLE_CLIENT_ID");
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID não configurado no .env");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: youtubeRedirectUri(),
    response_type: "code",
    scope: `${YT_UPLOAD_SCOPE} ${YT_READONLY_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeYoutubeCode(
  code: string,
): Promise<YoutubeConnection> {
  const clientId = getEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getEnv("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET ausentes");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: youtubeRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth YouTube falhou: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  if (!json.refresh_token) {
    throw new Error(
      "Google não devolveu refresh_token. Revogue o acesso do app em myaccount.google.com/permissions e conecte de novo.",
    );
  }
  const conn: YoutubeConnection = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiry: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    connectedAt: new Date().toISOString(),
  };
  const channel = await fetchMineChannel(conn.accessToken);
  if (channel) {
    conn.channelId = channel.id;
    conn.channelTitle = channel.title;
  }
  return conn;
}

async function fetchMineChannel(
  accessToken: string,
): Promise<{ id: string; title: string } | null> {
  const res = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    items?: Array<{ id?: string; snippet?: { title?: string } }>;
  };
  const item = json.items?.[0];
  if (!item?.id) return null;
  return { id: item.id, title: item.snippet?.title ?? item.id };
}

export async function refreshYoutubeAccess(
  userId: string,
): Promise<YoutubeConnection> {
  const settings = await loadUserSettings(userId);
  const yt = settings.youtube;
  if (!yt?.refreshToken) {
    throw new Error("YouTube não conectado. Conecte o canal nas configurações.");
  }
  const expiry = Date.parse(yt.expiry);
  if (Number.isFinite(expiry) && expiry > Date.now() + 60_000) {
    return yt;
  }
  const clientId = getEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getEnv("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET ausentes");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: yt.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Refresh YouTube falhou: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  const next: YoutubeConnection = {
    ...yt,
    accessToken: json.access_token,
    expiry: new Date(Date.now() + json.expires_in * 1000).toISOString(),
  };
  await saveUserSettings(userId, { ...settings, youtube: next });
  return next;
}

export async function saveYoutubeConnection(
  userId: string,
  conn: YoutubeConnection,
): Promise<void> {
  const settings = await loadUserSettings(userId);
  await saveUserSettings(userId, { ...settings, youtube: conn });
}

export async function disconnectYoutube(userId: string): Promise<void> {
  const settings = await loadUserSettings(userId);
  await saveUserSettings(userId, { ...settings, youtube: undefined });
}

export async function uploadYoutubeVideo(opts: {
  userId: string;
  filePath: string;
  title: string;
  description: string;
  tags: string[];
  publishAt: Date;
}): Promise<{ videoId: string }> {
  const conn = await refreshYoutubeAccess(opts.userId);
  const publishAtIso = opts.publishAt.toISOString();
  const metadata = {
    snippet: {
      title: opts.title.slice(0, 100),
      description: opts.description.slice(0, 5000),
      tags: opts.tags.slice(0, 30),
      categoryId: "22",
    },
    status: {
      privacyStatus: "private",
      publishAt: publishAtIso,
      selfDeclaredMadeForKids: false,
    },
  };

  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!init.ok) {
    throw new Error(`Falha ao iniciar upload: ${await init.text()}`);
  }
  const uploadUrl = init.headers.get("location");
  if (!uploadUrl) {
    throw new Error("YouTube não retornou URL de upload resumível");
  }

  const body = await readFile(opts.filePath);
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      "Content-Type": "video/mp4",
      "Content-Length": String(body.byteLength),
    },
    body,
  });
  if (!put.ok) {
    throw new Error(`Upload YouTube falhou: ${await put.text()}`);
  }
  const json = (await put.json()) as { id?: string };
  if (!json.id) throw new Error("Upload concluído sem videoId");
  return { videoId: json.id };
}
