/**
 * 凭据落盘：Windows 上用 DPAPI（当前用户作用域）加密，其他平台退化成 0600 明文。
 *
 * 为什么不用原生模块：`@node-rs/dpapi`、`win-dpapi` 都要在用户机上编 C++，桥的安装路径
 * （junction 的 node_modules、热部署后重启）经不起这个。PowerShell 调
 * `[System.Security.Cryptography.ProtectedData]` 是同一套系统 API，只是绕了一道进程，
 * 一次加解密几十毫秒，登录态是分钟级的，够用。
 *
 * 文件格式（`credentials.bin`）：
 *   `PWDP1` + 4 字节小端长度 + 密文            ← DPAPI
 *   `PWPL1` + 4 字节小端长度 + 明文 UTF-8      ← 非 Windows 退化
 * 前缀是为了「换机器 / 换用户」能给出准确的中文原因，而不是解密时抛一串乱码。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DPAPI_MAGIC = "PWDP1";
export const PLAIN_MAGIC = "PWPL1";

export function dpapiSupported(platform: string = process.platform): boolean {
  return platform === "win32";
}

/**
 * 跑一段 PowerShell，stdin 进、stdout 出。找不到 pwsh 就先试 powershell（5.1 也有 DPAPI，
 * 但要先 `Add-Type -AssemblyName System.Security`）。
 */
function runPowerShell(script: string, input: string, timeoutMs = 15_000): Promise<string> {
  const exe = process.env.PI_WEB_PWSH || "pwsh";
  return new Promise<string>((resolve, reject) => {
    const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell 超时"));
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && exe !== "powershell") {
        // 没装 pwsh 的机器上系统自带 powershell.exe。
        runPowerShell(script, input, timeoutMs).then(resolve, reject);
        return;
      }
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err.trim() || `PowerShell 退出码 ${code}`));
        return;
      }
      resolve(out.trim());
    });
    child.stdin?.end(input);
  });
}

const PROTECT = `
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($raw)
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($enc))
`;

const UNPROTECT = `
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($raw)
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($dec))
`;

/** DPAPI 加密。只在 Windows 上调；其他地方由 `writeSecret` 走进化分支。 */
export async function dpapiProtect(plain: string): Promise<Buffer> {
  const b64 = await runPowerShell(PROTECT, Buffer.from(plain, "utf8").toString("base64"));
  return Buffer.from(b64, "base64");
}

export async function dpapiUnprotect(blob: Buffer): Promise<string> {
  const b64 = await runPowerShell(UNPROTECT, blob.toString("base64"));
  return Buffer.from(b64, "base64").toString("utf8");
}

export interface SecretFileContent {
  /** 这条凭据是用 DPAPI 加密的，还是明文退化存的。 */
  encrypted: boolean;
  secret: string;
}

function pack(magic: string, body: Buffer): Buffer {
  const head = Buffer.alloc(magic.length + 4);
  head.write(magic, 0, "ascii");
  head.writeUInt32LE(body.length, magic.length);
  return Buffer.concat([head, body]);
}

function unpack(buf: Buffer): { magic: string; body: Buffer } | null {
  if (buf.length < 9) return null;
  const magic = buf.subarray(0, 5).toString("ascii");
  if (magic !== DPAPI_MAGIC && magic !== PLAIN_MAGIC) return null;
  const len = buf.readUInt32LE(5);
  const body = buf.subarray(9, 9 + len);
  if (body.length !== len) return null;
  return { magic, body };
}

/** 写凭据文件。目录不存在就先建；非 Windows 自动 chmod 0600。 */
export async function writeSecret(file: string, secret: string): Promise<{ encrypted: boolean }> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (dpapiSupported()) {
    const blob = await dpapiProtect(secret);
    fs.writeFileSync(file, pack(DPAPI_MAGIC, blob), { mode: 0o600 });
    return { encrypted: true };
  }
  fs.writeFileSync(file, pack(PLAIN_MAGIC, Buffer.from(secret, "utf8")), { mode: 0o600 });
  if (os.platform() !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* 有的文件系统不支持 chmod，写不进去也不影响读写 */
    }
  }
  return { encrypted: false };
}

export type SecretProblem =
  | "missing"
  | "foreign" // 换了 Windows 用户或换了机器，DPAPI 解不开
  | "corrupt"
  | "unavailable";

export class SecretError extends Error {
  readonly problem: SecretProblem;
  constructor(problem: SecretProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

/** 读凭据。文件不在返回 null；解不开抛 `SecretError`（页面据此让人重新登录）。 */
export async function readSecret(file: string): Promise<SecretFileContent | null> {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SecretError("unavailable", "凭据文件读不出来");
  }
  const parsed = unpack(buf);
  if (!parsed) throw new SecretError("corrupt", "凭据文件已损坏，重新登录即可");
  if (parsed.magic === PLAIN_MAGIC) {
    return { encrypted: false, secret: parsed.body.toString("utf8") };
  }
  if (!dpapiSupported()) {
    throw new SecretError("foreign", "这份凭据是在 Windows 上加密的，这台机器解不开");
  }
  try {
    return { encrypted: true, secret: await dpapiUnprotect(parsed.body) };
  } catch {
    throw new SecretError("foreign", "换过 Windows 用户或换过机器，这份凭据解不开，重新登录即可");
  }
}

export function removeSecret(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 删不掉也没关系，下次登录会覆盖 */
  }
}
