import { RpcChild } from "./rpc.ts";
import { statePath } from "./paths.ts";

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

const TTL_MS = 10 * 60 * 1000;

export function normalizeModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const m of raw as any[]) {
    const id = typeof m?.id === "string" ? m.id : "";
    const provider = typeof m?.provider === "string" ? m.provider : "";
    if (!id || !provider) continue;
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      provider,
      id,
      name: typeof m.name === "string" ? m.name : undefined,
      reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
      maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
    });
  }
  return out;
}

/**
 * The set of models pi would offer, fetched without touching any real session.
 *
 * There is no "list models" RPC that does not need a pi process, so this spawns a
 * short-lived `--no-session` child, asks `get_available_models`, and kills it.
 * The answer changes only when the user edits models.json, hence the TTL cache.
 */
export class ModelCatalog {
  private cache: { at: number; models: ModelInfo[] } | null = null;
  private loading: Promise<ModelInfo[]> | null = null;

  constructor(private cli: string) {}

  async list(force = false): Promise<ModelInfo[]> {
    if (!force && this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.models;
    if (this.loading) return this.loading;
    this.loading = this.fetch()
      .then((models) => {
        this.cache = { at: Date.now(), models };
        return models;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async fetch(): Promise<ModelInfo[]> {
    const rpc = new RpcChild({
      cli: this.cli,
      args: ["--mode", "rpc", "-ne", "--no-session"],
      cwd: process.cwd(),
      logPath: statePath("logs", "models.log"),
    });
    rpc.start();
    try {
      const data = await rpc.request<any>("get_available_models", {}, 30000);
      return normalizeModels(data?.models);
    } finally {
      rpc.kill();
    }
  }
}
