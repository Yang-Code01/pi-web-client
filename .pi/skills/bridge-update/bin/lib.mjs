/** restart.mjs 与 watchdog.mjs 共用的三件小工具（同一份逻辑别抄两遍）。 */
import fs from "node:fs";

export function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : dflt;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 追加一行日志；文件超过 `cap` 字节就先清空（看门狗每分钟一次，没人看着它长）。 */
export function appendLog(file, cap, ...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  try {
    if (cap && fs.existsSync(file) && fs.statSync(file).size > cap) fs.writeFileSync(file, "");
    fs.appendFileSync(file, line + "\n");
  } catch {
    /* 日志写不动不该让更新失败 */
  }
  return line;
}

/** 锁文件还新鲜（<5 分钟）= 另一个更新正在跑。 */
export function lockFresh(file) {
  const raw = readJson(file);
  if (!raw || typeof raw.at !== "string") return false;
  return Date.now() - Date.parse(raw.at) < 5 * 60 * 1000;
}
