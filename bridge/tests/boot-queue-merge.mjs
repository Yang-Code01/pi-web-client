/**
 * 启动窗口里发消息（#197 / D177、#198 / D178）：pi 还在加载扩展，桥先收下，气泡立刻出现。
 *
 * 用一个「启动很慢」的桩 pi（FAKE_PI_BOOT_MS）把启动窗口撑开，然后全部从外面看（WS 消息 +
 * 桩 pi 自己的日志，bridge/tests/fixtures/fake-pi.mjs）：
 *   1. `starting` 为真时发 prompt **不报错**：`item.add` 立刻到，item 上带 `pending: "booting"`；
 *   2. 那几秒里桩 pi 一封 prompt 都没收到（消息在桥里排队，没有硬塞给一个还没答话的进程），
 *      队列条也不列它们（气泡说「正在启动」，队列条不能抢先说「排队中」）；
 *   3. 会话名由这条消息决定（左栏不用等 pi 起来就有名字）；
 *   4. `starting` 翻假之后桩 pi 收到这条 prompt（`behavior: null`，第一句不是插话），
 *      同一枚 item 以 `pending: "sent"` 广播一次 `item.replace`；
 *   5. 启动失败（进程在窗口里死了）时气泡留着、标成 `pending: "failed"`，并给一句可读的说明 ——
 *      不能静默消失。完整的重试是 #200。
 *   6. 窗口里连发 3 条：气泡 3 枚都在、就绪后按到达顺序交出、第 2、3 条带 `steer` 并落进同一轮，
 *      队列条列出的正好是「还在 pi 队列里」的那两条；
 *   7. 第一条根本没起一轮（`disposition: "handled"`）时，第二条不干等 10 秒上限：裸发、自己开一轮。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/boot-queue.mjs
 */
