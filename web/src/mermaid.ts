/**
 * D227: Mermaid 图 —— 让网页里的 ```mermaid 围栏长成图，跟 pi 的 `markdown.mermaid` 一个口径。
 *
 * 三件事值得先说明白：
 *
 * - **模式来自 settings.json，不是页面自己的偏好。** pi 里 `markdown.mermaid` 是 `off` /
 *   `final` / `streaming`，终端按它在消息、摘要里画图。网页要跟它，否则同一份 settings.json
 *   在两个前端里意思不一样。值由桥解析（项目 → 全局 → pi 的出厂值），随会话状态一起下发，
 *   这里只负责记住当前值。
 * - **`final` 与 `streaming` 在网页里目前是同一件事。** 实时回答在网页里根本不排 markdown
 *   （`chat.ts` 的 `delta()` 只写 `textContent`），每一次 markdown 渲染都是一条已经落定的消息，
 *   所以没有「边写边画」这个中间态。模式值照收，等哪天实时排版了再分叉。
 * - **mermaid 只在真有图时才下载。** `import("mermaid")` 是动态的，Vite 会切出一个独立 chunk：
 *   没有 mermaid 的那一天，页面一个字节都不为它多付。
 *
 * 渲染结果是 mermaid 自己生成的 SVG，仍然按「文本不可信」处理：`securityLevel: "strict"` +
 * `htmlLabels: false` 不让标签变成 HTML，导入前再剥一遍 `<script>` 与 `on*` 属性，并且只走
 * `DOMParser` + `importNode`，不对任何元素写 innerHTML。
 */
import { tr } from "./i18n/index.ts";

export type MermaidMode = "off" | "final" | "streaming";

const MODES: MermaidMode[] = ["off", "final", "streaming"];
/** pi 的出厂值（`settings-defaults.js`：`markdown.mermaid: "streaming"`）。 */
const DEFAULT_MODE: MermaidMode = "streaming";

let mode: MermaidMode = DEFAULT_MODE;

/** pi 的判据：标签取第一个词、忽略大小写，`mermaid` 才算图。 */
export function isMermaidFence(label: string | null | undefined): boolean {
  return String(label ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

/** 当前要按哪种模式画。非法值（旧桥、手改坏了）回落到 pi 的出厂值。 */
export function mermaidMode(): MermaidMode {
  return mode;
}

export function setMermaidMode(next: unknown): void {
  const value = typeof next === "string" ? next.trim().toLowerCase() : "";
  mode = (MODES as string[]).includes(value) ? (value as MermaidMode) : DEFAULT_MODE;
}

/** 画过的东西按源码记一份：同一段图在转录里出现两次（翻页、切会话回来）不该画两遍。 */
const CACHE_MAX = 40;
/** `null` = 这段源码画不出来，别再试（mermaid 对坏语法每次都抛同样的错）。 */
const cache = new Map<string, string | null>();

let lib: Promise<any> | null = null;
let libFailed = false;
let seq = 0;
/** mermaid 的渲染有全局状态，不能并发：一条一条排队。 */
let chain: Promise<void> = Promise.resolve();
/** 上一次 initialize 用的配色，变了才重新 initialize（切到「明亮」档要跟着换）。 */
let themed = "";

function mermaidLib(): Promise<any> {
  if (!lib) {
    lib = import("mermaid")
      .then((mod) => (mod as any).default ?? mod)
      .catch((err) => {
        // 网络抖一下不该让这一页从此没有图：记下这次失败，下次还是重新试。
        lib = null;
        libFailed = true;
        throw err;
      })
      .finally(() => {
        if (lib) libFailed = false;
      });
  }
  return lib;
}

/** 页面配色取自 CSS 变量（D158：颜色只有 CSS 一份真源，这里不抄第二份）。 */
function themeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--panel", "#12151a"),
    primaryColor: read("--panel-2", "#171b22"),
    primaryTextColor: read("--text", "#e7eaf0"),
    primaryBorderColor: read("--line-strong", "#2f3a48"),
    secondaryColor: read("--panel-3", "#1c2129"),
    tertiaryColor: read("--sunken", "#0a0e13"),
    lineColor: read("--dim", "#9aa2b1"),
    textColor: read("--text", "#e7eaf0"),
    nodeBorder: read("--line-strong", "#2f3a48"),
    clusterBkg: read("--panel", "#12151a"),
    clusterBorder: read("--line", "#232833"),
    edgeLabelBackground: read("--panel", "#12151a"),
    fontFamily: read("--sans", "sans-serif"),
    fontSize: "14px",
  };
}

async function ready(): Promise<any> {
  const mermaid = await mermaidLib();
  const vars = themeVars();
  const signature = JSON.stringify(vars);
  if (signature !== themed) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      htmlLabels: false,
      fontFamily: vars.fontFamily,
      themeVariables: vars,
      flowchart: { htmlLabels: false },
      class: { htmlLabels: false },
    });
    themed = signature;
  }
  return mermaid;
}

