/**
 * 考勤面板的桥端：假 OA + 临时状态目录，真跑 HTTP。
 *
 * 覆盖那几条「说话算数」：没配过不给数据、密码只进不出（页面只见掩码）、
 * 记录只查自己（keyword 用工号，且行要再按 user_id / work_no 过一道）、上游 NG 不许当成功、
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
// exp = 2020-01-01：一登录就已经过期，模拟「上次登录的 token 早过期了，密码还在」。
const EXPIRED_TOKEN = `x.${Buffer.from(JSON.stringify({ sub: "TS0001", exp: 1577836800 })).toString("base64url")}.y`;
/** 登录接口发出去的 token：换成 EXPIRED_TOKEN 就是「过期但存着密码」那一档。 */
let loginToken = TOKEN;
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
/** 请假：上游收到的提交（含路径，四种假分三个端点）与撤回体、以及 use_type 0 的信息探测。 */
const seenLeaveAdds = [];
let seenLeaveCancel = null;
let leaveProbes = 0;
/** 上游收到的 Authorization / token 头。 */
const seenTokens = [];
/** 上游登录收到的 query。 */
let seenLogin = null;
/** 上游被登录了几次（断言「偷偷重登」）。 */
let loginCount = 0;
/** 模拟 token 被踢：第一次取数给 401。 */
let kicked = false;

