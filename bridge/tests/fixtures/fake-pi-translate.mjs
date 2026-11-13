/**
 * 翻译用的桩 pi（D241）：`--mode text -p …` 自己答，其它调用（rpc 会话、`--version`）原样转给
 * `fake-pi.mjs` —— 这样一次测试里既能开会话，又能让翻译真的走一遍子进程。
 *
 * 「翻译」就是给每行前面加个 `译 ` 再把假名抠掉：够用来验证分节 / 表格校验 / 同步写回，
 * 又永远不会碰真的模型。标题原样留着，不然译文再切一次节就对不上原文了。
 *
 * 指针用法：`PI_BIN=<这个文件>`。
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const modeAt = argv.indexOf("--mode");
const textMode = modeAt >= 0 && argv[modeAt + 1] === "text";

if (!textMode) {
  const child = spawn(process.execPath, [path.join(here, "fake-pi.mjs"), ...argv], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  /** 反向同步那一段：桩模型的行为就是「照抄【改后的译文】」。 */
  const reverse = (input) => {
    const mark = "【改后的译文】";
    const at = input.indexOf(mark);
    if (at < 0) return input.trim();
    const body = input.slice(at + mark.length);
    const cut = body.search(/\n\s*\n\s*把/);
    return (cut >= 0 ? body.slice(0, cut) : body).replace(/^\n+|\s+$/g, "");
  };
  /** 正向：逐行加前缀、去假名，标题与代码围栏原样。
   *  表格行不能加行首前缀 —— 桥按「行首是不是 | 」数表格行，加了就成了一张没有表格的译文。
   *  所以表格的标记落在单元格尾巴上。*/
  const forward = (input) => {
    const body = input.split("\n\n翻译上面的内容")[0];
    return body
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        if (/^\s*(#{1,6}\s|```|~~~)/.test(line)) return line;
        if (/^\s*\|/.test(line)) {
          const cells = line.split("|");
          return cells
            .map((cell, i) =>
              i === 0 || i === cells.length - 1 || !cell.trim() || /^[\s:-]+$/.test(cell) ? cell : `${cell.trimEnd()} 译 `,
            )
            .join("|")
            .replace(/[\u3040-\u30ff]/g, "");
        }
        return `译 ${line.replace(/[\u3040-\u30ff]/g, "")}`;
      })
      .join("\n")
      .replace(/\s+$/g, "");
  };

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    // 反向同步的 system-prompt 里写着「还原成…原文」，正向是「目标语言是…」。
    const sysAt = argv.indexOf("--system-prompt");
    const sys = sysAt >= 0 ? String(argv[sysAt + 1] ?? "") : "";
    process.stdout.write(`${sys.includes("还原成") ? reverse(input) : forward(input)}\n`);
    process.exit(0);
  });
}
