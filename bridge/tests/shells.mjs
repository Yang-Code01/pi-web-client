/**
 * Which shells the terminal ＋ offers (#23). Pure function over (platform, env, exists), so both
 * platforms are checked on any machine. Uses the built bridge:
 *   npm run build:bridge && node bridge/tests/shells.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { availableShells } from "../dist/terminal.js";

const has = (...files) => (f) => files.map((x) => path.normalize(x)).includes(path.normalize(f));
const ids = (list) => list.map((s) => s.id);

// Linux / macOS: $SHELL first, then the usual ones; never cmd.exe.
let list = availableShells("linux", { SHELL: "/usr/bin/fish" }, has("/usr/bin/fish", "/bin/bash", "/bin/sh"));
assert.deepEqual(ids(list), ["fish", "bash", "sh"]);
assert.deepEqual(list[0].args, ["-l"]);
console.log("ok 1  linux: $SHELL first, then bash, sh");

list = availableShells("darwin", {}, has("/bin/zsh", "/bin/bash", "/bin/sh"));
assert.deepEqual(ids(list), ["zsh", "bash", "sh"]);
console.log("ok 2  macOS without $SHELL: zsh, bash, sh");

list = availableShells("darwin", { SHELL: "/bin/zsh" }, has("/bin/zsh", "/bin/sh"));
assert.deepEqual(ids(list), ["zsh", "sh"]);
console.log("ok 3  $SHELL already in the list is not repeated");

// Windows: PowerShell 7, Windows PowerShell, Git Bash, cmd — whatever exists.
const env = { ProgramFiles: "C:/Program Files", "ProgramFiles(x86)": "C:/Program Files (x86)", SystemRoot: "C:/Windows", ComSpec: "C:/Windows/System32/cmd.exe" };
list = availableShells(
  "win32",
  env,
  has(
    "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
    "C:/Windows/System32/cmd.exe",
  ),
);
assert.deepEqual(ids(list), ["powershell", "git-bash", "cmd"]);
assert.equal(list.find((s) => s.id === "git-bash").label, "Git Bash");
console.log("ok 4  windows: powershell, Git Bash (x86 path), cmd");

list = availableShells("linux", {}, () => false);
assert.deepEqual(list, []);
console.log("ok 5  nothing found → empty (the bridge reports it instead of spawning cmd.exe)");
console.log("PASS");
