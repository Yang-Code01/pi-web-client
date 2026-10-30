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

function allowedPatterns(): string[] {
  const file = process.env.PI_WEB_ALLOW_FILE;
  if (!file) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data.patterns) ? data.patterns.map(String) : [];
  } catch {
    return [];
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

export default function approvalGate(pi: any): void {
  pi.on("session_start", async () => {
    console.error("[approval-gate] active");
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = String(event.toolName ?? "tool");
    const input = (event.input ?? {}) as Record<string, unknown>;
    const cwd = String(ctx.cwd ?? process.cwd());
    const risk = riskOf(toolName, input, cwd);
    if (!risk) return undefined;

    const detail = risk.detail.slice(0, 900);
    if (allowedPatterns().some((p) => detail.includes(p))) {
      console.error(`[approval-gate] remembered pattern allowed: ${detail.slice(0, 80)}`);
      return undefined;
    }

    if (ctx.hasUI === false) {
      return { block: true, reason: "这个会话没有可用的审批界面（ctx.hasUI=false），危险操作已被拦下。" };
    }

    const ok = await ctx.ui.confirm(`危险操作：${risk.why}`, `${toolName} → ${detail}`, { timeout: 5 * 60 * 1000 });
    if (!ok) {
      return {
        block: true,
        reason: "用户在 pi-web-client 上拒绝了这条命令。先问清楚，或改用更安全的做法。",
      };
    }
    return undefined;
  });
}
