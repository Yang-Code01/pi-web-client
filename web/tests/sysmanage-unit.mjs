/**
 * #266 本机管理：前端纯函数单测——DNS 预设/解析、端口过滤、服务过滤、格式化。
 *
 *   node web/tests/sysmanage-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DNS_PRESETS,
  clockText,
  countdownOf,
  filterServices,
  formatBytes,
  formatCountdown,
  formatDuration,
  parseDnsInput,
  parseHours,
  presetOf,
  sameServers,
  serviceStartLabel,
  serviceStatusLabel,
  targetText,
  uptimeParts,
  visiblePorts,
  weekdayOf,
  workdayName,
  workedPercent,
} from "../src/sysmanage-model.ts";

test("DNS 预设：公司在前，全部是 IPv4", () => {
  assert.equal(DNS_PRESETS[0].id, "corp");
  assert.equal(DNS_PRESETS[0].servers[0], "172.28.1.23");
  for (const preset of DNS_PRESETS) {
    assert.ok(preset.servers.length > 0);
    for (const server of preset.servers) assert.match(server, /^\d{1,3}(\.\d{1,3}){3}$/);
  }
});

test("presetOf：空 = DHCP，命中 = 预设 id，对不上 = custom", () => {
  assert.equal(presetOf([]), "dhcp");
  assert.equal(presetOf(["223.5.5.5"]), "ali");
  assert.equal(presetOf(["8.8.8.8", "1.1.1.1"]), "custom");
  assert.equal(sameServers(["1.1.1.1"], ["1.1.1.1"]), true);
  assert.equal(sameServers(["1.1.1.1"], ["1.1.1.1", "8.8.8.8"]), false);
});

test("parseDnsInput：逗号/空格/分号都认，去重，最多 3 个", () => {
  assert.deepEqual(parseDnsInput("223.5.5.5 119.29.29.29"), {
    ok: true,
    servers: ["223.5.5.5", "119.29.29.29"],
  });
  assert.deepEqual(parseDnsInput("1.1.1.1,1.1.1.1;8.8.8.8"), { ok: true, servers: ["1.1.1.1", "8.8.8.8"] });
  assert.equal(parseDnsInput("   ").ok, false);
  assert.equal(parseDnsInput("999.1.1.1").ok, false);
  assert.equal(parseDnsInput("1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4").ok, false, "超过 3 个要拒绝");
});

const port = (over = {}) => ({
  proto: "tcp",
  local: "0.0.0.0",
  port: 80,
  pid: 100,
  process: "",
  scope: "all",
  ...over,
});

test("visiblePorts：默认隐藏回环，对外/桥自身两个筛选", () => {
  const ports = [
    port({ port: 80, scope: "all" }),
    port({ port: 7864, local: "127.0.0.1", scope: "loopback", pid: 5678 }),
    port({ port: 7864, local: "10.6.2.241", scope: "nic", pid: 5678 }),
  ];
  const base = { showLoopback: false, filter: "all", bridgePid: 5678, bridgePort: 7864 };
  assert.deepEqual(
    visiblePorts(ports, base).map((p) => p.port),
    [80, 7864],
    "回环那条不显示，但 nic 那条还在",
  );
  assert.deepEqual(
    visiblePorts(ports, { ...base, filter: "external" }).map((p) => p.port),
    [80, 7864],
    "对外 = 非回环",
  );
  assert.deepEqual(
    visiblePorts(ports, { ...base, filter: "bridge" }).map((p) => p.pid),
    [5678, 5678],
    "桥自身按 pid 或端口命中",
  );
  assert.equal(visiblePorts(ports, { ...base, showLoopback: true, filter: "all" }).length, 3);
});

const service = (over = {}) => ({
  name: "svc",
  display: "Some Service",
  state: "Running",
  start: "Auto",
  pid: 100,
  path: "C:\\Program Files\\Some\\svc.exe",
  microsoft: false,
  ...over,
});

test("filterServices：默认只看非 Microsoft 且运行中；搜索 name/display/PID", () => {
  const rows = [
    service(),
    service({ name: "WinSvc", display: "Windows Update", microsoft: true }),
    service({ name: "StoppedSvc", display: "Old", state: "Stopped" }),
    service({ name: "Dell", display: "Dell Client Management Service", pid: 200 }),
  ];
  const base = { showMicrosoft: false, showStopped: false, query: "" };
  assert.deepEqual(
    filterServices(rows, base).map((s) => s.name),
    ["svc", "Dell"],
  );
  assert.deepEqual(
    filterServices(rows, { ...base, showMicrosoft: true }).map((s) => s.name),
    ["svc", "WinSvc", "Dell"],
  );
  assert.deepEqual(filterServices(rows, { ...base, showStopped: true }).map((s) => s.name), ["svc", "StoppedSvc", "Dell"]);
  assert.deepEqual(filterServices(rows, { ...base, query: "dell" }).map((s) => s.name), ["Dell"]);
  assert.deepEqual(filterServices(rows, { ...base, query: "200" }).map((s) => s.name), ["Dell"]);
});

test("格式化：GiB 口径、开机拆分", () => {
  assert.equal(formatBytes(34033348608), "31.7 GB");
  assert.equal(formatBytes(255175761920), "238 GB");
  assert.equal(formatBytes(0), "0 GB");
  assert.deepEqual(uptimeParts(4 * 86_400 + 19 * 3_600 + 52 * 60), { days: 4, hours: 19, minutes: 52 });
  assert.deepEqual(uptimeParts(-5), { days: 0, hours: 0, minutes: 0 });
});

test("WinNAT 状态文案：认得的翻译，认不出的原样", () => {
  assert.equal(serviceStatusLabel("Running"), "运行中");
  assert.equal(serviceStatusLabel("Stopped"), "已停止");
  assert.equal(serviceStatusLabel("Weird"), "Weird");
  assert.equal(serviceStartLabel("Manual"), "手动");
  assert.equal(serviceStartLabel(""), "");
});

test("上下班：倒计时大字 `HH:MM:SS`，过点加 `+`", () => {
  assert.equal(formatCountdown(2 * 3_600_000 + 13 * 60_000 + 7_000), "02:13:07");
  assert.equal(formatCountdown(0), "00:00:00");
  assert.equal(formatCountdown(-65_000), "+00:01:05");
  assert.equal(formatCountdown(-3_600_000), "+01:00:00");
  assert.deepEqual(countdownOf(1_500), { hours: 0, minutes: 0, seconds: 1, overtime: false });
  assert.equal(countdownOf(-1).overtime, true);
});

test("上下班：已工作工时先说小时，不足一小时说分秒", () => {
  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatDuration(-5), "0 秒");
  assert.equal(formatDuration(90_000), "1 分 30 秒");
  assert.equal(formatDuration(10 * 3_600_000), "10 小时 00 分");
  assert.equal(formatDuration(3_600_000 + 5 * 60_000 + 59_000), "1 小时 05 分");
});

test("上下班：进度条按目标工时算，封顶 100、不倒扣", () => {
  assert.equal(workedPercent(4.5 * 3_600_000, 9), 50);
  assert.equal(workedPercent(20 * 3_600_000, 9), 100);
  assert.equal(workedPercent(-1, 9), 0);
  assert.equal(workedPercent(3_600_000, 0), 0);
});

test("上下班：工时输入夹在 0.5–24，取 0.5 步长，逗号也认", () => {
  assert.equal(parseHours("9"), 9);
  assert.equal(parseHours(" 8,5 "), 8.5);
  assert.equal(parseHours("8.24"), 8);
  assert.equal(parseHours("7.26"), 7.5);
  assert.equal(parseHours("0.4"), null);
  assert.equal(parseHours("24.4"), null);
  assert.equal(parseHours(""), null);
  assert.equal(parseHours("abc"), null);
  assert.equal(parseHours("24"), 24);
  assert.equal(parseHours("0.5"), 0.5);
});

test("上下班：日期键换星期用本地分量，不受 UTC 偏移影响", () => {
  assert.equal(weekdayOf("2026-11-13"), "周五");
  assert.equal(weekdayOf("2026-11-15"), "周日");
  assert.equal(weekdayOf(""), "");
  assert.equal(weekdayOf("2026-13-40"), "");
  assert.equal(workdayName(1), "周一");
  assert.equal(workdayName(0), "周日");
  assert.equal(workdayName(7), "");
});

test("上下班：时刻文本带前导零", () => {
  assert.equal(clockText(new Date(2026, 10, 13, 9, 7).getTime()), "09:07");
  assert.equal(clockText(new Date(2026, 10, 13, 18, 0).getTime()), "18:00");
});

test("上下班：目标时刻跨过零点就标「明天」", () => {
  const now = new Date(2026, 10, 13, 23, 37).getTime();
  assert.equal(targetText(new Date(2026, 10, 13, 18, 0).getTime(), now), "18:00");
  assert.equal(targetText(new Date(2026, 10, 14, 5, 37).getTime(), now), "明天 05:37");
  assert.equal(targetText(new Date(2026, 10, 15, 1, 0).getTime(), now), "明天 01:00");
});
