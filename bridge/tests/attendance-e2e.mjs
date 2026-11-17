/**
 * 考勤面板的桥端：假 OA + 临时状态目录，真跑 HTTP。
 *
 * 覆盖那几条「说话算数」：没配过不给数据、密码只进不出（页面只见掩码）、
 * 记录只查自己（keyword 永远是登录态里的 user_id）、上游 NG 不许当成功、
 * 提交要二次确认、十分钟内不许重复提交、隧道访客整个模块 404。
 *
 *   node bridge/tests/attendance-e2e.mjs
 *   （Node 22 要加 `--experimental-transform-types`；Node 26 起类型剥离默认开启。）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-attendance-e2e-")));
// 状态目录必须是这条用例自己的：写进真的 bridge 状态目录会污染本机的考勤配置。
process.env.PI_WEB_STATE = path.join(tmp, "state");
fs.mkdirSync(process.env.PI_WEB_STATE, { recursive: true });

const { handleAttendance } = await import("../src/attendance.ts");

// ---------------------------------------------------------------- 假 OA

// exp = 2100-01-01，够 tokenFresh 认一辈子；payload 要能真解出来，不然 jwtExp 会给 0。
const TOKEN = `x.${Buffer.from(JSON.stringify({ sub: "TS0001", exp: 4102444800 })).toString("base64url")}.y`;
/** `ok` / `ng` / `500`：登录单独一档，别的接口不跟着变。 */
let loginMode = "ok";
/** 记录接口单独一档：`ok` / `ng` / `500`。 */
let recordsMode = "ok";
/** 加班初始化单独一档：`ok` / `ng`。 */
let overtimeMode = "ok";
/** 提交/撤回的返回：`ok` / `ng`。 */
let writeMode = "ok";
/** 上游收到的记录查询体（断言 query_type 与 keyword）。 */
const seenQueries = [];
/** 上游收到的提交体。 */
const seenAdds = [];
let seenCancel = null;
/** 上游收到的 Authorization / token 头。 */
const seenTokens = [];
/** 上游登录收到的 query。 */
let seenLogin = null;

const ROWS = [
  { user_id: 1001, name: "张三", work_no: "TS0001", day: "2026-11-13(五)", day_type: 0, start: "09:05", end: "18:31", ov: 0, code: "0", c_hours: 8, t_hours: 0 },
  { user_id: 1001, name: "张三", work_no: "TS0001", day: "2026-11-16(一)", day_type: 0, start: "09:12", end: null, ov: 0, code: "0", c_hours: 8, t_hours: 0 },
  { user_id: 1001, name: "张三", work_no: "TS0001", day: "2026-11-14(六)", day_type: 1, start: "10:00", end: "15:00", ov: 5, code: "0", c_hours: 0, t_hours: 0 },
];

