/**
 * `/login` and `/logout` for the web (#27), run by pi's own ModelRuntime in the bridge process.
 *
 * pi's login is UI-agnostic: `ModelRuntime.login(provider, "api_key" | "oauth", interaction)` asks
 * through `interaction.prompt()` (text / secret / select / manual_code) and reports through
 * `interaction.notify()` (auth_url, device_code, info, progress). The terminal draws those as a
 * dialog; here they travel over the WebSocket to the page and the answers come back the same way.
 * The credential is written by pi into `<agentDir>/auth.json` under pi's lock — the bridge never
 * sees a stored secret again, and never sends one to a page.
 *
 * OAuth callbacks land on a localhost server started by the provider's flow, i.e. on the bridge
 * machine. From another device, the flow's own `manual_code` prompt takes the pasted redirect URL
 * or code instead (pi docs/providers.md: "paste the final redirect URL").
 */
import crypto from "node:crypto";
import path from "node:path";
import { agentDir } from "./paths.ts";
import { piModule } from "./pimods.ts";

export interface ProviderAuthView {
  id: string;
  name: string;
  /** Login methods pi offers for it (an API-key auth without `login` is ambient-only: env vars etc.). */
  methods: { type: "api_key" | "oauth"; label: string }[];
  configured: boolean;
  /** Where the working credential comes from: stored (auth.json), environment, models.json … */
  source: string | null;
  label: string | null;
  /** What auth.json holds for it, if anything (type only — never the value). */
  stored: "api_key" | "oauth" | null;
}

async function runtime(cli: string): Promise<any> {
  const { ModelRuntime } = await piModule(cli, "core/model-runtime.js");
  return ModelRuntime.create({
    authPath: path.join(agentDir(), "auth.json"),
    modelsPath: path.join(agentDir(), "models.json"),
    allowModelNetwork: false,
  });
}

export async function listProviders(cli: string): Promise<ProviderAuthView[]> {
  const rt = await runtime(cli);
  const stored = new Map<string, "api_key" | "oauth">();
  for (const c of (await rt.listCredentials()) as { providerId: string; type: "api_key" | "oauth" }[]) stored.set(c.providerId, c.type);
  const out: ProviderAuthView[] = [];
  for (const p of rt.getProviders() as any[]) {
    const methods: ProviderAuthView["methods"] = [];
    if (p.auth?.apiKey?.login) methods.push({ type: "api_key", label: p.auth.apiKey.name ?? "API key" });
    if (p.auth?.oauth) methods.push({ type: "oauth", label: p.auth.oauth.loginLabel ?? p.auth.oauth.name ?? "OAuth" });
    let status: { configured?: boolean; source?: string; label?: string } = {};
    try {
      status = rt.getProviderAuthStatus(p.id) ?? {};
    } catch {
      /* a provider whose status throws is shown as not configured */
    }
    out.push({
      id: String(p.id),
      name: String(p.name ?? p.id),
      methods,
      configured: Boolean(status.configured),
      source: status.source ?? null,
      label: status.label ?? null,
      stored: stored.get(p.id) ?? null,
    });
  }
  out.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
  return out;
}

/** One running login: the page answers its prompts, or cancels it. */
interface LoginRun {
  id: string;
  provider: string;
  abort: AbortController;
  prompts: Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>;
}

export interface LoginIo {
  /** Send one message to the page that started the login. */
  send: (msg: Record<string, unknown>) => void;
}

const runs = new Map<string, LoginRun>();

/**
 * Start `pi /login <provider>` with method `type`. Resolves when pi has stored the credential (or
 * rejects with the provider's error / "cancelled"). Prompts and events go out through `io.send`.
 */
