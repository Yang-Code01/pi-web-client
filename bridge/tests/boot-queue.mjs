/**
 * 启动期发出的第一条消息（#197 / D177）与启动失败后的重试（#200）。
 *
 * 用一个「启动很慢」的桩 pi（FAKE_PI_BOOT_MS）把启动窗口撑开，然后全部从外面看（WS 消息 +
 * 桩 pi 自己的日志，bridge/tests/fixtures/fake-pi.mjs）：
 *   1. `starting` 为真时发 prompt **不报错**：`item.add` 立刻到，item 上带 `pending: "booting"`；
 *   2. 那几秒里桩 pi 一封 prompt 都没收到（消息在桥里排队，没有硬塞给一个还没答话的进程）；
 *   3. 会话名由这条消息决定（左栏不用等 pi 起来就有名字）；
 *   4. `starting` 翻假之后桩 pi 收到这条 prompt（`behavior: null`，第一句不是插话），
 *      同一枚 item 以 `pending: "sent"` 广播一次 `item.replace`；
 *   5. 启动失败（进程在窗口里死了）时气泡留着、标成 `pending: "failed"`，并给一句人话 ——
 *      不能静默消失，也不许把 exit code 这种东西甩给用户；
 *   6. 点「重试」（前端发的就是现有的 `claim` 帧）→ 重新拉起 pi → 就绪后按原顺序把没发出去的
 *      两条补发，带 `pending: "sent"` 回到正常态；
 *   7. pi 起来了但拒收这一条（`disposition: "handled"` + `error`）也走同一条失败/重试路。
 *
 * #201 把同一套队列接到另外两个入口上（同一个桩 pi、同一条 WS 连接）：
 *   6. 磁盘上的只读会话直接发消息（自动接管）：气泡**先于**拉起 pi 的握手广播（这是本票最硬的一条）；
 *   7. 点「接管」之后马上打字：接管还在拉 pi，消息照样立刻落地 —— 而且只起一支 pi（单飞）；
 *   8. 自动接管没成（终端里的 pi 还开着）：气泡标成没发出去，并说明原因；
 *   9. 挡路的东西没了再点「重试」：同一枚气泡回到待发、补发出去变「已交出」，不重复画、不重起 pi。
 *
 * #202 把启动期最容易漏掉的三种边界输入钉在同一只泵上：
 *   F. 带图的那条：气泡上记着两张图，就绪后图片跟着**同一条** prompt 交给 pi（不是只交文本），
 *     后面的纯文本不会被顺带塞图，顺序也不变；
 *   G. 粘贴块（长文本）：气泡里的与交给 pi 的是同一份，缩进 / 制表符 / 行尾空格一个不动；
 *   H. `!` 命令：bash 走的是 RPC 的 bash，pi 没起来就没有这条通道 —— 不排队、不静默丢，
 *     明说一句「还在启动」；就绪之后同一条命令照常能跑。
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
const LOCKED_FILE = writeDiskSession(LOCKED_ID, "终端里还开着");

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
  log("B. 建第二个会话，在启动窗口里连发两条，然后让 pi 在窗口里死掉");
  const mark2 = seen.length;
  send({ type: "create", cwd: REPO, name: "起不来的那个" });
  const created2 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "起不来的那个" && seen.indexOf(m) >= mark2,
    20000,
    "第二个 session 帧",
  );
  const sid2 = created2.sessionId ?? created2.state?.id;
  check(created2.state?.starting === true, "第二个会话也在启动窗口里");

  const TEXTS2 = ["这条会赶上启动失败", "同一批的第二条"];
  const added2 = [];
  for (const [i, text] of TEXTS2.entries()) {
    send({ type: "prompt", sessionId: sid2, text, clientId: `local:2:${i}` });
    const item = await waitFor((m) => m.type === "item.add" && m.sessionId === sid2 && m.item?.text === text, 1500, `第二个 item.add #${i}`);
    check(item.item?.pending === "booting", `第 ${i + 1} 条气泡带着待发标记`);
    added2.push(item);
  }

  const launches2 = () => records().filter((r) => r.t === "argv" && (r.argv ?? []).includes(sid2));
  await until(() => launches2().length > 0, 10000, "第二个桩 pi 的 argv 行");
  const launch = launches2().at(-1);
  check(Boolean(launch?.pid), `找到这个会话的桩 pi 进程（pid=${launch?.pid}）`);
  process.kill(launch.pid);

  for (const added of added2) {
    const failedItem = await waitFor(
      (m) => m.type === "item.replace" && m.sessionId === sid2 && m.id === added.item.id,
      15000,
      "item.replace failed",
    );
    check(failedItem.item?.pending === "failed", `pi 死在窗口里时气泡标成没发出去（pending=${JSON.stringify(failedItem.item?.pending)}）`);
    check(failedItem.item?.text === added.item.text, "气泡内容还在（没有静默消失）");
  }
  const notice = await waitFor((m) => m.type === "notice" && m.sessionId === sid2 && m.level === "error", 5000, "失败的说明");
  check(/没有发出去/.test(String(notice.text)), `给了一句可读的说明（「${notice.text}」）`);
  check(!/exit code|signal=|spawn|ENOENT/i.test(String(notice.text)), "说明里没有 exit code 之类的内部话术");
  check(!seen.some((m) => m.type === "item.remove" && added2.some((a) => (m.ids ?? []).includes(a.item.id))), "失败时气泡不被撤掉");

  // ---------------------------------------------------------------- B2. 点重试 → 拉起 pi → 按序补发
  log("B2. 重试（前端发的就是 claim 帧）：重新拉起 pi，就绪后按原顺序补发两条");
  const markRetry = seen.length;
  send({ type: "claim", sessionId: sid2 });
  const reclaimed = await waitFor(
    (m) => m.type === "session" && (m.sessionId ?? m.state?.id) === sid2 && m.state?.starting === true && seen.indexOf(m) >= markRetry,
    20000,
    "重试后的 session 帧（starting 为真）",
  );
  check(Boolean(reclaimed), "重试先走接管路径：spawn 之后会话说自己在启动");
  await waitFor((m) => m.type === "session.state" && m.session?.id === sid2 && m.session?.starting === false, 20000, "重试后 starting=false");
  await until(() => launches2().length > 1, 15000, "重试拉起的新进程");
  const respawned = launches2().at(-1);
  check(respawned?.pid !== launch.pid, `真的重新起了一个进程（旧 ${launch.pid} → 新 ${respawned?.pid}）`);

  for (const [i, text] of TEXTS2.entries()) {
    await until(() => records().some((r) => r.t === "prompt" && r.text === text), 15000, `补发的第 ${i + 1} 条`);
  }
  const resent = records().filter((r) => r.t === "prompt" && TEXTS2.includes(r.text));
  check(
    JSON.stringify(resent.map((r) => r.text)) === JSON.stringify(TEXTS2),
    `补发顺序和原来一致（${resent.map((r) => r.text).join(" → ")}）`,
  );
  check(resent[0]?.behavior === null, `第一条照旧开一轮（behavior=${JSON.stringify(resent[0]?.behavior ?? null)}）`);
  check(resent[1]?.behavior === "steer", `第二条在这一轮里插话（behavior=${JSON.stringify(resent[1]?.behavior)}）`);
  for (const added of added2) {
    const back = await waitFor(
      (m) => m.type === "item.replace" && m.sessionId === sid2 && m.id === added.item.id && m.item?.pending === "sent",
      15000,
      "item.replace sent（补发成功）",
    );
    check(back.item?.pending === "sent", `补发成功后徽标回到正常（pending=${JSON.stringify(back.item?.pending)}）`);
  }

  // ---------------------------------------------------------------- C. pi 起来了但拒收这一条
  log("C. 建第三个会话，在启动窗口里发一条会被拒收的消息");
  const mark3 = seen.length;
  send({ type: "create", cwd: REPO, name: "拒收的那个" });
  const created3 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "拒收的那个" && seen.indexOf(m) >= mark3,
    20000,
    "第三个 session 帧",
  );
  const sid3 = created3.sessionId ?? created3.state?.id;
  const TEXT3 = "REFUSE 这条 pi 不收";
  send({ type: "prompt", sessionId: sid3, text: TEXT3, clientId: "local:3" });
  const added3 = await waitFor((m) => m.type === "item.add" && m.sessionId === sid3 && m.item?.text === TEXT3, 1500, "第三个 item.add");
  check(added3.item?.pending === "booting", "第三个气泡先带着待发标记");
  await waitFor((m) => m.type === "session.state" && m.session?.id === sid3 && m.session?.starting === false, 20000, "第三个会话就绪");
  const refusedItem = await waitFor(
    (m) => m.type === "item.replace" && m.sessionId === sid3 && m.id === added3.item.id && m.item?.pending === "failed",
    15000,
    "拒收后的 item.replace failed",
  );
  check(refusedItem.item?.pending === "failed", "pi 起来了但拒收时同样标失败");
  check(refusedItem.item?.text === TEXT3, "被拒收的文本也还在");
  const refusedNotice = await waitFor(
    (m) => m.type === "notice" && m.sessionId === sid3 && m.level === "error",
    5000,
    "拒收的说明",
  );
  check(/没有发出去/.test(String(refusedNotice.text)), `拒收也有一句人话（「${refusedNotice.text}」）`);
  check(records().some((r) => r.t === "prompt-rejected" && r.text === TEXT3), "桩 pi 记下了这次拒收（桥不是自己凭空标失败的）");

  log("C2. 点重试：pi 已经活着，直接补发");
  send({ type: "claim", sessionId: sid3 });
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXT3), 15000, "拒收的那条被补发");
  const sentBack = await waitFor(
    (m) => m.type === "item.replace" && m.sessionId === sid3 && m.id === added3.item.id && m.item?.pending === "sent",
    15000,
    "补发成功后 item.replace sent",
  );
  check(sentBack.item?.pending === "sent", "重试之后这条也回到正常态");

  // ---------------------------------------------------------------- 6. 只读磁盘会话发消息 = 自动接管，气泡先于握手
  log("6. 只读会话（磁盘上、没在跑）直接发消息：气泡不能等拉起 pi 那几秒");
  send({ type: "subscribe", sessionId: DISK_ID });
  const preview = await waitFor((m) => m.type === "session" && m.sessionId === DISK_ID, 10000, "只读会话的 session 帧");
  check(preview.state?.owned === false && !preview.state?.starting, "先从磁盘只读地看一眼：没有在跑");

  const TEXTC = "只读会话里发的第一句";
  const markC = seen.length;
  const tC = Date.now();
  send({ type: "prompt", sessionId: DISK_ID, text: TEXTC, clientId: "local:3" });
  const addedC = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === DISK_ID && m.item?.text === TEXTC,
    1500,
    "只读会话的 item.add",
  );
  const tookC = Date.now() - tC;
  check(tookC < 1000, `气泡在握手之前就落地了（${tookC} ms，桩 pi 还要 ${BOOT_MS} ms 才答话）`);
  check(addedC.item?.pending === "booting", `带待发标记（pending=${JSON.stringify(addedC.item?.pending)}）`);
  check(addedC.clientId === "local:3", "广播带回 clientId（那一页据此认领，不重复画）");
  check(!records().some((r) => r.t === "prompt" && r.text === TEXTC), "窗口里没有硬塞给一个还没答话的 pi");
  check(
    !seen.some((m) => m.type === "notice" && m.sessionId === DISK_ID && m.level === "error"),
    "自动接管没有报错",
  );

  await waitFor((m) => m.type === "session.state" && m.session?.id === DISK_ID && m.session?.starting === false, 20000, "只读会话 starting=false");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXTC), 10000, "桩 pi 收到只读会话这条 prompt");
  const deliveredC = records().find((r) => r.t === "prompt" && r.text === TEXTC);
  check(deliveredC?.behavior === null, `就绪后开一轮（behavior=${JSON.stringify(deliveredC?.behavior ?? null)}）`);
  const argvC = records().filter((r) => r.t === "argv" && (r.argv ?? []).includes(DISK_FILE));
  check(argvC.length === 1, `这个会话的 pi 只起了一次（argv 里带磁盘文件：${argvC.length} 次）`);
  check(
    argvC[0]?.argv?.includes("--session") ?? false,
    "接管走的是 resume（--session <文件>），不是新会话",
  );
  const replacedC = await waitFor((m) => m.type === "item.replace" && m.sessionId === DISK_ID && m.id === addedC.item.id, 10000, "只读会话 item.replace sent");
  check(replacedC.item?.pending === "sent", `同一枚气泡改成已交出（pending=${JSON.stringify(replacedC.item?.pending)}）`);
  const ownedC = await waitFor((m) => m.type === "session.state" && m.session?.id === DISK_ID && m.session?.owned === true, 10000, "owned 翻转");
  check(Boolean(ownedC), "发完之后这个会话已经是网页的了（自动接管）");
  // 这一条要等整个握手过去再看：气泡的帧必须排在「开始拉起 pi」（starting:true）之前，
  // 也就是用户打完字的那一刻就看见了它，而不是等拉起 pi + get_state 回来。
  const addedCAt = seen.indexOf(addedC);
  const startedC = seen.findIndex((m) => m.type === "session.state" && m.session?.id === DISK_ID && m.session?.starting === true);
  check(
    startedC > 0 && addedCAt < startedC,
    `item.add 排在「开始拉起 pi」之前（item#${addedCAt} < starting#${startedC}）`,
  );
  check(seen.length > markC, "上面几帧都是这次发消息之后才来的");

  // ---------------------------------------------------------------- 7. 接管途中打字：立刻落地，只起一支 pi
  log("7. 点接管之后马上打字：接管还在拉 pi，消息也要立刻落地，而且不能因此把 pi 起两支");
  send({ type: "subscribe", sessionId: CLAIM_ID });
  const preview4 = await waitFor((m) => m.type === "session" && m.sessionId === CLAIM_ID, 10000, "第二个只读会话的 session 帧");
  check(preview4.state?.owned === false, "第二个会话也是只读的");

  // 两条消息连着发、中间不等：claim 才进入 openLive（它还卡在 pinPermission 上），prompt 就到了。
  send({ type: "claim", sessionId: CLAIM_ID });
  const TEXTCLAIM = "接管途中打的字";
  const t4 = Date.now();
  send({ type: "prompt", sessionId: CLAIM_ID, text: TEXTCLAIM, clientId: "local:4" });
  const addedClaim = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === CLAIM_ID && m.item?.text === TEXTCLAIM,
    1500,
    "接管途中的 item.add",
  );
  const tookClaim = Date.now() - t4;
  check(tookClaim < 1000, `接管途中发消息，气泡照样立刻出现（${tookClaim} ms）`);
  check(addedClaim.item?.pending === "booting", `同样带着待发标记（pending=${JSON.stringify(addedClaim.item?.pending)}）`);

  await waitFor((m) => m.type === "session.state" && m.session?.id === CLAIM_ID && m.session?.starting === false, 20000, "接管会话 starting=false");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXTCLAIM), 10000, "桩 pi 收到接管途中那条");
  const argvClaim = records().filter((r) => r.t === "argv" && (r.argv ?? []).includes(CLAIM_FILE));
  check(argvClaim.length === 1, `claim 和 prompt 同时来，pi 只起了一支（${argvClaim.length} 次）`);
  check(records().filter((r) => r.t === "prompt" && r.text === TEXTCLAIM).length === 1, "这条消息只交出去一次");
  const replacedClaim = await waitFor((m) => m.type === "item.replace" && m.sessionId === CLAIM_ID && m.id === addedClaim.item.id, 10000, "接管途中 item.replace sent");
  check(replacedClaim.item?.pending === "sent", "气泡最后是已交出");

  // ---------------------------------------------------------------- 8. 自动接管没成：气泡标红、说明原因
  log("8. 终端里的 pi 还开着（有 tty 锁）：自动接管会被拒，气泡要标成没发出去");
  fs.mkdirSync(path.join(STATE, "locks"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "locks", `${LOCKED_ID}.tty.json`), JSON.stringify({ pid: process.pid, at: Date.now() }));
  send({ type: "subscribe", sessionId: LOCKED_ID });
  await waitFor((m) => m.type === "session" && m.sessionId === LOCKED_ID, 10000, "被锁住的会话的 session 帧");
  const TEXTI = "这条会被锁挡住";
  send({ type: "prompt", sessionId: LOCKED_ID, text: TEXTI, clientId: "local:5" });
  const addedI = await waitFor((m) => m.type === "item.add" && m.sessionId === LOCKED_ID && m.item?.text === TEXTI, 5000, "被锁会话的 item.add");
  check(addedI.item?.pending === "booting", "气泡先落地（哪怕是注定发不出去的）");
  const failed5 = await waitFor((m) => m.type === "item.replace" && m.sessionId === LOCKED_ID && m.id === addedI.item.id, 10000, "被锁会话的 item.replace failed");
  check(failed5.item?.pending === "failed", `接管被拒时气泡标成没发出去（pending=${JSON.stringify(failed5.item?.pending)}）`);
  check(failed5.item?.text === TEXTI, "气泡内容还在");
  const why5 = await waitFor((m) => m.type === "notice" && m.level === "error" && /终端里的 pi/.test(String(m.text)), 10000, "被拒绝的原因");
  check(Boolean(why5), `说清楚了原因（「${why5.text}」）`);
  check(!records().some((r) => r.t === "argv" && (r.argv ?? []).includes(LOCKED_ID)), "没有去动那个会话（一支 pi 都没起）");

  // ---------------------------------------------------------------- 9. 挡路的没了：点「重试」补发，不哑掉
  log("9. 删掉 tty 锁、点「重试」（前端发的就是 claim 帧）：被拒过的那条要补发出去");
  fs.rmSync(path.join(STATE, "locks", `${LOCKED_ID}.tty.json`), { force: true });
  const markRetryI = seen.length;
  send({ type: "claim", sessionId: LOCKED_ID });
  await waitFor(
    (m) => m.type === "item.replace" && m.sessionId === LOCKED_ID && m.id === addedI.item.id && m.item?.pending === "booting" && seen.indexOf(m) >= markRetryI,
    20000,
    "重试后气泡回到待发",
  );
  check(true, "重试把同一枚气泡放回队列（不是又画一条）");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXTI), 20000, "桩 pi 收到被拒过的那条");
  const delivered5 = records().find((r) => r.t === "prompt" && r.text === TEXTI);
  check(delivered5?.behavior === null, `补发时是「开一轮」（behavior=${JSON.stringify(delivered5?.behavior ?? null)}）`);
  await waitFor((m) => m.type === "item.replace" && m.sessionId === LOCKED_ID && m.id === addedI.item.id && m.item?.pending === "sent", 20000, "重试后气泡改成已交出");
  check(true, "补发之后气泡不再是「没发出去」");
  check(
    !seen.some((m) => m.type === "item.add" && m.sessionId === LOCKED_ID && m.item?.text === TEXTI && seen.indexOf(m) >= markRetryI),
    "没有重复画一条气泡",
  );
  const retryArgv = records().filter((r) => r.t === "argv" && (r.argv ?? []).includes(LOCKED_FILE));
  check(retryArgv.length === 1, `补发也只起了一支 pi（argv 里带磁盘文件：${retryArgv.length} 次）`);
  check(retryArgv[0]?.argv?.includes("--session") ?? false, "补发同样是 resume（--session <文件>）");

  // ---------------------------------------------------------------- D. 启动期撤回：整批退回、气泡同帧清空、pi 不被打扰
  log("D. 建第四个会话，启动窗口里连发三条，然后撤回（clearQueue）");
  const mark4 = seen.length;
  send({ type: "create", cwd: REPO, name: "撤回来的那个" });
  const created4 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "撤回来的那个" && seen.indexOf(m) >= mark4,
    20000,
    "第四个 session 帧",
  );
  const sid4 = created4.sessionId ?? created4.state?.id;
  check(created4.state?.starting === true, "第四个会话也在启动窗口里");
  const TEXTS4 = ["第一句：先看架构", "第二句：再补测试", "第三句：最后跑一遍"];
  const added4 = [];
  for (const [i, text] of TEXTS4.entries()) {
    const from = seen.length;
    send({ type: "prompt", sessionId: sid4, text, clientId: `local:3:${i}` });
    added4.push(
      await waitFor((m) => m.type === "item.add" && m.sessionId === sid4 && m.item?.text === text && seen.indexOf(m) >= from, 2000, `第四个会话的 item.add ${i}`),
    );
  }
  check(added4.every((m) => m.item?.pending === "booting"), "三条都还在桥里排队（pending=booting）");
  check(!records().some((r) => r.t === "prompt" && TEXTS4.includes(r.text)), "撤回之前桩 pi 一封都没收到");

  const restoreFrom = seen.length;
  send({ type: "clearQueue", sessionId: sid4 });
  const restore = await waitFor((m) => m.type === "queue.restore" && m.sessionId === sid4 && seen.indexOf(m) >= restoreFrom, 5000, "启动期的 queue.restore");
  check(JSON.stringify(restore.texts) === JSON.stringify(TEXTS4), `三条文本按发出顺序一次退回（${JSON.stringify(restore.texts)}）`);
  const removed = await waitFor((m) => m.type === "item.remove" && m.sessionId === sid4 && seen.indexOf(m) >= restoreFrom, 5000, "启动期的 item.remove");
  const goneIds = Array.isArray(removed.ids) ? removed.ids : [];
  check(added4.every((m) => goneIds.includes(m.item.id)), `三条气泡一起删掉（${goneIds.length} 个 id）`);
  check(seen.filter((m) => m.type === "queue.restore" && m.sessionId === sid4).length === 1, "只退回一次（没有「先清一半再清一半」的第二帧）");
  check(
    !seen.some((m) => m.type === "session.state" && m.session?.id === sid4 && m.session?.starting === false),
    "撤回的那一刻会话还停在启动窗口里（撤回没有把它拽出来）",
  );

  await until(() => records().some((r) => r.t === "argv" && (r.argv ?? []).includes(sid4)), 10000, "第四个桩 pi 的 argv 行");
  const launch3 = records().filter((r) => r.t === "argv" && (r.argv ?? []).includes(sid4)).at(-1);
  check(!records().some((r) => r.t === "abort" && r.pid === launch3?.pid), "撤回不打断 pi：桩 pi 没收到 abort");

  log("等第四个会话启动完成：撤回的那三条不能被补交");
  await waitFor((m) => m.type === "session.state" && m.session?.id === sid4 && m.session?.starting === false, 20000, "第四个会话 starting=false");
  await sleep(800);
  check(!records().some((r) => r.t === "prompt" && TEXTS4.includes(r.text)), "启动完成后桩 pi 仍然一封都没收到（不是只清了桥的队头）");
  check(!seen.some((m) => m.type === "item.replace" && m.sessionId === sid4), "没有气泡被改成「已交出」");
  check(records().some((r) => r.t === "clear_queue"), "桥也跟 pi 要过它那份队列（两边都清，不是只清一半）");
  const AFTER3 = "撤回之后这一句";
  send({ type: "prompt", sessionId: sid4, text: AFTER3, clientId: "local:3:after" });
  await until(() => records().some((r) => r.t === "prompt" && r.text === AFTER3), 10000, "撤回之后的新消息交给 pi");
  check(records().some((r) => r.t === "prompt" && r.text === AFTER3), "撤回之后同一个会话照常能发（pi 继续启动完了，不用再等一次）");

  // ---------------------------------------------------------------- E. 只退回没交出去的：已 sent 的那条留着
  log("E. 建第五个会话：就绪瞬间只交出第一条，剩下的撤回来");
  const mark5 = seen.length;
  send({ type: "create", cwd: REPO, name: "交了一半的那个" });
  const created5 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "交了一半的那个" && seen.indexOf(m) >= mark5,
    20000,
    "第五个 session 帧",
  );
  const sid5 = created5.sessionId ?? created5.state?.id;
  const TEXTS5 = ["HOLD 交出去的第一条", "还排队的第二条", "还排队的第三条"];
  const added5 = [];
  for (const [i, text] of TEXTS5.entries()) {
    const from = seen.length;
    send({ type: "prompt", sessionId: sid5, text, clientId: `local:4:${i}` });
    added5.push(
      await waitFor((m) => m.type === "item.add" && m.sessionId === sid5 && m.item?.text === text && seen.indexOf(m) >= from, 2000, `第五个会话的 item.add ${i}`),
    );
  }
  await waitFor((m) => m.type === "session.state" && m.session?.id === sid5 && m.session?.starting === false, 20000, "第五个会话 starting=false");
  const sentOne = await waitFor((m) => m.type === "item.replace" && m.sessionId === sid5 && m.id === added5[0].item.id, 10000, "第一条的 item.replace sent");
  check(sentOne.item?.pending === "sent", "第一条已经交给 pi（气泡上写着 sent）");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXTS5[0]), 10000, "第一条交给桩 pi");

  const mixedFrom = seen.length;
  send({ type: "clearQueue", sessionId: sid5 });
  const mixed = await waitFor((m) => m.type === "queue.restore" && m.sessionId === sid5 && seen.indexOf(m) >= mixedFrom, 8000, "混合队列的 queue.restore");
  check(JSON.stringify(mixed.texts) === JSON.stringify(TEXTS5.slice(1)), `只退回还在桥里的两条（${JSON.stringify(mixed.texts)}）`);
  const mixedRemoved = await waitFor((m) => m.type === "item.remove" && m.sessionId === sid5 && seen.indexOf(m) >= mixedFrom, 8000, "混合队列的 item.remove");
  const mixedIds = Array.isArray(mixedRemoved.ids) ? mixedRemoved.ids : [];
  check(!mixedIds.includes(added5[0].item.id), "已经 sent 的那条气泡留着");
  check(added5.slice(1).every((m) => mixedIds.includes(m.item.id)), "还在排队的两个气泡删掉");
  await sleep(600);
  check(!records().some((r) => r.t === "prompt" && TEXTS5.slice(1).includes(r.text)), "撤回的两条终究没交给 pi");

  // ---------------------------------------------------------------- F. #202 启动期的图片：原样跟着这条走
  log("F. 建第六个会话：启动窗口里发一条带两张图的，再发一条纯文本");
  const mark6 = seen.length;
  send({ type: "create", cwd: REPO, name: "带图的那个" });
  const created6 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "带图的那个" && seen.indexOf(m) >= mark6,
    20000,
    "第六个 session 帧",
  );
  const sid6 = created6.sessionId ?? created6.state?.id;
  check(created6.state?.starting === true, "第六个会话也在启动窗口里");
  // 一张 1×1 的 PNG：桥不解码，只原样转给 pi，所以字节是不是真图不重要。
  const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const IMAGES6 = [
    { data: PNG_1PX, mimeType: "image/png" },
    { data: PNG_1PX, mimeType: "image/jpeg" },
  ];
  const TEXTIMG = "配上两张图的那句";
  const fromImg = seen.length;
  send({ type: "prompt", sessionId: sid6, text: TEXTIMG, images: IMAGES6, clientId: "local:6:0" });
  const addedImg = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === sid6 && m.item?.text === TEXTIMG && seen.indexOf(m) >= fromImg,
    2000,
    "带图那条的 item.add",
  );
  check(addedImg.item?.pending === "booting", `带图的气泡也立刻落地并排队（pending=${JSON.stringify(addedImg.item?.pending)}）`);
  check(
    JSON.stringify(addedImg.item?.images) === JSON.stringify(IMAGES6.map((i) => ({ mimeType: i.mimeType }))),
    `气泡上记着两张图（${JSON.stringify(addedImg.item?.images)}）`,
  );
  const TEXTONLY = "跟在后头的一句";
  send({ type: "prompt", sessionId: sid6, text: TEXTONLY, clientId: "local:6:1" });
  await waitFor(
    (m) => m.type === "item.add" && m.sessionId === sid6 && m.item?.text === TEXTONLY && seen.indexOf(m) >= fromImg,
    2000,
    "纯文本那条的 item.add",
  );
  check(!records().some((r) => r.t === "prompt" && (r.text === TEXTIMG || r.text === TEXTONLY)), "窗口里桩 pi 一封都没收到");

  await waitFor((m) => m.type === "session.state" && m.session?.id === sid6 && m.session?.starting === false, 20000, "第六个会话 starting=false");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXTIMG), 10000, "带图那条交给桩 pi");
  const imgDelivered = records().find((r) => r.t === "prompt" && r.text === TEXTIMG);
  check(
    JSON.stringify(imgDelivered?.images) === JSON.stringify(["image/png", "image/jpeg"]),
    `两张图跟着这条一起交给了 pi（${JSON.stringify(imgDelivered?.images)}）`,
  );
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXTONLY), 10000, "纯文本那条交给桩 pi");
  const textDelivered = records().find((r) => r.t === "prompt" && r.text === TEXTONLY);
  check((textDelivered?.images ?? []).length === 0, "后一条纯文本没有被顺带塞上图（图跟着它自己的那条）");
  const imgOrder = records()
    .filter((r) => r.t === "prompt" && [TEXTIMG, TEXTONLY].includes(r.text))
    .map((r) => r.text);
  check(
    JSON.stringify(imgOrder) === JSON.stringify([TEXTIMG, TEXTONLY]),
    `交给 pi 的顺序与发出顺序一致（${JSON.stringify(imgOrder)}）`,
  );
  const replacedImg = await waitFor((m) => m.type === "item.replace" && m.sessionId === sid6 && m.id === addedImg.item.id, 10000, "带图那条的 item.replace sent");
  check(replacedImg.item?.images?.length === 2 && replacedImg.item?.pending === "sent", "改成「已交出」之后气泡上的两张图还在");

  // ---------------------------------------------------------------- G. #202 启动期的粘贴块：长文本原样交出去
  log("G. 建第七个会话：启动窗口里贴一大段代码（缩进 + 制表符 + 行尾空格），后面再接着打字");
  const mark7 = seen.length;
  send({ type: "create", cwd: REPO, name: "贴了一段代码的那个" });
  const created7 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "贴了一段代码的那个" && seen.indexOf(m) >= mark7,
    20000,
    "第七个 session 帧",
  );
  const sid7 = created7.sessionId ?? created7.state?.id;
  check(created7.state?.starting === true, "第七个会话也在启动窗口里");
  // 前端把粘贴块拼在打的字前面、空行分隔（`sendPrompt()`），桥和 pi 看到的就该是这一份，一个字符都不许动。
  const PASTED7 = [
    "```ts",
    "export function boot(id: string) {",
    "    if (!id) return; // 行尾留两个空格  ",
    "\tconst tail = '制表符';",
    "    return tail;",
    "}",
    "```",
  ].join("\n");
  const TYPED7 = "这段是接着打的";
  const TEXT7 = `${PASTED7}\n\n${TYPED7}`;
  const fromPaste = seen.length;
  send({ type: "prompt", sessionId: sid7, text: TEXT7, clientId: "local:7:0" });
  const addedPaste = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === sid7 && m.item?.kind === "user" && seen.indexOf(m) >= fromPaste,
    2000,
    "粘贴块那条的 item.add",
  );
  check(addedPaste.item?.text === TEXT7, "气泡里就是拼出来的那一整份（折叠由前端按长度自己算）");
  check(!records().some((r) => r.t === "prompt" && r.text === TEXT7), "窗口里还是没交给 pi");
  await waitFor((m) => m.type === "session.state" && m.session?.id === sid7 && m.session?.starting === false, 20000, "第七个会话 starting=false");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXT7), 10000, "粘贴块那条交给桩 pi");
  const deliveredPaste = records().find((r) => r.t === "prompt" && r.text === TEXT7);
  check(deliveredPaste?.text === TEXT7, "交给 pi 的与气泡、与粘贴的那份一字不差");
  check(
    deliveredPaste?.text.includes("    if (!id) return; // 行尾留两个空格  ") && deliveredPaste?.text.includes("\tconst tail"),
    "缩进、制表符、行尾空格都没被规范化掉",
  );
  check(deliveredPaste?.text.endsWith(`\n\n${TYPED7}`), "打的字接在粘贴块后面，空行分隔");

  // ---------------------------------------------------------------- H. #202 启动期的 `!` 命令：不排队，明说一句
  log("H. 建第八个会话：启动窗口里敲 ! 命令 —— 不进 bootQueue、不静默丢，就绪后照常能跑");
  const mark8 = seen.length;
  send({ type: "create", cwd: REPO, name: "敲了叹号命令的那个" });
  const created8 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "敲了叹号命令的那个" && seen.indexOf(m) >= mark8,
    20000,
    "第八个 session 帧",
  );
  const sid8 = created8.sessionId ?? created8.state?.id;
  check(created8.state?.starting === true, "第八个会话也在启动窗口里");
  const BOOT_CMD = "echo 启动期不该执行的命令";
  const fromBash = seen.length;
  send({ type: "bash", sessionId: sid8, command: BOOT_CMD, excludeFromContext: false });
  const bashRefused = await waitFor(
    (m) => m.type === "notice" && m.level === "error" && /还在启动/.test(String(m.text)) && seen.indexOf(m) >= fromBash,
    5000,
    "启动期 ! 命令的说明",
  );
  check(/!/.test(String(bashRefused.text)), `给了一句人话（「${bashRefused.text}」）`);
  check(
    !seen.some((m) => m.type === "item.add" && m.sessionId === sid8 && m.item?.kind === "bash"),
    "没有画出 bash 卡片（这条命令根本没发出去）",
  );
  check(
    !seen.some((m) => m.type === "item.add" && m.sessionId === sid8 && m.item?.kind === "user"),
    "也没有被塞进 prompt 队列（气泡上不该出现这条命令）",
  );
  check(!records().some((r) => r.t === "bash" && r.command === BOOT_CMD), "桩 pi 也没收到 bash（没起来就没有这条通道）");

  await waitFor((m) => m.type === "session.state" && m.session?.id === sid8 && m.session?.starting === false, 20000, "第八个会话 starting=false");
  send({ type: "bash", sessionId: sid8, command: BOOT_CMD, excludeFromContext: true });
  const bashItem = await waitFor(
    (m) => m.type === "item.add" && m.sessionId === sid8 && m.item?.kind === "bash" && m.item?.command === BOOT_CMD,
    5000,
    "就绪后的 bash 卡片",
  );
  check(bashItem.item?.excludeFromContext === true, "拦的只是启动窗口：就绪之后 !! 命令照常能跑");
  await until(() => records().some((r) => r.t === "bash" && r.command === BOOT_CMD), 10000, "桩 pi 收到就绪后的 bash");
  const bashDone = await waitFor((m) => m.type === "item.replace" && m.sessionId === sid8 && m.id === bashItem.item.id, 10000, "bash 结果");
  check(
    String(bashDone.item?.output ?? "").includes(`ran: ${BOOT_CMD}`),
    `输出照常回来（${JSON.stringify(bashDone.item?.output)}）`,
  );
  check(
    !records().some((r) => r.t === "bash" && r.command === BOOT_CMD && r.exclude !== true),
    "启动期那条始终没有在后台补跑",
  );

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
