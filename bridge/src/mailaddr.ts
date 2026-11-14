/**
 * 地址的纯字符串处理：`Name <a@b.com>` ↔ `a@b.com`。不碰网络、不碰配置，好单测。
 *
 * 为什么单独一份：面板「回复」填的是 `MailDetailView.from`（`PlayStation <email@…>` 这种带显示名的
 * 形式），而白名单比对、`normalizeMail()` 的校验、SMTP 的收件人都要**裸地址**。以前三处各写一套：
 * 面板「回复」被 `^[^\s@]+@…$` 拦成「收件人不像地址」（500），白名单里带显示名的地址永远对不上。
 * 现在只有这里一份口径。
 */
/** 带显示名的形式：`Name <addr>` / `"Name, with comma" <addr>` / `<addr>`。 */
const ANGLE = /^(.*?)<\s*([^<>]*?)\s*>\s*$/s;
/** 裸地址：本地部分与域名都不许有空白与尖括号。够用了 —— 真正吗合法不归我们判，交给服务器。 */
const ADDR = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * `Name <a@b.com>` → `a@b.com`；裸地址原样（去空白）；其余（空、垃圾）原样返回，让调用方去判。
 * 空的尖括号（`Name <>`）返回空串 —— 那是个没有地址的显示名，调用方必须当成无效。
 */
export function bareAddress(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const m = ANGLE.exec(text);
  if (m) return m[2].trim();
  return text.replace(/^<|>$/g, "").trim();
}

/** 显示名（拿不到就是空串）。`Name <a@b.com>` → `Name`。 */
export function displayName(raw: unknown): string {
  const text = String(raw ?? "").trim();
  const m = ANGLE.exec(text);
  if (!m) return "";
  return m[1].trim().replace(/^"(.*)"$/s, "$1").trim();
}

/** 是不是一个能发出去的地址：先剥显示名，再比形状。 */
export function isEmailAddress(raw: unknown): boolean {
  const addr = bareAddress(raw);
  return !!addr && ADDR.test(addr);
}

/** 收件人列表去重、留顺序、剥掉空项（白名单与 SMTP 都用这一份）。 */
export function bareAddresses(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const addr = bareAddress(item);
    if (!addr) continue;
    if (!out.some((one) => one.toLowerCase() === addr.toLowerCase())) out.push(addr);
  }
  return out;
}

/** 给 `MailError` 用的一句提示（调用方自己拼 code）。 */
export const BAD_ADDRESS_HINT = "收件人写成 someone@example.com，或者「名字 <someone@example.com>」这种形式。";
