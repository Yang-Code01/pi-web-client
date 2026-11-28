#!/usr/bin/env node
/**
 * 让 node 跑得动 `import "./x.css"`：**只给单元测试用**。
 *
 * 页面侧的模块会 `import "./xxx.css"`（vite 认得），而 `node --experimental-strip-types`
 * 不认这个后缀 —— 一碰到就 `ERR_UNKNOWN_FILE_EXTENSION`，于是任何**间接** import 到样式表的
 * 视图模块都测不了。`web/tests/review-unit.mjs` 就是这么坏的：它只要 `reviewView()`，却因为
 * `review.ts → gh-setup.ts → github-panel.css` 这一跳整份跑不起来（node 25 起不再放行）。
 *
 * 挂法（放在 `--experimental-strip-types` 后面即可，`--import` 比入口模块先跑）：
 *
 *   node --experimental-strip-types --import ./tools/css-stub.mjs web/tests/review-unit.mjs
 *
 * 只把样式表当成「默认导出一个空对象」的模块，别的一概不动 —— 浏览器里那一份仍由 vite 处理。
 */
import { register } from "node:module";

const hooks = `
export async function load(url, context, next) {
  if (url.endsWith(".css")) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  return next(url, context);
}
`;

// 数据 URL 注册：一个文件就够，不必再拆一个 hooks 模块出去。
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
