import { applyLang, bootLang, fmtDate, fmtNum, fmtRelative, fmtTime, tr } from "../i18n/index.ts";
import { renderMarkdown } from "../md.ts";
import { RichEditor } from "../notes/editor.ts";
import { hasRichMarkup, isRichEmpty, plainText, sanitizeRich } from "../notes/rich.ts";
import { SheetDialog } from "../sheet/dialog.ts";
import "../sheet/sheet.css";

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
  status?: string;
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
  kind: "text" | "receipt" | "file" | "recall" | "note";
  text?: string;
  ack?: { id: string; status: "delivered" | "failed"; error?: string };
  file?: { name: string; size: number; mime: string; sha256?: string; w?: number; h?: number };
  via?: "pi";
  /** P2：会话内序号，同毫秒时当排序第二键。 */
  seq?: number;
  /** P3：引用。 */
  replyTo?: { id: string; from: string; excerpt: string };
  /** `kind:"recall"` 指向被撤回的那条（页面不单独画它，只把原气泡换成灰条）。 */
  ref?: string;
  /** `kind:"note"` 的记录包（#507）。 */
  note?: NoteInfo;
  /** 视图字段（peer 折叠出来，不落盘）：这条已经被撤回。 */
  recalled?: boolean;
  /** 视图字段：我自己发的这条现在在哪个态。 */
  state?: "sending" | "delivered" | "failed";
}

interface NoteShotInfo {
  name: string;
  size: number;
  sha256: string;
  /** 由桥对齐出来的文件条目 id；null = 还没到。 */
  entryId?: string | null;
}

interface NoteInfo {
  title: string;
  body: string;
  kind: "bug" | "change" | "idea" | "chore";
  status: "pending" | "done" | "dropped";
  shots?: NoteShotInfo[];
  noteCreatedAt?: number;
  noteUpdatedAt?: number;
  /** 本地接受状态（sidecar，不从对端回传）。 */
  accepted?: { noteId: string; at: number } | null;
}

interface Thread {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  last: Entry | null;
  count: number;
  online: boolean;
  status: string;
  lastSeen: number;
  unread: number;
  pinned: boolean;
  muted: boolean;
  draft: string;
  lastMine: boolean;
  sending: boolean;
  typing: boolean;
}

interface Contact {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
  // 老关系记录 / 测试桩没有 quick 字段时按 false 处理。
  quick?: boolean;
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
  mime?: string;
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
  collapse: ["M9 5l7 7-7 7"],
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
  ignored: [] as string[],
  transfers: [] as Transfer[],
  free: 0,
  msgs: [] as Entry[],
  msgsFor: "" as string,
  sending: false,
  /** P3：正在引用的那条（发送后清空）。 */
  replyTo: null as Entry | null,
  /** P4：上一次通知过的未读数，按 nodeId 记（只在页面隐藏时用来比）。 */
  unreadSeen: new Map<string, number>(),
  /** D302：会话列表折叠（跨刷新记住），折叠后整块宽度让给对话。 */
  listCollapsed: readFlag("peer.listCollapsed"),
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
const pickerPath = document.querySelector("#picker-path") as HTMLInputElement;
const pickerGo = document.querySelector("#picker-go") as HTMLButtonElement;
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
/** 刚发出一条消息（文字 / 文件）：下一次重画必须贴底，哪怕原先停在历史中间。 */
let forceBottom = false;
let prevScroll = 0;
let textInput: HTMLElement | null = null;
/** 输入区的富文本实例：换会话要 destroy（它在 document 上挂了监听）。 */
let composer: RichEditor | null = null;
let sendBtn: HTMLButtonElement | null = null;
/** 引用条所在的槽：换会话时重建，引用 / 取消引用时只重画槽里的东西。 */
let replyHost: HTMLElement | null = null;
/** 输入中的心跳节流：服务端还有一层 1.5 s，这里只是别把每次按键都发出去。 */
let typingSentAt = 0;
/** 草稿防抖：敲一下存一下会把 threads.json 打成筛子。 */
let draftTimer = 0;

// ---------------------------------------------------------------- 小工具

const byteLen = (text: string): number => new TextEncoder().encode(text).length;
/** 除了普通段落/换行，还有别的标签才算「带了格式」：纯文字仍发纯文本，老气泡不变。 */
const hasFormat = (html: string): boolean =>
  /<[a-z][^>]*>/i.test(html.replace(/<p(?:\s[^>]*)?>|<\/p>|<br(?:\s[^>]*)?>|<\/br>/gi, ""));

/** localStorage 里的布尔开关：存 `"1"` / `"0"`，读写都包一层 try（隐身模式下会抛）。 */
function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* 隐身模式 */
  }
}

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
  pingUnread();
}

/** 桌面通知开关：默认开，浏览器权限要用户点一下才给（`setNotify`）。 */
function notifyEnabled(): boolean {
  try {
    return window.localStorage.getItem("peer.notify") !== "0";
  } catch {
    return true;
  }
}

let unreadPrimed = false;

/**
 * P4：页面不在前面时，新消息弹一条系统通知。
 *
 * 首轮只记账不弹（否则一打开就把全部未读弹一遍）；静音会话与免打扰都挡。
 * bridge 那边有一条同样的路（Web Push），两者不冲突：页面开着就是这条，页面关了就是那条。
 */
function pingUnread(): void {
  // 嵌在主页面弹层里时，通知由主页面统一发（它知道「内网通弹层开着没有」）；这一份只在
  // `/peer` 被单独打开时管用 —— 否则同一件事会弹两条。
  const embedded = window.self !== window.top;
  const canNotify =
    !embedded && document.hidden && notifyEnabled() && "Notification" in window && Notification.permission === "granted";
  for (const t of S.threads) {
    const prev = S.unreadSeen.get(t.nodeId) ?? 0;
    S.unreadSeen.set(t.nodeId, t.unread);
    if (!unreadPrimed || !canNotify) continue;
    if (t.unread <= prev || t.unread === 0) continue;
    if (t.muted || S.view?.status?.config.dnd) continue;
    const last = t.last;
    const body = last ? (last.text ?? (last.file ? tr("[文件] {p1}", { p1: last.file.name }) : tr("发来一条新消息"))) : "";
    try {
      const note = new Notification(tr("内网通 · {p1}", { p1: t.nickname }), { body: body.slice(0, 120), tag: t.nodeId });
      note.onclick = () => {
        window.focus();
        openThread(t.nodeId);
        note.close();
      };
    } catch {
      /* 不支持 / 权限被撤：不弹就是了 */
    }
  }
  unreadPrimed = true;
}

async function setNotify(on: boolean): Promise<void> {
  if (!on) {
    try {
      window.localStorage.setItem("peer.notify", "0");
    } catch {
      /* 隐身模式 */
    }
    toast(tr("桌面通知已关"));
    renderMain();
    return;
  }
  if ("Notification" in window && Notification.permission !== "granted") {
    try {
      await Notification.requestPermission();
    } catch {
      /* 老浏览器没有 requestPermission */
    }
    // 读回来重新判一次：上面的窄化在 await 之后已经不成立了，所以先转成 string 再比。
    if (String(Notification.permission) !== "granted") {
      toast(tr("浏览器没有给通知权限"));
      return;
    }
  }
  try {
    window.localStorage.setItem("peer.notify", "1");
  } catch {
    /* 隐身模式 */
  }
  toast(tr("桌面通知已开"));
  renderMain();
}

/** 独立落盘的忽略名单：页面只用它挡住在线表兜底合并，不改状态 / 找人接口。 */
async function loadIgnored(): Promise<void> {
  try {
    const data = await getJson<{ nodeIds?: string[] }>("/api/peer/ignored");
    S.ignored = Array.isArray(data.nodeIds) ? data.nodeIds.filter((id): id is string => typeof id === "string") : [];
  } catch {
    S.ignored = [];
  }
}

