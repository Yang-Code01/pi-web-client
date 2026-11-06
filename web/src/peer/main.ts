import { applyLang, bootLang, fmtDate, fmtRelative, fmtTime, tr } from "../i18n/index.ts";

/**
 * `peer.html` 的脚本：只跟 bridge 说话（cookie + `/api/peer*`），从不直接连 7865。
 *
 * 页面分四页（消息 / 联系人 / 传输 / 我），布局按**容器宽度**切：宽的时候是
 * 「轨道 + 列表 + 主区」三栏，窄的时候退回单栏钻取（列表 ↔ 内容）。因为整个页面
 * 既可能全屏、也可能塞在 1000px 的弹框 iframe 里，看视口宽度会判错。
 */

applyLang(bootLang());

// 塞在弹框 iframe 里时，外层已经有「内网通 / 关闭」那一行标题了，这页的顶栏就不用再写一遍名字。
if (window.self !== window.top) document.body.classList.add("embedded");

interface OnlinePeer {
  nodeId: string;
  nickname: string;
  hostname: string;
  addr: string;
  port: number;
  lastSeen: number;
  ips: string[];
}

interface PeerStatus {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  online: OnlinePeer[];
  config: { hidden: boolean; pauseFiles: boolean; dnd: boolean; inbox: string; manual: string[] };
}

interface PeerView {
  enabled: boolean;
  running: boolean;
  reason: string;
  status: PeerStatus | null;
}

interface Entry {
  id: string;
  at: number;
  from: { nodeId: string; nickname?: string; hostname?: string; port?: number };
  to: { kind: "node" | "group"; id: string };
  kind: "text" | "receipt" | "file";
  text?: string;
  ack?: { id: string; status: "delivered" | "failed"; error?: string };
  file?: { name: string; size: number; mime: string; sha256?: string };
  via?: "pi";
}

interface Thread {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  last: Entry | null;
  count: number;
  online: boolean;
}

interface Contact {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  friend: boolean;
  favorite: boolean;
  incoming: boolean;
  outgoing: boolean;
  at: number;
  online: boolean;
  addr: string;
  livePort: number;
}

interface Transfer {
  id: string;
  peerId: string;
  direction: "out" | "in";
  name: string;
  size: number;
  bytes: number;
  status: "sending" | "receiving" | "done" | "failed";
  error?: string;
}

interface BrowseEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

interface Browse {
  path: string;
  parent: string | null;
  roots: { name: string; path: string }[];
  places: { name: string; path: string }[];
  entries: BrowseEntry[];
}

type Page = "msg" | "contacts" | "transfers" | "me";

const MAX_TEXT_BYTES = 32 * 1024;
const NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------- 图标

