import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { wavDuration } from "./audio.mjs";

const DEFAULT_VOICE = "Microsoft Huihui Desktop";

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        env: options.env || process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: String(error), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, options.timeout == null ? 30000 : options.timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, stdout, stderr, timedOut });
    });
  });
}

const SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $requested = $env:E2E_TTS_VOICE
  $selected = $false
  if ($requested) {
    try { $s.SelectVoice($requested); $selected = $true } catch { }
  }
  if (-not $selected) {
    $zh = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like "zh-*" } | Select-Object -First 1
    if (-not $zh) { throw "no zh-CN voice installed" }
    $s.SelectVoice($zh.VoiceInfo.Name)
  }
  $s.Rate = [int]$env:E2E_TTS_RATE
  $s.SetOutputToWaveFile($env:E2E_TTS_PATH)
  $s.Speak($env:E2E_TTS_TEXT)
} finally {
  $s.Dispose()
}
`;

/**
 * Windows SAPI narration. Every request is cached by text + voice + rate, so
 * re-recording the same case is instant and every clip gets a stable WAV.
 */
export function createTts(options = {}) {
  const dir = path.join(options.dir || process.cwd(), "tts");
  const enabled = options.enabled !== false && process.platform === "win32";
  const voice = options.voice || "";
  const rate = Math.max(-10, Math.min(10, Number.isFinite(options.rate) ? options.rate : -1));
  const log = options.log || (() => {});
  const timeoutMs = options.timeoutMs == null ? 30000 : options.timeoutMs;
  const failures = [];
  const used = new Set();
  let dirReady = false;

  function ensureDir() {
    if (dirReady) return;
    fs.mkdirSync(dir, { recursive: true });
    dirReady = true;
  }

  async function speak(text) {
    const clean = String(text == null ? "" : text)
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return { ok: false, reason: "empty text" };
    if (!enabled) return { ok: false, reason: "tts disabled" };
    if (process.platform !== "win32") return { ok: false, reason: "tts only on Windows" };
    ensureDir();
    const hash = createHash("sha1")
      .update(`${voice}\u0000${rate}\u0000${clean}`)
      .digest("hex");
    const file = path.join(dir, `${hash}.wav`);
    if (fs.existsSync(file) && fs.statSync(file).size > 44) {
      try {
        const duration = wavDuration(fs.readFileSync(file));
        used.add(file);
        return { ok: true, path: file, duration, cached: true, voice: voice || DEFAULT_VOICE };
      } catch (error) {
        fs.rmSync(file, { force: true });
        log(`tts cache unreadable, regenerating: ${error.message}`);
      }
    }
    const result = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      {
        env: {
          ...process.env,
          E2E_TTS_VOICE: voice,
          E2E_TTS_RATE: String(rate),
          E2E_TTS_PATH: file,
          E2E_TTS_TEXT: clean
        },
        timeout: timeoutMs
      }
    );
    if (result.code !== 0 || !fs.existsSync(file) || fs.statSync(file).size <= 44) {
      const error = result.timedOut ? "timeout" : result.stderr.slice(-1200);
      fs.rmSync(file, { force: true });
      failures.push({ text: clean, error });
      log(`tts failed: ${error}`);
      return { ok: false, reason: "sapi failed", error };
    }
    const duration = wavDuration(fs.readFileSync(file));
    used.add(file);
    return { ok: true, path: file, duration, cached: false, voice: voice || DEFAULT_VOICE };
  }

  return {
    speak,
    failures,
    used,
    enabled,
    voice: voice || DEFAULT_VOICE,
    rate,
    dir
  };
}

/** Installed enabled SAPI voices, for `doctor` and the report appendix. */
export async function listTtsVoices() {
  if (process.platform !== "win32") return [];
  const script =
    'Add-Type -AssemblyName System.Speech; ' +
    '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
    'Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name }';
  const result = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeout: 15000 }
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, culture] = line.split("|");
      return { name, culture };
    })
    .filter((voice) => voice.name);
}
