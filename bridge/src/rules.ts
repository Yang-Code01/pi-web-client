/**
 * 「⚡ 复盘」写下的规矩（D164 的第三段延伸）。
 *
 * 账本记的是「这一类栽过几次」，教训是「下次怎么办」——两件事，分两处放：
 * 账本 (`failures.ts`) 只读、按次数归并；规矩是模型在复盘里写的一句可执行的话，键用同一个
 * 归并键 `tool|code|sig`，所以一条规矩天然挂在账本的一类上（账本里还没有这一类也允许：
 * 复盘轮可能谈到一条还没入账的新坑）。
 *
 * 为什么旁挂文件而不是写进账本：账本「只读」是它的立身之本（D164），一旦回写正文，
 * 下一次入账就可能盖掉人看着的那句话。
 *
 * `reviewed` 也落在这里：它是「这个会话已经复盘过 N 条失败」，和账本 `sessions[sid].n`
 * 同一个数法，刷新 / 换设备之后 ⚡ 里那条「发到会话复盘」不会又被点亮一次（重复烧 token）。
 */
import { createHash } from "node:crypto";
import { readJson, statePath, writeJson } from "./paths.ts";

export interface RuleRec {
  /** 与账本同一个归并键 `tool|code|sig`。 */
  key: string;
  tool: string;
  code: string;
  /** 命令形状，只用来在人眼前指认这一条。 */
  sig: string;
  /** 一句可执行的规矩（模型写的，人只能删，不能改——改了就没人认得它对应哪一类）。 */
  rule: string;
  /** 写下 / 覆盖的时刻，ISO。 */
  at: string;
}

export interface RuleBook {
  version: 1;
  ws: string;
  rules: RuleRec[];
  /** 会话 id → 上次复盘时的失败条数（口径同账本 `sessions[sid].n`）。 */
  reviewed: Record<string, { at: string; n: number }>;
}

const MAX_RULES = 100;
const MAX_TEXT = 200;

function clean(s: unknown, max = MAX_TEXT): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** 与账本同一套文件名规则：可读前缀 + ws 的 8 位哈希，`F:/a b` 与 `F:/a_b` 不共用一本。 */
function fileFor(ws: string): string {
  const safe = ws.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 100) || "none";
  const tail = createHash("sha1").update(ws).digest("hex").slice(0, 8);
  return statePath("rules", `${safe}-${tail}.json`);
}

export function emptyBook(ws: string): RuleBook {
  return { version: 1, ws, rules: [], reviewed: {} };
}

export function readRules(ws: string): RuleBook {
  const raw = readJson<Partial<RuleBook>>(fileFor(ws), {});
  const rules = Array.isArray(raw.rules)
    ? raw.rules
        .filter((r): r is RuleRec => Boolean(r) && typeof r === "object" && typeof (r as RuleRec).key === "string")
        .map((r) => ({
          key: String(r.key),
          tool: String(r.tool ?? ""),
          code: String(r.code ?? ""),
          sig: String(r.sig ?? ""),
          rule: clean(r.rule),
          at: String(r.at ?? ""),
        }))
        .filter((r) => Boolean(r.rule))
    : [];
  // 新的在前：折叠区里最该看见的是刚写下那句。
  rules.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    version: 1,
    ws,
    rules: rules.slice(0, MAX_RULES),
    reviewed: raw.reviewed && typeof raw.reviewed === "object" ? raw.reviewed : {},
  };
}

function save(book: RuleBook): RuleBook {
  const out = { ...book, version: 1 as const, rules: book.rules.slice(0, MAX_RULES) };
  writeJson(fileFor(book.ws), out);
  return out;
}

/** 同一个键再复盘 = **覆盖**（旧的规矩没有价值时才需要留下历史，这里不需要）。 */
export function setRule(input: { ws: string; key: string; rule: string; tool?: string; code?: string; sig?: string; at?: string }): RuleBook {
  const ws = String(input.ws || "");
  if (!ws) throw new Error("没有工作区");
  const key = clean(input.key, 200);
  const rule = clean(input.rule);
  if (!key) throw new Error("规矩缺少键");
  if (!rule) throw new Error("规矩是空的");
  const book = readRules(ws);
  const at = input.at || new Date().toISOString();
  const old = book.rules.find((r) => r.key === key);
  const rec: RuleRec = {
    key,
    // 账本里可能还没有这一类：键自带 tool 与 code，退而求其次也能拆出来。
    tool: clean(input.tool, 40) || old?.tool || key.split("|")[0] || "",
    code: clean(input.code, 40) || old?.code || key.split("|")[1] || "",
    sig: clean(input.sig, 80) || old?.sig || key.split("|").slice(2).join("|") || "",
    rule,
    at,
  };
  book.rules = [rec, ...book.rules.filter((r) => r.key !== key)];
  return save(book);
}

export function deleteRule(ws: string, key: string): RuleBook {
  const book = readRules(String(ws || ""));
  const before = book.rules.length;
  book.rules = book.rules.filter((r) => r.key !== key);
  if (book.rules.length === before) throw new Error("这条规矩已经不在了");
  return save(book);
}

/** 复盘发出去之后才记：发失败要留着让它重试，不能先把「已复盘」占了。 */
export function markReviewed(ws: string, sid: string, n: number): RuleBook {
  const book = readRules(String(ws || ""));
  if (!sid) throw new Error("没有会话");
  book.reviewed = {
    ...book.reviewed,
    [sid]: { at: new Date().toISOString(), n: Math.max(0, Math.trunc(Number(n) || 0)) },
  };
  return save(book);
}

/** 这一本里某个键的规矩（复盘提示词用得上：上一轮怎么写的）。 */
export function ruleFor(book: RuleBook | null, key: string): RuleRec | null {
  return book?.rules.find((r) => r.key === key) ?? null;
}