const SCRUB = /^(script|foreignObject)$/i;

/** mermaid 的 SVG 串 → 可以挂进页面的节点，顺手把不该执行的东西摘掉。 */
function svgNode(svg: string): SVGElement | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return null;
  for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (SCRUB.test(node.nodeName)) {
      node.remove();
      continue;
    }
    for (const attr of Array.from(node.attributes)) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
    }
  }
  return document.importNode(root, true) as unknown as SVGElement;
}

function note(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const line = raw.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function failed(host: HTMLElement, err: unknown): void {
  host.classList.remove("pending");
  host.classList.add("failed");
  if (host.querySelector(".md-mermaid-error")) return;
  const line = document.createElement("div");
  line.className = "md-mermaid-error";
  const why = note(err);
  line.textContent = why ? tr("图画不出来（{p1}），原文留在下面", { p1: why }) : tr("图画不出来，原文留在下面");
  host.append(line);
}

function paint(host: HTMLElement, svg: string): void {
  const node = svgNode(svg);
  if (!node) {
    failed(host, new Error("svg"));
    return;
  }
  host.classList.remove("pending");
  host.classList.remove("failed");
  host.replaceChildren(node);
}

async function render(host: HTMLElement, code: string): Promise<void> {
  // 页已经翻走了（换了会话、重画了消息）：白画一遍还占着队列。
  if (!host.isConnected) return;
  if (cache.has(code)) {
    const svg = cache.get(code);
    if (svg) paint(host, svg);
    else failed(host, new Error(""));
    return;
  }
  try {
    const mermaid = await ready();
    const { svg } = await mermaid.render(`md-mermaid-${++seq}`, code);
    if (typeof svg !== "string" || !svg) throw new Error("empty svg");
    cache.set(code, svg);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    if (!host.isConnected) return;
    paint(host, svg);
  } catch (err) {
    // 取消（切走、重建 DOM）不是「画不出来」，别把人家还没看完的图判死。
    if (!host.isConnected) return;
    // 下载 mermaid 本体失败和「这段源码画不出来」是两回事：前者下次还要再试。
    if (!libFailed) {
      cache.set(code, null);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    }
    failed(host, err);
  }
}

/**
 * 把一段 mermaid 源码画进 `host`（里面先放着原文那段 `<pre>`）。同步返回：图是异步来的，
 * 来之前原文照旧看得见，来之后整块换掉；画不出来就留原文并在下面写一句为什么。
 */
export function mountMermaid(host: HTMLElement, code: string): void {
  const text = String(code ?? "").trim();
  if (!text) return;
  // 源码寄存在自己身上：画成图之后原文就没了，而「模式改成 off」还得把它退回来。
  host.dataset.mermaidSrc = text;
  host.classList.add("pending");
  chain = chain
    .then(() => render(host, text))
    // 一次渲染炸了不能把后面排队的图一起卡死。
    .catch(() => {});
}

/** 画出来的、画不出来的、还在排队的，都是一个 `.md-mermaid` 包着原文那个 `<pre>`。 */
const HOST = ".md-mermaid";

/** 与 `md.ts` 围栏分支里那块一样的形状：`<pre data-lang><code>源码</code></pre>`。 */
function sourceBlock(code: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.dataset.lang = "mermaid";
  const node = document.createElement("code");
  node.textContent = code;
  pre.append(node);
  return pre;
}

/**
 * 模式改了，已经画在屏幕上的那些跟着变（不用重排整个转录）。
 *
 * - 改成 `off`：每个 `.md-mermaid` 用寄存的源码退回一段普通围栏；
 * - 改成画：还没包起来的 mermaid 围栏就地包上再画（mermaid 本体和渲染结果都在缓存里，回来得很快）。
 *
 * 两条都只动 DOM，不重新 markdown 解析 —— 原文在 `mountMermaid` 时已经存进 `data-mermaid-src` 了。
 */
export function applyMermaidMode(root: ParentNode = document): void {
  if (mode === "off") {
    for (const host of Array.from(root.querySelectorAll<HTMLElement>(HOST))) {
      const code = host.dataset.mermaidSrc ?? "";
      if (code.trim()) host.replaceWith(sourceBlock(code));
      else host.remove();
    }
    return;
  }
  for (const pre of Array.from(root.querySelectorAll<HTMLElement>("pre[data-lang]"))) {
    if (!isMermaidFence(pre.dataset.lang) || pre.closest(HOST)) continue;
    const host = document.createElement("div");
    host.className = HOST.slice(1);
    pre.replaceWith(host);
    host.append(pre);
    mountMermaid(host, pre.textContent ?? "");
  }
}