/** 单色线性图标。每条 icon 是若干 `d`（24×24、stroke=currentColor）。 */
const ICONS: Record<string, string[]> = {
  msg: ["M20.5 11.6c0 3.9-3.8 7.1-8.5 7.1-1 0-2-.15-2.9-.42L4 20l1.4-3.6C4.2 15.2 3.5 13.5 3.5 11.6 3.5 7.7 7.3 4.5 12 4.5s8.5 3.2 8.5 7.1Z"],
  contacts: ["M4 20v-1.6A5.4 5.4 0 0 1 9.4 13h1.2A5.4 5.4 0 0 1 16 18.4V20", "M11 3.5a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8Z", "M17 8.2a2.6 2.6 0 1 1 0 5.2", "M18 13.4c2 .5 3 1.8 3 3.6V20"],
  transfers: ["M7 4v12", "M7 16l-3-3", "M7 16l3-3", "M17 20V8", "M17 8l-3 3", "M17 8l3 3"],
  me: ["M12 3.5a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2Z", "M4.5 20v-1.4A6 6 0 0 1 10.5 12.6h3A6 6 0 0 1 19.5 18.6V20"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "M16.2 16.2 21 21"],
  plus: ["M12 5v14", "M5 12h14"],
  send: ["M4.5 12 20.5 4l-6.4 16.2-2.6-6.4L4.5 12Z"],
  attach: ["M20 11.5 12.4 19a4.6 4.6 0 0 1-6.5-6.5l8-8a3.1 3.1 0 0 1 4.4 4.4l-8 8a1.6 1.6 0 0 1-2.2-2.2l7-7"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  back: ["M15 5l-7 7 7 7"],
  more: ["M5.5 12h.01", "M12 12h.01", "M18.5 12h.01"],
  star: ["M12 4.2l2.3 4.9 5.2.7-3.8 3.6.9 5.3L12 16.2l-4.6 2.5.9-5.3L4.5 9.8l5.2-.7z"],
  file: ["M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z", "M14 3.5V8h4.5"],
  folder: ["M3.5 8a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"],
  retry: ["M20 12a8 8 0 1 1-2.4-5.7", "M20 4v5h-5"],
  check: ["M5 13l4.5 4L19 7"],
  alert: ["M12 8.5v4.5", "M12 16.4h.01", "M12 3.6 21 20H3z"],
  eyeOff: ["M3 3l18 18", "M10.6 6.3A9.6 9.6 0 0 1 12 6.2c5 0 8 5.8 8 5.8a14 14 0 0 1-2.4 3.3", "M6.4 7.2C3.9 9 3 12 3 12s3 5.8 9 5.8c1.1 0 2.1-.2 3-.5"],
  bellOff: ["M6.2 8.5A6 6 0 0 1 18 10.5V14", "M6 14v3h12", "M4 20l16-16", "M10 20a2 2 0 0 0 4 0"],
  copy: ["M9 9h10v10H9z", "M15 5.5H5.5V15"],
  trash: ["M4.5 7h15", "M9.5 7V5h5v2", "M6.5 7l.9 13h9.2l.9-13"],
  userPlus: ["M10 4a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z", "M3.5 20v-1.5A5.5 5.5 0 0 1 9 13h2", "M17.5 13.5v6", "M14.5 16.5h6"],
  refresh: ["M20 11a8 8 0 1 0-1.2 5.2", "M20 4.5V11h-6.5"],
  monitor: ["M4 5.5h16v10H4z", "M9 20h6", "M12 15.5V20"],
  disk: ["M4 6.5h16v11H4z", "M7 6.5V4h10v2.5", "M8 12h8"],
  image: ["M4 5.5h16v13H4z", "M4 15l4.5-4 3.5 3 3-2.5 5 4", "M9 9.2h.01"],
};

function ic(name: string, cls = ""): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

// ---------------------------------------------------------------- 状态

const S = {
  page: "msg" as Page,
  thread: null as string | null,
  contact: null as string | null,
  transfer: null as string | null,
  query: "",
  mview: "list" as "list" | "chat",
  view: null as PeerView | null,
  threads: [] as Thread[],
  contacts: [] as Contact[],
  transfers: [] as Transfer[],
  free: 0,
  msgs: [] as Entry[],
  msgsFor: "" as string,
  sending: false,
};

const app = document.querySelector("#app") as HTMLElement;
const barEl = document.querySelector("#bar") as HTMLElement;
const hintEl = document.querySelector("#hint") as HTMLElement;
const railEl = document.querySelector("#rail") as HTMLElement;
const listEl = document.querySelector("#list") as HTMLElement;
const mainEl = document.querySelector("#main") as HTMLElement;
const mobEl = document.querySelector("#mobnav") as HTMLElement;
const layerEl = document.querySelector("#layer") as HTMLElement;
const toastEl = document.querySelector("#toast") as HTMLElement;
const picker = document.querySelector("#picker") as HTMLElement;
const crumbsEl = document.querySelector("#crumbs") as HTMLElement;
const placesEl = document.querySelector("#places") as HTMLUListElement;
const rootsEl = document.querySelector("#roots") as HTMLUListElement;
const filesEl = document.querySelector("#files") as HTMLUListElement;
const pickerSel = document.querySelector("#picker-sel") as HTMLElement;
const pickerUp = document.querySelector("#picker-up") as HTMLButtonElement;
const pickerSendBtn = document.querySelector("#picker-send") as HTMLButtonElement;
const pickerClose = document.querySelector("#picker-close") as HTMLButtonElement;

let pickerDir = "";
let pickerParent: string | null = null;
let picked: BrowseEntry | null = null;
let composeEl: HTMLElement | null = null;
let composeFor = "";
/** 消息列重画前的滚动位置：贴着底就继续贴底，翻历史就停在原处。 */
let stickBottom = true;
let prevScroll = 0;
let textInput: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;

// ---------------------------------------------------------------- 小工具

const byteLen = (text: string): number => new TextEncoder().encode(text).length;

/** 时间/相对时间统一走 i18n 的 fmt*：手写 toLocale* 会脱离当前语言（docs/I18N.md）。 */
function ago(ts: number): string {
  return fmtRelative(ts);
}

function clock(ts: number): string {
  return fmtTime(ts);
}

function dayLabel(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();
  if (same(d, now)) return tr("今天");
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (same(d, y)) return tr("昨天");
  return fmtDate(ts);
}

function sizeOf(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function percentOf(t: Transfer): number {
  return t.size ? Math.min(100, Math.round((t.bytes / t.size) * 100)) : 100;
}

function speed(bytes: number): string {
  return `${sizeOf(bytes)}/s`;
}

/**
 * 传输速率：`/transfers` 只给累计字节和状态，没有速率字段，所以自己采样求差。
 * 每渲染一次更新一次样本（1.2 秒一轮），样本太旧（换了状态 / 停了很久）就报 `—`。
 */
const rateSamples = new Map<string, { bytes: number; at: number }>();

function speedOf(t: Transfer): string {
  const now = Date.now();
  const running = t.status === "sending" || t.status === "receiving";
  const prev = rateSamples.get(t.id);
  rateSamples.set(t.id, { bytes: t.bytes, at: now });
  if (!running) return "";
  if (!prev || now - prev.at < 200 || now - prev.at > 10_000) return "—";
  const perSec = Math.max(0, (t.bytes - prev.bytes) / ((now - prev.at) / 1000));
  return perSec < 1 ? "—" : speed(perSec);
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function iconBtn(name: string, title: string, act: (ev: MouseEvent) => void): HTMLButtonElement {
  const b = h("button", "icon-btn");
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(ic(name));
  b.addEventListener("click", act);
  return b;
}

/** 头像：首字母 + 由 nodeId 算出来的稳定色相（同一个人每次都是同一个颜色）。 */
function hueOf(key: string): number {
  let x = 2166136261 >>> 0;
  for (const ch of key) {
    x ^= ch.codePointAt(0) ?? 0;
    x = Math.imul(x, 16777619) >>> 0;
  }
  return (x * 137) % 360;
}

function avatar(name: string, key: string, online?: boolean): HTMLElement {
  const box = h("span", "av");
  box.style.setProperty("--h", String(hueOf(key)));
  box.textContent = (name.trim()[0] ?? "?").toUpperCase();
  if (online !== undefined) {
    const dot = h("i", `st${online ? " on" : ""}`);
    box.append(dot);
  }
  return box;
}

let toastTimer = 0;

function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add("on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("on"), 1600);
}

// ---------------------------------------------------------------- 网络

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function loadStatus(): Promise<void> {
  try {
    S.view = await getJson<PeerView>("/api/peer");
  } catch {
    S.view = { enabled: false, running: false, reason: tr("拿不到状态"), status: null };
  }
  renderBar();
  renderHint();
}

async function loadThreads(): Promise<void> {
  try {
    const data = await getJson<{ threads: Thread[] }>("/api/peer/threads");
    S.threads = data.threads ?? [];
  } catch {
    S.threads = [];
  }
}

async function loadContacts(): Promise<void> {
  try {
    const data = await getJson<{ contacts: Contact[] }>("/api/peer/contacts");
    S.contacts = data.contacts ?? [];
  } catch {
    S.contacts = [];
  }
}

/** 一串消息的指纹：id + 回执状态。轮询拿回来跟上次一样就不必重画。 */
function msgSig(): string {
  return S.msgs.map((m) => `${m.id}:${m.ack?.status ?? ""}`).join("|");
}

async function loadMessages(id = S.thread): Promise<void> {
  if (!id) return;
  const data = await getJson<{ entries: Entry[] }>(`/api/peer/messages?peer=${encodeURIComponent(id)}&limit=200`).catch(() => null);
  // 拉不到就保持旧内容：一次超时不该把聊天清空
  if (!data) return;
  S.msgs = data.entries ?? [];
  S.msgsFor = id;
}

async function loadTransfers(): Promise<void> {
  const data = await getJson<{ transfers: Transfer[]; free: number }>("/api/peer/transfers").catch(() => null);
  if (!data) return;
  S.transfers = data.transfers ?? [];
  S.free = data.free ?? 0;
}

// ---------------------------------------------------------------- 骨架渲染

const PAGES: { id: Page; icon: string; label: string; color: string }[] = [
  { id: "msg", icon: "msg", label: "消息", color: "var(--c-msg)" },
  { id: "contacts", icon: "contacts", label: "联系人", color: "var(--c-contacts)" },
  { id: "transfers", icon: "transfers", label: "传输", color: "var(--c-transfers)" },
  { id: "me", icon: "me", label: "我", color: "var(--c-me)" },
];

function go(page: Page): void {
  if (S.page !== page) {
    S.page = page;
    S.query = "";
    if (page === "me") S.mview = "chat";
    else S.mview = "list";
  }
  app.dataset.page = page;
  app.dataset.mview = S.mview;
  renderAll();
}

function openThread(id: string): void {
  S.thread = id;
  S.page = "msg";
  S.mview = "chat";
  S.msgs = [];
  S.msgsFor = "";
  app.dataset.page = "msg";
  app.dataset.mview = "chat";
  renderAll();
  void loadMessages().then(() => renderMain());
}

function renderAll(): void {
  renderBar();
  renderHint();
  renderRail();
  renderList();
  renderMain();
  renderMobnav();
}

function renderBar(): void {
  const st = S.view?.status ?? null;
  const up = Boolean(S.view?.enabled && S.view?.running);
  const frag = h("div", "");
  frag.style.display = "contents";

  const brand = h("div", "brand");
  const dot = h("span", `dot ${up ? "up" : "down"}`);
  dot.title = up ? tr("内网通在运行") : S.view?.reason || tr("内网通没在运行");
  brand.append(dot, h("span", "nm", tr("内网通")));

  const meta = h("div", "meta");
  meta.textContent = st ? `${st.nickname} · ${st.nodeId.slice(0, 8)} · :${st.port}` : "";

  const spacer = h("div", "spacer");

  const flags = h("div", "meta");
  if (st) {
    const on: string[] = [];
    if (st.config.hidden) on.push(tr("隐身"));
    if (st.config.dnd) on.push(tr("免打扰"));
    if (st.config.pauseFiles) on.push(tr("暂停收文件"));
    flags.textContent = on.join(" · ");
  }

  frag.append(brand, meta, spacer, flags);
  if (window.self === window.top) {
    const back = h("a", "btn", tr("‹ 回 pi"));
    back.href = "/";
    back.title = tr("回到 pi 主页面");
    frag.append(back);
  }
  barEl.replaceChildren(frag);
}

/** 顶栏左侧的状态点已经说明了 up/down；这里不再重复第二个点。 */
function renderHint(): void {
  const st = S.view?.status ?? null;
  const up = Boolean(S.view?.enabled && S.view?.running);
  hintEl.replaceChildren();
  if (up && !st?.config.hidden && !st?.config.dnd) {
    hintEl.classList.remove("on");
    return;
  }
  hintEl.classList.add("on");
  if (!up) {
    hintEl.append(ic("alert"), h("span", "grow", S.view?.enabled ? S.view.reason || tr("内网通正在启动") : tr("内网通没在运行（PI_PEER=0 或者还没构建）")));
    const retry = h("button", "btn", tr("重试"));
    retry.type = "button";
    retry.addEventListener("click", () => void refreshAll());
    hintEl.append(retry);
    return;
  }
  const bits: string[] = [];
  if (st?.config.hidden) bits.push(tr("隐身中：别人看不到你，你也看不到新的人"));
  if (st?.config.dnd) bits.push(tr("免打扰：新消息不提醒"));
  hintEl.append(ic("eyeOff"), h("span", "grow", bits.join(" · ")));
  const off = h("button", "btn", tr("去改"));
  off.type = "button";
  off.addEventListener("click", () => go("me"));
  hintEl.append(off);
}

function renderRail(): void {
  railEl.replaceChildren();
  for (const p of PAGES) {
    const b = h("button", S.page === p.id ? "on" : "");
    b.type = "button";
    b.title = tr(p.label);
    b.setAttribute("aria-label", tr(p.label));
    b.style.setProperty("--c", p.color);
    b.append(ic(p.icon), h("span", "tag", tr(p.label)));
    b.addEventListener("click", () => go(p.id));
    railEl.append(b);
  }
}

function renderMobnav(): void {
  mobEl.replaceChildren();
  for (const p of PAGES) {
    const b = h("button", S.page === p.id ? "on" : "");
    b.type = "button";
    b.style.setProperty("--c", p.color);
    b.append(ic(p.icon), h("span", "", tr(p.label)));
    b.addEventListener("click", () => go(p.id));
    mobEl.append(b);
  }
}

function searchBox(placeholder: string): HTMLElement {
  const box = h("div", "search");
  const input = h("input");
  input.type = "search";
  input.placeholder = placeholder;
  input.value = S.query;
  input.dataset.keep = "search";
  input.addEventListener("input", () => {
    S.query = input.value;
    renderList();
  });
  box.append(ic("search"), input);
  return box;
}

/**
 * 整块重画会把正在输入的输入框一起换掉（焦点、光标、选区全没）。
 * 重画前记住「哪个带 data-keep 的元素拿着焦点」，重画后把焦点与选区还回去。
 */
function rerender(rebuild: () => void): void {
  const active = document.activeElement;
  const keep = active instanceof HTMLElement ? active.dataset.keep : undefined;
  const sel =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? ([active.selectionStart, active.selectionEnd] as const)
      : null;
  rebuild();
  if (!keep) return;
  const next = document.querySelector<HTMLElement>(`[data-keep="${keep}"]`);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (sel && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
    const end = next.value.length;
    const at = (n: number | null): number => Math.min(n ?? end, end);
    try {
      next.setSelectionRange(at(sel[0]), at(sel[1]));
    } catch {
      /* search/number 这类 input 不支持选区，焦点回来就够了 */
    }
  }
}

function renderList(): void {
  rerender(paintList);
}

function paintList(): void {
  listEl.replaceChildren();
  // 我页没有列表：整块宽度让给右侧。光把 list 隐藏不够 —— 网格会自动补位，main 会被挤到第二列。
  const noList = S.page === "me";
  app.dataset.nolist = noList ? "1" : "0";
  listEl.style.display = noList ? "none" : "";
  if (noList) return;
  if (S.page === "msg") return renderThreadList();
  if (S.page === "contacts") return renderContactList();
  return renderTransferList();
}

function matches(...texts: (string | undefined)[]): boolean {
  const q = S.query.trim().toLowerCase();
  if (!q) return true;
  return texts.some((t) => (t ?? "").toLowerCase().includes(q));
}

function preview(t: Thread): string {
  const e = t.last;
  if (!e) return tr("还没有消息");
  if (e.kind === "receipt") return tr("已送达");
  if (e.kind === "file") return tr("[文件] {p1}", { p1: e.file?.name ?? "" });
  return e.text ?? "";
}

function renderThreadList(): void {
  listEl.append(searchBox(tr("搜索会话")));
  const box = h("div", "listbox");
  const rows = S.threads.filter((t) => matches(t.nickname, t.hostname));
  if (!rows.length) {
    box.append(
      emptyState(
        "msg",
        S.query ? tr("没有匹配的会话") : tr("还没有对话"),
        S.query ? tr("换个名字试试") : tr("从左边的联系人里选一个人开始聊"),
      ),
    );
  }
  for (const t of rows) {
    const row = h("div", `row${S.thread === t.nodeId ? " on" : ""}`);
    row.append(avatar(t.nickname, t.nodeId, t.online));
    const tbox = h("div", "t");
    const name = h("div", "n");
    name.append(h("span", "nm", t.nickname));
    if (t.last?.via === "pi") name.append(h("span", "pill pi", "pi"));
    const sub = h("div", "s");
    sub.append(h("span", "", preview(t)));
    tbox.append(name, sub);
    const right = h("div", "r");
    right.append(h("span", "tm", t.last ? ago(t.last.at) : ""));
    row.append(tbox, right);
    row.addEventListener("click", () => openThread(t.nodeId));
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      threadMenu(ev.clientX, ev.clientY, t);
    });
    box.append(row);
  }
  listEl.append(box);
}

interface Group {
  title: string;
  items: Contact[];
}

function contactGroups(): Group[] {
  // 一个人只出现在一组里：收藏优先，跟“好友·在线”重复会把同一行画两遍。
  const used = new Set<string>();
  const take = (list: Contact[]): Contact[] => {
    const out: Contact[] = [];
    for (const c of list) {
      if (used.has(c.nodeId)) continue;
      used.add(c.nodeId);
      out.push(c);
    }
    return out;
  };
  const pending = take(S.contacts.filter((c) => c.incoming && !c.friend));
  const online = take(S.contacts.filter((c) => c.friend && c.online));
  const offline = take(S.contacts.filter((c) => c.friend && !c.online));
  const nearby = take(S.contacts.filter((c) => !c.friend && !c.incoming));
  // 收藏不再单独成组：同一个人会同时出现在「收藏」和「好友·在线」，看着像两个人。
  // 改成收藏的排到组内最前（行上已有 ★），组本身不留空壳。
  const favFirst = (list: Contact[]): Contact[] =>
    list.slice().sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.nickname.localeCompare(b.nickname));
  const groups: Group[] = [];
  if (pending.length) groups.push({ title: tr("待处理"), items: favFirst(pending) });
  groups.push({ title: tr("好友 · 在线"), items: favFirst(online) });
  groups.push({ title: tr("好友 · 离线"), items: favFirst(offline) });
  if (nearby.length) groups.push({ title: tr("附近的人"), items: favFirst(nearby) });
  return groups.filter((g) => g.items.length > 0 || g.title.startsWith(tr("好友")));
}

