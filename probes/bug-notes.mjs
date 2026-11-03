/**
 * 顶栏 🐞 bug 记录（D108）：桥端一整条链路。
 *
 * 真的起一台隔离桥（临时 PI_WEB_STATE / PI_AGENT_DIR、端口 7899），不碰 pi、不花模型调用，
 * 用一条真 WS 走完：hello 带 notes → 存一条（标题从正文首行推出来）→ 改状态 →
 * 贴图落到 assets/<id>/ → /api/image 能读回来 → 删图 → 删记录（连目录一起）→
 * 坏输入被拒（非图片 data URL、错 kind、不存在 id）。
 * 落盘断言看的是 bug-notes.json 本体，不是桥回了什么。
 *
 * 跑：node probes/bug-notes.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "file:///F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.PI_WEB_PORT ?? 7891);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notes-state-"));
const AGENT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-notes-agent-"));
const FILE = path.join(STATE, "notes", "bug-notes.json");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const until = async (fn, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`超时：${what}`);
};
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { version: 1, notes: [] };
  }
};

/** 1×1 的 PNG（真图片，走真解码路径）。 */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const child = spawn(process.execPath, [BRIDGE], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_AGENT_DIR: AGENT, PI_WEB_NO_EXT: "1" },
});
child.stderr.on("data", (b) => {
  const line = String(b).trim();
  if (line) log("bridge:", line.slice(0, 200));
});
const stop = () => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);

