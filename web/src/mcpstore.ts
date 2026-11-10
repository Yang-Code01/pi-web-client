/**
 * MCP 商店里「这一条装没装过」「默认叫什么名字」这两个判断（#299 / #300）。
 *
 * 以前这两件事直接写在 `app.ts` 的 paint 里：名字靠 `slug()` 取 registry 名的最后一段，
 * 已安装靠 `「名字 + transport」.includes(包名 / URL)` —— 两边根本不是同一类东西，
 * 于是 `app.worldmonitor/mcp` 默认叫 `mcp`（装第二个就覆盖第一个），远程条目装完永远显示「安装」。
 *
 * 判断逻辑挪出 DOM，`web/tests/mcpstore-unit.mjs` 才能钉住它们。
 */

/** `ext.inventory` 里的 MCP 行（只留这里用得到的字段）。 */
export interface InstalledMcpView {
  name: string;
  transport?: string | null;
  /** 下面三个是这一版 bridge 新加的；老桥没有它们，只能退回按名字猜。 */
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
}

/** `StoreMcpItem.options` 里的一条安装方式。 */
export interface StoreOptionView {
  kind: "npm" | "pypi" | "oci" | "remote";
  identifier: string;
  url?: string;
}

/** 这些短名说明不了是什么服务（registry 里几千条都叫 mcp / site / server），要带上 owner。 */
const GENERIC = new Set(["mcp", "mcp-server", "server", "servers", "site", "catalog", "api", "app", "web", "cli", "tool", "tools", "agent", "service", "services", "gateway", "proxy"]);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `foo-mcp` / `foo-mcp-server` / `mcp-foo` → `foo`；泛称与空串返回空。 */
function shortSlug(short: string): string {
  const base = slugify(short);
  if (!base) return "";
  const stripped = base.replace(/-mcp(-server)?$/, "").replace(/^mcp-/, "");
  const candidate = stripped || base;
  return GENERIC.has(candidate) ? "" : candidate;
}

/**
 * 默认服务名。
 *
 * - 短名本身够特别：`com.browser-use/browser-use` → `browser-use`（保持原样）
 * - 短名是泛称：带上 registry owner，`app.worldmonitor/mcp` → `worldmonitor`，
 *   `io.github.BuilderIO/mcp` → `builderio`
 * - owner 也是泛称：退回短名本身（`mcp`），由 `freeName` 去加后缀
 */
export function serverNameFor(name: string, title = ""): string {
  const cut = name.lastIndexOf("/");
  const ns = cut > 0 ? name.slice(0, cut) : "";
  const short = cut >= 0 ? name.slice(cut + 1) : name;
  const base = shortSlug(short);
  if (base) return base;
  const owner = ns.split(".").filter(Boolean).pop() ?? "";
  const ownerSlug = shortSlug(owner);
  if (ownerSlug) return ownerSlug;
  return slugify(short || title) || "mcp";
}

/** 名字已被占用时往后加 `-2`、`-3`…：表单预填的就是「点一下就能装」的名字。 */
export function freeName(base: string, installed: InstalledMcpView[]): string {
  const taken = new Set(installed.map((m) => m.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) {
    const next = `${base}-${n}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** 同名的已装服务器（大小写不敏感）；用于在表单里提醒「这一装会替换它」。 */
export function sameName(name: string, installed: InstalledMcpView[]): InstalledMcpView | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  return installed.find((m) => m.name.toLowerCase() === want) ?? null;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * 这条安装方式对应的已装服务器；没装过返回 null。
 *
 * - remote：比 URL（去掉末尾斜杠、大小写不敏感）
 * - npm / pypi / oci：在 `args` 里找 `包名` / `包名@版本` / `包名==版本` / `镜像:tag`
 * - 老桥（行里没有 command / args / url）：退回按名字与包名比对，不至于全变「未安装」
 */
export function matchInstalled(opt: StoreOptionView, installed: InstalledMcpView[]): InstalledMcpView | null {
  const id = opt.identifier.trim();
  if (!id) return null;
  if (opt.kind === "remote") {
    const want = normalizeUrl(opt.url ?? id);
    const byUrl = installed.find((m) => m.url && normalizeUrl(m.url) === want);
    if (byUrl) return byUrl;
  } else {
    const sep = opt.kind === "npm" ? "@" : opt.kind === "pypi" ? "==" : ":";
    const hit = installed.find((m) => (m.args ?? []).some((a) => a === id || a.startsWith(`${id}${sep}`)));
    if (hit) return hit;
  }
  const legacy = installed.every((m) => !m.command && !m.url && !(m.args ?? []).length);
  if (!legacy) return null;
  const short = id.split("/").pop() ?? id;
  return installed.find((m) => m.name === id || m.name === short) ?? null;
}
