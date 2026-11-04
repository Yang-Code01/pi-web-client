/**
 * How much memory the pi processes are really taking (D120 / #77).
 *
 * The only pids that count are the ones the bridge's own `RpcChild` handles report — never "find
 * the parent" and never "everything named node.exe". A memory number that can be off by one
 * process is worse than no number: #79 will reap sessions with it.
 *
 * Reading the table is per-platform (`tasklist /FO CSV /NH`, `ps -A -o pid=,rss=`), and the
 * parsing is a pure function so "the output format changed" is a test, not a support ticket. A
 * reading that cannot be trusted comes back as a failure, and the panel says 「不可用」 (D120 §6).
 */
import { spawn } from "node:child_process";

export type TableStyle = "tasklist" | "ps";

export interface ProcessTableCommand {
  /** The executable to spawn. */
  file: string;
  args: string[];
  style: TableStyle;
  /** What to call it in logs — under the test seam `file` is node itself. */
  label: string;
}

/** A sample, or the reason there is none. `failure === null` means the bytes are real. */
export interface MemSample {
  /** pid → resident bytes, only for the pids we asked about and the table happened to list. */
  bytes: Map<number, number>;
  failure: string | null;
}

/** D120 §2: a process table that takes longer than this is treated as unreadable. */
export const SAMPLE_TIMEOUT_MS = 2000;

/**
 * The command that lists every process with its resident size, or `null` on a platform we have no
 * rule for. `PI_WEB_PROCESS_TABLE_BIN` replaces the whole command with a **node script** for tests
 * (the same seam as `PI_BIN`, so the fixture is a `.mjs`); it is `PI_WEB_*` and never reaches pi.
 */
export function processTableCommand(platform: NodeJS.Platform = process.platform): ProcessTableCommand | null {
  const win32 = platform === "win32";
  if (!win32 && platform !== "darwin" && platform !== "linux") return null;
  const style: TableStyle = win32 ? "tasklist" : "ps";
  const args = win32 ? ["/FO", "CSV", "/NH"] : ["-A", "-o", "pid=,rss="];
  const override = process.env.PI_WEB_PROCESS_TABLE_BIN;
  if (override) return { file: process.execPath, args: [override, ...args], style, label: "process table stub" };
  const file = win32 ? "tasklist" : "ps";
  return { file, args, style, label: file };
}

/**
 * One CSV record → fields, honouring the quotes `tasklist` puts around every field (the memory
 * column contains a thousands separator, so a plain `split(",")` would cut it in half).
 */
function csvFields(line: string): string[] | null {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  let seenQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === '"' && !field) {
      quoted = true;
      seenQuote = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  if (!seenQuote) return null; // not a tasklist row at all
  fields.push(field);
  return fields;
}

/** `"node.exe","15320","Console","1","285,484 K"` → pid + bytes. Anything else is not a row. */
function tasklistRow(line: string): { pid: number; bytes: number } | null {
  const fields = csvFields(line);
  if (!fields || fields.length < 5) return null;
  const pid = Number(fields[1].trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const mem = /^([\d,]+)\s*K$/i.exec(fields[4].trim());
  if (!mem) return null;
  const kib = Number(mem[1].replace(/,/g, ""));
  if (!Number.isFinite(kib)) return null;
  return { pid, bytes: kib * 1024 };
}

/** `  15320  292352` → pid + bytes. `ps -o rss=` is KiB on both darwin and linux. */
function psRow(line: string): { pid: number; bytes: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
  if (!m) return null;
  return { pid: Number(m[1]), bytes: Number(m[2]) * 1024 };
}

/**
 * Pure: the raw table a platform command printed + the pids we own → pid → bytes. Rows for pids
 * that are not ours are dropped (that is the whole point of handing `pids` in), and an output we
 * do not recognise yields an empty map rather than a guess.
 */
export function parseProcessTable(style: TableStyle, raw: string, pids: readonly number[]): Map<number, number> {
  const known = new Set(pids);
  const out = new Map<number, number>();
  const rowOf = style === "tasklist" ? tasklistRow : psRow;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = rowOf(line.replace(/\r$/, ""));
    if (!row || !known.has(row.pid)) continue;
    out.set(row.pid, row.bytes);
  }
  return out;
}

/** Run the platform command and hand back what it printed; any trouble is a failure, not a throw. */
function readTable(cmd: ProcessTableCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.file, cmd.args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let raw = "";
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!err) return resolve(raw);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(err);
    };
    const timer = setTimeout(() => finish(new Error(`${cmd.label} did not answer within ${SAMPLE_TIMEOUT_MS}ms`)), SAMPLE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      raw += chunk;
      // A table that big is not a process table; stop reading before it eats the tick.
      if (raw.length > 4 * 1024 * 1024) finish(new Error(`${cmd.label} printed more than 4 MB`));
    });
    child.on("error", (err) => finish(new Error(`cannot run ${cmd.label}: ${err.message}`)));
    child.on("close", () => finish(null));
  });
}

/**
 * Resident bytes of exactly these pids. `pids` empty = nothing to measure, which is not a failure;
 * every other way of having no trustworthy number is, so callers can say 「不可用」 instead of
 * reaping a session over a bad measurement (D120 §6).
 */
export async function sampleMemory(pids: readonly number[]): Promise<MemSample> {
  const none = new Map<number, number>();
  if (!pids.length) return { bytes: none, failure: null };
  const cmd = processTableCommand();
  if (!cmd) return { bytes: none, failure: `no process table command for platform ${process.platform}` };
  let raw: string;
  try {
    raw = await readTable(cmd);
  } catch (err) {
    return { bytes: none, failure: String((err as Error)?.message ?? err) };
  }
  const bytes = parseProcessTable(cmd.style, raw, pids);
  if (!bytes.size) return { bytes, failure: `${cmd.label} listed none of our ${pids.length} pid(s)` };
  return { bytes, failure: null };
}
