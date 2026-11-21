# 写一条 e2e 用例

用例是一个 ES module，导出 `meta` 和一个 `default async function (h)`。`h` 由驱动注入，封装了录制时需要的所有动作——直接用 Playwright 也可以，但红框、光标、字幕和旁白只有走 `h.*` 才会出现。

```js
export const meta = {
  title: "会话列表支持按名称排序",
  expect: "切换排序后，列表立即按名称重排。",
  slug: "session-sort"          // 可选；CLI 的 --slug 优先
};

export default async function (h) {
  await h.case({ id: "sort-by-name", title: "按名称排序", expect: meta.expect });

  await h.step("打开排序菜单", { say: "先点排序。" });
  await h.click('button[data-act="sort"]', { label: "排序" });

  await h.step("选择名称", { say: "选名称。" });
  await h.click('button[data-sort="name"]', { label: "名称" });

  const names = await h.page.locator(".session-row .title").allInnerTexts();
  const sorted = [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
  await h.expect("列表按名称排序", names, sorted);

  await h.endCase();
}
```

## 一条用例的生命周期

1. `h.case({id,title,expect})`：显示「用例 N」卡，1.25 秒后开始。`id` 只允许稳定字符（会进文件名），不同用例不要重名。
2. 若干 `h.step()`：每步先合成旁白（TTS），再显示顶部步骤条和底部字幕，等旁白读完再继续。
3. 动作：`click / fill / press / scroll / drag / hold / waitFor`。
4. 断言：`h.expect()`。失败默认只记录、继续跑；`{critical:true}` 才抛错并终止本条用例。
5. `h.endCase()`：显示通过/失败/出错卡，1 秒后切下一条。

没有 `h.case()` 时，驱动会在最后自动补一条 `run` 用例。多条用例写多个 `h.case()`/`h.endCase()` 即可。

## 旁白与节奏

- Windows SAPI 中文大约 **4–6 字/秒**。一句 20 字大约 4 秒；旁白超过 30 字，视频就会明显拖。
- `say` 是给耳朵的，`title` 是给眼睛的。两者不要一模一样地重复；`buildStepCues` 会在相同时只留一个。
- 点击前驱动会自动停 350–550ms；需要更多停顿用 `h.hold(ms,{label})`，不要用 `page.waitForTimeout()` 裸等（不会有计时标记）。
- 瞬时现象（一闪而过的 toast、闪屏、错误提示）用 `h.moment("一句话")`，不要试图用慢动作手速去追。后处理会以 0.25× 插播。
- 不要在一步里塞太多动作。一个动作一个 `step`，观众才能跟上。

## 选择器

优先用应用已有的稳定钩子，而不是文字：

```js
'button[data-act="new"]'        // 开新会话
'button[data-act="skills"]'     // 技能
'.composer textarea'            // 输入框
'.new-sheet button.btn.primary' // 新会话面板的确认
'.skill-pop'                    // 技能面板
```

文字选择器只在没有钩子时用，并尽量 `exact: true`：

```js
h.page.getByRole("button", { name: "发送", exact: true })
```

`target` 可以是 CSS 字符串或 Locator。驱动会在动作前 `scrollIntoViewIfNeeded()` 并取 `boundingBox()` 画红框；ElementHandle 不支持，请传 Locator。

## 动作细节

### click

```js
await h.click(target, {
  label: "发送",       // 红框上方的标签；默认是「点击」（右键为「右键」），不是元素文本
  moveMs: 420,        // 假光标移动时长
  preClickMs: 420,    // 红框出现到按下之间
  postClickMs: 320,   // 按下到松开/波纹
  button: "left",
  force: false
});
```

点击后会保留红框到下一步/下一次 fill 或 overlay 清理，同时留下一个短暂波纹；这样报告里能看清刚才点了哪。点击失败会抛错；先确认元素可见、没有被遮挡。

### fill

```js
await h.fill(".composer textarea", "你好", { label: "输入框", delay: 45 });
```

先点击聚焦，再 `fill("")` 清空，然后逐字 `pressSequentially`；逐字失败会回退一次 `fill()`。输入过程中红框保留。

### press

```js
await h.press("Escape", { label: "Esc" });
await h.press("Control+Enter", { label: "Ctrl+Enter" });
```

键帽显示在右下角，`Control+Enter` 这类组合键整串显示成一个键帽。

### scroll / drag / hold / waitFor

```js
await h.scroll(".session-list", 480);           // 正数向下
await h.drag(".card", ".trash");                 // 红色虚线 + 起终点
await h.hold(900, { label: "等待保存" });
await h.waitFor(".toast", { state: "visible", timeout: 8000 });
```

`waitFor` 带计时标记；超时会抛错。`hold` 用于纯等待，`waitFor` 用于等 DOM。

## 断言

```js
await h.expect("标题", await h.page.title(), "pi");
await h.expect("输入框内容", await h.page.locator("textarea").inputValue(), "你好");
await h.expect("面板关闭", await h.page.locator(".skill-pop").isVisible(), false);
await h.expect("文字包含关键字", text.includes("已保存"), true);
```

- 比较用 `node:util.isDeepStrictEqual`，对象/数组可以直接比。
- 失败默认只记录，本条用例记为 `fail`，后面的步骤继续跑（这样才能把 bug 现象录完）。
- **bug 复现**直接用默认值：记录失败但不中断录制，报告里会显示「期望 / 实际」。确实要保护后续步骤时才用 `{ critical: true }`。
- 不要断言实现细节（内部类名、DOM 结构），断言用户能看到的结果。

## 等待

- 优先 `h.waitFor(locator, {state:"visible"|"hidden"|"attached"})`。
- 等网络/动画用 `h.hold(ms,{label})`，并在 label 里写清等什么。
- 不要 `await new Promise(r => setTimeout(r, 5000))`：没有标记，视频里会像卡住。

## bug 模式

1. 先按 `diagnosing-bugs` 找到根因，写修改方案；**不要改代码**。
2. 用例按最小复现路径写；每一步都是用户能看懂的操作。
3. 在现象出现的那一刻 `h.moment("...")`；如果现象是「值没变」，先做一次 `h.expect(...)` 再 moment。
4. 断言失败不要抛；这样视频能完整录到「实际是什么样」。
5. `meta.json` 里的 `causeHtml` / `fixHtml` 由诊断结果填写；报告会原样渲染。

## change 模式

- 同一份脚本跑 before/after；断言写**修改后**的期望。
- before 失败是正常的对照；不要为了让 before 通过而放宽断言。
- 用例要覆盖用户可见行为，不要把纯重构算进去。
- 如果某条用例在 before 也通过，说明它没有验证到这次变更；在 `meta.coverage` 里标 `partial` 或换用例。

## 多用例

```js
await h.case({ id: "default", title: "默认排序", expect: "..." });
// ...
await h.endCase();

await h.case({ id: "persist", title: "刷新后保持", expect: "..." });
// ...
await h.endCase();
```

每条用例的切片从 `h.case()` 开始到 `h.endCase()` 结束；报告按 case 并排。用例之间不要依赖上一条留下的页面状态——需要就重新导航。

## 调试

- `h.shot("name")` 额外存一张截图到产物目录的 `shots/`。
- `h.log("...")` 写进 `run.log`。
- 失败时先看 `run.log`，再看 `raw-spec-after.json` 的 `errors` / `console` / `network`。
- 只想看动作不想等旁白：`--no-tts`；但交付前用默认设置再录一遍。
