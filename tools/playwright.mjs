/**
 * Find playwright where it actually is (D114). The probes used to hardcode
 * `C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs`,
 * which is one machine's npx cache entry — the hash changes on every reinstall, and it does not exist
 * anywhere else.
 *
 * Order: `PW_PATH` → the repo's own `node_modules` (if someone added playwright) → any npx cache hit.
 * A candidate only counts once it has actually **launched** a browser: an npx cache often holds a
 * playwright whose browsers were never downloaded (`npx playwright install`), and importing it works
 * fine — the failure only shows up at `chromium.launch()`, half way into a probe.
 *
 * Run one with `PW_PATH=/path/to/playwright/index.mjs node probes/…` to pin a specific install.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./paths.mjs";

function candidates() {
  const out = [];
  if (process.env.PW_PATH) out.push(path.resolve(process.env.PW_PATH));
  out.push(path.join(REPO, "node_modules", "playwright", "index.mjs"));
  const cache = path.join(process.env.LOCALAPPDATA ?? process.env.HOME ?? "", "npm-cache", "_npx");
  try {
    for (const dir of fs.readdirSync(cache)) out.push(path.join(cache, dir, "node_modules", "playwright", "index.mjs"));
  } catch {
    /* no npx cache: fine, the other candidates may still hit */
  }
  return out.filter((f) => f && fs.existsSync(f));
}

let cached = null;

/** `await loadPlaywright()` → the playwright module (usually `{ chromium }`). */
export async function loadPlaywright() {
  if (cached) return cached;
  const tried = candidates();
  const broken = [];
  for (const file of tried) {
    try {
      const mod = await import(pathToFileURL(file).href);
      // Importing is not proof: the browsers may be missing for this version.
      const browser = await mod.chromium.launch();
      await browser.close();
      cached = mod;
      return cached;
    } catch (err) {
      broken.push(`${file}\n      ${String(err?.message ?? err).split("\n")[0]}`);
    }
  }
  throw new Error(
    [
      "找不到能用的 playwright（导入成功但浏览器没下载也算不能用）。试过：",
      ...(broken.length ? broken.map((b) => `  - ${b}`) : ["  （一个都没找到）"]),
      "修：npm i -D playwright && npx playwright install，或运行 npx playwright 让它自己装一次，",
      "再用 PW_PATH 指向 …/playwright/index.mjs。",
    ].join("\n"),
  );
}
