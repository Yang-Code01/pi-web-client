/**
 * H1：读会话文件失败，不能变成「对话没了」。
 *
 * 曾经的写法是 catch 里 `items = []`，而且在读之前就把 `tailSig` 提交掉：一次瞬时读失败会广播
 * `items: []`（前端清屏），并且同一个签名再也不会被重试，得重启桥才能恢复。
 *
 * 制造的是真错误而不是假的：文件被别的程序以「独占」方式打开（Windows 上很常见 —— 杀软、编辑器、
 * 另一个 pi 进程）。`statSync` 照样成功，`openSync` 抛 EBUSY。POSIX 上用「同名目录」触发 EISDIR。
 *
 *   node --experimental-transform-types bridge/tests/tail-read-error.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tail-"));
process.env.PI_WEB_STATE = STATE;

const { Session } = await import("../src/sessions.ts");

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

const id = "tttt1111";
const file = path.join(STATE, `${id}.jsonl`);
const meta = {
  file,
  id,
  cwd: process.cwd(),
  startedAt: "2026-11-08T00:00:00.000Z",
  name: null,
  nameAt: null,
  firstUserText: null,
  mtime: Date.now(),
};

const user = (n, text) => ({
  type: "message",
  id: `e${n}`,
  parentId: n === 1 ? null : `e${n - 1}`,
  timestamp: "2026-11-08T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});

const writeAll = (msgs) =>
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id })}\n${msgs.map((n) => JSON.stringify(user(n, `第${n}句`))).join("\n")}\n`);

/** refreshFromFile 用的签名算法，照抄一份好在测试里断言「签名没变」。 */
const sig = (p) => {
  const st = fs.statSync(p);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
};

// 独占打开文件并一直持有句柄（Windows）；POSIX 上没有这种共享模式，改用同名目录制造 EISDIR。
const lock = async (target) => {
  if (process.platform !== "win32") {
    fs.unlinkSync(target);
    fs.mkdirSync(target);
    return { release: async () => fs.rmdirSync(target), error: "EISDIR" };
  }
  const script = `$f=[System.IO.File]::Open("${target}","Open","Read","None"); Write-Output READY; Start-Sleep -Seconds 120; $f.Close()`;
  const child = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("独占句柄没就绪")), 20000);
    child.stdout.once("data", (buf) => {
      if (/READY/.test(String(buf))) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return {
    release: async () => {
      child.kill();
      for (let i = 0; i < 60; i++) {
        try {
          fs.closeSync(fs.openSync(target, "r"));
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      throw new Error("句柄没释放");
    },
    error: "EBUSY",
  };
};

let lockHandle = null;
try {
  // 1. 正常读一次：两条消息进来，没有通知 -----------------------------------
  writeAll([1, 2]);
  const session = new Session(process.execPath, meta);
  const notices = [];
  session.on("ws", (payload) => {
    if (payload?.type === "notice") notices.push(payload);
  });

  session.refreshFromFile();
  check("正常读盘：两条消息", () => assert.equal(session.items.length, 2));
  check("正常读盘：不发通知", () => assert.equal(notices.length, 0));
  const before = sig(file);

  // 2. 文件又长了，但这次读失败：旧对话不能消失，只报一次 --------------------
  writeAll([1, 2, 3]);
  const grown = sig(file);
  check("前提：签名变了", () => assert.notEqual(grown, before));

  lockHandle = await lock(file);
  for (let i = 0; i < 3; i++) session.refreshFromFile();

  check("读失败：旧对话原样保留", () => assert.equal(session.items.length, 2));
  check("读失败：只发一条通知（重试不刷屏）", () => assert.equal(notices.length, 1));
  check("读失败：通知带 code 供界面翻译", () => assert.equal(notices[0]?.code, "session_file_unreadable"));
  check("读失败：通知是 error 级", () => assert.equal(notices[0]?.level, "error"));
  check("读失败：通知里带上真正的原因", () => assert.match(String(notices[0]?.text), new RegExp(lockHandle.error)));
  check("读失败：不动 truncated", () => assert.equal(session.state.truncated, false));

  // 3. 解锁后（签名与失败那次完全相同）：必须自己接上 ------------------------
  // 失败没推进 tailSig，所以这里不会因为「签名没变」被跳过；旧写法会永远停在上一步。
  await lockHandle.release();
  lockHandle = null;
  check("前提：解锁后签名仍是失败那次", () => assert.equal(sig(file), grown));

  session.refreshFromFile();
  check("同签名恢复：真的重试了（第三条消息出现）", () => assert.equal(session.items.length, 3));
  check("同签名恢复：没有多出来的通知", () => assert.equal(notices.length, 1));

  // 4. 从一打开就读不到：构造不抛，items 空 --------------------------------
  const coldFile = path.join(STATE, "bbbb2222.jsonl");
  fs.writeFileSync(coldFile, `${JSON.stringify({ type: "session", id: "bbbb2222" })}\n`);
  lockHandle = await lock(coldFile);
  const cold = new Session(process.execPath, { ...meta, file: coldFile, id: "bbbb2222" });
  check("一开始就读不到：不抛，items 为空", () => assert.deepEqual(cold.items, []));
  await lockHandle.release();
  lockHandle = null;
} finally {
  try {
    await lockHandle?.release();
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nall ok");
process.exit(failures ? 1 : 0);
