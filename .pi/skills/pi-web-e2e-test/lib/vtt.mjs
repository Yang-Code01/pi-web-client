/** WebVTT generation and per-case cue slicing. No browser or ffmpeg required. */

const EPS = 1e-9;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

/** Format seconds as `HH:MM:SS.mmm` (VTT has no hours limit, but this is plenty). */
export function formatVttTime(seconds) {
  let ms = Math.floor(Math.max(0, finite(seconds)) * 1000 + 1e-6);
  const hours = Math.floor(ms / 3_600_000);
  ms -= hours * 3_600_000;
  const minutes = Math.floor(ms / 60_000);
  ms -= minutes * 60_000;
  const secs = Math.floor(ms / 1000);
  ms -= secs * 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(ms, 3)}`;
}

function cleanText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/-->/g, "→")
    .replace(/\n+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Build a complete VTT document. Cues are sorted and clamped to the video
 * duration; empty cues are dropped.
 *
 * @param {Array<{start:number, end:number, text:string}>} cues
 * @param {number} duration
 */
export function buildVtt(cues, duration) {
  const total = Math.max(0, finite(duration));
  const rows = [];
  for (const cue of cues ?? []) {
    const start = Math.max(0, finite(cue?.start));
    const end = Math.min(total, Math.max(0, finite(cue?.end)));
    const text = cleanText(cue?.text);
    if (!text || end <= start + EPS) continue;
    rows.push({ start, end, text });
  }
  rows.sort((a, b) => a.start - b.start || a.end - b.end);
  const body = rows
    .map((cue) => `${formatVttTime(cue.start)} --> ${formatVttTime(cue.end)}\n${cue.text}`)
    .join("\n\n");
  return body ? `WEBVTT\n\n${body}\n` : "WEBVTT\n\n";
}

/**
 * Take the cues that overlap a clip and rebase them to the clip's start.
 * Used when the report shows one video per case instead of the full run.
 */
export function sliceCues(cues, start, end) {
  const from = Math.max(0, finite(start));
  const to = Math.max(from, finite(end));
  const out = [];
  for (const cue of cues ?? []) {
    const cueStart = Math.max(from, finite(cue?.start));
    const cueEnd = Math.min(to, finite(cue?.end));
    const text = cleanText(cue?.text);
    if (!text || cueEnd <= cueStart + EPS) continue;
    out.push({ start: cueStart - from, end: cueEnd - from, text });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}
