/**
 * Local shells for the web UI.
 *
 * This is the only place in the bridge that hands a remote caller an interactive shell, so the
 * rules live here in one block instead of being scattered through the message switch:
 *
 * - only loopback / LAN clients ever reach it (the ws switch refuses tunnel traffic before calling),
 *   and `term.open` additionally needs a fresh passphrase (step-up, 10 minutes);
 * - at most `MAX_TERMS` shells at a time, killed with the bridge or when the client asks;
 * - a shell is a child of this process: it keeps working across a page reload (the buffer is
 *   replayed on `attach`) but never survives the bridge.
 *
 * Elevation (Q-008) is deliberately *not* done by piping into an elevated process — Windows cannot
 * redirect the console of an elevated child, so that path only ever produced a dead terminal. The
 * elevated case opens a real console window on the desktop instead (see `elevatedShell`).
 */
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import * as pty from "node-pty";

export interface TermHooks {
  onData: (id: string, data: string) => void;
  onExit: (id: string, code: number) => void;
}

export interface OpenedTerm {
  id: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
}

interface Term {
  proc: pty.IPty;
  shell: string;
  cwd: string;
  /** Recent output, replayed when the page reconnects. */
  buf: string;
}

const MAX_TERMS = 4;
const KEEP_BYTES = 200_000;

const SHELLS: { file: string; label: string }[] = [
  { file: "C:/Program Files/PowerShell/7/pwsh.exe", label: "pwsh" },
  { file: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", label: "powershell" },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pickShell(): { file: string; args: string[]; label: string } {
  for (const { file, label } of SHELLS) {
    if (fs.existsSync(file)) return { file, args: ["-NoLogo"], label };
  }
  return { file: process.env.ComSpec ?? "cmd.exe", args: [], label: "cmd" };
}

function resolveCwd(wanted: string | undefined): string {
  if (wanted) {
    try {
      if (fs.statSync(wanted).isDirectory()) return wanted;
    } catch {
      /* not there any more: fall through to the home directory */
    }
  }
  return os.homedir();
}

export class Terminals {
  private terms = new Map<string, Term>();
  private seq = 0;

  constructor(private hooks: TermHooks) {}

  list(): OpenedTerm[] {
    return [...this.terms].map(([id, term]) => ({ id, shell: term.shell, cwd: term.cwd, cols: 0, rows: 0 }));
  }

  open(opts: { cols?: number; rows?: number; cwd?: string }): OpenedTerm | { error: string } {
    if (this.terms.size >= MAX_TERMS) return { error: `最多同时开 ${MAX_TERMS} 个终端，先关掉一个` };
    const cols = clamp(opts.cols ?? 100, 20, 400);
    const rows = clamp(opts.rows ?? 30, 5, 200);
    const cwd = resolveCwd(opts.cwd);
    const { file, args, label } = pickShell();
    const env = { ...process.env } as Record<string, string>;
    for (const key of Object.keys(env)) if (key.startsWith("PI_") || env[key] === undefined) delete env[key];
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";

    let proc: pty.IPty;
    try {
      proc = pty.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env });
    } catch (err) {
      return { error: `启动终端失败：${(err as Error).message}` };
    }
    this.seq += 1;
    const id = `t${this.seq.toString(36)}-${Date.now().toString(36)}`;
    const term: Term = { proc, shell: label, cwd, buf: "" };
    this.terms.set(id, term);
    proc.onData((data) => {
      term.buf = (term.buf + data).slice(-KEEP_BYTES);
      this.hooks.onData(id, data);
    });
    proc.onExit(({ exitCode }) => {
      this.terms.delete(id);
      this.hooks.onExit(id, exitCode);
    });
    return { id, shell: label, cwd, cols, rows };
  }

  /** Output so far, so a reloaded page can show what happened while it was away. */
  history(id: string): string | null {
    return this.terms.get(id)?.buf ?? null;
  }

  /** What to print in the panel header when a page re-attaches to a shell it did not open. */
  describe(id: string): { shell: string; cwd: string } | null {
    const term = this.terms.get(id);
    return term ? { shell: term.shell, cwd: term.cwd } : null;
  }

  write(id: string, data: string): boolean {
    const term = this.terms.get(id);
    if (!term) return false;
    term.proc.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.terms.get(id);
    if (!term) return;
    try {
      term.proc.resize(clamp(cols, 20, 400), clamp(rows, 5, 200));
    } catch {
      /* the shell may already be gone; nothing to fix */
    }
  }

  close(id: string): boolean {
    const term = this.terms.get(id);
    if (!term) return false;
    this.terms.delete(id);
    try {
      term.proc.kill();
    } catch {
      /* already dead */
    }
    return true;
  }

  closeAll(): void {
    for (const id of [...this.terms.keys()]) this.close(id);
  }
}

/**
 * Q-008: an elevated shell cannot stream into the browser (Windows will not hand a non-elevated
 * parent the console of an elevated child), so “run as administrator” opens a real window on the
 * desktop and the caller is told so instead of getting a terminal that never prints anything.
 *
 * The command is handed over as -EncodedCommand (base64 UTF-16LE): no nested quoting, no path with
 * a space or a quote can turn into two arguments.
 */
export function openConsole(options: { cwd?: string; file?: string; admin?: boolean }): { ok: boolean; message: string } {
  if (process.platform !== "win32") return { ok: false, message: "提权只支持 Windows" };
  const cwd = resolveCwd(options.cwd);
  const shell = pickShell();
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  // A script runs and the window closes with it; a bare terminal stays open to be typed into.
  const args = ["-NoLogo"];
  if (options.file) args.push("-File", options.file);
  else args.push("-NoExit");
  const argList = args.map(quote).join(",");
  const verb = options.admin ? " -Verb RunAs" : "";
  const script = `Start-Process -FilePath ${quote(shell.file)} -ArgumentList ${argList} -WorkingDirectory ${quote(cwd)}${verb}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    // No `detached`: a detached child gets DETACHED_PROCESS (no console), and Start-Process needs a
    // desktop session to open a window — it silently did nothing. The launcher exits right away and
    // the window it started is its own process, so nothing here needs to survive the bridge.
    spawn("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch (err) {
    return { ok: false, message: `打不开窗口：${(err as Error).message}` };
  }
  const where = options.admin ? "管理员" : "";
  const what = options.file ? `${where} PowerShell 窗口（跑这个脚本）` : `${where} PowerShell 窗口`;
  // Q-023: this notice used to say "提权" even when -Verb RunAs was never added, so a plain shell
  // was reported as an elevated one. Say only what actually happened.
  const why = options.admin
    ? "提权进程的控制台不归网页管，输入输出都在那个窗口里；UAC 里点了取消，窗口就不会出现。"
    : "它开在自己的窗口里，输入输出都不回网页。";
  return { ok: true, message: `已在这台电脑上打开${what}，工作目录 ${cwd}。${why}` };
}
