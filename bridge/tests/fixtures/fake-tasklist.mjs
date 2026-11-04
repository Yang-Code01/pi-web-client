/**
 * Stand-in for the process table the bridge samples for the runtime panel (#77):
 * `tasklist /FO CSV /NH` on win32, `ps -A -o pid=,rss=` on darwin / linux.
 *
 * Rows come from `FAKE_TABLE` (JSON: pid → KiB), so a test can write the **real** pids of the stub
 * pi processes it just started, plus a decoy pid that must be ignored. The output shape follows the
 * arguments the bridge actually passes. `FAKE_TABLE_GARBAGE` prints that text instead — the
 * "the format changed under us" case — and `FAKE_TABLE_LOG` gets one line per run, which is how
 * "we did not sample" is provable.
 */
import fs from "node:fs";

const logPath = process.env.FAKE_TABLE_LOG || "";
if (logPath) fs.appendFileSync(logPath, JSON.stringify({ at: Date.now(), argv: process.argv.slice(2) }) + "\n");

if (process.env.FAKE_TABLE_GARBAGE !== undefined) {
  process.stdout.write(process.env.FAKE_TABLE_GARBAGE);
  process.exit(0);
}

let rows = [];
try {
  rows = Object.entries(JSON.parse(fs.readFileSync(process.env.FAKE_TABLE || "", "utf8")));
} catch {
  /* no table yet: print nothing, which is a valid empty table */
}

const csv = process.argv.includes("/FO");
for (const [pid, kib] of rows) {
  const k = Number(kib).toLocaleString("en-US");
  if (csv) process.stdout.write(`"node.exe","${pid}","Console","1","${k} K"\r\n`);
  else process.stdout.write(`${String(pid).padStart(6)} ${String(Math.round(Number(kib))).padStart(8)}\n`);
}
