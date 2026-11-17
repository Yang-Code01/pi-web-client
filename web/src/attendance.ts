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
import type { AttendanceState, AttendanceRecords, AttendanceOvertime } from "./sysmanage-types.ts";
// 日期 → 「周五」这件事本机管理已经做过一遍（sysmanage-model.ts:207），别再写一张中文星期表。
import { weekdayOf } from "./sysmanage-model.ts";
import { defaultRange, hoursText, reasonText, spanText, stepState } from "./attendance-shared.ts";
import "./attendance.css";

type Tab = "records" | "overtime" | "settings";

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

export interface AttendancePaneDeps {
  /** 页面被换掉时（切页 / 关面板）调它，用来丢定时器。 */
  onDispose?: (fn: () => void) => void;
}

/**
 * 画一页考勤进 `host`。返回一个 dispose：切走时调用，把正在跑的请求和定时器丢掉。
 * 重复调用会先把上一次的内容清空。
 */
export function paintAttendance(host: HTMLElement): () => void {
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
  let pending: { preview: Record<string, unknown>; body: Record<string, unknown> } | null = null;
  let opened: string | null = null;
  /** 撤回要点两次：第一次记在这儿，第二次才真发。 */
  let cancelPending: number | null = null;

  const form: OvertimeForm = {
    start: "",
    end: "",
    hours: "2",
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
      if (form.l1.length === 0 && overtime.candidates.l1.length === 1) form.l1 = [String(overtime.candidates.l1[0]!.userId)];
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
    if (!state.configured) {
      root.append(paintUnconfigured());
      return;
    }
    if (tab === "records") root.append(paintRecords());
    else if (tab === "overtime") root.append(paintOvertime());
    else root.append(paintSettings());
  }

  function paintBar(): HTMLElement {
    const bar = el("div", "at-bar");
    const tabs = el("div", "at-tabs");
    const items: [Tab, string][] = [
      ["records", tr("考勤记录")],
      ["overtime", tr("加班申请")],
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
        el("span", "at-chip", tr("加班 {p1} 小时").replace("{p1}", String(s.overtime))),
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
    for (const label of [tr("日期"), tr("上班"), tr("下班"), tr("加班"), tr("备注")]) {
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
        el("td", "", row.overtime ? String(row.overtime) : ""),
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

  function noteOf(row: AttendanceRecords["rows"][number]): string {
    const parts: string[] = [];
    if (row.weekend) parts.push(tr("周末"));
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
    grid.append(field(tr("开始"), datetime("start", form.start, (v) => (form.start = v))));
    grid.append(field(tr("结束"), datetime("end", form.end, (v) => (form.end = v))));
    const hours = document.createElement("input");
    hours.type = "number";
    hours.min = "0.5";
    hours.step = "0.5";
    hours.className = "at-input";
    hours.value = form.hours;
    hours.oninput = () => (form.hours = hours.value);
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
    grid.append(field(tr("项目"), text("project", form.project, (v) => (form.project = v))));
    grid.append(field(tr("说明"), text("detail", form.detail, (v) => (form.detail = v))));
    grid.append(field(tr("一级审批人"), leaderSelect(overtime.candidates.l1, form.l1, false)));
    grid.append(field(tr("二级审批人"), leaderSelect(overtime.candidates.l2, form.l2, true)));
    card.append(grid);

    if (pending) {
      const preview = el("div", "at-confirm");
      preview.append(el("div", "at-confirm__title", tr("确认一下，这一步会真的提交到考勤系统：")));
      const p = pending.preview as { startTime?: string; endTime?: string; hours?: number; workflow?: string };
      preview.append(
        el("div", "at-confirm__line", tr("{p1} → {p2} · {p3} 小时", { p1: p.startTime ?? "", p2: p.endTime ?? "", p3: String(p.hours ?? "") })),
        el("div", "at-confirm__line", tr("事由：{p1}", { p1: form.project ? `${form.reasonType} / ${form.project}` : form.reasonType })),
        el("div", "at-confirm__line", tr("审批人：{p1}", { p1: p.workflow ?? "" })),
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
        const state_ = statusOf(overtime.workflow[String(app.code)] as unknown, app.workflow_result);
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

  function statusOf(chain: unknown, result: number): { text: string; tone: "ok" | "bad" } {
    const state_ = stepState(chain, result);
    if (state_.kind === "ended") return { text: tr("已结束"), tone: "ok" };
    if (state_.kind === "pending") return { text: tr("待{p1}审批", { p1: state_.role }), tone: "ok" };
    return { text: tr("审批中"), tone: "ok" };
  }

  function field(label: string, node: HTMLElement): HTMLElement {
    const box = el("label", "at-field");
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

  function datetime(name: string, value: string, onChange: (v: string) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "datetime-local";
    input.className = "at-input";
    input.dataset.field = name;
    input.value = value;
    input.onchange = () => onChange(input.value);
    return input;
  }

  function leaderSelect(list: { userId: number; name: string; workNo: string }[], chosen: string[], multi: boolean): HTMLElement {
    const wrap = el("div", "at-leaders");
    if (list.length === 0) {
      wrap.append(el("span", "at-hint", tr("没有候选")));
      return wrap;
    }
    const sel = document.createElement("select");
    sel.className = "at-input";
    if (multi) sel.multiple = true;
    for (const p of list) {
      const opt = document.createElement("option");
      opt.value = String(p.userId);
      opt.textContent = p.workNo ? `${p.name} ${p.workNo}` : p.name;
      if (chosen.includes(opt.value)) opt.selected = true;
      sel.append(opt);
    }
    sel.dataset.role = multi ? "l2" : "l1";
    sel.onchange = () => {
      const picked = Array.from(sel.selectedOptions).map((o) => o.value);
      if (multi) form.l2 = picked;
      else form.l1 = picked;
    };
    wrap.append(sel);
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

  function paintSettings(): HTMLElement {
    const wrap = el("div", "at-section");
    const card = el("div", "at-card");
    card.append(el("h3", "at-card__title", tr("考勤系统")));
    const grid = el("div", "at-grid");

    const apiBase = text("apiBase", state?.apiBase ?? "", () => {});
    apiBase.placeholder = "https://attendance.example.com:8085";
    const pageBase = text("pageBase", state?.pageBase ?? "", () => {});
    pageBase.placeholder = "https://attendance.example.com";
    const account = text("account", "", () => {});
    account.placeholder = state?.account || tr("工号或邮箱");
    const password = document.createElement("input");
    password.type = "password";
    password.className = "at-input";
    password.autocomplete = "current-password";
    password.placeholder = tr("只用来换登录态，加密存在本机");

    grid.append(
      field(tr("接口地址"), apiBase),
      field(tr("网页地址"), pageBase),
      field(tr("账号"), account),
      field(tr("密码"), password),
    );
    card.append(grid);

    const actions = el("div", "at-actions");
    const save = el("button", "btn", tr("保存配置"));
    save.type = "button";
    save.onclick = async () => {
      try {
        await api.attendanceSaveConfig({
          apiBase: apiBase.value.trim(),
          pageBase: pageBase.value.trim(),
          account: account.value.trim() || state?.account || "",
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
        await api.attendanceLogin({ account: account.value.trim() || state?.account || "", password: password.value });
        password.value = "";
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

  return () => {
    disposed = true;
    root.remove();
  };
}
