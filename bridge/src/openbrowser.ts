/**
 * `npm start` 之后顺手把页面打开（用户要求：以前只打印地址，还得自己去浏览器里粘）。
 *
 * 只在**人手动在终端里启动**时开：看门狗、热部署、更新脚本、测试环境的 stdout 都是管道或文件，
 * `isTTY` 为假 —— 那些自动重启要是每回都弹一个标签，一天下来能开一屏。
 * `PI_WEB_OPEN=1` / `PI_WEB_OPEN=0` 可以不管终端判断，强制开或关。
 */
import { spawn } from "node:child_process";

const ON = new Set(["1", "true", "yes", "on", "always"]);
const OFF = new Set(["0", "false", "no", "off", "never"]);

/** 该不该开：显式开关优先，没写就看这次启动是不是接在终端上。 */
export function shouldOpenPage(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  const flag = String(env.PI_WEB_OPEN ?? "").trim().toLowerCase();
  if (ON.has(flag)) return true;
  if (OFF.has(flag)) return false;
  return isTTY;
}

/** 交给系统默认浏览器：Windows `start`，macOS `open`，Linux `xdg-open`。 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  // `start` 会把第一个带引号的参数当成窗口标题，空的 `""` 占住它，URL 才被当成 URL。
  if (platform === "win32") return { cmd: "cmd.exe", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

/**
 * 打开页面。fire-and-forget：`start` / `xdg-open` 自己会退出，浏览器起没起、抢没抢焦点
 * 都不该挡住 bridge 继续起。
 */
export function openPage(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const { cmd, args } = browserCommand(url, platform);
  try {
    // 不 detached：Windows 上 DETACHED_PROCESS 没有桌面关联，`start` 会静默什么也不做
    //（terminal.ts 里同样的坑）。cmd 自己的黑框用 windowsHide 藏掉。
    const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    // 没有这个监听器，找不到 opener（比如精简过的 Linux 没装 xdg-open）时 'error' 没人接，
    // 会变成未捕获异常把 bridge 带走。开不成页面不是什么大事，安静算了。
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
