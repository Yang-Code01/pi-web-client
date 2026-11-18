/**
 * 本机管理 → 考勤（第六页）。
 *
 * 这一页自己管自己的数据：进页调 `/api/attendance/state`，三块内容各拉各的接口，
 * 不塞进 `sysmanage.ts` 的 `state[section]` —— 那套是按「一次 GET 一份快照」设计的，
 * 考勤要的是「配置 / 记录 / 申请」三份不同形状、还能分别写回。
 *
 * 界面上的硬约束：
 *   - 密码只在输入框里待着，从不回显、从不进 localStorage；页面拿到的账号一律是掩码。
 *   - 提交加班要二次确认：先 POST 不带 confirm 拿一份预览，人再点一次才真发。
 *   - 隧道访客看不到这一页（桥端整页 404），页面这边只负责别把自己画坏。
 */
import { api } from "./api.ts";
import { createEl as el } from "./chat.ts";
import { errText, tr } from "./i18n/index.ts";
import type { AttendanceState, AttendanceRecords, AttendanceOvertime, AttendanceReminder } from "./sysmanage-types.ts";
// 日期 → 「周五」这件事本机管理已经做过一遍（sysmanage-model.ts:207），别再写一张中文星期表。
import { weekdayOf } from "./sysmanage-model.ts";
import { dateKey, defaultRange, defaultWindow, hoursText, overtimeSplit, reasonText, round1, spanText, stepState } from "./attendance-shared.ts";
import "./attendance.css";

type Tab = "records" | "overtime" | "reminder" | "settings";

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
  let notice = "";
  let noticeTone: "ok" | "bad" = "ok";
  // 密码框靠这个活过重绘：点「保存配置」会把整页重画，输入框里刚敲的密码
  // 随之消失，紧接着点「登录」就变成「请填密码」。只留在内存里，不落盘。
  let passwordDraft = "";
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
    else if (tab === "reminder") root.append(paintReminder());
    else root.append(paintSettings());
  }

  function paintBar(): HTMLElement {
    const bar = el("div", "at-bar");
    const tabs = el("div", "at-tabs");
    const items: [Tab, string][] = [
      ["records", tr("考勤记录")],
      ["overtime", tr("加班申请")],
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
      if (row.weekend) tr_.className = "weekend";
      if (!row.clockIn || !row.clockOut) tr_.className = `${tr_.className} missing`.trim();
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
      const kind = row.weekend ? tr("周末") : tr("平时");
      td.append(
        el("span", row.weekend ? "at-ov-tag weekend" : "at-ov-tag", kind),
        el("span", "at-ov-hours", String(row.overtime)),
      );
    } else if (row.weekend) {
      // 周末没加班也标一下，免得看成数据漏了。
      td.append(el("span", "at-ov-tag quiet", tr("周末")));
    }
    return td;
  }

  function noteOf(row: AttendanceRecords["rows"][number]): string {
    const parts: string[] = [];
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
    grid.append(field(tr("事由"), typeSel));
    grid.append(field(tr("项目"), noteField("project", form.project, (v) => (form.project = v), tr("比如项目号，可不填"))));
    grid.append(field(tr("说明"), noteField("detail", form.detail, (v) => (form.detail = v), tr("补一句为什么，可不填"))));
    grid.append(field(tr("一级审批人"), leaderSelect(overtime.candidates.l1, form.l1)));
    grid.append(field(tr("二级审批人"), fixedLeaders(overtime.fixedL2, tr("由考勤系统按组织架构定，不能改")), true));
    card.append(grid);

    if (pending) {
      const preview = el("div", "at-confirm");
      preview.append(el("div", "at-confirm__title", tr("确认一下，这一步会真的提交到考勤系统：")));
      const p = pending.preview as { startTime?: string; endTime?: string; hours?: number; workflow?: string };
      preview.append(
        el("div", "at-confirm__line", tr("{p1} → {p2} · {p3} 小时", { p1: p.startTime ?? "", p2: p.endTime ?? "", p3: String(p.hours ?? "") })),
        el("div", "at-confirm__line", tr("事由：{p1}", { p1: form.project ? `${form.reasonType} / ${form.project}` : form.reasonType })),
        el("div", "at-confirm__line", tr("审批人：{p1}", { p1: approverNames() || p.workflow || "" })),
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

  /** 一格表单：wide 时占满整行（审批人这种要塞几个名字的用得上）。 */
  function field(label: string, node: HTMLElement, wide = false): HTMLElement {
    const box = el("label", "at-field");
    if (wide) box.classList.add("at-field--wide");
    box.append(el("span", "at-field__label", label));
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

  /** 可选的小输入框：带一句提示，免得人以为必须填。 */
  /** 确认框里给人看的审批人：id 换成「姓名 工号」，按一级、二级的顺序。 */
  function approverNames(): string {
    const pool = new Map<number, string>();
    for (const x of overtime?.candidates.l1 ?? []) pool.set(x.userId, `${x.name} ${x.workNo}`.trim());
    for (const x of overtime?.fixedL2 ?? []) pool.set(x.userId, `${x.name} ${x.workNo}`.trim());
    const show = (ids: string[]): string => ids.map((id) => pool.get(Number(id)) ?? "").filter(Boolean).join(tr("、"));
    return [show(form.l1), show(form.l2)].filter(Boolean).join(" → ");
  }

  function noteField(name: string, value: string, onChange: (v: string) => void, hint: string): HTMLInputElement {
    const input = text(name, value, onChange);
    input.placeholder = hint;
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

  // 一级审批人记住上次的选择：天天是同一个人，每次从头挑太烦。
  function rememberApprovers(): void {
    try {
      localStorage.setItem(L1_KEY, JSON.stringify(form.l1));
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

  function leaderSelect(list: { userId: number; name: string; workNo: string }[], chosen: string[]): HTMLElement {
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
      form.l1 = Array.from(sel.selectedOptions)
        .map((o) => o.value)
        .filter(Boolean);
      rememberApprovers();
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
        await api.attendanceOvertimeSubmit({ ...body, confirm: true });
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
    password.type = "password";
    password.className = "at-input";
    password.autocomplete = "current-password";
    password.placeholder = tr("登录态会加密存本机");
    password.value = passwordDraft;
    password.oninput = () => {
      passwordDraft = password.value;
    };

    grid.append(
      field(tr("接口地址"), apiBase),
      field(tr("网页地址"), pageBase),
      field(tr("账号"), account),
      field(tr("密码"), password),
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
        await api.attendanceLogin({ account: wantAccount, password: password.value });
        password.value = "";
        passwordDraft = "";
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
