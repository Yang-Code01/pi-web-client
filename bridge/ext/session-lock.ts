/**
 * Session lock for the *terminal* pi (#30), installed from pi-web-client's 设置 → 终端联动.
 *
 * pi has no session-file lock: a terminal pi and the web's pi writing the same .jsonl make two
 * invisible sibling branches (pi-web-client docs/DECISIONS.md D8). The bridge already refuses to
 * take over a file written in the last 20 seconds, but an idle terminal pi slips through, and the
 * terminal never knew about the web's lock at all. This extension closes both gaps:
 *
 *  - while a terminal pi has a session open it writes `<locks>/<id>.tty.json` (its pid); the bridge
 *    refuses to take that session over and shows it as 「终端占用」;
 *  - when the terminal opens a session the web is writing (`<locks>/<id>.lock` held by a live
 *    bridge), it says so and offers to quit before anything is appended.
 *
 * The bridge writes this file with LOCK_DIR filled in; the web's own pi children skip it (they run
 * with PI_WEB_ALLOW_FILE set).
 */
import fs from "node:fs";
import path from "node:path";

const LOCK_DIR: string = "__LOCK_DIR__";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function readPid(file: string): number | null {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(file, "utf8"))?.pid);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export default function sessionLock(pi: any): void {
  if (process.env.PI_WEB_ALLOW_FILE) return; // a pi the web itself started: the bridge owns its lock
  let held: string | null = null;

  const release = () => {
    if (!held) return;
    try {
      if (readPid(held) === process.pid) fs.unlinkSync(held);
    } catch {
      /* already gone */
    }
    held = null;
  };
  process.once("exit", release);

  pi.on("session_start", async (_event: any, ctx: any) => {
    release();
    const id = String(ctx.sessionManager?.getSessionId?.() ?? "");
    if (!id) return;
    const web = readPid(path.join(LOCK_DIR, `${id}.lock`));
    if (web && web !== process.pid && alive(web)) {
      const msg = "网页（pi-web-client）正在写这个会话。两边同时写会让会话分叉、互相看不见对方的消息。";
      if (ctx.hasUI) {
        const pick = await ctx.ui.select(`${msg}\n先在网页上点「让回终端」，再回来打开。`, ["退出 pi", "仍然打开（会分叉）"]);
        if (pick !== "仍然打开（会分叉）") {
          ctx.shutdown();
          return;
        }
      } else {
        console.error(`[pi-web-client] ${msg}`);
      }
    }
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
      held = path.join(LOCK_DIR, `${id}.tty.json`);
      fs.writeFileSync(held, JSON.stringify({ pid: process.pid, at: Date.now(), cwd: ctx.cwd }));
    } catch {
      held = null;
    }
  });

  pi.on("session_shutdown", async () => release());
}
