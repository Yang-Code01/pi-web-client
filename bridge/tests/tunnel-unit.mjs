/**
 * D184：隧道对外地址只能来自 cloudflared 的框线横幅（D29），协议默认 http2。
 *
 *   node --experimental-transform-types bridge/tests/tunnel-unit.mjs
 */
import assert from "node:assert/strict";
import { parseTunnelUrl, tunnelArgs, tunnelProtocol } from "../src/tunnel.ts";

// ---------------------------------------------------------------- 地址解析

/** 真横幅（docs/probes/cloudflared-probe.md 照抄的那四行，行宽 119）。 */
const banner = [
  "2026-10-30T15:13:28Z INF +--------------------------------------------------------------------------------------------+",
  "2026-10-30T15:13:28Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
  "2026-10-30T15:13:28Z INF |  https://hospital-sixth-accessing-eventually.trycloudflare.com                             |",
  "2026-10-30T15:13:28Z INF +--------------------------------------------------------------------------------------------+",
].join("\n");
assert.equal(parseTunnelUrl(banner), "https://hospital-sixth-accessing-eventually.trycloudflare.com");

// 半行不算 URL（watch 里是累积 buf 再匹配的），整行才算。
assert.equal(parseTunnelUrl("|  https://licensing-seminar-custom-accurate.trycl"), null);
assert.equal(parseTunnelUrl(`|  https://licensing-seminar-custom-accurate.trycloudflare.com   |`), "https://licensing-seminar-custom-accurate.trycloudflare.com");

// 创建失败时 cloudflared 会提到 API 主机：那不是隧道地址，抓了就等于对外报一个永远 1033 的链接。
const failure = '2026-11-08T02:17:29Z ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded';
assert.equal(parseTunnelUrl(failure), null);
assert.equal(parseTunnelUrl("https://api.trycloudflare.com"), null, "裸 URL 不算，必须在框线里");

// ---------------------------------------------------------------- 协议

assert.equal(tunnelProtocol({}), "http2", "默认 http2：本机 QUIC 到边缘 10 秒就断（D184）");
assert.equal(tunnelProtocol({ PI_WEB_TUNNEL_PROTOCOL: "quic" }), "quic");
assert.equal(tunnelProtocol({ PI_WEB_TUNNEL_PROTOCOL: " HTTP2 " }), "http2");
assert.equal(tunnelProtocol({ PI_WEB_TUNNEL_PROTOCOL: "h2" }), "http2", "认不出的值回落到默认，不把垃圾参数递给 cloudflared");

const args = tunnelArgs(7864, "http2");
assert.deepEqual(args.slice(0, 2), ["tunnel", "--url"]);
assert.equal(args[2], "http://127.0.0.1:7864");
assert.ok(args.includes("--no-autoupdate"));
assert.equal(args[args.indexOf("--protocol") + 1], "http2");

console.log("tunnel-unit ok");
