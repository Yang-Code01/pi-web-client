# pi coding agent 对外集成面：事实报告

基线：`@earendil-works/pi-coding-agent@1.4.0`（本机路径 `C:\Users\GG_Bond\AppData\Local\nvm\v23.11.1\node_modules\@earendil-works\pi-coding-agent`）。下文 `证据` 路径均相对该包根目录。`dist/` 是真实实现，`docs/` 仅作说明；冲突处以 `dist/` 为准。

## 0. 结论速览

1. RPC = **一个子进程 + stdin/stdout 上的 JSONL**，没有 TCP/HTTP/WS，没有端口。
2. 一个 RPC 进程 = **一个 active 会话**；切会话是在进程内 `switch_session`/`new_session` 替换，不是多路复用。
3. **没有任何内建的工具审批**。审批只能由扩展在 `tool_call` 钩子里用 `ctx.ui.confirm/select` 实现，经 `extension_ui_request` 转发给客户端；客户端不回就**永久挂起**（无内建超时）。
4. 会话文件是 append-only JSONL，**没有跨进程锁**。双进程写同一文件不会立刻崩，但会形成隐形分支，compaction 可能丢上下文。
5. 浏览器必须自己写 Node bridge（RPC 或 SDK 二选一）；pi 侧没有可直接给浏览器用的服务端，OpenClaw 的 Gateway 也不是 pi 的协议。
6. 事件流无 `seq`、无 replay，`message_update` 是**纯 delta**（无累积快照）；断线只能 `get_entries` 重建。
7. 扩展 `ctx.ui.custom()`（自定义 TUI 组件）在 RPC 下恒为 `undefined`，主题 API 全废 → 网页端不可能与 TUI 100% 等价。
8. 交互式 `--resume` 选择器与跨 cwd 的「fork 确认」直接读写 `process.stdin/stdout`，在 RPC 模式下会破坏协议流。

---

## 1. 传输与启动

- 启动：`pi --mode rpc [常规 CLI 参数]`。`--mode rpc` 优先级最高，非 TTY 也进 RPC。
  证据：`dist/main.js:81`（`if (parsed.mode === "rpc") return "rpc";` 早于 `!stdinIsTTY` 判断）
- 子进程写法（RpcClient 即如此）：`spawn("node", ["<pkg>/dist/cli.js","--mode","rpc",...], {stdio:["pipe","pipe","pipe"]})`。
  证据：`dist/modes/rpc/rpc-client.js:31`
- 专用入口 `pi-coding-agent/rpc-entry`：内部 `main(["--mode","rpc", ...argv])`，置 `process.title=<app>-rpc`、`PI_CODING_AGENT=true`、`AI_AGENT=pi`、静音 warnings、先 `configureHttpDispatcher()`。
  证据：`dist/rpc-entry.js:3`、`package.json:14`（exports `"./rpc-entry"`）
- 传输：**stdio JSON Lines**，一对象一行、LF 结尾、容忍前置 CR；**别用 Node `readline`**（它还在 U+2028/U+2029 切分，这两个字符在 JSON 字符串里合法）。
  证据：`docs/rpc.md:54`、`dist/modes/rpc/jsonl.js:18`
- 单行长度**无上限**（buffer 无限增长），大图 base64 / 大工具输出都是一行。
  证据：`dist/modes/rpc/jsonl.js:22`
- RPC 拒绝 `@file`：`Error: @file arguments are not supported in RPC mode`，退出码 1。
  证据：`dist/main.js:526`
- 四类记录：stdin `RpcCommand`（可带 `id?:string`）；stdout `{type:"response",command,success,data|error,id?}`；stdout 会话事件；双向 `extension_ui_request`/`extension_ui_response`（同 id，后者**不产生** command response）。
  证据：`dist/modes/rpc/rpc-types.d.ts`、`docs/rpc.md:48`
- 命令**并发处理**，必须按 `id` 关联；只有 `bash_execution_update` 会带回 command id。
  证据：`dist/modes/rpc/rpc-mode.js:602`、`docs/rpc.md:46`
- 解析失败：`{"type":"response","command":"parse","success":false,"error":"Failed to parse command: ..."}`（**无 id**）。
  证据：`dist/modes/rpc/rpc-mode.js:602`
- 生命周期：stdin end → `onInputEnd` → 有序 shutdown（先 `runtimeHost.dispose()` 再 exit）；handler 返回 `new Promise(() => {})`，**进程永不自然退出**。
  证据：`dist/modes/rpc/rpc-mode.js:639`、`dist/modes/rpc/rpc-mode.js:654`、`dist/modes/rpc/rpc-mode.js:579`
- SIGTERM/SIGHUP → 杀子进程 + shutdown。
  证据：`dist/modes/rpc/rpc-mode.js:275`
- 命令全集（33 条）：`prompt`、`steer`、`follow_up`、`abort`、`clear_queue`、`new_session`、`get_state`、`set_model`、`cycle_model`、`get_available_models`、`set_thinking_level`、`cycle_thinking_level`、`get_available_thinking_levels`、`set_steering_mode`、`set_follow_up_mode`、`compact`、`set_auto_compaction`、`set_auto_retry`、`abort_retry`、`bash`、`abort_bash`、`get_session_stats`、`export_html`、`switch_session`、`fork`、`clone`、`get_fork_messages`、`get_entries`、`get_tree`、`get_last_assistant_text`、`set_session_name`、`get_messages`、`get_commands`。
  证据：`dist/modes/rpc/rpc-types.d.ts`（`RpcCommand` 联合）

