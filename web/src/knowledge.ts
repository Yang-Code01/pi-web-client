/**
 * 知识库：BuildHub（vibe-hub.org 的 MIT 克隆站）那套内容搬进客户端后的整页面板。
 *
 * 三件事与前端的约定（`tools/sync-knowledge.mjs` 负责生成，别在运行时改数据）：
 * - 数据是静态文件：`/knowledge/terms.zh.json`、`terms.en.json`、`prompts.json`、`skills.json`，
 *   打开面板时一次 `fetch` 全量、内存里建索引；565 条概念 + 19 条提示词 + 26 个技能 ≈ 6 MB（本地网络）。
 * - 正文是站内现成的 HTML（概念的结构图、变体卡、场景图都是纯 CSS 画的），样式在
 *   `/knowledge/site.css`，**第一次打开面板时才挂 `<link>`**，已按 `.kb-site` 作用域缩过（见脚本头注释）。
 *   所以这里 `innerHTML` 的是我们自己生成的 JSON，不是用户输入。
 * - 图片 / 视频封面已经转成 webp 落在 `/knowledge/assets/`，站内 `<video>` 在导出阶段就换成了 `<img>`。
 *
 * 交互边界：只读。两个联动的落点都是「填进输入框，不发送」——
 * - 插入当前回话：`handoff.prefill()`；没有激活会话时它自己会转去开新会话（app.ts 的行为）；
 * - 新开回话：`handoff.newSessionWith()`，建好会话把文字预填进去，同样不发。
 *
 * 深链：`/knowledge/<slug>`（概念）、`/knowledge/prompt/<id>`、`/knowledge/skill/<id>`。
 * `open()` 时按当前 pathname 选中，之后每次选中都 `replaceState`，刷新 / 分享 / agent 引用都能直达。
 */
import { createEl as el } from "./chat.ts";
import { icon } from "./icons.ts";
import { errText, tr } from "./i18n/index.ts";
import "./knowledge.css";
import { retireOverlay, trapEscape } from "./modal.ts";

/** 「交给 agent」的两个出口，与 jira.ts 的同名接口一致（app.ts 统一传 `this.prefill / this.newSessionWith`）。 */
export interface KnowledgeHandoff {
  /** 只把文字放进当前输入框，不发送；没有激活会话时由宿主转去新会话。 */
  prefill(text: string, name?: string): void;
  /** 开一个新会话，建好后预填，不自动发送。`name` 预填进新会话的名字框。 */
  newSessionWith(text: string, name?: string): void;
}

export interface KnowledgeHost {
  handoff?: KnowledgeHandoff;
  onClose?: () => void;
}

type KbKind = "term" | "prompt" | "skill";
type KbTab = "all" | KbKind;
type KbLocale = "zh" | "en";

interface KbSection {
  title: string;
  html: string;
  stageHtml?: string;
  parts?: unknown[];
  variants?: unknown[];
  scenes?: unknown[];
  references?: unknown[];
}

interface KbTerm {
  slug: string;
  name: string;
  en: string;
  quoteLabel: string;
  quote: string;
  summaryLead: string;
  summaryRest: string;
  aliases: string[];
  demoHtml: string;
  sections: KbSection[];
}

interface KbPrompt {
  id: string;
  name: string;
  category: string;
  tagline: string;
  prompt: string;
  why?: string[];
  example?: string;
  pitfalls?: string[];
  bestFor?: string;
  models?: string;
  tags?: string[];
}

interface KbSkill {
  id: string;
  name: string;
  category: string;
  tagline: string;
  overview: string;
  features?: string[];
  useCases?: string[];
  bestFor?: string;
  pricing?: string;
  platform?: string;
  author?: string;
  repo?: string;
  install?: string;
  installs?: string;
  tags?: string[];
  logo?: string;
}

interface KbCategory<T> {
  key: string;
  label: string;
  prompts?: T[];
  skills?: T[];
}

/** prompts.json / skills.json 的顶层形状：{ title, subtitle, categories: [...] }。 */
interface KbDoc<T> {
  title?: string;
  subtitle?: string;
  categories: KbCategory<T>[];
}