async function loadContacts(): Promise<void> {
  await loadIgnored();
  try {
    const data = await getJson<{ contacts: Contact[] }>("/api/peer/contacts");
    S.contacts = data.contacts ?? [];
  } catch {
    S.contacts = [];
  }
  // 在线名单兜底：通讯录那边没把在线的人合并进来时（例如接口是旧版或被代理替换），
  // 页面自己补一行，这样「附近的人」只依赖当前在线表。已有关系行一律不覆盖，
  // 被移除的人不再补回来，每轮轮询重新构造，不会累积重复。
  const me = S.view?.status?.nodeId;
  const known = new Set(S.contacts.map((c) => c.nodeId));
  const ignored = new Set(S.ignored);
  for (const p of S.view?.status?.online ?? []) {
    if (p.nodeId === me || known.has(p.nodeId) || ignored.has(p.nodeId)) continue;
    known.add(p.nodeId);
    S.contacts.push({
      nodeId: p.nodeId,
      nickname: p.nickname,
      hostname: p.hostname,
      port: p.port,
      quick: false,
      friend: false,
      favorite: false,
      incoming: false,
      outgoing: false,
      at: p.lastSeen,
      online: true,
      addr: p.addr,
      livePort: p.port,
    });
  }
}

/** 一串消息的指纹：id + 回执状态。轮询拿回来跟上次一样就不必重画。 */
function msgSig(): string {
  return S.msgs.map((m) => `${m.id}:${m.ack?.status ?? ""}`).join("|");
}

/** 拉取序号：只让最新一次请求的响应落到 S.msgs 上。 */
let msgSeq = 0;

async function loadMessages(id = S.thread): Promise<void> {
  if (!id) return;
  // 慢响应要能丢：手点得比网快时，A 的响应会在切到 B 之后才回来。
  const seq = ++msgSeq;
  const data = await getJson<{ entries: Entry[] }>(`/api/peer/messages?peer=${encodeURIComponent(id)}&limit=200`).catch(() => null);
  // 拉不到就保持旧内容：一次超时不该把聊天清空
  if (!data || seq !== msgSeq || S.thread !== id) return;
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

/** 折叠 / 展开会话列表：折叠后 `paintList` 不进 DOM，主区吃掉整块宽度（同一个 data-nolist）。 */
function setListCollapsed(on: boolean): void {
  S.listCollapsed = on;
  writeFlag("peer.listCollapsed", on);
  renderAll();
}

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
  // 从联系人列表点「发消息」就是要马上打字：把焦点直接放进输入框。
  // renderAll() 里 renderChat() 已经同步建好 textarea（composeBox 会更新 textInput）。
  textInput?.focus({ preventScroll: true });
  void loadMessages().then(async () => {
    const fresh = threadOf(id);
    if (fresh) await markRead(fresh);
    await loadThreads();
    if (S.thread === id && S.page === "msg") renderList();
    renderMain();
  });
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

  frag.append(brand, meta, spacer);
  if (S.listCollapsed && S.page !== "me") {
    frag.append(iconBtn("collapse", tr("展开会话列表"), () => setListCollapsed(false)));
  }
  frag.append(flags);
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
  if (st?.config.hidden) bits.push(tr("隐身中：别人看不到你，但仍能看见别人"));
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
  const noList = S.page === "me" || S.listCollapsed;
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
  if (e.recalled) return tr("撤回了一条消息");
  const body =
    e.kind === "note"
      ? tr("[记录] {p1}", { p1: e.note?.title ?? "" })
      : e.kind === "file"
        ? picKind(e) === "gif"
          ? tr("[动图]")
          : picKind(e)
            ? tr("[图片]")
            : tr("[文件] {p1}", { p1: e.file?.name ?? "" })
        : hasRichMarkup(e.text ?? "")
          ? plainText(e.text ?? "")
          : (e.text ?? "");
  // 最后一条是我发的就加「你:」前缀（QQ 的会话行也这样，不然自己的话看着像对方说的）。
  return t.lastMine ? tr("你: {p1}", { p1: body }) : body;
}

function badgeText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** 把未读打到已读：拿最后一条消息的 `{at, id}` 当水位，同毫秒也不会漏（D299）。 */
async function markRead(t: Thread): Promise<void> {
  if (!t.last || t.unread === 0) return;
  try {
    await postJson("/api/peer/read", { peer: t.nodeId, at: t.last.at, id: t.last.id });
  } catch {
    /* 落后一拍不算错：下一轮轮询会重试 */
  }
}

