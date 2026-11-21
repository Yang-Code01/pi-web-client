---
name: pi-web-e2e-test
description: 用无头浏览器录一段带红框、字幕和中文旁白的端到端视频，产出「bug 复现」或「变更验收」HTML。bug 模式先诊断根因、只写不改；变更模式在修改前/修改后两个环境各录一遍并排对照。当用户说「复现这个 bug 并录下来」「给这个改动做验收」「改前改后各录一段」「出一份 e2e 测试报告」时使用；只手动调用，不自动触发。
disable-model-invocation: true
---

# pi-web-e2e-test

把一次端到端操作录成**看得懂的视频**，再包成一份能直接打开的 HTML。两种模式：

- **bug**：先按 `diagnosing-bugs` 查根因，写修改方案但**先不改代码**；录一段复现视频，报告里放现象、原因、复现手顺、修改方案。
- **change**：按 spec / 上下文 / PR 写用例，在**修改前**和**修改后**两个环境各录一遍，报告里并排对照。

产物默认写到**主检出**的 `.scratch/e2e/<时间>-<ascii-slug>/`（在 worktree 里跑也不会写进 worktree，避免删 worktree 时被一起删掉）：

```
<slug>bug.html        或   <slug>变更.html
spec.json             报告读取的最终数据
media/after.mp4       完整录像（H.264 + AAC）
media/after.vtt       字幕
media/before.mp4      修改前（change）
media/after-<case>.mp4 每条用例的切片
cases/                用例脚本副本（便于下次复用）
raw/                  webm、TTS wav
shots/                h.shot() 额外截图
raw-spec-after.json   原始录制元数据（调试用）
run.log
```

## 先看环境

```bash
node .pi/skills/pi-web-e2e-test/bin/e2e.mjs doctor --dir <仓库或 worktree>
```

`doctor` 会检查 Node、git、系统 ffmpeg（必须有 libx264 + AAC）、Playwright、中文 SAPI 语音、测试环境 CLI。缺 ffmpeg 或 Playwright 就先修，不要硬跑。

## A. bug 复现

### 1. 先诊断，不改代码

如果用户给的 bug 描述不够复现（缺页面、缺操作、缺期望），先用 `ask_user_question` 问清；不要猜一个 bug 来录。

调用 `diagnosing-bugs` 技能（或按它的循环）定位根因。产出：

- 根因，最好落到**文件:行** + 证据（日志、代码路径、复现条件）。
- 修改方案：文件:行 + 思路 + 关键代码草图。
- **不要落盘改产品代码。** 这个模式的交付物是视频和报告，不是 patch。

### 2. 写复现用例

在 `.scratch/e2e/<slug>/` 下写 `case.mjs`（参考 `cases/example.mjs` 和 `references/writing-cases.md`）。要点：

- 用 `h.step("...", { say: "短句旁白" })` 把复现手顺拆成一步一步；旁白要短，Windows SAPI 中文大约 4–6 字/秒。
- 点击走 `h.click()`（自动红框 + 假光标 + 点击波纹），按键走 `h.press()`（键帽），拖拽走 `h.drag()`，滚动走 `h.scroll()`。
- 在 bug 出现的那一刻调 `h.moment("一句话描述现象")`，后处理会以 0.25× 插播，画面右上角有「慢放」徽标。
- 期望行为用 `h.expect(...)` 记录；默认只记录、不中断录制，失败会显示在报告里。只有确实要中断整条用例时才加 `{ critical: true }`。
- 用例的 `meta` 写 `title`、`slug`、`expect`；`h.case()` 的标题与之一致。

### 3. 写报告内容

同目录写 `meta.json`。bug 模式常用字段：

```json
{
  "title": "提交后草稿没有清空",
  "slug": "draft-not-cleared",
  "summary": "一句话说明这次复现。",
  "symptom": "点了发送之后，输入框里还留着刚才的文字。",
  "expected": "发送成功后输入框应为空。",
  "actual": "文字仍在，且再次发送会重复。",
  "causeHtml": "<p>根因在 <code>web/src/app.ts:1234</code>：...</p>",
  "fixHtml": "<p>在 <code>...</code> 处补 ...；这只是方案，未落盘。</p>"
}
```

`causeHtml` / `fixHtml` 会原样放进报告，可以写 `<p>`、`<pre>`、`<code>`、`<ul>`。没有 HTML 就写 `cause` / `fix` 纯文本。

### 4. 跑

```bash
node .pi/skills/pi-web-e2e-test/bin/e2e.mjs bug \
  --case .scratch/e2e/draft-not-cleared/case.mjs \
  --meta .scratch/e2e/draft-not-cleared/meta.json \
  --dir <仓库或 worktree>
```

- 默认会自己起一个隔离测试环境（口令 `test`，不开窗口），跑完自动关。
- 想复用已经起好的环境：`--env http://127.0.0.1:17876/` 或 `--env <实例 id>`；这时不会关它。
- 想看环境一直留着：`--keep`（会打印 stop 命令）。
- 断言失败**不会**让这个模式退出非零；录制/转码失败才会。

### 5. 交付

报告生成后，按客户端约定单独问一次「要在预览里打开吗？」——用户选打开再 `open_preview`，不要自己开 Edge 窗口。把绝对路径和关键结论一起说清楚。

## B. 新变更 / 修改后测试

### 1. 定用例

优先级：**spec.md > 对话上下文 > PR 内容**。没有 spec 就从 diff 和 PR 描述里提炼用户可见行为，别把内部重构当用例。用例要能回答「改前是什么、改后是什么」。

