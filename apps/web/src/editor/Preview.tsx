import {
  findActiveVideoClip,
  type CaptionCue,
  type Timeline,
} from "../types";
import { mediaUrl } from "../api";
import { getSession } from "../lib/supabase";
import { useEffect, useMemo, useRef, useState } from "react";

export function Preview({
  projectId,
  timeline,
  timeMs,
  playing,
  onTime,
  onTogglePlay,
}: {
  projectId: string;
  timeline: Timeline;
  timeMs: number;
  playing: boolean;
  onTime: (ms: number) => void;
  onTogglePlay: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [token, setToken] = useState<string>("");
  const clip = findActiveVideoClip(timeline, timeMs);
  const cue = useMemo(() => {
    const track = timeline.tracks.find((t) => t.type === "captions");
    if (!track || track.type !== "captions") return null;
    return (
      track.cues.find((c) => timeMs >= c.startMs && timeMs < c.endMs) ?? null
    );
  }, [timeline, timeMs]);

  useEffect(() => {
    void getSession().then((s) => setToken(s?.access_token ?? ""));
  }, []);

  const src = clip && token
    ? `${mediaUrl(projectId, clip.assetId)}?t=${token}`
    : "";

  // Auth via query won't work - need blob fetch with Authorization
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const lastAsset = useRef<string>("");

  useEffect(() => {
    if (!clip) {
      setBlobUrl(null);
      return;
    }
    if (lastAsset.current === clip.assetId && blobUrl) return;
    let revoked: string | null = null;
    void (async () => {
      const session = await getSession();
      const res = await fetch(mediaUrl(projectId, clip.assetId), {
        headers: session?.access_token
          ? { Authorization: `Bearer ${session.access_token}` }
          : {},
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      revoked = url;
      lastAsset.current = clip.assetId;
      setBlobUrl(url);
    })();
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [clip?.assetId, projectId]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !clip) return;
    const local = (timeMs - clip.timelineStartMs + clip.inMs) / 1000;
    if (Math.abs(el.currentTime - local) > 0.25) {
      el.currentTime = Math.max(0, local);
    }
  }, [timeMs, clip?.id]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (playing) void el.play().catch(() => undefined);
    else el.pause();
  }, [playing, blobUrl]);

  return (
    <div className="preview">
      <div className="preview-stage">
        {blobUrl ? (
          <video
            ref={videoRef}
            src={blobUrl}
            playsInline
            onTimeUpdate={(e) => {
              if (!clip || !playing) return;
              const localMs = e.currentTarget.currentTime * 1000;
              onTime(clip.timelineStartMs + (localMs - clip.inMs));
            }}
            onEnded={onTogglePlay}
          />
        ) : (
          <div className="preview-empty">Importe um vídeo para começar</div>
        )}
        {cue && <div className="caption-overlay">{cue.text}</div>}
      </div>
      <div className="preview-controls">
        <button type="button" className="cta small" onClick={onTogglePlay}>
          {playing ? "Pausar" : "Play"}
        </button>
        <span className="timecode">{formatMs(timeMs)}</span>
        <span className="muted-src">{src ? "" : ""}</span>
      </div>
    </div>
  );
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export type { CaptionCue };