function renderThreadList(): void {
  const head = h("div", "listhead");
  head.append(searchBox(tr("搜索会话")), iconBtn("back", tr("收起会话列表"), () => setListCollapsed(true)));
  listEl.append(head);
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
    const row = h("div", `row${S.thread === t.nodeId ? " on" : ""}${t.pinned ? " pinned" : ""}`);
    const wrap = h("span", "avwrap");
    wrap.append(avatar(t.nickname, t.nodeId, t.online));
    if (t.unread > 0) wrap.append(h("i", `unread${t.muted ? " quiet" : ""}`, t.muted ? "" : badgeText(t.unread)));
    row.append(wrap);
    const tbox = h("div", "t");
    const name = h("div", "n");
    name.append(h("span", "nm", t.nickname));
    if (t.pinned) name.append(ic("star", "pin"));
    if (t.last?.via === "pi") name.append(h("span", "pill pi", "pi"));
    const sub = h("div", "s");
    if (t.typing) sub.append(h("span", "typing", tr("对方正在输入…")));
    else if (t.draft) sub.append(h("span", "draft", tr("草稿：{p1}", { p1: plainText(t.draft).slice(0, 80) })));
    else sub.append(h("span", "", preview(t)));
    if (t.muted) sub.append(ic("bellOff", "mute"));
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
  // quick 与 friend 正交：一键加过的人单独成组，排在好友之后、附近的人之前（D234）。
  const quickList = take(S.contacts.filter((c) => c.quick && !c.friend));
  const nearby = take(S.contacts.filter((c) => !c.friend && !c.incoming && !c.quick));
  // 收藏不再单独成组：同一个人会同时出现在「收藏」和「好友·在线」，看着像两个人。
  // 改成收藏的排到组内最前（行上已有 ★），组本身不留空壳。
  const favFirst = (list: Contact[]): Contact[] =>
    list.slice().sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.nickname.localeCompare(b.nickname));
  const groups: Group[] = [];
  if (pending.length) groups.push({ title: tr("待处理"), items: favFirst(pending) });
  groups.push({ title: tr("好友 · 在线"), items: favFirst(online) });
  groups.push({ title: tr("好友 · 离线"), items: favFirst(offline) });
  if (quickList.length) groups.push({ title: tr("快捷联系人"), items: favFirst(quickList) });
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
  let forced = forceBottom;
  forceBottom = false;
  if (prev) {
    // 发出去的东西一定要看得见：`forceBottom` 优先于「刚才停在哪」。
    stickBottom = forced || prev.scrollTop + prev.clientHeight >= prev.scrollHeight - 32;
    prevScroll = prev.scrollTop;
  } else if (forced) {
    stickBottom = true;
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

/**
 * 当前的会话对象。有历史就从 /threads 里取；刚加的好友还没历史（peer 的 /threads 只遍历
 * history 目录），就用通讯录 / 在线表拼一个，不然聊天区只剩「选一个会话」，第一条消息没法发。
 */
function threadOf(id: string | null): Thread | null {
  if (!id) return null;
  const found = S.threads.find((x) => x.nodeId === id);
  if (found) return found;
  const contact = contactOf(id);
  const online = S.view?.status?.online.find((p) => p.nodeId === id);
  const nickname = contact?.nickname || online?.nickname;
  if (!nickname) return null;
  return {
    nodeId: id,
    nickname,
    hostname: contact?.hostname || online?.hostname || "",
    port: contact?.port ?? online?.port ?? 0,
    last: null,
    count: 0,
    online: Boolean(online),
    status: online?.status ?? (online ? "online" : "offline"),
    lastSeen: online?.lastSeen ?? 0,
    unread: 0,
    pinned: false,
    muted: false,
    draft: "",
    lastMine: false,
    sending: false,
    typing: false,
  };
}

function renderChat(): void {
  const t = threadOf(S.thread);
  if (!t) {
    composer?.destroy();
    composer = null;
    textInput = null;
    composeEl = null;
    composeFor = "";
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
  const subText = t.typing
    ? tr("对方正在输入…")
    : t.online
      ? (t.status === "away" ? tr("离开") : tr("在线")) + " · " + (t.hostname || "")
      : tr("离线");
  const sub = h("div", `s${t.typing ? " typing" : ""}`, subText);
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
    if (e.kind === "receipt" || e.kind === "recall") continue;
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
  const compose = composeBox(t);
  mainEl.append(compose);
  // 贴底要在**输入框也挂上之后**做：先设一次会把还没缩下来的高度当成底，
  // 差的那几十像素就是输入框与文件卡片的高度（用户报的「发完文件没滚到底」）。
  if (stickBottom) {
    stream.scrollTop = stream.scrollHeight;
    requestAnimationFrame(() => {
      if (stickBottom) stream.scrollTop = stream.scrollHeight;
    });
  } else {
    stream.scrollTop = prevScroll;
  }
}

const NOTE_KIND_TEXT: Record<string, string> = { bug: "bug", change: tr("变更"), idea: tr("想法"), chore: tr("杂事") };
const NOTE_STATUS_TEXT: Record<string, string> = { pending: tr("待处理"), done: tr("已处理"), dropped: tr("已忽略") };

/** 记录卡片（#508）：标题 / 两行摘要 / 分类状态 / 最多 4 张图 / 来源 / 预览与接受。 */
function noteCard(e: Entry, t: Thread, mine: boolean): HTMLElement {
  const note = e.note as NoteInfo;
  const shots = note.shots ?? [];
  const missing = shots.filter((shot) => !shot.entryId).length;
  const card = h("div", `ncard${e.state === "failed" ? " failed" : ""}${note.accepted ? " accepted" : ""}`);
  const top = h("div", "ntop");
  const chips = h("div", "nchips");
  chips.append(h("span", "nchip", NOTE_KIND_TEXT[note.kind] ?? note.kind), h("span", "nchip st", NOTE_STATUS_TEXT[note.status] ?? note.status));
  top.append(h("div", "ntitle", note.title || tr("未命名")), chips);
  card.append(top);
  const brief = plainText(note.body).trim();
  if (brief) card.append(h("div", "nbrief", brief.slice(0, 140)));
  if (shots.length) {
    const grid = h("div", "nthumbs");
    for (const shot of shots.slice(0, 4)) grid.append(shotThumb(shot));
    if (shots.length > 4) grid.append(h("div", "nthumb more", `+${shots.length - 4}`));
    card.append(grid);
  }
  if (missing) card.append(h("div", "nmiss", tr("还差 {p1} 张图", { p1: String(missing) })));
  const foot = h("div", "nfoot");
  const who = mine ? (S.view?.status?.nickname ?? tr("我")) : t.nickname;
  foot.append(h("span", "nfrom", [who, e.from.hostname || t.hostname, clock(e.at)].join(" · ")));
  const acts = h("div", "nacts");
  const preview = h("button", "link", tr("预览")) as HTMLButtonElement;
  preview.addEventListener("click", () => showNotePeek(e, t));
  acts.append(preview);
  if (!mine) {
    if (note.accepted) {
      const open = h("button", "link", tr("打开记录")) as HTMLButtonElement;
      open.addEventListener("click", () => {
        window.parent?.postMessage({ t: "pi-note-open", id: note.accepted?.noteId }, window.location.origin);
      });
      acts.append(h("span", "nok", tr("已接受")), open);
    } else {
      const take = h("button", "btn pri", tr("接受")) as HTMLButtonElement;
      take.disabled = missing > 0 || e.state === "sending" || e.state === "failed";
      if (missing) take.title = tr("还差 {p1} 张图", { p1: String(missing) });
      take.addEventListener("click", () => void acceptNote(e, t, take));
      acts.append(take);
    }
  }
  foot.append(acts);
  card.append(foot);
  return card;
}

/** 截图缩略图：点开大图（与文件预览共用一层）。 */
function shotThumb(shot: NoteShotInfo): HTMLElement {
  if (!shot.entryId) return h("div", "nthumb missing", tr("还差图"));
  const url = `/api/peer/file?id=${encodeURIComponent(shot.entryId)}`;
  const img = h("img", "nthumb") as HTMLImageElement;
  img.src = url;
  img.alt = shot.name;
  img.loading = "lazy";
  img.addEventListener("click", (ev) => {
    ev.stopPropagation();
    showPreview({ name: shot.name, mime: "image/*", size: shot.size, url });
  });
  return img;
}

/** 接受：桥端原子导入，成功后本地卡片变「已接受」，面板由 broadcast 刷新。 */
async function acceptNote(e: Entry, t: Thread, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = tr("接受中…");
  try {
    const res = await postJson<{ ok: boolean; noteId: string; warning?: string }>("/api/peer/note/accept", { peer: t.nodeId, id: e.id });
    if (e.note) e.note.accepted = { noteId: res.noteId, at: Date.now() };
    toast(res.warning || tr("记录已导入"));
    renderMain();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = label;
    toast((err as Error).message);
  }
}

/** 预览正文：净化过的 HTML 直接挂节点（选择复制照常用，编辑不了）。 */
function noteBody(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<body>${sanitizeRich(html)}</body>`, "text/html");
  const box = h("div", "note-rich");
  box.append(...[...doc.body.childNodes].map((node) => document.importNode(node, true)));
  for (const a of box.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return box;
}

/** 只读预览（#508）：标题、分类、发送时状态、正文、全部截图、来源；没有转发 / agent。 */
function showNotePeek(e: Entry, t: Thread): void {
  const note = e.note;
  if (!note) return;
  closeLayer();
  const scrim = h("div", "scrim");
  const modal = h("div", "modal notepeek");
  const head = h("header");
  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    closeLayer();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    close();
  };
  head.append(h("strong", "nm", note.title || tr("未命名")), iconBtn("close", tr("关闭"), close));
  const meta = h("div", "meta");
  meta.append(
    h("span", "nchip", NOTE_KIND_TEXT[note.kind] ?? note.kind),
    h("span", "nchip st", tr("发送时") + " · " + (NOTE_STATUS_TEXT[note.status] ?? note.status)),
  );
  const body = h("div", "body note-body");
  body.append(noteBody(note.body));
  modal.append(head, meta, body);
  const shots = (note.shots ?? []).filter((shot) => shot.entryId);
  if (shots.length) {
    const gallery = h("div", "note-gallery");
    for (const shot of shots) gallery.append(shotThumb(shot));
    modal.append(gallery);
  }
  const from = h("div", "note-from", tr("来自 {p1} · {p2} · {p3}", {
    p1: e.from.nickname || t.nickname,
    p2: e.from.hostname || t.hostname,
    p3: `${fmtDate(e.at)} ${clock(e.at)}`,
  }));
  modal.append(from);
  layerEl.append(scrim, modal);
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
}

function entryNode(e: Entry, t: Thread): HTMLElement {
  const mine = e.from.nodeId === S.view?.status?.nodeId;
  // 撤回（P3）：原气泡换成一整行灰条，原文不再显示（文件里还在，见 D299）。
  if (e.recalled) {
    return h("div", "graytip", mine ? tr("你撤回了一条消息") : tr("{p1} 撤回了一条消息", { p1: t.nickname }));
  }
  const msg = h("div", `msg${mine ? " mine" : ""}`);
  msg.dataset.id = e.id;
  msg.append(avatar(mine ? (S.view?.status?.nickname ?? tr("我")) : t.nickname, e.from.nodeId));
  const box = h("div", "b");
  if (e.replyTo) box.append(quoteBlock(e.replyTo));
  if (e.kind === "note" && e.note) {
    box.append(noteCard(e, t, mine));
  } else if (e.kind === "file" && e.file && picKind(e)) {
    box.append(picBubble(e, mine));
  } else if (e.kind === "file" && e.file) {
    box.append(fileCard(e, mine));
  } else {
    const text = e.text ?? "";
    const bub = h("div", `bub${e.state === "failed" ? " failed" : ""}`);
    bub.title = tr("点击复制");
    const body = h("div", "bub-body");
    let copy = text;
    if (hasRichMarkup(text)) {
      // 富文本（#515 之后从输入区发出来的）：颜色 / 字号 / 底色剥掉，只留结构。
      body.classList.add("rich");
      body.append(richBubble(text));
      copy = plainText(text);
    } else {
      // 旧纯文本与记录转发过来的 Markdown：表格与图片不进气泡（#512）。
      body.classList.add("md");
      body.append(renderMarkdown(text, { tables: false, imageSrc: () => null, openPath: (path) => void copyPath(path) }));
    }
    bub.append(body);
    bub.addEventListener("click", (ev) => {
      const el = ev.target instanceof Element ? ev.target : null;
      // 链接 / 代码块 / 表格要能自己选中或跳转，不抢成「复制全文」。
      if (el?.closest("a, code, pre, table, .bub-more")) return;
      void copyText(copy);
    });
    addFold(bub, body, text);
    box.append(bub);
  }
  const meta = h("div", "tm");
  if (e.via === "pi") meta.append(h("span", "pill pi", tr("pi 代发")));
  meta.append(h("span", "", clock(e.at)));
  if (mine) {
    if (e.state === "sending") {
      meta.append(h("span", "sending", tr("发送中…")));
    } else if (e.state === "failed") {
      const bad = ic("alert", "bad");
      meta.append(bad, h("span", "bad", tr("发送失败")));
      const retry = h("button", "link", tr("重发"));
      retry.addEventListener("click", () => void resend(e));
      meta.append(retry);
    } else if (e.state === "delivered") {
      const ok = ic("check", "ok");
      meta.append(ok, h("span", "ok", tr("已送达")));
    }
  }
  box.append(meta);
  msg.append(box);
  msg.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    messageMenu(ev.clientX, ev.clientY, e, t, mine);
  });
  return msg;
}

/** 富文本气泡：净化过的 HTML 落到气泡里，span 只当载体（颜色 / 字号 / 底色不跟过来）。 */
function richBubble(html: string): HTMLElement {
  // 本文件不写 innerHTML（仓库规矩，见 `web/src/md.ts` 抬头）：DOMParser 解析完再挂节点。
  const doc = new DOMParser().parseFromString(`<body>${sanitizeRich(html)}</body>`, "text/html");
  const box = document.createElement("div");
  box.append(...[...doc.body.childNodes].map((node) => document.importNode(node, true)));
  for (const span of [...box.querySelectorAll("span")]) span.replaceWith(...span.childNodes);
  for (const head of box.querySelectorAll("h1, h2, h3")) head.classList.add("bub-h");
  for (const a of box.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return box;
}

/** 路径链接：复制到剪贴板；气泡里的链接一律新窗口，别把内网通页面顶掉。 */
async function copyPath(path: string): Promise<void> {
  await copyText(path);
  toast(tr("已复制路径"));
}

/** 长消息折叠：只切类，不重渲染（滚动位置不跳）；展开状态不落盘。 */
function addFold(bub: HTMLElement, body: HTMLElement, text: string): void {
  const plain = hasRichMarkup(text) ? plainText(text) : text;
  if (plain.length <= 1600 && plain.split("\n").length <= 24) return;
  body.classList.add("clip");
  const more = h("button", "bub-more", tr("显示全文"));
  more.type = "button";
  more.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = body.classList.toggle("clip") === false;
    more.textContent = open ? tr("收起") : tr("显示全文");
  });
  bub.append(more);
}

/** 引用条摘要：富文本要先转纯文本，不能把标签写进引用里。 */
function excerptOf(e: Entry): string {
  const raw = e.kind === "note" ? (e.note?.title ?? "") : (e.text ?? e.file?.name ?? "");
  return (hasRichMarkup(raw) ? plainText(raw) : raw).slice(0, 120);
}
function quoteBlock(ref: { id: string; from: string; excerpt: string }): HTMLElement {
  const target = S.msgs.find((m) => m.id === ref.id);
  const box = h("div", "quote");
  const who = target ? (target.from.nodeId === S.view?.status?.nodeId ? tr("我") : ref.from) : tr("引用");
  box.append(h("span", "who", who), h("span", "ex", target?.recalled ? tr("原消息已撤回") : ref.excerpt));
  box.title = tr("点一下跳到原消息");
  box.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const node = mainEl.querySelector<HTMLElement>(`.msg[data-id="${ref.id}"]`);
    if (node) node.scrollIntoView({ block: "center", behavior: "smooth" });
    else toast(tr("原消息不在这段历史里"));
  });
  return box;
}

function messageMenu(x: number, y: number, e: Entry, t: Thread, mine: boolean): void {
  const items: { label: string; icon?: string; danger?: boolean; run: () => void }[] = [];
  if (e.kind === "note" && e.note) {
    // 记录包不支持撤回 / 引用；只给预览与失败重发。
    items.push({ label: tr("预览"), run: () => showNotePeek(e, t) });
    if (mine && e.state === "failed") items.push({ label: tr("重发"), icon: "retry", run: () => void resend(e) });
    openMenu(x, y, items);
    return;
  }
  if (e.text) items.push({ label: tr("复制文字"), icon: "copy", run: () => void copyText(e.text ?? "") });
  items.push({ label: tr("引用"), icon: "msg", run: () => startReply(e) });
  if (mine && e.state === "failed") items.push({ label: tr("重发"), icon: "retry", run: () => void resend(e) });
  if (mine && Date.now() - e.at <= 120_000) {
    items.push({ label: tr("撤回"), icon: "trash", danger: true, run: () => void recall(e, t) });
  }
  openMenu(x, y, items);
}

function startReply(e: Entry): void {
  S.replyTo = e;
  renderMain();
  textInput?.focus({ preventScroll: true });
}

/** 引用 / 撤回都要重拉：撤回了之后原文要从消息流里消失，只留灰条。 */
async function recall(e: Entry, t: Thread): Promise<void> {
  try {
    await postJson("/api/peer/recall", { peer: t.nodeId, id: e.id });
    await loadMessages(t.nodeId);
    await loadThreads();
    renderList();
    renderMain();
  } catch (err) {
    toast((err as Error).message);
  }
}

/**
 * 这条文件消息是不是图片：`"pic"` / `"gif"` / `null`（D305）。
 *
 * QQ 把图片、动图、表情做成三种元素（`PicMsgElem` / `GiphyMsgElem` / `FaceMsgElem`）；
 * 我们只有一种 `kind:"file"`，所以按 mime 分派 —— 分成三种 kind 会把回执、撤回、未读、
 * 折叠那一套全都要跟着分叉，不值当。
 */
function picKind(e: Entry): "gif" | "pic" | null {
  if (e.kind !== "file" || !e.file) return null;
  const mime = (e.file.mime || "").toLowerCase();
  if (mime === "image/gif" || /\.gif$/i.test(e.file.name)) return "gif";
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|bmp|avif)$/i.test(e.file.name)) return "pic";
  return null;
}

/**
 * 图片气泡：聊天里直接是图，不是文件卡片（D305）。
 *
 * 尺寸优先用消息里记着的 `w/h`（发/收时在本机读文件头算的）把位置先占住；小图当**表情包**
 * 画（不要边框、上限更小），大图按比例缩到气泡宽度以内。点一下看原图（D302 的弹窗），
 * 右键菜单（复制 / 引用 / 撤回）照旧在 `.msg` 上，不用另写。
 */
/** 图片加载完会把列表顶高：只要人还贴着底就重新钉住（翻历史时不打扰）。 */
function repinBottom(): void {
  if (!stickBottom) return;
  const stream = mainEl.querySelector<HTMLElement>(".stream");
  if (stream) stream.scrollTop = stream.scrollHeight;
}

function picBubble(e: Entry, mine: boolean): HTMLElement {
  const f = e.file!;
  // 表情包：小、方、而且不是动图（QQ 里 `FaceMsgElem` 与 `GiphyMsgElem` 是两种元素）。
  const square = f.w && f.h ? Math.max(f.w, f.h) / Math.min(f.w, f.h) <= 1.6 : false;
  const sticker = picKind(e) === "pic" && Boolean(f.w && f.h && Math.max(f.w, f.h) <= 200 && square);
  const wrap = h("div", `pic${sticker ? " sticker" : ""}`);
  const img = h("img");
  img.src = `/api/peer/file?id=${encodeURIComponent(e.id)}`;
  img.alt = f.name;
  img.loading = "lazy";
  img.decoding = "async";
  // 先按记着的宽高占位（等比缩到气泡宽度内），图没下来时也不会把整列消息顶下去。
  if (f.w && f.h) {
    const cap = sticker ? 150 : 300;
    const scale = Math.min(1, cap / Math.max(f.w, f.h));
    img.width = Math.max(1, Math.round(f.w * scale));
    img.height = Math.max(1, Math.round(f.h * scale));
  }
  img.title = tr("点一下看原图");
  img.addEventListener("click", () => previewEntry(e));
  // 图到了之后重新贴一次底（没有 w/h 的老消息加载前是 0 高）。
  img.addEventListener("load", repinBottom);
  // 取不到就退回文件卡片，别留一个破图标在那儿。
  img.addEventListener("error", () => {
    wrap.replaceChildren(fileCard(e, mine));
    repinBottom();
  });
  wrap.append(img);
  return wrap;
}

function fileCard(e: Entry, mine: boolean): HTMLElement {
  const f = e.file!;
  const card = h("div", "fcard");
  const icon = h("div", "ic");
  icon.append(ic(/^image\//.test(f.mime) ? "image" : "file"));
  const body = h("div");
  body.append(h("div", "nm", f.name), h("div", "sz", sizeOf(f.size)));
  // 点卡片 = 预览（D302：预览是这页自己的弹窗，不再借主界面的面板）。
  card.title = tr("点一下预览");
  card.style.cursor = "pointer";
  card.addEventListener("click", () => previewEntry(e));

  const foot = h("div", "fbot");
  const acts = h("span", "fbtns");
  if (mine) {
    // 文件不走 outbox（它有自己那套 token/分块/哈希），所以永远没有 receipt：
    // 自己发的就当「已发出」。
    const status: string = e.state ?? "sent";
    const done = status === "delivered" || status === "sent";
    foot.append(h("span", "", done ? tr("已送达") : status === "sending" ? tr("发送中…") : tr("发送失败")));
    if (done) {
      acts.append(actBtn(tr("预览"), () => previewEntry(e)), actBtn(tr("打开所在位置"), () => void revealFile(e)));
    } else if (status === "failed") {
      acts.append(actBtn(tr("重发"), () => void resend(e)));
    } else {
      acts.append(h("span", "act", tr("等一会")));
    }
  } else {
    foot.append(h("span", "", tr("对方发来")));
    const dl = h("a", "act", tr("下载"));
    dl.href = `/api/peer/file?id=${encodeURIComponent(e.id)}`;
    dl.download = f.name;
    dl.rel = "noopener";
    dl.addEventListener("click", (ev) => ev.stopPropagation());
    acts.append(actBtn(tr("预览"), () => previewEntry(e)), dl, actBtn(tr("打开所在位置"), () => void revealFile(e)));
  }
  foot.append(acts);
  body.append(foot);
  card.append(icon, body);
  return card;
}

/** 卡片右下角那颗小按钮：统一 `<button class="act">`，点它不要连累整张卡片的点击。 */
function actBtn(label: string, run: () => void): HTMLButtonElement {
  const b = h("button", "act", label);
  b.type = "button";
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    run();
  });
  return b;
}

/** 「打开所在位置」：让这台机器的文件管理器把它选出来（macOS 是 Finder 里的 `open -R`）。 */
async function revealFile(e: Entry): Promise<void> {
  try {
    await postJson("/api/peer/reveal", { id: e.id });
  } catch (err) {
    toast((err as Error).message);
  }
}

/** 文本类后缀：这些即使 mime 是 application/octet-stream 也当文本预览。 */
const TEXT_EXT = /\.(md|markdown|txt|log|json|ya?ml|toml|ini|csv|ts|tsx|js|jsx|mjs|css|html?|xml|py|go|rs|java|c|h|cpp|sh|bash|zsh|bat|ps1|diff|patch|sql|conf|env)$/i;

/**
 * 预览弹窗（D302）。**不再借主界面的预览面板**：那个要一个打开的会话、还会把内网通弹层关掉，
 * 看一张截图不值当。这里按类型自己画：图片 `<img>`、PDF `<iframe>`、文本 `<pre>`，
 * 其余说清楚「点下载」。
 */
/** 当前开着的那扇表格浮窗（同一时间只留一扇，和主界面 `sheetDock` 一个规矩）。 */
let sheetWin: SheetDialog | null = null;

/**
 * 一份「可以看的东西」：同一套渲染要伺候两种来源 ——
 * 内网通里的一条文件消息（`entryId`），和选择器里眼前这份**还没发出去**的本机文件（`path`）。
 */
interface PreviewSrc {
  name: string;
  mime: string;
  size: number;
  /** 取字节的地址（`/api/peer/file?id=` 或 `/api/peer/fs/raw?path=`）。 */
  url: string;
  entryId?: string;
  path?: string;
}

function previewEntry(e: Entry): void {
  const f = e.file;
  if (!f) return;
  showPreview({
    name: f.name,
    mime: f.mime,
    size: f.size,
    url: `/api/peer/file?id=${encodeURIComponent(e.id)}`,
    entryId: e.id,
  });
}

/** 选择器里「预览」：文件还在本机，没进历史，所以按路径取字节。 */
function previewLocal(file: BrowseEntry): void {
  showPreview({
    name: file.name,
    mime: file.mime ?? "",
    size: file.size,
    url: `/api/peer/fs/raw?path=${encodeURIComponent(file.path)}`,
    path: file.path,
  });
}

/**
 * 内网通的 Excel：开的是**本工程那扇表格浮窗**（`SheetDialog`，D166 那一套）。
 *
 * 凭据由 `/api/peer/sheet` 现发 —— 内网通页面没有会话，拿不到 `/api/preview` 的 grant；
 * 拿到 token 之后其余全走既有的 `/api/sheet/*`：看、查找、改格子、合并/插删行列都是同一份
 * 代码，不另写一个简化表格（D303 复审）。
 *
 * 和主界面的差别只有两处：`scale` 恒为 1（这页没有界面缩放），`onQuote` 不给（这里没有
 * 可以引用给 pi 的输入框）。
 */
async function openSheetWindow(src: PreviewSrc): Promise<void> {
  closeLayer();
  let grant: { token: string; path?: string };
  try {
    grant = await postJson<{ token: string; path?: string }>(
      "/api/peer/sheet",
      src.entryId ? { id: src.entryId } : { path: src.path },
    );
  } catch (err) {
    toast((err as Error).message);
    return;
  }
  const token = grant.token;
  sheetWin?.destroy();
  sheetWin = null;
  const dlg: SheetDialog = new SheetDialog({
    token,
    name: src.name,
    path: grant.path ?? src.path ?? "",
    raw: src.url,
    scale: () => 1,
    loadMeta: () => postJson("/api/sheet/meta", { token }),
    fetchWindow: (sheet, r0, r1, c0, c1) => postJson("/api/sheet/window", { token, sheet, r0, r1, c0, c1 }),
    findSheet: (sheet, q) => postJson("/api/sheet/find", { token, sheet, q }),
    mediaUrl: (sheet, id) => `/api/sheet/media?token=${encodeURIComponent(token)}&sheet=${encodeURIComponent(sheet)}&id=${encodeURIComponent(id)}`,
    saveSheet: (sheet, ops) => postJson("/api/sheet/edit", { token, sheet, ops }),
    saveStruct: (sheet, op) => postJson("/api/sheet/struct", { token, sheet, op }),
    page: { token },
    onOpen: async () => {
      await postJson("/api/peer/open", src.entryId ? { id: src.entryId } : { path: src.path });
    },
    onReveal: async () => {
      await postJson("/api/peer/reveal", src.entryId ? { id: src.entryId } : { path: src.path });
    },
    onReopen: () => void openSheetWindow(src),
    onClose: () => {
      if (sheetWin === dlg) sheetWin = null;
    },
    onRaise: () => {
      sheetWin?.root.classList.remove("front");
      dlg.root.classList.add("front");
    },
  });
  sheetWin = dlg;
  document.body.append(dlg.root);
  dlg.root.classList.add("front");
  dlg.open();
}

/**
 * 预览弹窗（D302）。**不借主界面的预览面板**：那个要一个打开的会话、还会把内网通弹层
 * 关掉，看一张截图不值当。这里按类型自己画：图片 `<img>`、PDF `<iframe>`、文本 `<pre>`，
 * Excel 交给上面那扇表格浮窗，其余说清楚「点下载」。
 */
function showPreview(src: PreviewSrc): void {
  if (/\.(xlsx|xlsm)$/i.test(src.name)) {
    void openSheetWindow(src);
    return;
  }
  closeLayer();
  const scrim = h("div", "scrim");
  scrim.addEventListener("click", closeLayer);
  const modal = h("div", "modal preview");
  const head = h("header");
  head.append(h("strong", "nm", src.name), iconBtn("close", tr("关掉预览"), closeLayer));
  const meta = h("div", "meta");
  meta.append(h("span", "", `${sizeOf(src.size)} · `), h("span", "", src.mime || tr("未知类型")));
  const body = h("div", "body");
  modal.append(head, meta, body);
  layerEl.append(scrim, modal);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    // 捕获阶段就把这一下吃掉：不冒泡到「Esc 关选择器」那条全局监听
    // （否则在预览里按 Esc，预览关了、下面的选择器也一起关了）。
    ev.stopPropagation();
    document.removeEventListener("keydown", onKey, true);
    closeLayer();
  };
  document.addEventListener("keydown", onKey, true);
  void fillPreview(body, src);
}

async function fillPreview(body: HTMLElement, src: PreviewSrc): Promise<void> {
  const name = src.name.toLowerCase();
  if (/^image\//.test(src.mime) || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name)) {
    const img = h("img");
    img.src = src.url;
    img.alt = src.name;
    body.append(img);
    return;
  }
  if (src.mime === "application/pdf" || name.endsWith(".pdf")) {
    const frame = h("iframe");
    frame.src = src.url;
    frame.title = src.name;
    body.append(frame);
    return;
  }
  const isText = src.mime.startsWith("text/") || TEXT_EXT.test(name);
  if (!isText) {
    body.append(h("div", "none", tr("这个类型在这儿看不了，点「下载」用别的程序打开")));
    return;
  }
  if (src.size > 2 * 1024 * 1024) {
    body.append(h("div", "none", tr("太大了（{p1}），点「下载」再看", { p1: sizeOf(src.size) })));
    return;
  }
  try {
    const res = await fetch(src.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body.append(h("pre", "", await res.text()));
  } catch (err) {
    body.append(h("div", "none", tr("读不出来：{p1}", { p1: (err as Error).message })));
  }
}

/** 引用条（P3）：换会话会重建，引用 / 取消引用只重画这一条。 */
function paintReplyBar(): void {
  if (!replyHost) return;
  replyHost.replaceChildren();
  const r = S.replyTo;
  replyHost.hidden = !r;
  if (!r) return;
  const bar = h("div", "replybar");
  const who = r.from.nodeId === S.view?.status?.nodeId ? tr("我") : r.from.nickname || r.from.nodeId.slice(0, 8);
  bar.append(h("span", "who", tr("回复 {p1}", { p1: who })), h("span", "ex", (r.text ?? r.file?.name ?? "").slice(0, 120)));
  bar.append(
    iconBtn("close", tr("取消引用"), () => {
      S.replyTo = null;
      paintReplyBar();
    }),
  );
  replyHost.append(bar);
}

function composeBox(t: Thread): HTMLElement {
  if (composeEl && composeFor === t.nodeId) {
    (composeEl.querySelector(".hintline") as HTMLElement | null)?.replaceChildren();
    paintReplyBar();
    return composeEl;
  }
  // 换会话：旧编辑器在 document 上挂着 mousedown / keydown，不拆会跟着整页活着。
  composer?.destroy();
  composer = null;
  composeFor = t.nodeId;
  const wrap = h("div", "compose");
  replyHost = h("div", "replyhost");
  replyHost.hidden = true;
  const box = h("div", "box");
  // 精简工具栏（#515）：粗 / 斜 / 下划线 / 删除线 / 列表 / 引用 / 代码块。行内代码与链接靠 Markdown 输入规则。
  const toolbar = h("div", "peer-tools");
  const body = h("div", "peer-rich");
  body.dataset.placeholder = tr("发给 {p1}", { p1: t.nickname });
  body.dataset.empty = "1";
  body.dataset.keep = "compose";
  const ed = new RichEditor({
    body,
    toolbar,
    tools: ["b", "i", "u", "s", "ul", "ol", "code", "quote"],
    onChange: () => onComposeChange(t.nodeId),
    onEnter: () => void send(),
    say: (text) => toast(text),
  });
  // P1：草稿从会话元数据里恢复（现在存的是净化过的 HTML；老草稿是纯文本，setHtml 接得住）。
  if (t.draft) ed.setHtml(t.draft);
  body.dataset.empty = isRichEmpty(ed.html()) ? "1" : "0";
  composer = ed;
  textInput = body;

  const bar2 = h("div", "bar2");
  const attach = iconBtn("attach", tr("发文件"), () => void openPicker(t.nodeId));
  const hint = h("span", "hintline", tr("Enter 发送，Shift+Enter 换行；拖文件或粘贴截图也行"));
  const btn = h("button", "send", tr("发送"));
  btn.type = "button";
  btn.addEventListener("click", () => void send());
  bar2.append(attach, hint, btn);
  box.append(toolbar, body, bar2);
  wrap.append(replyHost, box);
  sendBtn = btn;
  composeEl = wrap;
  paintReplyBar();

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
  // 粘贴截图：capture 抢在编辑器的 paste 之前，否则图片变成一段空文字。
  body.addEventListener(
    "paste",
    (ev) => {
      const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.kind === "file");
      if (!item) return;
      const f = item.getAsFile();
      if (!f) return;
      ev.preventDefault();
      ev.stopPropagation();
      void uploadBlob(tr("截图 {p1}.png", { p1: new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(/:/g, "-") }), f);
    },
    true,
  );
  return wrap;
}

/** 输入变化：typing 心跳 + 800ms 防抖存 HTML 草稿（#515）。 */
function onComposeChange(peerId: string): void {
  const ed = composer;
  if (!ed) return;
  const html = ed.html();
  const empty = isRichEmpty(html);
  if (textInput) textInput.dataset.empty = empty ? "1" : "0";
  // P3：输入中。只在本会话面板里发，不发就不发，对端 3 秒后自然过期。
  if (Date.now() - typingSentAt > 1500) {
    typingSentAt = Date.now();
    void postJson("/api/peer/typing", { peer: peerId }).catch(() => {});
  }
  // P1：草稿。停手 800 ms 落一次；空就是空串，不把 <p><br></p> 存进去。
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    const value = empty ? "" : html;
    if (byteLen(value) > MAX_TEXT_BYTES) return;
    if (value === (S.threads.find((x) => x.nodeId === peerId)?.draft ?? "")) return;
    void postJson("/api/peer/thread", { peer: peerId, draft: value }).catch(() => {});
  }, 800);
}

