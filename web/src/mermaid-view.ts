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

type MermaidApi = {
  initialize(cfg: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
};

let loader: Promise<MermaidApi> | null = null;
let seq = 0;
/** 串行渲染：mermaid 的 render 共用一份全局配置与临时节点，并发会互相踩。 */
let queue: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<MermaidApi> {
  loader ??= import("mermaid").then((m) => m.default as unknown as MermaidApi);
  return loader;
}

/** 当前主题是不是深色：`data-theme` 不是 `*-light` 就当深色。 */
export function mermaidTheme(theme: string | undefined): "default" | "dark" {
  return theme && /light/.test(theme) ? "default" : "dark";
}

/** 把 mermaid 给的 SVG 文本解析成节点；解析不了返回 null。 */
export function svgNode(svg: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || parsed.getElementsByTagName("parsererror").length) return null;
  return document.importNode(root, true) as unknown as SVGSVGElement;
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
    try {
      const mermaid = await loadMermaid();
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: mermaidTheme(document.documentElement.dataset.theme) });
      const { svg } = await mermaid.render(id, text);
      const node = svgNode(svg);
      if (!node) throw new Error(tr("图的输出无法解析"));
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
      const reason = err instanceof Error ? err.message : String(err);
      msg.textContent = tr("Mermaid 图渲染失败：{p1}", { p1: reason.split("\n")[0] });
      box.appendChild(msg);
      box.dataset.state = "error";
    }
  };
  queue = queue.then(job, job);
  return box;
}