function renderContactList(): void {
  const bar = h("div", "listbar");
  bar.append(searchBox(tr("搜索联系人")));
  const add = iconBtn("plus", tr("添加联系人"), () => addModal());
  bar.append(add);
  listEl.append(bar);

  const box = h("div", "listbox");
  const groups = contactGroups().map((g) => ({
    ...g,
    items: g.items.filter((c) => matches(c.nickname, c.hostname, c.addr)),
  }));
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) {
    box.append(
      emptyState(
        "contacts",
        S.query ? tr("没有匹配的联系人") : tr("还没有联系人"),
        S.query ? tr("换个名字试试") : tr("点右上角的「+」加一个地址，或者等同网的人打开 pi"),
      ),
    );
  }
  for (const g of groups) {
    if (!g.items.length) continue;
    const title = h("div", "group-title", g.title);
    title.append(h("span", "n", String(g.items.length)));
    box.append(title);
    for (const c of g.items) {
      const row = h("div", `row${S.contact === c.nodeId ? " on" : ""}`);
      row.append(avatar(c.nickname, c.nodeId, c.online));
      const t = h("div", "t");
      const name = h("div", "n");
      name.append(h("span", "nm", c.nickname));
      if (c.favorite) {
        const star = ic("star", "ic");
        star.style.color = "var(--warn)";
        star.style.width = "11px";
        star.style.height = "11px";
        name.append(star);
      }
      const sub = h("div", "s");
      sub.append(h("span", "", c.online ? (c.hostname || c.addr) + " · " + tr("在线") : tr("离线")));
      t.append(name, sub);
      const right = h("div", "r");
      if (c.incoming && !c.friend) right.append(h("span", "pill", tr("待处理")));
      row.append(t, right);
      row.addEventListener("click", () => {
        S.contact = c.nodeId;
        S.mview = "chat";
        app.dataset.mview = "chat";
        renderAll();
      });
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        contactMenu(ev.clientX, ev.clientY, c);
      });
      box.append(row);
    }
  }
  listEl.append(box);
}

