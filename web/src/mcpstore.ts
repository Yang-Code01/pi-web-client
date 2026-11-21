/**
 * MCP 商店里「默认叫什么名字」「这个名字会不会替换掉已装的」「密钥该叫哪个变量」这三件事。
 *
 * 以前名字直接取 registry 名的最后一段（`app.worldmonitor/mcp` → `mcp`），而 pi 的 `mcp add`
 * 撞名只打一行 `Replaced`，于是装第二个 `mcp` 就把第一个静默覆盖掉了（D379）。
 * 判断都放在这里，`web/tests/mcpstore-unit.mjs` 才能钉住它们，而不是靠点开页面看。
 *
 * 名字规则照 pi：只允许字母、数字、`-`、`_`；只有 `-` 和 `_` 不同的两个名字算同一个 server。
 */
import { tr } from "./i18n/index.ts";

/** `ext.inventory` 里的 MCP 行（只留这里用得到的字段）。 */
export interface InstalledMcpView {
  name: string;
  transport?: string | null;
}

/** 这些短名说明不了是什么服务：registry 里几千条都叫 `mcp` / `site` / `server`。 */
const GENERIC = new Set([
  "mcp",
  "mcpserver",
  "server",
  "servers",
  "site",
  "catalog",
  "api",
  "app",
  "web",
  "cli",
  "tool",
  "tools",
  "agent",
  "agents",
  "service",
  "services",
  "gateway",
  "proxy",
  "remote",
  "default",
  "main",
  "core",
  "hub",
  "docs",
  "doc",
  "directory",
  "jobs",
  "booking",
  "public",
  "marketplace",
  "search",
  "news",
  "data",
  "database",
  "files",
  "list",
  "kite",
  "connector",
  "integration",
  "plugins",
  "mcpd",
]);

/** pi 只认 `[A-Za-z0-9_-]`，所以点号、斜杠、空格一律折成 `-`。 */
export function slugifyName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `foo-mcp` / `foo-mcp-server` / `mcp-foo` → `foo`；泛称或空串返回空。 */
function shortSlug(short: string): string {
  const base = slugifyName(short);
  if (!base) return "";
  const stripped = base.replace(/-mcp(-server)?$/, "").replace(/^mcp-/, "");
  const candidate = stripped || base;
  return GENERIC.has(candidate.replace(/-/g, "")) ? "" : candidate;
}

/**
 * 命名空间里最能说明问题的那一段：优先最后一段，太短或本身是泛称就往左找，
 * 全都不可用返回空（`ac.inference.sh` → `inference`，`app.worldmonitor` → `worldmonitor`）。
 */
function ownerSlug(ns: string): string {
  const parts = ns.split(/[./\\-]+/).map(slugifyName).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (part.length >= 3 && !GENERIC.has(part.replace(/-/g, ""))) return part;
  }
  return "";
}

/**
 * 默认服务名。
 *
 * - 短名本身够特别：`com.browser-use/browser-use` → `browser-use`
 * - 短名是泛称：借 registry 命名空间，`app.worldmonitor/mcp` → `worldmonitor`，
 *   `io.github.BuilderIO/mcp` → `builderio`，`ac.inference.sh/mcp` → `inference`
 * - 两边都说不出东西：退回短名（`mcp`），由 `freeName` 加后缀，绝不跟已装的撞。
 */
export function serverNameFor(name: string, title = ""): string {
  const cut = name.lastIndexOf("/");
  const ns = cut > 0 ? name.slice(0, cut) : "";
  const short = cut >= 0 ? name.slice(cut + 1) : name;
  const fromShort = shortSlug(short);
  if (fromShort) return fromShort;
  const fromOwner = ownerSlug(ns);
  if (fromOwner) return fromOwner;
  const fromTitle = shortSlug(title);
  if (fromTitle) return fromTitle;
  return slugifyName(short) || slugifyName(title) || "mcp";
}

/** 只有 `-` 和 `_` 不同的名字算同一个 server（pi 的规则），大小写也不分。 */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, "-");
}

/** 名字已被占用时往后加 `-2`、`-3`…：表单预填的名字点一下就能装。 */
export function freeName(base: string, installed: InstalledMcpView[]): string {
  const taken = new Set(installed.map((m) => nameKey(m.name)));
  const root = base || "mcp";
  if (!taken.has(nameKey(root))) return root;
  for (let n = 2; n < 100; n++) {
    const next = `${root}-${n}`;
    if (!taken.has(nameKey(next))) return next;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/** 同名的已装服务器（`-`/`_` 与大小写不敏感）；用于在表单里说明「这一装会替换它」。 */
export function sameName(name: string, installed: InstalledMcpView[]): InstalledMcpView | null {
  const want = nameKey(name);
  if (!want) return null;
  return installed.find((m) => nameKey(m.name) === want) ?? null;
}

/** 表单里名字这一格的状态：不能用时给一句人话（同时当 i18n 键），能用时说会不会替换已装的。 */
export function checkName(name: string, installed: InstalledMcpView[]): { ok: true; taken: InstalledMcpView | null } | { ok: false; problem: string } {
  const raw = name.trim();
  if (!raw) return { ok: false, problem: tr("名字不能为空。") };
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return { ok: false, problem: tr("只能用字母、数字、「-」和「_」。") };
  return { ok: true, taken: sameName(raw, installed) };
}

/**
 * 密钥在 mcp.json 里写成哪个环境变量名。
 *
 * 与 `bridge/src/market.ts` 的 `mcpAddRequest` 同一条规则：env 的密钥保持字段名，
 * header 的密钥前缀服务名（header 值要拼进请求，变量名得区分开）。两边不一致就会
 * 提示一个、实际读另一个。
 */
export function secretVarName(serverName: string, fieldName: string, isHeader: boolean): string {
  if (!isHeader) return fieldName;
  return `${serverName}_${fieldName}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}
