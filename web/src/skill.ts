/**
 * `/skill:<name>` 的显示规则，和桥端 `bridge/src/sessionfile.ts` 的 `displayUserText` 是一对：
 * 桥负责把文件里那段 `<skill …>整篇 SKILL.md</skill>` 折回命令并打在 item 上，这里只负责画。
 *
 * 桥与 web 是两份独立构建，没有共享模块 —— 规则要改就两边一起改（`typedSkill` 是这里的对照物）。
 */

import { tr } from "./i18n/index.ts";

/**
 * 一条**待发送**的 prompt 调的是哪个技能：`/skill:<name>` 在开头才算，与 pi 的
 * `startsWith("/skill:")` 一致。乐观气泡（还没写盘）靠它先画上药丸，免得 400ms 后换样式。
 */
export function skillOf(text: string): string | null {
  const m = /^\s*\/skill:(\S+)/.exec(text);
  return m ? m[1] : null;
}

/**
 * 把用户消息画进 `body`：技能调用的命令是一颗药丸（tooltip 放 SKILL.md 路径），用户自己写的话
 * 原样跟在后面。`text` 是桥折回来的 `/skill:<name> args`；对不上就整段按普通文本画。
 */
export function fillUserBody(body: HTMLElement, item: { text: string; skill?: string; skillPath?: string }): void {
  const cmd = item.skill ? `/skill:${item.skill}` : "";
  if (cmd && item.text.startsWith(cmd)) {
    const chip = document.createElement("code");
    chip.className = "msg-skill";
    chip.textContent = cmd;
    if (item.skillPath) chip.title = tr("技能文件：{p1}", { p1: item.skillPath });
    body.append(chip);
    // 分隔符就是折回文本里那个空格，别裁：气泡是 `white-space: pre-wrap`。
    const rest = item.text.slice(cmd.length);
    if (rest.trim()) body.append(document.createTextNode(rest));
  } else {
    body.textContent = item.text;
  }
}