const oa = http.createServer((req, res) => {
  const url = new URL(req.url, "http://oa.test");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const token = req.headers.token ?? null;
  seenTokens.push(token);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }

    if (url.pathname === "/in/login/check") {
      seenLogin = { account: url.searchParams.get("user_account"), password: url.searchParams.get("user_password") };
      if (loginMode === "500") return send(500, { detail: "boom" });
      if (loginMode === "ng") return send(200, { status: "NG", error: "账号或密码错误" });
      return send(200, { status: "OK", token: TOKEN, user_id: 1001, name: "张三", work_no: "TS0001" });
    }

    if (url.pathname === "/in/record/query") {
      seenQueries.push({ token, body });
      if (recordsMode === "500") return send(500, { detail: "boom" });
      if (recordsMode === "ng") return send(200, { status: "NG", error: "查不到" });
      return send(200, { status: "OK", data_list: ROWS, max_day: "2026-11-16" });
    }

    if (url.pathname === "/in/apply/overtime/get") {
      if (overtimeMode === "ng") return send(200, { status: "NG", error: "取不到" });
      return send(200, {
        status: "OK",
        apply_list: [
          {
            code: 900001,
            user_id: 1001,
            name: "张三",
            agent_user_id: 0,
            agent_name: "",
            start_time: "2026-11-16T18:00:00",
            end_time: "2026-11-16T20:00:00",
            hours: 2,
            reason: '{"type":"进度延迟","project":"P1","detail":"赶版本"}',
            workflow_result: 0,
            expense: 0,
            reject_reason: null,
          },
        ],
        workflow_list: {
          900001: [
            { workflow_index: 0, workflow_role_name: "申请人", workflow_result: 1, handle_user_id: 1001, handle_user_name: "张三", update_time: "", workflow_user_name: "张三-TS0001" },
            { workflow_index: 1, workflow_role_name: "项目负责人", workflow_result: 0, handle_user_id: null, handle_user_name: null, update_time: "", workflow_user_name: "李四-TS0002" },
          ],
        },
        overtime_reason: ["进度延迟", "追加作业"],
        overtime_admit_time: "09:00~19:30",
        overtime_rule: "0&5&1",
        special_workflow_1: "",
      });
    }

    if (url.pathname === "/in/common/leaders") {
      return send(200, {
        status: "OK",
        list: {
          team_leaders: [{ user_id: 2001, name: "李四", work_no: "TS0002" }],
          depart_leaders: [
            { user_id: 3001, name: "王五", work_no: "TS0003" },
            { user_id: 3002, name: "赵六", work_no: "TS0004" },
          ],
        },
      });
    }

    if (url.pathname === "/in/apply/overtime/add") {
      seenAdds.push({ token, body });
      if (writeMode === "ng") return send(200, { status: "NG", message: "申请人不能是自己" });
      return send(200, { status: "OK", code: 900002 });
    }

    if (url.pathname === "/in/apply/overtime/cancel") {
      seenCancel = { code: url.searchParams.get("code"), token };
      if (writeMode === "ng") return send(200, { status: "NG", message: "已经批完了" });
      return send(200, { status: "OK" });
    }

    send(404, { detail: "Not Found" });
  });
});