export async function login(cli: string, provider: string, type: "api_key" | "oauth", io: LoginIo): Promise<{ loginId: string; done: Promise<void> }> {
  const rt = await runtime(cli);
  const p = (rt.getProviders() as any[]).find((x) => x.id === provider);
  if (!p) throw new Error(`pi 不认识这个 provider：${provider}`);
  if (type === "api_key" && !p.auth?.apiKey?.login) throw new Error(`${p.name} 没有 API key 登录（只能用环境变量等方式）`);
  if (type === "oauth" && !p.auth?.oauth) throw new Error(`${p.name} 不支持 OAuth 登录`);
  const run: LoginRun = { id: `login_${crypto.randomUUID().slice(0, 8)}`, provider, abort: new AbortController(), prompts: new Map() };
  runs.set(run.id, run);
  // Same device id the terminal's /login sends (some providers want it).
  const { SettingsManager } = await piModule(cli, "core/settings-manager.js");
  const settings = SettingsManager.create(process.cwd(), agentDir());
  const done = (async () => {
    try {
      await rt.login(
        provider,
        type,
        {
          signal: run.abort.signal,
          prompt: (prompt: any) =>
            new Promise<string>((resolve, reject) => {
              const promptId = `p${run.prompts.size + 1}_${Date.now().toString(36)}`;
              run.prompts.set(promptId, { resolve, reject });
              // A prompt the flow itself withdraws (callback won the race against manual_code).
              prompt.signal?.addEventListener(
                "abort",
                () => {
                  if (!run.prompts.delete(promptId)) return;
                  io.send({ type: "auth.prompt.cancel", loginId: run.id, promptId });
                  reject(new Error("Login cancelled"));
                },
                { once: true },
              );
              io.send({
                type: "auth.prompt",
                loginId: run.id,
                promptId,
                prompt: {
                  type: prompt.type,
                  message: String(prompt.message ?? ""),
                  placeholder: prompt.placeholder ?? null,
                  options: Array.isArray(prompt.options) ? prompt.options.map((o: any) => ({ id: String(o.id), label: String(o.label ?? o.id), description: o.description ?? null })) : null,
                },
              });
            }),
          notify: (event: any) => io.send({ type: "auth.event", loginId: run.id, event }),
        },
        { getDeviceId: () => settings.getOrCreateDeviceId() },
      );
      await settings.flush?.();
    } finally {
      for (const p of run.prompts.values()) p.reject(new Error("Login cancelled"));
      runs.delete(run.id);
    }
  })();
  return { loginId: run.id, done };
}

export function answer(loginId: string, promptId: string, value: string | null): boolean {
  const run = runs.get(loginId);
  const p = run?.prompts.get(promptId);
  if (!run || !p) return false;
  run.prompts.delete(promptId);
  if (value === null) {
    // Cancelling one prompt cancels the login, like closing the terminal dialog.
    p.reject(new Error("Login cancelled"));
    run.abort.abort();
  } else p.resolve(value);
  return true;
}

export function cancel(loginId: string): boolean {
  const run = runs.get(loginId);
  if (!run) return false;
  run.abort.abort();
  for (const p of run.prompts.values()) p.reject(new Error("Login cancelled"));
  run.prompts.clear();
  return true;
}

/**
 * D229 / pi 1.5.1：登录 Radius 之后，把 Radius MCP 接到这份登录上。
 *
 * 终端里 `/login radius` 成功后会展一个 `Configure Radius MCP in <mcp.json>?`（`offerRadiusMcpServer`
 * → `planRadiusMcpServer`），网页这边同样问，只是以一条提示出现在登录面板里 —— 写文件的判断与
 * 内容都用 pi 自己的两个函数，桥不自己拼 mcp.json，也不从页面收配置。
 */
export const RADIUS_PROVIDER = "radius";

export interface RadiusMcpPlan {
  /** 要写的 mcp.json（pi 的全局那份）。 */
  mcpPath: string;
  /** 服务名（`radius` / `radius-mcp`…），由 pi 按现有命名空间挑的。 */
  name: string;
}

/** 要不要问：全局 mcp.json 里已经有一个用这份登录的 Radius 服务时 pi 返回 undefined。 */
export async function radiusMcpPlan(cli: string, cwd: string): Promise<RadiusMcpPlan | null> {
  const mod = await piModule(cli, "core/radius-mcp.js");
  const plan = mod.planRadiusMcpServer(RADIUS_PROVIDER, agentDir(), cwd) as { mcpPath: string; name: string; config: unknown } | undefined;
  return plan ? { mcpPath: plan.mcpPath, name: plan.name } : null;
}

/** 用户点了「配上」：重新解一遍计划（页面不参与内容），再交给 pi 的 `addMcpServerConfig()`。 */
export async function addRadiusMcp(cli: string, cwd: string): Promise<RadiusMcpPlan> {
  const mod = await piModule(cli, "core/radius-mcp.js");
  const plan = mod.planRadiusMcpServer(RADIUS_PROVIDER, agentDir(), cwd) as { mcpPath: string; name: string; config: unknown } | undefined;
  if (!plan) throw new Error("全局 mcp.json 里已经有一个用这份登录的 Radius 服务了");
  const mcp = await piModule(cli, "extensions/mcp/config.js");
  mcp.addMcpServerConfig(plan.mcpPath, plan.name, plan.config);
  return { mcpPath: plan.mcpPath, name: plan.name };
}

export async function logout(cli: string, provider: string): Promise<void> {
  const rt = await runtime(cli);
  await rt.logout(provider);
}
