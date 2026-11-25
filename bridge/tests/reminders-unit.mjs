/**
 * D389：提醒中心的不变量。这里只碰 `Reminders` 的**公开面**（add / settle / read / mute /
 * markStaleAll / setSettings / view），不碰内部字段 —— 那几个数字（角标、吐司、cap）都是用户
 * 能在页面上看见的东西。
 *
 *   node --experimental-strip-types bridge/tests/reminders-unit.mjs
 */
import assert from "node:assert/strict";
import { Reminders, REMINDER_CAP, REMINDER_COALESCE_MS, REMINDER_KEEP_DAYS } from "../src/reminders.ts";

/** 注入时钟 + 不落盘的存储：测试只问逻辑，不问磁盘。 */
function makeStore(settings) {
  let clock = 0;
  const store = new Reminders({ now: () => clock, save: () => {} });
  if (settings) store.setSettings(settings);
  return { store, tick: (ms) => (clock += ms), at: (ms) => (clock = ms) };
}

/** 一条审批的形状（id 就是 pi 那边的 approval id）。 */
const approval = (id, sessionId = "s1") => ({
  id,
  kind: "approval",
  sessionId,
  sessionName: "api 重构",
  title: "需要你批准 · api 重构",
  body: "rm -rf dist/ && npm run build",
});
const ask = (id, sessionId = "s2") => ({
  id,
  kind: "ask",
  sessionId,
  sessionName: "go-svc 迁移",
  title: "需要你回答 · go-svc 迁移",
  body: "选哪个迁移方式？",
});
const notice = (id) => ({ id, kind: "notice", sessionName: "构建", title: "prisma 迁移失败", body: "exit 1" });

// ---------------------------------------------------------------- 角标与吐司

{
  const { store } = makeStore();
  /* 第一版原型在这里栽过：把「还没弹过」当成「0 时刻弹过」，第一条被自己吞掉。 */
  const r = store.add(approval("a1"));
  assert.equal(r.toast, true, "第一次来一定要弹一条吐司（虚拟时钟从 0 起也不行）");
  assert.equal(store.view().badge, 1);
  assert.equal(store.view().items[0].state, "waiting");
}

{
  const { store, tick } = makeStore();
  store.add(approval("a1"));
  const again = store.add(approval("a2"));
  assert.equal(again.toast, false, `同一会话 ${REMINDER_COALESCE_MS / 1000} 秒内只弹一条`);
  assert.equal(store.view().badge, 2, "合并的是吐司，不是事实：角标照涨");

  tick(REMINDER_COALESCE_MS + 1);
  assert.equal(store.add(approval("a3")).toast, true, "过了窗口就该再弹");
  assert.equal(store.view().badge, 3);
}

{
  const { store } = makeStore();
  store.add(approval("a1", "s1"));
  assert.equal(store.add(ask("q1", "s2")).toast, true, "另一个会话有自己的 30 秒窗口");
  assert.equal(store.view().badge, 2, "一张审批卡、一份问卷各算 1");
}

{
  const { store } = makeStore();
  assert.equal(store.add(notice("n1")).toast, false, "非阻塞默认不弹，只让角标涨");
  assert.equal(store.view().badge, 1);
  assert.equal(store.view().items[0].kind, "notice");
}

// ---------------------------------------------------------------- 归宿

{
  const { store } = makeStore();
  store.add(approval("a1"));
  store.settle("a1", "approve");
  assert.equal(store.view().items[0].state, "handled");
  assert.equal(store.view().items[0].outcome, "approved");
  assert.equal(store.view().badge, 0, "批完就离开「在等」");

  store.add(approval("a2"));
  store.settle("a2", "reject");
  assert.equal(store.view().items[0].outcome, "rejected");

  store.add(ask("q1"));
  store.settle("q1", "answered");
  assert.equal(store.view().items[0].outcome, "answered");

  store.add(ask("q2"));
  store.settle("q2", "cancelled");
  assert.equal(store.view().items[0].state, "stale", "被取消 = 失效，不是「处理完了」");
  assert.equal(store.view().items[0].outcome, "stale");
}

{
  const { store } = makeStore();
  store.add(notice("n1"));
  store.read("n1");
  assert.equal(store.view().items[0].state, "read");
  assert.equal(store.view().badge, 0, "非阻塞点一下就消（= 已读）");
}