const bridge = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://bridge.test");
  const ctx = { publicReq: req.headers["x-test-tunnel"] === "1", upstream: oaBase };
  if (await handleAttendance(req, res, url, ctx)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

const oaBase = await listen(oa);
const bridgeBase = await listen(bridge);

async function call(method, route, body, headers = {}) {
  const res = await fetch(bridgeBase + route, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 不是 JSON 就把原文给断言用 */
  }
  return { status: res.status, json, text };
}

test.after(() => {
  oa.close();
  bridge.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 用例

test("没配过：state 说没配，records 直接 400", async () => {
  const st = await call("GET", "/api/attendance/state");
  assert.equal(st.status, 200);
  assert.equal(st.json.configured, false);
  assert.equal(st.json.account, "");

  const rec = await call("GET", "/api/attendance/records?start=2026-11-10&end=2026-11-16");
  assert.equal(rec.status, 400);
  assert.equal(rec.json.code, "not_configured");
});

test("配地址：只收完整的 http(s)，不收带账号密码的", async () => {
  const bad = await call("PUT", "/api/attendance/config", { apiBase: "oa.test", account: "TS0001" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "bad_api_base");

  const withCreds = await call("PUT", "/api/attendance/config", { apiBase: "http://u:p@127.0.0.1:1", account: "TS0001" });
  assert.equal(withCreds.status, 400);
  assert.equal(withCreds.json.code, "bad_api_base");

  const noAccount = await call("PUT", "/api/attendance/config", { apiBase: "https://attendance.example.com:8443" });
  assert.equal(noAccount.status, 400);
  assert.equal(noAccount.json.code, "no_account");

  const ok = await call("PUT", "/api/attendance/config", {
    apiBase: "https://attendance.example.com:8443",
    pageBase: "https://attendance.example.com",
    account: "TS0001",
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });

  const st = await call("GET", "/api/attendance/state");
  assert.equal(st.json.configured, true);
  assert.equal(st.json.apiBase, "https://attendance.example.com:8443");
  assert.equal(st.json.pageBase, "https://attendance.example.com");
  assert.equal(st.json.loggedIn, false);
  // 账号出了桥就是掩码；完整账号只在 config.json 里。
  assert.equal(st.json.account, "TS***1");
});

test("账号留空：PUT / login 都沿用已经存着的那个；把掩码发回来直接拒", async () => {
  // 页面上只有掩码（TS***1）：用户不重填账号时，前端发空串，桥端要接住。
  const keep = await call("PUT", "/api/attendance/config", {
    apiBase: "https://attendance.example.com:8443",
    pageBase: "https://attendance.example.com",
    account: "",
  });
  assert.equal(keep.status, 200);
  assert.equal((await call("GET", "/api/attendance/state")).json.account, "TS***1");

  const masked = await call("PUT", "/api/attendance/config", {
    apiBase: "https://attendance.example.com:8443",
    account: "TS***1",
  });
  assert.equal(masked.status, 400);
  assert.equal(masked.json.code, "bad_account");

  const login = await call("POST", "/api/attendance/login", { password: "good" });
  assert.equal(login.status, 200);
  assert.equal(seenLogin.account, "TS0001");
});

test("登录：缺密码 / 上游 NG 都拒，成功只回姓名与掩码工号", async () => {
  const noPw = await call("POST", "/api/attendance/login", { account: "TS0001" });
  assert.equal(noPw.status, 400);
  assert.equal(noPw.json.code, "no_password");

  const ok = await call("POST", "/api/attendance/login", { account: "TS0001", password: "good" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, userName: "张三", workNoMask: "TS***1" });
  assert.equal(seenLogin.account, "TS0001");
  assert.equal(seenLogin.password, "good", "密码走 query 是 OA 的形状，改不了");

  loginMode = "ng";
  const ng = await call("POST", "/api/attendance/login", { account: "TS0001", password: "wrong" });
  assert.equal(ng.status, 401);
  assert.equal(ng.json.code, "login_failed");
  assert.match(ng.json.error, /账号或密码错误/);
  // 错误消息会进日志、回页面、进模型上下文：密码不许出现在里面。
  assert.doesNotMatch(ng.json.error, /wrong|good/);

  // 「失败即停」：紧接着再试一次（这次密码是对的）也要先等一下，否则会把 OA 账号试锁。
  loginMode = "ok";
  const blocked = await call("POST", "/api/attendance/login", { account: "TS0001", password: "good" });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.code, "too_many");

  const st = await call("GET", "/api/attendance/state");
  assert.equal(st.json.loggedIn, true);
  assert.equal(st.json.userName, "张三");
  assert.equal(st.json.workNoMask, "TS***1");
  // 登录态是密文落盘的：文件里不该出现明文字段。
  const credFile = path.join(process.env.PI_WEB_STATE, "attendance", "credentials.bin");
  assert.equal(fs.existsSync(credFile), true);
  const raw = fs.readFileSync(credFile);
  const magic = raw.subarray(0, 5).toString("latin1");
  assert.ok(magic === "PWDP1" || magic === "PWPL1", magic);
  if (magic === "PWDP1") assert.doesNotMatch(raw.toString("latin1"), /good/, "DPAPI 密文里不该有明文");
});

test("记录：只查自己，query_type 必须是 3", async () => {
  const rec = await call("GET", "/api/attendance/records?start=2026-11-10&end=2026-11-16");
  assert.equal(rec.status, 200);
  assert.equal(rec.json.source, "live");
  assert.equal(rec.json.stale, false);
  const q = seenQueries.at(-1);
  assert.equal(q.token, TOKEN, "带的是登录态里的 token");
  assert.deepEqual(q.body, { keyword: "1001", query_type: 3, start_dt: "2026-11-10", end_dt: "2026-11-16" });

  const rows = rec.json.rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, "2026-11-13");
  assert.equal(rows[0].weekday, "五");
  assert.equal(rows[1].clockOut, null);
  assert.equal(rows[2].weekend, true);
  assert.equal(rows[2].overtime, 5);

  const s = rec.json.summary;
  assert.equal(s.days, 3);
  assert.equal(s.attended, 3);
  assert.equal(s.missing, 1, "周二下班缺卡算一次，周六不缺");
  assert.equal(s.overtime, 5);
  assert.equal(s.lastDay, "2026-11-16");
});

test("记录：页面传的日期不会绕过 90 天上限", async () => {
  const rec = await call("GET", "/api/attendance/records?start=2020-01-01&end=2026-11-16");
  assert.equal(rec.status, 200);
  const q = seenQueries.at(-1);
  assert.equal(q.body.end_dt, "2026-11-16", "终点本来是合法的，不该被推到今天");
  assert.match(q.body.start_dt, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  const span = (new Date(q.body.end_dt) - new Date(q.body.start_dt)) / 86_400_000;
  assert.equal(span + 1, 90, "一次最多 90 天");
  assert.equal(rec.json.range.clamped, true);
});

test("记录：上游 NG 时用缓存顶上，并且明确说这是缓存", async () => {
  recordsMode = "ng";
  const rec = await call("GET", "/api/attendance/records?start=2026-11-10&end=2026-11-16");
  assert.equal(rec.status, 200);
  assert.equal(rec.json.source, "cache");
  assert.equal(rec.json.stale, true);
  assert.match(rec.json.problem, /查不到/);
  assert.equal(rec.json.rows.length, 3);
  recordsMode = "ok";
});

test("记录：上游 HTTP 挂了，缓存补不上就把错误回出去", async () => {
  recordsMode = "500";
  const rec = await call("GET", "/api/attendance/records?start=2026-01-01&end=2026-01-05");
  assert.equal(rec.status, 502);
  assert.equal(rec.json.code, "upstream");
  recordsMode = "ok";
});

test("记录：上游 HTTP 200 但 body 是 NG，也说清楚是哪段没取到", async () => {
  recordsMode = "ng";
  const rec = await call("GET", "/api/attendance/records?start=2026-01-01&end=2026-01-05");
  assert.equal(rec.status, 502);
  assert.equal(rec.json.code, "records_ng");
  assert.match(rec.json.error, /查不到/);
  recordsMode = "ok";
});

test("加班申请：申请单、审批链、候选人都到齐", async () => {
  const ot = await call("GET", "/api/attendance/overtime");
  assert.equal(ot.status, 200);
  assert.equal(ot.json.userId, 1001);
  assert.deepEqual(ot.json.reasons, ["进度延迟", "追加作业"]);
  assert.equal(ot.json.admitTime, "09:00~19:30");
  assert.equal(ot.json.applyList.length, 1);
  const a = ot.json.applyList[0];
  assert.equal(a.code, 900001);
  assert.deepEqual(a.reasonParsed, { type: "进度延迟", project: "P1", detail: "赶版本" });
  assert.equal(ot.json.workflow["900001"].length, 2);
  assert.deepEqual(ot.json.candidates.l1, [{ userId: 2001, name: "李四", workNo: "TS0002" }]);
  assert.equal(ot.json.candidates.l2.length, 2);
});

const draft = {
  startTime: "2026-11-18T18:00",
  endTime: "2026-11-18T20:00",
  hours: 2,
  reason: { type: "进度延迟", project: "P1", detail: "赶版本" },
  workflow: "2001&3001,3002",
};

test("加班提交：先要确认，不写任何东西", async () => {
  const before = seenAdds.length;
  const res = await call("POST", "/api/attendance/overtime", draft);
  assert.equal(res.status, 200);
  assert.equal(res.json.needConfirm, true);
  assert.equal(res.json.preview.startTime, "2026-11-18T18:00:00");
  assert.equal(res.json.preview.workflow, "2001&3001,3002");
  assert.equal(seenAdds.length, before, "没确认就一个字节都不该发出去");
});

test("加班提交：本地校验挡在手边", async () => {
  const order = await call("POST", "/api/attendance/overtime", { ...draft, endTime: "2026-11-18T17:00", confirm: true });
  assert.equal(order.status, 400);
  assert.equal(order.json.code, "time_order");

  const noReason = await call("POST", "/api/attendance/overtime", { ...draft, reason: { type: "" }, confirm: true });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.code, "reason_type_missing");

  const noApprover = await call("POST", "/api/attendance/overtime", { ...draft, workflow: "&", confirm: true });
  assert.equal(noApprover.status, 400);
  assert.equal(noApprover.json.code, "approver_missing");
  assert.equal(seenAdds.length, 0, "被本地校验挡住的都不该打到上游");
});

test("加班提交：确认后真发，body 是 OA 要的那七个字段", async () => {
  const res = await call("POST", "/api/attendance/overtime", { ...draft, confirm: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  const sent = seenAdds.at(-1);
  assert.equal(sent.token, TOKEN);
  assert.deepEqual(sent.body, {
    use_type: 0,
    user_id: 1001,
    agent_user_id: 0,
    reason: '{"type":"进度延迟","project":"P1","detail":"赶版本"}',
    start_time: "2026-11-18T18:00:00",
    end_time: "2026-11-18T20:00:00",
    workflow_list: "2001&3001,3002",
  });
});

test("加班提交：十分钟内同样的内容挡住第二次", async () => {
  const again = await call("POST", "/api/attendance/overtime", { ...draft, confirm: true });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "duplicate");
  assert.match(again.json.error, /十分钟内/);
});

test("加班提交：内容变一点就不算重复", async () => {
  const res = await call("POST", "/api/attendance/overtime", { ...draft, endTime: "2026-11-18T21:00", hours: 3, confirm: true });
  assert.equal(res.status, 200);
});

test("加班提交：上游 NG 回 502，不当成功", async () => {
  writeMode = "ng";
  const res = await call("POST", "/api/attendance/overtime", { ...draft, startTime: "2026-11-19T18:00", endTime: "2026-11-19T20:00", confirm: true });
  assert.equal(res.status, 502);
  assert.equal(res.json.code, "rejected");
  assert.match(res.json.error, /申请人不能是自己/);
  writeMode = "ok";
});

test("撤回：先要确认，确认后才打上游", async () => {
  seenCancel = null;
  const first = await call("POST", "/api/attendance/overtime/cancel?code=900001");
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { needConfirm: true, code: "900001" });
  assert.equal(seenCancel, null);

  const bad = await call("POST", "/api/attendance/overtime/cancel?code=abc&confirm=1");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "bad_code");

  const ok = await call("POST", "/api/attendance/overtime/cancel?code=900001&confirm=1");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  assert.equal(seenCancel.code, "900001");
  assert.equal(seenCancel.token, TOKEN);
});

test("退出：登录态没了，记录退成缓存", async () => {
  const out = await call("POST", "/api/attendance/logout");
  assert.equal(out.status, 200);
  const st = await call("GET", "/api/attendance/state");
  assert.equal(st.json.loggedIn, false);
  assert.equal(st.json.cacheDays, 3, "缓存还在，退出不等于清数据");

  const rec = await call("GET", "/api/attendance/records?start=2026-11-10&end=2026-11-16");
  assert.equal(rec.status, 200);
  assert.equal(rec.json.source, "cache");
  assert.equal(rec.json.stale, true);
});

test("隧道访客：整个模块都当不存在", async () => {
  for (const route of [
    "/api/attendance/state",
    "/api/attendance/config",
    "/api/attendance/records?start=2026-11-10&end=2026-11-16",
    "/api/attendance/overtime",
  ]) {
    const res = await call("GET", route, undefined, { "x-test-tunnel": "1" });
    assert.equal(res.status, 404, route);
    assert.equal(res.json.error, "not found", route);
  }
});

test("清除本地数据：配置、凭据、缓存全没，审计留着", async () => {
  const before = fs.readFileSync(path.join(process.env.PI_WEB_STATE, "attendance", "audit.jsonl"), "utf8");
  assert.match(before, /"kind":"login"/);
  assert.doesNotMatch(before, /good/, "审计里不许出现密码");

  const del = await call("DELETE", "/api/attendance/config");
  assert.equal(del.status, 200);
  assert.deepEqual(del.json, { ok: true });

  const st = await call("GET", "/api/attendance/state");
  assert.equal(st.json.configured, false);
  assert.equal(st.json.cacheDays, 0);
  assert.equal(st.json.loggedIn, false);

  const after = fs.readFileSync(path.join(process.env.PI_WEB_STATE, "attendance", "audit.jsonl"), "utf8");
  assert.match(after, /"kind":"purge"/);
  assert.doesNotMatch(after, /good/);
});

test("非本模块的路径不接", async () => {
  const res = await call("GET", "/api/jira/state");
  assert.equal(res.status, 404);
  assert.equal(res.json.error, "not found");
});