## 2. 事件流

RPC 与 `--mode json` 共用同一套事件。证据：`docs/json.md:55` 起表格、`dist/core/agent-session.d.ts:47`

| 事件 | payload | 备注 |
|---|---|---|
| `agent_start` / `turn_start` | 无 | |
| `turn_end` | `message`, `toolResults` | |
| `message_start` | `message` | |
| `message_update` | `usage`, `assistantMessageEvent` | **线上无 `message`、无 `partial`** |
| `message_end` | `message` | 权威最终消息 |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult` | 工具自报增量 |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError`, `durationMs` | durationMs 用单调时钟 |
| `agent_end` | `messages`, `willRetry` | 只表示一次低级 run 结束 |
| `agent_settled` | `aborted` | **唯一的「不会自动继续」信号** |
| `queue_update` | `steering[]`, `followUp[]` | 全量队列，非增量 |
| `entry_appended` | `entry` | 扩展 `pi.appendEntry()` |
| `session_info_changed` | `name` | |
| `thinking_level_changed` | `level` | |
| `compaction_start` | `reason: manual\|threshold\|overflow` | |
| `compaction_end` | `reason`, `result?`, `aborted`, `willRetry`, `errorMessage?` | |
| `auto_retry_start` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` | |
| `auto_retry_end` | `success`, `attempt`, `finalError?` | |
| `summarization_retry_*` | 见 docs | 摘要重试 |
| `bash_execution_update` | `id?`, `delta` | 仅 RPC/JSON，每输出块一条 |
| `extension_error` | `extensionPath`, `event`, `error` | 仅 RPC |

证据：`dist/core/agent-session.d.ts:47`-90（`AgentSessionEvent` 联合）、`docs/json.md:55`、`docs/json.md:107`、`docs/json.md:122`

- `message_update.assistantMessageEvent.type`：`text_start|text_delta|text_end|thinking_start|thinking_delta|thinking_end|toolcall_start|toolcall_delta|toolcall_end|done|error`；`start`/`done`/`error` 被转成 `message_start`/`message_end`，不走 `message_update`。
  证据：`docs/json.md`（`assistantMessageEvent` 小节）
- 线上裁剪逻辑 28 行，可直接照抄给浏览器：非 `message_update` 原样返回；`message_update` 只留 `{type,usage,assistantMessageEvent}`；`toolcall_start` 额外补 `{id, toolName}`。
  证据：`dist/modes/json-event.js:16`
- 服务端假设客户端能正确处理 delta 顺序：`toolcall_start` 取不到 `event.partial.content[contentIndex]` 就抛 `toolcall_start content at index N is not a tool call`；`message_update.message.role !== "assistant"` 就抛 `message_update message is not an assistant message`。
  证据：`dist/modes/json-event.js:4`、`dist/modes/json-event.js:21`
- `usage` 是 provider 最新累计值，**流式期间可能一直是 0**；精确成本用 `message_end.message.usage` 或 `get_session_stats`。
  证据：`docs/json.md`（usage 说明）、`dist/core/agent-session.d.ts:202`
- `prompt` 的 `success:true` 不代表完成：`data.disposition ∈ started|queued|handled`；`handled` 表示根本没起 run，别等 `agent_settled`。
  证据：`docs/rpc-commands.md:40`、`docs/rpc-commands.md:42`
- `agent_end` ≠ idle：重试/溢出恢复/compaction/steering/follow-up 都可能继续，只有 `agent_settled` 是终态。
  证据：`docs/rpc.md:69`
- 背压：每条事件写完 await `waitForRawStdoutBackpressure()`；另有 `session.agent.subscribe(async () => { await waitForRawStdoutBackpressure(); })`，使 **agent 事件层面也等 stdout 排空** → 客户端停读会阻塞 agent loop。
  证据：`dist/modes/rpc/rpc-mode.js:265`、`dist/modes/rpc/rpc-mode.js:271`、`docs/rpc.md:56`
- 写入层：回调式 `process.stdout.write` + `ENOBUFS/EAGAIN/EWOULDBLOCK` 每 10ms 重试，串成 Promise 尾链，失败 `process.exit(1)`。
  证据：`dist/core/output-guard.js:10`、`dist/core/output-guard.js:67`
- **无事件序号 / 无 timestamp / 无 replay buffer**，顺序只由单进程 stdout 决定。
  证据：`dist/modes/json-event.js:23`
- stdout 被 `takeOverStdout()` 接管：`process.stdout.write` 重定向到 stderr，只留 raw 通道；非 interactive 启动时执行。
  证据：`dist/core/output-guard.js:38`、`dist/main.js:522`

## 3. 工具审批与安全

- **内建没有任何逐调用审批**：`Pi can read, change, and execute files with the permissions of the account that started it, and it does not ask for approval before every tool call.`
  证据：`docs/security.md:3`
- 内置工具执行前不问客户端：grep `ui.confirm|ui.select|ui.input(`（`dist/core`、`dist/extensions`、`dist/modes`，排除 `.map`）只命中 `dist/core/project-trust.js:10` 与 llama 扩展（用户主动敲 `/llama`）。
  证据：`dist/core/project-trust.js:10`
- 唯一审批点 = 扩展 `tool_call` 钩子：串行 await，返回 `{block:true, reason}` 即拦截。
  证据：`dist/core/extensions/runner.js:957`（`emitToolCall`）、`dist/core/extensions/runner.js:965`（`if (result.block) return result;`）、`dist/core/agent-session.js:332`（调用点）
- handler 抛错 = 工具被 block（fail-safe），不是放行。
  证据：`docs/extensions.md:375`
- RPC 下 `ctx.hasUI === true`（dialog + fire-and-forget 可用），权限扩展会真弹框，不会走无人值守分支。
  证据：`docs/rpc-extension-ui.md`（`ctx.mode=="rpc"` 且 `hasUI==true` 小节）
- 超时：只有扩展**自己**传 `opts.timeout` 才有；`select/confirm/input/editor` 只读调用方传入的 `opts.signal`/`opts.timeout`，pi 不注入默认超时或默认 signal。
  证据：`dist/modes/rpc/rpc-mode.js:84`-86、`dist/core/extensions/types.d.ts:40`（`ExtensionUIDialogOptions{signal?:AbortSignal; timeout?:number}`）
- 客户端不回应 → `createDialogPromise` 永久 pending → `tool_call` handler 永不返回 → 该工具调用永不开始，run 卡死。`abort` **解不开**它（dialog 只听调用方传的 signal，`session.abort()` 只 abort agent/tool）。
  证据：`dist/modes/rpc/rpc-mode.js:47`、`dist/modes/rpc/rpc-mode.js:84`
- 无 settings 级 allowlist / 自动批准策略。所谓「自动批准」= 写个 `tool_call` 扩展返回 `undefined`，或不装扩展；白名单得扩展自己实现。
  证据：`docs/security.md:3`、`docs/extensions.md`（`tool_call` 小节）
- 参考实现 `examples/extensions/permission-gate.ts` 只拦 `bash`，默认模式 `[/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i]`；`!ctx.hasUI` 时 fail-closed `{block:true, reason:"Dangerous command blocked (no UI for confirmation)"}`；**没传 timeout/signal** → 客户端不答就死等。
  证据：`examples/extensions/permission-gate.ts:11`
- 能力提示 `pi.getAllTools()[].annotations` 是 MCP 风格 `readOnlyHint/destructiveHint/idempotentHint/openWorldHint`，**未验证、仅供决策**。
  证据：`dist/core/extensions/types.d.ts:398`
- trust ≠ 审批：project trust 只管「启动时是否加载项目内资源」（`.pi/settings.json`、`.pi/extensions`、`.pi/mcp.json` 等），不是动作沙箱；pi 无内建 sandbox。
  证据：`docs/security.md`（Project trust 小节）、`docs/containerization.md`
- **Print/JSON/RPC 模式无法显示内建 trust prompt**：无 CLI override / 无扩展处理 / 无已保存决策时，只有 `defaultProjectTrust:"always"` 才加载受保护资源。
  证据：`docs/security.md:77`

## 4. 会话归属、恢复、并发写、只读 tail

- 进程与 active 会话 1:1：`AgentSessionRuntime` 持有一个 `session`，`switchSession/newSession/fork` 都是**替换**，且替换前 `await this.session.abort()`。
  证据：`dist/core/agent-session-runtime.js:102`（`teardownCurrent`，abort 在 105）、`dist/core/agent-session-runtime.js:128`（`switchSession`）
- 新进程按 id 恢复：`--session <path|id>`、`--session-id <id>`（存在则开、不存在则建）、`--continue`。RPC 下可用（纯解析，不读 stdin）。
  证据：`dist/main.js:308`-351、`docs/cli.md`（session flags）
- `--resume` 在无 TUI 场景**不可用**：它调 `selectSession(...)` 渲染选择器。
  证据：`dist/main.js:328`
- 跨 cwd 打开会话会**同步阻塞读 stdin**：`const shouldFork = await promptConfirm("Fork this session into current directory?")`，而 `promptConfirm` 用 `node:readline` 读 `process.stdin`、写 `process.stdout`。
  证据：`dist/main.js:316`、`dist/main.js:218`
- `switch_session` 也不能跨 cwd：`assertSessionCwdExists` 抛 `MissingSessionCwdError`。
  证据：`dist/core/agent-session-runtime.js:135`、`dist/core/session-cwd.js:32`
- **没有会话文件锁**：`session-manager.js` 里 grep `lock` 只剩 keybindings；`proper-lockfile` 只用于 auth-storage / settings-manager / trust-manager。
  证据：`dist/core/session-manager.js`（无 lockfile 引用）、`dist/core/settings-manager.js:4`
- 双进程写同一文件的真实行为：各自启动全量解析出自己那份 entry 树，`_buildIndex()` 用「最后一个 entry」当 leaf；各自 `appendFileSync` 追加。两份 entry 都进文件，但 `parentId` 各指自己认为的 leaf → 重载后是**两条不可见的兄弟分支**，谁也不报错；任一方 compaction 写 `firstKeptEntryId` 时基于自己的视图，可能把对方消息从模型上下文切掉。
  证据：`dist/core/session-manager.js:726`（`_buildIndex`，`this.leafId = entry.id` 逐条覆盖）、`dist/core/session-manager.js:794`（`_persist`）
- 首写用 `openSync(path,"wx")`：文件已存在会 `EEXIST` 抛错。
  证据：`dist/core/session-manager.js:794`
- 只读 tail 可行：写侧 `appendFileSync(file, JSON.stringify(entry)+"\n")`，一次一条完整行、append-only；外部按 byte offset 增量读即可。
  证据：`dist/core/session-manager.js:794`
- 但有 truncate 风险：`_rewriteFile()` 用 `openSync(this.sessionFile,"w")` 全量重写，调用点 = 空文件初始化 / 版本迁移 / fork-clone 写新文件。
  证据：`dist/core/session-manager.js:754`、`678`、`723`、`1283`（同文件）
- 首次落盘是懒的：`_hasConversation()` 要求存在 role 为 user/assistant 的 message，否则 `get_state` 给的 `sessionFile` 路径此刻**还不存在**。
  证据：`dist/core/session-manager.js:791`

## 5. 并发

- 单 RPC 进程**不能**同时跑多会话：协议只有 `switch_session/new_session/fork/clone`，没有「按 session 路由」字段，所有命令作用于唯一 active session。
  证据：`dist/modes/rpc/rpc-types.d.ts`、`dist/core/agent-session-runtime.js:128`
- 同一会话**不能**被多客户端连接：传输是进程私有 stdio，无监听端口；要复用只能自己写 broker 做 id 多路复用（协议支持并发命令 + `id` 关联）。
  证据：`dist/modes/rpc/rpc-mode.js:602`
- SDK 在一个 Node 进程里可起 N 个 `AgentSession`：每次 `createAgentSession()` 都 new `ModelRuntime`/`SettingsManager`/`SessionManager`/`Agent`。
  证据：`dist/core/sdk.js:69`
- 但有**进程级共享**：
  - `globalThis.fetch` 被 `configureHttpDispatcher()` 打补丁（`originalGlobalFetch`/`installedGlobalFetch`），所有会话共用一套代理/超时；
    证据：`dist/core/http-dispatcher.js:13`、`dist/core/http-dispatcher.js:91`
  - `process.stdout` 接管只有 CLI 做（SDK 不做）；
    证据：`dist/core/output-guard.js:38`、`dist/main.js:522`
  - `settings.json`/`auth.json`/`trust.json` 共享，写入侧有 lockfile；
    证据：`dist/core/settings-manager.js:4`
  - 每个 session 持完整 entry 数组（内存随会话长度线性增长），模型调用是 HTTP，无 GPU/单例模型客户端问题。
    证据：`dist/core/session-manager.js:330`、`dist/core/agent-session.js`
- 列表页注意：`SessionInfo` 含 `firstMessage` 与 `allMessagesText`（全文），即列表要解析每个会话文件全文。
  证据：`dist/core/session-manager.d.ts:163`

## 6. SDK

- 导出：`import { createAgentSession, SessionManager, AgentSessionRuntime, ... } from "@earendil-works/pi-coding-agent"`。
  证据：`dist/index.d.ts:20`、`dist/index.d.ts:21`
- 工厂签名：`createAgentSession(options?: CreateAgentSessionOptions): Promise<{session: AgentSession, extensionsResult, modelFallbackMessage?}>`。
  证据：`dist/core/sdk.d.ts:116`、`dist/core/sdk.js:69`
- 关键 options：`cwd`、`agentDir`、`modelRuntime`、`model`、`thinkingLevel`、`scopedModels`、`noTools:"all"|"builtin"`、`tools[]`、`excludeTools[]`、`customTools[]`、`resourceLoader`、`sessionManager`、`settingsManager`、`sessionStartEvent`。
  证据：`dist/core/sdk.d.ts`（`CreateAgentSessionOptions`）
- **SDK 默认也落盘**：`sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))`；纯内存要显式 `SessionManager.inMemory()`。
  证据：`dist/core/sdk.js:77`
- 发消息：`await session.prompt(text, {images?, streamingBehavior?})`，在该 run 结束（含自动重试）后 resolve；流式中不带 `streamingBehavior` 抛 `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`。
  证据：`dist/core/agent-session.js:1631`、`dist/core/agent-session.js:1665`
- 排队/打断：`session.steer(msg)`/`session.followUp(msg)` 返回 `"queued"|"handled"`；`await session.abort()`；`await session.waitForIdle()` 只等不中止。
  证据：`dist/core/agent-session.js:1971`、`dist/core/agent-session.js:1983`
- 订阅：`const off = session.subscribe((event) => ...)`；**SDK 事件带累积快照**（`assistantMessageEvent.partial`、`message_update.message`），要 delta 自己裁，或照抄 `dist/modes/json-event.js:16`。
  证据：`dist/core/agent-session.js:990`、`dist/modes/json-event.js:16`
- abort 后恢复：进程与 session 都在，直接再 `prompt()` 即可；但 **abort 不清队列**（官方 Esc 语义 = 先 `clear_queue` 再 `abort`）。
  证据：`docs/rpc-commands.md:94`、`docs/rpc-commands.md:107`
- 多会话切换：`AgentSessionRuntime` 的 `newSession()/switchSession()/fork()/importFromJsonl()` 替换 active session 并重建服务；**替换后旧订阅失效，必须重新 subscribe**。
  证据：`dist/core/agent-session-runtime.js:128`、`:147`、`:174`
- SDK **不加载** CLI 内置扩展（codemode / tool_search / MCP），要自己塞 `DefaultResourceLoader({extensionFactories})` 再 `session.bindExtensions()`。
  证据：`docs/sdk.md`（built-in extensions 小节）
- 必须 `session.dispose()`：中止活动工作、失效扩展 ctx、断开 agent、移除监听。
  证据：`docs/sdk.md`
- **无 TTY 要求**：`createAgentSession` 全程不读 `process.stdin`、不查 `isTTY`；TTY 逻辑只在 `dist/main.js` 的 appMode 判定里。
  证据：`dist/core/sdk.js:69`、`dist/main.js:81`

最小骨架（Node ≥ 22，ESM）：

```js
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  cwd: "F:/work/project",
  sessionManager: SessionManager.inMemory(),   // 或 SessionManager.open(path)
  tools: ["read", "bash", "edit", "write"],
});

