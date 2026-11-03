/**
 * Where the bridge looks for session files must match where pi writes them (#20).
 *
 *   node bridge/tests/session-dirs.mjs        (Node ≥ 22.18 strips the .ts types itself)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, sessionsRootInfo } from "../src/paths.ts";
import { listSessionFiles } from "../src/sessionfile.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "session-dirs");
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const KEYS = ["PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const env = (vars) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
};
let n = 0;
const ok = (msg) => console.log(`  ok ${++n}  ${msg}`);

try {
  const agent = path.join(ROOT, "agent");
  fs.mkdirSync(agent, { recursive: true });
  const settings = (value) => fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify(value));

  // 1. pi's variable, not the old PI_AGENT_DIR spelling.
  env({ PI_CODING_AGENT_DIR: agent });
  assert.equal(agentDir(), agent);
  assert.deepEqual(sessionsRootInfo(), { dir: path.join(agent, "sessions"), source: "default" });
  ok("PI_CODING_AGENT_DIR picks the agent dir; sessions default under it");

  // 2. Global settings.sessionDir (absolute) is honoured.
  const custom = path.join(ROOT, "custom-sessions");
  settings({ sessionDir: custom });
  assert.deepEqual(sessionsRootInfo(), { dir: custom, source: "settings.sessionDir" });
  ok("settings.json sessionDir (absolute)");

  // 3. A relative one is per-project in pi: no single folder, fall back to the default.
  settings({ sessionDir: "rel/sessions" });
  assert.equal(sessionsRootInfo().source, "default");
  ok("relative settings.sessionDir falls back to the default");

  // 4. The env variable beats settings, like pi's main.js.
  settings({ sessionDir: custom });
  const fromEnv = path.join(ROOT, "env-sessions");
  env({ PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: fromEnv });
  assert.deepEqual(sessionsRootInfo(), { dir: fromEnv, source: "PI_CODING_AGENT_SESSION_DIR" });
  ok("PI_CODING_AGENT_SESSION_DIR beats settings.sessionDir");

  // 5. `~/` expands to the home dir, as pi's normalizePath does.
  env({ PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: "~/pi-sessions-x" });
  assert.equal(sessionsRootInfo().dir, path.join(os.homedir(), "pi-sessions-x"));
  ok("~/ expansion");

  // 6. The bridge-only test seam still wins over everything.
  const seam = path.join(ROOT, "seam");
  env({ PI_AGENT_DIR: seam, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: fromEnv });
  assert.deepEqual(sessionsRootInfo(), { dir: path.join(seam, "sessions"), source: "PI_AGENT_DIR" });
  ok("PI_AGENT_DIR test seam");

  // 7. Listing: flat files (custom dir layout) + per-cwd folders (default layout), no cap.
  const mk = (file, id, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [
      { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: ROOT },
      { type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }] } },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };
  const list = path.join(ROOT, "list");
  for (let i = 0; i < 70; i++) mk(path.join(list, `2026-01-01T00-00-${String(i).padStart(2, "0")}_flat${i}.jsonl`), `flat${i}`, `flat ${i}`);
  for (let i = 0; i < 65; i++) mk(path.join(list, "--E--proj--", `2026-01-02T00-00-${String(i).padStart(2, "0")}_nest${i}.jsonl`), `nest${i}`, `nest ${i}`);
  let metas = listSessionFiles(list);
  assert.equal(metas.length, 135);
  assert.ok(metas.some((m) => m.id === "flat0") && metas.some((m) => m.id === "nest0"));
  ok("flat + nested layouts listed, 135 sessions, nothing hidden by a per-folder cap");

  // 8. The meta cache notices a changed file.
  const target = path.join(list, "--E--proj--", "2026-01-02T00-00-00_nest0.jsonl");
  fs.appendFileSync(target, JSON.stringify({ type: "session_info", id: "i1", parentId: "m1", timestamp: new Date().toISOString(), name: "renamed" }) + "\n");
  metas = listSessionFiles(list);
  assert.equal(metas.find((m) => m.id === "nest0")?.name, "renamed");
  fs.rmSync(target);
  metas = listSessionFiles(list);
  assert.equal(metas.length, 134);
  ok("cached metadata follows edits and deletions");

  console.log("PASS");
} finally {
  env(Object.fromEntries(KEYS.filter((k) => saved[k] !== undefined).map((k) => [k, saved[k]])));
}
