/**
 * Approval gate for pi-web-client.
 *
 * pi has no built-in tool approval (docs/security.md), so the bridge starts pi
 * with `-e <this file>` and answers the confirm dialogs over RPC
 * (extension_ui_request → extension_ui_response). Only risky calls stop for
 * approval; everything else runs untouched (DECISIONS D1).
 *
 * Event shape (dist/core/extensions/types.d.ts): { toolCallId, toolName, input }.
 * A throwing handler blocks the tool — this gate is fail-closed by design.
 *
 * stdout belongs to the RPC protocol: log with console.error only.
 */
import fs from "node:fs";
import path from "node:path";

const SHELL_TOOLS = new Set(["bash", "powershell", "shell", "run_command", "execute", "exec", "terminal"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "create_file", "str_replace"]);
const COMPOUND = /[;&|`<>\r\n]|\$\(/;

const SHELL_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /(^|[\s;&|(])(rm|rmdir|del|erase|unlink)\s+/i, why: "删除文件" },
  { re: /(^|[\s;&|(])(mv|move|ren|rename)\s+/i, why: "移动/重命名文件" },
  { re: /\bgit\s+push\b/i, why: "推送到远端" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s)/i, why: "丢弃工作区改动" },
  { re: /(curl|wget)[^|;]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/i, why: "把网络内容直接喂给 shell" },
  { re: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall)\b/i, why: "安装/卸载依赖" },
  { re: /\b(pip|pip3|uv)\s+(install|uninstall)\b/i, why: "安装/卸载 Python 包" },
  { re: /\b(winget|choco|scoop|apt|apt-get|brew)\s+(install|remove|uninstall|upgrade)\b/i, why: "用系统包管理器装东西" },
  { re: /\bsudo\b/i, why: "提权" },
  { re: /\b(Remove-Item|Format-Volume|Stop-Computer|shutdown|reg\s+delete)\b/i, why: "破坏性系统命令" },
  { re: /\bgit\s+(remote\s+(set-url|add)|config\s+--global)\b/i, why: "改 git 远端/全局配置" },
];

type Mode = "readonly" | "strict" | "ask" | "auto";

/**
 * Tools that only look (#29). Read-only mode is a whitelist: these, the web's question tools, and
 * any tool whose own annotations say `readOnlyHint: true` (MCP servers declare it). Everything else —
 * MCP tools without the hint, extension tools, unknown names — is blocked, not waved through.
 * `codemode` itself is allowed: the tools its script calls come through this hook one by one
 * (pi passes them as nested tool calls with `parentToolCallId`, agent-session.js), so a write
 * inside a script is still stopped.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search", "codemode", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "peer_find", "peer_history"]);
/**
 * 给局域网上的人发文字（#45 第 5 片，决定 33）：它不写本地磁盘，所以严格模式下放行，
 * 但只读模式下仍然拦——「只读」的意思是别往外说话，不只是别改文件。
 */
const PEER_SEND = new Set(["peer_send"]);
const ASK_TOOLS = new Set(["question", "questionnaire", "ask_user_question", "ask_user"]);

function readOnlyHint(pi: any, toolName: string): boolean {
  try {
    const tool = (pi.getAllTools?.() ?? []).find((t: any) => t?.name === toolName);
    return tool?.annotations?.readOnlyHint === true;
  } catch {
    return false;
  }
}

/** `{patterns, mode}` per session; re-read on every call so the web button applies immediately. */
function readAllow(): { patterns: string[]; mode: Mode } {
  const file = process.env.PI_WEB_ALLOW_FILE;
  if (!file) return { patterns: [], mode: "ask" };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const mode: Mode = ["readonly", "strict", "ask", "auto"].includes(data.mode) ? data.mode : "ask";
    return { patterns: Array.isArray(data.patterns) ? data.patterns.map(String) : [], mode };
  } catch {
    return { patterns: [], mode: "ask" };
  }
}

function shellCommand(input: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "script", "code"]) {
    const v = input[key];
    if (typeof v === "string") return v;
  }
  return "";
}

function targetPath(input: Record<string, unknown>): string {
  for (const key of ["file_path", "path", "filePath", "filename", "target"]) {
    const v = input[key];
    if (typeof v === "string") return v;
  }
  return "";
}

function isOutside(cwd: string, target: string): boolean {
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
  const rel = path.relative(cwd, abs);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

function riskOf(toolName: string, input: Record<string, unknown>, cwd: string): { why: string; detail: string } | null {
  const name = toolName.toLowerCase();
  if (SHELL_TOOLS.has(name)) {
    const command = shellCommand(input).trim();
    if (!command) return null;
    for (const rule of SHELL_PATTERNS) if (rule.re.test(command)) return { why: rule.why, detail: command };
    return null;
  }
  if (WRITE_TOOLS.has(name)) {
    const target = targetPath(input).trim();
    if (!target) return null;
    const normalized = target.replace(/\\/g, "/");
    if (/(^|\/)\.git\//.test(normalized)) return { why: "改 .git 里的东西", detail: target };
    if (isOutside(cwd, target)) return { why: "写当前项目之外的文件", detail: target };
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- peer 工具（第 5 片）

/**
 * 三个工具都走 peer 的回环端口，不经过 bridge：pi 子进程本来就是本机进程，
 * 而 peer 的 `/tools/find`、`/messages`、`/send` 都只认回环（决定 2）。
 * 端口由 bridge 在 spawn 时写进 PI_PEER_PORT（index.ts 里那行 process.env.PI_PEER_PORT）。
 */
const PEER_PORT = Number(process.env.PI_PEER_PORT || 7865);

async function peerCall(pathname: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${PEER_PORT}${pathname}`, {
      signal: AbortSignal.timeout(5000),
      ...init,
    });
  } catch (err) {
    // 只在这一层加「连不上」：走到下面说明 peer 是活的，报的是业务错误。
    throw new Error(`连不上 peer（${PEER_PORT}）：${(err as Error).message}。局域网没开时这些工具用不了，别重试。`);
  }
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(String(body?.error ?? `HTTP ${res.status}`));
  return body;
}