const off = session.subscribe((e) => {
  if (e.type === "message_update") {
    const a = e.assistantMessageEvent;
    if (a.type === "text_delta") ws.send(JSON.stringify({ t: "text", d: a.delta }));
    if (a.type === "thinking_delta") ws.send(JSON.stringify({ t: "thinking", d: a.delta }));
    if (a.type === "toolcall_start") {
      const tc = a.partial.content[a.contentIndex];
      ws.send(JSON.stringify({ t: "tool", id: tc.id, name: tc.name }));
    }
  }
  if (e.type === "tool_execution_start") ws.send(JSON.stringify({ t: "tool_start", toolName: e.toolName, args: e.args }));
  if (e.type === "tool_execution_end") ws.send(JSON.stringify({ t: "tool_end", toolName: e.toolName, isError: e.isError }));
  if (e.type === "message_end") ws.send(JSON.stringify({ t: "final", message: e.message }));
  if (e.type === "agent_settled") ws.send(JSON.stringify({ t: "idle", aborted: e.aborted }));
});

await session.prompt("hello");
await session.abort();        // 注意：不清队列
await session.waitForIdle();
off(); session.dispose();
```

## 7. HTTP / WebSocket / web UI

- **没有内建 HTTP/WS 服务端，也没有 `serve`/`web` 子命令**。`dist/**` grep `createServer|new WebSocket|http.Server|listen(` 只命中 provider 客户端、OAuth 回调、`http-dispatcher`、`radius`。
  证据：`dist/core/http-dispatcher.js:13`、`dist/cli/args.js`（flag 全集无 serve/web；session 相关只有 `--continue/--resume/--session/--session-id/--fork/--session-dir/--no-session/--name/--export`）
- CLI 子命令只有 `install/remove/uninstall/update/list/config/auth/mcp`。
  证据：`docs/cli.md`、`dist/main.js:474`
- 唯一「给别的程序用」的官方形态是 `--mode rpc`：`control it over RPC, or build apps with the Pi TypeScript SDK`。
  证据：`README.md:21`
- 社区 web UI：README 点名 OpenClaw（`https://github.com/OpenClaw/OpenClaw`）为「real-world integration」。
  证据：`README.md:21`
- OpenClaw 的接法（经本地代理读其仓库文档核实）：自带 Gateway（本地控制面）+ Control UI（web）+ CLI + TUI + 多 channel；agent runtime 是可插拔的「准备后的模型循环」，pi 在其中作为 harness/runtime 被对照与包装（`wrapToolWithBeforeToolCallHook`、`plugin.approval.request` 两阶段审批、`skipPermission`/`overridesBuiltInTool` 桥接）。**它不消费 pi 的 RPC 协议**，pi 也没为它开专用接口。
  证据：OpenClaw 仓库 `docs/concepts/agent-runtimes.md`、`docs/plugins/copilot.md:308`-341（外部仓库）
- 结论：浏览器客户端要自己写 bridge（Node 内 SDK，或 spawn RPC 子进程 + `ws`）。

## 8. 扩展 UI over RPC

扩展能推给 RPC 客户端的 UI 只有 9 种（全部带 `type:"extension_ui_request"` 与 `id`）：

| method | 字段 | 需要响应 | 超时 |
|---|---|---|---|
| `select` | `title`, `options[]`, `timeout?` | `{type:"extension_ui_response", id, value}` | 仅当扩展传入 |
| `confirm` | `title`, `message`, `timeout?` | `{...id, confirmed:boolean}` | 仅当扩展传入 |
| `input` | `title`, `placeholder?`, `timeout?` | `{...id, value}` | 仅当扩展传入 |
| `editor` | `title`, `prefill?` | `{...id, value}` | 无 |
| `notify` | `message`, `notifyType: info\|warning\|error` | 不需要 | — |
| `setStatus` | `statusKey`, `statusText?`（undefined=清除） | 不需要 | — |
| `setWidget` | `widgetKey`, `widgetLines?`, `widgetPlacement: aboveEditor\|belowEditor` | 不需要 | — |
| `setTitle` | `title` | 不需要 | — |
| `set_editor_text` | `text` | 不需要 | — |

取消：`{type:"extension_ui_response", id, cancelled:true}` → `select/input/editor` 得 `undefined`、`confirm` 得 `false`。
证据：`dist/modes/rpc/rpc-types.d.ts`、`dist/modes/rpc/rpc-mode.js:84`-86、`docs/rpc-extension-ui.md`

RPC 下**不可用/降级**（网页端不要假装实现）：
- `custom()` → 恒 `undefined`（自定义 TUI 组件，无法转发）
- `onTerminalInput()` → no-op；`getEditorText()` → `""`；`getEditorComponent()` → `undefined`；`getToolsExpanded()` → `false`
- `pasteToEditor()` → 退化为 `setEditorText`
- `setWorkingMessage/setWorkingVisible/setWorkingIndicator/setHiddenThinkingLabel/setFooter/setHeader/addAutocompleteProvider/setEditorComponent/setToolsExpanded` → 全 no-op
- `getAllThemes()` → `[]`；`getTheme()` → `undefined`；`setTheme()` → `{success:false, error:"Theme switching not supported in RPC mode"}`

证据：`docs/rpc-extension-ui.md`（limitations）、`dist/modes/rpc/rpc-mode.js:83`-224

网页端「算功能完整」的最低集：`select/confirm/input/editor` 四件（否则 permission-gate 这类扩展直接卡死整个 run）+ `notify` + `setStatus/setWidget/setTitle/set_editor_text`。`custom()` 类扩展在网页端**不可能**支持，这是架构上限。
证据：`dist/modes/rpc/rpc-mode.js:83`、`docs/rpc-extension-ui.md`

## 9. 会话文件

- 路径：`~/.pi/agent/sessions/--<encoded-cwd>--/<时间戳>_<session-id>.jsonl`。
  编码：`const safePath = \`--${resolvedCwd.replace(/^[/\]/, "").replace(/[/\:]/g, "-")}--\``；文件名 `fileTimestamp = timestamp.replace(/[:.]/g, "-")`。
  证据：`dist/core/session-manager.js:290`、`dist/core/session-manager.js:713`
- 目录可改：`--session-dir`、`PI_CODING_AGENT_SESSION_DIR`、settings `sessionDir`；`--no-session` → `SessionManager.inMemory()`（退出即不可 resume）。
  证据：`dist/main.js:287`、`docs/sessions.md`
- 版本：`CURRENT_SESSION_VERSION = 3`，v1/v2 自动迁移（迁移触发 `_rewriteFile`）。
  证据：`dist/core/session-manager.js:11`、`dist/core/session-manager.js:723`
- 首行是 header（`type:"session", version, id, timestamp, cwd, parentSession?`），不属于 entry 树；坏行静默跳过。
  证据：`dist/core/session-manager.js:318`（`parseSessionEntryLine`）
- entry 类型全集：`session`(header)、`message`、`model_change`、`thinking_level_change`、`usage`、`compaction`、`context_edit`、`branch_summary`、`custom`、`custom_message`、`label`、`session_info`。
  证据：`dist/core/session-manager.d.ts`（SessionEntry 联合）、`docs/session-format.md`
- 增量解析：可以。一行一 entry、append-only，外部按 byte offset 读新增字节、按 `\n` 切、逐行 `JSON.parse`；流式 delta **不落盘**，落盘的是完整 message。
  证据：`dist/core/session-manager.js:794`、`dist/core/session-manager.js:330`
- 官方导出可复用的纯函数：`parseSessionEntries` / `buildContextEntries` / `buildSessionProjection` / `buildSessionContext` / `sessionEntryToContextMessages`。
  证据：`dist/index.d.ts:21`、`dist/core/session-manager.d.ts:183`
- 体积：工具输出**全文**进 session（只在进模型上下文时按 `DEFAULT_MAX_LINES=2000`/`DEFAULT_MAX_BYTES=50KB` 截断，`fullOutputPath` 只存路径）；图片以 base64 内联在 `ImageContent.data`（单图上限 4.5MB base64、2000px、jpegQuality 80），一个 entry 行可能几 MB。
  证据：`dist/core/tools/truncate.js:10`、`dist/utils/image-resize-core.js:8`、`docs/message-types.md`
- 导出：`export_html` 命令可写自包含 HTML；`--export <input> [output]` 亦可。
  证据：`dist/modes/rpc/rpc-types.d.ts`、`docs/cli.md`

## 10. 其他约束

- **图片输入**：`prompt` 的 `images?: ImageContent[]`（`{type:"image", data:<base64>, mimeType}`）；settings `blockImages` 开启时 SDK 会把图片换成文本 `"Image reading is disabled."`。
  证据：`dist/core/sdk.js:162`、`dist/modes/rpc/rpc-types.d.ts`
- **slash 命令**：`prompt` 中以 `/` 开头的文本先尝试扩展命令（**流式期间也立即执行**），`/skill:name` 与 `/template` 会展开；TUI 内建命令（`/settings`、`/hotkeys`）不在 `get_commands` 里，通过 prompt 发也不执行。
  证据：`docs/rpc-commands.md:31`、`dist/core/agent-session.js:1640`
- **模型切换**：`set_model{provider,modelId}`/`cycle_model`/`get_available_models`；`Model` 含 `id,name,api,provider,baseUrl,reasoning,input:["text","image"],contextWindow,maxTokens,cost{input,output,cacheRead,cacheWrite}`（美元/百万 token）；切换写 `model_change` entry。
  证据：`docs/rpc-commands.md`（set_model / get_available_models）、`docs/session-format.md`
- **compaction**：阈值 `contextTokens > contextWindow - reserveTokens`，`reserveTokens` 默认 16384、`keepRecentTokens` 默认 20000；可在工具结果后、新 prompt 前触发，也可因 provider overflow / 过早 `stopReason:"length"` 触发一次 compact-and-retry；`compact` 可手动加指令。
  证据：`dist/core/settings-defaults.js:10`、`dist/core/compaction/compaction.js:176`、`docs/compaction.md`
- **成本**：`get_session_stats` 返回 `tokens{input,output,cacheRead,cacheWrite,total}`、`cost:number`、`contextUsage?{tokens,contextWindow,percent}`；compaction 后立刻取，`contextUsage.tokens/percent` 可能为 null；`usage` entry（如 `kind:"cache_warm"`）不计入上下文但计入成本。
  证据：`dist/core/agent-session.d.ts:202`、`docs/rpc-commands.md:526`、`docs/session-format.md`
- **abort 语义**：只中止当前 run（含 retry/compaction/branch summary），等 idle 才响应；**进程仍活着**（handler 返回永不 resolve 的 Promise），**队列不清**。
  证据：`dist/core/agent-session.js:1971`、`dist/modes/rpc/rpc-mode.js:327`、`dist/modes/rpc/rpc-mode.js:654`
- **bash 命令的坑**：`bash` 立即执行并写入 `BashExecutionMessage`，但**只有下一次 `prompt` 时**才（默认）转成 `UserMessage` 进上下文，格式 `` Ran `ls -la`\n```\n...\n``` ``；`excludeFromContext:true` 则永不进上下文。
  证据：`docs/rpc-commands.md:495`、`docs/rpc-commands.md:497`
- **工具事件顺序**：`tool_execution_start → tool_call → tool_execution_update* → tool_result → tool_execution_end`，`tool_call` 只是扩展钩子，位于执行前。
  证据：`docs/extensions.md`（事件顺序小节）
- **Windows**：原生 Windows 的 `bash` 工具走 Git Bash（`shellPath` → `%ProgramFiles%\Git\bin\bash.exe` → `(x86)` → `PATH`），可选 `powershell` 工具（`pwsh.exe` 优先，`-NoProfile -NonInteractive -ExecutionPolicy Bypass`），后者仅原生 Windows 可用。
  证据：`docs/windows.md:3`、`docs/windows.md:19`、`docs/windows.md:36`、`docs/windows.md:55`
- **RPC 无 PTY 需求**（`initTheme(..., interactive)` 才建 TUI）；stdout 是管道，pi 侧已处理 `ENOBUFS` 重试与 `flushRawStdout`，bridge 不要用同步写堵它。
  证据：`dist/main.js:737`、`dist/core/output-guard.js:10`
- **`--mode rpc` 启动后 `process.stdout` 被接管**，任何 `console.log` 都跑到 stderr（否则污染协议）。
  证据：`dist/core/output-guard.js:38`

---

## 红线：网页端做不到 / 很难做的事

1. **接管终端里正在跑的会话**：没有 attach/connect/端口，传输是进程私有 stdio；`--session` 只能「新进程重开同一文件」，那是双写（见红线 3）。唯一安全形态是「只读 tail」（能看不能说）。
   证据：`dist/modes/rpc/rpc-mode.js:644`
2. **一个会话多客户端**：协议无连接概念、无 session 订阅路由；只能自己写 broker 做多路复用，且写操作必须串行化。
   证据：`dist/modes/rpc/rpc-types.d.ts`
3. **安全地双写同一会话文件**：无锁、leaf 靠「最后一行」推断、首写 `"wx"`、重写 `"w"`（会 truncate）。双进程结果是不报错的隐形分叉 + compaction 视野错乱。
   证据：`dist/core/session-manager.js:726`、`:794`、`:754`
4. **工具审批的默认体验**：pi 里不存在审批这层，不装扩展就没有拦截点；装了扩展后审批会真的阻塞等客户端，无内建超时，客户端崩了就永久卡住该 run。
   证据：`docs/security.md:3`、`dist/modes/rpc/rpc-mode.js:47`
5. **不让模型动文件/执行命令**：无内建沙箱、无 settings 级 allowlist；只能靠扩展拦截 + 容器/微 VM 隔离。
   证据：`docs/containerization.md`、`docs/security.md`
6. **浏览器直连**：无 HTTP/WS 服务端、无 serve/web 子命令、无鉴权与多用户概念；bridge 必须自己写，且它就是权限边界（pi 以启动它的 OS 账号权限执行一切）。
   证据：`dist/cli/args.js`、`dist/core/http-dispatcher.js:13`
7. **断线重连续上「正在生成的那条消息」**：事件无 seq/timestamp/replay，`message_update` 是纯 delta；断线只能 `get_state` + `get_entries` 重建，中途态丢失。
   证据：`dist/modes/json-event.js:23`、`dist/modes/rpc/rpc-mode.js:503`
8. **中途把 run 迁到另一个进程**：`switch_session`/`new_session` 会先 abort 当前 run；无 run id / handoff。
   证据：`dist/core/agent-session-runtime.js:105`
9. **自定义 TUI 组件类扩展**：`ctx.ui.custom()` 在 RPC 恒为 `undefined`；主题、编辑器组件、自动补全 provider、footer/header 全 no-op。网页端无法与 TUI 功能等价。
   证据：`docs/rpc-extension-ui.md`、`dist/modes/rpc/rpc-mode.js:83`
10. **跨目录恢复会话**：会触发 stdin 上的 `promptConfirm`，在 RPC 模式等于破坏协议；`switch_session` 直接抛 `MissingSessionCwdError`。
    证据：`dist/main.js:316`、`dist/core/session-cwd.js:32`
11. **`--resume` 选择器**：无 TUI 不可用，列表页必须自己扫 `sessions/*/*.jsonl`（且 `list()` 会读全文）。
    证据：`dist/main.js:328`、`dist/core/session-manager.d.ts:163`
12. **长 bash 命令走官方 RpcClient**：`send()` 对每条命令有 **30s 硬超时**（`Timeout waiting for response to <cmd>`），`bash`、`compact`、`export_html` 超过 30s 会被客户端判失败（服务端还在跑）。要么自己写 client，要么只对立即返回的 `prompt` 用 RpcClient。
    证据：`dist/modes/rpc/rpc-client.js:463`
13. **单按钮「停止」**：`abort` 不清队列，下次 idle 后 queued 的 follow-up 会继续跑；停止必须 `clear_queue` + `abort` 两步。
    证据：`docs/rpc-commands.md:107`、`dist/core/agent-session.js:1971`
14. **会话管理**：有 `set_session_name`，但**没有 delete/rename 文件/移动目录的 RPC 命令**；删会话只能自己动文件系统（且要避开运行中的进程）。
    证据：`dist/modes/rpc/rpc-types.d.ts`
15. **扩展安装/信任交互**：project trust 内建提示在 RPC/JSON/print 下不可显示，必须启动时显式 `--approve/--no-approve` 或配 `defaultProjectTrust`；网页端无法「弹一次信任框」。
    证据：`docs/security.md:77`
16. **精确的实时成本**：流式期间 `usage` 可能恒为 0，`get_session_stats` 是快照；逐 token 计费只能自己按 provider usage 累加，且 compaction 后 `contextUsage` 可能为 null。
    证据：`docs/json.md`、`dist/core/agent-session.d.ts:218`

## 三个接入路线对比

| 维度 | A 驱动 RPC 子进程 | B 用 SDK 在 Node 服务里内嵌 | C 只读磁盘会话文件 + 另起进程写入 |
|---|---|---|---|
| 能发消息？ | 能（`prompt`/`steer`/`follow_up`） | 能（`session.prompt` + `steer`/`followUp`） | 只读侧不能；写入靠另起进程（A 或 print），是「新 run」而非续聊 |
| 能审批？ | 能，前提是装了 `tool_call` 扩展；UI 走 `extension_ui_request` 往返 | 能，扩展仍在进程内（`ctx.ui` 由你实现），也可用自定义 tool 包装 | 不能。客户端拿不到审批通道；写入侧若是 A，仍需 A 的往返 |
| 能并发多会话？ | 能，一会话一进程（N 个 `node cli.js --mode rpc`）；单进程内不行 | 能，同进程 N 个 `createAgentSession`（注意 `globalThis.fetch` 进程级打补丁、内存随会话增长） | 只读侧可任意多文件并发；写入侧受限于进程数 |
| 能接力终端里已在跑的会话？ | 不能。只能新进程 `--session <path>` 重开（= 双写，见红线 3） | 不能。同理，SDK `open()` 也是全量解析后自己当写者 | 只能「看」：append-only 可 tail，但会撞上 `_rewriteFile` 的 truncate 窗口 |
| 实现难度 | 中：子进程生命周期、JSONL framing（别用 readline）、id 关联、扩展 UI 往返、`agent_settled` 收尾 | 中高：自己实现 UI/审批桥、扩展加载、事件裁成 delta、`dispose` 生命周期、SDK 升级破坏性变更 | 低（读）+ 高（写）：要复刻 `buildContextEntries`/compaction 语义才敢写 |
| 稳定性风险 | 中：进程崩溃/僵尸；官方 client 30s 超时对 bash/compact 不适用；协议随包升级变动 | 中高：进程内共享 `globalThis.fetch` 补丁与 settings/auth 文件；一个 session 崩可能带走整个服务；扩展异常影响主进程 | 高：无锁双写 → 隐形分叉 + compaction 丢上下文；首写 `"wx"`/重写 `"w"` 都可能炸；没有「写完了」信号 |

选型提示（非结论）：A 隔离性最好（一会话一进程，崩了只死一个）；B 资源利用率最好（共享模型目录/连接池）但故障域最大；C 只适合「历史浏览 / 只读分享 / 导出」这层，不适合当写入主路径。
