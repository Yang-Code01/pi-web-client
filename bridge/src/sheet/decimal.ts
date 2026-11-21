/**
 * 十进制舍入：Excel 的「按显示位数四舍五入」不按二进制位走。
 *
 * 为什么不用 `abs + abs * 1e-12` 那种补偿：
 * - 它是**相对**补偿，值越大补得越多：`1e12 + 1e12*1e-12 = 1000000000001`。
 * - `x * 10^d` 再 `Math.round` 会被二进制误差带偏：`1.005 * 100 = 100.49999999999999`，
 *   `ROUNDUP(2.67,2)` 会被 `ceil` 抬成 2.68。
 *
 * 这里全程在十进制位上算：先把值写成「有效数字 × 10^指数」（`Number#toExponential` 给的是
 * 最短往返表示），再按目标位数用 BigInt 取整，最后拼回十进制串。Excel 只存 15 位有效数字，
 * 所以先按 15 位截断（`1/3` 显示 15 位小数时是 `0.333333333333333`，不是 `…667`）。
 */

/** Excel 单元格的有效数字位数。 */
export const SIG = 15;

/**
 * 把 `abs` 以 `10^-dec` 为单位拆开：`abs ≈ (q + rem/div) * 10^-dec`（`div === 1n` 时 rem 恒为 0）。
 * `dec` 可为负（舍到十位、百位…）。
 */
function decompose(abs: number, dec: number): { q: bigint; rem: bigint; div: bigint } {
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(abs.toExponential());
  if (!m) return { q: 0n, rem: 0n, div: 1n };
  const digits = (m[1] ?? "") + (m[2] ?? "");
  const k = Number(m[3]) - (digits.length - 1) + Math.trunc(dec);
  const big = BigInt(digits);
  if (k >= 0) return { q: big * 10n ** BigInt(k), rem: 0n, div: 1n };
  const div = 10n ** BigInt(-k);
  return { q: big / div, rem: big % div, div };
}

/** 向下取整到 `10^-dec` 单位，并告诉调用方「还有没有剩」。 */
function floorUnits(abs: number, dec: number): { u: bigint; exact: boolean } {
  const { q, rem } = decompose(abs, dec);
  return { u: q, exact: rem === 0n };
}

/** 四舍五入（half-up）到 `10^-dec` 单位。 */
function halfUpUnits(abs: number, dec: number): bigint {
  const { q, rem, div } = decompose(abs, dec);
  return div !== 1n && rem * 2n >= div ? q + 1n : q;
}

/** 把「10^-dec 为单位的整数」拼回十进制串，`dec > 0` 时带小数点、`dec < 0` 时补 0。 */
function join(u: bigint, dec: number): string {
  const d = Math.trunc(dec);
  const s = u.toString();
  if (d <= 0) return s + "0".repeat(-d);
  const t = s.padStart(d + 1, "0");
  return `${t.slice(0, -d)}.${t.slice(-d)}`;
}

/** Excel 的规格化：只留 15 位有效数字。 */
export function normalize15(x: number): number {
  return Number.isFinite(x) && x !== 0 ? Number(x.toPrecision(SIG)) : x;
}

/**
 * `abs` 按 `dec` 位小数显示的文本（定长，末尾补 0），四舍五入按十进制 half-up。
 * `dec` 取 0…15；非有限值原样返回，不自作聪明。
 */
export function decimalFixed(abs: number, dec: number): string {
  if (!Number.isFinite(abs)) return String(abs);
  const d = Math.max(0, Math.min(SIG, Math.trunc(dec)));
  if (abs === 0) return d ? `0.${"0".repeat(d)}` : "0";
  return join(halfUpUnits(normalize15(Math.abs(abs)), d), d);
}

/**
 * 十进制舍入到 `dec` 位小数，返回数字。
 * `dir`：0 = 四舍五入（half-up，Excel 的 ROUND），1 = 远离 0（ROUNDUP），-1 = 朝 0（ROUNDDOWN）。
 */
export function roundDecimal(x: number, dec: number, dir: -1 | 0 | 1 = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const d = Math.trunc(dec);
  if (!Number.isFinite(d) || d > SIG) return x; // 15 位之外没有可舍的位
  if (d < -308) return 0;
  const abs = normalize15(Math.abs(x));
  let u: bigint;
  if (dir === 0) u = halfUpUnits(abs, d);
  else {
    const { u: f, exact } = floorUnits(abs, d);
    u = dir > 0 && !exact ? f + 1n : f;
  }
  const out = Number(join(u, d)) * Math.sign(x);
  return Object.is(out, -0) ? 0 : out;
}