{
  const { store } = makeStore();
  store.add(approval("a1"));
  store.read("a1");
  assert.equal(store.view().items[0].state, "waiting", "审批不能被「点开」当成处理过");
}

// ---------------------------------------------------------------- 重启 / 静音

{
  const { store } = makeStore();
  store.add(approval("a1"));
  store.add(ask("q1"));
  store.markStaleAll();
  assert.equal(store.view().badge, 0, "桥重启：那几个 pi 子进程已经死了");
  assert.deepEqual(
    store.view().items.map((r) => r.state),
    ["stale", "stale"],
  );
}

{
  const { store } = makeStore();
  store.add(approval("a1", "s1"));
  store.add(ask("q1", "s2"));
  store.mute("s1", true);
  assert.equal(store.view().badge, 1, "静音的会话不计角标");
  assert.equal(store.view().items.length, 2, "但清单里仍在");
  assert.equal(store.muted("s1"), true);
  assert.equal(store.add(approval("a2", "s1")).toast, false, "静音之后不再弹");

  store.mute("s1", false);
  assert.equal(store.view().badge, 3, "取消静音，之前那两条也算回来（a1 / q1 / a2）");
}

// ---------------------------------------------------------------- 设置

{
  const { store } = makeStore({ enabled: true, blocking: false, others: true });
  assert.equal(store.add(approval("a1")).toast, false, "关掉阻塞类 = 不弹");
  assert.equal(store.view().badge, 1, "角标照常（关掉的是打断，不是知情）");
}

{
  const { store } = makeStore({ enabled: false, blocking: true, others: true });
  assert.equal(store.add(approval("a1")).toast, false, "总开关关掉 = 一条都不弹");
  assert.equal(store.view().badge, 1, "角标仍在");
  assert.equal(store.settings().enabled, false);
}

// ---------------------------------------------------------------- 容量

{
  const { store, tick } = makeStore();
  for (let i = 0; i < REMINDER_CAP + 40; i++) {
    store.add(approval(`a${i}`, `s${i % 3}`));
    store.settle(`a${i}`, "approve"); /* 全部处理掉，好让 cap 有东西可丢 */
    tick(10);
  }
  const v = store.view();
  assert.equal(v.items.length, REMINDER_CAP, "封顶就是封顶");
  assert.equal(v.badge, 0);
}

{
  const { store } = makeStore();
  for (let i = 0; i < REMINDER_CAP + 10; i++) store.add(approval(`a${i}`, `s${i % 2}`));
  const v = store.view();
  assert.equal(v.items.length, REMINDER_CAP + 10, "在等的一条都不许丢，哪怕超过 cap");
  assert.equal(v.badge, REMINDER_CAP + 10);
}

{
  const { store, at } = makeStore();
  store.add(approval("old"));
  store.settle("old", "approve");
  store.add(approval("fresh"));
  at((REMINDER_KEEP_DAYS + 1) * 86_400_000);
  store.add(approval("newer"));
  const ids = store.view().items.map((r) => r.id);
  assert.equal(ids.includes("old"), false, "超过保留期的已处理条目丢掉");
  assert.equal(ids.includes("fresh"), true, "还在保留期里的留着");
}

{
  const { store, at } = makeStore();
  store.add(approval("stuck"));
  at((REMINDER_KEEP_DAYS + 1) * 86_400_000);
  store.add(approval("newer"));
  assert.equal(
    store.view().items.some((r) => r.id === "stuck"),
    true,
    "在等的条目不受保留期影响 —— 否则「有人在等你」会被时间悄悄吞掉",
  );
}

// ---------------------------------------------------------------- 谓词一致

{
  const { store } = makeStore();
  store.add(approval("a1", "s1"));
  store.add(ask("q1", "s2"));
  store.add(notice("n1"));
  store.mute("s2", true);
  const v = store.view();
  const expected = v.items.filter((r) => r.state === "waiting" && !v.muted.includes(r.sessionId)).length;
  assert.equal(v.badge, expected, "角标与清单必须共用一个谓词（差一个就会出现「角标 2、清单 3 条」）");
}

{
  const { store } = makeStore();
  store.add(approval("a1"));
  store.add(approval("a1"));
  assert.equal(store.view().items.length, 1, "同一个 id 重复 add 是幂等的（重连重放不该多一条）");
}

console.log("reminders-unit: ok");
