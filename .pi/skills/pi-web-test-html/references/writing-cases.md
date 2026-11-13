# 写用例集（cases/<name>.mjs）

用例集只写「测什么、看哪里、算不算过」。浏览器、登录、截图落盘、spec.json 由 `bin/run-book.mjs` 负责。

```js
export const meta = {
  title: "pi-web-client · 本机管理「上下班」模块 测试书",
  module: "本机管理 / 上下班",   // 写进总览与环境页
  branch: "feat/workclock",
  pr: "#414",
  decision: "D246",              // 有就写，没有留空
  output: "上下班模块-测试书",    // xlsx/html 的文件名（不含扩展名）
  order: ["TC-01", "TC-02"],     // 用例执行与排序顺序
};

export default async function workclock(h) {
  const { page, ctx, base, openCase, step, ok, fail, shot } = h;
  // …
}
```

`h` 上还有什么：`api(path)`（GET JSON）、`apiPost(path, data)`、`ps(command)`（Windows PowerShell，返回 trim 后的 stdout）、`cases`、`sortCases(order)`、`log(msg)`、`browser`。

## 四件套

```js
openCase({ id: "TC-01", title: "分区入口与首次打开", module: "…", priority: "P0", precondition: "全新状态目录" });
const s = step("点「上下班」分区", "大字显示 --:--:--");   // 预期写成给人看的结果
ok(s, `大字「${digits}」`);                                // 实际观察
if (digits !== "--:--:--") fail(s, `大字应是 --:--:--，实际 ${digits}`);
await shot(s, ".sys-wk-hero", "hero");                    // 截这块界面
```

- 一条 case 可以有很多 step；任一步 `fail` 之后，这条 case 的判定就是「失败」。**不要** fail 后 `return`，后面的步骤与截图仍要收进来——测试书要能看出坏在哪一步。
- 人工步骤（要人锁屏、要 UAC 弹框）也写成 step，判定标「人工」：`cur.verdict = "人工"`（`cur` 是 `openCase` 的返回值），并在 `expected`/`actual` 里写清「怎么补、补完看什么」。
- `shot(s, selector, name)` 会重试 4 次（元素在重渲染里会被换掉），文件名是 `<case>-<step>-<name>.png`。一张图信息量不够就再截一块，`s.shots` 会全部收进 xlsx。

## 断言口径

- **只断言产品该保证的事**：时间口径、接口码、状态文案、可见数字格式。别断言像素、别断言随机 id。
- **数值断言留容差**：倒计时每秒在走，比 `|target − now − remainingMs| ≤ 3000`，不要比具体字符串。
- **时间种子相对 now 生成，不写死 09:04**。写死就会出现「凌晨跑时种子落在未来、被产品过滤、用例假失败」——本仓库踩过。给「今天已过的时点」写一个 `todaySchedule(span)` 之类的函数。
- **状态目录别硬编码**：从接口里读回来（例如 `st.agent.scriptPath` 的 dirname），不同实例、不同用户名下路径都不一样。
- 用例之间会共享状态（装记录器 → 卸记录器 → 再装），顺序由 `meta.order` 固定；新用例插在原顺序里，别依赖字母序。

## 截图

- 截**元素**（分区根容器、卡片、表格），不截整个视口：测试书里贴的是「这一步看到的那块」。
- 表格长过一屏时用 `scrollTop` 偏移滚动，不要 `scrollIntoView`（会被 sticky 头挡住）。
- 列表页先把骨架屏等掉：`waitForFunction(() => !document.body.innerText.includes("正在读取"))`。

## 有系统副作用的模块

装计划任务、写 `%APPDATA%`、改注册表这类步骤：

1. `setup/<用例集>.sh` 写清「怎么回到干净状态」，`bin/env.sh fresh` 会先跑它；
2. 用例里自己卸掉（并断言卸干净：任务不存在、进程退出、自启没了）；
3. 失败中断时 `setup/<用例集>.sh` 仍能兜底，别把机器留在半装状态。
