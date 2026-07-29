import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined);
const bypass = import.meta.env.VITE_DEV_AUTH_BYPASS === "1";

let client: SupabaseClient | null = null;

export function isDevBypass(): boolean {
  return bypass || !url || !anon;
}

export function getSupabase(): SupabaseClient | null {
  if (isDevBypass()) return null;
  if (!client) {
    client = createClient(url!, anon!);
  }
  return client;
}

export async function getSession(): Promise<Session | null> {
  if (isDevBypass()) {
    return {
      access_token: "dev",
      token_type: "bearer",
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "dev@local.test",
      },
    } as Session;
  }
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

export async function signIn(email: string, password: string) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase não configurado");
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email: string, password: string, displayName: string) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase não configurado");
  const { error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) throw error;
}

export async function signOut() {
  const sb = getSupabase();
  if (!sb) return;
  await sb.auth.signOut();
}
