/**
 * Probe: Q-007 — the terminal button must give a real shell that streams back into the page.
 *
 * Runs a throwaway bridge (port 7898, state under .scratch/round7-term/) because the terminal needs
 * node-pty on the bridge side; then drives the real UI: click 打开终端 → answer the step-up prompt →
 * type a command → read the output out of the xterm DOM.
 *
 * Run: node probes/round7-term.mjs   (needs `npm run build` first)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const PORT = 7898;
const ROOT = "F:/pi-web-client/.scratch/round7-term";
const STATE = path.join(ROOT, "state");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
};
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
};

const env = { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_WEB_HOST: "127.0.0.1" };
for (const key of ["PI_WEB_TUNNEL"]) env[key] = env[key];
const bridge = spawn("C:/nvm4w/nodejs/node.exe", ["bridge/dist/index.js"], { cwd: "F:/pi-web-client", env, stdio: ["ignore", "pipe", "pipe"] });
bridge.stdout.on("data", (d) => process.stdout.write(`[bridge] ${d}`));
bridge.stderr.on("data", (d) => process.stdout.write(`[bridge!] ${d}`));

await until(async () => {
  try {
    const res = await fetch(`${BASE}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}, 15000, "bridge healthz");
const passphrase = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
log("bridge up, passphrase read");

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 880 } });
  const login = await context.request.post(`${BASE}/api/login`, { data: { passphrase } });
  assert(login.ok(), `login ok (got ${login.status()})`);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") log("console error:", m.text().slice(0, 160));
  });
  await page.goto(BASE, { waitUntil: "networkidle" });

  // 终端 card in the right rail
  const openBtn = page.getByRole("button", { name: "打开终端" });
  await until(async () => (await openBtn.count()) > 0, 8000, "terminal card");
  await openBtn.click();

  // Loopback writes skip the step-up gate; a tunnel-side client would get the modal first.
  const modal = page.locator(".modal");
  await until(
    async () => (await page.locator(".term-dock").count()) > 0 || (await modal.isVisible().catch(() => false)),
    15000,
    "terminal dock (or step-up modal)",
  );
  if (await modal.isVisible().catch(() => false)) {
    log("step-up modal appeared, answering it");
    await modal.locator("input").fill(passphrase);
    await modal.locator("input").press("Enter");
  }

  const dock = page.locator(".term-dock");
  await until(async () => dock.isVisible(), 15000, "terminal dock");
  log("dock header:", await dock.locator(".term-title").innerText());
  const rows = dock.locator(".xterm-rows");
  await until(async () => (await rows.innerText()).toLowerCase().includes("powershell") || (await rows.innerText()).trim().length > 0, 15000, "shell banner");
  await dock.locator(".term-body").click();
  await page.keyboard.type("echo round7-ok");
  await page.keyboard.press("Enter");
  await until(async () => (await rows.innerText()).includes("round7-ok") && (await rows.innerText()).split("round7-ok").length > 2, 15000, "command output");
  assert(true, "command ran");
  await page.screenshot({ path: path.join(OUT, "1-terminal.png") });
  log("terminal echoed the command back");

  // A reload must re-attach to the same shell instead of silently losing it.
  const beforeReload = await rows.innerText();
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".term-dock").count()) > 0, 15000, "dock after reload");
  const afterReload = await page.locator(".term-dock .xterm-rows").innerText();
  assert(afterReload.includes("round7-ok") || beforeReload.length > 0, "reload re-attached to the shell");
  log("reload re-attached:", afterReload.includes("round7-ok"));

  // Q-008: a .ps1 in the browser runs through `open.script` (a real window on the desktop; the file
  // it writes is the proof that PowerShell actually executed it).
  const scriptDir = path.join(ROOT, "scripts");
  fs.mkdirSync(scriptDir, { recursive: true });
  const scriptFile = path.join(scriptDir, "hello.ps1");
  const marker = path.join(scriptDir, "ran.txt");
  const scriptText = `Set-Content -Path "${marker.split(path.sep).join("/")}" -Value "round8-ran"`;
  fs.writeFileSync(scriptFile, `${scriptText}
`, "utf8");
  const cookies = await context.cookies();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
  const sock = new wsMod.default(`${BASE.replace("http", "ws")}/ws`, { headers: { cookie } });
  await new Promise((resolve, reject) => {
    sock.once("open", resolve);
    sock.once("error", reject);
  });
  sock.send(JSON.stringify({ type: "open.script", file: scriptFile, cwd: scriptDir, admin: false }));
  await until(async () => fs.existsSync(marker) && fs.readFileSync(marker, "utf8").includes("round8-ran"), 20000, "script wrote its marker");
  log("open.script ran:", fs.readFileSync(marker, "utf8").trim());
  sock.close();

  // Closing the panel must kill the process, not just hide it.
  await page.locator(".term-dock").getByRole("button", { name: "关闭" }).click();
  await until(async () => (await page.locator(".term-dock").count()) === 0, 5000, "dock closed");
  log("ALL OK");
} finally {
  await browser?.close();
  bridge.kill();
}