interface KbData {
  zh: KbTerm[];
  en: KbTerm[];
  prompts: KbDoc<KbPrompt>;
  skills: KbDoc<KbSkill>;
}

/** 列表里的一行：概念 / 提示词 / 技能统一成这个形状，搜索和渲染都只认它。 */
interface Entry {
  key: string;
  kind: KbKind;
  name: string;
  sub: string;
  hay: string;
  term?: KbTerm;
  prompt?: KbPrompt;
  skill?: KbSkill;
  category?: string;
}

const SITE_CSS = "/knowledge/site.css";
const DATA_FILES = {
  zh: "/knowledge/terms.zh.json",
  en: "/knowledge/terms.en.json",
  prompts: "/knowledge/prompts.json",
  skills: "/knowledge/skills.json",
} as const;

/** 站点样式表只在第一次打开时挂一次；失败也 resolve —— 正文没样式，但内容要能看。 */
let cssOnce: Promise<void> | null = null;
function loadSiteCss(): Promise<void> {
  cssOnce ??= new Promise<void>((resolve) => {
    if (document.head.querySelector(`link[href="${SITE_CSS}"]`)) {
      resolve();
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = SITE_CSS;
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.append(link);
  });
  return cssOnce;
}

/** 数据全量只拉一次（面板关掉再开不重复下 6 MB）。失败时清空缓存，下次能重试。 */
let dataOnce: Promise<KbData> | null = null;
function loadData(): Promise<KbData> {
  if (dataOnce) return dataOnce;
  const job = (async (): Promise<KbData> => {
    const [zh, en, prompts, skills] = await Promise.all([
      getJson<KbTerm[]>(DATA_FILES.zh),
      getJson<KbTerm[]>(DATA_FILES.en),
      getJson<KbDoc<KbPrompt>>(DATA_FILES.prompts),
      getJson<KbDoc<KbSkill>>(DATA_FILES.skills),
    ]);
    return { zh, en, prompts, skills };
  })();
  dataOnce = job;
  job.catch(() => {
    if (dataOnce === job) dataOnce = null;
  });
  return job;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** 把 HTML 片段压成一行纯文本（列表副标题、搜索索引都用它）。 */
function plain(html: string, max = 120): string {
  const text = (html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const lower = (v: string | undefined): string => (v ?? "").toLowerCase();

function kindLabel(kind: KbKind): string {
  if (kind === "prompt") return tr("提示词");
  if (kind === "skill") return tr("技能");
  return tr("概念");
}

/** 概念 / 提示词 / 技能 → 深链路径。 */
function pathOf(kind: KbKind, id: string): string {
  if (kind === "prompt") return `/knowledge/prompt/${encodeURIComponent(id)}`;
  if (kind === "skill") return `/knowledge/skill/${encodeURIComponent(id)}`;
  return `/knowledge/${encodeURIComponent(id)}`;
}

/** pathname → 想要选中的那条（`null` 表示「打开面板，但不指定」）。 */
function fromPath(pathname: string): { kind: KbKind; id: string } | null {
  const m = /^\/knowledge\/?(.*)$/.exec(pathname);
  if (!m) return null;
  const rest = m[1].replace(/\/$/, "");
  if (!rest) return { kind: "term", id: "" };
  const prompt = /^prompt\/(.+)$/.exec(rest);
  if (prompt) return { kind: "prompt", id: decodeURIComponent(prompt[1]) };
  const skill = /^skill\/(.+)$/.exec(rest);
  if (skill) return { kind: "skill", id: decodeURIComponent(skill[1]) };
  return { kind: "term", id: decodeURIComponent(rest) };
}

function entriesOf(data: KbData, locale: KbLocale): Entry[] {
  const terms = locale === "en" && data.en.length ? data.en : data.zh;
  const out: Entry[] = [];
  for (const t of terms) {
    out.push({
      key: `term:${t.slug}`,
      kind: "term",
      name: t.name,
      sub: plain(t.summaryLead || t.quote || t.sections[0]?.title || "", 110),
      hay: [
        t.name,
        t.en,
        t.slug,
        ...(t.aliases ?? []),
        t.quote,
        t.summaryLead,
        t.summaryRest,
      ]
        .map(lower)
        .join("\n"),
      term: t,
    });
  }
  for (const cat of data.prompts.categories) {
    for (const p of cat.prompts ?? []) {
      out.push({
        key: `prompt:${p.id}`,
        kind: "prompt",
        name: p.name,
        sub: plain(p.tagline || "", 110),
        hay: [p.name, p.id, p.category, cat.label, p.tagline, p.prompt, p.bestFor, ...(p.tags ?? [])]
          .map(lower)
          .join("\n"),
        prompt: p,
        category: cat.label,
      });
    }
  }
  for (const cat of data.skills.categories) {
    for (const s of cat.skills ?? []) {
      out.push({
        key: `skill:${s.id}`,
        kind: "skill",
        name: s.name,
        sub: plain(s.tagline || "", 110),
        hay: [
          s.name,
          s.id,
          s.category,
          cat.label,
          s.tagline,
          s.overview,
          s.bestFor,
          s.author,
          ...(s.tags ?? []),
        ]
          .map(lower)
          .join("\n"),
        skill: s,
        category: cat.label,
      });
    }
  }
  return out;
}

/**
 * 「交给 agent」那段文字。概念给的是能当上下文用的一小段；提示词直接把提示词正文交出去
 * （复制走它才是有用的）；技能给概述 + 安装命令。
 */
// i18n-ignore-start 插进输入框、发给模型的正文，跟会话语言走，不该随界面语言变（D206 同类）
function handoffText(entry: Entry): string {
  const link = `${location.origin}${pathOf(entry.kind, entry.term?.slug ?? entry.prompt?.id ?? entry.skill?.id ?? "")}`;
  if (entry.term) {
    const t = entry.term;
    const lines = [`知识库 · ${t.name}${t.en ? `（${t.en}）` : ""}`];
    if (t.summaryLead) lines.push(`${t.summaryLead}${t.summaryRest ? ` ${t.summaryRest}` : ""}`);
    if (t.quote) lines.push(`${t.quoteLabel || tr("你可能会说")}：「${plain(t.quote, 200)}」`);
    if (t.aliases.length) lines.push(`${tr("也常被叫作")}：${t.aliases.join(" / ")}`);
    lines.push(`${tr("出处")}：${link}`);
    return lines.join("\n");
  }
  if (entry.prompt) {
    const p = entry.prompt;
    return [plain(p.tagline, 200), "", p.prompt].join("\n");
  }
  const s = entry.skill;
  if (!s) return entry.name;
  const lines = [`知识库 · ${tr("技能")}「${s.name}」— ${plain(s.tagline, 120)}`];
  if (s.overview) lines.push("", plain(s.overview, 600));
  if (s.install) lines.push("", `${tr("安装")}：${s.install}`);
  if (s.repo) lines.push(`${tr("仓库")}：${s.repo}`);
  return lines.join("\n");
}
// i18n-ignore-end

/**
 * 语言自称：切到哪种界面语言，按钮上都写它自己的名字（同 i18n/index.ts 的 LANGS）。
 * 它是语言名，不是界面文案，所以不走 tr()。
 */
const LANG_LABEL: Record<"zh" | "en", string> = { zh: "中", en: "EN" };

/** 新会话名字框里的名字：短一点，别把整段提示词塞进去。 */
function nameOf(entry: Entry): string {
  if (entry.term) return entry.term.name.slice(0, 24);
  if (entry.prompt) return entry.prompt.name.slice(0, 24);
  return (entry.skill?.name ?? entry.name).slice(0, 24);
}

let current: KnowledgePanel | null = null;

/** 打开知识库（单例：已经开着就把它提到前面，不叠第二层）。 */
export function openKnowledge(host: KnowledgeHost = {}): void {
  if (current) {
    current.focusSearch();
    current.onClose = host.onClose ?? null;
    return;
  }
  current = new KnowledgePanel(host);
  current.mount();
}

class KnowledgePanel {
  onClose: (() => void) | null = null;
  private host: KnowledgeHost;
  private root: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private paneEl: HTMLElement | null = null;
  private crumbEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private langEl: HTMLElement | null = null;
  private data: KbData | null = null;
  private entries: Entry[] = [];
  private tab: KbTab = "all";
  private query = "";
  private locale: KbLocale = "zh";
  private selected: Entry | null = null;
  private loading = false;
  private error = "";
  private handoffButtons: HTMLButtonElement[] = [];
  private disposeEsc: (() => void) | null = null;
  private themeWatch: MutationObserver | null = null;
  private readonly keyHandler = (ev: KeyboardEvent): void => this.onKey(ev);

  constructor(host: KnowledgeHost) {
    this.host = host;
    this.onClose = host.onClose ?? null;
    this.locale = /^en/i.test(navigator.language) ? "en" : "zh";
  }

  // ---------------------------------------------------------------- 外壳

  mount(): void {
    // 不打 data-mac-surface：那是给「遮罩 + 居中卡片」用的，mac 主题会给它铺一层
    // --mac-scrim 并把第一个子元素当窗口卡片，整页浮层会被压成一张半透明的纸。
    const back = el("div", "kb-back");
    const bar = el("div", "kb-bar");
    const brand = el("div", "kb-brand");
    brand.append(icon("book", { size: 15 }), el("span", undefined, tr("知识库")));
    const sub = el("div", "kb-sub");
    this.noteEl = el("p", "kb-note", tr("正在载入知识库…"));
    this.noteEl.hidden = false;

    const lang = el("div", "kb-lang");
    for (const id of ["zh", "en"] as const) {
      const btn = el("button", undefined, LANG_LABEL[id]);
      btn.dataset.lang = id;
      btn.onclick = () => this.setLocale(id);
      lang.append(btn);
    }
    this.langEl = lang;

    const close = el("button", "kb-close");
    close.title = tr("关闭（Esc）");
    close.setAttribute("aria-label", close.title);
    close.append(icon("close", { size: 14 }));
    close.onclick = () => this.close();

    const spacer = el("div", "kb-spacer");
    bar.append(brand, spacer, sub, lang, close);

    const body = el("div", "kb-body");
    const side = el("div", "kb-side");
    const searchWrap = el("div", "kb-search");
    const search = el("input");
    search.type = "search";
    search.placeholder = tr("搜索概念、提示词、技能（按 / 聚焦）");
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.renderList();
    });
    search.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      // Esc 先清搜索，再按一次才关面板 —— 别让人一按就把整页收了。
      ev.stopPropagation();
      if (search.value) {
        search.value = "";
        this.query = "";
        this.renderList();
      } else {
        this.close();
      }
    });
    searchWrap.append(search);
    this.searchEl = search;

    this.tabsEl = el("div", "kb-tabs");
    this.listEl = el("div", "kb-list");
    this.countEl = el("div", "kb-count");
    side.append(searchWrap, this.tabsEl, this.listEl, this.countEl);

    const detail = el("div", "kb-detail");
    const tools = el("div", "kb-tools");
    this.crumbEl = el("div", "kb-crumb", tr("从左边选一条"));
    const toolsSpacer = el("div", "kb-spacer");
    const insert = el("button", "kb-btn primary", tr("插入当前回话"));
    insert.title = tr("把这条内容填进当前输入框，不发送");
    insert.onclick = () => this.handoff("prefill");
    const fresh = el("button", "kb-btn", tr("新开回话"));
    fresh.title = tr("开一个新会话并预填，不发送");
    fresh.onclick = () => this.handoff("newSessionWith");
    const copy = el("button", "kb-btn", tr("复制"));
    copy.title = tr("只复制文字到剪贴板");
    copy.onclick = () => void this.copy();
    this.handoffButtons = [insert, fresh];
    for (const b of this.handoffButtons) b.disabled = true;
    tools.append(this.crumbEl, toolsSpacer, insert, fresh, copy);
    this.paneEl = el("div", "kb-pane");
    detail.append(tools, this.paneEl);

    body.append(side, detail);
    back.append(bar, this.noteEl, body);
    this.root = back;

    const app = document.getElementById("app") ?? document.body;
    app.append(back);
    document.addEventListener("keydown", this.keyHandler, true);
    this.disposeEsc = trapEscape(() => this.close());
    this.themeWatch = new MutationObserver(() => this.paintTheme());
    this.themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    this.renderTabs();
    this.renderShellState();
    this.focusSearch();
    void this.boot();
  }

  close(): void {
    if (!this.root) return;
    document.removeEventListener("keydown", this.keyHandler, true);
    this.disposeEsc?.();
    this.disposeEsc = null;
    this.themeWatch?.disconnect();
    this.themeWatch = null;
    // 关掉就把地址还原，别让用户按刷新又跳回来。
    if (location.pathname.startsWith("/knowledge")) {
      history.replaceState(null, "", "/");
    }
    retireOverlay(this.root);
    this.root = null;
    if (current === this) current = null;
    const back = this.onClose;
    this.onClose = null;
    back?.();
  }

  focusSearch(): void {
    this.searchEl?.focus();
    this.searchEl?.select();
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.root || ev.defaultPrevented || ev.isComposing) return;
    const target = ev.target as HTMLElement | null;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (ev.key === "/" && !typing) {
      ev.preventDefault();
      this.searchEl?.focus();
    }
  }

  // ---------------------------------------------------------------- 数据

  private async boot(): Promise<void> {
    this.loading = true;
    this.renderShellState();
    try {
      const [data] = await Promise.all([loadData(), loadSiteCss()]);
      this.data = data;
      this.entries = entriesOf(data, this.locale);
      this.loading = false;
      this.renderTabs();
      this.renderShellState();
      this.pickInitial();
    } catch (err) {
      this.loading = false;
      this.error = errText(err);
      this.renderShellState();
    }
  }

  /** 打开时按地址选；地址没指定就选当前分类的第一条（别给一张空白页）。 */
  private pickInitial(): void {
    const want = fromPath(location.pathname);
    if (want && want.id) {
      const key = `${want.kind}:${want.id}`;
      const hit = this.entries.find((e) => e.key === key);
      if (hit) {
        this.select(hit, false);
        return;
      }
    }
    const first = this.filtered()[0] ?? this.entries[0];
    if (first) this.select(first, false);
  }

  private setLocale(next: KbLocale): void {
    if (next === this.locale || !this.data) return;
    this.locale = next;
    const prev = this.selected;
    this.entries = entriesOf(this.data, next);
    this.renderTabs();
    this.renderShellState();
    const again = prev ? this.entries.find((e) => e.key === prev.key) : null;
    const pick = again ?? this.filtered()[0] ?? null;
    if (pick) this.select(pick, true);
  }

  private filtered(): Entry[] {
    const tokens = this.query.split(/\s+/).filter(Boolean);
    return this.entries.filter((e) => {
      if (this.tab !== "all" && e.kind !== this.tab) return false;
      return tokens.every((t) => e.hay.includes(t));
    });
  }

  // ---------------------------------------------------------------- 渲染

  private renderShellState(): void {
    const note = this.noteEl;
    if (note) {
      if (this.loading) {
        note.hidden = false;
        note.classList.remove("bad");
        note.textContent = tr("正在载入知识库…");
      } else if (this.error) {
        note.hidden = false;
        note.classList.add("bad");
        note.textContent = tr("知识库数据没读进来：{p1}。在 web 下跑一次 npm run knowledge:sync 再试。", {
          p1: this.error,
        });
      } else {
        note.hidden = true;
      }
    }
    const sub = this.root?.querySelector<HTMLElement>(".kb-sub");
    if (sub && this.data) {
      const terms = this.locale === "en" && this.data.en.length ? this.data.en.length : this.data.zh.length;
      const prompts = this.data.prompts.categories.reduce((n, c) => n + (c.prompts?.length ?? 0), 0);
      const skills = this.data.skills.categories.reduce((n, c) => n + (c.skills?.length ?? 0), 0);
      sub.textContent = tr("{p1} 个概念 · {p2} 条提示词 · {p3} 个技能", {
        p1: terms,
        p2: prompts,
        p3: skills,
      });
    }
    for (const btn of this.langEl?.querySelectorAll<HTMLButtonElement>("button") ?? []) {
      btn.classList.toggle("on", btn.dataset.lang === this.locale);
    }
    this.renderList();
  }

  private renderTabs(): void {
    const tabs = this.tabsEl;
    if (!tabs) return;
    const counts: Record<KbTab, number> = { all: this.entries.length, term: 0, prompt: 0, skill: 0 };
    for (const e of this.entries) counts[e.kind] += 1;
    const defs: Array<[KbTab, string]> = [
      ["all", tr("全部")],
      ["term", tr("概念")],
      ["prompt", tr("提示词")],
      ["skill", tr("技能")],
    ];
    tabs.replaceChildren(
      ...defs.map(([id, label]) => {
        const btn = el("button", "kb-tab" + (this.tab === id ? " on" : ""), `${label} ${counts[id]}`);
        btn.dataset.tab = id;
        btn.onclick = () => {
          if (this.tab === id) return;
          this.tab = id;
          this.renderTabs();
          const keep = this.selected && (id === "all" || this.selected.kind === id);
          this.renderList();
          if (!keep) {
            const first = this.filtered()[0];
            if (first) this.select(first, true);
            else this.clearSelection();
          }
        };
        return btn;
      }),
    );
  }

  /** 列表只重建行，滚动位置在筛选不变时保持不动（键盘上下走的时候不跳）。 */
  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    const rows = this.filtered();
    const frag = document.createDocumentFragment();
    for (const entry of rows) {
      const row = el("div", "kb-row" + (this.selected?.key === entry.key ? " on" : ""));
      row.dataset.key = entry.key;
      const top = el("div", "kb-row-top");
      top.append(el("div", "kb-row-name", entry.name), el("div", "kb-row-kind", kindLabel(entry.kind)));
      row.append(top);
      if (entry.sub) row.append(el("div", "kb-row-sub", entry.sub));
      row.onclick = () => this.select(entry, true);
      frag.append(row);
    }
    list.replaceChildren(frag);
    if (this.countEl) {
      this.countEl.textContent = this.query
        ? tr("匹配 {p1} 条", { p1: rows.length })
        : tr("共 {p1} 条", { p1: rows.length });
    }
  }

  private clearSelection(): void {
    this.selected = null;
    if (this.crumbEl) this.crumbEl.textContent = tr("从左边选一条");
    for (const b of this.handoffButtons) b.disabled = true;
    this.renderList();
    if (this.paneEl) {
      this.paneEl.replaceChildren(this.emptyState());
    }
    this.syncUrl(null);
  }

  private emptyState(): HTMLElement {
    const box = el("div", "kb-empty");
    box.append(el("div", undefined, tr("左边挑一条：概念看结构图与用法，提示词直接能拿去用。")));
    const hint = el("div", undefined, "");
    const kbd = el("kbd", undefined, "/");
    hint.append(kbd, document.createTextNode(` ${tr("跳到搜索，Esc 关闭")}`));
    box.append(hint);
    return box;
  }

  private select(entry: Entry, syncUrl: boolean): void {
    this.selected = entry;
    this.renderList();
    if (this.crumbEl) {
      this.crumbEl.textContent = `${kindLabel(entry.kind)} · ${entry.name}`;
    }
    for (const b of this.handoffButtons) b.disabled = !this.host.handoff;
    if (this.paneEl) {
      const site = el("div", "kb-site");
      this.paintTheme(site);
      if (entry.term) site.append(this.termView(entry.term));
      else if (entry.prompt) site.append(this.promptView(entry.prompt, entry.category ?? ""));
      else if (entry.skill) site.append(this.skillView(entry.skill, entry.category ?? ""));
      this.paneEl.replaceChildren(site);
      this.paneEl.scrollTop = 0;
    }
    if (syncUrl) this.syncUrl(entry);
  }

  private syncUrl(entry: Entry | null): void {
    const path = entry ? pathOf(entry.kind, entry.term?.slug ?? entry.prompt?.id ?? entry.skill?.id ?? "") : "/";
    if (location.pathname === path) return;
    history.replaceState(null, "", path);
  }

  /** 站内深色变量只认它自己的 `html[data-color-mode]`，这里按客户端主题补一次。 */
  private paintTheme(target?: HTMLElement): void {
    const node = target ?? this.paneEl?.querySelector<HTMLElement>(".kb-site");
    if (!node) return;
    const dark = document.documentElement.dataset.theme !== "mac-light";
    if (dark) node.dataset.kbDark = "1";
    else delete node.dataset.kbDark;
  }

  // ---------------------------------------------------------------- 三种正文

  /** 概念：结构照抄站内 `TermBody.tsx`，样式靠 site.css 里的 `.detail-*` 那套。 */
  private termView(term: KbTerm): HTMLElement {
    const body = el("div", `detail-body detail-entry-${term.slug}`);
    const hero = el("section", "detail-hero");
    hero.append(el("span", "detail-kicker rd-kicker", tr("概念")));
    const head = el("div", "dh-head");
    const h1 = el("h1", undefined, term.name);
    if (term.en) h1.append(el("span", undefined, term.en));
    head.append(h1);
    hero.append(head);
    if (term.quote) {
      const quote = el("div", "dh-quote");
      quote.append(
        el("span", "dh-quote-label", term.quoteLabel || tr("你可能会说")),
        el("p", "dh-quote-text", term.quote),
      );
      hero.append(quote);
    }
    if (term.summaryLead) {
      const line = el("div", "dh-tagline");
      line.append(el("strong", "dh-summary-lead", term.summaryLead));
      if (term.summaryRest) {
        line.append(el("span", "dh-summary-separator", "·"), el("span", undefined, term.summaryRest));
      }
      hero.append(line);
    }
    if (term.aliases.length) {
      const alias = el("div", "alias-row");
      alias.append(el("span", undefined, tr("也常被叫作")));
      for (const a of term.aliases) alias.append(el("em", undefined, a));
      hero.append(alias);
    }
    if (term.demoHtml) {
      const demo = el("div", "dh-demo");
      const view = el("div", "dh-demo-viewport");
      const inner = el("div", "dh-demo-inner");
      inner.append(fragmentOf(term.demoHtml));
      view.append(inner);
      demo.append(view);
      hero.append(demo);
    }
    body.append(hero);
    term.sections.forEach((section, i) => {
      if (!section.html) return;
      const wrap = el("section", "vh-raw-section" + (i === 0 ? " vh-raw-first" : ""));
      wrap.append(fragmentOf(section.html));
      body.append(wrap);
    });
    return body;
  }

  private promptView(prompt: KbPrompt, category: string): HTMLElement {
    const doc = el("div", "kb-doc");
    doc.append(el("div", "kb-doc-cat", category));
    doc.append(el("h1", undefined, prompt.name));
    if (prompt.tagline) doc.append(el("p", "kb-doc-tagline", prompt.tagline));
    const meta = el("div", "kb-meta");
    for (const [label, value] of [
      [tr("适合"), prompt.bestFor],
      [tr("模型"), prompt.models],
    ] as const) {
      if (value) meta.append(el("span", "kb-chip", tr("{p1}：{p2}", { p1: label, p2: value })));
    }
    for (const tag of prompt.tags ?? []) meta.append(el("span", "kb-chip", tag));
    if (meta.childElementCount) doc.append(meta);

    doc.append(el("h2", undefined, tr("提示词")));
    const pre = el("pre");
    pre.textContent = prompt.prompt;
    doc.append(pre);

    if (prompt.why?.length) {
      doc.append(el("h2", undefined, tr("为什么这样写")));
      doc.append(listOf(prompt.why));
    }
    if (prompt.example) {
      doc.append(el("h2", undefined, tr("例子")));
      doc.append(el("p", undefined, prompt.example));
    }
    if (prompt.pitfalls?.length) {
      doc.append(el("h2", undefined, tr("容易踩的坑")));
      doc.append(listOf(prompt.pitfalls));
    }
    return doc;
  }

  private skillView(skill: KbSkill, category: string): HTMLElement {
    const doc = el("div", "kb-doc");
    doc.append(el("div", "kb-doc-cat", category));
    doc.append(el("h1", undefined, skill.name));
    if (skill.tagline) doc.append(el("p", "kb-doc-tagline", skill.tagline));
    const meta = el("div", "kb-meta");
    for (const [label, value] of [
      [tr("作者"), skill.author],
      [tr("平台"), skill.platform],
      [tr("价格"), skill.pricing],
      [tr("安装量"), skill.installs],
    ] as const) {
      if (value) meta.append(el("span", "kb-chip", tr("{p1}：{p2}", { p1: label, p2: value })));
    }
    for (const tag of skill.tags ?? []) meta.append(el("span", "kb-chip", tag));
    if (meta.childElementCount) doc.append(meta);

    if (skill.overview) {
      doc.append(el("h2", undefined, tr("简介")));
      doc.append(el("p", undefined, skill.overview));
    }
    if (skill.install) {
      doc.append(el("h2", undefined, tr("安装")));
      const pre = el("pre");
      pre.textContent = skill.install;
      doc.append(pre);
    }
    if (skill.features?.length) {
      doc.append(el("h2", undefined, tr("能力")));
      doc.append(listOf(skill.features));
    }
    if (skill.useCases?.length) {
      doc.append(el("h2", undefined, tr("用在哪")));
      doc.append(listOf(skill.useCases));
    }
    if (skill.bestFor) {
      doc.append(el("h2", undefined, tr("适合谁")));
      doc.append(el("p", undefined, skill.bestFor));
    }
    if (skill.repo) {
      doc.append(el("h2", undefined, tr("仓库")));
      const p = el("p");
      const a = el("a", undefined, skill.repo);
      a.href = skill.repo;
      a.target = "_blank";
      a.rel = "noreferrer";
      p.append(a);
      doc.append(p);
    }
    return doc;
  }

  // ---------------------------------------------------------------- 联动

  private handoff(kind: "prefill" | "newSessionWith"): void {
    const entry = this.selected;
    const handoff = this.host.handoff;
    if (!entry || !handoff) return;
    const text = handoffText(entry);
    const name = nameOf(entry);
    if (kind === "prefill") handoff.prefill(`${text}\n`, name);
    else handoff.newSessionWith(`${text}\n`, name);
  }

  private async copy(): Promise<void> {
    const entry = this.selected;
    if (!entry) return;
    const text = handoffText(entry);
    try {
      await navigator.clipboard.writeText(text);
      this.toast(tr("已复制"));
    } catch {
      // 剪贴板在不安全的上下文里会拒（http + 非 localhost），退回到选中一个临时文本框。
      const area = el("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      try {
        document.execCommand("copy");
        this.toast(tr("已复制"));
      } catch {
        this.toast(tr("复制失败：浏览器不让写剪贴板"));
      } finally {
        area.remove();
      }
    }
  }

  private toast(text: string): void {
    const note = this.noteEl;
    if (!note) return;
    note.hidden = false;
    note.classList.remove("bad");
    note.textContent = text;
    window.setTimeout(() => {
      if (this.noteEl === note && !this.error && !this.loading) note.hidden = true;
    }, 1600);
  }
}

/**
 * HTML 片段 → 节点。用 DOMParser 而不是 innerHTML（`md.ts` 立的规矩）：解析出来的脚本不会执行，
 * 节点再被 `append` 时归到本文档。内容是我们自己导出的 JSON（`tools/sync-knowledge.mjs`），
 * 不是用户输入 —— 但走同一条安全路径，也不给 lint 留口子。
 */
function fragmentOf(html: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const doc = new DOMParser().parseFromString(`<div id="kb-import">${html}</div>`, "text/html");
  const root = doc.getElementById("kb-import");
  if (!root) return frag;
  for (const node of Array.from(root.childNodes)) frag.append(node);
  return frag;
}

function listOf(items: string[]): HTMLElement {
  const ul = el("ul");
  for (const item of items) ul.append(el("li", undefined, item));
  return ul;
}
