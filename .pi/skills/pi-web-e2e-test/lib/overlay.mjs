import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let cached = "";

/** The init script injected into every page: CSS + overlay controller. */
export function overlayScript() {
  if (cached) return cached;
  const css = fs.readFileSync(path.join(here, "overlay.css"), "utf8");
  const js = fs.readFileSync(path.join(here, "overlay-init.js"), "utf8");
  cached = `window.__E2E_CSS = ${JSON.stringify(css)};\n${js}\n`;
  return cached;
}
