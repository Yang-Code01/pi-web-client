/**
 * 字节数的唯一口径：`1.5 KB`、`2 MB` —— 单位前留一个空格，最多一位小数，`.0` 不写。
 *
 * 只此一份：设置 → 本机管理（含下沿「文件」的表格，见 `dirpicker.ts`）与邮箱面板的附件大小
 * 都走这里。以前各处各写一行（`1024KB` / `1.0MB` / `2 KB`），同一份大文件在三个面板里长得
 * 不一样，用户看不出哪个是真的。
 *
 * 负数、`NaN`、0 一律按 `0 B`：大小这一列不该出现 `-1 B` 或者空字符串。
 */
const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(n: number): string {
  let value = Number.isFinite(n) && n > 0 ? n : 0;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 字节档不带小数（`512 B`，不是 `512.0 B`）；往上最多一位，且去掉没意义的 `.0`。
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit]}`;
}