const ROWS = [
  { user_id: 1001, name: "张三", work_no: "TS0001", day: "2026-11-13(五)", day_type: 0, start: "09:05", end: "18:31", ov: 0, code: "0", c_hours: 0, t_hours: 0 },
  { user_id: 1001, name: "张三", work_no: "TS0001", day: "2026-11-16(一)", day_type: 0, start: "09:12", end: null, ov: 0, code: "0", c_hours: 0, t_hours: 0 },
  { user_id: 1001, name: "张三", work_no: "TS0001", day: "2026-11-14(六)", day_type: 1, start: "10:00", end: "15:00", ov: 5, code: "0", c_hours: 0, t_hours: 0 },
  // 整天调休，完全没打卡：OA 里就是 code=申请单号 + c_hours=8 + start/end 为空。
  { user_id: 1001, name: "张三", work_no: "TS0001", day: "2026-11-10(一)", day_type: 0, start: null, end: null, ov: 0, code: "109603", c_hours: 8, t_hours: 0 },
  // 假日（day_type 2）：没打卡也不该记缺卡。
  { user_id: 1001, name: "张三", work_no: "TS0001", day: "2026-11-11(三)", day_type: 2, start: null, end: null, ov: 0, code: "0", c_hours: 0, t_hours: 0 },
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
      loginCount += 1;
      seenLogin = { account: url.searchParams.get("user_account"), password: url.searchParams.get("user_password") };
      if (loginMode === "500") return send(500, { detail: "boom" });
      if (loginMode === "ng") return send(200, { status: "NG", error: "账号或密码错误" });
      return send(200, { status: "OK", token: loginToken, user_id: 1001, name: "张三", work_no: "TS0001" });
    }

    if (url.pathname === "/in/record/query") {
      seenQueries.push({ token, body });
      if (kicked) {
        kicked = false;
        return send(401, { detail: { code: 5000, message: "无效token", data: "Token Error" } });
      }
      if (recordsMode === "other") {
        return send(200, {
          status: "OK",
          data_list: [{ user_id: 9999, name: "旁人", work_no: "TS00019", day: "2026-11-12(四)", day_type: 0, start: "09:00", end: "18:00", ov: 0 }],
          max_day: "2026-11-12",
        });
      }
      if (recordsMode === "html") {
        // 把网页地址填成接口地址时的真实样子：200 + 一堆 HTML。
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!DOCTYPE html><html><body>登录</body></html>");
      }
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
            { workflow_index: 2, workflow_role_name: "部门负责人", workflow_result: 0, handle_user_id: null, handle_user_name: null, update_time: "", workflow_user_name: "王五-TS0003,赵六-TS0004" },
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

    if (url.pathname === "/in/roles/depart_leader_data") {
      // 二级审批人的固定名单：OA 只给「姓名-工号」，user_id 得自己对到候选表里。
      return send(200, {
        status: "OK",
        // 兜底名单故意给一个对不上候选表的人：能过说明固定名单走的是「上一次申请」，不是这里。
        last: { depart_manager: ["孙七-TS0007"], event_manager: ["李四-TS0002"] },
        data: [{ depart_manager: "王五-TS0003", event_manager: ["李四-TS0002"] }],
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

    if (url.pathname === "/in/apply/leave/get") {
      return send(200, {
        status: "OK",
        apply_list: [
          {
            code: 118304, user_id: 1001, name: "张三-TS0001", agent_user_id: 0, agent_name: 0,
            start_time: "2026-11-23T09:00:00", end_time: "2026-11-24T18:00:00",
            normal_hours: 0, compensatory_hours: 16, sick_hours: 0, other_apply_type: "0", other_days: 0,
            reason: "回老家", workflow_result: 0, reject_reason: null,
          },
        ],
        workflow_list: {
          118304: [
            { workflow_index: 0, workflow_role_name: "申请人", workflow_result: 1, handle_user_name: "张三-TS0001" },
            { workflow_index: 1, workflow_role_name: "项目负责人", workflow_result: 0, workflow_user_name: "李四-TS0002" },
          ],
        },
        special_workflow_1: "",
      });
    }

    if (url.pathname.startsWith("/in/apply/leave/add/")) {
      // use_type 0 是 OA 页面进页时的信息探测：只回审批人与日历，不落单。
      if (body?.use_type === 0) {
        leaveProbes++;
        return send(200, {
          team_leader: [
            { user_id: 2001, name: "李四-TS0002", role_id: "D002", depart_id: 1 },
            { user_id: 2002, name: "赵六-TS0006", role_id: "D002", depart_id: 1 },
          ],
          recently_team_leader: [{ user_id: 2001, name: "李四-TS0002", depart_id: 1 }],
          user_depart_leader_inf: [
            { user_depart_leader_user_id: 3001, user_depart_leader_work_no: "TS0003", user_depart_leader_name: "王五-TS0003", user_depart_leader_depart_id: 1 },
          ],
          compensatory_time: [{ compensatory_time: 57 }],
          day_type: [
            { date: "2026-11-23T00:00:00", type: 0 },
            { date: "2026-11-24T00:00:00", type: 0 },
            { date: "2026-11-28T00:00:00", type: 1 },
          ],
        });
      }
      seenLeaveAdds.push({ path: url.pathname, token, body });
      if (writeMode === "ng") return send(200, { status: "NG", message: "调休时间不足" });
      return send(200, { status: "OK", message: "申请成功" });
    }

    if (url.pathname === "/in/apply/leave/cancel") {
      seenLeaveCancel = { token, body };
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
  // 闸门是按时间戳算的（1 次失败退避 1 秒）：不把这一秒等过去，后面「被踢了偷偷重登」
  // 那条用例就会撞在同一道闸门上拿到 429 —— 那是闸门在正常工作，不是重登坏了。
  await new Promise((r) => setTimeout(r, 1_100));

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
  // keyword 用工号：user_id 当关键字会被工号里含这几个数字的同事命中（实测 640 → JS1640）。
  assert.deepEqual(q.body, { keyword: "TS0001", query_type: 3, start_dt: "2026-11-10", end_dt: "2026-11-16" });

  const rows = rec.json.rows;
  assert.equal(rows.length, 5);
  assert.equal(rows[0].date, "2026-11-13");
  assert.equal(rows[0].weekday, "五");
  assert.equal(rows[0].missing, false, "两头都打了卡");
  assert.equal(rows[1].clockOut, null);
  assert.equal(rows[1].missing, true, "下班卡缺了");
  assert.equal(rows[2].dayOff, true);
  assert.equal(rows[2].overtime, 5);
  assert.equal(rows[3].missing, false, "整天调休没打卡不算缺卡");
  assert.equal(rows[3].fullDayExcused, true);
  assert.equal(rows[4].dayOff, true, "假日");
  assert.equal(rows[4].missing, false);

  const s = rec.json.summary;
  assert.equal(s.days, 5);
  assert.equal(s.attended, 3);
  assert.equal(s.missing, 1, "只有周一（11/16）下班缺卡算一次；调休、假日、周六都不算");
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
  // 旧版缓存里存的是改口径之前的行（没有 dayOff / absenceHours）。raw 是整行存着的，
  // 读的时候要重新映一遍，不然升级后离线看历史还是老的误判。
  const cachePath = path.join(process.env.PI_WEB_STATE, "attendance", "cache.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      account: "TS0001",
      fetchedAt: Date.now(),
      maxDay: "2026-11-11",
      days: {
        "2026-11-11": {
          date: "2026-11-11",
          weekday: "三",
          weekend: true,
          clockIn: null,
          clockOut: null,
          overtime: 0,
          overtimeEdited: false,
          editedBy: "",
          raw: { day: "2026-11-11(三)", day_type: 2, start: null, end: null, ov: 0 },
        },
      },
    }),
  );
  recordsMode = "ng";
  const rec = await call("GET", "/api/attendance/records?start=2026-11-10&end=2026-11-16");
  assert.equal(rec.status, 200);
  assert.equal(rec.json.source, "cache");
  assert.equal(rec.json.stale, true);
  assert.match(rec.json.problem, /查不到/);
  assert.equal(rec.json.rows.length, 1);
  assert.equal(rec.json.rows[0].dayOff, true, "day_type 2 是假日，旧缓存也要认");
  assert.equal(rec.json.rows[0].missing, false);
  assert.equal(rec.json.summary.missing, 0);
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

test("记录：接口地址指到网页上（回 HTML）时，说出是地址填错了", async () => {
  recordsMode = "html";
  const rec = await call("GET", "/api/attendance/records?start=2026-01-01&end=2026-01-05");
  assert.equal(rec.status, 502);
  assert.equal(rec.json.code, "bad_json");
  // 说的是「地址填错了」，不是一句没用的「不是 JSON」。
  assert.match(rec.json.error, /指到了网页/);
  recordsMode = "ok";
});

test("上游把 token 踢了（人在别处又登一次）：偷偷重登一次，用户看不到「过期了」", async () => {
  const before = loginCount;
  kicked = true;
  const rec = await call("GET", "/api/attendance/records?start=2026-11-10&end=2026-11-16");
  assert.equal(rec.status, 200);
  assert.equal(rec.json.source, "live");
  assert.equal(rec.json.stale, false);
  assert.equal(loginCount, before + 1);
  assert.equal(rec.json.rows.length, 5);
});

test("记录：上游模糊匹配回别人的行，一条都不当自己的显示", async () => {
  recordsMode = "other";
  const rec = await call("GET", "/api/attendance/records?start=2026-01-01&end=2026-01-05");
  assert.equal(rec.status, 502);
  assert.equal(rec.json.code, "wrong_user");
  assert.match(rec.json.error, /不是本人/);
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
  assert.equal(ot.json.workflow["900001"].length, 3);
  assert.deepEqual(ot.json.candidates.l1, [{ userId: 2001, name: "李四", workNo: "TS0002" }]);
  assert.equal(ot.json.candidates.l2.length, 2);
  // 二级审批人取「上一次申请的第二级」（与 OA 表单那两条只读框一致），兜底才是 depart_leader_data。
  assert.deepEqual(ot.json.fixedL2, [
    { userId: 3001, name: "王五", workNo: "TS0003" },
    { userId: 3002, name: "赵六", workNo: "TS0004" },
  ]);
  // 一级审批人的默认值 = 上一次申请的 idx1 审批人（李四-TS0002 → 2001）。
  assert.deepEqual(ot.json.defaultL1, [{ userId: 2001, name: "李四", workNo: "TS0002" }]);
});

const draft = {
  startTime: "2026-11-18T18:00",
  endTime: "2026-11-18T20:00",
  hours: 2,
  reason: { type: "进度延迟", project: "P1", detail: "赶版本" },
  // 页面真实发的是对象，不是 "2001&3001,3002" 这种字符串。
  workflow: { l1: [2001], l2: [3001, 3002] },
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

test("加班提交：审批人两种形状都认，别再把 [object Object] 解成空", async () => {
  const asString = await call("POST", "/api/attendance/overtime", { ...draft, workflow: "2001&3001,3002" });
  assert.equal(asString.status, 200);
  assert.equal(asString.json.preview.workflow, "2001&3001,3002", "字符串形状要照旧能用");

  const asObject = await call("POST", "/api/attendance/overtime", draft);
  assert.equal(asObject.status, 200);
  assert.equal(asObject.json.preview.workflow, "2001&3001,3002", "页面的 {l1,l2} 要归成同一串");

  const onlyL1 = await call("POST", "/api/attendance/overtime", { ...draft, workflow: { l1: [2001], l2: [] } });
  assert.equal(onlyL1.status, 200, "只选一级也行");
  assert.equal(onlyL1.json.preview.workflow, "2001&");
});

test("加班提交：本地校验挡在手边", async () => {
  const order = await call("POST", "/api/attendance/overtime", { ...draft, endTime: "2026-11-18T17:00", confirm: true });
  assert.equal(order.status, 400);
  assert.equal(order.json.code, "time_order");

  const noReason = await call("POST", "/api/attendance/overtime", { ...draft, reason: { type: "" }, confirm: true });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.code, "reason_type_missing");

  const noProject = await call("POST", "/api/attendance/overtime", { ...draft, reason: { ...draft.reason, project: "" }, confirm: true });
  assert.equal(noProject.status, 400);
  assert.equal(noProject.json.code, "project_missing");

  const noDetail = await call("POST", "/api/attendance/overtime", { ...draft, reason: { ...draft.reason, detail: " " }, confirm: true });
  assert.equal(noDetail.status, 400);
  assert.equal(noDetail.json.code, "detail_missing");

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
    // 这两条是从 OA 自己页面发出来的请求体里抄的：use_type 是 1，datetime 用空格不用 T。
    // 以前发 0 + "T"，接口照样回 OK，但申请一览里一行都不多 —— 测试必须钉住。
    use_type: 1,
    user_id: 1001,
    agent_user_id: 0,
    reason: '{"type":"进度延迟","project":"P1","detail":"赶版本"}',
    start_time: "2026-11-18 18:00:00",
    end_time: "2026-11-18 20:00:00",
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

test("请假申请：一览、类型、审批人、调休余额都到齐，进页只做 use_type 0 的探测", async () => {
  const adds = seenLeaveAdds.length;
  const res = await call("GET", "/api/attendance/leave");
  assert.equal(res.status, 200);
  assert.equal(res.json.applyList.length, 1);
  assert.equal(res.json.applyList[0].leaveType, "调休");
  assert.deepEqual(res.json.candidates.map((p) => p.userId), [2001, 2002]);
  assert.deepEqual(res.json.defaultL1, [{ userId: 2001, name: "李四", workNo: "TS0002" }]);
  assert.deepEqual(res.json.fixedL2, [{ userId: 3001, name: "王五", workNo: "TS0003" }]);
  assert.equal(res.json.compensatory, 57);
  assert.deepEqual(res.json.workdays, ["2026-11-23", "2026-11-24"]);
  assert.ok(leaveProbes > 0);
  assert.equal(seenLeaveAdds.length, adds, "进页不该落任何单");
});

const leaveDraft = {
  type: "调休",
  startDay: "2026-11-23",
  endDay: "2026-11-24",
  startHour: 9,
  endHour: 18,
  reason: "回老家",
  workflow: { l1: [2001], l2: [3001] },
  workdays: ["2026-11-23", "2026-11-24"],
};

test("请假提交：先要确认，预览带预估时长，不写任何东西", async () => {
  const before = seenLeaveAdds.length;
  const res = await call("POST", "/api/attendance/leave", leaveDraft);
  assert.equal(res.status, 200);
  assert.equal(res.json.needConfirm, true);
  assert.equal(res.json.preview.startTime, "2026-11-23 09:00:00");
  assert.equal(res.json.preview.workflow, "2001&3001");
  assert.deepEqual(res.json.preview.estimate, { value: 16, unit: "h" });
  assert.equal(seenLeaveAdds.length, before);
});

test("请假提交：本地校验（事由必填、钟点只认 OA 那几个）", async () => {
  const before = seenLeaveAdds.length;
  const noReason = await call("POST", "/api/attendance/leave", { ...leaveDraft, reason: "", confirm: true });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.code, "reason_missing");
  const badHour = await call("POST", "/api/attendance/leave", { ...leaveDraft, startHour: 10, confirm: true });
  assert.equal(badHour.json.code, "hour_invalid");
  const badType = await call("POST", "/api/attendance/leave", { ...leaveDraft, type: "年假", confirm: true });
  assert.equal(badType.json.code, "type_missing");
  assert.equal(seenLeaveAdds.length, before);
});

test("请假提交：按类型走对端点，body 跟 OA 页面发的一样", async () => {
  const res = await call("POST", "/api/attendance/leave", { ...leaveDraft, confirm: true });
  assert.equal(res.status, 200);
  const sent = seenLeaveAdds.at(-1);
  assert.equal(sent.path, "/in/apply/leave/add/normal");
  assert.equal(sent.token, TOKEN);
  assert.deepEqual(sent.body, {
    use_type: 1,
    user_id: 1001,
    agent_user_id: 0,
    leave_type: "调休",
    reason: "回老家",
    start_time: "2026-11-23 09:00:00",
    end_time: "2026-11-24 18:00:00",
    workflow_list: "2001&3001",
  });

  const again = await call("POST", "/api/attendance/leave", { ...leaveDraft, confirm: true });
  assert.equal(again.status, 409, "十分钟内同样的请假挡住第二次");

  await call("POST", "/api/attendance/leave", { ...leaveDraft, type: "病假", confirm: true });
  assert.equal(seenLeaveAdds.at(-1).path, "/in/apply/leave/add/sick");
  await call("POST", "/api/attendance/leave", { ...leaveDraft, type: "其他", reason: "婚假", confirm: true });
  const other = seenLeaveAdds.at(-1);
  assert.equal(other.path, "/in/apply/leave/add/other");
  assert.equal(other.body.start_time, "2026-11-23 00:00:00", "其他假只按天");
});

test("请假提交：上游 NG 回 502", async () => {
  writeMode = "ng";
  const res = await call("POST", "/api/attendance/leave", { ...leaveDraft, type: "事假", confirm: true });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /调休时间不足/);
  writeMode = "ok";
});

test("请假撤回：先要确认，确认后带上类型发给上游", async () => {
  seenLeaveCancel = null;
  const first = await call("POST", "/api/attendance/leave/cancel?code=118304&type=" + encodeURIComponent("调休"));
  assert.deepEqual(first.json, { needConfirm: true, code: "118304" });
  assert.equal(seenLeaveCancel, null);
  const ok = await call("POST", "/api/attendance/leave/cancel?code=118304&confirm=1&type=" + encodeURIComponent("调休"));
  assert.deepEqual(ok.json, { ok: true });
  assert.deepEqual(seenLeaveCancel.body, { code: 118304, leave_type: "调休" });
});

test("token 过期但密码还在：仍算登录态，设置页能拿回那个密码", async () => {
  // 用户上次登录的 token 过期了（OA 一天一换）：界面别说「未登录」——
  // 一查记录 session() 就会拿存着的密码自己重登，用户根本不用回来点登录。
  loginToken = EXPIRED_TOKEN;
  const login = await call("POST", "/api/attendance/login", { account: "TS0001", password: "good" });
  assert.equal(login.status, 200);
  loginToken = TOKEN;

  const st = await call("GET", "/api/attendance/state");
  assert.equal(st.json.loggedIn, true, "token 过期但密码还在，就该算登录态");
  assert.equal("hasPassword" in st.json, false, "摘要里不摆没用的开关：页面只看 loggedIn");

  const pw = await call("GET", "/api/attendance/password");
  assert.equal(pw.status, 200);
  assert.equal(pw.json.password, "good", "设置页把已存的密码回填进密码框（框本身仍是 password）");

  // 拿这份「token 过期」的凭据去取数：重登一次，用户看不到「过期了」。
  const before = loginCount;
  const rec = await call("GET", "/api/attendance/records?start=2026-11-10&end=2026-11-16");
  assert.equal(rec.status, 200);
  assert.equal(rec.json.source, "live");
  assert.equal(loginCount, before + 1, "过期后的第一次取数会自己重登一次");
});

test("自动续登被上游拒了：界面回落成未登录，密码改对之后又回来", async () => {
  // 场景：token 过期、存着的密码被 OA 那边改了。此时界面若还写「已登录」，
  // 每条请求都 401，比原来的「过期了」更难查。
  loginToken = EXPIRED_TOKEN;
  loginMode = "ok";
  const login = await call("POST", "/api/attendance/login", { account: "TS0001", password: "good" });
  assert.equal(login.status, 200);
  loginToken = TOKEN;

  loginMode = "ng";
  const rec = await call("GET", "/api/attendance/records?start=2026-11-10&end=2026-11-16");
  assert.equal(rec.status, 200, "取数失败退缓存，不把整页打成 500");
  assert.equal(rec.json.source, "cache");
  const st = await call("GET", "/api/attendance/state");
  assert.equal(st.json.loggedIn, false, "密码被上游拒了，就不能再说「已登录」");

  // 重登被拒也算一次失败，进了 1 秒退避：不等一下会撞 429，那档不算「密码坏了」。
  await new Promise((r) => setTimeout(r, 1_100));
  loginMode = "ok";
  const again = await call("GET", "/api/attendance/records?start=2026-11-10&end=2026-11-16");
  assert.equal(again.status, 200);
  assert.equal(again.json.source, "live", "密码又能用了：自己续上，不用人回来点登录");
  const after = await call("GET", "/api/attendance/state");
  assert.equal(after.json.loggedIn, true, "续上了就该回到已登录");
});

test("退出：登录态没了，记录退成缓存", async () => {
  const out = await call("POST", "/api/attendance/logout");
  assert.equal(out.status, 200);
  const st = await call("GET", "/api/attendance/state");
  assert.equal(st.json.loggedIn, false);
  assert.equal(st.json.cacheDays, 5, "缓存还在，退出不等于清数据");

  const rec = await call("GET", "/api/attendance/records?start=2026-11-10&end=2026-11-16");
  assert.equal(rec.status, 200);
  assert.equal(rec.json.source, "cache");
  assert.equal(rec.json.stale, true);
});

test("隧道访客：整个模块都当不存在", async () => {
  for (const route of [
    "/api/attendance/state",
    "/api/attendance/config",
    "/api/attendance/password",
    "/api/attendance/records?start=2026-11-10&end=2026-11-16",
    "/api/attendance/overtime",
    "/api/attendance/reminder",
  ]) {
    const res = await call("GET", route, undefined, { "x-test-tunnel": "1" });
    assert.equal(res.status, 404, route);
    assert.equal(res.json.error, "not found", route);
  }
});

test("提醒：默认关着，通道状态照实说", async () => {
  const out = await call("GET", "/api/attendance/reminder");
  assert.equal(out.status, 200);
  assert.equal(out.json.rule.enabled, false);
  assert.equal(out.json.rule.time, "18:00");
  assert.equal(out.json.lastFiredDate, "");
  assert.equal(out.json.pushEnabled, false, "测试里的 ctx 没塞 notifier，那就是没有通道");
  assert.equal(out.json.pushSubscriptions, 0);
});

test("提醒：开着却不选星期，存不进去", async () => {
  const out = await call("PUT", "/api/attendance/reminder", { enabled: true, days: [], time: "18:00", text: "交加班" });
  assert.equal(out.status, 400);
  assert.equal(out.json.code, "bad_reminder");
  assert.match(out.json.error, /星期/);
});

test("提醒：存下来能读回来，时间会被规范化", async () => {
  const out = await call("PUT", "/api/attendance/reminder", { enabled: true, days: [5, 5, 1], time: "9:05", text: "  交加班  " });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.rule, { enabled: true, days: [1, 5], time: "09:05", text: "交加班" });
  const back = await call("GET", "/api/attendance/reminder");
  assert.deepEqual(back.json.rule, out.json.rule);
});

test("提醒：关着的时候不挑毛病，先存半张脸也行", async () => {
  const out = await call("PUT", "/api/attendance/reminder", { enabled: false, days: [] });
  assert.equal(out.status, 200);
  assert.equal(out.json.rule.enabled, false);
});

test("提醒：没有通知通道时，试发要明说", async () => {
  const out = await call("POST", "/api/attendance/reminder/test");
  assert.equal(out.status, 500);
  assert.equal(out.json.code, "no_notifier");
});

test("提醒：定时器到点只发一次，重启也不补第二遍", async () => {
  const { startReminderLoop } = await import("../src/attendance-reminder.ts");
  const today = new Date();
  const weekday = today.getDay() === 0 ? 7 : today.getDay();
  const put = await call("PUT", "/api/attendance/reminder", { enabled: true, days: [weekday], time: "00:00", text: "该交加班了" });
  assert.equal(put.status, 200);

  const pushes = [];
  const notifier = {
    enabled: true,
    subscriptionCount: () => 1,
    push: async (title, body, url, force, extra) => {
      pushes.push({ title, body, url, force, extra });
      return { sent: 1, failed: 0 };
    },
  };

  const fired = [];
  const stop = startReminderLoop({
    notifier,
    url: () => "http://127.0.0.1:7864/",
    intervalMs: 60_000,
    onFire: (title, body) => fired.push({ title, body }),
  });
  await new Promise((r) => setTimeout(r, 120));
  stop();
  assert.equal(pushes.length, 1, "到点了就该发一条");
  assert.equal(pushes[0].force, true, "要 force，否则页面开着就看不到");
  assert.match(pushes[0].body, /该交加班了/);
  // D349：页面开着也要提醒 —— 同时告诉页面，推送带固定 tag + 不自动消失。
  assert.equal(fired.length, 1, "到点要同时告诉开着的页面");
  assert.match(fired[0].body, /该交加班了/);
  assert.equal(pushes[0].extra?.tag, "pi-attendance-reminder");
  assert.equal(pushes[0].extra?.sticky, true);

  const again = startReminderLoop({ notifier, url: () => "http://127.0.0.1:7864/", intervalMs: 60_000 });
  await new Promise((r) => setTimeout(r, 120));
  again();
  assert.equal(pushes.length, 1, "今天已经发过，重启不许再来一遍");

  const rec = await call("GET", "/api/attendance/reminder");
  assert.equal(rec.json.lastFiredDate, new Date().toLocaleDateString("sv-SE"));
  assert.equal(rec.json.lastSent, 1);

  // 把时间挪一挪，当天的「已发过」就该让开。
  const moved = await call("PUT", "/api/attendance/reminder", { enabled: true, days: [weekday], time: "23:59", text: "该交加班了" });
  assert.equal(moved.json.lastFiredDate, "");
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
