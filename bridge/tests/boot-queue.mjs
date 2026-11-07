/**
 * 启动期发出的第一条消息（#197 / D177）：pi 还在加载扩展，桥先收下，气泡立刻出现。
 *
 * 用一个「启动很慢」的桩 pi（FAKE_PI_BOOT_MS）把启动窗口撑开，然后全部从外面看（WS 消息 +
 * 桩 pi 自己的日志，bridge/tests/fixtures/fake-pi.mjs）：
 *   1. `starting` 为真时发 prompt **不报错**：`item.add` 立刻到，item 上带 `pending: "booting"`；
 *   2. 那几秒里桩 pi 一封 prompt 都没收到（消息在桥里排队，没有硬塞给一个还没答话的进程）；
 *   3. 会话名由这条消息决定（左栏不用等 pi 起来就有名字）；
 *   4. `starting` 翻假之后桩 pi 收到这条 prompt（`behavior: null`，第一句不是插话），
 *      同一枚 item 以 `pending: "sent"` 广播一次 `item.replace`；
 *   5. 启动失败（进程在窗口里死了）时气泡留着、标成 `pending: "failed"`，并给一句可读的说明 ——
 *      不能静默消失。完整的重试是 #200。
 *
 * #201 把同一套队列接到另外两个入口上（同一个桩 pi、同一条 WS 连接）：
 *   6. 磁盘上的只读会话直接发消息（自动接管）：气泡**先于**拉起 pi 的握手广播（这是本票最硬的一条）；
 *   7. 点「接管」之后马上打字：接管还在拉 pi，消息照样立刻落地 —— 而且只起一支 pi（单飞）；
 *   8. 自动接管没成（终端里的 pi 还开着）：气泡标成没发出去，并说明原因。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/boot-queue.mjs
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "boot-queue");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const PORT = Number(process.env.PI_WEB_PORT ?? 7877);
const BASE = `http://127.0.0.1:${PORT}`;
/** 启动窗口：够长到「立刻广播」与「就绪后才交给 pi」两件事能分别观察到。 */
const BOOT_MS = 2500;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });

/**
 * 磁盘上的一份会话文件（桥启动前就写好的）：只读会话、以及「终端里还开着」的那个。
 * mtime 拨到一小时前 —— `openLive()` 会把 20 秒内被写过的文件当成「终端里的 pi 可能还开着」。
 * 返回文件路径（桩 pi 的 argv 里要能认出它）。
 */
