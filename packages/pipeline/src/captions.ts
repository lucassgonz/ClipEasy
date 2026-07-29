import { writeFile } from "node:fs/promises";
import type { CaptionCue } from "./timeline.js";

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

/** Default ASS style tuned for the given play resolution (vertical or horizontal). */
export function cuesToAss(
  cues: CaptionCue[],
  playRes: AssPlayRes = { x: 1080, y: 1920 },
): string {
  const px = Math.max(1, Math.round(playRes.x));
  const py = Math.max(1, Math.round(playRes.y));
  const isVertical = py >= px;
  // ~3.3% of height; slightly smaller on vertical so long lines wrap cleanly.
  const fontSize = Math.round(py * (isVertical ? 0.028 : 0.045));
  const marginLR = Math.round(px * (isVertical ? 0.07 : 0.05));
  const marginV = Math.round(py * (isVertical ? 0.055 : 0.06));

  const header = `[Script Info]
Title: clipEasy
ScriptType: v4.00+
PlayResX: ${px}
PlayResY: ${py}
WrapStyle: 1
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,2,2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = cues
    .filter((c) => c.text.trim() && c.endMs > c.startMs)
    .map(
      (c) =>
        `Dialogue: 0,${msToAssTime(c.startMs)},${msToAssTime(c.endMs)},Default,,0,0,0,,${escapeAss(c.text.trim())}`,
    )
    .join("\n");

  return `${header}${events}\n`;
}

export async function writeAssFile(
  cues: CaptionCue[],
  filePath: string,
  playRes?: AssPlayRes,
): Promise<void> {
  await writeFile(filePath, cuesToAss(cues, playRes), "utf8");
}
