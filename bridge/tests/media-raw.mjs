/**
 * Probe: 视频 / 音频预览的桥端行为（#542）—— 只走 HTTP：`/api/preview` 与 `/raw/<token>/`。
 *
 * Covers: 视频 / 音频扩展名的 kind（avi 也算 video，由前端降级）；`/raw` 的 MIME；HTTP Range
 * （无 Range → 200 + Accept-Ranges、`a-b` / `a-` / `-n` → 206 + Content-Range、越界 → 416、
 * 多段 → 200 整份、HEAD 与 GET 头一致无 body）；html 注入那条路不受影响。
 *
 * 自带丢弃式 bridge + 脚本化 pi，不花模型 turn、不碰 7864。端口由系统分配，可用 MEDIA_PORT 钉住。
 *
 *   node bridge/tests/media-raw.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { freePort } from "../../tools/free-port.mjs";

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.MEDIA_PORT ?? (await freePort()));
const ROOT = path.join(REPO, ".scratch", "media-raw");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "media-raw-pass";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, AGENT, WORK]) fs.mkdirSync(d, { recursive: true });
// 100 个可辨认的字节：第 i 个字节就是 i，区间对不对一眼看得出。
const BYTES = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
const MEDIA = {
  "clip.mp4": ["video", "video/mp4"],
  "clip.m4v": ["video", "video/mp4"],
  "clip.webm": ["video", "video/webm"],
  "clip.ogv": ["video", "video/ogg"],
  "clip.mov": ["video", "video/quicktime"],
  "clip.mkv": ["video", "video/x-matroska"],
  "clip.avi": ["video", "video/x-msvideo"],
  "clip.wmv": ["video", "video/x-ms-wmv"],
  "clip.flv": ["video", "video/x-flv"],
  "tune.mp3": ["audio", "audio/mpeg"],
  "tune.wav": ["audio", "audio/wav"],
  "tune.m4a": ["audio", "audio/mp4"],
  "tune.aac": ["audio", "audio/aac"],
  "tune.ogg": ["audio", "audio/ogg"],
  "tune.oga": ["audio", "audio/ogg"],
  "tune.flac": ["audio", "audio/flac"],
  "tune.opus": ["audio", "audio/ogg"],
};
for (const name of Object.keys(MEDIA)) fs.writeFileSync(path.join(WORK, name), BYTES);
fs.writeFileSync(path.join(WORK, "page.html"), "<!doctype html><title>p</title><p>hi</p>", "utf8");

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_WHATS_NEW: "0",
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  FAKE_PI_LOG: path.join(ROOT, "fake-pi.jsonl"),
};
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* wait */
    }
    await sleep(200);
  }
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const seen = [];
  ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "media" }));
  let sid = null;
  for (let i = 0; i < 300 && !sid; i++) {
    sid = seen.find((m) => m.type === "session" && m.state?.id)?.state.id ?? null;
    if (!sid) await sleep(100);
  }
  if (!sid) throw new Error("no session");

  const preview = async (p) => {
    const res = await fetch(`${BASE}/api/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ sessionId: sid, path: p }),
    });
    return res.json();
  };
  const rawUrl = (info) => `${BASE}/raw/${info.token}/${info.rel}`;

  // ── kind + MIME ──
  for (const [name, [kind, mime]] of Object.entries(MEDIA)) {
    const info = await preview(name);
    check(`${name} → kind=${kind}`, info.kind === kind, JSON.stringify(info.kind ?? info));
    const res = await fetch(rawUrl(info));
    check(`${name} → content-type ${mime}`, res.headers.get("content-type") === mime, String(res.headers.get("content-type")));
    await res.arrayBuffer();
  }

  // ── Range ──
  const info = await preview("clip.mp4");
  const url = rawUrl(info);
  const get = async (range, method = "GET") => {
    const res = await fetch(url, { method, headers: range ? { range } : {} });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, h: res.headers, body };
  };

  const full = await get(null);
  check("无 Range → 200", full.status === 200, String(full.status));
  check("无 Range → Accept-Ranges: bytes", full.h.get("accept-ranges") === "bytes", String(full.h.get("accept-ranges")));
  check("无 Range → 整份字节", full.body.equals(BYTES), String(full.body.length));

  const ab = await get("bytes=10-19");
  check("bytes=10-19 → 206", ab.status === 206, String(ab.status));
  check("bytes=10-19 → Content-Range", ab.h.get("content-range") === "bytes 10-19/100", String(ab.h.get("content-range")));
  check("bytes=10-19 → Content-Length 10", ab.h.get("content-length") === "10", String(ab.h.get("content-length")));
  check("bytes=10-19 → 字节 10..19", ab.body.equals(BYTES.subarray(10, 20)), JSON.stringify([...ab.body]));

  const open = await get("bytes=95-");
  check("bytes=95- → 206 尾段", open.status === 206 && open.h.get("content-range") === "bytes 95-99/100" && open.body.equals(BYTES.subarray(95)), `${open.status} ${open.h.get("content-range")}`);

  const suffix = await get("bytes=-5");
  check("bytes=-5 → 206 最后 5 字节", suffix.status === 206 && suffix.h.get("content-range") === "bytes 95-99/100" && suffix.body.equals(BYTES.subarray(95)), `${suffix.status} ${suffix.h.get("content-range")}`);

  const clamp = await get("bytes=90-500");
  check("bytes=90-500 → 截到文件尾", clamp.status === 206 && clamp.h.get("content-range") === "bytes 90-99/100" && clamp.body.length === 10, `${clamp.status} ${clamp.h.get("content-range")}`);

  const beyond = await get("bytes=100-");
  check("起点越界 → 416", beyond.status === 416, String(beyond.status));
  check("416 → Content-Range: bytes */100", beyond.h.get("content-range") === "bytes */100", String(beyond.h.get("content-range")));

  const multi = await get("bytes=0-1,5-6");
  check("多段 → 200 整份", multi.status === 200 && multi.body.equals(BYTES), String(multi.status));

  const junk = await get("items=0-1");
  check("不认识的单位 → 200 整份", junk.status === 200 && junk.body.equals(BYTES), String(junk.status));

  const head = await get(null, "HEAD");
  check("HEAD → 200 无 body", head.status === 200 && head.body.length === 0, `${head.status} ${head.body.length}`);
  check("HEAD → 头与 GET 一致", head.h.get("content-length") === "100" && head.h.get("accept-ranges") === "bytes" && head.h.get("content-type") === "video/mp4");

  const headRange = await get("bytes=0-9", "HEAD");
  check("HEAD + Range → 206 无 body", headRange.status === 206 && headRange.body.length === 0 && headRange.h.get("content-length") === "10", `${headRange.status}`);

  // ── html 注入那条路不受影响 ──
  const page = await preview("page.html");
  const html = await fetch(rawUrl(page), { headers: { range: "bytes=0-3" } });
  const text = await html.text();
  check("html 仍整份返回（含注入脚本），不做 Range", html.status === 200 && text.includes("<p>hi</p>") && text.length > 50, `${html.status} ${text.length}`);

  ws.close();
} catch (err) {
  console.error(bridgeLog.slice(-3000));
  check(`unexpected: ${err?.message ?? String(err)}`, false);
} finally {
  bridge.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exitCode = 1;
}
