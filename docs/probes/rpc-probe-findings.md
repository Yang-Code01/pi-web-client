# RPC 实测结论（pi 1.4.0，本机）

原始数据：`probes/out/raw.jsonl`、`probes/out/rpc-probe.md`。探针脚本：`probes/rpc-probe.mjs`、`probes/rpc-probe2.mjs`、`probes/resume-test.mjs`、`probes/gate-probe.ts`。

## 1. 能跑通的

| 事项 | 结果 |
|---|---|
| `node <cli.js> --mode rpc -ne -e <gate.ts>` | ✅ 扩展正常加载，`ctx.hasUI=true`、`ctx.mode="rpc"` |
| `prompt` 命令 | ✅ `{"disposition":"started"}`；事件流正常（`agent_start`/`turn_*`/`message_*`/`tool_execution_*`/`agent_end`/`agent_settled`） |
| 审批往返 | ✅ `tool_call` → `ctx.ui.confirm` → `extension_ui_request{confirm,id,title,message,timeout}` → 回 `{type:'extension_ui_response',id,confirmed:true}` → 工具执行 |
| 拒绝 | ✅ `confirmed:false` → 扩展返回 `{block:true,reason}` → agent 收到，run 正常结束 |
| `cancelled:true` | ✅ 对 confirm 等价于 false（扩展拿到 `false`） |
| 超时 | ✅ `ctx.ui.confirm(..., {timeout:3000})` → pi **自己**在 3 秒后以 `false` resolve，扩展照常收到（不是 bridge 的责任） |
| 会话复活 | ✅ `--session <已有.jsonl>` → 实测恢复 16 条消息 / 18 个条目 / 同一 leafId |
| 增量条目 | ✅ `get_entries(since=firstId)` 返回 19/20（since 为**排他**） |
| stdout 纯净度 | ✅ 扩展里用 `console.error` 记日志时，非 JSON 行 = 0 |
| `-ne` + 显式 `-e` | ✅ 未装包的干净进程仍能加载指定扩展；settings 里的 provider/model 照常生效（实测用的是 wb2api/cn:deepseek-v4.1-flash） |

## 2. 三个必须绕开的坑（实测）

### 2.1 `abort` 在审批挂起时永远不返回
- 现象：有 pending confirm 时发 `{"type":"abort"}`，**15 秒、8 秒都没有 response**（探针两次）。
- 补发 `cancelled:true` 之后，`agent_settled` 立刻到达，`get_state.isStreaming=false`，再发 `prompt` 正常。
- 结论：**中断的正确顺序是「先应答掉该会话所有 pending confirm（cancelled），再发 abort」**；abort 必须带客户端超时、不能阻塞 UI 线程。

### 2.2 `RpcClient` 不能用来做审批
- `dist/modes/rpc/rpc-client.js:412 handleLine()` 会把 `extension_ui_request` 当事件派发（能收到），但类里**没有公开方法**发 `extension_ui_response`。
- 私有 `send()` 实现是 `{...command, id: 'req_N'}` —— **id 在后、会覆盖调用方给的 id**，而审批应答必须回服务端原来的 id。
- 结论：bridge 自写 ~200 行客户端（严格按 `docs/rpc.md` 的分帧规则：按 `\n` 切、去 CR、禁用 readline）。`RpcClient` 只作参考。

### 2.3 用户装的 `question` / `questionnaire` 扩展在 RPC 下不可用
- `~/.pi/agent/extensions/question.ts:73`、`questionnaire.ts:110` 都走 `ctx.ui.custom()`，而 `docs/rpc-extension-ui.md` 明确：RPC 模式下 `custom()` 返回 `undefined`。
- 结论：bridge 子进程用 `-ne` 不加载它们；要「问用户」能力就自带一个走 `ctx.ui.select` / `ctx.ui.input` 的 `ask` 工具。

## 3. 其它记录

- `get_state` 字段：`model, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, sessionFile, sessionId, autoCompactionEnabled, messageCount, pendingMessageCount`。
- `get_available_models` 本机 18 个；`get_session_stats` 给 `sessionFile/userMessages/assistantMessages/toolCalls/toolResults/tokens`。
- `prompt` 带图：`{"type":"prompt","message":"...","images":[{"type":"image","data":"<base64>","mimeType":"image/png"}]}`。
- 流式期间再发 `prompt` 必须带 `streamingBehavior: "steer"|"followUp"`，否则报错。
- `tool_execution_end` 带 `durationMs`（有用：卡片上的耗时直接取它）。
- `get_entries` 条目类型实测只有 `model_change` / `thinking_level_change` / `message`（本机 settings 下），渲染时以 `message` 为主，其余当元数据。
