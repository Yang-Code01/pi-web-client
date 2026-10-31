import crypto from "node:crypto";
import fs from "node:fs";
import { statePath, ensureStateDirs } from "./paths.ts";

const COOKIE = "pwc";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX = 5;

const WORDS = [
  "amber", "basil", "cedar", "delta", "ember", "fable", "gamma", "harbor", "indigo", "juniper",
  "kilo", "linen", "maple", "nectar", "onyx", "pepper", "quartz", "raven", "saffron", "tango",
  "umber", "vega", "willow", "xenon", "yarrow", "zephyr", "cobalt", "drift", "flint", "gusto",
];

function secret(): Buffer {
  ensureStateDirs();
  const file = statePath("secret");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
}

export function generatePassphrase(): string {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  const digits = String(crypto.randomInt(1000)).padStart(3, "0");
  return `${pick()}-${pick()}-${pick()}-${digits}`;
}

/** Rewrites the passphrase (hash + plaintext copy). Existing cookies stay valid. */
export function setPassphrase(pass: string): void {
  setPassphraseOnDisk(pass);
}

function setPassphraseOnDisk(pass: string): void {
  ensureStateDirs();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pass, salt, 32).toString("hex");
  fs.writeFileSync(statePath("passphrase.hash"), `scrypt$${salt}$${hash}`, { mode: 0o600 });
  fs.writeFileSync(statePath("passphrase.txt"), `${pass}\n`, { mode: 0o600 });
}

/** Creates a passphrase on first run; returns the plain text only when it was just generated. */
export function ensurePassphrase(): string | null {
  ensureStateDirs();
  if (fs.existsSync(statePath("passphrase.hash"))) return null;
  const pass = generatePassphrase();
  setPassphraseOnDisk(pass);
  return pass;
}

export function currentPassphrase(): string | null {
  try {
    return fs.readFileSync(statePath("passphrase.txt"), "utf8").trim();
  } catch {
    return null;
  }
}

export function passphraseIsSet(): boolean {
  return fs.existsSync(statePath("passphrase.hash"));
}

export function verifyPassphrase(input: string): boolean {
  try {
    const [kind, salt, hash] = fs.readFileSync(statePath("passphrase.hash"), "utf8").split("$");
    if (kind !== "scrypt" || !salt || !hash) return false;
    const got = crypto.scryptSync(input, salt, 32);
    const want = Buffer.from(hash, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

function sign(value: string): string {
  return crypto.createHmac("sha256", secret()).update(value).digest("hex");
}

export function issueSessionToken(): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const body = String(exp);
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return false;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const exp = Number(body);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const want = Buffer.from(sign(body), "hex");
  let got: Buffer;
  try {
    got = Buffer.from(mac, "hex");
  } catch {
    return false;
  }
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    // Cookies on 127.0.0.1 are shared with every other local port; one malformed %-escape from
    // another app must not make every request here throw.
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean): string {
  const bits = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function clearedCookie(secure: boolean): string {
  const bits = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function authorized(cookieHeader: string | undefined): boolean {
  return verifySessionToken(parseCookies(cookieHeader)[COOKIE]);
}

const attempts = new Map<string, { count: number; resetAt: number }>();

export function loginAllowed(ip: string): boolean {
  const now = Date.now();
  if (attempts.size > 10_000) {
    for (const [key, value] of attempts) if (value.resetAt < now) attempts.delete(key);
  }
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  rec.count += 1;
  return rec.count <= LOGIN_MAX;
}

export function resetLoginAttempts(ip: string): void {
  attempts.delete(ip);
}

/**
 * Requests arriving through cloudflared come from 127.0.0.1 and carry CF headers.
 * Anything with cf-connecting-ip is treated as public (needs Secure cookies).
 */
export function isTunnelRequest(headers: Record<string, string | string[] | undefined>): boolean {
  return Boolean(headers["cf-connecting-ip"] || headers["x-forwarded-proto"] === "https");
}

function isLoopback(ip: string | undefined): boolean {
  return /^(::1|::ffff:127\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+)$/.test(ip ?? "");
}

/**
 * cf-connecting-ip is only believed when the peer is loopback (the local cloudflared). A LAN client
 * could otherwise send a fresh fake value per request and dodge the per-IP login limit.
 */
export function clientIp(headers: Record<string, string | string[] | undefined>, socketIp: string | undefined): string {
  const cf = headers["cf-connecting-ip"];
  if (isLoopback(socketIp) && typeof cf === "string" && cf) return cf;
  return socketIp || "unknown";
}
