---
description: 录一段带红框、字幕和中文旁白的 e2e 视频：bug 复现（只诊断不改）或变更验收（改前/改后对照）
argument-hint: "[bug 描述或变更说明；也可写 case 路径、--before 等]"
---
把这次 e2e 验收跑成一份能直接打开的报告。流程写在 `.pi/skills/pi-web-e2e-test/SKILL.md`，**第一步就用 read 把它读完**，再按里面的顺序做。

- 用户要复现 bug：按 `diagnosing-bugs` 找根因，写修改方案但**先不改产品代码**；录复现视频，产出 `<描述>bug.html`。
- 用户要验新变更 / 修改后测试：用例优先级 spec.md > 上下文 > PR；同一份 case 在修改前（`git merge-base HEAD main`）和修改后各录一遍，产出 `<描述>变更.html`。
- 信息不足（缺复现步骤、缺期望、缺代码来源）时，用 `ask_user_question` 问清再动手；不要猜。
- 视频必须能看清：每一步等旁白读完，点击有红框，瞬时现象用 `h.moment()` 慢放。
- 产物默认写主检出 `.scratch/e2e/`；跑完停环境、删 before worktree。
- 报告生成后单独问一次「要在预览里打开吗？」，用户选打开再 `open_preview`。

补充要求（命令行后面跟的字，没有就忽略这行）：$@
