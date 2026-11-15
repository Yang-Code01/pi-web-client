/**
 * 邮件 HTML → 可以安全塞进 sandbox iframe 的正文。
 *
 * 为什么不是直接 `innerHTML`：邮件是别人写的 HTML，里面有脚本、表单、远程图片、
 * `javascript:` 链接。这里做两层：
 *   1. **白名单式清理**：去掉 script/iframe/form/svg 这些能执行或能嵌套文档的标签，
 *      去掉 `on*`、`srcdoc`、`srcset`，链接只留 http/https/mailto/tel/#；
 *   2. **iframe 再套一层**：`sandbox` 不给 allow-scripts，srcdoc 里再写一份 CSP，
 *      就算清理漏了，脚本/表单/子框架也跑不起来。
 *
 * 图片分三种：
 *   - 内嵌图：mailparser 已换成 `data:image/...`，直接放行；
 *   - `cid:`：按 `MailAttachmentView.contentId` 换成附件直链（`inline=1`）；
 *   - 远程图：默认收起（透明占位 + CSS 隐藏），只记原地址；用户点「显示图片」后重画才放行。
 *     CSP 的 img-src 也跟着 `allowRemote` 走，两层都拦。
 */
import { cidKey, inlineImageMap, type MailAttachmentView } from "./mail-shared.ts";

export interface MailHtmlOptions {
  attachments: readonly MailAttachmentView[];
  /** 把一条附件变成浏览器可访问的 URL（通常是 `/api/mail/attachment?...&inline=1`）。 */
  inlineUrl: (a: MailAttachmentView) => string;
  /** 是否放行 http(s) 远程图片。 */
  allowRemote: boolean;
}

export interface MailHtmlRender {
  /** 清理后的正文 HTML（含邮件自带的 <style>）。 */
  html: string;
  /** 远程 `<img>` 数量，按钮上的 N 用它，别把 CSS 背景图也算成图张数。 */
  remoteImages: number;
  /** 远程 CSS `url()` 数量；只有背景图时也要给「显示远程图片」的入口。 */
  remoteCss: number;
}

/** 1×1 透明 GIF：远程图被拦时替换 src，避免浏览器请求远程；实际显示由 CSS 收起。 */
const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

/** 能执行、能加载子文档、能提交表单的标签一律不要。`style` 留在白名单里，但内容要洗。 */
const DROP_TAGS = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "optgroup",
  "link",
  "meta",
  "base",
  "title",
  "svg",
  "math",
  "canvas",
  "audio",
  "video",
  "source",
  "track",
  "map",
  "area",
  "template",
  "dialog",
  "portal",
]);

function safeHref(raw: string): string {
  const href = String(raw ?? "").trim();
  if (!href) return "";
  if (/^(https?:|mailto:|tel:)/i.test(href) || href.startsWith("#")) return href;
  return "";
}

/** `data:image/...` 只认常见位图；SVG 能带脚本，直接当普通远程/未知图处理。 */
function isDataImage(raw: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i.test(String(raw ?? "").trim());
}

/** `srcset` 的第一个候选 URL；`srcset` 只有图、没有 `src` 时拿它补位。 */
export function firstSrcsetUrl(srcset: string): string {
  return String(srcset ?? "").trim().match(/^(\S+)/)?.[1] ?? "";
}

function cleanColor(raw: string | null): string {
  const v = String(raw ?? "").trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) || /^[a-z]{3,20}$/i.test(v) ? v : "";
}

/** 洗 CSS：@import、expression、远程 url 全部处理；返回被拦的远程资源数。 */
function cleanCss(
  input: string,
  allowRemote: boolean,
  resolveCid: (value: string) => string | null = () => null,
): { css: string; remote: number } {
  let remote = 0;
  let css = String(input ?? "");
  css = css.replace(/@import[^;]*(?:;|$)/gi, " ");
  css = css.replace(/expression\s*\([^)]*\)/gi, "none");
  css = css.replace(/-moz-binding\s*:[^;}]*;?/gi, "");
  css = css.replace(/behavior\s*:[^;}]*;?/gi, "");
  css = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, _quote: string, rawUrl: string) => {
    const url = String(rawUrl ?? "").trim();
    if (isDataImage(url) || url.startsWith("#")) return whole;
    if (/^cid:/i.test(url)) {
      const hit = resolveCid(url);
      return hit ? `url("${hit.replace(/"/g, "%22")}")` : "none";
    }
    if (/^(https?:)?\/\//i.test(url) || /^[a-z][a-z0-9+.-]*:/i.test(url)) {
      remote += 1;
      return allowRemote ? whole : "none";
    }
    // 相对路径在 srcdoc 里没有可靠 base，按远程资源处理。
    remote += 1;
    return allowRemote ? whole : "none";
  });
  return { css: css.trim(), remote };
}

/**
 * 清理一封邮件的 HTML。返回的是**片段**（不是完整文档），由 `buildMailFrameHtml` 套壳。
 */
