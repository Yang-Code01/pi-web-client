/**
 * Repo-relative paths for the tests and probes (D114).
 *
 * These scripts used to carry the maintainer's own machine in them — `F:/pi-web-client/…` for the
 * repo and `C:/Users/GG_Bond/…` for playwright and pi — so on any other clone the first `readFile`
 * threw `ENOENT: F:\pi-web-client\…`. Resolve from `import.meta.url` instead: a test knows its own
 * location, and that is the only path that is true on every machine.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root. This file sits in `<repo>/tools/`. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The built frontend the stub-bridge probes serve. */
export const DIST = path.join(REPO, "web", "dist");

/** `<repo>/.scratch/<parts…>` — throwaway state, gitignored (fixtures, isolated bridges, screenshots). */
export function scratch(...parts) {
  return path.join(REPO, ".scratch", ...parts);
}

/** The bridge's own `ws` copy: the repo root has no node_modules of its own. */
export function wsWrapper() {
  return path.join(REPO, "bridge", "node_modules", "ws", "wrapper.mjs");
}
