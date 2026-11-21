# 踩坑清单

按「症状 → 原因 → 做法」排。先跑 `doctor`，一半的问题在那一步就能看见。

## 产物 / worktree

**症状**：合完 PR、删了 worktree，报告和视频一起没了。
**原因**：产物写进了 worktree 的 `.scratch/`，`git worktree remove` 会把未跟踪文件一起删。
**做法**：默认产物写主检出 `.scratch/e2e/`；只有明确要留在 worktree 时才用 `--out`。删 worktree 一律 `node tools/worktree-remove.mjs <dir>`，不要 `git worktree remove --force`。

**症状**：`removeBeforeWorktree` 拒绝删除，报「拒绝删除非 e2e worktree」。
**原因**：目录名不是 `e2e-*-before`，或不在 `<repo>-wt/` 下。
**做法**：只让技能自己建/删 before worktree；手工建的临时 worktree 自己用 `worktree-remove.mjs` 清。

## 环境 / 端口

**症状**：`startEnv` 超时，日志里 `EADDRINUSE`。
**原因**：端口被别的实例或残留进程占了；17864 起，7864/7865/7866 永久保留。
**做法**：`node .pi/skills/pi-web-client-test-dev/bin/env.mjs list` 看谁在用；`stop --id <id>`；不要手动改端口。

**症状**：报告里的链接能开，但页面是登录框。
**原因**：复用了 `--env` 的外部实例，但没有登录，或者口令不是 `test`。
**做法**：`--env` 只接受本仓库测试环境 CLI 起的实例；外部实例要么先登录，要么让技能自己起。`login` 字段在 `raw-spec-*.json` 里可查。

**症状**：change 模式 before 环境起不来，提示找不到 `pi-web-client-test-dev`。
**原因**：`--before` 指向太老的提交，那时还没有测试环境技能。
**做法**：用默认 merge-base；或者 `--before <ref>` 指向包含该技能的提交。不要拿几周前的 tag 硬跑。

**症状**：跑完机器上多了一堆 Edge 窗口。
**原因**：测试环境 CLI 默认会开窗口；技能已用 `--no-open`，但手工起的实例可能没带。
**做法**：技能起的实例都带 `--no-open`；`--keep` 时把 stop 命令告诉用户，别让窗口一直留着。

## Playwright / 录制

**症状**：`Playwright 没有开始录像` 或 `recordVideo` 目录里没有 webm。
**原因**：`recordVideo` 只在 `newContext` 时生效；context 没关就取不到文件；viewport 非法也会静默失败。
**做法**：确认 `recordVideo` 在 `newContext({...})` 里，`context.close()` 后再 `video.saveAs()`；viewport 用 `1280x800` 或 `1440x940`。

**症状**：视频开头少了一截，点击对不上画面。
**原因**：`t0` 取得太晚（比如在 `goto` 之后），录像其实已经开始了。
**做法**：`t0 = Date.now()` 放在 `newContext()` 之前；本技能的 driver 已经这么做。

**症状**：页面上的红框/字幕没出现。
**原因**：`addInitScript` 在 `goto` 之后才注入，或者页面 CSP 拦了内联样式。
**做法**：在 `newContext` 后、`newPage` 前 `addInitScript`；context 已开 `bypassCSP: true`。如果页面自己清了 `body`，检查 `#__e2e_overlay` 是否被移除。

**症状**：点击报 `element is not visible`，但截图里明明有。
**原因**：元素被弹层遮挡，或者在滚动容器外。
**做法**：先 `h.waitFor` 等弹层关闭；`h.click` 会 `scrollIntoViewIfNeeded`，仍不行就用 `force: true` 并确认副作用可接受。

## 视频 / ffmpeg

**症状**：`ffmpeg 不支持 libx264 / aac`。
**原因**：用了 Playwright 自带的 ffmpeg（只有 VP9/PNG），或者 PATH 里是精简版。
**做法**：`doctor` 会检查；装完整版 ffmpeg（winget Gyan 包），或 `FFMPEG_PATH` 指向完整 ffmpeg。不要用 `ms-playwright/ffmpeg-*/ffmpeg-win64.exe`。

**症状**：报告里的视频黑屏/无法拖动。
**原因**：用了 webm 或没有 `faststart`；浏览器对某些 VP9 支持不好。
**做法**：最终产物一律 H.264 + AAC、`-movflags +faststart`；webm 只留在 `raw/`。

**症状**：慢放段和字幕对不上。
**原因**：字幕用了 raw 时间，或者 `h.moment` 的 `lead/tail` 太大，把无关段落也慢放了。
**做法**：字幕/音频都用 `buildTimeMap` 的 final 时间；`h.moment` 默认 `lead:0.8 tail:0.6`，只覆盖现象前后；重叠的 moment 会被合并。

**症状**：视频没有声音。
**原因**：SAPI 没有中文语音、TTS 失败被静默降级，或 `--no-tts`。
**做法**：看 `raw/tts/` 是否有 wav；`doctor` 会列中文语音；用 `--voice "Microsoft Huihui Desktop"` 指定；没有中文语音就 `--no-tts`，字幕仍在。

**症状**：旁白读到一半就切下一步。
**原因**：SAPI 时长和实际播放不一致，或 `step` 没等音频。
**做法**：`h.step` 会等 `audioDuration + 250ms`；不要手工 `h.hold` 替代。旁白太长就删字，不要加速到听不清。

## 文件名 / 路径

**症状**：报告文件名变成 `runbug.html` 或含 `?`、`:`。
**原因**：`slug` 来自标题，Windows 不允许这些字符。
**做法**：`--slug` 显式给一个短横线 slug；`safeFileStem` 会保留中文、替换非法字符，但不要依赖它收拾一长串标题。

**症状**：中文路径下 ffmpeg 报 `No such file`。
**做法**：所有路径都加引号；Node 侧用 `path.resolve`，不要手工拼 `/`。ffmpeg 参数用数组传，不要拼 shell 字符串。

## 断言 / 报告

**症状**：bug 模式的视频在断言失败处就停了。
**原因**：`h.expect` 默认只记录；有人加了 `{ critical: true }` 才会抛。
**做法**：bug 复现保持默认；只有后续步骤依赖前面结果、失败后跑下去没意义时才加 `{ critical: true }`。

**症状**：change 的 before 视频全是失败，报告看起来像坏了。
**原因**：这是预期对照；before 本来就不该通过新行为的断言。
**做法**：在 `meta.summary` / `coverage` 里说明「before 失败是预期」；不要为了让 before 绿而删断言。

**症状**：报告打不开视频，控制台 404。
**原因**：报告被移动了，或者 `media/` 没跟着走；视频是相对路径。
**做法**：整个输出目录一起移动；不要只拷 HTML。预览时用目录里的 HTML 路径。

**症状**：报告里的步骤按钮点了没反应。
**原因**：`data-seek` 找不到对应 `<video>`，或视频还没 metadata。
**做法**：等 `loadedmetadata` 后再绑事件；报告脚本已在 `DOMContentLoaded` 后绑，视频用 `preload="metadata"`。

## 其它

- **不要用 `python` 改这些文件**：Windows 默认 GBK，中文会炸；用 Node `fs.readFileSync(path,"utf8")` / `writeFileSync`。
- **不要 commit `raw/` 和 `media/` 进仓库**：产物在 `.scratch/`，本来就不进 git；如果手工放到别处，记得 `.gitignore`。
- **`--keep` 不是免费的**：它会留下测试环境和 before worktree；交付时把 `stop` 命令和目录路径一起给用户。
- **`doctor` 通过不代表用例对**：它只检查工具链；选择器和断言还得自己跑一遍。
