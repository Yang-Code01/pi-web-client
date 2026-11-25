/**
 * 出网路由的纯逻辑：代理候选从哪来、按什么顺序、每一路给多久、全失败时说了什么。
 *
 * 这层的价值全在「直连挂了还有没有下一手」：`viaRoutes` 的顺序错一次，评审就会在同样一处
 * 白白失败（现场那句：`error: RPC failed; curl 56 Recv failure: Connection was reset`）。
 *
 *   node --experimental-strip-types bridge/tests/netroute-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FETCH_PLAN,
  directEnv,
  discoverLocalProxies,
  normalizeProxy,
  parseListeners,
  parseScutilProxy,
  parseWindowsProxyServer,
  probeHttpProxy,
  proxyCandidates,
  proxyEnv,
  readPiHttpProxy,
  resolveProxyCandidates,
  viaRoutes,
} from "../src/netroute.ts";

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

/** 拿一个只装着指定变量的 env，避免本机真代理变量混进断言。 */
const env = (over = {}) => ({ NO_PROXY: "127.0.0.1,localhost", ...over });

await check("normalizeProxy：补 scheme、去末尾斜杠、空值给空串", () => {
  assert.equal(normalizeProxy("127.0.0.1:7899"), "http://127.0.0.1:7899");
  assert.equal(normalizeProxy("http://127.0.0.1:7899/"), "http://127.0.0.1:7899");
  assert.equal(normalizeProxy(" https://proxy.local:8443/// "), "https://proxy.local:8443");
  assert.equal(normalizeProxy(""), "");
  assert.equal(normalizeProxy(null), "");
});

await check("parseWindowsProxyServer：共用写法与分协议写法都认，重复只留一次", () => {
  assert.deepEqual(parseWindowsProxyServer("127.0.0.1:7899"), ["http://127.0.0.1:7899"]);
  assert.deepEqual(parseWindowsProxyServer("http=127.0.0.1:7899;https=127.0.0.1:7899"), ["http://127.0.0.1:7899"]);
  assert.deepEqual(parseWindowsProxyServer("http=10.0.0.2:8080;https=10.0.0.3:8443"), ["http://10.0.0.2:8080", "http://10.0.0.3:8443"]);
  assert.deepEqual(parseWindowsProxyServer(""), []);
});

await check("parseScutilProxy：只认手动配置的 HTTP/HTTPS，PAC 拿不到地址就不猜", () => {
  const text = [
    " <dictionary> {",
    "  HTTPEnable : 1",
    "  HTTPPort : 7899",
    "  HTTPProxy : 127.0.0.1",
    "  HTTPSEnable : 1",
    "  HTTPSPort : 7899",
    "  HTTPSProxy : 127.0.0.1",
    "  ProxyAutoConfigEnable : 1",
    " }",
  ].join("\n");
  assert.deepEqual(parseScutilProxy(text), ["http://127.0.0.1:7899"]);
  assert.deepEqual(parseScutilProxy(" ProxyAutoConfigEnable : 1\n"), []);
});

await check("proxyCandidates：pi 设置 → 系统 → env，同一条只留一次", () => {
  const list = proxyCandidates(env({ HTTPS_PROXY: "http://env-proxy:8080/", http_proxy: "http://env-proxy:8080" }), {
    httpProxy: "127.0.0.1:7899",
    system: ["http://sys-proxy:3128"],
  });
  assert.deepEqual(list, ["http://127.0.0.1:7899", "http://sys-proxy:3128", "http://env-proxy:8080"]);
});

await check("proxyCandidates：谁都没配就是空 —— 没有写死的端口兜底（会绑到某台机器上）", () => {
  assert.deepEqual(proxyCandidates(env(), {}), []);
});

await check("proxyCandidates：BILLION_CONTEXT_PROXY 是网关占位主机名，不当出口代理去试", () => {
  const list = proxyCandidates(env({ BILLION_CONTEXT_PROXY: "http://billion-context.inline", HTTPS_PROXY: "http://env-proxy:8080" }), {});
  assert.deepEqual(list, ["http://env-proxy:8080"]);
});

