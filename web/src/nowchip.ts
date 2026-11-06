/**
 * 「当前在哪」那颗（#96）：工作区色点 + **会话名** + 在线点 + 待处理角标。
 *
 * 会话名写在这颗上（#126）：四套壳的顶栏标题都被 CSS 藏了（`html[data-layout="a"] .topbar > .title`
 * 与 `html:not([data-layout="a"]) .topbar .title`），这颗是名字唯一看得见的地方。工作区名只留在
 * `aria-label` / `title` 上，读屏和悬停照样拿得到；颜色仍然标识工作区。
 *
 * 它是四套布局（#97 / #98）共用的那一颗，所以组件只吃挂载点、不读全局状态 —— 数据映射在
 * 纯函数里（`nowChipView`），DOM 类只负责把一份 view 抹到自己的节点上。切会话、改工作区名、
 * 待处理数变化，重画一次 `render()` 就全变。
 *
 * 颜色从这里来：`hash(组 id) % 6` 取既有六个 accent —— 不新造调色板（见 palette.ts）。
 */
import { ACCENTS, ACCENT_IDS, type AccentId } from "./palette.ts";
import { tr } from "./i18n/index.ts";
import type { WorkspaceState, WsGroup } from "./types.ts";

/** 工作区色点可用的六个 accent id（顺序就是把 id 散列上去的桶）。 */
export const WS_ACCENTS = ACCENT_IDS;

/** 组 id → 稳定颜色。同一个工作区在任何设备、任何会话里都是同一色。 */
export function wsAccent(id: string | null | undefined): AccentId {
  const text = String(id ?? "");
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ACCENT_IDS[(h >>> 0) % ACCENT_IDS.length];
}

/** 与桥的 `normalizePath` 同一套折叠规则：反斜杠、重复斜杠、盘符根。 */
export function normalizeWsPath(value: unknown): string {
  let s = String(value ?? "").trim().replace(/\\/g, "/");
  if (!s) return "";
  const unc = s.startsWith("//");
  s = s.replace(/\/{2,}/g, "/");
  if (unc) s = `/${s}`;
  s = s.replace(/\/+$/, "");
  if (!s) return "/";
  return /^[a-zA-Z]:$/.test(s) ? `${s}/` : s;
}

/** 工作区显示名：手命名 > 工程根目录名 > 占位（没组 = 未分组）。 */
export function wsTitle(group: WsGroup | null | undefined): string {
  if (!group) return tr("未分组");
  const named = String(group.name ?? "").trim();
  if (named) return named;
  const key = normalizeWsPath(group.key);
  const base = key.replace(/[\\/]+$/, "").split("/").pop() ?? "";
  if (base) return base;
  return group.manual ? tr("未命名工作区") : tr("未分组");
}

export interface NowSession {
  id: string;
  name: string;
  cwd?: string | null;
  ws?: string;
}

/**
 * 这个会话站在哪个工作区。信号按新鲜度排：override（拖动刚落下来）> 列表里的 `ws`
 * （`sessions.list` 的权威值）> 会话快照的 `ws`（`subscribe` 回来的 state 可能不带）>
 * 按 cwd 反查桥发来的工程根缓存。都没有 → null（显示「未分组」）。
 */
export function wsOf(
  session: NowSession | null | undefined,
  workspace: WorkspaceState,
  listedWs?: string | null,
): WsGroup | null {
  if (!session) return null;
  const groups = workspace.groups ?? [];
  const wanted = [workspace.overrides?.[session.id], listedWs, session.ws].find((v): v is string => Boolean(v));
  if (wanted) {
    const hit = groups.find((g) => g.id === wanted);
    if (hit) return hit;
  }
  const cwd = normalizeWsPath(session.cwd ?? "");
  if (!cwd) return null;
  const root = workspace.keys?.[cwd.toLowerCase()];
  if (!root) return null;
  const id = normalizeWsPath(root).toLowerCase();
  return groups.find((g) => g.id === id) ?? null;
}

export interface NowChipPending {
  text: string;
  title: string;
}

export interface NowChipInput {
  session: NowSession | null;
  group: WsGroup | null;
  connected: boolean;
  running: boolean;
  owned: boolean;
  /** 只放「待处理」那一档（待回答 / 待确认），与树里的角标同一份文案。 */
  pending: NowChipPending | null;
}

export interface NowChipView {
  hidden: boolean;
  workspace: string;
  name: string;
  accent: AccentId | null;
  /** 与顶栏那颗状态点同一套优先级：离线 > 运行中 > 本地会话。 */
  live: "" | "live" | "busy" | "bad";
  badge: NowChipPending | null;
  /** 读屏：工作区名，会话名，当前会话。 */
  label: string;
  title: string;
}

export function nowChipView(input: NowChipInput): NowChipView {
  const s = input.session;
  if (!s) {
    return { hidden: true, workspace: "", name: "", accent: null, live: "", badge: null, label: "", title: "" };
  }
  const name = String(s.name ?? "").trim() || s.id;
  const workspace = wsTitle(input.group);
  const label = input.group
    ? tr("{p1}，{p2}，当前会话", { p1: workspace, p2: name })
    : tr("{p2}，当前会话", { p2: name });
  return {
    hidden: false,
    workspace,
    name,
    accent: input.group ? wsAccent(input.group.id) : null,
    live: !input.connected ? "bad" : input.running ? "busy" : input.owned ? "live" : "",
    badge: input.pending ?? null,
    label,
    title: label,
  };
}

/**
 * 把 view 抹到 DOM。挂载点由调用方给（topbar、竖列旁、色点条上……都行），自己不找位置，
 * 也不注册全局手势 —— 票面措辞里它是指示，不是按钮。
 */
export class NowChip {
  readonly el: HTMLElement;
  private readonly dot: HTMLSpanElement;
  private readonly ws: HTMLSpanElement;
  private readonly live: HTMLSpanElement;
  private readonly badge: HTMLSpanElement;

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "now-chip";
    this.el.setAttribute("role", "group");
    this.dot = document.createElement("span");
    this.dot.className = "now-dot";
    this.ws = document.createElement("span");
    this.ws.className = "now-name";
    this.live = document.createElement("span");
    this.live.className = "now-live";
    this.badge = document.createElement("span");
    this.badge.className = "badge wait";
    this.el.append(this.dot, this.ws, this.live, this.badge);
    host.append(this.el);
  }

  render(view: NowChipView): void {
    this.el.hidden = view.hidden;
    if (view.hidden) return;
    this.dot.hidden = view.accent === null;
    if (view.accent) this.dot.style.background = ACCENTS[view.accent].accent;
    this.ws.textContent = view.name;
    this.live.hidden = !view.live;
    this.live.className = view.live ? `now-live ${view.live}` : "now-live";
    this.badge.hidden = view.badge === null;
    this.badge.textContent = view.badge?.text ?? "";
    this.badge.title = view.badge?.title ?? "";
    this.el.setAttribute("aria-label", view.label);
    this.el.title = view.title;
  }
}
