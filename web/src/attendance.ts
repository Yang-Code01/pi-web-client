/**
 * 本机管理 → 考勤（第六页）。
 *
 * 这一页自己管自己的数据：进页调 `/api/attendance/state`，三块内容各拉各的接口，
 * 不塞进 `sysmanage.ts` 的 `state[section]` —— 那套是按「一次 GET 一份快照」设计的，
 * 考勤要的是「配置 / 记录 / 申请」三份不同形状、还能分别写回。
 *
 * 界面上的硬约束：
 *   - 账号在页面上永远是掩码；已存的本机密码由桥解密后回填进密码框（input 仍是
 *     `type=password`，眼睛按钮只切 type），不落 localStorage，也不进 state 摘要。
 *   - 提交加班 / 请假要二次确认：先 POST 不带 confirm 拿一份预览，人再点一次才真发；
 *     真发的是预览那一刻的表单（之后再改表单不会混进去）。
 *   - 隧道访客看不到这一页（桥端整页 404），页面这边只负责别把自己画坏。
 */
import { api } from "./api.ts";
import { createEl as el } from "./chat.ts";
import { errText, tr } from "./i18n/index.ts";
import type { AttendanceState, AttendanceRecords, AttendanceOvertime, AttendanceLeave, AttendanceReminder } from "./sysmanage-types.ts";
// 日期 → 「周五」这件事本机管理已经做过一遍（sysmanage-model.ts:207），别再写一张中文星期表。
import { weekdayOf } from "./sysmanage-model.ts";
import { dateKey, defaultRange, defaultWindow, hoursText, leaveKinds, leaveTotal, overtimeSplit, reasonText, round1, spanText, stepState } from "./attendance-shared.ts";
import type { LeaveKind } from "./attendance-shared.ts";
import "./attendance.css";

type Tab = "records" | "overtime" | "leave" | "reminder" | "settings";

// i18n-ignore-start OA 的请假类型值：原样发给 OA、也拿来比对，不是界面文案（显示走 leaveTypeLabel）
const LEAVE_TYPES = ["调休", "事假", "病假", "其他"] as const;
// i18n-ignore-end

function leaveTypeLabel(t: string): string {
  const i = (LEAVE_TYPES as readonly string[]).indexOf(t);
  return i < 0 ? t : [tr("调休"), tr("事假"), tr("病假"), tr("其他")][i]!;
}

/** 「其他」假只按天、不选钟点。 */
const isByDay = (t: string): boolean => t === LEAVE_TYPES[3];

interface LeaveForm {
  type: string;
  startDay: string;
  startHour: number;
  endDay: string;
  endHour: number;
  reason: string;
  l1: string[];
}

/** 眼睛图标：`visible` = 密码此刻是明文，图标给「划线眼」（点一下又藏回去）。 */
function eyeIcon(visible: boolean): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const attrs: Record<string, string> = {
    viewBox: "0 0 24 24",
    width: "16",
    height: "16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  const path = (d: string): void => {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  };
  if (visible) {
    path("M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a17.6 17.6 0 0 1-2.16 3.19");
    path("M6.61 6.61A17.6 17.6 0 0 0 2 12s3.5 8 10 8a9.12 9.12 0 0 0 4.24-1.06");
    path("M14.12 14.12a3 3 0 1 1-4.24-4.24");
    path("M2 2l20 20");
  } else {
    path("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z");
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", "12");
    dot.setAttribute("cy", "12");
    dot.setAttribute("r", "3");
    svg.append(dot);
  }
  return svg;
}

interface OvertimeForm {
  start: string;
  end: string;
  hours: string;
  reasonType: string;
  project: string;
  detail: string;
  l1: string[];
  l2: string[];
}

const L1_KEY = "pi-web-attendance:l1";
const LEAVE_L1_KEY = "pi-web-attendance:leave-l1";

export interface AttendancePane {
  /** 切走 / 关面板时调它：停掉正在跑的请求，把 DOM 摘掉。 */
  dispose: () => void;
  /** 「刷新」按钮用：重读状态，并按当前页签重拉数据。 */
  refresh: () => void;
}

/**
 * 画一页考勤进 `host`。重复调用会先把上一次的内容清空。
 * 页签、表单、展开的那一行都存在这一份闭包里 —— 所以调用方别在手痒时重画它。
 */