try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => {
    try {
      return (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 20000, "healthz");
  const passphrase = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check("登录拿到 cookie", login.ok && cookie.includes("="), cookie.slice(0, 24));

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const inbox = [];
  ws.on("message", (raw) => {
    try {
      inbox.push(JSON.parse(String(raw)));
    } catch {
      /* ignore */
    }
  });
  const send = (msg) => ws.send(JSON.stringify(msg));
  const wait = async (type, pred = () => true, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const at = inbox.findIndex((m) => m.type === type && pred(m));
      if (at >= 0) return inbox.splice(at, 1)[0];
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`没等到 ${type}`);
  };

  // ---- hello 载着记录一起来
  const hello = await wait("hello");
  check("hello 带 notes 数组", Array.isArray(hello.notes) && hello.notes.length === 0, JSON.stringify(hello.notes));

  // ---- 1. 存一条：没有标题，从正文首行推
  send({ type: "notes.save", kind: "bug", mode: "quick", title: "", body: "手机横屏时顶栏被挤出屏幕\n390px 下 scrollWidth 是 730" });
  const saved1 = await wait("notes.saved");
  const n1 = saved1.note;
  check("notes.saved 回了一条", Boolean(n1?.id), JSON.stringify(saved1));
  check("标题取正文首行", n1.title === "手机横屏时顶栏被挤出屏幕", n1.title);
  check("默认待处理 / 类型 bug", n1.status === "pending" && n1.kind === "bug", `${n1.status}/${n1.kind}`);
  check("落盘一份", read().notes.length === 1 && read().notes[0].id === n1.id, FILE);
  const list1 = await wait("notes");
  check("写后广播 notes", list1.notes.length === 1 && list1.notes[0].id === n1.id);

  // ---- 2. 更新：同一 id 改正文，不该多一条
  send({ type: "notes.save", id: n1.id, kind: "bug", mode: "form", title: "顶栏溢出", body: "改过的正文", issue: "#52" });
  const saved2 = await wait("notes.saved", (m) => m.note?.id === n1.id);
  check("同 id 是更新", read().notes.length === 1 && read().notes[0].body === "改过的正文", JSON.stringify(read().notes[0].body));
  check("issue 一起存下", read().notes[0].issue === "#52" && saved2.note.issue === "#52");
  check("createdAt 不变、updatedAt 前进", read().notes[0].createdAt === n1.createdAt && read().notes[0].updatedAt >= n1.updatedAt);

  // ---- 3. 换状态
  send({ type: "notes.status", id: n1.id, status: "done", commit: "bd8c4ef" });
  await until(() => read().notes[0].status === "done", 4000, "status=done");
  check("status 落盘 + commit", read().notes[0].commit === "bd8c4ef", JSON.stringify(read().notes[0].commit));
  send({ type: "notes.status", id: n1.id, status: "nope" });
  const badStatus = await wait("notes.saved", (m) => Boolean(m.error)).catch(() => null);
  check("错 status 被拒并回 error", /status/.test(String(badStatus?.error)), badStatus?.error ?? "（没有回执）");
  check("被拒之后状态没变", read().notes[0].status === "done");

  // ---- 4. 贴图：落 assets/<id>/、能通过 /api/image 读回来
  send({ type: "notes.shot", id: n1.id, data: PNG });
  const shot1 = await wait("notes.shot", (m) => !m.error);
  check("回绝对路径", path.isAbsolute(String(shot1.path)), String(shot1.path));
  check("文件真的在", fs.existsSync(shot1.path), shot1.path);
  check("在 assets/<id>/ 下", path.dirname(shot1.path) === path.join(STATE, "notes", "assets", n1.id), path.dirname(shot1.path));
  check("shots 写进 json", read().notes[0].shots.length === 1 && read().notes[0].shots[0] === shot1.path);
  const img = await fetch(`${BASE}/api/image?path=${encodeURIComponent(shot1.path)}`, { headers: { cookie } });
  check("/api/image 读得回缩略图", img.ok && img.headers.get("content-type") === "image/png", `${img.status} ${img.headers.get("content-type")}`);

  // ---- 5. 第二张 + 删掉第一张
  send({ type: "notes.shot", id: n1.id, data: PNG });
  const shot2 = await wait("notes.shot", (m) => !m.error && m.path !== shot1.path);
  check("第二张换名（不覆盖）", shot2.path !== shot1.path, path.basename(shot2.path));
  send({ type: "notes.shot.remove", id: n1.id, path: shot1.path });
  await until(() => !fs.existsSync(shot1.path), 4000, "图片被删");
  check("删图后 json 只剩第二张", read().notes[0].shots.length === 1 && read().notes[0].shots[0] === shot2.path);
  send({ type: "notes.shot", id: n1.id, data: "data:text/plain;base64,aGk=" });
  const shotBad = await wait("notes.shot", (m) => Boolean(m.error));
  check("非图片 data URL 被拒", Boolean(shotBad.error), shotBad.error);

  // ---- 5.5 归档 / 垃圾箱 / 清空（记录先不真删，只打标记）
  send({ type: "notes.save", kind: "idea", body: "临时：归档和垃圾箱" });
  const n2 = (await wait("notes.saved", (m) => !m.error && m.note?.body === "临时：归档和垃圾箱")).note;
  send({ type: "notes.life", id: n2.id, life: "archived" });
  await wait("notes.saved", (m) => m.note?.id === n2.id && m.note.archivedAt);
  check("归档只打时间戳，记录还在", read().notes.length === 2 && read().notes.find((n) => n.id === n2.id).archivedAt > 0);
  send({ type: "notes.life", id: n2.id, life: "active" });
  await until(() => !read().notes.find((n) => n.id === n2.id).archivedAt, 4000, "复原清掉 archivedAt");
  check("复原清掉归档时间", !read().notes.find((n) => n.id === n2.id).deletedAt);
  send({ type: "notes.life", id: n2.id, life: "nope" });
  const badLife = await wait("notes.saved", (m) => Boolean(m.error));
  check("错 life 被拒", /life/.test(String(badLife.error)), badLife.error);
  send({ type: "notes.life", id: n2.id, life: "trashed" });
  await until(() => read().notes.find((n) => n.id === n2.id)?.deletedAt > 0, 4000, "deletedAt");
  check("删到垃圾箱仍留在 JSON 里", read().notes.length === 2);
  send({ type: "notes.purge" });
  await until(() => read().notes.length === 1, 4000, "清空垃圾箱");
  check("清空垃圾箱只清掉垃圾箱里那条", read().notes[0].id === n1.id);

  // ---- 6. 删记录：连 assets/<id>/ 一起
  send({ type: "notes.delete", id: n1.id });
  await until(() => read().notes.length === 0, 4000, "记录被删");
  check("assets 目录也清掉", !fs.existsSync(path.join(STATE, "notes", "assets", n1.id)));

  // ---- 7. 坏 kind / 不存在 id
  send({ type: "notes.save", kind: "wat", body: "x" });
  const badKind = await wait("notes.saved", (m) => Boolean(m.error));
  check("错 kind 被拒", /kind/.test(String(badKind.error)), badKind.error);
  send({ type: "notes.status", id: "nope-123", status: "done" });
  const badId = await wait("notes.saved", (m) => /已经不在了/.test(String(m.error))).catch(() => null);
  check("不存在 id 回 error", Boolean(badId), badId?.error ?? "（没有回执）");

  // ---- 8. 重启后还在
  send({ type: "notes.save", kind: "idea", body: "重启也要还在" });
  const last = await wait("notes.saved", (m) => !m.error && m.note?.body === "重启也要还在");
  check("再存一条想法", last.note.kind === "idea", last.note.kind);
  check("存完立刻就在文件里", read().notes.some((n) => n.body === "重启也要还在"), JSON.stringify(read().notes.map((n) => n.body)));
  ws.close();
  stop();
  await until(() => read().notes.length >= 1, 4000, "落盘");
  check("桥杀掉之后 json 仍在", read().notes.some((n) => n.body === "重启也要还在"));
} finally {
  stop();
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exitCode = failures ? 1 : 0;
