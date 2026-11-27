/**
 * 页面这一侧的沙箱词表。词表本身住在 `peer/src/sandbox.ts` —— peer 发出去的 CSP 与这里塞进
 * `<iframe sandbox>` 的属性必须是同一串，否则「弹窗里跑不跑的脚本」和「单独打开时跑不跑的脚本」
 * 会分叉。页面别处一律从 `./sandbox.ts` 引，不要直接摸 `../../peer/` 的路径。
 */
export { SANDBOX_TOKENS } from "../../../peer/src/sandbox.ts";