await check("readPiHttpProxy：读 PI_AGENT_DIR 下的 settings.json，缺文件/坏 JSON 给空串", () => {
  const saved = process.env.PI_AGENT_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-netroute-"));
  try {
    // 先指到空目录：不然这台机器上真有一个 httpProxy 的话，第一条断言就在测别人家的设置
    process.env.PI_AGENT_DIR = dir;
    assert.equal(readPiHttpProxy(), "", "没有 settings.json 时应当是空串");
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ httpProxy: "127.0.0.1:7899/" }));
    assert.equal(readPiHttpProxy(), "http://127.0.0.1:7899");
    fs.writeFileSync(path.join(dir, "settings.json"), "{ 这不是 json");
    assert.equal(readPiHttpProxy(), "");
    const list = resolveProxyCandidates();
    assert.ok(list.every((p) => p.startsWith("http")), `候选都要是完整 URL：${list.join(",")}`);
    assert.equal(new Set(list).size, list.length, "候选不许重复");
  } finally {
    if (saved === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = saved;
  }
});

await check("directEnv：把自己身上挂的代理变量全摘掉，并禁掉 git 的交互提示", () => {
  const src = env({
    HTTPS_PROXY: "http://dead:1",
    https_proxy: "http://dead:1",
    HTTP_PROXY: "http://dead:1",
    http_proxy: "http://dead:1",
    ALL_PROXY: "socks5://dead:2",
    all_proxy: "socks5://dead:2",
    BILLION_CONTEXT_PROXY: "http://billion-context.inline",
    PATH: "/usr/bin",
  });
  const out = directEnv(src);
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    assert.equal(out[key], undefined, `${key} 应当被摘掉`);
  }
  assert.equal(out.NO_PROXY, src.NO_PROXY, "NO_PROXY 是白名单，不能动");
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.GIT_TERMINAL_PROMPT, "0");
  assert.equal(src.HTTPS_PROXY, "http://dead:1", "不许改调用方传进来的对象");
});

await check("proxyEnv：同一代理写到 6 个名字上，旧值先被摘掉", () => {
  const out = proxyEnv("127.0.0.1:7899", env({ HTTPS_PROXY: "http://dead:1", HTTP_PROXY: "http://dead:2" }));
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    assert.equal(out[key], "http://127.0.0.1:7899", key);
  }
  assert.equal(out.GIT_TERMINAL_PROMPT, "0");
});

await check("viaRoutes：直连就通时不该去探代理（proxies 是函数也不许调用）", async () => {
  const seen = [];
  let probed = 0;
  const res = await viaRoutes(
    async (e, timeoutMs) => {
      seen.push({ env: e, timeoutMs });
      return { ok: true, value: "ok" };
    },
    { proxies: () => { probed += 1; return ["http://p:1"]; }, plan: FETCH_PLAN },
  );
  assert.equal(res.ok, true);
  assert.equal(res.route, "直连");
  assert.equal(probed, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].env.HTTPS_PROXY, undefined, "直连那一路必须是干净的 env");
});

await check("viaRoutes：直连挂了按候选顺序往下走，第一个通的就停", async () => {
  const calls = [];
  const res = await viaRoutes(
    async (e) => {
      calls.push(e.HTTPS_PROXY ?? "direct");
      if (e.HTTPS_PROXY === "http://p:2") return { ok: true, value: "via-2" };
      return { ok: false, err: e.HTTPS_PROXY ? `${e.HTTPS_PROXY} 超时` : "curl 56 Recv failure: Connection was reset" };
    },
    { proxies: () => ["http://p:1", "http://p:2"], plan: { ...FETCH_PLAN, attempts: 1 } },
  );
  assert.equal(res.ok, true);
  assert.equal(res.value, "via-2");
  assert.equal(res.route, "代理 http://p:2");
  assert.deepEqual(calls, ["direct", "http://p:1", "http://p:2"]);
});