const textResult = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const describe = (peer: any): string =>
  `- ${peer.nickname || peer.nodeId.slice(0, 8)}${peer.hostname ? `（${peer.hostname}）` : ""} · ${peer.nodeId} · ${peer.online ? "在线" : "离线"}${peer.friend ? " · 好友" : " · 非好友"}`;

const peerTools = [
  {
    name: "peer_find",
    label: "找局域网里的人",
    description: "在局域网里找人和自己所在的 pi 节点：返回昵称、主机名、nodeId、是否在线、是不是好友。昵称会重名，所以后面调 peer_history / peer_send 时用 nodeId。",
    promptSnippet: "peer_find(query?) → 局域网里的人（昵称 / nodeId / 在线 / 好友）",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "按昵称或主机名过滤，留空列出全部" },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const body = await peerCall(`/tools/find?q=${encodeURIComponent(String(params?.query ?? ""))}`);
      const peers: any[] = body.peers ?? [];
      if (!peers.length) return textResult("没找到人。局域网里目前没有别人在线，也没加过好友。", { count: 0 });
      const lines = peers.map(describe);
      const head = "找到 " + peers.length + " 个人：";
      const tail = "发消息用 peer_send(nodeId, text)，看历史用 peer_history(nodeId)。";
      return textResult([head, ...lines, "", tail].join("\n"), { peers });
    },
  },
  {
    name: "peer_history",
    label: "看局域网的对话",
    description: "读某个人和本机的局域网对话（只读，历史存在本机）。返回每条消息的时间、谁发的、内容；文件消息显示文件名和大小。",
    parameters: {
      type: "object",
      properties: {
        peer: { type: "string", description: "对方的 nodeId（先用 peer_find 拿）" },
        limit: { type: "number", description: "最多几条，默认 30，上限 200" },
      },
      required: ["peer"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const limit = Math.min(200, Math.max(1, Number(params?.limit) || 30));
      const body = await peerCall(`/messages?peer=${encodeURIComponent(String(params?.peer ?? ""))}&limit=${limit}`);
      const entries: any[] = body.entries ?? [];
      if (!entries.length) return textResult("这段对话是空的。", { count: 0 });
      const lines = entries
        .filter((entry) => entry.kind !== "receipt")
        .map((entry) => {
          const at = new Date(entry.at).toLocaleString("zh-CN", { hour12: false });
          const who = entry.from?.nickname || String(entry.from?.nodeId ?? "").slice(0, 8);
          if (entry.kind === "file") return `[${at}] ${who} 发来文件「${entry.file?.name}」（${Math.round((entry.file?.size ?? 0) / 1024)} KB）`;
          return `[${at}] ${who}${entry.via === "pi" ? "（agent）" : ""}: ${entry.text}`;
        });
      return textResult(lines.join("\n"), { count: lines.length });
    },
  },
  {
    name: "peer_send",
    label: "给局域网上的人发文字",
    description: "给局域网里的某个人发一条文字消息（不是邮件、不是通知：对方在 pi 的「局域网」页里看到）。只能发文字，不能发文件。发之前先用 peer_find 确认 nodeId。",
    promptSnippet: "peer_send(peer, text) → 给本机局域网里的某个人发文字（消息上会标「🤖 agent 代发」）",
    parameters: {
      type: "object",
      properties: {
        peer: { type: "string", description: "对方的 nodeId" },
        text: { type: "string", description: "要发的话，最长 32 KB（用 UTF-8 字节算）" },
      },
      required: ["peer", "text"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const body = await peerCall("/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ peer: String(params?.peer ?? ""), text: String(params?.text ?? ""), via: "pi" }),
      });
      return textResult(`发出去了（消息 id ${String(body.id ?? "").slice(0, 8)}…）。对方在线时会立刻收到；不在线就排队 24 小时。`, { id: body.id });
    },
  },
];

