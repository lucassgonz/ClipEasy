import { useState } from "react";
import { isDevBypass, signIn, signUp } from "../lib/supabase";

export function AuthPage({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isDevBypass()) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1 className="brand">ClipFácil</h1>
          <p className="tagline">
            Modo desenvolvimento (sem Supabase). Clique para entrar.
          </p>
          <button type="button" className="cta" onClick={onAuthed}>
            Entrar como Dev
          </button>
        </div>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await signIn(email, password);
      else await signUp(email, password, name || email.split("@")[0]!);
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha na autenticação");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="brand">ClipFácil</h1>
        <p className="tagline">
          Editor local com timeline, legendas e a sua conta.
        </p>
        <div className="segmented">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            Entrar
          </button>
          <button
            type="button"
            className={mode === "signup" ? "active" : ""}
            onClick={() => setMode("signup")}
          >
            Criar conta
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          {mode === "signup" && (
            <label className="field">
              <span>Nome</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Senha</span>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="cta" type="submit" disabled={busy}>
            {busy ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar conta"}
          </button>
        </form>
      </div>
    </div>
  );
}
