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

export function cuesToAss(cues: CaptionCue[]): string {
  const header = `[Script Info]
Title: clipEasy
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,2,2,40,40,80,1

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
): Promise<void> {
  await writeFile(filePath, cuesToAss(cues), "utf8");
}
