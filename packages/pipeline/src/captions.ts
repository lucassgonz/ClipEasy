import { writeFile } from "node:fs/promises";
import type { CaptionCue } from "./timeline.js";

export type CaptionStyleId = "clean" | "bold" | "pop" | "boxed";

export interface CaptionAnchorKeyframe {
  tMs: number;
  /** Prefer top when a face occupies the lower frame */
  place: "top" | "bottom";
}

function escapeAss(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

function msToAssTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export interface AssPlayRes {
  x: number;
  y: number;
}

export interface AssCaptionOptions {
  playRes?: AssPlayRes;
  style?: CaptionStyleId;
  /** When set, each cue picks top/bottom to avoid faces */
  anchorTrack?: CaptionAnchorKeyframe[];
  avoidFaces?: boolean;
}

function interpolateAnchor(
  track: CaptionAnchorKeyframe[] | undefined,
  timeMs: number,
): "top" | "bottom" {
  if (!track || track.length === 0) return "bottom";
  if (timeMs <= track[0]!.tMs) return track[0]!.place;
  const last = track[track.length - 1]!;
  if (timeMs >= last.tMs) return last.place;
  let best = track[0]!;
  for (const k of track) {
    if (k.tMs <= timeMs) best = k;
    else break;
  }
  return best.place;
}

type StyleParams = {
  font: string;
  fontSizeRatioV: number;
  fontSizeRatioH: number;
  primary: string;
  outline: string;
  back: string;
  bold: 0 | 1;
  borderStyle: 1 | 3;
  outlineWidth: number;
  shadow: number;
  marginRatioLR: number;
  marginRatioV: number;
};

function styleParams(style: CaptionStyleId): StyleParams {
  switch (style) {
    case "bold":
      return {
        font: "Arial Black",
        fontSizeRatioV: 0.038,
        fontSizeRatioH: 0.055,
        primary: "&H00FFFFFF",
        outline: "&H00000000",
        back: "&H80000000",
        bold: 1,
        borderStyle: 1,
        outlineWidth: 5,
        shadow: 3,
        marginRatioLR: 0.08,
        marginRatioV: 0.07,
      };
    case "pop":
      return {
        font: "Arial Black",
        fontSizeRatioV: 0.04,
        fontSizeRatioH: 0.058,
        // ASS is &HAABBGGRR — yellow
        primary: "&H0000F5FF",
        outline: "&H00000000",
        back: "&H80000000",
        bold: 1,
        borderStyle: 1,
        outlineWidth: 6,
        shadow: 2,
        marginRatioLR: 0.08,
        marginRatioV: 0.075,
      };
    case "boxed":
      return {
        font: "Arial",
        fontSizeRatioV: 0.032,
        fontSizeRatioH: 0.048,
        primary: "&H00FFFFFF",
        outline: "&H00000000",
        back: "&HC0000000",
        bold: 1,
        borderStyle: 3,
        outlineWidth: 8,
        shadow: 0,
        marginRatioLR: 0.08,
        marginRatioV: 0.07,
      };
    case "clean":
    default:
      return {
        font: "Arial",
        fontSizeRatioV: 0.03,
        fontSizeRatioH: 0.048,
        primary: "&H00FFFFFF",
        outline: "&H00000000",
        back: "&H80000000",
        bold: 1,
        borderStyle: 1,
        outlineWidth: 4,
        shadow: 2,
        marginRatioLR: 0.07,
        marginRatioV: 0.06,
      };
  }
}

/** Split long cues into ~3-word chunks with proportional timing (for older transcripts). */
export function expandCuesToWordGroups(
  cues: CaptionCue[],
  groupSize = 3,
): CaptionCue[] {
  const size = Math.max(1, groupSize);
  const out: CaptionCue[] = [];
  for (const cue of cues) {
    const words = cue.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || cue.endMs <= cue.startMs) continue;
    if (words.length <= size) {
      out.push(cue);
      continue;
    }
    const span = cue.endMs - cue.startMs;
    const groups = Math.ceil(words.length / size);
    for (let g = 0; g < groups; g += 1) {
      const slice = words.slice(g * size, (g + 1) * size);
      const startMs = Math.round(cue.startMs + (span * g) / groups);
      const endMs = Math.round(cue.startMs + (span * (g + 1)) / groups);
      out.push({
        id: `${cue.id}-w${g}`,
        startMs,
        endMs: Math.max(startMs + 80, endMs),
        text: slice.join(" "),
      });
    }
  }
  return out;
}

/** ASS pop-in: slight overscale then settle + short fade. */
function assAnimTags(): string {
  return "{\\fad(90,70)\\t(0,140,\\fscx118\\fscy118)\\t(140,260,\\fscx100\\fscy100)}";
}

/** ASS style tuned for play resolution + caption look. */
export function cuesToAss(
  cues: CaptionCue[],
  playResOrOpts: AssPlayRes | AssCaptionOptions = { x: 1080, y: 1920 },
): string {
  const opts: AssCaptionOptions =
    "playRes" in playResOrOpts ||
    "style" in playResOrOpts ||
    "anchorTrack" in playResOrOpts ||
    "avoidFaces" in playResOrOpts
      ? (playResOrOpts as AssCaptionOptions)
      : { playRes: playResOrOpts as AssPlayRes };

  const playRes = opts.playRes ?? { x: 1080, y: 1920 };
  const styleId = opts.style ?? "pop";
  const params = styleParams(styleId);
  const px = Math.max(1, Math.round(playRes.x));
  const py = Math.max(1, Math.round(playRes.y));
  const isVertical = py >= px;
  const fontSize = Math.round(
    py * (isVertical ? params.fontSizeRatioV : params.fontSizeRatioH),
  );
  const marginLR = Math.round(px * params.marginRatioLR);
  const marginV = Math.round(py * params.marginRatioV);
  const useAnchors = Boolean(opts.avoidFaces && opts.anchorTrack?.length);
  const synced = expandCuesToWordGroups(cues, 3);

  const header = `[Script Info]
Title: clipEasy
ScriptType: v4.00+
PlayResX: ${px}
PlayResY: ${py}
WrapStyle: 1
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${params.font},${fontSize},${params.primary},&H000000FF,${params.outline},${params.back},${params.bold},0,0,0,0,100,100,0,0,${params.borderStyle},${params.outlineWidth},${params.shadow},2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = synced
    .filter((c) => c.text.trim() && c.endMs > c.startMs)
    .map((c) => {
      const mid = (c.startMs + c.endMs) / 2;
      const place = useAnchors
        ? interpolateAnchor(opts.anchorTrack, mid)
        : "bottom";
      const align = place === "top" ? "{\\an8}" : "{\\an2}";
      const text = `${align}${assAnimTags()}${escapeAss(c.text.trim())}`;
      return `Dialogue: 0,${msToAssTime(c.startMs)},${msToAssTime(c.endMs)},Default,,0,0,0,,${text}`;
    })
    .join("\n");

  return `${header}${events}\n`;
}

export async function writeAssFile(
  cues: CaptionCue[],
  filePath: string,
  playResOrOpts?: AssPlayRes | AssCaptionOptions,
): Promise<void> {
  await writeFile(filePath, cuesToAss(cues, playResOrOpts), "utf8");
}
