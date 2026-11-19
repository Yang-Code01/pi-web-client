/**
 * 考勤模块的纯函数部分（#考勤）：不碰网络、不碰文件，只验口径。
 *
 * 这里守的是「说话算数」里最容易悄悄漂的那几条：区间裁剪（一次最多 90 天）、
 * 登录退避（OA 会锁账号，试错等于把人锁外面）、提交指纹（防重复提交）、
 * 以及「语义没坐实的字段不猜」——`mapRow` 只挑认得的，其余原样留在 `raw` 里。
 *
 *   node bridge/tests/attendance-unit.mjs
 *   （Node 22 要加 `--experimental-transform-types`；Node 26 起类型剥离默认开启。）
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const M = await import("../src/attendance-model.ts");

// ---------------------------------------------------------------- 日期

test("dateKey / isDateKey 只认 YYYY-MM-DD", () => {
  assert.equal(M.dateKey(new Date(2026, 10, 17)), "2026-11-17");
  assert.equal(M.isDateKey("2026-11-17"), true);
  assert.equal(M.isDateKey("2026-11-17T00:00:00"), false);
  assert.equal(M.isDateKey("2026-13-40"), false);
  assert.equal(M.isDateKey(""), false);
  assert.equal(M.isDateKey(20261117), false);
});

test("addDays / diffDays 跨月跨年都对", () => {
  assert.equal(M.addDays("2026-11-17", 1), "2026-11-18");
  assert.equal(M.addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(M.addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(M.addDays("2026-03-01", -1), "2026-02-28");
  // diffDays(a, b) 是 b - a 的天数。
  assert.equal(M.diffDays("2026-11-10", "2026-11-17"), 7);
  assert.equal(M.diffDays("2026-11-17", "2026-11-10"), -7);
});

// ---------------------------------------------------------------- 区间

test("clampRange：正常区间原样返回", () => {
  const r = M.clampRange("2026-11-10", "2026-11-16", "2026-11-17");
  assert.deepEqual(r, { start: "2026-11-10", end: "2026-11-16", clamped: false, problem: null });
});

test("clampRange：格式不对退化成最近 7 天并给出原因", () => {
  const r = M.clampRange("2026/11/10", "2026-11-16", "2026-11-17");
  assert.equal(r.start, "2026-11-11");
  assert.equal(r.end, "2026-11-17");
  assert.equal(r.clamped, true);
  assert.match(r.problem, /YYYY-MM-DD/);
});

test("clampRange：起止反了自动对调", () => {
  const r = M.clampRange("2026-11-16", "2026-11-10", "2026-11-17");
  assert.equal(r.start, "2026-11-10");
  assert.equal(r.end, "2026-11-16");
  assert.equal(r.clamped, false);
  assert.match(r.problem, /对调/);
});

test("clampRange：终点未来收到今天", () => {
  const r = M.clampRange("2026-11-10", "2026-12-01", "2026-11-17");
  assert.equal(r.end, "2026-11-17");
  assert.equal(r.clamped, true);
});

test("clampRange：超过 90 天从起点裁掉，并说清上限", () => {
  const r = M.clampRange("2026-01-01", "2026-11-17", "2026-11-17");
  assert.equal(r.end, "2026-11-17");
  assert.equal(r.start, M.addDays("2026-11-17", -(M.MAX_RANGE_DAYS - 1)));
  assert.equal(M.diffDays(r.start, r.end) + 1, M.MAX_RANGE_DAYS);
  assert.equal(r.clamped, true);
  assert.match(r.problem, /90/);
});

test("clampRange：90 天按跨度算，终点早于今天也给满 90 天", () => {
  // 回看历史：end 是 11-16（昨天），区间应该是 11-16 往前数 90 天，
  // 而不是被今天的 90 天窗口白白截掉一天。
  const r = M.clampRange("2020-01-01", "2026-11-16", "2026-11-17");
  assert.equal(r.end, "2026-11-16");
  assert.equal(M.diffDays(r.start, r.end) + 1, M.MAX_RANGE_DAYS);
  assert.equal(r.start, M.addDays("2026-11-16", -(M.MAX_RANGE_DAYS - 1)));
  assert.equal(r.clamped, true);
});

test("clampRange：整段都在未来时不会给出反向区间", () => {
  const r = M.clampRange("2026-12-01", "2026-12-05", "2026-11-17");
  assert.equal(r.start, "2026-11-17");
  assert.equal(r.end, "2026-11-17");
  assert.equal(r.clamped, true);
});

// ---------------------------------------------------------------- 登录退避

test("loginGate：没失败就放行", () => {
  const g = M.loginGate([], 1_000_000);
  assert.equal(g.allowed, true);
  assert.equal(g.waitMs, 0);
  assert.equal(g.reason, null);
});

test("loginGate：失败一次后要等 1 秒", () => {
  const now = 1_000_000;
  assert.equal(M.loginGate([now], now).allowed, false);
  assert.equal(M.loginGate([now], now + 1_000).allowed, true);
});

test("loginGate：退避翻倍", () => {
  const now = 1_000_000;
  const two = M.loginGate([now - 20_000, now - 10_000], now - 9_000);
  assert.equal(two.allowed, false);
  assert.equal(two.waitMs, 2_000 - 1_000);
});

test("loginGate：十分钟内满三次就封到窗口滑过去", () => {
  const now = 1_000_000;
  const failures = [now - 60_000, now - 50_000, now - 40_000];
  const g = M.loginGate(failures, now);
  assert.equal(g.allowed, false);
  assert.equal(g.failures, 3);
  assert.equal(g.waitMs, 540_000, "最早那次 + 10 分钟 - 现在");
  assert.match(g.reason, /连续失败 3 次/);
  // 窗口滑过最早那次就重新放行。
  assert.equal(M.loginGate(failures, now - 60_000 + M.LOGIN_WINDOW_MS).allowed, true);
});

test("loginGate：窗口外的失败不再算数", () => {
  const now = 1_000_000;
  const old = [now - M.LOGIN_WINDOW_MS - 1, now - M.LOGIN_WINDOW_MS - 2, now - M.LOGIN_WINDOW_MS - 3];
  assert.equal(M.loginGate(old, now).allowed, true);
});

test("loginRetryDelay 单调递增并且有上限", () => {
  assert.equal(M.loginRetryDelay(0), 0);
  assert.equal(M.loginRetryDelay(1), 1_000);
  assert.equal(M.loginRetryDelay(2), 2_000);
  assert.equal(M.loginRetryDelay(3), 4_000);
  assert.equal(M.loginRetryDelay(20), 60_000);
});

// ---------------------------------------------------------------- 提交指纹

const base = { account: "TS0001", startTime: "2026-11-16T18:00:00", endTime: "2026-11-16T20:00:00", hours: 2, reason: '{"type":"进度延迟"}' };

test("receiptKey 同内容同指纹，与大小写/首尾空格无关", () => {
  const a = M.receiptKey(base);
  const b = M.receiptKey({ ...base, account: " ts0001 ", startTime: " 2026-11-16T18:00:00 " });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test("receiptKey 内容变一点指纹就变", () => {
  const a = M.receiptKey(base);
  for (const patch of [{ hours: 2.5 }, { endTime: "2026-11-16T21:00:00" }, { reason: '{"type":"追加作业"}' }]) {
    assert.notEqual(M.receiptKey({ ...base, ...patch }), a, JSON.stringify(patch));
  }
});

test("findReceipt 只挡成功的、窗口内的", () => {
  const key = M.receiptKey(base);
  const now = 1_000_000;
  assert.equal(M.findReceipt([], key, now), null);
  // 失败的记录不挡重试。
  assert.equal(M.findReceipt([{ key, at: now - 1_000, ok: false }], key, now), null);
  // 窗口外的成功记录不挡。
  assert.equal(M.findReceipt([{ key, at: now - 11 * 60_000, ok: true }], key, now), null);
  const hit = M.findReceipt(
    [
      { key, at: now - 9 * 60_000, ok: true, code: "1" },
      { key, at: now - 1 * 60_000, ok: true, code: "2" },
    ],
    key,
    now,
  );
  assert.equal(hit.code, "2", "取最近的那条");
});

// ---------------------------------------------------------------- 掩码

test("maskAccount 长账号留头两位和末一位，短账号只留首位", () => {
  assert.equal(M.maskAccount(""), "");
  assert.equal(M.maskAccount("TS0001"), "TS***1");
  assert.equal(M.maskAccount("abc"), "a***");
  assert.equal(M.maskAccount("  yangqm@example.com  "), "ya***m");
});

// ---------------------------------------------------------------- 行映射

const RAW = {
  day: "2026-10-08(四)",
  day_type: 0,
  start: "09:20",
  end: "18:29",
  ov: 1.5,
  overtime_rewrite_enable: 1,
  update_name: "JS0130_王倩倩",
  c_hours: 8.5,
  t_hours: 0,
  code: "0",
  resign_flag: 0,
};

test("mapRow 挑认得的字段，其余原样留在 raw", () => {
  const row = M.mapRow(RAW);
  assert.equal(row.date, "2026-10-08");
  assert.equal(row.weekday, "四");
  assert.equal(row.dayOff, false);
  assert.equal(row.clockIn, "09:20");
  assert.equal(row.clockOut, "18:29");
  assert.equal(row.overtime, 1.5);
  assert.equal(row.overtimeEdited, true);
  assert.equal(row.editedBy, "JS0130_王倩倩");
  // 语义没坐实的字段不进模型字段，只能从 raw 里读。
  assert.equal(row.raw.c_hours, 8.5);
  assert.equal(row.raw.t_hours, 0);
  assert.equal(row.raw.code, "0");
});

test("mapRow：没打卡时时间是 null 而不是空串", () => {
  const row = M.mapRow({ ...RAW, start: null, end: "" });
  assert.equal(row.clockIn, null);
  assert.equal(row.clockOut, null);
});

// OA 的 day_type：0/4 = 平时（4 是调休上班的周六），1/3 = 周末，2 = 假日。
// 只认 1 会把国庆和祝日当成工作日，凭空多出缺卡。
test("mapRow：day_type 1/2/3 都是休息日", () => {
  assert.equal(M.mapRow({ ...RAW, day_type: 1 }).dayOff, true);
  assert.equal(M.mapRow({ ...RAW, day_type: "2" }).dayOff, true, "假日");
  assert.equal(M.mapRow({ ...RAW, day_type: 3 }).dayOff, true);
  assert.equal(M.mapRow({ ...RAW, day_type: 0 }).dayOff, false);
  assert.equal(M.mapRow({ ...RAW, day_type: 4 }).dayOff, false, "调休上班的周六要上班");
  assert.equal(M.mapRow({ ...RAW, day_type: null }).dayOff, false);
});

test("mapRow：字段名可以换（换 OA 只改映射）", () => {
  const row = M.mapRow(
    { work_date: "2026-11-02", rest: 1, "in": "08:55", out: "19:05", ot: 2 },
    { day: "work_date", dayType: "rest", clockIn: "in", clockOut: "out", overtime: "ot" },
  );
  assert.equal(row.date, "2026-11-02");
  assert.equal(row.dayOff, true);
  assert.equal(row.clockIn, "08:55");
  assert.equal(row.clockOut, "19:05");
  assert.equal(row.overtime, 2);
});

test("mapRow：全天申请从小时字段认出来，半天不算", () => {
  const base = { ...RAW, c_hours: 0, t_hours: 0, start: null, end: null };
  const leave = M.mapRow({ ...base, c_hours: 8 });
  assert.equal(leave.absenceHours, 8);
  assert.equal(leave.fullDayExcused, true);
  const half = M.mapRow({ ...base, c_hours: 4 });
  assert.equal(half.absenceHours, 4);
  assert.equal(half.fullDayExcused, false, "只请了半天，另一半没打卡仍然要提醒");
  const mix = M.mapRow({ ...base, t_hours: 4, bt_hours: 4 });
  assert.equal(mix.absenceHours, 8, "事假 + 出差可以拼成一天");
  assert.equal(mix.fullDayExcused, true);
  assert.equal(M.mapRow({ ...base, o_hours: 8 }).fullDayExcused, true, "其他假期");
  assert.equal(M.mapRow({ ...base, home: 1 }).fullDayExcused, true, "居家办公");
  assert.equal(M.mapRow({ ...base, special_reason: "部门团建" }).fullDayExcused, true, "活动出勤");
  assert.equal(M.mapRow({ ...base }).fullDayExcused, false, "什么都没申请");
});

test("splitDay 拆不出来就原样当日期", () => {
  assert.deepEqual(M.splitDay("2026-10-08(四)"), { date: "2026-10-08", weekday: "四" });
  assert.deepEqual(M.splitDay("2026-10-08"), { date: "2026-10-08", weekday: "" });
  assert.deepEqual(M.splitDay(null), { date: "", weekday: "" });
});

test("clockOf / numOf 不吃字符串里的脏东西", () => {
  assert.equal(M.clockOf("09:20"), "09:20");
  assert.equal(M.clockOf("9:20"), "09:20", "补零，页面里对齐");
  assert.equal(M.clockOf("09:20:33"), "09:20");
  // 认不出来但非空的，原样透出（OA 说了什么就显示什么，不替它编）；空的才算没打卡。
  assert.equal(M.clockOf("abc"), "abc");
  assert.equal(M.clockOf("   "), null);
  assert.equal(M.clockOf(undefined), null);
  assert.equal(M.numOf("1.5"), 1.5);
  assert.equal(M.numOf(2), 2);
  assert.equal(M.numOf(null), 0);
  assert.equal(M.numOf("x"), 0);
});

// ---------------------------------------------------------------- 汇总

test("summarize：平淡期周末不算缺卡", () => {
  const rows = [
    M.mapRow({ day: "2026-11-14(六)", day_type: 1, start: "10:00", end: "15:00", ov: 5 }),
    M.mapRow({ day: "2026-11-16(一)", day_type: 0, start: "09:00", end: "18:00", ov: 0 }),
    M.mapRow({ day: "2026-11-17(二)", day_type: 0, start: "09:10", end: null, ov: 0 }),
  ];
  const s = M.summarize(rows, "2026-11-16");
  assert.equal(s.days, 3);
  assert.equal(s.attended, 3);
  assert.equal(s.missing, 1, "周一下班缺卡算一次；周六不缺");
  assert.equal(s.overtime, 5);
  assert.equal(s.weekendOvertime, 5);
  assert.equal(s.lastDay, "2026-11-17", "max_day 与行取大者");
});

test("summarize：今天整行不算缺卡（下班卡还没到点）", () => {
  const rows = [
    M.mapRow({ day: "2026-11-16(一)", day_type: 0, start: "09:00", end: "18:00", ov: 0 }),
    M.mapRow({ day: "2026-11-17(二)", day_type: 0, start: null, end: null, ov: 0 }),
  ];
  assert.equal(M.summarize(rows, "2026-11-16").missing, 1, "不传 today 时今天也算缺卡");
  assert.equal(M.summarize(rows, "2026-11-16", "2026-11-17").missing, 0, "传了 today 就整行跳过");
  const half = [M.mapRow({ day: "2026-11-17(二)", day_type: 0, start: "09:10", end: null, ov: 0 })];
  assert.equal(M.summarize(half, "", "2026-11-17").missing, 0, "今天只有上班卡也不算缺");
  assert.equal(M.summarize(half, "", "2026-11-17").attended, 1, "出勤数照算");
});

test("summarize：整天请假没打卡不算缺卡", () => {
  const rows = [
    // 11/2 周一整天调休：OA 里 code=申请单号、c_hours=8、没有打卡。
    M.mapRow({ day: "2026-11-02(一)", day_type: 0, start: null, end: null, c_hours: 8, code: "109603", err: 0 }),
    // 只有半天假、又完全没打卡：另一半没人解释，仍然算缺卡。
    M.mapRow({ day: "2026-11-03(二)", day_type: 0, start: null, end: null, c_hours: 4, code: "109604", err: 0 }),
    // 出差一整天。
    M.mapRow({ day: "2026-11-04(三)", day_type: 0, start: null, end: null, bt_hours: 8, bt_code: "123" }),
  ];
  assert.equal(M.summarize(rows, "").missing, 1, "只有 11/03 那天算缺卡");
});

test("summarize：假日与周末没打卡不算缺卡", () => {
  const rows = [
    M.mapRow({ day: "2026-10-05(一)", day_type: 3, start: null, end: null }),
    M.mapRow({ day: "2026-10-06(二)", day_type: 2, start: null, end: null }),
    M.mapRow({ day: "2026-10-10(六)", day_type: 1, start: null, end: null }),
    M.mapRow({ day: "2026-10-08(四)", day_type: 0, start: null, end: null }),
  ];
  const s = M.summarize(rows, "");
  assert.equal(s.missing, 1, "只剩 10/08 这个工作日");
  assert.equal(s.attended, 0);
});

// OA 只有一次打卡时会把 start/end 填成同一时刻（11/13 09:27/09:27、11/14 11:00/11:00），
// 只看「有没有值」会把「忘了打下班卡」整条漏掉。
test("summarize：上下班时间相同等于只打了一次卡", () => {
  const rows = [M.mapRow({ day: "2026-11-13(五)", day_type: 0, start: "09:27", end: "09:27" })];
  const s = M.summarize(rows, "");
  assert.equal(s.missing, 1);
  assert.equal(s.attended, 1, "人来了，出勤照算");
});

test("summarize：假日加班算进周末桶", () => {
  const rows = [
    M.mapRow({ day: "2026-10-01(四)", day_type: 2, start: "09:00", end: "12:00", ov: 3 }),
    M.mapRow({ day: "2026-11-14(六)", day_type: 1, ov: 5 }),
    M.mapRow({ day: "2026-11-16(一)", day_type: 0, start: "09:00", end: "21:00", ov: 3 }),
  ];
  const s = M.summarize(rows);
  assert.equal(s.weekendOvertime, 8, "假日 3 + 周末 5");
  assert.equal(s.overtime, 11);
});

test("summarize：空列表不会 NaN", () => {
  const s = M.summarize([]);
  assert.deepEqual(s, { days: 0, attended: 0, missing: 0, overtime: 0, weekendOvertime: 0, lastDay: "" });
});

test("summarize：加班小时按 0.1 收口，不出现 5.999999", () => {
  const rows = [M.mapRow({ day: "2026-11-14(六)", day_type: 1, ov: 1.5 }), M.mapRow({ day: "2026-11-15(日)", day_type: 1, ov: 1.5 })];
  assert.equal(M.summarize(rows).overtime, 3);
});

// ---------------------------------------------------------------- 加班申请

test("事由：OA 存的是 JSON 字符串", () => {
  const r = M.parseOvertimeReason('{"type":"进度延迟","project":"P1","detail":"赶版本"}');
  assert.deepEqual(r, { type: "进度延迟", project: "P1", detail: "赶版本" });
  assert.equal(M.formatOvertimeReason(r), '{"type":"进度延迟","project":"P1","detail":"赶版本"}');
});

test("事由：坏 JSON / 空值都退化成空串，不抛", () => {
  for (const bad of ["", "not json", null, undefined, 42, "[]"]) {
    assert.deepEqual(M.parseOvertimeReason(bad), { type: "", project: "", detail: "" });
  }
});

test("审批链字符串 roundtrip", () => {
  assert.equal(M.formatWorkflow([12, 34], [56]), "12,34&56");
  assert.equal(M.formatWorkflow([12], []), "12&");
  assert.deepEqual(M.parseWorkflow("12,34&56"), { l1: [12, 34], l2: [56] });
  assert.deepEqual(M.parseWorkflow("12&"), { l1: [12], l2: [] });
  assert.deepEqual(M.parseWorkflow(""), { l1: [], l2: [] });
  assert.deepEqual(M.parseWorkflow("0&-1"), { l1: [], l2: [] }, "非正数丢掉");
});

test("datetime-local 与 OA 的 ISO 互转", () => {
  assert.equal(M.toLocalInput("2026-11-16T18:00:00"), "2026-11-16T18:00");
  assert.equal(M.toLocalInput("2026-11-16 18:00"), "2026-11-16T18:00");
  assert.equal(M.toLocalInput(""), "");
  assert.equal(M.fromLocalInput("2026-11-16T18:00"), "2026-11-16T18:00:00");
  assert.equal(M.fromLocalInput("2026-11-16T18:00:30"), "2026-11-16T18:00:30");
  assert.equal(M.fromLocalInput("nope"), "");
});

const draft = {
  startTime: "2026-11-16T18:00",
  endTime: "2026-11-16T20:00",
  hours: 2,
  reason: { type: "进度延迟", project: "", detail: "" },
  workflow: "12&56",
};

test("checkDraft：合格草稿没有毛病", () => {
  assert.equal(M.checkDraft(draft), null);
});

test("checkDraft：逐条毛病", () => {
  assert.equal(M.checkDraft({ ...draft, startTime: "" }).code, "time_missing");
  assert.equal(M.checkDraft({ ...draft, endTime: "" }).code, "time_missing");
  assert.equal(M.checkDraft({ ...draft, endTime: "2026-11-16T17:00" }).code, "time_order");
  assert.equal(M.checkDraft({ ...draft, endTime: "2026-11-16T18:00" }).code, "time_order");
  assert.equal(M.checkDraft({ ...draft, hours: 0 }).code, "hours_zero");
  assert.equal(M.checkDraft({ ...draft, hours: 5 }).code, "hours_mismatch");
  assert.equal(M.checkDraft({ ...draft, reason: { type: "", project: "", detail: "" } }).code, "reason_type_missing");
  assert.equal(M.checkDraft({ ...draft, workflow: "&" }).code, "approver_missing");
});

test("checkDraft：差不到一小时不拦（OA 允许按半天取整）", () => {
  assert.equal(M.checkDraft({ ...draft, hours: 2.5 }), null);
  assert.equal(M.checkDraft({ ...draft, hours: 1.5 }), null);
});

test("normalizeHours 只收 0.5 的倍数", () => {
  assert.equal(M.normalizeHours(2), 2);
  assert.equal(M.normalizeHours(2.3), 2.5);
  assert.equal(M.normalizeHours(2.2), 2);
  assert.equal(M.normalizeHours(0), 0);
  assert.equal(M.normalizeHours(-1), 0);
  assert.equal(M.normalizeHours(Number.NaN), 0);
});

test("round1 不产生浮点尾巴", () => {
  assert.equal(M.round1(0.1 + 0.2), 0.3);
  assert.equal(M.round1(1.449), 1.4);
  assert.equal(M.round1(1.45), 1.5);
});

// ---------------------------------------------------------------- 加班申请提醒

const R = await import("../src/attendance-reminder.ts");

test("weekdayOfDate：周日算 7，不是 0", () => {
  // 2026-11-16 周一 … 2026-11-22 周日
  assert.equal(R.weekdayOfDate(new Date(2026, 10, 16, 10, 0)), 1);
  assert.equal(R.weekdayOfDate(new Date(2026, 10, 20, 10, 0)), 5);
  assert.equal(R.weekdayOfDate(new Date(2026, 10, 21, 10, 0)), 6);
  assert.equal(R.weekdayOfDate(new Date(2026, 10, 22, 10, 0)), 7);
});

test("minutesOf / clockOfMinutes 互为反函数，坏输入有就回 -1", () => {
  assert.equal(R.minutesOf("18:00"), 1080);
  assert.equal(R.minutesOf("09:05"), 545);
  assert.equal(R.clockOfMinutes(1080), "18:00");
  assert.equal(R.clockOfMinutes(545), "09:05");
  assert.equal(R.minutesOf("24:00"), null);
  assert.equal(R.minutesOf("18:60"), null);
  assert.equal(R.minutesOf("18"), null);
  assert.equal(R.minutesOf("abc"), null);
});

test("normalizeRule：缺的字段回落到上一版，坏值被夹住", () => {
  const base = { enabled: false, days: [5], time: "18:00", text: "默认" };
  assert.deepEqual(R.normalizeRule({}, base), base);
  assert.deepEqual(R.normalizeRule({ enabled: true }, base), { ...base, enabled: true });
  assert.deepEqual(R.normalizeRule({ days: [7, 1, 1, 9, 0] }, base).days, [1, 7]);
  // 显式给空数组就是「一个都不选」，不回落；能不能存由 ruleProblem 说了算。
  assert.deepEqual(R.normalizeRule({ days: [] }, base).days, []);
  assert.match(R.ruleProblem({ ...base, enabled: true, days: [] }), /至少选一个星期/);
  assert.equal(R.normalizeRule({ time: "19:30" }, base).time, "19:30");
  assert.equal(R.normalizeRule({ time: "19:99" }, base).time, base.time);
  assert.equal(R.normalizeRule({ text: "  " }, base).text, base.text);
  const long = "长".repeat(R.MAX_REMINDER_TEXT + 20);
  assert.equal(R.normalizeRule({ text: long }, base).text.length, R.MAX_REMINDER_TEXT);
});

test("ruleProblem：关着就不管，开着才挑毛病", () => {
  const rule = { enabled: false, days: [], time: "25:00", text: "" };
  assert.equal(R.ruleProblem(rule), null);
  assert.match(R.ruleProblem({ ...rule, enabled: true, time: "18:00" }), /至少选一个星期/);
  assert.match(R.ruleProblem({ ...rule, enabled: true, days: [1] }), /HH:MM/);
  assert.equal(R.ruleProblem({ enabled: true, days: [1], time: "18:00", text: "" }), "提示内容不能空");
});

test("reminderDue：不在今天 / 没到点 / 今天已经发过，都不发", () => {
  const rule = { enabled: true, days: [2], time: "18:00", text: "x" };
  const now = new Date(2026, 10, 17, 18, 5);   // 周二 18:05
  assert.equal(R.reminderDue({ ...rule, enabled: false }, "", now).fire, false);
  assert.equal(R.reminderDue({ ...rule, days: [1] }, "", now).fire, false);
  assert.equal(R.reminderDue({ ...rule, time: "18:30" }, "", now).fire, false);
  assert.equal(R.reminderDue(rule, "2026-11-17", now).fire, false);
  const hit = R.reminderDue(rule, "2026-11-14", now);
  assert.equal(hit.fire, true);
  assert.equal(hit.offsetMinutes, 5);
  assert.equal(hit.late, true);
  assert.equal(R.reminderDue(rule, "", new Date(2026, 10, 17, 18, 0)).late, false);
});

test("reminderBody：补发时说明是几点那次的", () => {
  const rule = { enabled: true, days: [2], time: "18:00", text: "该交了" };
  assert.equal(R.reminderBody(rule, false), "该交了");
  assert.match(R.reminderBody(rule, true), /18:00/);
});

test("normalizeRule 后再 ruleProblem 仍然认账（顺序反了会漏检查）", () => {
  const base = R.DEFAULT_RULE;
  const rule = R.normalizeRule({ enabled: true, days: [3, 3], time: "17:45", text: "提交加班" }, base);
  assert.equal(R.ruleProblem(rule), null);
  assert.deepEqual(rule.days, [3]);
});
// ---------------------------------------------------------------- 审批人（默认值与固定名单）

const A = await import("../src/attendance.ts");
const pool = [
  { userId: 11, name: "王五", workNo: "TS0003" },
  { userId: 12, name: "赵六", workNo: "TS0004" },
  { userId: 9, name: "李四", workNo: "TS0002" },
];

test("parsePerson 拆「姓名-工号」，缺一半也不炸", () => {
  assert.deepEqual(A.parsePerson("王五-TS0003"), { name: "王五", workNo: "TS0003" });
  assert.deepEqual(A.parsePerson(" 王五-TS0003 "), { name: "王五", workNo: "TS0003" });
  assert.deepEqual(A.parsePerson("阿卜杜拉-买买提-TS0001"), { name: "阿卜杜拉-买买提", workNo: "TS0001" });
  assert.deepEqual(A.parsePerson("王五"), { name: "王五", workNo: "" });
  assert.deepEqual(A.parsePerson(""), { name: "", workNo: "" });
  assert.deepEqual(A.parsePerson(null), { name: "", workNo: "" });
  assert.deepEqual(A.parsePerson(42), { name: "", workNo: "" });
});

test("resolvePeople 按工号对 id，对不上的直接丢", () => {
  assert.deepEqual(A.resolvePeople(["王五-TS0003", "赵六-TS0004"], pool).map((p) => p.userId), [11, 12]);
  assert.deepEqual(A.resolvePeople(["王五-TS9999"], pool), []);
  assert.deepEqual(A.resolvePeople(["赵六"], pool).map((p) => p.userId), [12]);
  assert.deepEqual(A.resolvePeople(["王五-TS0003", "王五-TS0003", "", null, 7], pool).map((p) => p.userId), [11]);
  assert.deepEqual(A.resolvePeople(null, pool), []);
});

test("readDepartManagers 只取 last.depart_manager", () => {
  assert.deepEqual(A.readDepartManagers({ last: { depart_manager: ["王五-TS0003", "赵六-TS0004"] } }), ["王五-TS0003", "赵六-TS0004"]);
  assert.deepEqual(A.readDepartManagers({ data: [{ depart_manager: "张一-TS0010" }] }), []);
  assert.deepEqual(A.readDepartManagers({ last: { depart_manager: "王五-TS0003" } }), []);
  assert.deepEqual(A.readDepartManagers(null), []);
});

test("lastLeadApprover 取最新那条的 idx1，处理过就看 handle_user_name", () => {
  const workflow = {
    1: [
      { workflow_index: 0, workflow_user_name: "张三-TS0001", handle_user_name: "张三-TS0001" },
      { workflow_index: 1, workflow_user_name: "李四-TS0002", handle_user_name: null },
    ],
    2: [{ workflow_index: 1, workflow_user_name: "王五-TS0003,赵六-TS0004", handle_user_name: "王五-TS0003" }],
  };
  assert.equal(A.lastLeadApprover([{ code: 1, start_time: "2026-11-10T18:00:00" }, { code: 2, start_time: "2026-11-16T18:00:00" }], workflow), "王五-TS0003");
  assert.equal(A.lastLeadApprover([{ code: 1, start_time: "2026-11-10T18:00:00" }], workflow), "李四-TS0002");
  assert.equal(A.lastLeadApprover([{ code: 2, start_time: "2026-11-16T18:00:00" }], { 2: [{ workflow_index: 1, workflow_user_name: "王五-TS0003,赵六-TS0004", handle_user_name: "" }] }), "王五-TS0003");
  assert.equal(A.lastLeadApprover([], workflow), "");
  assert.equal(A.lastLeadApprover([{ code: 404, start_time: "2026-11-16T18:00:00" }], workflow), "");
});

test("lastStepPeople 用 workflow_user_name 当名单，不拿 handle 当名单", () => {
  const workflow = {
    1: [
      { workflow_index: 1, workflow_user_name: "李四-TS0002", handle_user_name: "李四-TS0002" },
      { workflow_index: 2, workflow_user_name: "王五-TS0003,赵六-TS0004", handle_user_name: "王五-TS0003" },
    ],
  };
  const list = [{ code: 1, start_time: "2026-11-12T18:00:00" }];
  // 第二级有两个人：只批过一个，但名单要完整
  assert.deepEqual(A.lastStepPeople(list, workflow, 2), ["王五-TS0003", "赵六-TS0004"]);
  assert.deepEqual(A.lastStepPeople(list, workflow, 1), ["李四-TS0002"]);
  assert.deepEqual(A.lastStepPeople(list, workflow, 3), []);
  assert.deepEqual(A.lastStepPeople([], workflow, 2), []);
});

test("oaTime 把 ISO 的 T 换成空格，OA 只认这种", () => {
  assert.equal(M.oaTime("2026-11-17T18:00:00"), "2026-11-17 18:00:00");
  assert.equal(M.oaTime("2026-11-17 18:00:00"), "2026-11-17 18:00:00");
  assert.equal(M.oaTime(""), "");
});

test("OVERTIME_USE_TYPE_DEFAULT 是 1 —— OA 页面新建加班发明细就是 1", () => {
  assert.equal(M.OVERTIME_USE_TYPE_DEFAULT, 1);
});
