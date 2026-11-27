/**
 * 沙箱词表：谁要把「别人发来的网页」放进 iframe（内网通的预览弹窗），或者把它当成一份文档发出去
 * （peer 的 `/files`、`/fs/raw` 响应头里的 CSP），用的都是这一串。两处对不上，就意味着「在弹窗里
 * 跑不跑脚本」和「单独打开时跑不跑脚本」不是同一个答案 —— 所以只留一份。
 *
 * 不带 `allow-same-origin`：页面跑在 opaque origin 里，读不到本站的 localStorage / cookie /
 * 同源接口。叶子文件（不 import 任何东西）：peer 的 tsc 与页面的 vite 都要能引它。
 */
export const SANDBOX_TOKENS = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** CSP 里那一整条（`sandbox` 后面跟令牌）。 */
export const SANDBOX_CSP = `sandbox ${SANDBOX_TOKENS}`;
