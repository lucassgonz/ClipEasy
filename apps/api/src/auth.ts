import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";

let supabaseAdmin: SupabaseClient | null = null;
let supabaseAnon: SupabaseClient | null = null;

export function getEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function supabaseConfigured(): boolean {
  return Boolean(getEnv("SUPABASE_URL") && getAnonKey());
}

function getAnonKey(): string | undefined {
  return (
    getEnv("SUPABASE_ANON_KEY") ||
    getEnv("SUPABASE_PUBLISHABLE_KEY") ||
    getEnv("VITE_SUPABASE_ANON_KEY") ||
    getEnv("VITE_SUPABASE_PUBLISHABLE_KEY")
  );
}

export function getSupabaseAnon(): SupabaseClient {
  const url = getEnv("SUPABASE_URL");
  const key = getAnonKey();
  if (!url || !key) {
    throw new Error(
      "Supabase não configurado. Defina SUPABASE_URL e SUPABASE_ANON_KEY (ou PUBLISHABLE_KEY) no .env",
    );
  }
  if (!supabaseAnon) {
    supabaseAnon = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseAnon;
}

export function getSupabaseAdmin(): SupabaseClient {
  const url = getEnv("SUPABASE_URL");
  const key =
    getEnv("SUPABASE_SERVICE_ROLE_KEY") ||
    getEnv("SUPABASE_SECRET_KEY") ||
    getAnonKey();
  if (!url || !key) {
    throw new Error("Supabase não configurado");
  }
  if (!supabaseAdmin) {
    supabaseAdmin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseAdmin;
}

export function userClient(token: string): SupabaseClient {
  const url = getEnv("SUPABASE_URL")!;
  const key = getAnonKey()!;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function requireUser(
  req: FastifyRequest,
): Promise<{ user: User; token: string }> {
  // Dev bypass for local UI without Supabase
  if (getEnv("DEV_AUTH_BYPASS") === "1") {
    return {
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "dev@local.test",
        app_metadata: {},
        user_metadata: { display_name: "Dev" },
        aud: "authenticated",
        created_at: new Date().toISOString(),
      } as User,
      token: "dev",
    };
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    const err = new Error("Não autenticado");
    (err as Error & { statusCode: number }).statusCode = 401;
    throw err;
  }
  const token = header.slice("Bearer ".length).trim();
  const { data, error } = await getSupabaseAnon().auth.getUser(token);
  if (error || !data.user) {
    const err = new Error("Sessão inválida");
    (err as Error & { statusCode: number }).statusCode = 401;
    throw err;
  }
  return { user: data.user, token };
}