// ---------------------------------------------------------------- 发送

async function send(): Promise<void> {
  const id = S.thread;
  const ed = composer;
  if (!id || !ed || S.sending) return;
  const html = ed.html();
  if (isRichEmpty(html)) return;
  // 有格式就发 HTML（接收端按 hasRichMarkup 判定为富文本）；纯文字仍发纯文本，老气泡不变。
  const text = hasFormat(html) ? html : plainText(html);
  if (byteLen(text) > MAX_TEXT_BYTES) return toast(tr("太长（上限 32 KB），改用文件发"));
  S.sending = true;
  if (sendBtn) sendBtn.disabled = true;
  const reply = S.replyTo;
  try {
    const body: Record<string, unknown> = { peer: id, text };
    if (reply) {
      body.replyTo = {
        id: reply.id,
        from: reply.from.nickname || reply.from.nodeId.slice(0, 8),
        excerpt: excerptOf(reply),
      };
    }
    await postJson("/api/peer/send", body);
    ed.setHtml("");
    if (textInput) textInput.dataset.empty = "1";
    S.replyTo = null;
    // 草稿跟着消息一起清掉；不刷会话列表（下一轮轮询会自己拉）。
    void postJson("/api/peer/thread", { peer: id, draft: "" }).catch(() => {});
    forceBottom = true;
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
    // P2：同一个 id 重投，**不造新消息** —— 旧版这里是再 `POST /send` 一次，历史会多一条。
    if (e.kind === "text") await postJson("/api/peer/retry", { peer: S.thread, id: e.id });
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
    // 发完要看见它：不然文件卡片就落在视口外面（这条是用户报的 bug）。
    forceBottom = true;
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
    forceBottom = true;
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

  // D300：传文件不再要好友，只要对方在线（文件走的是对方在线时的 HTTP 直连）。
  const file = h("button", "btn", tr("传文件"));
  file.type = "button";
  file.disabled = !c.online;
  if (!c.online) file.title = tr("对方已离线，等他上线再试");
  file.addEventListener("click", () => void openPicker(c.nodeId, true));
  acts.append(file);
  if (c.incoming && !c.friend) {
    const ok = h("button", "btn pri", tr("接受"));
    ok.type = "button";
    ok.addEventListener("click", () => void friendAction(c.nodeId, "accept", true));
    const no = h("button", "btn", tr("忽略"));
    no.type = "button";
    no.addEventListener("click", () => void friendAction(c.nodeId, "remove"));
    acts.append(ok, no);
  } else if (!c.friend) {
    // 两颗按钮并存：快捷添加（文字即时）、两步加好友（可传文件）。已 quick 时快捷按钮变成不可点的状态标签，
    // 但「加为好友」要留着，让用户还能升级成真正的好友。
    const qadd = h("button", "btn pri", c.quick ? tr("已是快捷联系人") : tr("快捷添加（可聊天）"));
    qadd.type = "button";
    qadd.disabled = Boolean(c.quick) || !c.online;
    if (!c.online) qadd.title = tr("对方已离线，等他上线再试");
    if (!c.quick) qadd.addEventListener("click", () => void friendAction(c.nodeId, "quick", true));
    acts.append(qadd);
    const add = h("button", "btn", c.outgoing ? tr("再发一次申请") : tr("加为好友"));
    add.type = "button";
    add.disabled = !c.online;
    if (!c.online) add.title = tr("对方离线，等上线再申请");
    add.addEventListener("click", () => void friendAction(c.nodeId, "request", true));
    acts.append(add);
    // 只给「附近的人」里由在线表合并出来的无关系行：移除后写忽略名单，下一轮轮询不再补回来。
    if (!c.quick && !c.outgoing && c.online) {
      const hide = h("button", "btn", tr("从附近移除"));
      hide.type = "button";
      hide.addEventListener("click", () => void friendAction(c.nodeId, "remove"));
      acts.append(hide);
    }
  }
  const rename = h("button", "btn", tr("改备注名"));
  rename.type = "button";
  rename.addEventListener("click", () => renameModal(c.nodeId, c.nickname));
  acts.append(rename);
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
  let relation = tr("还没加好友");
  if (c.friend) relation = tr("好友");
  else if (c.outgoing) relation = tr("已发申请");
  else if (c.incoming) relation = tr("对方申请中");
  else if (c.quick) relation = tr("快捷联系人");
  const rows: [string, string][] = [
    [tr("nodeId"), c.nodeId],
    [tr("地址"), `${c.addr || "?"}:${c.livePort || c.port}`],
    [tr("主机名"), c.hostname || "?"],
    [tr("状态"), c.online ? tr("在线") : tr("离线")],
    [tr("关系"), relation],
  ];
  for (const [k, v] of rows) kv.append(h("span", "k", k), h("span", "v", v));
  card.append(kv, h("div", "note", tr("在线的人会自动出现在「附近的人」里；快捷添加只放行文字，文件只能发给好友。")));
  if (!c.online && !c.friend) card.append(h("div", "note", tr("对方已离线，等他上线再试")));
  detail.append(card);
  mainEl.append(detail);
}

async function friendAction(peer: string, action: "request" | "quick" | "accept" | "favorite" | "remove", on?: boolean): Promise<void> {
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

  // D303：自己的名字。改完立刻重播一次 announce，别人下一次刷新就看到新名字。
  const nameCard = h("div", "card");
  nameCard.append(h("h3", "", tr("名字")));
  const nameRow = h("div", "namerow");
  const nameInput = inputEl(tr("你的名字"));
  nameInput.value = st.nickname;
  nameInput.maxLength = 40;
  const saveName = h("button", "btn pri", tr("保存"));
  saveName.type = "button";
  const applyName = async (): Promise<void> => {
    const value = nameInput.value.trim();
    if (!value || value === st.nickname) return;
    try {
      await postJson("/api/peer/config", { nickname: value });
      await loadStatus();
      await loadThreads();
      renderAll();
      toast(tr("名字已改成「{p1}」", { p1: value }));
    } catch (err) {
      toast((err as Error).message);
    }
  };
  saveName.addEventListener("click", () => void applyName());
  nameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void applyName();
  });
  nameRow.append(nameInput, saveName);
  nameCard.append(nameRow, h("div", "note", tr("别人看到的就是这个名字；改完会立刻广播一次。")));
  detail.append(nameCard);

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
    toggle(tr("隐身"), tr("别人看不到你，但消息照收"), st.config.hidden, (on) => void setConfig({ hidden: on })),
    toggle(tr("免打扰"), tr("新消息不弹提醒，消息照收"), st.config.dnd, (on) => void setConfig({ dnd: on })),
    toggle(tr("暂停收文件"), tr("别人发来的文件会被拒收，消息不受影响"), st.config.pauseFiles, (on) => void setConfig({ pauseFiles: on })),
    toggle(tr("桌面通知"), tr("页面不在前面时弹系统通知（需要浏览器授权）"), notifyEnabled(), (on) => void setNotify(on)),
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

  const ig = h("div", "card");
  ig.append(h("h3", "", tr("忽略名单")));
  const iacts = h("div", "acts");
  iacts.style.padding = "12px 13px";
  const clear = h("button", "btn", tr("清空忽略名单"));
  clear.type = "button";
  clear.disabled = S.ignored.length === 0;
  clear.addEventListener("click", () => void clearIgnored());
  iacts.append(clear);
  ig.append(
    h("div", "note", tr("已忽略 {p1} 人。清空后，仍在线的人会重新出现在「附近的人」里。", { p1: fmtNum(S.ignored.length) })),
    iacts,
  );
  detail.append(ig);

  mainEl.append(detail);
}