export function paintAttendance(host: HTMLElement): AttendancePane {
  let disposed = false;
  let tab: Tab = "records";
  let state: AttendanceState | null = null;
  let stateError = "";
  let records: AttendanceRecords | null = null;
  let recordsError = "";
  let recordsBusy = false;
  let range = defaultRange();
  let overtime: AttendanceOvertime | null = null;
  let overtimeError = "";
  let overtimeBusy = false;
  let leave: AttendanceLeave | null = null;
  let leaveError = "";
  let leaveBusy = false;
  let leavePending: { preview: Record<string, unknown>; body: Record<string, unknown> } | null = null;
  /** 请假撤回同样点两次。 */
  let leaveCancelPending: number | null = null;
  const leaveForm: LeaveForm = { type: LEAVE_TYPES[0], startDay: "", startHour: 9, endDay: "", endHour: 18, reason: "", l1: [] };
  let notice = "";
  let noticeTone: "ok" | "bad" = "ok";
  // 密码框靠这个活过重绘：点「保存配置」会把整页重画，输入框里刚敲的密码
  // 随之消失，紧接着点「登录」就变成「请填密码」。只留在内存里，不落盘。
  // 初始值来自桥解密的已存密码（loadSavedPassword）。`passwordTouched` 记住人动过没有 ——
  // 人把密码删空之后就别再回填，否则「删掉密码」这个动作会被下一帧撤销。
  let passwordDraft = "";
  let passwordTouched = false;
  /** 已经拿过桥的密码（或者不需要再拿）。拿不到时不置位，下次重画再问一次。 */
  let savedPasswordLoaded = false;
  let savedPasswordLoading = false;
  /** 眼睛按下去是明文。存闭包里，整页重画多少次都跟着人走。 */
  let passwordVisible = false;
  // 设置页另外三个框同样的道理：登录失败、保存成功都会整页重画，重画时若一律拿 state
  // 重新填，刚敲的地址和账号就被抹掉了（账号更冤 —— 页面从来只拿得到掩码）。
  // `cfgTouched` 分字段记：没动过的框继续跟着 state 走，动过的以草稿为准。
  const cfgDraft = { apiBase: "", pageBase: "", account: "" };
  const cfgTouched = { apiBase: false, pageBase: false, account: false };
  let pending: { preview: Record<string, unknown>; body: Record<string, unknown> } | null = null;
  let opened: string | null = null;
  /** 撤回要点两次：第一次记在这儿，第二次才真发。 */
  let cancelPending: number | null = null;

  let reminder: AttendanceReminder | null = null;
  let reminderError = "";
  let reminderBusy = false;
  let reminderNotice = "";
  let reminderLoaded = false;
  /** 页内提示条：桥那边刚发过提醒就在这里显示一条（系统通知被页面挡住时也看得见）。 */
  let bannerText = "";
  /** 已经提示过的那一次（按发送时刻去重），关掉就不再来。 */
  let bannerSeen = "";
  /** 提醒表单草稿：整页重画时不能把正在改的东西清掉。 */
  const reminderForm = { enabled: false, days: [] as number[], time: "18:00", text: "" };

  // 人手动改过时长就不再自动覆盖；没改过就跟着起止时间走。
  let hoursTouched = false;

  const form: OvertimeForm = {
    start: "",
    end: "",
    hours: "",
    reasonType: "",
    project: "",
    detail: "",
    l1: [],
    l2: [],
  };

  const root = el("div", "at-page");
  host.replaceChildren(root);

  const say = (text: string, tone: "ok" | "bad" = "ok") => {
    notice = text;
    noticeTone = tone;
    render();
  };

  const fail = (err: unknown) => {
    const e = err as Error & { code?: string };
    // 隧道访客能走到这里说明桥端兜底没拦住，给一句人话，不要甩 404。
    if (e?.code === "not_found" || /HTTP 404/.test(e?.message ?? "")) return tr("这一页不在公网开放，回本机看");
    return errText(err);
  };

  async function loadState(): Promise<void> {
    try {
      state = await api.attendanceState();
      stateError = "";
    } catch (err) {
      state = null;
      stateError = fail(err);
    }
    if (!disposed) render();
    if (state?.configured && !form.reasonType) void loadOvertime(true);
  }

  /**
   * 把本机存着的密码回填进密码框（`type=password`，屏幕上还是`••••`）。
   * 解密在桥端（DPAPI），这里只在进设置页时拉一次；读不到就当没有，用户自己填。
   */
  async function loadSavedPassword(): Promise<void> {
    if (savedPasswordLoaded || savedPasswordLoading) return;
    savedPasswordLoading = true;
    try {
      const { password } = await api.attendancePassword();
      // 真拿到了才记账：桥还在跑旧版本（没有这条路由）、或这次网络抽风时，
      // 不能因为失败一次就再也不回填 —— 那会让密码框在这一整页里永远是空的。
      savedPasswordLoaded = true;
      if (disposed || passwordTouched || !password) return;
      passwordDraft = password;
      render();
    } catch {
      // 读不出就不管：框空着，下次进设置页再试。
    } finally {
      savedPasswordLoading = false;
    }
  }

  async function loadRecords(): Promise<void> {
    if (recordsBusy) return;
    recordsBusy = true;
    recordsError = "";
    render();
    try {
      records = await api.attendanceRecords(range.start, range.end);
    } catch (err) {
      recordsError = fail(err);
    } finally {
      recordsBusy = false;
      if (!disposed) render();
    }
  }

  async function loadOvertime(silent = false): Promise<void> {
    if (overtimeBusy) return;
    overtimeBusy = true;
    if (!silent) overtimeError = "";
    render();
    try {
      overtime = await api.attendanceOvertime();
      overtimeError = "";
      if (!form.reasonType && overtime.reasons.length) form.reasonType = overtime.reasons[0]!;
      // 二级是 OA 按组织架构定死的，页面只负责显示：每次都以接口为准。
      form.l2 = overtime.fixedL2.map((p) => String(p.userId));
      if (form.l1.length === 0) {
        const recalled = recallApprovers(overtime.candidates.l1, L1_KEY);
        form.l1 = recalled.length > 0 ? recalled : overtime.defaultL1.map((p) => String(p.userId));
      }
      // 起止时间还没人动过：按今天是不是周末给一段默认值。
      if (!form.start) fillWindow(dateKey(new Date()));
    } catch (err) {
      overtimeError = fail(err);
    } finally {
      overtimeBusy = false;
      if (!disposed) render();
    }
  }

  async function loadLeave(silent = false): Promise<void> {
    if (leaveBusy) return;
    leaveBusy = true;
    if (!silent) leaveError = "";
    render();
    try {
      leave = await api.attendanceLeave();
      leaveError = "";
      if (leaveForm.l1.length === 0) {
        const recalled = recallApprovers(leave.candidates, LEAVE_L1_KEY);
        leaveForm.l1 = recalled.length > 0 ? recalled : leave.defaultL1.map((p) => String(p.userId));
      }
      if (!leaveForm.startDay) {
        const day = nextWorkday(leave.workdays);
        leaveForm.startDay = day;
        leaveForm.endDay = day;
      }
    } catch (err) {
      leaveError = fail(err);
    } finally {
      leaveBusy = false;
      if (!disposed) render();
    }
  }

  // ---------------------------------------------------------------- 渲染

  function render(): void {
    if (disposed) return;
    root.replaceChildren();
    root.append(paintBar());
    if (bannerText) {
      const banner = el("div", "at-banner");
      banner.append(el("span", "at-banner__text", tr("提醒：{p1}", { p1: bannerText })));
      const known = el("button", "at-link", tr("知道了"));
      known.type = "button";
      known.onclick = () => {
        bannerText = "";
        render();
      };
      banner.append(known);
      root.append(banner);
    }
    if (notice) {
      const box = el("div", `at-notice${noticeTone === "bad" ? " bad" : ""}`);
      box.append(el("span", "at-notice__text", notice));
      const close = el("button", "at-notice__x", "×");
      close.type = "button";
      close.onclick = () => {
        notice = "";
        render();
      };
      box.append(close);
      root.append(box);
    }
    if (stateError) {
      root.append(el("div", "at-empty", stateError));
      return;
    }
    if (!state) {
      root.append(el("div", "at-empty", tr("正在读状态…")));
      return;
    }
    // 没配置时默认落在「还没配置」上，但「设置」页必须能进去 —— 那是唯一的配置入口，
    // 不放开的话「去设置」按钮点了什么都不会发生（第一次装的人直接卡死）。
    if (!state.configured && tab !== "settings" && tab !== "reminder") {
      root.append(paintUnconfigured());
      return;
    }
    if (tab === "records") root.append(paintRecords());
    else if (tab === "overtime") root.append(paintOvertime());
    else if (tab === "leave") root.append(paintLeave());
    else if (tab === "reminder") root.append(paintReminder());
    else root.append(paintSettings());
  }

  function paintBar(): HTMLElement {
    const bar = el("div", "at-bar");
    const tabs = el("div", "at-tabs");
    const items: [Tab, string][] = [
      ["records", tr("考勤记录")],
      ["overtime", tr("加班申请")],
      ["leave", tr("请假申请")],
      ["reminder", tr("提醒")],
      ["settings", tr("设置")],
    ];
    for (const [id, label] of items) {
      const b = el("button", `at-tab${tab === id ? " on" : ""}`, label);
      b.type = "button";
      b.onclick = () => {
        if (tab === id) return;
        tab = id;
        notice = "";
        render();
        if (id === "overtime" && !overtime) void loadOvertime();
        if (id === "leave" && !leave) void loadLeave();
        if (id === "reminder" && !reminderLoaded) void loadReminder();
      };
      tabs.append(b);
    }
    bar.append(tabs);
    const meta = el("div", "at-meta");
    if (state) {
      meta.append(el("span", `at-chip${state.loggedIn ? "" : " warn"}`, state.loggedIn ? tr("{p1} · 已登录", { p1: state.account }) : tr("未登录")));
      if (state.cacheDays) meta.append(el("span", "at-chip", tr("{p1} 天缓存").replace("{p1}", String(state.cacheDays))));
    }
    bar.append(meta);
    return bar;
  }

  function paintUnconfigured(): HTMLElement {
    const box = el("div", "at-empty");
    box.append(el("p", "", tr("还没配置考勤系统。填好接口地址和账号，登录一次就能看了。")));
    const go = el("button", "btn", tr("去设置"));
    go.type = "button";
    go.onclick = () => {
      tab = "settings";
      render();
    };
    box.append(go);
    if (stateError) box.append(el("p", "at-hint", stateError));
    return box;
  }

  // ---- 记录

  function paintRecords(): HTMLElement {
    const wrap = el("div", "at-section");
    const toolbar = el("div", "at-toolbar");
    const start = document.createElement("input");
    start.type = "date";
    start.className = "at-input";
    start.value = range.start;
    start.onchange = () => (range.start = start.value || range.start);
    const end = document.createElement("input");
    end.type = "date";
    end.className = "at-input";
    end.value = range.end;
    end.onchange = () => (range.end = end.value || range.end);
    const query = el("button", "btn", recordsBusy ? tr("查询中…") : tr("查询"));
    query.type = "button";
    query.disabled = recordsBusy;
    query.onclick = () => void loadRecords();
    toolbar.append(el("span", "at-label", tr("从")), start, el("span", "at-label", tr("到")), end, query);
    wrap.append(toolbar);

    if (recordsError) wrap.append(el("div", "at-banner bad", recordsError));
    if (records?.stale) {
      const why = records.problem ? tr("（{p1}）", { p1: records.problem }) : "";
      wrap.append(el("div", "at-banner", tr("这是本地缓存，可能不是最新的") + why));
    }
    if (records) {
      const s = records.summary;
      const chips = el("div", "at-chips");
      chips.append(
        el("span", "at-chip", tr("出勤 {p1} 天").replace("{p1}", String(s.attended))),
        el("span", "at-chip", tr("记录 {p1} 天").replace("{p1}", String(s.days))),
        el("span", `at-chip${s.missing ? " warn" : ""}`, tr("缺卡 {p1} 天").replace("{p1}", String(s.missing))),
        ...overtimeChips(s),
        ...leaveChips(records.rows, records.compensatory),
      );
      wrap.append(chips);
      if (records.rows.length === 0) wrap.append(el("div", "at-empty", tr("这段时间没有记录")));
      else wrap.append(paintTable());
    } else if (!recordsBusy && !recordsError) {
      wrap.append(el("div", "at-empty", tr("还没查")));
      void loadRecords();
    }
    return wrap;
  }

  function paintTable(): HTMLElement {
    const table = el("table", "at-table");
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    // 表头要和行对得上：行是「日期/上班/下班/加班/备注/详情」6 列，详情行 colSpan 也是 6。
    for (const label of [tr("日期"), tr("上班"), tr("下班"), tr("加班"), tr("备注"), ""]) {
      hr.append(el("th", "", label));
    }
    thead.append(hr);
    table.append(thead);
    const tbody = document.createElement("tbody");
    for (const row of records!.rows) {
      const tr_ = document.createElement("tr");
      if (row.dayOff) tr_.className = "weekend";
      // 缺卡口径在桥端算好一起下发（周末、整天请假、今天都不算），这里只照着标。
      if (row.missing) tr_.className = `${tr_.className} missing`.trim();
      tr_.append(
        el("td", "at-day", weekdayOf(row.date) ? `${row.date} ${weekdayOf(row.date)}` : row.date),
        el("td", "", row.clockIn ?? "—"),
        el("td", "", row.clockOut ?? "—"),
        overtimeCell(row),
        el("td", "at-note", noteOf(row)),
      );
      const open = el("button", "at-detail", opened === row.date ? tr("收起") : tr("详情"));
      open.type = "button";
      open.onclick = () => {
        opened = opened === row.date ? null : row.date;
        render();
      };
      const detailCell = document.createElement("td");
      detailCell.append(open);
      tr_.append(detailCell);
      tbody.append(tr_);
      if (opened === row.date) {
        const detailRow = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 6;
        const pre = document.createElement("pre");
        pre.className = "at-raw";
        pre.textContent = JSON.stringify(row.raw, null, 2);
        cell.append(pre);
        detailRow.append(cell);
        tbody.append(detailRow);
      }
    }
    table.append(tbody);
    return table;
  }

  // 加班要分开看：平日和周末两套算头，混成一个总数等于没算。
  function overtimeChips(s: AttendanceRecords["summary"]): HTMLElement[] {
    const { workday, weekend } = overtimeSplit(s);
    const out: HTMLElement[] = [];
    if (workday > 0) {
      out.push(el("span", "at-chip", tr("平时加班 {p1} 小时").replace("{p1}", String(workday))));
    }
    if (weekend > 0) {
      out.push(el("span", "at-chip", tr("周末加班 {p1} 小时").replace("{p1}", String(weekend))));
    }
    if (!out.length) out.push(el("span", "at-chip", tr("没有加班")));
    return out;
  }

  function overtimeCell(row: AttendanceRecords["rows"][number]): HTMLElement {
    const td = el("td", "at-ov");
    if (row.overtime) {
      const kind = row.dayOff ? tr("周末") : tr("平时");
      td.append(
        el("span", row.dayOff ? "at-ov-tag weekend" : "at-ov-tag", kind),
        el("span", "at-ov-hours", String(row.overtime)),
      );
    } else if (row.dayOff) {
      // 周末没加班也标一下，免得看成数据漏了。
      td.append(el("span", "at-ov-tag quiet", tr("周末")));
    }
    return td;
  }

  // 请假只在备注列里写当日分项；区间合计与 OA 余额单独给 chips。
  function leaveChips(rows: AttendanceRecords["rows"], balance: number | null): HTMLElement[] {
    const out: HTMLElement[] = [];
    const used = leaveTotal(rows, "compensatory");
    if (used > 0) out.push(el("span", "at-chip", tr("本区间调休 {p1} 小时").replace("{p1}", String(used))));
    if (typeof balance === "number") out.push(el("span", "at-chip", tr("剩余调休 {p1} 小时").replace("{p1}", String(balance))));
    return out;
  }

  function noteOf(row: AttendanceRecords["rows"][number]): string {
    const parts: string[] = [];
    const labels: Record<LeaveKind, string> = {
      compensatory: tr("调休"),
      personal: tr("事假"),
      sick: tr("病假"),
      other: tr("其他"),
      trip: tr("出差"),
    };
    for (const item of leaveKinds(row.leaveHours)) parts.push(`${labels[item.kind]} ${item.hours}h`);
    if (row.overtimeEdited) parts.push(tr("加班时长被改过"));
    if (row.editedBy && row.editedBy !== "Batch") parts.push(row.editedBy);
    return parts.join(" · ");
  }

  // ---- 加班

  function paintOvertime(): HTMLElement {
    const wrap = el("div", "at-section");
    if (overtimeError) wrap.append(el("div", "at-banner bad", overtimeError));
    if (!overtime) {
      wrap.append(el("div", "at-empty", overtimeBusy ? tr("正在读申请…") : tr("还没读到申请")));
      if (!overtimeBusy) {
        const retry = el("button", "btn", tr("重试"));
        retry.type = "button";
        retry.onclick = () => void loadOvertime();
        wrap.append(retry);
      }
      return wrap;
    }

    // 表单
    const card = el("div", "at-card");
    card.append(el("h3", "at-card__title", tr("新的加班申请")));
    const grid = el("div", "at-grid");
    grid.append(
      field(
        tr("开始"),
        datetime("start", form.start, (v, input) => {
          const before = form.start.slice(0, 10);
          const day = v.slice(0, 10);
          form.start = v;
          // 换了一天（平日 ↔ 周末）就整段重给：两天的窗口不一样，不该让人手改两个时间。
          if (day && day !== before) {
            fillWindow(day);
            // 整页重画会丢焦点，就地改另外两个框就行。
            input.value = form.start;
            const card = input.closest(".at-card");
            const endInput = card?.querySelector<HTMLInputElement>('[data-field="end"]');
            if (endInput) endInput.value = form.end;
            const hoursInput = card?.querySelector<HTMLInputElement>('input[type="number"]');
            if (hoursInput) hoursInput.value = form.hours;
          }
          autofillHours();
        }),
      ),
    );
    grid.append(
      field(
        tr("结束"),
        datetime("end", form.end, (v, input) => {
          form.end = v;
          autofillHours();
          // 时长跟着起止时间走：自动算出来的值要立刻看得见。
          const card = input.closest(".at-card");
          const hoursInput = card?.querySelector<HTMLInputElement>('input[type="number"]');
          if (hoursInput) hoursInput.value = form.hours;
        }),
      ),
    );
    const hours = document.createElement("input");
    hours.type = "number";
    hours.min = "0.5";
    hours.step = "0.5";
    hours.className = "at-input";
    hours.placeholder = tr("自动算");
    hours.value = form.hours;
    hours.oninput = () => {
      hoursTouched = true;
      form.hours = hours.value;
    };
    grid.append(field(tr("时长（小时）"), hours));

    const typeSel = document.createElement("select");
    typeSel.className = "at-input";
    for (const r of overtime.reasons) {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r;
      if (r === form.reasonType) opt.selected = true;
      typeSel.append(opt);
    }
    if (!overtime.reasons.includes(form.reasonType) && overtime.reasons.length) form.reasonType = overtime.reasons[0]!;
    typeSel.onchange = () => (form.reasonType = typeSel.value);
    grid.append(field(tr("事由"), typeSel, false, true));
    grid.append(field(tr("项目"), noteField("project", form.project, (v) => (form.project = v), tr("比如项目号"), true), false, true));
    grid.append(field(tr("说明"), noteField("detail", form.detail, (v) => (form.detail = v), tr("补一句为什么"), true), false, true));
    grid.append(
      field(
        tr("一级审批人"),
        leaderSelect(overtime.candidates.l1, form.l1, (ids) => {
          form.l1 = ids;
          rememberApprovers(L1_KEY, ids);
        }),
        false,
        true,
      ),
    );
    grid.append(field(tr("二级审批人"), fixedLeaders(overtime.fixedL2, tr("由考勤系统按组织架构定，不能改")), true));
    card.append(grid);

    if (pending) {
      const preview = el("div", "at-confirm");
      preview.append(el("div", "at-confirm__title", tr("确认一下，这一步会真的提交到考勤系统：")));
      const p = pending.preview as {
        startTime?: string;
        endTime?: string;
        hours?: number;
        workflow?: string;
        reason?: { type?: string; project?: string; detail?: string };
      };
      // 确认框只照预览说话：预览是桥端校验过的那一份，也正是「确认提交」要发出去的那一份。
      const r = p.reason ?? {};
      preview.append(
        el("div", "at-confirm__line", tr("{p1} → {p2} · {p3} 小时", { p1: p.startTime ?? "", p2: p.endTime ?? "", p3: String(p.hours ?? "") })),
        el("div", "at-confirm__line", tr("事由：{p1}", { p1: [r.type, r.project].filter(Boolean).join(" / ") })),
        el("div", "at-confirm__line", tr("说明：{p1}", { p1: r.detail ?? "" })),
        el("div", "at-confirm__line", tr("审批人：{p1}", { p1: approverNames(p.workflow ?? "") || p.workflow || "" })),
      );
      const row = el("div", "at-confirm__actions");
      const ok = el("button", "btn primary", tr("确认提交"));
      ok.type = "button";
      ok.onclick = () => void submitOvertime(true);
      const no = el("button", "btn", tr("取消"));
      no.type = "button";
      no.onclick = () => {
        pending = null;
        render();
      };
      row.append(ok, no);
      preview.append(row);
      card.append(preview);
    } else {
      const submit = el("button", "btn primary", overtimeBusy ? tr("提交中…") : tr("提交申请"));
      submit.type = "button";
      submit.disabled = overtimeBusy;
      submit.onclick = () => void submitOvertime(false);
      card.append(submit);
    }
    wrap.append(card);

    // 列表
    const list = el("div", "at-card");
    list.append(el("h3", "at-card__title", tr("我的加班申请")));
    if (overtime.applyList.length === 0) list.append(el("div", "at-empty", tr("还没有申请")));
    else {
      const table = el("table", "at-table");
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const label of [tr("单号"), tr("时间"), tr("时长"), tr("事由"), tr("状态"), ""]) hr.append(el("th", "", label));
      thead.append(hr);
      table.append(thead);
      const tbody = document.createElement("tbody");
      for (const app of overtime.applyList) {
        const row = document.createElement("tr");
        const state_ = statusOf(overtime.workflow[String(app.code)] as unknown, app.workflow_result, app.reject_reason ?? "");
        row.append(
          el("td", "", String(app.code)),
          el("td", "", spanText(app.start_time, app.end_time)),
          el("td", "", hoursText(app.hours)),
          el("td", "", reasonText(app.reasonParsed)),
          el("td", state_.tone === "bad" ? "at-bad" : "", state_.text),
        );
        const cell = document.createElement("td");
        if (app.workflow_result === 0) {
          const cancel = el("button", "at-link", tr("撤回"));
          cancel.type = "button";
          cancel.onclick = () => void cancelOvertime(app.code);
          cell.append(cancel);
        }
        row.append(cell);
        tbody.append(row);
      }
      table.append(tbody);
      list.append(table);
    }
    wrap.append(list);
    return wrap;
  }

  function statusOf(chain: unknown, result: number, rejected: string): { text: string; tone: "ok" | "bad" } {
    const state_ = stepState(chain, result);
    if (state_.kind === "ended") {
      // 「审批结束」有三种结局，笼统写成「已结束」会把被驳回的抹平。
      if (rejected) return { text: tr("已驳回"), tone: "bad" };
      if (result === 1) return { text: tr("已通过"), tone: "ok" };
      return { text: tr("已结束"), tone: "ok" };
    }
    if (state_.kind === "pending") return { text: tr("待{p1}审批", { p1: state_.role }), tone: "ok" };
    return { text: tr("审批中"), tone: "ok" };
  }

  /** 一格表单：wide 时占满整行（审批人这种要塞几个名字的用得上）；required 时标签后面带一个红色 *。 */
  function field(label: string, node: HTMLElement, wide = false, required = false): HTMLElement {
    const box = el("label", "at-field");
    if (wide) box.classList.add("at-field--wide");
    const head = el("span", "at-field__label", label);
    if (required) {
      const star = el("span", "at-req", "*");
      star.title = tr("必填");
      head.append(star);
    }
    box.append(head);
    box.append(node);
    return box;
  }

  function text(name: string, value: string, onChange: (v: string) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "at-input";
    input.dataset.field = name;
    input.value = value;
    input.oninput = () => onChange(input.value);
    return input;
  }

  /**
   * 确认框里给人看的审批人：把 `"一级ids&二级ids"` 里的 id 换成「姓名 工号」，按一级、二级的顺序。
   * 加班、请假两页的候选人都放进名单里查（同一个人在两边的 id 一样）。
   */
  function approverNames(workflow: string): string {
    const pool = new Map<number, string>();
    const people = [
      ...(overtime?.candidates.l1 ?? []),
      ...(overtime?.fixedL2 ?? []),
      ...(leave?.candidates ?? []),
      ...(leave?.fixedL2 ?? []),
    ];
    for (const x of people) pool.set(x.userId, `${x.name} ${x.workNo}`.trim());
    const [a = "", b = ""] = workflow.split("&");
    const show = (part: string): string =>
      part
        .split(",")
        .map((id) => pool.get(Number(id)) ?? "")
        .filter(Boolean)
        .join(tr("、"));
    return [show(a), show(b)].filter(Boolean).join(" → ");
  }

  /** 带一句提示的小输入框；required 时同时打上 `required`（读屏、:invalid 样式都认）。 */
  function noteField(name: string, value: string, onChange: (v: string) => void, hint: string, required = false): HTMLInputElement {
    const input = text(name, value, onChange);
    input.placeholder = hint;
    if (required) input.required = true;
    return input;
  }

  function datetime(
    name: string,
    value: string,
    onChange: (v: string, input: HTMLInputElement) => void,
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "datetime-local";
    input.className = "at-input";
    input.dataset.field = name;
    input.value = value;
    input.onchange = () => onChange(input.value, input);
    return input;
  }

  // 起止时间填齐就自己算时长；人改过就不插手。
  function autofillHours(): void {
    if (hoursTouched) return;
    const a = new Date(form.start).getTime();
    const b = new Date(form.end).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
      form.hours = "";
      return;
    }
    form.hours = String(round1((b - a) / 3_600_000));
  }

  /** 按某一天给起止时间：工作日 18–22，周末 9–18。 */
  function fillWindow(day: string): void {
    const win = defaultWindow(day);
    form.start = `${day}T${win.start}`;
    form.end = `${day}T${win.end}`;
    autofillHours();
  }

  // 一级审批人记住上次的选择：天天是同一个人，每次从头挑太烦。加班、请假各记各的。
  function rememberApprovers(key: string, ids: string[]): void {
    try {
      localStorage.setItem(key, JSON.stringify(ids));
    } catch {
      /* 隐私模式下没有 localStorage，记不住就算了 */
    }
  }

  function recallApprovers(list: { userId: number }[], key: string): string[] {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const ids = JSON.parse(raw);
      if (!Array.isArray(ids)) return [];
      const known = new Set(list.map((p) => String(p.userId)));
      return ids.map(String).filter((id) => known.has(id));
    } catch {
      return [];
    }
  }

  function leaderSelect(
    list: { userId: number; name: string; workNo: string }[],
    chosen: string[],
    onPick: (ids: string[]) => void,
  ): HTMLElement {
    const wrap = el("div", "at-leaders");
    if (list.length === 0) {
      wrap.append(el("span", "at-hint", tr("没有候选")));
      return wrap;
    }
    const sel = document.createElement("select");
    sel.className = "at-input";
    // 单选没有占位项时，浏览器会把第一个候选画成「已选中」——看着像选了，其实没有。
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = tr("请选择");
    sel.append(blank);
    for (const p of list) {
      const opt = document.createElement("option");
      opt.value = String(p.userId);
      opt.textContent = p.workNo ? `${p.name} ${p.workNo}` : p.name;
      if (chosen.includes(opt.value)) opt.selected = true;
      sel.append(opt);
    }
    sel.dataset.role = "l1";
    sel.onchange = () => {
      onPick(
        Array.from(sel.selectedOptions)
          .map((o) => o.value)
          .filter(Boolean),
      );
    };
    wrap.append(sel);
    return wrap;
  }

  /** 二级审批人：只读展示。OA 按组织架构定好是谁，我们连改的口子都不给。 */
  function fixedLeaders(list: { name: string; workNo: string }[], hint: string): HTMLElement {
    const wrap = el("div", "at-leaders");
    if (list.length === 0) {
      wrap.append(el("span", "at-hint", tr("OA 没给这级的固定审批人，提交前先在 OA 网页上确认一次")));
      return wrap;
    }
    for (const p of list) wrap.append(el("span", "at-chip", p.workNo ? `${p.name} ${p.workNo}` : p.name));
    wrap.append(el("span", "at-hint", hint));
    return wrap;
  }

  async function submitOvertime(confirmed: boolean): Promise<void> {
    if (overtimeBusy) return;
    overtimeBusy = true;
    render();
    const body: Record<string, unknown> = {
      startTime: form.start,
      endTime: form.end,
      hours: Number(form.hours),
      reason: { type: form.reasonType, project: form.project, detail: form.detail },
      workflow: { l1: form.l1.map(Number), l2: form.l2.map(Number) },
    };
    try {
      if (!confirmed) {
        const res = await api.attendanceOvertimeSubmit({ ...body });
        if (res.needConfirm) {
          pending = { preview: res.preview ?? {}, body };
          notice = "";
          return;
        }
        notice = tr("提交完成");
        noticeTone = "ok";
      } else {
        // 发的是预览那一份：人在确认框出来之后又改了表单，不能让没看过的内容混进去。
        await api.attendanceOvertimeSubmit({ ...(pending?.body ?? body), confirm: true });
        pending = null;
        notice = tr("交上去了，等审批");
        noticeTone = "ok";
        overtime = await api.attendanceOvertime();
      }
    } catch (err) {
      pending = null;
      notice = fail(err);
      noticeTone = "bad";
    } finally {
      overtimeBusy = false;
      if (!disposed) render();
    }
  }

  async function cancelOvertime(code: number): Promise<void> {
    const confirmed = cancelPending === code;
    try {
      const res = await api.attendanceOvertimeCancel(code, confirmed);
      if (res.needConfirm) {
        cancelPending = code;
        notice = tr("再点一次撤回：单号 {p1}").replace("{p1}", String(code));
        noticeTone = "bad";
        render();
        return;
      }
      cancelPending = null;
      notice = tr("已撤回");
      noticeTone = "ok";
      overtime = await api.attendanceOvertime();
    } catch (err) {
      cancelPending = null;
      notice = fail(err);
      noticeTone = "bad";
    }
    if (!disposed) render();
  }

  // ---- 请假

  /** 今天之后的第一个工作日（OA 规定 ≤2 天的假要前一天提，默认当天基本都会被拒）。 */
  function nextWorkday(workdays: string[]): string {
    const today = dateKey(new Date());
    const hit = [...workdays].sort().find((d) => d > today);
    if (hit) return hit;
    const d = new Date();
    do d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6);
    return dateKey(d);
  }

  function dateInput(name: string, value: string, onChange: (v: string) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "date";
    input.className = "at-input";
    input.dataset.field = name;
    input.value = value;
    input.onchange = () => onChange(input.value);
    return input;
  }

  function hourSelect(name: string, hours: readonly number[], value: number, onChange: (v: number) => void): HTMLSelectElement {
    const sel = document.createElement("select");
    sel.className = "at-input at-hour";
    sel.dataset.field = name;
    for (const h of hours) {
      const opt = document.createElement("option");
      opt.value = String(h);
      opt.textContent = `${String(h).padStart(2, "0")}:00`;
      if (h === value) opt.selected = true;
      sel.append(opt);
    }
    sel.onchange = () => onChange(Number(sel.value));
    return sel;
  }

  /** 表单里的预估时长：口径与桥端 estimateLeave 一致（工作日整天 8h、半天 4h；其他按天）。 */
  function leaveEstimate(): string {
    const f = leaveForm;
    if (!f.startDay || !f.endDay || f.endDay < f.startDay) return "—";
    const days: string[] = [];
    for (let d = new Date(`${f.startDay}T00:00:00`); dateKey(d) <= f.endDay; d.setDate(d.getDate() + 1)) days.push(dateKey(d));
    if (isByDay(f.type)) return tr("{p1} 天", { p1: String(days.length) });
    const work = new Set(leave?.workdays ?? []);
    const isWork = (k: string): boolean => (work.size ? work.has(k) : ![0, 6].includes(new Date(`${k}T00:00:00`).getDay()));
    let hours = 0;
    days.forEach((k, i) => {
      if (!isWork(k)) return;
      const from = i === 0 ? f.startHour : 9;
      const to = i === days.length - 1 ? f.endHour : 18;
      hours += (from <= 9 && to >= 13 ? 4 : 0) + (from <= 14 && to >= 18 ? 4 : 0);
    });
    return tr("{p1} 小时", { p1: String(hours) });
  }

  function leaveSpan(start: string, end: string, type: string): string {
    const s = start.replace("T", " ");
    const e = end.replace("T", " ");
    if (isByDay(type)) return `${s.slice(0, 10)} → ${e.slice(0, 10)}`;
    return `${s.slice(0, 16)} → ${e.slice(0, 16)}`;
  }

  function leaveAmount(app: AttendanceLeave["applyList"][number]): string {
    if (isByDay(app.leaveType)) return tr("{p1} 天", { p1: String(app.other_days) });
    const h = app.compensatory_hours || app.normal_hours || app.sick_hours || 0;
    return tr("{p1} 小时", { p1: String(h) });
  }

  function paintLeave(): HTMLElement {
    const wrap = el("div", "at-section");
    if (leaveError) wrap.append(el("div", "at-banner bad", leaveError));
    if (!leave) {
      wrap.append(el("div", "at-empty", leaveBusy ? tr("正在读申请…") : tr("还没读到申请")));
      if (!leaveBusy) {
        const retry = el("button", "btn", tr("重试"));
        retry.type = "button";
        retry.onclick = () => void loadLeave();
        wrap.append(retry);
      }
      return wrap;
    }
    const f = leaveForm;
    const byDay = isByDay(f.type);
    const card = el("div", "at-card");
    card.append(el("h3", "at-card__title", tr("新的请假申请")));
    const grid = el("div", "at-grid");

    const typeSel = document.createElement("select");
    typeSel.className = "at-input";
    typeSel.dataset.field = "leaveType";
    for (const t of LEAVE_TYPES) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = leaveTypeLabel(t);
      if (t === f.type) opt.selected = true;
      typeSel.append(opt);
    }
    typeSel.onchange = () => {
      f.type = typeSel.value;
      render();
    };
    grid.append(field(tr("请假类型"), typeSel, false, true));
    const amount = el("span", "at-chip", leaveEstimate());
    amount.dataset.role = "leave-estimate";
    const amountBox = el("div", "at-leaders");
    amountBox.append(amount);
    if (f.type === LEAVE_TYPES[0] && leave.compensatory !== null) {
      amountBox.append(el("span", "at-hint", tr("调休余额 {p1} 小时", { p1: String(leave.compensatory) })));
    }
    grid.append(field(tr("时长（预估）"), amountBox));
    const refreshEstimate = (from: HTMLElement): void => {
      const chip = from.closest(".at-card")?.querySelector<HTMLElement>('[data-role="leave-estimate"]');
      if (chip) chip.textContent = leaveEstimate();
    };

    const startBox = el("div", "at-when");
    const startDay = dateInput("startDay", f.startDay, (v) => {
      f.startDay = v;
      // 结束日期早于开始就跟着挑：绝大多数假是同一天。
      if (!f.endDay || f.endDay < v) {
        f.endDay = v;
        const endInput = startDay.closest(".at-card")?.querySelector<HTMLInputElement>('[data-field="endDay"]');
        if (endInput) endInput.value = v;
      }
      refreshEstimate(startDay);
    });
    startBox.append(startDay);
    if (!byDay) {
      const sh = hourSelect("startHour", [9, 14], f.startHour, (v) => {
        f.startHour = v;
        refreshEstimate(sh);
      });
      startBox.append(sh);
    }
    grid.append(field(tr("开始"), startBox, false, true));

    const endBox = el("div", "at-when");
    const endDay = dateInput("endDay", f.endDay, (v) => {
      f.endDay = v;
      refreshEstimate(endDay);
    });
    endBox.append(endDay);
    if (!byDay) {
      const eh = hourSelect("endHour", [14, 18], f.endHour, (v) => {
        f.endHour = v;
        refreshEstimate(eh);
      });
      endBox.append(eh);
    }
    grid.append(field(tr("结束"), endBox, false, true));

    const hint = byDay ? tr("例如：育儿假，婚假，产假，丧假等，请注明") : tr("请假原因");
    grid.append(field(tr("事由"), noteField("leaveReason", f.reason, (v) => (f.reason = v), hint, true), true, true));
    grid.append(
      field(
        tr("一级审批人"),
        leaderSelect(leave.candidates, f.l1, (ids) => {
          f.l1 = ids;
          rememberApprovers(LEAVE_L1_KEY, ids);
        }),
        false,
        true,
      ),
    );
    grid.append(field(tr("二级审批人"), fixedLeaders(leave.fixedL2, tr("由考勤系统按组织架构定，不能改")), true));
    card.append(grid);

    const rules = el("ul", "at-rules");
    for (const line of [
      tr("请假 ≤2 天：须于前一日 16:30 前提交"),
      tr("请假 ≥3 天：须提前一周提交，说明事由并提交佐证材料"),
      tr("突发疾病无法提前报备：第一时间告知项目负责人，并于当日补齐系统流程"),
      tr("病假 / 其他假：还需填写《特殊假申请单》并提交佐证材料至管理部"),
    ]) {
      rules.append(el("li", "", line));
    }
    card.append(rules);

    if (leavePending) {
      const p = leavePending.preview as {
        type?: string;
        startTime?: string;
        endTime?: string;
        reason?: string;
        workflow?: string;
        estimate?: { value: number; unit: string };
      };
      const box = el("div", "at-confirm");
      box.append(el("div", "at-confirm__title", tr("确认一下，这一步会真的提交到考勤系统：")));
      const est = p.estimate ? (p.estimate.unit === "d" ? tr("{p1} 天", { p1: String(p.estimate.value) }) : tr("{p1} 小时", { p1: String(p.estimate.value) })) : "";
      box.append(
        el(
          "div",
          "at-confirm__line",
          [leaveTypeLabel(p.type ?? ""), leaveSpan(p.startTime ?? "", p.endTime ?? "", p.type ?? ""), est ? tr("约 {p1}", { p1: est }) : ""]
            .filter(Boolean)
            .join(" · "),
        ),
        el("div", "at-confirm__line", tr("事由：{p1}", { p1: p.reason ?? "" })),
        el("div", "at-confirm__line", tr("审批人：{p1}", { p1: approverNames(p.workflow ?? "") || p.workflow || "" })),
      );
      const row = el("div", "at-confirm__actions");
      const ok = el("button", "btn primary", tr("确认提交"));
      ok.type = "button";
      ok.disabled = leaveBusy;
      ok.onclick = () => void submitLeave(true);
      const no = el("button", "btn", tr("取消"));
      no.type = "button";
      no.onclick = () => {
        leavePending = null;
        render();
      };
      row.append(ok, no);
      box.append(row);
      card.append(box);
    } else {
      const submit = el("button", "btn primary", leaveBusy ? tr("提交中…") : tr("提交申请"));
      submit.type = "button";
      submit.disabled = leaveBusy;
      submit.onclick = () => void submitLeave(false);
      card.append(submit);
    }
    wrap.append(card);

    const list = el("div", "at-card");
    list.append(el("h3", "at-card__title", tr("我的请假申请")));
    if (leave.applyList.length === 0) list.append(el("div", "at-empty", tr("还没有申请")));
    else {
      const table = el("table", "at-table");
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const label of [tr("单号"), tr("类型"), tr("时间"), tr("时长"), tr("事由"), tr("状态"), ""]) hr.append(el("th", "", label));
      thead.append(hr);
      table.append(thead);
      const tbody = document.createElement("tbody");
      for (const app of leave.applyList) {
        const row = document.createElement("tr");
        const st = statusOf(leave.workflow[String(app.code)] as unknown, app.workflow_result, app.reject_reason ?? "");
        row.append(
          el("td", "", String(app.code)),
          el("td", "", app.leaveType ? leaveTypeLabel(app.leaveType) : "—"),
          el("td", "", leaveSpan(app.start_time, app.end_time, app.leaveType)),
          el("td", "", leaveAmount(app)),
          el("td", "at-note", app.reason ?? ""),
          el("td", st.tone === "bad" ? "at-bad" : "", st.text),
        );
        const cell = document.createElement("td");
        if (app.workflow_result === 0) {
          const cancel = el("button", "at-link", leaveCancelPending === app.code ? tr("确认撤回") : tr("撤回"));
          cancel.type = "button";
          cancel.onclick = () => void cancelLeave(app.code, app.leaveType);
          cell.append(cancel);
        }
        row.append(cell);
        tbody.append(row);
      }
      table.append(tbody);
      list.append(table);
    }
    wrap.append(list);
    return wrap;
  }

  async function submitLeave(confirmed: boolean): Promise<void> {
    if (leaveBusy) return;
    const f = leaveForm;
    const body: Record<string, unknown> = confirmed && leavePending
      ? leavePending.body
      : {
          type: f.type,
          startDay: f.startDay,
          endDay: f.endDay,
          startHour: f.startHour,
          endHour: f.endHour,
          reason: f.reason,
          workflow: { l1: f.l1.map(Number), l2: (leave?.fixedL2 ?? []).map((p) => p.userId) },
          workdays: leave?.workdays ?? [],
        };
    leaveBusy = true;
    render();
    try {
      if (!confirmed) {
        const res = await api.attendanceLeaveSubmit({ ...body });
        if (res.needConfirm) {
          leavePending = { preview: res.preview ?? {}, body };
          notice = "";
          return;
        }
      } else {
        await api.attendanceLeaveSubmit({ ...body, confirm: true });
        leavePending = null;
        f.reason = "";
        notice = tr("交上去了，等审批");
        noticeTone = "ok";
        leave = await api.attendanceLeave();
      }
    } catch (err) {
      leavePending = null;
      notice = fail(err);
      noticeTone = "bad";
    } finally {
      leaveBusy = false;
      if (!disposed) render();
    }
  }

  async function cancelLeave(code: number, type: string): Promise<void> {
    const confirmed = leaveCancelPending === code;
    try {
      const res = await api.attendanceLeaveCancel(code, type, confirmed);
      if (res.needConfirm) {
        leaveCancelPending = code;
        notice = tr("再点一次撤回：单号 {p1}").replace("{p1}", String(code));
        noticeTone = "bad";
        render();
        return;
      }
      leaveCancelPending = null;
      notice = tr("已撤回");
      noticeTone = "ok";
      leave = await api.attendanceLeave();
    } catch (err) {
      leaveCancelPending = null;
      notice = fail(err);
      noticeTone = "bad";
    }
    if (!disposed) render();
  }

  // ---- 设置

  // ---------------------------------------------------------------- 提醒

  async function loadReminder(silent = false): Promise<void> {
    if (reminderBusy) return;
    reminderBusy = true;
    if (!silent) reminderError = "";
    let fresh = false;
    try {
      const data = await api.attendanceReminder();
      reminder = data;
      reminderError = "";
      if (!reminderLoaded) {
        reminderLoaded = true;
        reminderForm.enabled = data.rule.enabled;
        reminderForm.days = [...data.rule.days];
        reminderForm.time = data.rule.time;
        reminderForm.text = data.rule.text;
      }
      fresh = pickBanner(data);
    } catch (err) {
      if (!silent || !reminder) reminderError = fail(err);
    } finally {
      reminderBusy = false;
      // 静默轮询只在真的冒出新提醒时重画，否则每 60 秒白闪一下。
      if (!disposed && (!silent || fresh)) render();
    }
  }

  /** 今天真的发过、且还没提示过 → 返回 true（调用方据此重画）。 */
  function pickBanner(data: AttendanceReminder): boolean {
    if (!data.rule.enabled) return false;
    if (data.lastFiredDate !== dateKey(new Date())) return false;
    const key = data.lastFiredDate + " " + data.lastFiredAt;
    if (key === bannerSeen) return false;
    bannerSeen = key;
    bannerText = data.rule.text;
    return true;
  }

  function clockOf(iso: string): string {
    if (!iso) return "";
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return "";
    return String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
  }

  function paintReminder(): HTMLElement {
    const wrap = el("div", "at-section");
    if (reminderError) wrap.append(el("div", "at-banner bad", reminderError));
    if (reminderNotice) wrap.append(el("div", "at-banner", reminderNotice));
    if (!reminder) {
      wrap.append(el("div", "at-empty", reminderBusy ? tr("正在读提醒设置…") : tr("还没读到提醒设置")));
      return wrap;
    }

    const card = el("div", "at-card");
    card.append(el("h3", "at-card__title", tr("加班申请提醒")));

    const on = document.createElement("input");
    on.type = "checkbox";
    on.checked = reminderForm.enabled;
    on.dataset.field = "reminder-enabled";
    on.onchange = () => (reminderForm.enabled = on.checked);
    const onRow = el("label", "at-toggle");
    onRow.append(on, el("span", "", tr("到点提醒我提交加班申请")));
    card.append(onRow);

    const grid = el("div", "at-grid at-grid--reminder");
    // 星期：7 个按钮，点谁谁亮。存 ISO 编号（1 = 周一），别把「周一」两个字存进数据里。
    const days = el("div", "at-week");
    const labels = [tr("周一"), tr("周二"), tr("周三"), tr("周四"), tr("周五"), tr("周六"), tr("周日")];
    labels.forEach((label, index) => {
      const day = index + 1;
      const picked = reminderForm.days.includes(day);
      const btn = el("button", "at-week__btn" + (picked ? " on" : ""), label);
      btn.type = "button";
      btn.dataset.day = String(day);
      btn.onclick = () => {
        reminderForm.days = picked
          ? reminderForm.days.filter((d) => d !== day)
          : [...reminderForm.days, day].sort((a, b) => a - b);
        reminderNotice = "";
        reminderError = "";
        render();
      };
      days.append(btn);
    });
    // 七个按钮要占整行，否则挤在 220px 的格子里换三行。
    const daysField = field(tr("每周几"), days);
    daysField.classList.add("at-field--wide");
    grid.append(daysField);

    const time = document.createElement("input");
    time.type = "time";
    time.className = "at-input";
    time.dataset.field = "reminder-time";
    time.value = reminderForm.time;
    time.oninput = () => (reminderForm.time = time.value);
    grid.append(field(tr("几点"), time));

    const body = text("reminder-text", reminderForm.text, (v) => (reminderForm.text = v));
    body.placeholder = tr("比如：该提交本周的加班申请了");
    grid.append(field(tr("提示内容"), body));
    card.append(grid);

    const actions = el("div", "at-actions");
    const save = el("button", "btn primary", tr("保存提醒"));
    save.type = "button";
    save.onclick = () => void saveReminder();
    const test = el("button", "btn", tr("试一下"));
    test.type = "button";
    test.onclick = () => void testReminder();
    actions.append(save, test);
    card.append(actions);
    wrap.append(card);

    // 这条提醒到底能不能弹出去，取决于 pi 的通知总开关和推送订阅 —— 摆明面上，别让人猜。
    const info = el("div", "at-card");
    info.append(el("h3", "at-card__title", tr("通知通道")));
    const kv = el("dl", "at-kv");
    const put = (k: string, v: string) => {
      kv.append(el("dt", "", k), el("dd", "", v));
    };
    put(tr("通知总开关"), reminder.pushEnabled ? tr("已打开") : tr("关着：去 pi 设置 → 通知里打开"));
    put(
      tr("推送订阅"),
      reminder.pushSubscriptions > 0
        ? tr("{p1} 台设备").replace("{p1}", String(reminder.pushSubscriptions))
        : tr("还没有设备订阅：在 pi 设置 → 通知里打开推送"),
    );
    put(tr("上次提醒"), reminder.lastFiredDate ? reminder.lastFiredDate + " " + clockOf(reminder.lastFiredAt) : tr("还没发过"));
    if (reminder.lastFiredDate) {
      put(tr("上次到达"), reminder.lastSent > 0 ? tr("{p1} 台设备").replace("{p1}", String(reminder.lastSent)) : tr("没有设备收到"));
    }
    info.append(kv);
    wrap.append(info);
    return wrap;
  }

  async function saveReminder(): Promise<void> {
    reminderNotice = "";
    reminderError = "";
    try {
      const saved = await api.attendanceReminderSave({
        enabled: reminderForm.enabled,
        days: reminderForm.days,
        time: reminderForm.time,
        text: reminderForm.text,
      });
      reminder = saved;
      reminderNotice = tr("提醒已保存");
      reminderForm.days = [...saved.rule.days];
      reminderForm.time = saved.rule.time;
      reminderForm.text = saved.rule.text;
    } catch (err) {
      reminderError = fail(err);
    }
    render();
  }

  async function testReminder(): Promise<void> {
    reminderNotice = "";
    reminderError = "";
    try {
      const sent = await api.attendanceReminderTest();
      reminderNotice = sent.sent > 0 ? tr("已发出去，去右下角看看") : tr("发出去了，但没有设备收到");
    } catch (err) {
      reminderError = fail(err);
    }
    render();
  }

  function paintSettings(): HTMLElement {
    const wrap = el("div", "at-section");
    const card = el("div", "at-card");
    card.append(el("h3", "at-card__title", tr("考勤系统")));
    const grid = el("div", "at-grid");

    const cfgInput = (name: "apiBase" | "pageBase" | "account", saved: string): HTMLInputElement =>
      text(name, cfgTouched[name] ? cfgDraft[name] : saved, (v) => {
        cfgTouched[name] = true;
        cfgDraft[name] = v;
      });
    const apiBase = cfgInput("apiBase", state?.apiBase ?? "");
    apiBase.placeholder = "https://attendance.example.com:8085";
    const pageBase = cfgInput("pageBase", state?.pageBase ?? "");
    pageBase.placeholder = "https://attendance.example.com";
    // 账号只认草稿：state 给的是掩码（TS***1），填进输入框再保存回去就成了账号。
    const account = cfgInput("account", "");
    account.placeholder = state?.account || tr("工号或邮箱");
    const password = document.createElement("input");
    password.type = passwordVisible ? "text" : "password";
    password.className = "at-input";
    // 与 D267 同口径：本站存过登录密码的浏览器会往 password 框里自动填 / 弹保存提示，
    // new-password 能把那条路堵掉。
    password.autocomplete = "new-password";
    password.placeholder = tr("登录态会加密存本机");
    password.value = passwordDraft;
    password.oninput = () => {
      passwordDraft = password.value;
      passwordTouched = true;
    };
    // 进设置页时把已存密码捞回来，只捞一次。
    if (!savedPasswordLoaded) void loadSavedPassword();
    // 眼睛只切 input 的 type：不改值、也不再问桥要一次，明文只存在于这一帧的 DOM 里。
    const secret = el("div", "at-secret");
    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "at-eye";
    const paintEye = (visible: boolean): void => {
      const label = visible ? tr("隐藏密码") : tr("显示密码");
      eye.title = label;
      eye.setAttribute("aria-label", label);
      eye.setAttribute("aria-pressed", visible ? "true" : "false");
      eye.replaceChildren(eyeIcon(visible));
    };
    eye.onclick = () => {
      passwordVisible = !passwordVisible;
      password.type = passwordVisible ? "text" : "password";
      paintEye(passwordVisible);
    };
    paintEye(passwordVisible);
    secret.append(password, eye);

    grid.append(
      field(tr("接口地址"), apiBase),
      field(tr("网页地址"), pageBase),
      field(tr("账号"), account),
      field(tr("密码"), secret),
    );
    card.append(grid);
    card.append(
      el(
        "p",
        "at-hint",
        tr("接口地址填 OA 的后端（一般带端口），网页地址填你平时打开页面的那个；两个常常只差端口。"),
      ),
    );

    const actions = el("div", "at-actions");
    const save = el("button", "btn", tr("保存配置"));
    save.type = "button";
    save.onclick = async () => {
      try {
        // 不带账户就表示「沿用已经存着的那个」—— 页面上只有掩码（TS***1），
        // 拿它当账号发回去会把掩码存成账号，登录必错。
        await api.attendanceSaveConfig({
          apiBase: apiBase.value.trim(),
          pageBase: pageBase.value.trim(),
          account: account.value.trim(),
        } as never);
        notice = tr("配置已保存");
        noticeTone = "ok";
        await loadState();
      } catch (err) {
        say(fail(err), "bad");
      }
    };
    const login = el("button", "btn primary", tr("登录"));
    login.type = "button";
    login.onclick = async () => {
      try {
        const wantApi = apiBase.value.trim().replace(/\/+$/, "");
        const wantPage = pageBase.value.trim();
        const wantAccount = account.value.trim();
        // 表单里填了地址就先落盘再登录：没人说过「登录」之前必须先点一次「保存配置」，
        // 而桥端 login 只读已存的 config —— 少了这一步就回「先配好 OA 地址」。
        if (wantApi && (wantApi !== (state?.apiBase ?? "") || wantPage !== (state?.pageBase ?? ""))) {
          await api.attendanceSaveConfig({ apiBase: wantApi, pageBase: wantPage, account: wantAccount } as never);
        }
        const used = password.value;
        await api.attendanceLogin({ account: wantAccount, password: used });
        // 桥刚把这条密码写进凭据文件：框里留着（掩码），眼睛一按能核对，改的时候不用重敲。
        passwordDraft = used;
        passwordTouched = false;
        savedPasswordLoaded = true;
        notice = tr("登录成功");
        noticeTone = "ok";
        await loadState();
      } catch (err) {
        say(fail(err), "bad");
      }
    };
    const logout = el("button", "btn", tr("退出登录"));
    logout.type = "button";
    logout.onclick = async () => {
      try {
        await api.attendanceLogout();
        passwordDraft = "";
        passwordTouched = false;
        passwordVisible = false;
        // 凭据已经删了，别再回头问桥要密码。
        savedPasswordLoaded = true;
        notice = tr("已退出");
        noticeTone = "ok";
        await loadState();
      } catch (err) {
        say(fail(err), "bad");
      }
    };
    actions.append(save, login, logout);
    card.append(actions);

    if (state) {
      const info = el("dl", "at-kv");
      const pairs: [string, string][] = [
        [tr("状态"), state.loggedIn ? tr("已登录") : tr("未登录")],
        [tr("账号"), state.account || "—"],
        [tr("工号"), state.workNoMask || "—"],
        [tr("缓存"), state.cacheDays ? tr("{p1} 天").replace("{p1}", String(state.cacheDays)) : "—"],
      ];
      for (const [k, v] of pairs) {
        info.append(el("dt", "", k), el("dd", "", v));
      }
      wrap.append(card, info);
    } else wrap.append(card);

    const danger = el("div", "at-card danger");
    danger.append(el("h3", "at-card__title", tr("清除本地数据")));
    danger.append(
      el("p", "at-hint", tr("删掉地址、账号、登录态和 {p1} 天缓存。审计日志留着（只有「什么时候做了什么」，没有密码）。").replace("{p1}", "90")),
    );
    const purge = el("button", "btn danger", tr("清除"));
    purge.type = "button";
    purge.onclick = async () => {
      if (!window.confirm(tr("确定清除本机保存的考勤配置和登录态？"))) return;
      try {
        await api.attendancePurge();
        passwordDraft = "";
        passwordTouched = false;
        passwordVisible = false;
        savedPasswordLoaded = true;
        // 清完就得把草稿一起丢掉：否则输入框还挂着刚被删掉的旧地址，看着像没清干净。
        cfgDraft.apiBase = "";
        cfgDraft.pageBase = "";
        cfgDraft.account = "";
        cfgTouched.apiBase = false;
        cfgTouched.pageBase = false;
        cfgTouched.account = false;
        notice = tr("已清除");
        noticeTone = "ok";
        records = null;
        overtime = null;
        await loadState();
      } catch (err) {
        say(fail(err), "bad");
      }
    };
    danger.append(purge);
    wrap.append(danger);
    return wrap;
  }

  render();
  void loadState();
  // 提醒设置顺带拉一次：页内提示条靠它判断「今天有没有发过」。
  void loadReminder(true);
  const reminderPoll = setInterval(() => void loadReminder(true), 60_000);

  const refresh = (): void => {
    void loadState();
    void loadReminder(true);
    if (tab === "records") void loadRecords();
    else if (tab === "overtime") void loadOvertime();
    else if (tab === "leave") void loadLeave();
  };

  return {
    dispose: () => {
      disposed = true;
      clearInterval(reminderPoll);
      root.remove();
    },
    refresh,
  };
}
