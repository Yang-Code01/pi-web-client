/** `peer.html` 的脚本：只跟 bridge 说话（cookie + `/api/peer`），从不直接连 7865。 */

interface OnlinePeer {
  nodeId: string;
  nickname: string;
  hostname: string;
  addr: string;
  port: number;
  lastSeen: number;
}

interface PeerView {
  enabled: boolean;
  running: boolean;
  reason: string;
  status: {
    nodeId: string;
    nickname: string;
    hostname: string;
    port: number;
    online: OnlinePeer[];
    config: { hidden: boolean; pauseFiles: boolean; dnd: boolean; inbox: string; manual: string[] };
  } | null;
}

const dot = document.querySelector("#dot") as HTMLElement;
const me = document.querySelector("#me") as HTMLElement;
const list = document.querySelector("#peers") as HTMLUListElement;
const empty = document.querySelector("#online-empty") as HTMLElement;
const form = document.querySelector("#add") as HTMLFormElement;
const addrInput = document.querySelector("#addr") as HTMLInputElement;
const refresh = document.querySelector("#refresh") as HTMLButtonElement;
const addError = document.querySelector("#add-error") as HTMLElement;

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 5 ? "刚刚" : `${s} 秒前`;
}

function render(view: PeerView | null, note = ""): void {
  if (!view) {
    dot.className = "dot";
    me.textContent = note || "拿不到状态";
    return;
  }
  const status = view.status;
  const up = view.enabled && view.running;
  dot.className = `dot ${up ? "is-up" : "is-down"}`;
  dot.title = up ? "peer 在跑" : view.reason || "peer 没在跑";
  if (!status) {
    me.textContent = view.enabled ? view.reason || "peer 正在启动" : "peer 未启用（PI_PEER=0 或还没构建）";
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  const flags = [status.config.hidden ? "隐身" : "", status.config.pauseFiles ? "暂停收文件" : "", status.config.dnd ? "免打扰" : ""]
    .filter(Boolean)
    .join(" · ");
  me.textContent = `${status.nickname} · ${status.nodeId.slice(0, 8)} · :${status.port}${flags ? ` · ${flags}` : ""}`;

  list.innerHTML = "";
  for (const peer of status.online) {
    const li = document.createElement("li");
    li.className = "peer";
    const left = document.createElement("span");
    left.textContent = peer.nickname;
    const right = document.createElement("small");
    right.textContent = `${peer.hostname || "?"} · ${peer.addr}:${peer.port} · ${ago(peer.lastSeen)}`;
    li.append(left, right);
    list.append(li);
  }
  empty.hidden = status.online.length > 0;
}

async function load(): Promise<void> {
  try {
    const res = await fetch("/api/peer", { headers: { accept: "application/json" } });
    if (res.status === 401) return render(null, "还没登录：先在主页面用口令登录");
    if (!res.ok) return render(null, `状态读取失败（HTTP ${res.status}）`);
    render((await res.json()) as PeerView);
  } catch (err) {
    render(null, `连不上 bridge：${(err as Error).message}`);
  }
}

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".tab")) other.classList.toggle("is-on", other === tab);
    for (const view of document.querySelectorAll<HTMLElement>(".view")) {
      view.hidden = view.id !== `view-${tab.dataset.view}`;
    }
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  addError.hidden = true;
  const addr = addrInput.value.trim();
  if (!addr) return;
  try {
    const res = await fetch("/api/peer/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addr }),
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    addrInput.value = "";
    await load();
  } catch (err) {
    addError.textContent = (err as Error).message;
    addError.hidden = false;
  }
});

refresh.addEventListener("click", async () => {
  addError.hidden = true;
  try {
    await fetch("/api/peer/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await load();
  } catch (err) {
    addError.textContent = `广播失败：${(err as Error).message}`;
    addError.hidden = false;
  }
});

void load();
// 第 1 片的实时性够用了：5 秒一轮，不需要为一张空壳页再开一条 WS。
setInterval(() => void load(), 5000);

// 在主页面里作为弹框的 iframe 打开时，「‹ 回 pi」会把整个 iframe 换成主页面，
// 所以嵌入式隐藏它 —— 关闭按钮已在弹框标题栏里。
if (window.self !== window.top) document.body.classList.add("embedded");
