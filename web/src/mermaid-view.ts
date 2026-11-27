/**
 * Mermaid 图：文档模式下 ```mermaid 围栏渲染成图（D-mermaid，见 docs/DECISIONS.md）。
 *
 * - mermaid 本体约 1 MB，按需 `import()`：没有 mermaid 围栏的页面一个字节都不下载（Vite 拆成独立 chunk）。
 * - 先放源码 `<pre>` 占位；渲染成功换成 `<svg>`，失败保留源码并在下面写一行原因 —— 坏图不吞内容。
 * - `securityLevel: "strict"`：标签里的 HTML 被 mermaid 自带的 DOMPurify 清掉、点击回调关掉。
 *   拿到的 SVG 字符串用 `DOMParser` 解析成节点再接进来，不走 `innerHTML`（md.ts 的规矩）。
 * - 主题：按 `<html data-theme>` 选 mermaid 的 default / dark；渲染时取一次，换主题后重新打开预览即可。
 */

import { tr } from "./i18n/index.ts";
import { isTheme, themeInfo } from "./theme.ts";

/** mermaid 自己的类型（不从包里抄一份，改了不会对不上）。 */
type MermaidApi = typeof import("mermaid")["default"];

let loader: Promise<MermaidApi> | null = null;
/** mermaid 上一次 initialize 用的主题；同一主题不必重复配置全局状态。 */
let initedTheme: "default" | "dark" | null = null;
let seq = 0;
/** 串行渲染：mermaid 的 render 共用一份全局配置与临时节点，并发会互相踩。 */
let queue: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<MermaidApi> {
  loader ??= import("mermaid")
    .then((m) => m.default)
    .catch((err: unknown) => {
      // 加载失败（断网、chunk 404）不留在缓存里：下一次围栏重试，而不是刷新前一直报错。
      loader = null;
      throw err;
    });
  return loader;
}

/** 当前主题用哪套 mermaid 配色：查 `theme.ts` 的主题表，不按 id 里有没有 `light` 猜。 */
export function mermaidTheme(theme: string | undefined): "default" | "dark" {
  return isTheme(theme) && themeInfo(theme).light ? "default" : "dark";
}

/** 主题变了才 initialize：mermaid 的配置是全局的，每个围栏重复配一遍纯属浪费。 */
function ensureInit(mermaid: MermaidApi): void {
  const theme = mermaidTheme(document.documentElement.dataset.theme);
  if (initedTheme === theme) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
  initedTheme = theme;
}

/** 把 mermaid 给的 SVG 文本解析成节点；解析不了返回 null。 */
export function svgNode(svg: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || parsed.getElementsByTagName("parsererror").length) return null;
  const node = document.importNode(root, true);
  return node instanceof SVGSVGElement ? node : null;
}

/**
 * mermaid 默认给 SVG 写 `width="100%"` + `max-width`，宽图会被压进容器宽度（实测 3808px 的图缩成 600×11）。
 * 改成 viewBox 的原始像素宽，配 `.md-mermaid-fig` 的 `overflow-x: auto` 才是「太宽就滚动、不缩」。
 */
function naturalWidth(node: SVGSVGElement): void {
  const vb = node.viewBox?.baseVal;
  if (vb?.width) node.setAttribute("width", String(Math.ceil(vb.width)));
}

/**
 * 一个 mermaid 围栏的占位块。返回的节点立刻可插入；图渲染好后原地替换里面的内容。
 * `pre` 是调用方已经建好的源码块（带不带高亮都行），渲染失败时就留着它。
 */
export function mermaidBlock(text: string, pre: HTMLElement): HTMLElement {
  const box = document.createElement("div");
  box.className = "md-mermaid";
  box.dataset.state = "pending";
  box.appendChild(pre);
  const id = `md-mermaid-${++seq}`;
  const job = async () => {
    // 预览切走 / 被重新渲染后，box 已经不在文档里：调用方都是同步 append 的，
    // 到这里还不连接就是被丢弃了，跳过 render，不占串行队列也不白做布局。
    if (!box.isConnected) return;
    try {
      const mermaid = await loadMermaid();
      ensureInit(mermaid);
      const { svg } = await mermaid.render(id, text);
      const node = svgNode(svg);
      if (!node) throw new Error(tr("图的输出无法解析"));
      naturalWidth(node);
      const fig = document.createElement("div");
      fig.className = "md-mermaid-fig";
      fig.appendChild(node);
      box.replaceChildren(fig);
      box.dataset.state = "ok";
    } catch (err) {
      // mermaid 失败时会在 body 里留一个临时节点（id 前加 d），顺手清掉。
      document.getElementById(`d${id}`)?.remove();
      const msg = document.createElement("div");
      msg.className = "md-mermaid-err";
      // 保留整段原因（parse 错误的行号、片段、Expecting 都在换行后面，只留首行等于没说），
      // 折叠成一行并截断，免得一行错误把版面撑开。
      const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
      msg.textContent = tr("Mermaid 图渲染失败：{p1}", { p1: reason.length > 300 ? `${reason.slice(0, 300)}…` : reason });
      box.appendChild(msg);
      box.dataset.state = "error";
    }
  };
  queue = queue.then(job, job);
  return box;
}
