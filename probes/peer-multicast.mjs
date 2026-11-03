/**
 * 骨架闸门：#45 的组播发现到底能不能用。
 *
 * 不是给 CI 的断言，是给「公司交换机放不放行 239.255.42.99」这个问题的本机快检：
 * 同一个进程起两份 Discovery（同绑组播端口、reuseAddr），互发 announce，看对方收没收到。
 *
 * 用法：node probes/peer-multicast.mjs [组播地址] [端口] [超时秒]
 *   通过 → 打印 ok 并退出 0（只能证明「本机网络栈放行」，穿过交换机的那一半要两台真机验）
 *   不通过 → 打印没收到并退出 1
 */
import dgram from "node:dgram";

const GROUP = process.argv[2] || "239.255.42.99";
const PORT = Number(process.argv[3] || 7866);
const TIMEOUT = Number(process.argv[4] || 5) * 1000;
const HELLO = { proto: 1, t: "hello", nodeId: "probe-a", port: 0 };

const a = dgram.createSocket({ type: "udp4", reuseAddr: true });
const b = dgram.createSocket({ type: "udp4", reuseAddr: true });
const got = [];
let down = 0;
const close = () => (down ? null : (down = 1, a.close(), b.close()));
const timer = setTimeout(() => {
  console.log(got.length ? `ok：收到 ${got.length} 条（${got.join(" / ")}）` : "没收到组播——这台机器不放行，只能走手动地址");
  close();
  process.exit(got.length ? 0 : 1);
}, TIMEOUT);

for (const sock of [a, b]) {
  sock.on("error", (err) => {
    console.log(`socket 出错：${err.message}`);
    close();
    process.exit(2);
  });
}
b.on("message", (buf, rinfo) => {
  got.push(`${rinfo.address}:${rinfo.port} ${buf.toString("utf8").slice(0, 40)}`);
});
a.bind(PORT, () => {
  a.addMembership(GROUP);
  b.bind(PORT, () => {
    b.addMembership(GROUP);
    // 让内层 socket 先就位再发，否则第一条会丢。
    setTimeout(() => a.send(JSON.stringify(HELLO), PORT, GROUP), 100);
  });
});