function renderTransferList(): void {
  const box = h("div", "listbox");
  const live = S.transfers.filter((t) => t.status === "sending" || t.status === "receiving");
  const done = S.transfers.filter((t) => t.status !== "sending" && t.status !== "receiving");
  if (!S.transfers.length) {
    box.append(emptyState("transfers", tr("还没有传输"), tr("在聊天里点「+」或者把文件拖进窗口，都会从这儿走")));
  }
  if (live.length) {
    box.append(h("div", "group-title", tr("进行中")));
    for (const t of live) box.append(transferRow(t));
  }
  if (done.length) {
    box.append(h("div", "group-title", tr("最近")));
    for (const t of done) box.append(transferRow(t));
  }
  listEl.append(box);
}

function transferRow(t: Transfer): HTMLElement {
  const row = h("div", `trow${S.transfer === t.id ? " on" : ""}`);
  const box = h("div", "ic");
  box.append(ic(/^image\//.test(mimeOf(t.name)) ? "image" : "file"));
  const mid = h("div");
  const pct = percentOf(t);
  mid.append(
    h("div", "nm", t.name),
    h("div", "s", (t.direction === "out" ? tr("发出") : tr("接收")) + " · " + sizeOf(t.size)),
  );
  const right = h("div", "pct");
  if (t.status === "failed") right.append(h("span", "bad", tr("失败")));
  else if (t.status === "done") right.append(h("span", "ok", tr("完成")));
  else right.append(h("b", "", `${pct}%`), h("span", "", speedOf(t)));
  row.append(box, mid, right);
  row.addEventListener("click", () => {
    S.transfer = t.id;
    S.mview = "chat";
    app.dataset.mview = "chat";
    renderAll();
  });
  return row;
}

function mimeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image/" + ext;
  return "application/octet-stream";
}

function emptyState(icon: string, title: string, sub: string): HTMLElement {
  const box = h("div", "empty");
  box.append(ic(icon, ""), h("div", "t", title), h("div", "s", sub));
  return box;
}

// ---------------------------------------------------------------- 主区

function renderMain(): void {
  // 重新画聊天会把消息列清空重排，滚到哪儿要自己记住：翻历史的时侯别把人拽回底。
  const prev = mainEl.querySelector<HTMLElement>(".stream");
  if (prev) {
    stickBottom = prev.scrollTop + prev.clientHeight >= prev.scrollHeight - 32;
    prevScroll = prev.scrollTop;
  }
  rerender(paintMain);
}

function paintMain(): void {
  mainEl.replaceChildren();
  if (S.page === "msg") {
    renderChat();
    return;
  }
  if (S.page === "contacts") {
    renderContactDetail();
    return;
  }
  if (S.page === "transfers") {
    renderTransferDetail();
    return;
  }
  renderMe();
}

function backBtn(): HTMLButtonElement {
  const b = iconBtn("back", tr("返回列表"), () => {
    S.mview = "list";
    app.dataset.mview = "list";
    renderAll();
  });
  b.classList.add("back-btn");
  return b;
}

function renderChat(): void {
  const t = S.threads.find((x) => x.nodeId === S.thread);
  if (!t) {
    mainEl.append(
      emptyState("msg", tr("选一个会话"), tr("左边挑一个人；还没有人就在「联系人」里加一个地址")),
    );
    return;
  }
  const head = h("div", "head");
  head.append(backBtn(), avatar(t.nickname, t.nodeId, t.online));
  const title = h("div", "t");
  const name = h("div", "n");
  name.append(h("span", "nm", t.nickname));
  const sub = h("div", "s", t.online ? tr("在线") + " · " + (t.hostname || "") : tr("离线"));
  title.append(name, sub);
  head.append(title, h("div", "grow"));
  const tools = h("div", "tools");
  tools.append(
    iconBtn("attach", tr("发文件"), () => void openPicker(t.nodeId)),
    iconBtn("more", tr("更多"), (ev) => {
      const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      threadMenu(box.left, box.bottom + 6, t);
    }),
  );
  head.append(tools);
  mainEl.append(head);

  const stream = h("div", "stream");
  let lastDay = "";
  for (const e of S.msgs) {
    if (e.kind === "receipt") continue;
    const day = dayLabel(e.at);
    if (day !== lastDay) {
      stream.append(h("div", "day", day));
      lastDay = day;
    }
    stream.append(entryNode(e, t));
  }
  if (!S.msgs.length) {
    stream.append(h("div", "empty", tr("还没有消息，说点什么吧")));
  }
  mainEl.append(stream);
  stream.scrollTop = stickBottom ? stream.scrollHeight : prevScroll;

  const compose = composeBox(t);
  mainEl.append(compose);
}

function entryNode(e: Entry, t: Thread): HTMLElement {
  const mine = e.from.nodeId === S.view?.status?.nodeId;
  const msg = h("div", `msg${mine ? " mine" : ""}`);
  msg.append(avatar(mine ? (S.view?.status?.nickname ?? tr("我")) : t.nickname, e.from.nodeId));
  const box = h("div", "b");
  if (e.kind === "file" && e.file) {
    box.append(fileCard(e, mine));
  } else {
    const bub = h("div", "bub", e.text ?? "");
    bub.title = tr("点击复制");
    bub.addEventListener("click", () => void copyText(e.text ?? ""));
    box.append(bub);
  }
  const meta = h("div", "tm");
  if (e.via === "pi") meta.append(h("span", "pill pi", tr("pi 代发")));
  meta.append(h("span", "", clock(e.at)));
  if (mine && e.ack) {
    if (e.ack.status === "delivered") {
      const ok = ic("check", "ok");
      meta.append(ok, h("span", "ok", tr("已送达")));
    } else {
      const bad = ic("alert", "bad");
      meta.append(bad, h("span", "bad", tr("发送失败")));
      const retry = h("button", "link", tr("重试"));
      retry.addEventListener("click", () => void resend(e));
      meta.append(retry);
    }
  }
  box.append(meta);
  msg.append(box);
  return msg;
}

function fileCard(e: Entry, mine: boolean): HTMLElement {
  const f = e.file!;
  const card = h("div", "fcard");
  const icon = h("div", "ic");
  icon.append(ic(/^image\//.test(f.mime) ? "image" : "file"));
  const body = h("div");
  body.append(h("div", "nm", f.name), h("div", "sz", sizeOf(f.size)));
  const status = mine ? e.ack : undefined;
  if (status) {
    const foot = h("div", "fbot");
    foot.append(
      h("span", "", status.status === "delivered" ? tr("已送达") : tr("发送失败")),
      h("span", "act", status.status === "delivered" ? tr("打开") : tr("重试")),
    );
    body.append(foot);
    card.addEventListener("click", () => {
      if (status.status === "failed") void resend(e);
      else toast(tr("文件已经在你自己的盘上"));
    });
  } else {
    const foot = h("div", "fbot");
    const act = h("a", "act", tr("另存 / 打开"));
    act.href = `/api/peer/file?id=${encodeURIComponent(e.id)}`;
    act.target = "_blank";
    act.rel = "noopener";
    act.addEventListener("click", (ev) => ev.stopPropagation());
    foot.append(h("span", "", tr("对方发来")), act);
    body.append(foot);
  }
  card.append(icon, body);
  return card;
}

function composeBox(t: Thread): HTMLElement {
  if (composeEl && composeFor === t.nodeId) {
    (composeEl.querySelector(".hintline") as HTMLElement | null)?.replaceChildren();
    return composeEl;
  }
  composeFor = t.nodeId;
  const wrap = h("div", "compose");
  const box = h("div", "box");
  const ta = h("textarea");
  ta.placeholder = tr("发给 {p1}", { p1: t.nickname });
  ta.rows = 2;
  ta.dataset.keep = "compose";
  ta.autocomplete = "off";
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void send();
    }
  });
  const bar2 = h("div", "bar2");
  const attach = iconBtn("attach", tr("发文件"), () => void openPicker(t.nodeId));
  const hint = h("span", "hintline", tr("Enter 发送，Shift+Enter 换行；拖文件或粘贴截图也行"));
  const btn = h("button", "send", tr("发送"));
  btn.type = "button";
  btn.addEventListener("click", () => void send());
  bar2.append(attach, hint, btn);
  box.append(ta, bar2);
  wrap.append(box);
  textInput = ta;
  sendBtn = btn;
  composeEl = wrap;

  wrap.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    box.style.borderColor = "var(--accent-dim)";
  });
  wrap.addEventListener("dragleave", () => {
    box.style.borderColor = "";
  });
  wrap.addEventListener("drop", (ev) => {
    ev.preventDefault();
    box.style.borderColor = "";
    const f = ev.dataTransfer?.files?.[0];
    if (f) void uploadBlob(f.name, f);
  });
  ta.addEventListener("paste", (ev) => {
    const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.kind === "file");
    if (!item) return;
    const f = item.getAsFile();
    if (!f) return;
    ev.preventDefault();
    void uploadBlob(tr("截图 {p1}.png", { p1: new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(/:/g, "-") }), f);
  });
  return wrap;
}

