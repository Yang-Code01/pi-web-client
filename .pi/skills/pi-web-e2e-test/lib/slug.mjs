/** Filesystem-safe names for run directories and report files. */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** ASCII-only directory slug: Latin words survive, CJK becomes `run`. */
export function asciiSlug(text) {
  const slug = String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "run";
}

/**
 * Human-readable file stem (Chinese is fine). Removes characters Windows
 * rejects, trims trailing dots/spaces, and avoids reserved device names.
 */
export function safeFileStem(text) {
  let stem = String(text ?? "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80)
    .replace(/[.\s]+$/g, "");
  if (!stem) stem = "e2e";
  if (RESERVED.test(stem)) stem = `_${stem}`;
  return stem;
}

/** `YYYYMMDD-HHMMSS` in local time; lexical order is chronological. */
export function runStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
