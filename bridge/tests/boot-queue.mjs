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

  // ---------------------------------------------------------------- C. 启动期撤回：整批退回、气泡同帧清空、pi 不被打扰
  log("C. 建第三个会话，启动窗口里连发三条，然后撤回（clearQueue）");
  const mark3 = seen.length;
  send({ type: "create", cwd: REPO, name: "撤回来的那个" });
  const created3 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "撤回来的那个" && seen.indexOf(m) >= mark3,
    20000,
    "第三个 session 帧",
  );
  const sid3 = created3.sessionId ?? created3.state?.id;
  check(created3.state?.starting === true, "第三个会话也在启动窗口里");
  const TEXTS3 = ["第一句：先看架构", "第二句：再补测试", "第三句：最后跑一遍"];
  const added3 = [];
  for (const [i, text] of TEXTS3.entries()) {
    const from = seen.length;
    send({ type: "prompt", sessionId: sid3, text, clientId: `local:3:${i}` });
    added3.push(
      await waitFor((m) => m.type === "item.add" && m.sessionId === sid3 && m.item?.text === text && seen.indexOf(m) >= from, 2000, `第三个会话的 item.add ${i}`),
    );
  }
  check(added3.every((m) => m.item?.pending === "booting"), "三条都还在桥里排队（pending=booting）");
  check(!records().some((r) => r.t === "prompt" && TEXTS3.includes(r.text)), "撤回之前桩 pi 一封都没收到");

  const restoreFrom = seen.length;
  send({ type: "clearQueue", sessionId: sid3 });
  const restore = await waitFor((m) => m.type === "queue.restore" && m.sessionId === sid3 && seen.indexOf(m) >= restoreFrom, 5000, "启动期的 queue.restore");
  check(JSON.stringify(restore.texts) === JSON.stringify(TEXTS3), `三条文本按发出顺序一次退回（${JSON.stringify(restore.texts)}）`);
  const removed = await waitFor((m) => m.type === "item.remove" && m.sessionId === sid3 && seen.indexOf(m) >= restoreFrom, 5000, "启动期的 item.remove");
  const goneIds = Array.isArray(removed.ids) ? removed.ids : [];
  check(added3.every((m) => goneIds.includes(m.item.id)), `三条气泡一起删掉（${goneIds.length} 个 id）`);
  check(seen.filter((m) => m.type === "queue.restore" && m.sessionId === sid3).length === 1, "只退回一次（没有「先清一半再清一半」的第二帧）");
  check(
    !seen.some((m) => m.type === "session.state" && m.session?.id === sid3 && m.session?.starting === false),
    "撤回的那一刻会话还停在启动窗口里（撤回没有把它拽出来）",
  );

  await until(() => records().some((r) => r.t === "argv" && (r.argv ?? []).includes(sid3)), 10000, "第三个桩 pi 的 argv 行");
  const launch3 = records().filter((r) => r.t === "argv" && (r.argv ?? []).includes(sid3)).at(-1);
  check(!records().some((r) => r.t === "abort" && r.pid === launch3?.pid), "撤回不打断 pi：桩 pi 没收到 abort");

  log("等第三个会话启动完成：撤回的那三条不能被补交");
  await waitFor((m) => m.type === "session.state" && m.session?.id === sid3 && m.session?.starting === false, 20000, "第三个会话 starting=false");
  await sleep(800);
  check(!records().some((r) => r.t === "prompt" && TEXTS3.includes(r.text)), "启动完成后桩 pi 仍然一封都没收到（不是只清了桥的队头）");
  check(!seen.some((m) => m.type === "item.replace" && m.sessionId === sid3), "没有气泡被改成「已交出」");
  check(records().some((r) => r.t === "clear_queue"), "桥也跟 pi 要过它那份队列（两边都清，不是只清一半）");
  const AFTER3 = "撤回之后这一句";
  send({ type: "prompt", sessionId: sid3, text: AFTER3, clientId: "local:3:after" });
  await until(() => records().some((r) => r.t === "prompt" && r.text === AFTER3), 10000, "撤回之后的新消息交给 pi");
  check(records().some((r) => r.t === "prompt" && r.text === AFTER3), "撤回之后同一个会话照常能发（pi 继续启动完了，不用再等一次）");

  // ---------------------------------------------------------------- D. 只退回没交出去的：已 sent 的那条留着
  log("D. 建第四个会话：就绪瞬间只交出第一条，剩下的撤回来");
  const mark4 = seen.length;
  send({ type: "create", cwd: REPO, name: "交了一半的那个" });
  const created4 = await waitFor(
    (m) => m.type === "session" && m.state?.name === "交了一半的那个" && seen.indexOf(m) >= mark4,
    20000,
    "第四个 session 帧",
  );
  const sid4 = created4.sessionId ?? created4.state?.id;
  const TEXTS4 = ["交出去的第一条", "还排队的第二条", "还排队的第三条"];
  const added4 = [];
  for (const [i, text] of TEXTS4.entries()) {
    const from = seen.length;
    send({ type: "prompt", sessionId: sid4, text, clientId: `local:4:${i}` });
    added4.push(
      await waitFor((m) => m.type === "item.add" && m.sessionId === sid4 && m.item?.text === text && seen.indexOf(m) >= from, 2000, `第四个会话的 item.add ${i}`),
    );
  }
  await waitFor((m) => m.type === "session.state" && m.session?.id === sid4 && m.session?.starting === false, 20000, "第四个会话 starting=false");
  const sentOne = await waitFor((m) => m.type === "item.replace" && m.sessionId === sid4 && m.id === added4[0].item.id, 10000, "第一条的 item.replace sent");
  check(sentOne.item?.pending === "sent", "第一条已经交给 pi（气泡上写着 sent）");
  await until(() => records().some((r) => r.t === "prompt" && r.text === TEXTS4[0]), 10000, "第一条交给桩 pi");

  const mixedFrom = seen.length;
  send({ type: "clearQueue", sessionId: sid4 });
  const mixed = await waitFor((m) => m.type === "queue.restore" && m.sessionId === sid4 && seen.indexOf(m) >= mixedFrom, 8000, "混合队列的 queue.restore");
  check(JSON.stringify(mixed.texts) === JSON.stringify(TEXTS4.slice(1)), `只退回还在桥里的两条（${JSON.stringify(mixed.texts)}）`);
  const mixedRemoved = await waitFor((m) => m.type === "item.remove" && m.sessionId === sid4 && seen.indexOf(m) >= mixedFrom, 8000, "混合队列的 item.remove");
  const mixedIds = Array.isArray(mixedRemoved.ids) ? mixedRemoved.ids : [];
  check(!mixedIds.includes(added4[0].item.id), "已经 sent 的那条气泡留着");
  check(added4.slice(1).every((m) => mixedIds.includes(m.item.id)), "还在排队的两个气泡删掉");
  await sleep(600);
  check(!records().some((r) => r.t === "prompt" && TEXTS4.slice(1).includes(r.text)), "撤回的两条终究没交给 pi");

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
