/**
 * #266 本机管理：桥端纯函数的单测——不跑 PowerShell、不碰真网卡。
 *
 *   node --experimental-transform-types bridge/tests/sysmanage-unit.mjs
 */
import assert from "node:assert/strict";
import { normalizeAdapters, normalizeNodeInterfaces, normalizeServices, normalizeWinnat, parseNetstat } from "../src/sysmanage.ts";

// ------------------------------------------------- ① netstat 解析

const netstat = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:135      0.0.0.0:0       LISTENING      1432
  TCP    127.0.0.1:7864   0.0.0.0:0       LISTENING      5678
  TCP    [::]:445         [::]:0          LISTENING      4
  TCP    10.6.2.241:139   10.6.2.5:50000  ESTABLISHED    4
  UDP    0.0.0.0:5353     *:*                            1234
  UDP    127.0.0.1:1900   *:*                            999
  UDP    [::]:3702        *:*                            4321
  UDP    0.0.0.0:5353     *:*                            1234
`;

const ports = parseNetstat(netstat);
assert.equal(ports.length, 6, "只收 TCP LISTENING 与 UDP；重复的 UDP 行去重");
assert.deepEqual(
  ports.map((p) => `${p.proto}:${p.local}:${p.port}:${p.pid}:${p.scope}`),
  [
    "tcp:0.0.0.0:135:1432:all",
    "tcp:127.0.0.1:7864:5678:loopback",
    "tcp::::445:4:all",
    "udp:0.0.0.0:5353:1234:all",
    "udp:127.0.0.1:1900:999:loopback",
    "udp::::3702:4321:all",
  ],
  "地址/端口/PID/范围都要对；IPv6 的 [::] 去掉方括号",
);

// ------------------------------------------------- ② 网卡合并

const adapters = normalizeAdapters(
  [
    {
      InterfaceIndex: 15,
      NetConnectionID: "Ethernet",
      Description: "Intel(R) Ethernet",
      MACAddress: "aa:bb:cc:dd:ee:ff",
      GUID: "{G-15}",
      NetConnectionStatus: 2,
    },
    {
      InterfaceIndex: 19,
      NetConnectionID: "vSwitch",
      Description: "Hyper-V",
      MACAddress: "00:15:5d:00:00:01",
      GUID: "{G-19}",
      NetConnectionStatus: 7,
    },
    { InterfaceIndex: 99, NetConnectionID: null, Description: "hidden", GUID: "{G-99}", NetConnectionStatus: 2 },
  ],
  [
    {
      InterfaceIndex: 15,
      IPAddress: ["10.6.2.241", "fe80::1"],
      IPSubnet: ["255.255.252.0", "64"],
      DefaultIPGateway: ["10.6.1.1"],
      DNSServerSearchOrder: ["223.5.5.5"],
      DHCPEnabled: false,
      IPConnectionMetric: 10,
    },
    {
      InterfaceIndex: 19,
      IPAddress: ["172.22.224.1"],
      IPSubnet: ["255.255.240.0"],
      DefaultIPGateway: ["172.22.224.1"],
      DNSServerSearchOrder: [],
      DHCPEnabled: false,
      IPConnectionMetric: 1,
    },
  ],
);

assert.equal(adapters.length, 2, "NetConnectionID 为空的隐藏适配器不要");
assert.equal(adapters[0].name, "Ethernet", "有默认路由的排第一");
assert.equal(adapters[0].default, true);
assert.equal(adapters[0].mask.length, 1, "IPSubnet 里的 IPv6 前缀长度 64 不能当掩码");
assert.equal(adapters[0].mask[0], "255.255.252.0");
assert.deepEqual(adapters[0].ipv4, ["10.6.2.241"], "只留 IPv4");
assert.equal(adapters[0].mac, "AA:BB:CC:DD:EE:FF", "MAC 转大写");
assert.equal(adapters[0].status, "up");
assert.equal(adapters[1].status, "disconnected");
assert.equal(adapters[1].default, false, "断开的网卡即使 metric 更小也不能当默认路由");

// ------------------------------------------------- ③ 服务归类

const services = normalizeServices([
  {
    Name: "ClickToRunSvc",
    DisplayName: "Microsoft Office Click-to-Run Service",
    State: "Running",
    StartMode: "Auto",
    ProcessId: 100,
    PathName: "C:\\Program Files\\Common Files\\microsoft shared\\ClickToRun\\OfficeClickToRun.exe",
  },
  {
    Name: "DellClientManagementService",
    DisplayName: "Dell Client Management Service",
    State: "Running",
    StartMode: "Auto",
    ProcessId: 200,
    PathName: "C:\\Program Files (x86)\\Dell\\UpdateService\\ServiceShell.exe",
  },
  {
    Name: "Schedule",
    DisplayName: "Task Scheduler",
    State: "Running",
    StartMode: "Auto",
    ProcessId: 300,
    PathName: "C:\\WINDOWS\\system32\\svchost.exe -k netsvcs",
  },
  {
    Name: "EmptyPath",
    DisplayName: "Mystery",
    State: "Stopped",
    StartMode: "Manual",
    ProcessId: null,
    PathName: null,
  },
]);

const byName = new Map(services.map((s) => [s.name, s]));
assert.equal(byName.get("ClickToRunSvc")?.microsoft, true, "Common Files\\microsoft shared 也算 Microsoft");
assert.equal(byName.get("DellClientManagementService")?.microsoft, false, "Dell 是第三方");
assert.equal(byName.get("Schedule")?.microsoft, true, "system32 算 Microsoft");
assert.equal(byName.get("EmptyPath")?.microsoft, true, "没有路径的当成 Microsoft，默认列表不展示");
assert.equal(byName.get("EmptyPath")?.pid, null, "PID 0 / 负数要归 null");
assert.deepEqual(
  services.map((s) => s.display),
  ["Dell Client Management Service", "Microsoft Office Click-to-Run Service", "Mystery", "Task Scheduler"],
  "按显示名排序",
);

// ------------------------------------------------- ⑤ 非 Windows 网卡

const nodeAdapters = normalizeNodeInterfaces([
  [
    "en0",
    [
      { address: "192.168.1.5", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.1.5/24", scopeid: 0 },
      { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "fe80::1/64", scopeid: 1 },
    ],
  ],
  [
    "lo0",
    [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8", scopeid: 0 }],
  ],
  ["empty", undefined],
]);
assert.deepEqual(nodeAdapters.map((a) => a.name), ["en0", "lo0"], "按名称排序，跳过没有地址的接口");
assert.deepEqual(nodeAdapters[0].ipv4, ["192.168.1.5"], "只收 IPv4");
assert.deepEqual(nodeAdapters[0].mask, ["255.255.255.0"], "保留掩码");
assert.equal(nodeAdapters[0].mac, "aa:bb:cc:dd:ee:ff", "保留 MAC");
assert.equal(nodeAdapters[0].status, "up");
assert.equal(nodeAdapters[0].dhcp, false, "非 Windows 不猜 DHCP");
assert.equal(nodeAdapters[1].mac, "", "全零 MAC 不显示");
assert.equal(nodeAdapters[1].status, "up");

// ------------------------------------------------- WinNAT 状态

assert.deepEqual(normalizeWinnat({ status: "Running", start: "Manual" }), { status: "Running", start: "Manual" });
assert.deepEqual(normalizeWinnat({ status: "Stopped" }), { status: "Stopped", start: "" }, "缺启动类型就空串");
assert.equal(normalizeWinnat(null), null, "没有 winnat 服务 → null");
assert.equal(normalizeWinnat({ status: 4 }), null, "枚举数字不收（脚本必须转字符串）");

console.log(`sysmanage-unit: ok — ${ports.length} 个端口 / ${adapters.length} 张网卡 / ${services.length} 个服务`);
