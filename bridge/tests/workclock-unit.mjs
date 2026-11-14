/**
 * 上下班统计的纯逻辑：解析、去重、挑上班时刻、按天汇总、设置归一。
 *
 * 守的是三条口径（页面上的倒计时全靠它们）：
 * ① 上班 = 当天第一次解锁，记录器事件优先于日志回填，同一天两者都有时**不混算**；
 * ② 倒计时走墙上时间：今天还没锁屏就按「现在」算已工作，锁屏了就停在最后一次锁屏；
 * ③ 休息日只记解锁、不算达标。
 *
 * 不碰磁盘、不跑 PowerShell（那两条路要真机，见 docs 里的手工验收）。
 *
 *   node bridge/tests/workclock-unit.mjs
 */
import assert from "node:assert/strict";
import {
  dedupeEvents,
  localDateKey,
  normalizeSettings,
  parseEventLines,
  parseLogEvents,
  summarizeCoverage,
  summarizeDays,
  summarizeToday,
} from "../src/workclock.ts";

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} — ${err.message}`);
  }
};

/** 本地时间构造（不要用 Date.UTC：localDateKey 按本地分量切天）。 */
const at = (y, m, d, hh = 0, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss).getTime();
/** 每天都算上班，免得用例依赖跑测试那天是星期几。 */
const ALL_DAYS = { hours: 9, workdays: [0, 1, 2, 3, 4, 5, 6], notify: true, updatedAt: 0 };
const ev = (t, k, src = "event") => ({ t, k, src });
const HOUR = 3_600_000;

check("localDateKey 按本地分量切天：23:59 与次日 00:01 不是同一天", () => {
  assert.equal(localDateKey(at(2026, 3, 10, 23, 59)), "2026-03-10");
  assert.equal(localDateKey(at(2026, 3, 11, 0, 1)), "2026-03-11");
});

check("parseEventLines：坏行跳过，未知 src 归一成 event，其余原样", () => {
  const text = [
    "",
    "   ",
    "not json",
    "[1,2]",
    JSON.stringify({ t: at(2026, 3, 10, 8), k: "unlock", src: "event" }),
    JSON.stringify({ t: at(2026, 3, 10, 18), k: "lock", src: "start" }),
    JSON.stringify({ t: at(2026, 3, 10, 19), k: "lock", src: "poll" }),
    JSON.stringify({ t: at(2026, 3, 10, 20), k: "lock", src: "weird" }),
    JSON.stringify({ t: 0, k: "unlock" }),
    JSON.stringify({ t: -1, k: "unlock" }),
    JSON.stringify({ t: "123", k: "unlock" }),
    JSON.stringify({ t: at(2026, 3, 10, 21), k: "wake" }),
    JSON.stringify({ t: at(2026, 3, 10, 22), k: "unlock" }),
  ].join("\r\n");
  const out = parseEventLines(text);
  assert.equal(out.length, 5);
  assert.deepEqual(out[0], { t: at(2026, 3, 10, 8), k: "unlock", src: "event" });
  assert.equal(out[3].src, "event");
  assert.equal(out[4].k, "unlock");
});

check("parseLogEvents：非数组给空，非法项丢掉，来源强制 log", () => {
  assert.deepEqual(parseLogEvents(null), []);
  assert.deepEqual(parseLogEvents({ a: 1 }), []);
  const out = parseLogEvents([
    { t: at(2026, 3, 9, 7), k: "unlock", src: "event" },
    { t: at(2026, 3, 9, 7, 0, 3), k: "lock" },
    { t: 0, k: "unlock" },
    { k: "unlock" },
    null,
    "x",
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { t: at(2026, 3, 9, 7), k: "unlock", src: "log" });
  assert.deepEqual(out[1], { t: at(2026, 3, 9, 7, 0, 3), k: "lock", src: "log" });
});

check("dedupeEvents：同种事件 5 秒内只留最早的一条，且按时间排序", () => {
  const t = at(2026, 3, 10, 8);
  const out = dedupeEvents([
    ev(t + 2_000, "unlock"),
    ev(t, "unlock"),
    ev(t + 3_000, "unlock"),
    ev(t + 5_000, "unlock"),
    ev(t + 6_000, "lock"),
    ev(t + 7_000, "lock"),
    ev(t + 8_000, "unlock"),
  ]);
  assert.deepEqual(
    out.map((e) => [e.t - t, e.k]),
    [
      [0, "unlock"],
      [5_000, "unlock"],
      [6_000, "lock"],
      [8_000, "unlock"],
    ],
  );
});

check("只有记录器启动时刻时用它兜底（上班还没被看到也先有个倒计时）", () => {
  const now = at(2026, 3, 10, 20);
  const days = summarizeDays([ev(at(2026, 3, 10, 15), "unlock", "start")], ALL_DAYS, now);
  assert.equal(days[0].firstUnlock, at(2026, 3, 10, 15));
  assert.equal(days[0].source, "event");
});

check("启动时刻比日志回填弱：中途装记录器不把上班时间推候", () => {
  const now = at(2026, 3, 10, 20);
  const days = summarizeDays(
    [ev(at(2026, 3, 10, 9), "unlock", "log"), ev(at(2026, 3, 10, 15), "unlock", "start")],
    ALL_DAYS,
    now,
  );
  assert.equal(days[0].firstUnlock, at(2026, 3, 10, 9));
  assert.equal(days[0].source, "log");
});

check("记录器事件优先于日志回填：同一天两者都有时不取更早的日志", () => {
  const now = at(2026, 3, 10, 20);
  const days = summarizeDays(
    [ev(at(2026, 3, 10, 7), "unlock", "log"), ev(at(2026, 3, 10, 8), "unlock", "event"), ev(at(2026, 3, 10, 18), "lock")],
    ALL_DAYS,
    now,
  );
  assert.equal(days[0].firstUnlock, at(2026, 3, 10, 8));
  assert.equal(days[0].source, "event");
  assert.equal(days[0].workedMs, 10 * HOUR);
});

check("没有记录器事件时退到日志，来源记 log；只有轮询估计时记 poll", () => {
  const now = at(2026, 3, 10, 20);
  const logged = summarizeDays([ev(at(2026, 3, 10, 7), "unlock", "log")], ALL_DAYS, now);
  assert.equal(logged[0].source, "log");
  assert.equal(logged[0].firstUnlock, at(2026, 3, 10, 7));
  const polled = summarizeDays([ev(at(2026, 3, 10, 9), "unlock", "poll")], ALL_DAYS, now);
  assert.equal(polled[0].source, "poll");
});

check("今天还没锁屏：已工作算到「现在」，ongoing 为真", () => {
  const now = at(2026, 3, 10, 12);
  const days = summarizeDays([ev(at(2026, 3, 10, 9), "unlock")], ALL_DAYS, now);
  assert.equal(days[0].lastEnd, now);
  assert.equal(days[0].workedMs, 3 * HOUR);
  assert.equal(days[0].ongoing, true);
});

check("今天已锁屏：工时停在最后一次锁屏，ongoing 为假", () => {
  const now = at(2026, 3, 10, 20);
  const days = summarizeDays([ev(at(2026, 3, 10, 9), "unlock"), ev(at(2026, 3, 10, 17), "lock")], ALL_DAYS, now);
  assert.equal(days[0].lastEnd, at(2026, 3, 10, 17));
  assert.equal(days[0].workedMs, 8 * HOUR);
  assert.equal(days[0].ongoing, false);
});

check("达标只在工作日算：休息日干满 9 小时也 met=false", () => {
  const now = at(2026, 3, 10, 23); // 2026-03-10 是周二
  const today = new Date(now).getDay();
  const events = [ev(at(2026, 3, 10, 8), "unlock"), ev(at(2026, 3, 10, 22), "lock")];
  const workday = summarizeDays(events, { ...ALL_DAYS, workdays: [today] }, now)[0];
  assert.equal(workday.workday, true);
  assert.equal(workday.met, true);
  const rest = summarizeDays(events, { ...ALL_DAYS, workdays: [(today + 3) % 7] }, now)[0];
  assert.equal(rest.workday, false);
  assert.equal(rest.met, false);
  assert.equal(rest.workedMs, 14 * HOUR);
});

check("summarizeDays：窗口里每天一行、日期倒序、没上工的记 null", () => {
  const now = at(2026, 3, 10, 12);
  const days = summarizeDays([ev(at(2026, 3, 8, 9), "unlock")], ALL_DAYS, now, 4);
  assert.deepEqual(
    days.map((d) => d.date),
    ["2026-03-10", "2026-03-09", "2026-03-08", "2026-03-07"],
  );
  assert.equal(days[0].firstUnlock, null);
  assert.equal(days[0].workedMs, 0);
  assert.equal(days[0].unlocks, 0);
  assert.equal(days[2].firstUnlock, at(2026, 3, 8, 9));
});

check("summarizeDays：未来时间的事件（时钟漂移）不算进今天", () => {
  const now = at(2026, 3, 10, 12);
  const days = summarizeDays([ev(now + 10 * 60_000, "unlock")], ALL_DAYS, now, 1);
  assert.equal(days[0].firstUnlock, null);
});

check("summarizeToday：目标下班 = 上班 + 工时，remaining 可负，明细只含当天", () => {
  const now = at(2026, 3, 10, 20);
  const events = [ev(at(2026, 3, 10, 9), "unlock"), ev(at(2026, 3, 9, 9), "unlock", "log")];
  const days = summarizeDays(events, ALL_DAYS, now);
  const today = summarizeToday(days, events, ALL_DAYS, now);
  assert.equal(today.target, at(2026, 3, 10, 18));
  assert.equal(today.remainingMs, -2 * HOUR);
  assert.equal(today.events.length, 1);
  assert.equal(today.events[0].t, at(2026, 3, 10, 9));
});

check("summarizeToday：没上班记录时 target / remaining / 明细都空", () => {
  const now = at(2026, 3, 10, 9);
  const days = summarizeDays([], ALL_DAYS, now);
  const today = summarizeToday(days, [], ALL_DAYS, now);
  assert.equal(today.target, null);
  assert.equal(today.remainingMs, null);
  assert.deepEqual(today.events, []);
});

check("normalizeSettings：默认 9 小时 + 周一到周五", () => {
  const s = normalizeSettings(null);
  assert.equal(s.hours, 9);
  assert.deepEqual(s.workdays, [1, 2, 3, 4, 5]);
  assert.equal(s.notify, true);
  assert.equal(s.updatedAt, 0);
});

check("normalizeSettings：工时夹在 0.5–24 并取 0.5 步长", () => {
  assert.equal(normalizeSettings({ hours: 0.1 }).hours, 0.5);
  assert.equal(normalizeSettings({ hours: 40 }).hours, 24);
  assert.equal(normalizeSettings({ hours: 8.26 }).hours, 8.5);
  assert.equal(normalizeSettings({ hours: 7.24 }).hours, 7);
  assert.equal(normalizeSettings({ hours: Number.NaN }).hours, 9);
  assert.equal(normalizeSettings({ hours: "8" }).hours, 9);
});

check("normalizeSettings：星期去重、排序、丢掉非法值，空表回默认", () => {
  assert.deepEqual(normalizeSettings({ workdays: [5, 1, 1, 9, -1, 2.5] }).workdays, [1, 5]);
  assert.deepEqual(normalizeSettings({ workdays: [] }).workdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(normalizeSettings({ workdays: "mon" }).workdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(normalizeSettings({ workdays: [6, 0] }).workdays, [0, 6]);
});

check("normalizeSettings：notify 只有显式 false 才关，updatedAt 透传", () => {
  assert.equal(normalizeSettings({ notify: false }).notify, false);
  assert.equal(normalizeSettings({ notify: 0 }).notify, true);
  assert.equal(normalizeSettings({ updatedAt: 1700000000000 }).updatedAt, 1700000000000);
});

check("summarizeCoverage：按来源数天数，from/to 取首末解锁", () => {
  const now = at(2026, 3, 10, 12);
  const days = summarizeDays(
    [
      ev(at(2026, 3, 9, 9), "unlock", "log"),
      ev(at(2026, 3, 10, 9), "unlock", "event"),
      ev(at(2026, 3, 8, 9), "unlock", "poll"),
    ],
    ALL_DAYS,
    now,
  );
  const coverage = summarizeCoverage(days);
  assert.equal(coverage.days, 3);
  assert.equal(coverage.logDays, 1);
  assert.equal(coverage.agentDays, 2);
  assert.equal(coverage.from, at(2026, 3, 8, 9));
  assert.equal(coverage.to, at(2026, 3, 10, 9));
});

if (failures) {
  console.log(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log("\n上下班逻辑：全部通过");
