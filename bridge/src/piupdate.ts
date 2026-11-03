/**
 * "Is pi itself out of date?" (#49): settings → 扩展与 MCP shows one row for the CLI the bridge
 * drives. `pi update` asks `https://pi.dev/api/latest-version` and then installs from the npm
 * registry npm is configured with, so the check asks the registry first (that is what an update
 * would actually pull, mirror included) and falls back to pi's own endpoint when the registry is
 * unreachable. Both answers are cached together for 30 minutes, like the extension checks.
 *
 * The two probes return their failure instead of throwing, so the row can still say why it does not
 * know the latest version (network, status, shape) without unwinding through the bridge.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "./market.ts";

/** The npm package `pi update` reinstalls; the bridge's CLI always comes from this package. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_DEV = "https://pi.dev/api/latest-version";
const TTL = 30 * 60_000;

export interface PiLatest {
  latest: string;
  /** Where the answer came from: `npm <host>` or `pi.dev`. */
  source: string;
  checkedAt: number;
}

/** A probe that could not produce a version, with the reason for the row. */
interface Miss {
  error: string;
}

let memo: { at: number; value: PiLatest } | null = null;

/** `registry=` from the npmrc files npm would read, if any. */
function npmrcRegistry(): string | null {
  const files = [path.join(os.homedir(), ".npmrc"), path.join(process.env.APPDATA ?? "", "npm", "etc", "npmrc")];
  for (const file of files) {
    const text = readText(file);
    const m = text ? /^\s*registry\s*=\s*(\S+)\s*$/m.exec(text) : null;
    if (m?.[1]) return m[1];
  }
  return null;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The registry an update would install from: env override, npmrc, then npm's own default. */
export function npmRegistry(): string {
  const raw = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || npmrcRegistry() || "https://registry.npmjs.org/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `version` out of a registry-style JSON body, or the reason it is not there. */
function versionFrom(text: string, what: string): string | Miss {
  let data: { version?: unknown };
  try {
    data = JSON.parse(text) as { version?: unknown };
  } catch {
    return { error: `${what} 返回的不是 JSON` };
  }
  if (typeof data.version !== "string" || !data.version) return { error: `${what} 没有返回版本号` };
  return data.version;
}

async function fromRegistry(): Promise<PiLatest | Miss> {
  const registry = npmRegistry();
  const what = `npm 源 ${hostOf(registry)}`;
  let res: { status: number; text: string };
  try {
    res = await request(`${registry}${PI_PACKAGE.replace("/", "%2F")}/latest`, { timeoutMs: 15_000 });
  } catch (err: any) {
    return { error: `${what} 连不上：${String(err?.message ?? err)}` };
  }
  if (res.status < 200 || res.status >= 300) return { error: `${what} 返回 ${res.status}` };
  const version = versionFrom(res.text, what);
  if (typeof version !== "string") return version;
  return { latest: version, source: what, checkedAt: Date.now() };
}

async function fromPiDev(): Promise<PiLatest | Miss> {
  const what = "pi.dev";
  let res: { status: number; text: string };
  try {
    res = await request(PI_DEV, { timeoutMs: 15_000 });
  } catch (err: any) {
    return { error: `${what} 连不上：${String(err?.message ?? err)}` };
  }
  if (res.status < 200 || res.status >= 300) return { error: `${what} 返回 ${res.status}` };
  const version = versionFrom(res.text, what);
  if (typeof version !== "string") return version;
  return { latest: version, source: what, checkedAt: Date.now() };
}

/**
 * Latest released pi. `force` skips the 30-minute cache (the page's 重新检查); when both sources
 * fail the thrown message carries both reasons.
 */
export async function piLatest(force = false): Promise<PiLatest> {
  if (!force && memo && Date.now() - memo.at < TTL) return memo.value;
  const first = await fromRegistry();
  if ("latest" in first) {
    memo = { at: first.checkedAt, value: first };
    return first;
  }
  const second = await fromPiDev();
  if ("latest" in second) {
    memo = { at: second.checkedAt, value: second };
    return second;
  }
  throw new Error(`${first.error}；${second.error}`);
}
