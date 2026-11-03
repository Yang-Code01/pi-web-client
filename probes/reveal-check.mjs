/**
 * Probe: "在文件夹中显示" (D67) — the way out of a preview the viewer cannot render.
 *
 * Two layers, because only one of them is safe to run unattended:
 *
 *   1. `revealCommand()` for all three platforms — pure, no process spawned. This is where the
 *      per-OS difference lives (`explorer /select,` vs `open -R` vs `xdg-open`).
 *   2. The HTTP route on a real bridge: a missing file must be a 400 with a readable message, and a
 *      tunnel caller (`cf-connecting-ip` set) must be refused with 403 — that one matters because the
 *      action happens on the *desktop*, not in the browser.
 *
 * The success path really launches the desktop file manager, so it is opt-in: `REVEAL_OPEN=1` opens a
 * window for the fixture folder. Run that one by hand when changing the launch code.
 *
 * Run: npm run build:bridge && node probes/reveal-check.mjs
 *      REVEAL_OPEN=1 node probes/reveal-check.mjs      # also opens the folder once
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(REPO, ".scratch/reveal-check");
const STATE = path.join(ROOT, "state");
const PORT = 7893;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

// --- 1) command shapes ---------------------------------------------------------------------------
const { revealCommand } = await import(new URL("../bridge/dist/terminal.js", import.meta.url).href);
const win = revealCommand("C:\\Users\\me\\我的 文档\\a.xlsm", "win32");
ok(win.cmd === "explorer.exe", "windows uses explorer.exe");
ok(win.args.length === 1 && win.args[0] === "/select,C:\\Users\\me\\我的 文档\\a.xlsm", `windows passes /select,<file> as one argument (${JSON.stringify(win.args)})`);

const mac = revealCommand("/Users/me/a b/a.xlsm", "darwin");
ok(mac.cmd === "open" && mac.args.join(" ") === "-R /Users/me/a b/a.xlsm", `macOS reveals with open -R (${JSON.stringify(mac.args)})`);

const linux = revealCommand("/home/me/a b/a.xlsm", "linux");
ok(linux.cmd === "xdg-open" && linux.args[0] === "/home/me/a b", `linux opens the directory (${JSON.stringify(linux.args)})`);

// --- 2) the route on a real bridge ---------------------------------------------------------------
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const real = path.join(ROOT, "报告 2026.xlsm");
fs.writeFileSync(real, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01, 0x02])); // zip magic + NULs = binary

const child = spawn(process.execPath, [path.join(REPO, "bridge/dist/index.js")], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_NO_EXT: "1" },
});
const logLines = [];
child.stdout.on("data", (b) => logLines.push(String(b)));
child.stderr.on("data", (b) => logLines.push(String(b)));
const stop = () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);

for (let i = 0; i < 100; i += 1) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(200);
}
const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
ok(Boolean(cookie), "logged in");

const post = (body, headers = {}) =>
  fetch(`${BASE}/api/reveal`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const missing = await post({ path: path.join(ROOT, "不存在的文件.xlsm") });
const missingBody = await missing.json();
ok(missing.status === 400 && /文件不存在/.test(missingBody.error ?? ""), `missing file → 400 「${missingBody.error}」`);

const dir = await post({ path: ROOT });
ok(dir.status === 400 && /目录/.test((await dir.json()).error ?? ""), "a directory is refused (the viewer only calls this with files)");

const tunnel = await post({ path: real }, { "cf-connecting-ip": "203.0.113.9" });
ok(tunnel.status === 403, `tunnel caller → 403 (${(await tunnel.json()).error})`);

if (process.env.REVEAL_OPEN === "1") {
  const opened = await post({ path: real });
  const body = await opened.json();
  ok(opened.status === 200 && body.ok === true, `real file → 200 「${body.message}」`);
  await sleep(800);
  const logged = logLines.join("");
  ok(/reveal .*→ ok/.test(logged), "the bridge logged the reveal");
  console.log(`     ↳ 检查一下桌面：应该弹出一个资源管理器窗口，文件「${path.basename(real)}」被选中`);
} else {
  console.log("skip  成功路径需要真的弹出资源管理器：REVEAL_OPEN=1 node probes/reveal-check.mjs");
}

stop();
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