const writeDiskSession = (id, text) => {
  const file = path.join(AGENT, "sessions", "--fixture--", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const at = new Date(Date.now() - 3600_000).toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      { type: "session", version: 3, id, timestamp: at, cwd: REPO },
      { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  fs.utimesSync(file, new Date(at), new Date(at));
  return file;
};
const DISK_ID = "zz-boot-queue-readonly";
const DISK_FILE = writeDiskSession(DISK_ID, "磁盘里的老会话");
const CLAIM_ID = "zz-boot-queue-claim";
const CLAIM_FILE = writeDiskSession(CLAIM_ID, "接管途中的那个");
const LOCKED_ID = "zz-boot-queue-locked";
writeDiskSession(LOCKED_ID, "终端里还开着");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed += 1;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* bridge not up yet */
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
};

/**
 * 上一轮没退干净的桥要是还占着端口，新桥会 EADDRINUSE，而登录会拿新口令去问旧桥（401）——
 * 两种症状都指向错误的方向。先等端口让出来，等不到就直说。
 */
const portBusy = () =>
  new Promise((resolve) => {
    const probe = net.connect({ port: PORT, host: "127.0.0.1" });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
for (let i = 0; i < 40 && (await portBusy()); i++) await sleep(500);
if (await portBusy()) {
  console.error(`端口 ${PORT} 还被占着（上一次的桥没退干净？）`);
  process.exit(1);
}

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
    FAKE_PI_LOG: PI_LOG,
    FAKE_PI_BOOT_MS: String(BOOT_MS),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

/** 桩 pi 写下的每一行：argv / prompt / boot-slow / exit —— 都是这次「交没交出去」的证据。 */
const records = () =>
  fs.existsSync(PI_LOG)
    ? fs
        .readFileSync(PI_LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const seen = [];
  const waits = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    msg._at = Date.now();
    seen.push(msg);
    for (const w of [...waits]) {
      if (w.pred(msg)) {
        waits.delete(w);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", (e) => j(new Error(`ws: ${e.message}`)));
  });
  const waitFor = (pred, ms, label) => {
    const hit = seen.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const entry = { pred, resolve };
      entry.timer = setTimeout(() => {
        waits.delete(entry);
        reject(new Error(`timeout: ${label}`));
      }, ms);
      waits.add(entry);
    });
  };
  const send = (msg) => ws.send(JSON.stringify(msg));

  // ---------------------------------------------------------------- A. 启动期发第一条
  log(`A. 建会话（桩 pi 要「启动」${BOOT_MS} ms），在窗口里发第一条`);
  // 不给名字：会话名该由启动期发的这条消息决定。
  const mark = seen.length;
  send({ type: "create", cwd: REPO });
  const created = await waitFor((m) => m.type === "session" && m.state?.starting === true && seen.indexOf(m) >= mark, 20000, "session 帧");
  const sid = created.sessionId ?? created.state?.id;
  check(created.state?.starting === true, "刚建好时 starting 为真（这就是启动窗口）");

  const TEXT = "启动期发的第一条";
  const t0 = Date.now();
  send({ type: "prompt", sessionId: sid, text: TEXT, clientId: "local:1" });
  const added = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === sid && m.item?.kind === "user" && m.item?.text === TEXT,
    1500,
    "启动期的 item.add",
  );
  const took = Date.now() - t0;
  check(took < 1000, `气泡在启动窗口里就落地了（${took} ms，pi 还要 ${BOOT_MS} ms 才答话）`);
  check(added.item?.pending === "booting", `item 上带着待发标记（pending=${JSON.stringify(added.item?.pending)}）`);
  check(added.clientId === "local:1", "广播带回了 clientId（那一页据此认领自己的气泡，不重复画）");
  check(!seen.some((m) => m.type === "notice" && m.sessionId === sid && /没|错|失败/.test(String(m.text))), "启动期发消息没有报错");

  const named = await waitFor(
    (m) => m.type === "session.state" && m.session?.id === sid && m.session?.name === TEXT,
    3000,
    "会话名取这条消息",
  );
  check(Boolean(named), `会话名由这条消息决定（左栏不用等 pi 起来就有名字：${named.session?.name}）`);

  check(!records().some((r) => r.t === "prompt"), "窗口里桩 pi 一封 prompt 都没收到（消息在桥里排队）");

  log("等 pi 就绪：第一条要被交出去");
  await waitFor((m) => m.type === "session.state" && m.session?.id === sid && m.session?.starting === false, 20000, "starting=false");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXT), 10000, "pi 收到这条 prompt");
  const delivered = records().find((r) => r.t === "prompt" && r.text === TEXT);
  check(delivered?.behavior === null, `交出去时是「开一轮」而不是插话（behavior=${JSON.stringify(delivered?.behavior ?? null)}）`);
  const replaced = await waitFor(
    (m) => m.type === "item.replace" && m.sessionId === sid && m.id === added.item.id,
    10000,
    "item.replace sent",
  );
  check(replaced.item?.pending === "sent", `就绪后同一枚气泡改成已交出（pending=${JSON.stringify(replaced.item?.pending)}）`);
  check(!seen.some((m) => m.type === "item.remove" && (m.ids ?? []).includes(added.item.id)), "气泡没有被撤掉");

  // ---------------------------------------------------------------- B. 启动失败：气泡留着、给一句话
  log("B. 建第二个会话，在启动窗口里发消息，然后让 pi 在窗口里死掉");
  const mark2 = seen.length;
  send({ type: "create", cwd: REPO, name: "起不来的那个" });
  const created2 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "起不来的那个" && seen.indexOf(m) >= mark2,
    20000,
    "第二个 session 帧",
  );
  const sid2 = created2.sessionId ?? created2.state?.id;
  check(created2.state?.starting === true, "第二个会话也在启动窗口里");

  const TEXT2 = "这条会赶上启动失败";
  send({ type: "prompt", sessionId: sid2, text: TEXT2, clientId: "local:2" });
  const added2 = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === sid2 && m.item?.text === TEXT2,
    1500,
    "第二个 item.add",
  );
  check(added2.item?.pending === "booting", "第二个气泡同样带着待发标记");

  await until(() => records().some((r) => r.t === "argv" && (r.argv ?? []).includes(sid2)), 10000, "第二个桩 pi 的 argv 行");
  const launch = records().filter((r) => r.t === "argv" && (r.argv ?? []).includes(sid2)).at(-1);
  check(Boolean(launch?.pid), `找到这个会话的桩 pi 进程（pid=${launch?.pid}）`);
  process.kill(launch.pid);

  const failedItem = await waitFor(
    (m) => m.type === "item.replace" && m.sessionId === sid2 && m.id === added2.item.id,
    15000,
    "item.replace failed",
  );
  check(failedItem.item?.pending === "failed", `pi 死在窗口里时气泡标成没发出去（pending=${JSON.stringify(failedItem.item?.pending)}）`);
  check(failedItem.item?.text === TEXT2, "气泡内容还在（没有静默消失）");
  const notice = await waitFor(
    (m) => m.type === "notice" && m.sessionId === sid2 && m.level === "error",
    5000,
    "失败的说明",
  );
  check(/没有发出去/.test(String(notice.text)), `给了一句可读的说明（「${notice.text}」）`);
  check(!seen.some((m) => m.type === "item.remove" && (m.ids ?? []).includes(added2.item.id)), "失败时气泡不被撤掉");

  // ---------------------------------------------------------------- C. 只读磁盘会话发消息 = 自动接管，气泡先于握手
  log("C. 只读会话（磁盘上、没在跑）直接发消息：气泡不能等拉起 pi 那几秒");
  send({ type: "subscribe", sessionId: DISK_ID });
  const preview = await waitFor((m) => m.type === "session" && m.sessionId === DISK_ID, 10000, "只读会话的 session 帧");
  check(preview.state?.owned === false && !preview.state?.starting, "先从磁盘只读地看一眼：没有在跑");

  const TEXT3 = "只读会话里发的第一句";
  const mark3 = seen.length;
  const t3 = Date.now();
  send({ type: "prompt", sessionId: DISK_ID, text: TEXT3, clientId: "local:3" });
  const added3 = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === DISK_ID && m.item?.text === TEXT3,
    1500,
    "只读会话的 item.add",
  );
  const took3 = Date.now() - t3;
  check(took3 < 1000, `气泡在握手之前就落地了（${took3} ms，桩 pi 还要 ${BOOT_MS} ms 才答话）`);
  check(added3.item?.pending === "booting", `带待发标记（pending=${JSON.stringify(added3.item?.pending)}）`);
  check(added3.clientId === "local:3", "广播带回 clientId（那一页据此认领，不重复画）");
  check(!records().some((r) => r.t === "prompt" && r.text === TEXT3), "窗口里没有硬塞给一个还没答话的 pi");
  check(
    !seen.some((m) => m.type === "notice" && m.sessionId === DISK_ID && m.level === "error"),
    "自动接管没有报错",
  );

  await waitFor((m) => m.type === "session.state" && m.session?.id === DISK_ID && m.session?.starting === false, 20000, "只读会话 starting=false");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXT3), 10000, "桩 pi 收到只读会话这条 prompt");
  const delivered3 = records().find((r) => r.t === "prompt" && r.text === TEXT3);
  check(delivered3?.behavior === null, `就绪后开一轮（behavior=${JSON.stringify(delivered3?.behavior ?? null)}）`);
  const argv3 = records().filter((r) => r.t === "argv" && (r.argv ?? []).includes(DISK_FILE));
  check(argv3.length === 1, `这个会话的 pi 只起了一次（argv 里带磁盘文件：${argv3.length} 次）`);
  check(
    argv3[0]?.argv?.includes("--session") ?? false,
    "接管走的是 resume（--session <文件>），不是新会话",
  );
  const replaced3 = await waitFor((m) => m.type === "item.replace" && m.sessionId === DISK_ID && m.id === added3.item.id, 10000, "只读会话 item.replace sent");
  check(replaced3.item?.pending === "sent", `同一枚气泡改成已交出（pending=${JSON.stringify(replaced3.item?.pending)}）`);
  const owned3 = await waitFor((m) => m.type === "session.state" && m.session?.id === DISK_ID && m.session?.owned === true, 10000, "owned 翻转");
  check(Boolean(owned3), "发完之后这个会话已经是网页的了（自动接管）");
  // 这一条要等整个握手过去再看：气泡的帧必须排在「开始拉起 pi」（starting:true）之前，
  // 也就是用户打完字的那一刻就看见了它，而不是等拉起 pi + get_state 回来。
  const added3At = seen.indexOf(added3);
  const started3 = seen.findIndex((m) => m.type === "session.state" && m.session?.id === DISK_ID && m.session?.starting === true);
  check(
    started3 > 0 && added3At < started3,
    `item.add 排在「开始拉起 pi」之前（item#${added3At} < starting#${started3}）`,
  );
  check(seen.length > mark3, "上面几帧都是这次发消息之后才来的");

  // ---------------------------------------------------------------- D. 接管途中打字：立刻落地，只起一支 pi
  log("D. 点接管之后马上打字：接管还在拉 pi，消息也要立刻落地，而且不能因此把 pi 起两支");
  send({ type: "subscribe", sessionId: CLAIM_ID });
  const preview4 = await waitFor((m) => m.type === "session" && m.sessionId === CLAIM_ID, 10000, "第二个只读会话的 session 帧");
  check(preview4.state?.owned === false, "第二个会话也是只读的");

  // 两条消息连着发、中间不等：claim 才进入 openLive（它还卡在 pinPermission 上），prompt 就到了。
  send({ type: "claim", sessionId: CLAIM_ID });
  const TEXT4 = "接管途中打的字";
  const t4 = Date.now();
  send({ type: "prompt", sessionId: CLAIM_ID, text: TEXT4, clientId: "local:4" });
  const added4 = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === CLAIM_ID && m.item?.text === TEXT4,
    1500,
    "接管途中的 item.add",
  );
  const took4 = Date.now() - t4;
  check(took4 < 1000, `接管途中发消息，气泡照样立刻出现（${took4} ms）`);
  check(added4.item?.pending === "booting", `同样带着待发标记（pending=${JSON.stringify(added4.item?.pending)}）`);

  await waitFor((m) => m.type === "session.state" && m.session?.id === CLAIM_ID && m.session?.starting === false, 20000, "接管会话 starting=false");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXT4), 10000, "桩 pi 收到接管途中那条");
  const argv4 = records().filter((r) => r.t === "argv" && (r.argv ?? []).includes(CLAIM_FILE));
  check(argv4.length === 1, `claim 和 prompt 同时来，pi 只起了一支（${argv4.length} 次）`);
  check(records().filter((r) => r.t === "prompt" && r.text === TEXT4).length === 1, "这条消息只交出去一次");
  const replaced4 = await waitFor((m) => m.type === "item.replace" && m.sessionId === CLAIM_ID && m.id === added4.item.id, 10000, "接管途中 item.replace sent");
  check(replaced4.item?.pending === "sent", "气泡最后是已交出");

  // ---------------------------------------------------------------- E. 自动接管没成：气泡标红、说明原因
  log("E. 终端里的 pi 还开着（有 tty 锁）：自动接管会被拒，气泡要标成没发出去");
  fs.mkdirSync(path.join(STATE, "locks"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "locks", `${LOCKED_ID}.tty.json`), JSON.stringify({ pid: process.pid, at: Date.now() }));
  send({ type: "subscribe", sessionId: LOCKED_ID });
  await waitFor((m) => m.type === "session" && m.sessionId === LOCKED_ID, 10000, "被锁住的会话的 session 帧");
  const TEXT5 = "这条会被锁挡住";
  send({ type: "prompt", sessionId: LOCKED_ID, text: TEXT5, clientId: "local:5" });
  const added5 = await waitFor((m) => m.type === "item.add" && m.sessionId === LOCKED_ID && m.item?.text === TEXT5, 5000, "被锁会话的 item.add");
  check(added5.item?.pending === "booting", "气泡先落地（哪怕是注定发不出去的）");
  const failed5 = await waitFor((m) => m.type === "item.replace" && m.sessionId === LOCKED_ID && m.id === added5.item.id, 10000, "被锁会话的 item.replace failed");
  check(failed5.item?.pending === "failed", `接管被拒时气泡标成没发出去（pending=${JSON.stringify(failed5.item?.pending)}）`);
  check(failed5.item?.text === TEXT5, "气泡内容还在");
  const why5 = await waitFor((m) => m.type === "notice" && m.level === "error" && /终端里的 pi/.test(String(m.text)), 10000, "被拒绝的原因");
  check(Boolean(why5), `说清楚了原因（「${why5.text}」）`);
  check(!records().some((r) => r.t === "argv" && (r.argv ?? []).includes(LOCKED_ID)), "没有去动那个会话（一支 pi 都没起）");

  ws.close();
} catch (err) {
  failed += 1;
  console.error("ERROR", err?.message ?? err);
  console.error(bridgeOut.join("").slice(-1500));
} finally {
  bridge.kill();
}
log(failed ? `FAILED (${failed})` : "PASS");
process.exit(failed ? 1 : 0);