await check("viaRoutes：全挂时等一会儿整轮重试，再把每一条路的原因都报出来", async () => {
  const calls = [];
  const sleeps = [];
  const logs = [];
  const res = await viaRoutes(
    async (e) => {
      calls.push(e.HTTPS_PROXY ?? "direct");
      return { ok: false, err: e.HTTPS_PROXY ? `${e.HTTPS_PROXY} 拒绝连接` : "Connection was reset" };
    },
    {
      proxies: () => ["http://p:1"],
      plan: { directMs: 1000, proxyMs: 1000, attempts: 2, retryMs: 3, budgetMs: 10_000 },
      sleep: async (ms) => { sleeps.push(ms); },
      onLog: (line) => logs.push(line),
    },
  );
  assert.equal(res.ok, false);
  assert.deepEqual(calls, ["direct", "http://p:1", "direct", "http://p:1"]);
  assert.deepEqual(sleeps, [3]);
  assert.equal(res.tried.length, 4);
  assert.match(res.reason, /^直连：Connection was reset；代理 http:\/\/p:1：.*；直连：Connection was reset/);
  assert.ok(logs.some((l) => l.includes("后整轮重试（第 2 轮）")), logs.join("\n"));
});

await check("viaRoutes：一个代理候选都没有时不空转重试", async () => {
  let n = 0;
  const res = await viaRoutes(
    async () => {
      n += 1;
      return { ok: false, err: "Connection was reset" };
    },
    { proxies: [], plan: { ...FETCH_PLAN, attempts: 3, retryMs: 1 } },
  );
  assert.equal(res.ok, false);
  assert.equal(n, 1);
  assert.equal(res.reason, "直连：Connection was reset");
});

await check("viaRoutes：单次超时被剩余预算夹住，attempt 抛异常算失败不算崩", async () => {
  const got = [];
  const res = await viaRoutes(
    async (_e, timeoutMs) => {
      got.push(timeoutMs);
      throw new Error("spawn 失败");
    },
    { proxies: [], plan: { directMs: 90_000, proxyMs: 1, attempts: 1, retryMs: 0, budgetMs: 500 } },
  );
  assert.equal(res.ok, false);
  assert.equal(got.length, 1);
  assert.ok(got[0] <= 500 && got[0] > 300, `期望 500 左右，实际 ${got[0]}`);
  assert.equal(res.reason, "直连：spawn 失败");
});

await check("parseListeners：netstat / lsof / ss 三家都解，通配归一到环回，只留本地监听", () => {
  const win = [
    "  TCP    0.0.0.0:7899           0.0.0.0:0              LISTENING       1234",
    "  TCP    127.0.0.1:18791        0.0.0.0:0              LISTENING       1235",
    "  TCP    127.0.0.1:7899         0.0.0.0:0              LISTENING       1234",
    "  TCP    192.168.1.5:3306       0.0.0.0:0              LISTENING       1236",
    "  TCP    127.0.0.1:7864         127.0.0.1:52111        ESTABLISHED     1237",
  ].join("\r\n");
  assert.deepEqual(parseListeners(win, "win32"), [
    { host: "127.0.0.1", port: 7899 },
    { host: "127.0.0.1", port: 18791 },
  ]);
  const mac = ["p1234", "nTCP", "n127.0.0.1:7899", "n[::1]:8080", "n*:61000"].join("\n");
  assert.deepEqual(parseListeners(mac, "darwin"), [
    { host: "127.0.0.1", port: 7899 },
    { host: "127.0.0.1", port: 61000 },
  ]);
  const linux = ["State Recv-Q Send-Q Local Address:Port Peer Address:Port", "LISTEN 0 4096 0.0.0.0:7899 0.0.0.0:*", "LISTEN 0 128 10.1.2.3:5432 0.0.0.0:*"].join("\n");
  assert.deepEqual(parseListeners(linux, "linux"), [{ host: "127.0.0.1", port: 7899 }]);
});