export default function approvalGate(pi: any): void {
  for (const tool of peerTools) pi.registerTool(tool);

  pi.on("session_start", async () => {
    console.error("[approval-gate] active");
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = String(event.toolName ?? "tool");
    const input = (event.input ?? {}) as Record<string, unknown>;
    const cwd = String(ctx.cwd ?? process.cwd());
    const { patterns, mode } = readAllow();
    const lower = toolName.toLowerCase();
    const acts = SHELL_TOOLS.has(lower) || WRITE_TOOLS.has(lower);
    const looksOnly = READ_ONLY_TOOLS.has(lower) || ASK_TOOLS.has(lower) || readOnlyHint(pi, toolName);

    if (mode === "auto") return undefined;
    if (mode === "readonly" && !looksOnly) {
      return {
        block: true,
        reason: "当前是只读模式（用户在 pi-web-client 设置）：不能写文件、不能执行命令。只读取和分析，把要做的改动写成方案告诉用户。",
      };
    }

    let risk = riskOf(toolName, input, cwd);
    // Strict: every write and every command stops, not only the risky ones.
    // Strict: every call that is not known to only look stops — writes, commands, and tools the
    // gate knows nothing about (MCP, extensions) alike.
    if (!risk && mode === "strict" && !looksOnly && !PEER_SEND.has(lower)) {
      const detail = SHELL_TOOLS.has(lower) ? shellCommand(input).trim() : WRITE_TOOLS.has(lower) ? targetPath(input).trim() : "";
      const why = SHELL_TOOLS.has(lower) ? "执行命令" : WRITE_TOOLS.has(lower) ? "写文件" : `调用工具 ${toolName}`;
      risk = { why, detail: detail || JSON.stringify(input).slice(0, 300) };
    }
    if (!risk) return undefined;

    const detail = risk.detail.slice(0, 900);
    // Patterns are per session (PI_WEB_ALLOW_FILE) and match the whole leading word(s), never a
    // substring; chained/redirected commands always ask, since a prefix says nothing about the rest.
    const remembered =
      patterns.includes(`tool:${lower}`) ||
      (!COMPOUND.test(detail) && patterns.some((p) => p && !p.startsWith("tool:") && (detail === p || detail.startsWith(`${p} `))));
    if (remembered) {
      console.error(`[approval-gate] remembered pattern allowed: ${detail.slice(0, 80)}`);
      return undefined;
    }

    if (ctx.hasUI === false) {
      return { block: true, reason: "这个会话没有可用的审批界面（ctx.hasUI=false），危险操作已被拦下。" };
    }

    const ok = await ctx.ui.confirm(`${risk.why === "执行命令" || risk.why === "写文件" || risk.why.startsWith("调用工具") ? "需要确认" : "危险操作"}：${risk.why}`, `${toolName} → ${detail}`, { timeout: 5 * 60 * 1000 });
    if (!ok) {
      return {
        block: true,
        reason: "用户在 pi-web-client 上拒绝了这条命令。先问清楚，或改用更安全的做法。",
      };
    }
    return undefined;
  });
}
