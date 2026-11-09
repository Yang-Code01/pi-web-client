/**
 * D208: 产物弹窗要能说「这个文件原来是空的 / 原来长这样」，所以必须在**写入之前**把原文存下来。
 *
 * 这是唯一零竞态的位置：pi 在 `tool_call` 上 await 所有 handler，然后才执行工具。我们在这个
 * handler 里等桥把文件读进它自己的状态目录（`POST /api/artifacts/snapshot`），回来以后写入才
 * 开始。桥读完就应答，所以文件内容不用经过 RPC —— 只传路径。
 *
 * 三条纪律：
 * - 只处理写文件的工具，别的工具一个字节都不发；
 * - 失败一律 fail-open：桥没开、超时、回 500 都不影响写文件，代价只是这一行在界面上显示「未知」；
 * - 绝不返回 `{block:true}` —— 这不是权限闸，是记账。
 *
 * stdout 属于 RPC 协议：日志只能走 console.error。
 */

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "multi_edit", "create", "str_replace_editor", "apply_patch"]);

function toolPath(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const a = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "file", "filename"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

async function postSnapshot(filePath: string): Promise<void> {
  const base = process.env.PI_WEB_LOOPBACK;
  const token = process.env.PI_WEB_LOOPBACK_TOKEN;
  if (!base || !token) return;
  // 本机回环，正常 1–5 ms；2 s 只是「桥不在了」的兜底，不能让写文件等这么久。
  await fetch(`${base}/api/artifacts/snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, path: filePath }),
    signal: AbortSignal.timeout(2000),
  });
}

export default function artifactSnapshot(pi: any): void {
  pi.on("tool_call", async (event: any) => {
    try {
      const name = String(event?.toolName ?? "").toLowerCase();
      if (!WRITE_TOOLS.has(name)) return;
      const filePath = toolPath(event?.input);
      if (!filePath) return;
      await postSnapshot(filePath);
    } catch (err: any) {
      // 记账失败不是工具失败。只留一行日志，别再往上抛（抛了会把这次写入拦下来）。
      console.error(`[artifact-snapshot] skipped: ${String(err?.message ?? err)}`);
    }
  });
  pi.on("session_start", async () => {
    console.error("[artifact-snapshot] active");
  });
}