await check("probeHttpProxy：CONNECT 回 200 / 407 算代理，别的与哑端口都不算", async () => {
  const net = await import("node:net");
  const answer = (reply) =>
    new Promise((resolve) => {
      const server = net.createServer((socket) => {
        socket.once("data", () => socket.end(reply));
        socket.on("error", () => {});
      });
      server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
  const ok = await answer("HTTP/1.1 200 Connection established\r\n\r\n");
  const auth = await answer("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
  const notProxy = await answer("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
  try {
    assert.equal(await probeHttpProxy("127.0.0.1", ok.port, 1_000), true, "200 要算代理");
    assert.equal(await probeHttpProxy("127.0.0.1", auth.port, 1_000), true, "407 也证明它是代理");
    assert.equal(await probeHttpProxy("127.0.0.1", notProxy.port, 1_000), false, "普通 HTTP 服务不算");
    assert.equal(await probeHttpProxy("127.0.0.1", 1, 500), false, "没人听就是 false");
  } finally {
    for (const s of [ok.server, auth.server, notProxy.server]) s.close();
  }
});

await check("discoverLocalProxies：只交回探测通过的，按端口序，可限额，探挂了也不崩", async () => {
  const listeners = [
    { host: "127.0.0.1", port: 9001 },
    { host: "127.0.0.1", port: 7899 },
    { host: "127.0.0.1", port: 9002 },
  ];
  const probe = async (_host, port) => {
    if (port === 9002) throw new Error("连接被拒");
    return port === 7899;
  };
  assert.deepEqual(await discoverLocalProxies({ listeners: () => listeners, probe }), ["http://127.0.0.1:7899"]);
  assert.deepEqual(await discoverLocalProxies({ listeners: () => listeners, probe, limit: 2 }), ["http://127.0.0.1:7899"]);
  assert.deepEqual(await discoverLocalProxies({ listeners: () => [], probe }), []);
});

await check("viaRoutes：直连就通时不探本机；直连挂了才探，并且用上探到的代理", async () => {
  let discovered = 0;
  const okDirect = await viaRoutes(async () => ({ ok: true, value: "ok" }), {
    proxies: () => [],
    discover: async () => {
      discovered += 1;
      return ["http://127.0.0.1:7899"];
    },
  });
  assert.equal(okDirect.ok, true);
  assert.equal(discovered, 0, "直连就通时不该花时间去 netstat");

  const used = [];
  const viaProbe = await viaRoutes(
    async (e) => {
      used.push(e.HTTPS_PROXY ?? "直连");
      return e.HTTPS_PROXY === "http://127.0.0.1:7899" ? { ok: true, value: "值" } : { ok: false, err: "Connection was reset" };
    },
    {
      proxies: () => [],
      discover: async () => ["http://127.0.0.1:7899"],
      plan: { attempts: 1, retryMs: 0, budgetMs: 30_000 },
    },
  );
  assert.deepEqual(used, ["直连", "http://127.0.0.1:7899"]);
  assert.equal(viaProbe.ok, true);
  assert.equal(viaProbe.route, "现探的代理 http://127.0.0.1:7899");
});

await check("viaRoutes：现探到的与已配的重复时不重复试，探挂了不影响错误汇总", async () => {
  const used = [];
  const res = await viaRoutes(
    async (e) => {
      used.push(e.HTTPS_PROXY ?? "直连");
      return { ok: false, err: "不通" };
    },
    {
      proxies: () => ["http://127.0.0.1:7899"],
      discover: async () => ["http://127.0.0.1:7899", "http://127.0.0.1:7000"],
      plan: { attempts: 1, retryMs: 0, budgetMs: 30_000 },
    },
  );
  assert.deepEqual(used, ["直连", "http://127.0.0.1:7899", "http://127.0.0.1:7000"], "已配过的那条不该再来一遍");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "直连：不通；代理 http://127.0.0.1:7899：不通；代理 http://127.0.0.1:7000：不通");

  const boom = await viaRoutes(async () => ({ ok: false, err: "不通" }), {
    proxies: () => [],
    discover: async () => {
      throw new Error("netstat 不在");
    },
    plan: { attempts: 1, retryMs: 0, budgetMs: 30_000 },
  });
  assert.equal(boom.ok, false);
  assert.equal(boom.reason, "直连：不通");
});

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
