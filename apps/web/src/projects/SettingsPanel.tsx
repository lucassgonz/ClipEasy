import { useEffect, useState } from "react";
import {
  disconnectYoutube,
  fetchPublishQueue,
  fetchUserSettings,
  previewPublishSlots,
  processPublishQueue,
  saveUserSettings,
  startYoutubeOAuth,
} from "../api";
import type { PostingSchedule, UserSettingsPublic } from "../types";

const DAY_LABELS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Seg" },
  { value: 2, label: "Ter" },
  { value: 3, label: "Qua" },
  { value: 4, label: "Qui" },
  { value: 5, label: "Sex" },
  { value: 6, label: "Sáb" },
  { value: 0, label: "Dom" },
];

function defaultSchedule(): PostingSchedule {
  return {
    timezone: "America/Sao_Paulo",
    days: [0, 1, 2, 3, 4, 5, 6],
    times: ["12:00", "18:00"],
  };
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<UserSettingsPublic | null>(null);
  const [schedule, setSchedule] = useState<PostingSchedule>(defaultSchedule());
  const [timesText, setTimesText] = useState("12:00, 18:00");
  const [preview, setPreview] = useState<string | null>(null);
  const [queueInfo, setQueueInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const s = await fetchUserSettings();
    setSettings(s);
    setSchedule(s.postingSchedule);
    setTimesText(s.postingSchedule.times.join(", "));
    const q = await fetchPublishQueue();
    if (q.total > 0) {
      setQueueInfo(
        `Fila: ${q.pending} pendente(s), ${q.uploading} enviando, ${q.done} ok, ${q.error} erro(s)${q.processing ? " · processando…" : ""}`,
      );
    } else {
      setQueueInfo(null);
    }
  }

  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const data = ev.data as { type?: string; ok?: boolean; error?: string };
      if (data?.type !== "youtube-oauth") return;
      if (data.ok) {
        void refresh().catch((e: Error) => setError(e.message));
      } else {
        setError(data.error || "Falha ao conectar YouTube");
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  function toggleDay(day: number) {
    setSchedule((prev) => {
      const has = prev.days.includes(day);
      const days = has
        ? prev.days.filter((d) => d !== day)
        : [...prev.days, day].sort((a, b) => a - b);
      return { ...prev, days: days.length ? days : [1, 2, 3, 4, 5] };
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const times = timesText
        .split(/[,;\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const next = await saveUserSettings({
        ...schedule,
        times: times.length ? times : ["12:00", "18:00"],
      });
      setSettings(next);
      setSchedule(next.postingSchedule);
      setTimesText(next.postingSchedule.times.join(", "));
      const slots = await previewPublishSlots(60, next.postingSchedule);
      setPreview(
        slots.firstAt && slots.lastAt
          ? `Ex.: 60 clipes → ${slots.count} posts · ${new Date(slots.firstAt).toLocaleString()} até ${new Date(slots.lastAt).toLocaleString()} (${slots.slotsPerDay}/dia)`
          : "Sem slots válidos",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function connectYoutube() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await startYoutubeOAuth();
      window.open(url, "clipEasy-youtube", "width=560,height=720");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true">
      <div className="settings-panel">
        <header className="settings-head">
          <h2>Configurações</h2>
          <button type="button" className="ghost" onClick={onClose}>
            Fechar
          </button>
        </header>

        {error && <p className="error">{error}</p>}

        <section className="settings-section">
          <h3>Conta YouTube</h3>
          <p className="hint">
            A chave de API só lê o canal. Para agendar uploads, conecte o Google
            com permissão de upload (OAuth).
          </p>
          {settings?.youtube.connected ? (
            <div className="settings-row">
              <p>
                Conectado
                {settings.youtube.channelTitle
                  ? `: ${settings.youtube.channelTitle}`
                  : ""}
              </p>
              <button
                type="button"
                className="ghost danger"
                disabled={busy}
                onClick={() =>
                  void disconnectYoutube()
                    .then(setSettings)
                    .catch((e: Error) => setError(e.message))
                }
              >
                Desconectar
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="cta small"
              disabled={busy || settings?.oauthConfigured === false}
              onClick={() => void connectYoutube()}
            >
              Conectar YouTube
            </button>
          )}
          {settings && !settings.oauthConfigured && (
            <p className="hint">
              Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env (veja
              README).
            </p>
          )}
        </section>

        <section className="settings-section">
          <h3>Horários padrão de postagem</h3>
          <p className="hint">
            Usado ao agendar clipes no projeto. Começa amanhã nos dias e
            horários abaixo (fuso {schedule.timezone}).
          </p>

          <div className="day-grid">
            {DAY_LABELS.map((d) => (
              <button
                key={d.value}
                type="button"
                className={
                  schedule.days.includes(d.value) ? "day-chip on" : "day-chip"
                }
                onClick={() => toggleDay(d.value)}
              >
                {d.label}
              </button>
            ))}
          </div>

          <label className="field compact">
            <span>Horários (HH:MM, separados por vírgula)</span>
            <input
              value={timesText}
              onChange={(e) => setTimesText(e.target.value)}
              placeholder="12:00, 18:00"
            />
          </label>

          <div className="settings-row">
            <button
              type="button"
              className="cta small"
              disabled={busy}
              onClick={() => void save()}
            >
              Salvar agenda
            </button>
          </div>
          {preview && <p className="hint">{preview}</p>}
        </section>

        <section className="settings-section">
          <h3>Fila de publicação</h3>
          {queueInfo ? <p className="hint">{queueInfo}</p> : <p className="hint">Nenhum upload na fila.</p>}
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void processPublishQueue({ retryErrors: true, limit: 5 })
                .then(() => refresh())
                .catch((e: Error) => setError(e.message))
            }
          >
            Retentar erros / continuar fila
          </button>
        </section>
      </div>
    </div>
  );
}