export function renderMailHtml(raw: string, opts: MailHtmlOptions): MailHtmlRender {
  const source = String(raw ?? "");
  if (!source.trim()) return { html: "", remoteImages: 0, remoteCss: 0 };
  const doc = new DOMParser().parseFromString(source, "text/html");
  const body = doc.body;
  if (!body) return { html: "", remoteImages: 0, remoteCss: 0 };
  const cids = inlineImageMap(opts.attachments);
  const resolveCid = (value: string): string | null => {
    const hit = cids.get(cidKey(value));
    return hit && String(hit.contentType ?? "").toLowerCase().startsWith("image/") ? opts.inlineUrl(hit) : null;
  };
  let remoteImages = 0;
  let remoteCss = 0;

  // <head> 里的样式不能丢：营销邮件几乎所有布局都在这里。
  const headStyles: string[] = [];
  for (const style of Array.from(doc.head?.querySelectorAll("style") ?? [])) {
    const cleaned = cleanCss(style.textContent ?? "", opts.allowRemote, resolveCid);
    remoteCss += cleaned.remote;
    if (cleaned.css) headStyles.push(`<style>${cleaned.css}</style>`);
  }

  const styleAttr = cleanCss(body.getAttribute("style") ?? "", opts.allowRemote, resolveCid);
  remoteCss += styleAttr.remote;
  if (styleAttr.css) headStyles.push(`<style>body{${styleAttr.css}}</style>`);
  const bg = cleanColor(body.getAttribute("bgcolor"));
  if (bg) headStyles.push(`<style>body{background-color:${bg}}</style>`);

  const walk = (parent: Element): void => {
    for (const child of Array.from(parent.children)) {
      const tag = child.tagName.toLowerCase();
      if (DROP_TAGS.has(tag)) {
        child.remove();
        continue;
      }

      if (tag === "style") {
        const cleaned = cleanCss(child.textContent ?? "", opts.allowRemote, resolveCid);
        remoteCss += cleaned.remote;
        child.textContent = cleaned.css;
        continue;
      }

      // 有些邮件只写 srcset、不写 src；先补一个 src，后面的远程拦截 / 显示图片才能生效。
      if (tag === "img" && !child.getAttribute("src")) {
        const first = firstSrcsetUrl(child.getAttribute("srcset") ?? "");
        if (first) child.setAttribute("src", first);
      }

      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        if (name.startsWith("on") || ["srcdoc", "srcset", "sizes", "ping", "formaction", "action", "method", "background"].includes(name)) {
          child.removeAttribute(attr.name);
          continue;
        }
        if (name === "style") {
          const cleaned = cleanCss(value, opts.allowRemote, resolveCid);
          remoteCss += cleaned.remote;
          if (cleaned.css) child.setAttribute("style", cleaned.css);
          else child.removeAttribute("style");
          continue;
        }
        if (name === "href") {
          const href = safeHref(value);
          if (href) child.setAttribute("href", href);
          else child.removeAttribute("href");
          continue;
        }
        if (name === "src" && tag === "img") {
          const src = String(value ?? "").trim();
          if (/^cid:/i.test(src)) {
            const hit = cids.get(cidKey(src));
            if (hit && String(hit.contentType ?? "").toLowerCase().startsWith("image/")) {
              child.setAttribute("src", opts.inlineUrl(hit));
            } else {
              child.removeAttribute("src");
              child.setAttribute("data-mc-missing", "1");
            }
          } else if (isDataImage(src)) {
            // 内嵌 base64，保留。
          } else if (/^data:/i.test(src)) {
            // SVG / HTML 等非位图 data URI 不进 <img>，统一当缺失图。
            child.removeAttribute("src");
            child.setAttribute("data-mc-missing", "1");
          } else if (src) {
            remoteImages += 1;
            child.setAttribute("data-mc-remote-src", src);
            if (!opts.allowRemote) {
              child.setAttribute("src", TRANSPARENT_GIF);
              child.setAttribute("data-mc-blocked", "1");
            }
          } else {
            child.removeAttribute("src");
          }
        }
      }

      if (tag === "a") {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer nofollow");
      }
      walk(child);
    }
  };
  walk(body);

  return { html: headStyles.join("") + body.innerHTML, remoteImages, remoteCss };
}

const BASE_CSS = `
html, body { margin: 0; padding: 0; background: #fff; color: #1f2328; }
body { font: 13px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; border-collapse: collapse; }
td, th { max-width: 100%; }
a { color: #0b63ce; }
blockquote { margin: .6em 0; padding-left: .8em; border-left: 2px solid #d0d7de; color: #57606a; }
pre { white-space: pre-wrap; word-break: break-word; }
/* Blocked images are collapsed: dozens of 600x300 placeholders would make the body look blank. */
img[data-mc-blocked], img[data-mc-missing] { display: none !important; }
`;

/** 完整 srcdoc：CSP + 参考样式。`allowRemote` 同时控制 CSP 的 img-src。 */
export function buildMailFrameHtml(rendered: MailHtmlRender, allowRemote: boolean): string {
  const csp = [
    "default-src 'none'",
    `img-src data: blob: 'self'${allowRemote ? " https: http:" : ""}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "script-src 'none'",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${BASE_CSS}</style></head><body>${rendered.html}</body></html>`;
}
