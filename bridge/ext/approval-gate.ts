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
  // GitHub 通道（#661）：建 PR 是 AI 的本职活，不拦；把代码合进 main 是人的决定。
  // 只拦一条等于留个后门，所以三条路都拦：① `gh pr merge`，含 `gh -R a/b pr merge 1`
  // 这类全局参数插在中间的写法（`gh` 与 `pr`、`pr` 与 `merge` 之间都是 `[^\n]*`）；
  // ② REST 的 `…/pulls/N/merge` 与并分支的 `…/merges`；③ GraphQL 的 mergePullRequest /
  // enqueuePullRequest（合并队列）/ enablePullRequestAutoMerge（自动合并 = 稍后合）。
  // 按行匹配是对的：一条 shell 命令里的换行只可能是引号内或反斜杠续行，续行在 riskOf 里先接回去。
  { re: /\bgh\b[^\n]*\bpr\b[^\n]*\bmerge\b/i, why: "合并 PR" },
  { re: /\bgh\s+api\b[^\n]*(\/merges?\b|mergePullRequest|enqueuePullRequest|enablePullRequestAutoMerge)/i, why: "合并 PR（走 API）" },
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
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls", "tool_search", "codemode",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  // 内网通 MCP（D439）里只查不写的那几个：查人、读记录、看未读、看状态。发送与共享不在这里。
  "mcp__peer__peer_contacts", "mcp__peer__peer_history", "mcp__peer__peer_inbox", "mcp__peer__peer_status",
  // #86：随手问要能查天气/查文档。这几个只往网上看，不碰本地磁盘；代价是它们会把参数
  // （可能是从本机文件里读到的内容）发给外部服务 —— 这是「联网」本身的含义，不是漏洞。
  "web_search", "fetch_content", "source_check", "get_search_content",
  // 邮箱的「看」：列账号、列信、读一封、看内嵌图。它们不往本地写东西，只把远端内容拉进来，
  // 和 web_search 同类。取附件会落盘、发信会对外说话，都不在这张白名单里。
  "mail_accounts", "mail_list", "mail_read", "mail_image",
]);
/**
 * 内网通 MCP（D439）：工具名是 `mcp__peer__<tool>`。查询类在上面那张白名单里；发送与共享
 * 是「往外说话」，严格模式下要逐次确认 —— 和原来 peer_send 的分寸一样。
 */
const PEER_MCP_WRITE = new Set(["mcp__peer__peer_send_text", "mcp__peer__peer_share"]);
const ASK_TOOLS = new Set(["question", "questionnaire", "ask_user_question", "ask_user"]);

function readOnlyHint(pi: any, toolName: string): boolean {
  try {
    const tool = (pi.getAllTools?.() ?? []).find((t: any) => t?.name === toolName);
    return tool?.annotations?.readOnlyHint === true;
  } catch {
    return false;
  }
}

/** `{patterns, mode, handoffPath}` per session; re-read on every call so the web button applies immediately. */
function readAllow(): { patterns: string[]; mode: Mode; handoffPath: string | null } {
  const file = process.env.PI_WEB_ALLOW_FILE;
  if (!file) return { patterns: [], mode: "ask", handoffPath: null };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const mode: Mode = ["readonly", "strict", "ask", "auto"].includes(data.mode) ? data.mode : "ask";
    return {
      patterns: Array.isArray(data.patterns) ? data.patterns.map(String) : [],
      mode,
      handoffPath: typeof data.handoffPath === "string" && data.handoffPath ? data.handoffPath : null,
    };
  } catch {
    return { patterns: [], mode: "ask", handoffPath: null };
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
    // 反斜杠续行在 shell 里是同一条命令，先接回去再匹配，否则 `gh -R a/b \` + 换行 +
    // `pr merge 12` 从换行处漏过去（规则里的 `[^\n]*` 就断在这儿）。报给用户的仍是原串。
    const flat = command.replace(/\\\r?\n/g, " ");
    for (const rule of SHELL_PATTERNS) if (rule.re.test(flat)) return { why: rule.why, detail: command };
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

export default function approvalGate(pi: any): void {
  pi.on("session_start", async () => {
    console.error("[approval-gate] active");
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = String(event.toolName ?? "tool");
    const input = (event.input ?? {}) as Record<string, unknown>;
    const cwd = String(ctx.cwd ?? process.cwd());
    const { patterns, mode, handoffPath } = readAllow();
    const lower = toolName.toLowerCase();
    const looksOnly = READ_ONLY_TOOLS.has(lower) || ASK_TOOLS.has(lower) || readOnlyHint(pi, toolName);

    // #484：交接文档是桥自己起的一个文件，写到哪儿由桥决定。只放行这一个目标（按绝对路径比），
    // 其他写入在只读 / 需确认下照旧拦 —— 交接因此不必把整个会话降成「可写」。
    if (handoffPath && WRITE_TOOLS.has(lower)) {
      const target = targetPath(input).trim();
      if (target) {
        const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
        if (abs === path.resolve(handoffPath)) {
          console.error("[approval-gate] handoff document allowed");
          return undefined;
        }
      }
    }

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
    // D439：内网通的发送 / 共享不写本机，但会对别人说话 —— ask / strict 下都要确认。
    if (!risk && PEER_MCP_WRITE.has(lower)) {
      risk = {
        why: lower.endsWith("peer_share") ? "把东西共享给内网通里的人" : "给内网通里的人发消息",
        detail: JSON.stringify(input).slice(0, 300),
      };
    }
    if (!risk && mode === "strict" && !looksOnly && !PEER_MCP_WRITE.has(lower)) {
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