async function clearIgnored(): Promise<void> {
  try {
    await postJson("/api/peer/ignored/clear");
    await loadContacts();
    renderAll();
  } catch (err) {
    toast((err as Error).message);
  }
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

/** P1：改置顶 / 静音 / 草稿。改完立刻重拉会话列表，行上的标记不会慢一拍。 */
async function patchThread(peer: string, patch: { pinned?: boolean; muted?: boolean; draft?: string }): Promise<void> {
  try {
    await postJson("/api/peer/thread", { peer, ...patch });
    await loadThreads();
    if (S.page === "msg") renderList();
  } catch (err) {
    toast((err as Error).message);
  }
}

function threadMenu(x: number, y: number, t: Thread): void {
  openMenu(x, y, [
    { label: tr("打开对话"), icon: "msg", run: () => openThread(t.nodeId) },
    // D300：传文件只要求对方在线，不再要求是好友。
    ...(t.online ? [{ label: tr("传文件"), icon: "attach", run: () => void openPicker(t.nodeId, true) }] : []),
    { label: t.pinned ? tr("取消置顶") : tr("置顶会话"), icon: "star", run: () => void patchThread(t.nodeId, { pinned: !t.pinned }) },
    { label: t.muted ? tr("取消免打扰") : tr("消息免打扰"), icon: "bellOff", run: () => void patchThread(t.nodeId, { muted: !t.muted }) },
    { label: tr("标记为已读"), icon: "check", run: () => void markRead(t).then(() => loadThreads()).then(() => { if (S.page === "msg") renderList(); }) },
    { label: tr("改备注名"), icon: "me", run: () => renameModal(t.nodeId, t.nickname) },
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
    ...(!c.friend && !c.incoming && !c.quick && c.online
      ? [{ label: tr("快捷添加（可聊天）"), icon: "userPlus", run: () => void friendAction(c.nodeId, "quick", true) }]
      : []),
    // D300：传文件只要求在线。
    ...(c.online ? [{ label: tr("传文件"), icon: "attach", run: () => void openPicker(c.nodeId, true) }] : []),
    { label: tr("改备注名"), icon: "me", run: () => renameModal(c.nodeId, c.nickname) },
    { label: c.favorite ? tr("取消收藏") : tr("收藏"), icon: "star", run: () => void friendAction(c.nodeId, "favorite", !c.favorite) },
    ...(!c.friend && !c.quick && !c.incoming && !c.outgoing && c.online
      ? [{ label: tr("从附近移除"), icon: "trash", danger: true, run: () => void friendAction(c.nodeId, "remove") }]
      : []),
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

/**
 * 改备注名（D303）：只改本机这份记录。对方改自己的名字不会覆盖它，我们改它也不会告诉对方。
 * 会话列表与联系人详情都走这一个弹窗。
 */
function renameModal(peerId: string, current: string): void {
  closeLayer();
  const scrim = h("div", "scrim");
  scrim.addEventListener("click", closeLayer);
  const modal = h("div", "modal");
  const head = h("header");
  head.append(h("strong", "", tr("改备注名")), iconBtn("close", tr("关掉"), closeLayer));
  const body = h("div", "body");
  const field = h("label", "field");
  const input = inputEl(tr("给他起个名字"));
  input.value = current;
  input.maxLength = 40;
  field.append(h("span", "", tr("备注名")), input);
  body.append(field, h("p", "note", tr("只改你这边的显示名，对方看不到，也不会被对方的改名冲掉。")));
  const foot = h("footer");
  const cancel = h("button", "btn", tr("取消"));
  cancel.type = "button";
  cancel.addEventListener("click", closeLayer);
  const save = h("button", "btn pri", tr("保存"));
  save.type = "button";
  const run = async (): Promise<void> => {
    const name = input.value.trim();
    if (!name) return;
    try {
      await postJson("/api/peer/friend", { peer: peerId, action: "rename", name });
      closeLayer();
      await loadContacts();
      await loadThreads();
      renderAll();
      toast(tr("备注名已改成「{p1}」", { p1: name }));
    } catch (err) {
      const line = h("p", "err", (err as Error).message);
      modal.insertBefore(line, foot);
    }
  };
  save.addEventListener("click", () => void run());
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void run();
  });
  foot.append(cancel, save);
  modal.append(head, body, foot);
  layerEl.append(scrim, modal);
  window.setTimeout(() => input.focus({ preventScroll: true }), 0);
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
    pickerPath.value = pickerDir;
    pickerPath.classList.remove("bad");
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

function selectEntry(li: HTMLElement, entry: BrowseEntry): void {
  for (const other of filesEl.children) other.classList.remove("on");
  li.classList.add("on");
  picked = entry;
  pickerSendBtn.disabled = false;
  pickerSel.textContent = entry.name;
  pickerPath.value = entry.path;
  pickerPath.classList.remove("bad");
}

function fileItem(entry: BrowseEntry): HTMLLIElement {
  const li = h("li", entry.dir ? "dir" : "");
  li.append(ic(entry.dir ? "folder" : "file"), h("span", "ell", entry.name));
  const tail = h("span", "racts");
  tail.append(h("span", "sz", entry.dir ? "" : sizeOf(entry.size)));
  if (!entry.dir) {
    // D304：文件行给两颗按钮 —— 发之前先看一眼（预览），或直接选中（选择）。
    const look = h("button", "", tr("预览"));
    look.type = "button";
    look.addEventListener("click", (ev) => {
      ev.stopPropagation();
      previewLocal(entry);
    });
    const pick = h("button", "", tr("选择"));
    pick.type = "button";
    pick.addEventListener("click", (ev) => {
      ev.stopPropagation();
      selectEntry(li, entry);
    });
    tail.append(look, pick);
  }
  li.append(tail);
  li.addEventListener("click", () => {
    if (entry.dir) {
      void browse(entry.path);
      return;
    }
    selectEntry(li, entry);
  });
  return li;
}

/**
 * 跳到路径（D304，照本工程文件管理器的 D153）：指向文件夹就进去；指向文件就进它的父目录、
 * 把那行标成 `.hit` 并**选中**它（在这里选中就等于「准备发给对方」）。找不到就地报错，列表不动。
 */
async function jumpTo(raw: string): Promise<void> {
  const value = raw.trim().replace(/^["'`]|["'`]$/g, "");
  if (!value) return;
  const bad = (): void => {
    pickerPath.classList.add("bad");
    toast(tr("找不到这个路径：{p1}", { p1: value }));
  };
  const asDir = await getJson<Browse & { ok: boolean }>(`/api/peer/fs?path=${encodeURIComponent(value)}`).catch(() => null);
  if (asDir) {
    await browse(value);
    return;
  }
  const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (cut <= 0) return bad();
  const dir = value.slice(0, cut);
  const base = value.slice(cut + 1);
  const listing = await getJson<Browse & { ok: boolean }>(`/api/peer/fs?path=${encodeURIComponent(dir)}`).catch(() => null);
  if (!listing) return bad();
  await browse(dir);
  const entry = (listing.entries ?? []).find((e) => e.name === base);
  const row = [...filesEl.querySelectorAll("li")].find(
    (li) => (li.querySelector(".ell") as HTMLElement | null)?.textContent === base,
  );
  if (!entry || !row) return bad();
  row.classList.add("hit");
  row.scrollIntoView({ block: "nearest" });
  if (!entry.dir) selectEntry(row, entry);
  pickerPath.value = entry.path;
  pickerPath.classList.remove("bad");
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
pickerGo.addEventListener("click", () => void jumpTo(pickerPath.value));
pickerPath.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    void jumpTo(pickerPath.value);
  } else {
    pickerPath.classList.remove("bad");
  }
});
pickerSendBtn.addEventListener("click", () => {
  if (picked) void sendPath(picked.path);
});
picker.addEventListener("click", (ev) => {
  if (ev.target === picker) closePicker();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  // 先关最上面那层：预览弹窗 / 菜单（`#layer`）优先于选择器 —— 否则在预览里按 Esc
  // 会把下面整个选择器关掉，用户还得重新找一遍文件。
  if (layerEl.childElementCount) return closeLayer();
  if (!picker.hidden) closePicker();
});

// ---------------------------------------------------------------- 启动 / 轮询

async function boot(): Promise<void> {
  document.title = tr("内网通 · pi");
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) node.textContent = tr(node.dataset.i18n ?? "");
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) node.title = tr(node.dataset.i18nTitle ?? "");
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n-aria]")) node.setAttribute("aria-label", tr(node.dataset.i18nAria ?? ""));
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    (node as HTMLInputElement).placeholder = tr(node.dataset.i18nPlaceholder ?? "");
  }
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
  // P4：启动时先报一次「人在」，别让自己在 10 分钟内就显示成离开。
  void postJson("/api/peer/presence").catch(() => {});
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
  void loadMessages().then(async () => {
    if (S.page === "msg" && msgSig() !== before) renderMain();
    // P1：贴底看 = 看见了。打了水位之后下一轮 /threads 会把未读清零。
    if (!document.hidden && stickBottom) {
      const t = threadOf(S.thread);
      if (t) await markRead(t);
    }
  });
}, 2500);

// P4：页面开着就每分钟报一次「人在」—— away 只在没人动 10 分钟后才成立。
const heartbeat = (): void => {
  if (document.hidden) return;
  void postJson("/api/peer/presence").catch(() => {});
};
window.setInterval(heartbeat, 60_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) heartbeat();
});

window.setInterval(() => {
  void loadTransfers().then(() => {
    if (S.page === "transfers") {
      renderList();
      renderMain();
    }
  });
}, 1200);