在 `.scratch/e2e/<slug>/case.mjs` 写用例。**同一份用例会跑两遍**：

- `before`：默认 `git merge-base HEAD main` 的代码（自动建临时 worktree + 测试环境）。
- `after`：当前 `--dir` 的代码（自动起测试环境）。
- 断言写**修改后**的期望；修改前失败是正常的对照，不要为了让 before 通过而放宽断言。
- 用 `--before <ref>` 覆盖基准（比如某个 tag 或父提交）。

### 2. 写报告内容

```json
{
  "title": "会话列表支持按更新时间排序",
  "slug": "session-sort",
  "summary": "列表头新增排序菜单；切换后立即按更新时间重排。",
  "changeTitle": "会话列表排序",
  "source": "spec.md §2.3 / PR #612",
  "coverage": [
    { "item": "默认按更新时间倒序", "status": "covered", "note": "case 1" },
    { "item": "切换为名称排序", "status": "covered", "note": "case 2" },
    { "item": "刷新后保持排序", "status": "not-covered", "note": "需要持久化断言，留给下一轮" }
  ],
  "uncovered": ["排序偏好在重启后的持久化"]
}
```

`source` 写清依据来自 spec 的哪一节或哪个 PR；`coverage` / `uncovered` 会进报告的覆盖矩阵。

### 3. 跑

```bash
node .pi/skills/pi-web-e2e-test/bin/e2e.mjs change \
  --case .scratch/e2e/session-sort/case.mjs \
  --meta .scratch/e2e/session-sort/meta.json \
  --dir <当前 worktree>
```

- 自动建 `../<repo>-wt/e2e-<run>-before`，junction 依赖，跑完删除（`--keep` 保留）。
- 两个环境串行启动、串行录制，避免端口和资源打架。
- `--env <URL|ID>` 在 change 模式下只作为**修改后**环境复用；修改前仍然按 `--before` 起。
- 修改后有失败用例时退出码为 1；报告照常生成。修改前失败不影响退出码。

### 4. 交付

同样单独问一次预览；报告里每条用例有并排双视频、步骤 chip、同步播放/暂停、按步骤跳转和速度选择。

## 用例 API（速查）

完整说明见 `references/writing-cases.md`。先记住这些：

| API | 作用 |
| --- | --- |
| `h.case({id,title,expect})` / `h.endCase()` | 一条用例的开始/结束；结束时显示结果卡 |
| `h.step(title,{say,caption,hold})` | 一步；先合成旁白，再显示步骤条/字幕，等旁白读完 |
| `h.click(target,{label})` | 滚动到元素 → 假光标 → 红框 → 点击 → 波纹 |
| `h.fill(target,text,{label,delay})` | 点击 + 清空 + 逐字输入；失败回退一次填入 |
| `h.press(key,{label})` | 按键，右下角显示键帽 |
| `h.scroll(target,deltaY)` | 滚动，并显示方向标记 |
| `h.drag(from,to)` | 拖拽，红色虚线 + 起终点 |
| `h.hold(ms,{label})` | 纯等待（加载、动画），带计时标记 |
| `h.waitFor(target,{state,timeout})` | 等元素出现/消失，带加载计时 |
| `h.expect(desc,actual,expected,{critical})` | 断言；失败默认只记录，`critical:true` 才中断 |
| `h.moment(label,{slow,lead,tail})` | 标记瞬时 bug，后处理慢放 |
| `h.shot(name)` | 额外截图 |

`target` 可以是 CSS 字符串或 Playwright Locator；页面对象是 `h.page`，需要原生操作时直接用。

## 自测

```bash
cd .pi/skills/pi-web-e2e-test
node --test tests/*.test.mjs                 # 纯函数与报告单测
PI_WEB_E2E_SMOKE=1 node --test tests/e2e-cli.test.mjs  # 真起环境跑 bug/change（慢）
```

## 硬规则

- **bug 模式不改产品代码**；只写复现用例和报告。要修另开 worktree、另开 PR。
- **产物不进 worktree 的 `.scratch`**：默认写主检出；`--out` 明确指定时除外。
- **不碰 7864 的正式实例**：默认走 `pi-web-client-test-dev` 的隔离环境；端口从 17864 起。
- **跑完清场**：不 `--keep` 时环境会停、修改前 worktree 会删；`--keep` 时把 stop 命令和目录路径告诉用户。
- **删 worktree 只用 `tools/worktree-remove.mjs`**，不要 `git worktree remove --force`。
- **TTS 可关但不要默认关**：`--no-tts` 只在没有中文语音或用户明确要求静音时用；字幕仍然保留。
- **视频要能看清**：每一步等旁白读完；点击前至少停 350ms；瞬时现象用 `h.moment`，不要靠加快节奏蒙混。

## 排查

先看 `run.log`，再看 `raw-spec-after.json` 里的 `errors` / `console` / `network`。常见问题：

- `Playwright 没有开始录像`：`recordVideo` 没生效，确认 `--viewport` 合法。
- `overlay 注入失败`：页面 CSP 或导航太早；`bypassCSP` 已开，检查是否在 `goto` 前就注入了。
- 视频没有声音：检查 `raw/tts/` 是否有 wav；SAPI 没有中文语音时用 `--no-tts`，或 `--voice` 指定。
- 视频时间对不上：`h.moment` 的 `lead/tail` 调小；时间映射在 `lib/timeline.mjs`，有单测。
- 修改前环境起不来：确认 `--before` 的 ref 里有 `pi-web-client-test-dev` 技能和 `tools/playwright.mjs`；没有就换 ref 或 `--before` 指定一个更近的提交。

更多见 `references/pitfalls.md`。