import fs from "node:fs";
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

  // ---------------------------------------------------------------- C. 启动期连发 3 条：按序、合并
  log("C. 建第三个会话，在启动窗口里连发 3 条（第 1 条故意跑得久，后面两条才有机会插进同一轮）");
  const mark3 = seen.length;
  send({ type: "create", cwd: REPO, name: "连发三条的那个" });
  const created3 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "连发三条的那个" && seen.indexOf(m) >= mark3,
    20000,
    "第三个 session 帧",
  );
  const sid3 = created3.sessionId ?? created3.state?.id;
  check(created3.state?.starting === true, "第三个会话也在启动窗口里");

  const TEXTS = ["STAY 一", "第二句", "第三句"];
  for (const [i, text] of TEXTS.entries()) send({ type: "prompt", sessionId: sid3, text, clientId: `local:c${i}` });
  const adds = [];
  for (const text of TEXTS) {
    adds.push(await waitFor((m) => m.type === "item.add" && m.sessionId === sid3 && m.item?.text === text, 2000, `气泡 ${text}`));
  }
  check(
    adds.every((a) => a.item?.pending === "booting"),
    `3 枚气泡在启动窗口里都落地了、都带着待发标记（${adds.map((a) => a.item?.pending).join(",")}）`,
  );
  check(
    !seen.some((m) => m.type === "notice" && m.sessionId === sid3),
    "启动期连发 3 条没有错误通知",
  );
  check(
    !seen.some(
      (m) => m.type === "queue" && m.sessionId === sid3 && ((m.steering ?? []).length || (m.followUp ?? []).length),
    ),
    "窗口里队列条一条也不列（气泡说「正在启动」，队列条不能抢先说「排队中」）",
  );

  log("等 pi 就绪：3 条按到达顺序交出去，第 2、3 条插进第 1 条那一轮");
  await waitFor((m) => m.type === "session.state" && m.session?.id === sid3 && m.session?.starting === false, 20000, "第三个会话 starting=false");
  await until(
    () => TEXTS.every((t) => records().some((r) => r.t === "prompt" && r.text === t)),
    15000,
    "三条都交给 pi",
  );
  const delivered3 = records().filter((r) => r.t === "prompt" && TEXTS.includes(r.text));
  check(
    delivered3.map((r) => r.text).join("|") === TEXTS.join("|"),
    `3 条按到达顺序交给 pi（实际 ${delivered3.map((r) => r.text).join("|")}）`,
  );
  check(delivered3[0]?.behavior === null, `第 1 条开一轮、不带标记（behavior=${JSON.stringify(delivered3[0]?.behavior ?? null)}）`);
  check(
    delivered3[1]?.behavior === "steer" && delivered3[2]?.behavior === "steer",
    `第 2、3 条带插话标记（${delivered3.map((r) => JSON.stringify(r.behavior ?? null)).join(",")}）`,
  );
  check(new Set(delivered3.map((r) => r.pid)).size === 1, "3 条交给的是同一个 pi 进程（没有各自开一个）");
  const runs3 = records().filter((r) => r.t === "run-start" && r.pid === delivered3[0]?.pid);
  check(runs3.length === 1, `第 2、3 条在这一轮里被处理（这一支 pi 只开了一轮，实际 ${runs3.length} 轮）`);

  for (const add of adds) {
    const rep = await waitFor(
      (m) => m.type === "item.replace" && m.sessionId === sid3 && m.id === add.item.id,
      10000,
      `气泡 ${add.item.text} 变 sent`,
    );
    check(rep.item?.pending === "sent", `「${add.item.text}」交出去之后气泡改成已交出`);
  }

  const q3 = await waitFor(
    (m) => m.type === "queue" && m.sessionId === sid3 && (m.steering ?? []).includes(TEXTS[2]),
    10000,
    "队列条列出插话",
  );
  check(
    JSON.stringify(q3.steering) === JSON.stringify([TEXTS[1], TEXTS[2]]),
    `队列条上的两条正是还在 pi 队列里的那两条（${JSON.stringify(q3.steering)}）`,
  );
  check(!(q3.steering ?? []).includes(TEXTS[0]), "正在跑的第 1 条不算排队（不出现在队列条里）");
  await waitFor(
    (m) =>
      m.type === "queue" &&
      m.sessionId === sid3 &&
      !(m.steering ?? []).length &&
      !(m.followUp ?? []).length &&
      seen.indexOf(m) > seen.indexOf(q3),
    15000,
    "队列条清空",
  );
  const lastQ = seen.filter((m) => m.type === "queue" && m.sessionId === sid3).at(-1);
  check(
    !(lastQ?.steering ?? []).length && !(lastQ?.followUp ?? []).length,
    "这一轮做完，队列条自己清空（和气泡不再「处理中」是同一时刻）",
  );
  check(
    !seen.some((m) => m.type === "notice" && m.sessionId === sid3 && /没有发出去|拒收/.test(String(m.text))),
    "整条路没有任何一条被丢掉",
  );

  // ---------------------------------------------------------------- D. 交出去时 pi 已不在流式：裸发，自己开一轮
  log("D. 建第四个会话：第一条被 pi 就地处理、根本没起一轮，第二条不能干等「这一轮开始」的 10 秒上限");
  const mark4 = seen.length;
  send({ type: "create", cwd: REPO, name: "没起 run 的那个" });
  const created4 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "没起 run 的那个" && seen.indexOf(m) >= mark4,
    20000,
    "第四个 session 帧",
  );
  const sid4 = created4.sessionId ?? created4.state?.id;
  const D1 = "HANDLED 斜杠命令";
  const D2 = "这一条自己开一轮";
  send({ type: "prompt", sessionId: sid4, text: D1, clientId: "local:d0" });
  send({ type: "prompt", sessionId: sid4, text: D2, clientId: "local:d1" });
  check(created4.state?.starting === true, "第四个会话也在启动窗口里（两条都在窗口里发的）");

  await waitFor((m) => m.type === "session.state" && m.session?.id === sid4 && m.session?.starting === false, 20000, "第四个会话 starting=false");
  const tReady = Date.now();
  await until(() => records().some((r) => r.t === "prompt" && r.text === D2), 15000, "第二条被交出去");
  const took4 = Date.now() - tReady;
  const delivered4 = records().filter((r) => r.t === "prompt" && (r.text === D1 || r.text === D2));
  check(
    delivered4.map((r) => r.text).join("|") === `${D1}|${D2}`,
    `两条都交出去了、顺序不变（${delivered4.map((r) => r.text).join("|")}）`,
  );
  check(
    delivered4[1]?.behavior === null,
    `pi 已经不在流式输出，第二条裸发（behavior=${JSON.stringify(delivered4[1]?.behavior ?? null)}）`,
  );
  check(took4 < 5000, `没有干等「这一轮开始」的 10 秒上限（就绪到第二条交出 ${took4} ms）`);
  check(
    !records().some((r) => r.t === "prompt-rejected" && (r.text === D1 || r.text === D2)),
    "裸发没有被 pi 拒收（Agent is already processing）",
  );
  await until(() => records().some((r) => r.t === "turn" && r.text === D2), 5000, "第二条自己开了一轮");
  check(
    records().some((r) => r.t === "turn" && r.text === D2 && r.pid === delivered4[1]?.pid),
    "第二条由 pi 自己开了一轮（不必人再发一次）",
  );
  const d1Sent = await waitFor(
    (m) => m.type === "item.replace" && m.sessionId === sid4 && m.item?.text === D1,
    5000,
    "第一条气泡变 sent",
  );
  check(d1Sent.item?.pending === "sent", "就地处理掉的第一条也算交出去了（不是失败）");
  check(
    !seen.some((m) => m.type === "notice" && m.sessionId === sid4),
    "这一路没有报错（裸发兜底不该惊动用户）",
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
