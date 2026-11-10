/**
 * `/api/session/image`：会话里的原图按需从文件读。
 *
 * 手写一条带两张图的会话文件，起真 bridge（假 pi，不花模型 turn），然后：
 *   A. 列表里有这个会话；
 *   B. n=0 / n=1 各自拿到对应字节与 mime；
 *   C. 越界 404、负序号 400、不存在的会话 / 条目 404 —— 都是 JSON 错误，不是半截二进制。
 *
 * 端口默认 7893，`SESSION_IMAGE_PORT` 可改；不碰 7864 上的实例。
 *
 *   node bridge/tests/session-image.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO } from "../../tools/paths.mjs";

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.SESSION_IMAGE_PORT ?? 7893);
const ROOT = path.join(REPO, ".scratch", "session-image-e2e");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const BASE = `http://127.0.0.1:${PORT}`;

const SID = "0190cccc-0000-7000-8000-0000000000e1";
const ENTRY = "0190cccc-0000-7000-8000-0000000000e2";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

// 编码规则与 pi / history-paths-ui.mjs 一致：--<绝对路径去掉前导斜杠、斜杠与冒号换成 ->--
const encode = (cwd) => `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const DIR = path.join(AGENT, "sessions", encode(WORK));
fs.mkdirSync(DIR, { recursive: true });

const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-01T00:00:01.000Z";
const file = path.join(DIR, `2026-01-01T00-00-00-000Z_${SID}.jsonl`);
const rows = [
  { type: "session", version: 3, id: SID, timestamp: t0, cwd: WORK },
  {
    type: "message",
    id: ENTRY,
    parentId: null,
    timestamp: t1,
    message: {
      role: "user",
      content: [
        { type: "text", text: "看这两张" },
        { type: "image", mimeType: "image/png", data: PNG_A.toString("base64") },
        { type: "image", mimeType: "image/webp", data: PNG_B.toString("base64") },
      ],
      timestamp: Date.parse(t1),
    },
  },
];
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
};
const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

const shutdown = () => {
  try {
    bridge.kill();
  } catch {
    /* already gone */
  }
};

try {
  for (let i = 0; i < 150; i++) {
    try {
      if (fs.existsSync(path.join(STATE, "passphrase.txt")) && (await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* wait */
    }
    await sleep(200);
  }

  const PASS = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check("登录拿到 cookie", Boolean(cookie));
  const get = (url) => fetch(url, { headers: cookie ? { cookie } : {} });

  const listed = await get(`${BASE}/api/sessions`).then((r) => r.json());
  check("会话列表里能看到这条会话", listed.sessions?.some((s) => s.id === SID), JSON.stringify(listed.sessions?.map((s) => s.id)));

  const image = (n) => get(`${BASE}/api/session/image?id=${encodeURIComponent(SID)}&item=${encodeURIComponent(ENTRY)}&n=${n}`);
  const first = await image(0);
  const firstBytes = Buffer.from(await first.arrayBuffer());
  check("n=0：200 + image/png + 原始字节", first.status === 200 && first.headers.get("content-type") === "image/png" && firstBytes.equals(PNG_A), `${first.status} ${first.headers.get("content-type")} ${firstBytes.length}B`);

  const second = await image(1);
  const secondBytes = Buffer.from(await second.arrayBuffer());
  check("n=1：按序号取到第二张（webp）", second.status === 200 && second.headers.get("content-type") === "image/webp" && secondBytes.equals(PNG_B), `${second.status} ${second.headers.get("content-type")}`);

  const oob = await image(2);
  check("n=2 越界：404 JSON", oob.status === 404 && (await oob.json()).error?.includes("找不到了"), `${oob.status}`);

  const bad = await image(-1);
  check("n=-1：400", bad.status === 400, `${bad.status}`);

  const ghost = await get(`${BASE}/api/session/image?id=nope&item=${encodeURIComponent(ENTRY)}&n=0`);
  check("不存在的会话：404", ghost.status === 404, `${ghost.status}`);

  const ghostEntry = await get(`${BASE}/api/session/image?id=${encodeURIComponent(SID)}&item=nope&n=0`);
  check("不存在的条目：404", ghostEntry.status === 404, `${ghostEntry.status}`);

  const noCache = await image(0);
  check("同一张图走缓存头（immutable）", noCache.headers.get("cache-control")?.includes("immutable") === true, String(noCache.headers.get("cache-control")));
} catch (err) {
  check(`用例未跑完：${String(err?.message ?? err)}`, false);
} finally {
  shutdown();
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n${failed.length} 项失败；bridge 日志尾巴：\n${bridgeLog.split("\n").slice(-40).join("\n")}`);
  process.exit(1);
}
console.log("\n全部通过");