// ---------------------------------------------------------------- 发送

async function send(): Promise<void> {
  const id = S.thread;
  const ta = textInput;
  if (!id || !ta || S.sending) return;
  const text = ta.value.replace(/\s+$/, "");
  if (!text) return;
  if (byteLen(text) > MAX_TEXT_BYTES) return toast(tr("太长了（上限 32 KB）"));
  S.sending = true;
  if (sendBtn) sendBtn.disabled = true;
  try {
    await postJson("/api/peer/send", { peer: id, text });
    ta.value = "";
    await loadMessages(id);
    await loadThreads();
    renderAll();
  } catch (err) {
    toast((err as Error).message);
  } finally {
    S.sending = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

async function resend(e: Entry): Promise<void> {
  if (!S.thread) return;
  try {
    if (e.kind === "text" && e.text) await postJson("/api/peer/send", { peer: S.thread, text: e.text });
    else toast(tr("文件重发请从磁盘再选一次"));
    await loadMessages();
    renderMain();
  } catch (err) {
    toast((err as Error).message);
  }
}

async function sendPath(path: string, name?: string): Promise<void> {
  if (!S.thread) return;
  try {
    await postJson("/api/peer/sendfile", name ? { peer: S.thread, path, name } : { peer: S.thread, path });
    closePicker();
    await loadMessages();
    renderMain();
  } catch (err) {
    toast((err as Error).message);
  }
}

async function uploadBlob(name: string, blob: Blob): Promise<void> {
  if (!S.thread) return;
  if (blob.size > 64 * 1024 * 1024) return toast(tr("「{p1}」太大（上限 64 MB），用「+」从磁盘选", { p1: name }));
  try {
    const res = await fetch(`/api/peer/upload?peer=${encodeURIComponent(S.thread)}&name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: blob,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    await loadMessages();
    renderMain();
  } catch (err) {
    toast((err as Error).message);
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(tr("已复制"));
  } catch {
    toast(tr("复制不了，手动选吧"));
  }
}

// ---------------------------------------------------------------- 联系人详情

function contactOf(id: string | null): Contact | undefined {
  return S.contacts.find((c) => c.nodeId === id);
}

function renderContactDetail(): void {
  const c = contactOf(S.contact);
  if (!c) {
    mainEl.append(emptyState("contacts", tr("选一个联系人"), tr("左边挑一个人，资料和操作都在这儿")));
    return;
  }
  const head = h("div", "head");
  head.append(backBtn(), h("div", "t", tr("联系人")));
  mainEl.append(head);

  const detail = h("div", "detail");
  const hero = h("div", "hero");
  hero.append(avatar(c.nickname, c.nodeId, c.online));
  const t = h("div", "t");
  const name = h("div", "n", c.nickname);
  if (c.favorite) {
    const star = ic("star", "ic");
    star.style.color = "var(--warn)";
    star.style.width = "13px";
    star.style.height = "13px";
    name.append(star);
  }
  const sub = h("div", "sub", c.online ? tr("在线") + " · " + (c.hostname || c.addr) : tr("离线"));
  t.append(name, sub);
  hero.append(t);
  detail.append(hero);

  const acts = h("div", "acts");
  const talk = h("button", "btn pri", tr("发消息"));
  talk.type = "button";
  talk.addEventListener("click", () => openThread(c.nodeId));
  acts.append(talk);

  if (c.friend) {
    const file = h("button", "btn", tr("传文件"));
    file.type = "button";
    file.addEventListener("click", () => void openPicker(c.nodeId, true));
    acts.append(file);
  }
  if (c.incoming && !c.friend) {
    const ok = h("button", "btn pri", tr("接受"));
    ok.type = "button";
    ok.addEventListener("click", () => void friendAction(c.nodeId, "accept", true));
    const no = h("button", "btn", tr("忽略"));
    no.type = "button";
    no.addEventListener("click", () => void friendAction(c.nodeId, "remove"));
    acts.append(ok, no);
  } else if (!c.friend) {
    const add = h("button", "btn", c.outgoing ? tr("再发一次申请") : tr("加好友"));
    add.type = "button";
    add.disabled = !c.online;
    if (!c.online) add.title = tr("对方离线，等上线再申请");
    add.addEventListener("click", () => void friendAction(c.nodeId, "request", true));
    acts.append(add);
  }
  const fav = h("button", "btn", c.favorite ? tr("取消收藏") : tr("收藏"));
  fav.type = "button";
  fav.addEventListener("click", () => void friendAction(c.nodeId, "favorite", !c.favorite));
  acts.append(fav);
  if (c.friend) {
    const kick = h("button", "btn dng", tr("删除好友"));
    kick.type = "button";
    kick.addEventListener("click", () => void friendAction(c.nodeId, "remove"));
    acts.append(kick);
  }
  detail.append(acts);

  const card = h("div", "card");
  card.append(h("h3", "", tr("资料")));
  const kv = h("div", "kv");
  const rows: [string, string][] = [
    [tr("nodeId"), c.nodeId],
    [tr("地址"), `${c.addr || "?"}:${c.livePort || c.port}`],
    [tr("主机名"), c.hostname || "?"],
    [tr("状态"), c.online ? tr("在线") : tr("离线")],
    [tr("关系"), c.friend ? tr("好友") : c.outgoing ? tr("已发申请") : c.incoming ? tr("对方申请中") : tr("还没加好友")],
  ];
  for (const [k, v] of rows) kv.append(h("span", "k", k), h("span", "v", v));
  card.append(kv, h("div", "note", tr("在线的人会自动出现在「附近的人」里；文件只能发给好友。")));
  detail.append(card);
  mainEl.append(detail);
}

async function friendAction(peer: string, action: "request" | "accept" | "favorite" | "remove", on?: boolean): Promise<void> {
  try {
    await postJson("/api/peer/friend", { peer, action, on });
    await loadContacts();
    await loadThreads();
    renderAll();
  } catch (err) {
    toast((err as Error).message);
  }
}

// ---------------------------------------------------------------- 传输详情

function renderTransferDetail(): void {
  const head = h("div", "head");
  head.append(backBtn(), h("div", "t", tr("传输")));
  mainEl.append(head);
  const detail = h("div", "detail wide");
  const t = S.transfers.find((x) => x.id === S.transfer);
  if (!t) {
    const sum = h("div", "card");
    sum.append(h("h3", "", tr("存储")));
    const kv = h("div", "kv");
    kv.append(h("span", "k", tr("剩余空间")), h("span", "v", sizeOf(S.free)));
    const inbox = S.view?.status?.config.inbox ?? "";
    kv.append(h("span", "k", tr("收件箱")), h("span", "v", inbox || "—"));
    sum.append(kv);
    const foot = h("div", "acts");
    foot.style.padding = "0 13px 13px";
    const openBtn = h("button", "btn", tr("打开收件箱"));
    openBtn.type = "button";
    openBtn.disabled = !inbox;
    openBtn.addEventListener("click", () => void reveal(inbox));
    foot.append(openBtn);
    sum.append(foot);
    detail.append(sum);
    detail.append(h("p", "note", tr("左边是进行中和最近的传输；点一条看详情。")));
    mainEl.append(detail);
    return;
  }

  const pct = percentOf(t);
  const hero = h("div", "hero");
  const box = h("div", "av");
  box.style.setProperty("--h", "265");
  box.append(ic(/^image\//.test(mimeOf(t.name)) ? "image" : "file"));
  const tt = h("div", "t");
  tt.append(
    h("div", "n", t.name),
    h(
      "div",
      "sub",
      (t.direction === "out" ? tr("发给") : tr("收自")) +
        " " +
        (contactOf(t.peerId)?.nickname ?? t.peerId.slice(0, 8)),
    ),
  );
  hero.append(box, tt);
  detail.append(hero);

  if (t.status === "sending" || t.status === "receiving") {
    const prog = h("div", "prog");
    const fill = h("i");
    fill.style.width = `${pct}%`;
    prog.append(fill);
    detail.append(prog);
    const rate = speedOf(t);
    detail.append(h("div", "note", `${pct}% · ${sizeOf(t.bytes)} / ${sizeOf(t.size)}` + (rate && rate !== "—" ? ` · ${rate}` : "")));
  }

  const card = h("div", "card");
  card.append(h("h3", "", tr("详情")));
  const kv = h("div", "kv");
  const rows: [string, string][] = [
    [tr("大小"), sizeOf(t.size)],
    [tr("已传"), sizeOf(t.bytes)],
    [tr("方向"), t.direction === "out" ? tr("发出") : tr("接收")],
    [
      tr("状态"),
      t.status === "done"
        ? tr("完成")
        : t.status === "failed"
          ? tr("失败") + (t.error ? " · " + t.error : "")
          : tr("传输中"),
    ],
    [tr("对端"), contactOf(t.peerId)?.nickname ?? t.peerId],
  ];
  for (const [k, v] of rows) kv.append(h("span", "k", k), h("span", "v", v));
  card.append(kv);
  detail.append(card);

  const acts = h("div", "acts");
  const inbox = S.view?.status?.config.inbox ?? "";
  if (t.direction === "in" && t.status === "done" && inbox) {
    const open = h("button", "btn", tr("打开收件箱"));
    open.type = "button";
    open.addEventListener("click", () => void reveal(inbox));
    acts.append(open);
  }
  detail.append(acts);
  mainEl.append(detail);
}

async function reveal(target: string): Promise<void> {
  if (!target) return;
  try {
    await postJson("/api/reveal", { path: target });
  } catch (err) {
    toast((err as Error).message);
  }
}

// ---------------------------------------------------------------- 我

function renderMe(): void {
  const st = S.view?.status;
  const head = h("div", "head");
  head.append(h("div", "t", tr("我")));
  mainEl.append(head);

  const detail = h("div", "detail wide");
  if (!st) {
    detail.append(emptyState("me", tr("内网通没在运行"), tr("启动 bridge 之后这里会有你自己的资料和开关")));
    mainEl.append(detail);
    return;
  }

  const hero = h("div", "hero");
  hero.append(avatar(st.nickname, st.nodeId));
  const t = h("div", "t");
  t.append(h("div", "n", st.nickname), h("div", "sub", `${st.hostname} · :${st.port}`));
  hero.append(t);
  detail.append(hero);

  const profile = h("div", "card");
  profile.append(h("h3", "", tr("资料")));
  const kv = h("div", "kv");
  for (const [k, v] of [
    [tr("nodeId"), st.nodeId],
    [tr("主机名"), st.hostname],
    [tr("端口"), String(st.port)],
  ] as [string, string][]) {
    kv.append(h("span", "k", k), h("span", "v", v));
  }
  profile.append(kv, h("div", "note", tr("nodeId 是这台机器的身份，换机器或删掉 ~/.pi-peer 就会变。")));
  detail.append(profile);

  const sw = h("div", "card");
  sw.append(h("h3", "", tr("开关")));
  sw.append(
    toggle(tr("隐身"), tr("别人看不到你，你也收不到新的人"), st.config.hidden, (on) => void setConfig({ hidden: on })),
    toggle(tr("免打扰"), tr("新消息不弹提醒，消息照收"), st.config.dnd, (on) => void setConfig({ dnd: on })),
    toggle(tr("暂停收文件"), tr("别人发来的文件会被拒收，消息不受影响"), st.config.pauseFiles, (on) => void setConfig({ pauseFiles: on })),
  );
  detail.append(sw);

  const store = h("div", "card");
  store.append(h("h3", "", tr("存储")));
  const skv = h("div", "kv");
  skv.append(h("span", "k", tr("收件箱")), h("span", "v", st.config.inbox));
  skv.append(h("span", "k", tr("剩余空间")), h("span", "v", sizeOf(S.free)));
  store.append(skv);
  const sacts = h("div", "acts");
  sacts.style.padding = "0 13px 13px";
  const open = h("button", "btn", tr("打开收件箱"));
  open.type = "button";
  open.addEventListener("click", () => void reveal(st.config.inbox));
  sacts.append(open);
  store.append(sacts);
  detail.append(store);

  const net = h("div", "card");
  net.append(h("h3", "", tr("发现")));
  const nacts = h("div", "acts");
  nacts.style.padding = "12px 13px";
  const again = h("button", "btn", tr("重新广播"));
  again.type = "button";
  again.addEventListener("click", () => void refreshAll());
  nacts.append(again);
  net.append(nacts, h("div", "note", st.config.manual.length ? tr("手动地址：{p1}", { p1: st.config.manual.join(", ") }) : tr("同一内网的人打开 pi 就会互相出现；组播被挡时用「+」手动加地址。")));
  detail.append(net);

  mainEl.append(detail);
}

function toggle(name: string, sub: string, on: boolean, run: (on: boolean) => void): HTMLElement {
  const row = h("div", "toggle");
  const t = h("div", "t");
  t.append(h("div", "n", name), h("div", "s", sub));
  const sw = h("span", `sw${on ? " on" : ""}`);
  row.append(t, sw);
  row.addEventListener("click", () => {
    sw.classList.toggle("on");
    run(!on);
  });
  return row;
}

async function setConfig(patch: { hidden?: boolean; dnd?: boolean; pauseFiles?: boolean }): Promise<void> {
  try {
    await postJson("/api/peer/config", patch);
    await loadStatus();
    renderAll();
  } catch (err) {
    toast((err as Error).message);
    await loadStatus();
    renderAll();
  }
}

async function refreshAll(): Promise<void> {
  try {
    await postJson("/api/peer/refresh");
  } catch {
    /* 没跑起来的时候刷新也会失败，状态条已经说了 */
  }
  await loadStatus();
  await loadThreads();
  await loadContacts();
  await loadTransfers();
  renderAll();
}

// ---------------------------------------------------------------- 菜单 / 弹窗

function closeLayer(): void {
  layerEl.replaceChildren();
}

function openMenu(x: number, y: number, items: { label: string; icon?: string; danger?: boolean; run: () => void }[]): void {
  closeLayer();
  const scrim = h("div", "scrim");
  scrim.addEventListener("click", closeLayer);
  const menu = h("div", "menu");
  for (const item of items) {
    const b = h("button", item.danger ? "dng" : "");
    b.type = "button";
    if (item.icon) b.append(ic(item.icon));
    b.append(h("span", "", item.label));
    b.addEventListener("click", () => {
      closeLayer();
      item.run();
    });
    menu.append(b);
  }
  const maxX = window.innerWidth - 180;
  const maxY = window.innerHeight - (items.length * 34 + 20);
  menu.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
  layerEl.append(scrim, menu);
}

function threadMenu(x: number, y: number, t: Thread): void {
  const c = contactOf(t.nodeId);
  openMenu(x, y, [
    { label: tr("打开对话"), icon: "msg", run: () => openThread(t.nodeId) },
    ...(c?.friend ? [{ label: tr("传文件"), icon: "attach", run: () => void openPicker(t.nodeId, true) }] : []),
    {
      label: tr("复制 nodeId"),
      icon: "copy",
      run: () => void copyText(t.nodeId),
    },
  ]);
}

function contactMenu(x: number, y: number, c: Contact): void {
  openMenu(x, y, [
    { label: tr("发消息"), icon: "msg", run: () => openThread(c.nodeId) },
    ...(c.friend ? [{ label: tr("传文件"), icon: "attach", run: () => void openPicker(c.nodeId, true) }] : []),
    { label: c.favorite ? tr("取消收藏") : tr("收藏"), icon: "star", run: () => void friendAction(c.nodeId, "favorite", !c.favorite) },
    { label: tr("复制 nodeId"), icon: "copy", run: () => void copyText(c.nodeId) },
    ...(c.friend
      ? [{ label: tr("删除好友"), icon: "trash", danger: true, run: () => void friendAction(c.nodeId, "remove") }]
      : []),
  ]);
}

function addModal(): void {
  closeLayer();
  const scrim = h("div", "scrim");
  scrim.addEventListener("click", closeLayer);
  const modal = h("div", "modal");
  const head = h("header");
  head.append(h("strong", "", tr("添加联系人")), iconBtn("close", tr("关掉"), closeLayer));
  const body = h("div", "body");
  const field = h("label", "field");
  field.append(h("span", "", tr("手动地址")), inputEl("192.168.1.7:7865"));
  body.append(field, h("p", "note", tr("组播被交换机挡住时，填对方的 IP 和端口就能互相出现。")));
  const foot = h("footer");
  const cancel = h("button", "btn", tr("取消"));
  cancel.type = "button";
  cancel.addEventListener("click", closeLayer);
  const goBtn = h("button", "btn pri", tr("添加并刷新"));
  goBtn.type = "button";
  goBtn.addEventListener("click", async () => {
    const value = (field.querySelector("input") as HTMLInputElement).value.trim();
    if (!value) return;
    try {
      await postJson("/api/peer/add", { addr: value });
      closeLayer();
      await refreshAll();
      toast(tr("已添加，等对方回一声"));
    } catch (error) {
      const line = h("p", "err", (error as Error).message);
      modal.insertBefore(line, foot);
    }
  });
  foot.append(cancel, goBtn);
  modal.append(head, body, foot);
  layerEl.append(scrim, modal);
}

function inputEl(placeholder: string): HTMLInputElement {
  const i = h("input");
  i.type = "text";
  i.placeholder = placeholder;
  i.autocomplete = "off";
  return i;
}

// ---------------------------------------------------------------- 文件选择器

async function openPicker(peer: string, direct = false): Promise<void> {
  // 「传文件」从联系人页直接进来时，先把会话切过去：发完就在聊天里能看到。
  if (!S.thread || S.thread !== peer) {
    S.thread = peer;
    await loadMessages();
  }
  if (direct) {
    S.page = "msg";
    app.dataset.page = "msg";
    S.mview = "chat";
    app.dataset.mview = "chat";
  }
  picker.hidden = false;
  await browse("");
}

function closePicker(): void {
  picker.hidden = true;
  picked = null;
}

async function browse(dir: string): Promise<void> {
  try {
    const data = await getJson<Browse & { ok: boolean }>(`/api/peer/fs?path=${encodeURIComponent(dir)}`);
    pickerDir = data.path ?? dir;
    pickerParent = data.parent ?? null;
    picked = null;
    renderCrumbs();
    placesEl.replaceChildren(...(data.places ?? []).map((p) => placeItem(p.name, p.path)));
    rootsEl.replaceChildren(...(data.roots ?? []).map((p) => placeItem(p.name, p.path)));
    filesEl.replaceChildren();
    if (!data.entries?.length) filesEl.append(h("li", "", tr("这个文件夹是空的")));
    for (const entry of data.entries ?? []) filesEl.append(fileItem(entry));
    pickerSendBtn.disabled = true;
    pickerSel.textContent = tr("还没选文件");
    pickerUp.disabled = !pickerParent;
    pickerUp.onclick = () => pickerParent && void browse(pickerParent);
  } catch (err) {
    toast((err as Error).message);
  }
}

function placeItem(name: string, path: string): HTMLLIElement {
  const li = h("li");
  li.append(ic(/^[A-Z]:\\?$/.test(path) ? "disk" : "folder"), h("span", "ell", name));
  li.title = path;
  li.addEventListener("click", () => void browse(path));
  return li;
}

function fileItem(entry: BrowseEntry): HTMLLIElement {
  const li = h("li");
  li.append(ic(entry.dir ? "folder" : "file"), h("span", "ell", entry.name));
  li.append(h("span", "sz", entry.dir ? "" : sizeOf(entry.size)));
  li.addEventListener("click", () => {
    if (entry.dir) {
      void browse(entry.path);
      return;
    }
    for (const other of filesEl.children) other.classList.remove("on");
    li.classList.add("on");
    picked = entry;
    pickerSendBtn.disabled = false;
    pickerSel.textContent = entry.name;
  });
  return li;
}

function renderCrumbs(): void {
  crumbsEl.replaceChildren();
  const root = iconBtn("monitor", tr("这台电脑"), () => void browse(""));
  root.classList.add("crumb-root");
  crumbsEl.append(root);
  const parts = pickerDir.split(/[\\/]/).filter(Boolean);
  let acc = "";
  parts.forEach((part, i) => {
    acc += (i === 0 ? "" : "\\") + part;
    const target = acc;
    const b = h("button", "", part);
    b.type = "button";
    b.addEventListener("click", () => void browse(target));
    crumbsEl.append(h("span", "", "›"), b);
  });
}

pickerClose.addEventListener("click", closePicker);
pickerSendBtn.addEventListener("click", () => {
  if (picked) void sendPath(picked.path);
});
picker.addEventListener("click", (ev) => {
  if (ev.target === picker) closePicker();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!picker.hidden) return closePicker();
  closeLayer();
});

// ---------------------------------------------------------------- 启动 / 轮询

async function boot(): Promise<void> {
  document.title = tr("内网通 · pi");
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) node.textContent = tr(node.dataset.i18n ?? "");
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) node.title = tr(node.dataset.i18nTitle ?? "");
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n-aria]")) node.setAttribute("aria-label", tr(node.dataset.i18nAria ?? ""));
  (pickerClose as HTMLElement).append(ic("close"));
  await loadStatus();
  await loadThreads();
  await loadContacts();
  await loadTransfers();
  if (S.threads.length && !S.thread) S.thread = S.threads[0].nodeId;
  app.dataset.page = S.page;
  app.dataset.mview = S.mview;
  renderAll();
  if (S.thread) void loadMessages().then(() => renderMain());
}

void boot();

window.setInterval(() => {
  void loadStatus().then(() => {
    renderBar();
    renderHint();
  });
}, 5000);

window.setInterval(() => {
  void loadThreads().then(() => {
    if (S.page === "msg") renderList();
  });
}, 4000);

window.setInterval(() => {
  void loadContacts().then(() => {
    if (S.page === "contacts") {
      renderList();
      renderMain();
    }
  });
}, 6000);

window.setInterval(() => {
  if (S.page !== "msg" || !S.thread || document.hidden) return;
  // 没有新消息就不重画：整块换 DOM 会把输入框、选区、滚动都拽一遍，2.5 秒一次太贵了。
  const before = msgSig();
  void loadMessages().then(() => {
    if (S.page === "msg" && msgSig() !== before) renderMain();
  });
}, 2500);

window.setInterval(() => {
  void loadTransfers().then(() => {
    if (S.page === "transfers") {
      renderList();
      renderMain();
    }
  });
}, 1200);
