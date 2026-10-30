# cloudflared quick tunnel（trycloudflare）本机验证报告

- 探针日期：2026-10-30（本机时间 23:12–23:20）
- 机器：Windows + MSYS bash，用户目录 `C:\Users\GG_Bond`
- 目标端口：`127.0.0.1:7864`（临时用 node 静态服务占用，返回 `ok-from-7864`）
- 结论：**可行**。quick tunnel 在本机可用，`curl` 拿到源站内容。但有两个硬坑：出网要走本地代理、Windows 上必须 `taskkill /F` 才能停。

---

## 1. 可执行文件与版本

安装前确实没有：`where cloudflared` 返回 `信息: 用提供的模式无法找到文件`（exit 1），
`WinGet\Packages` 下无 cloudflare 目录，`winget list --id Cloudflare.cloudflared` 提示
`找不到与输入条件匹配的已安装程序包`。

安装方式：winget（**必须带代理环境变量**，它要从 GitHub Releases 拉 MSI）：

```bash
export HTTPS_PROXY=http://127.0.0.1:18791 HTTP_PROXY=http://127.0.0.1:18791
winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements --silent
```

输出确认：下载 `https://github.com/cloudflare/cloudflared/releases/download/2026.10.6/cloudflared-windows-amd64.msi`
→ `已成功验证安装程序哈希` → `已成功安装`（EXIT=0）。

**最终绝对路径**（注意是 `Program Files (x86)`，不是 `Program Files`，也不是 `WinGet\Packages`）：

```text
C:\Program Files (x86)\cloudflared\cloudflared.exe
```

```bash
$ "/c/Program Files (x86)/cloudflared/cloudflared.exe" --version
cloudflared version 2026.10.6 (built 2026-10-29T04:55 UTC)
```

- 文件大小 55,390,656 字节。
- MSI 已把 `C:\Program Files (x86)\cloudflared\` 写进**机器级 PATH**，但**当前已开的 shell 不会热更新** ——
  装完立刻 `where cloudflared` 仍然找不到，需要新开终端。实现方**不要依赖 PATH**，直接用绝对路径。
- 注册表卸载项：`MsiExec.exe /I{1AF16193-7422-494D-81A7-A87DC9E61668}`（DisplayName `cloudflared`，DisplayVersion `2026.10.6`）。

## 2. 流：URL 打在 **stderr**，不是 stdout

连续 4 次启动，把 stdout / stderr 分别重定向到两个文件，结果：

```text
cf.out.log   0 bytes     <- stdout 全程 0 字节
cf2.out.log  0 bytes
cf3.out.log  0 bytes
cf4.out.log  0 bytes
cf5.out.log  0 bytes
```

**cloudflared 的所有日志（包括 URL 横幅）全部走 stderr；stdout 一个字节都没有。**
实现方必须读 stderr，只接 stdout 会永远拿不到 URL。

## 3. 分配 URL 那行的完整原文

`cat -A` 与 `od -c` 双重确认：**框线是纯 ASCII 的 `+` `-` `|`，没有任何 Unicode 制表符**；
每行定长 **119 字符**（不含 `\n`），`|` 后面是**两个空格**，URL 后面是一串空格补齐到 `|`。

完整 4 行横幅（原文照抄，含行尾空格；日志前缀是 `YYYY-MM-DDTHH:MM:SSZ INF `，共 25 字符）：

```text
2026-10-30T15:13:28Z INF +--------------------------------------------------------------------------------------------+
2026-10-30T15:13:28Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-10-30T15:13:28Z INF |  https://hospital-sixth-accessing-eventually.trycloudflare.com                             |
2026-10-30T15:13:28Z INF +--------------------------------------------------------------------------------------------+
```

**关键行（这一行就是交付物）**：

```text
2026-10-30T15:13:28Z INF |  https://hospital-sixth-accessing-eventually.trycloudflare.com                             |
```

结构拆解（25 + 1 + 2 + 61 + 29 + 1 = 119）：

| 段 | 内容 |
| --- | --- |
| 25 字符 | `2026-10-30T15:13:28Z INF ` |
| 1 字符 | `\|` |
| 2 空格 | `  ` |
| 61 字符 | `https://hospital-sixth-accessing-eventually.trycloudflare.com` |
| 29 空格 | 补齐到行宽 |
| 1 字符 | `\|` |

### 建议的正则

主推（对 `|` 前的两个空格做锚定，不会误抓别处的 URL）：

```text
/\|\s{1,}(https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com)\s{0,}\|/
```

- 抓 group 1 即 URL。`\s{1,}` 容忍 1 个或多个空格（未来宽度变化不炸）。
- **不要**锚定行尾 `$` —— 后面有 29 个空格 + `|`。
- **不要**用不带首尾约束的 `https?://[^.\s]*\.trycloudflare\.com`，否则会误抓 `https://api.trycloudflare.com`
  （失败时日志里会有 `Post "https://api.trycloudflare.com/tunnel": context deadline exceeded`。
  我在探针里就踩到了：拿它去 curl 一直被解析成 `https://api.trycloudflare.com`，返回 405，白折腾一轮）。

兜底正则（不断言框线，但用「子域至少含一个连字符」排除 `api`）：

```text
/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/
```

URL 形态固定：**3~4 个英文小写单词用 `-` 连成的子域 + `.trycloudflare.com`**，纯小写。实例：

```text
https://hospital-sixth-accessing-eventually.trycloudflare.com
https://dem-chemical-cove-valve.trycloudflare.com
https://jim-heating-vienna-competitors.trycloudflare.com
```

> **每次启动 URL 都不同**，不可缓存/复用。重启进程 = 换域名。

## 4. 时间线（启动 → URL → 可用）

同一脚本内用 `date +%s%3N` 打点，两次独立测量：

| 事件 | 运行 A | 运行 B |
| --- | --- | --- |
| 进程启动 | t=0 | t=0 |
| **URL 横幅出现** | **6381 ms** | **6896 ms** |
| Tunnel connection 注册（`Registered tunnel connection ... protocol=quic`） | ~5.5 s | ~5.4 s |
| **首次 `curl` 返回 200（源站内容）** | **18400 ms** | **20135 ms** |

- **URL 出现后还要再等 ~11–13 秒才真正可用**，总时长按 **~20 秒** 规划。
- 未就绪期间**不是** 502/1033，而是 **TCP/TLS 层直接连不上，`curl` 返回 `code=000`、
  `errormsg="Connection timed out after 8005 milliseconds"`**（域名还没在边缘路由好）。
  所以重试判据是「没拿到 200 就一直重试」，不要只等 502。
- 就绪后响应稳定在 2.3–2.9 s（首包略慢，Cloudflare 边缘 HKG/lax 回落）。

## 5. 可达性验证（curl 实际输出）

```bash
$ URL=$(sed -n 's/.*|  \(https:\/\/[a-z0-9-]\+\.trycloudflare\.com\).*/\1/p' cf2.err.log | head -1)
$ echo $URL
https://hospital-sixth-accessing-eventually.trycloudflare.com

$ curl -s -m 20 "$URL/"
ok-from-7864

[code=200 total=2.917095s]
```

再连打两次：

```text
--- attempt 2 ---  ok-from-7864   [code=200 total=2.332875s]
--- attempt 3 ---  ok-from-7864   [code=200 total=2.414881s]
```

返回体正是 7864 上 node 服务写的 `ok-from-7864`，隧道端到端打通。

**隧道死掉后的行为**（杀掉 cloudflared 后立刻 curl 同一 URL）：

```text
code=530 size=5994 time=5.427041
页面 title: Cloudflare Tunnel error | <子域>.trycloudflare.com | Cloudflare
页面内 marker: errorCode:1033
```

→ 检测「隧道已断」的正确判据是 **HTTP 530**（body 里 `errorCode:1033`），不是 502、不是 404。

## 6. 授权 / --no-autoupdate / 进程行为

**不需要任何授权或登录。** 全程没有打开浏览器、没有 `Please open the following URL`、
没有 device-code 提示。日志原文：

```text
INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.
```

`Cannot determine default configuration path. No file [config.yml config.yaml] in [~/.cloudflared ~/.cloudflare-warp ~/cloudflare-warp]` 属正常噪音，不建配置文件也能跑。

**`--no-autoupdate`：Windows 上是空操作，不需要加。** 日志明说：

```text
INF cloudflared will not automatically update on Windows systems.
```

该 flag 本身存在（`cloudflared tunnel --help` 里有 `--no-autoupdate  Disable periodic check for updates...`），
跨平台代码加上无害，但本机无需。

其它观察：

- 生效配置：`Settings: map[ha-connections:1 protocol:quic url:http://127.0.0.1:7864]`
- **cloudflared 会额外监听一个本地 metrics 端口**，本机实测拿到 `127.0.0.1:20241`（Prometheus 指标）。
  `--metrics` 的帮助原文：`If no address is passed cloudflared will try to bind to [localhost:20241 localhost:20242 localhost:20243 localhost:20244 localhost:20245]. If all are unavailable, a random port will be used.`
  —— 所以同时跑多个隧道不会硬冲突（依次退到 20242、20243…），但会占用 127.0.0.1 上的连续端口，实现方若做端口白名单要留意。
- 启动 ~10 s 后会打一段 `CONNECTIVITY PRE-CHECKS`（不阻塞，属事后体检）；本机实测出现过
  `UDP Connectivity ... region2 ... status=fail` → `suggested_protocol=http2`，但隧道照常工作。
- 除 `Cannot determine default configuration path` 之外还有一条
  `cloudflared does not support loading the system root certificate pool on Windows. Please use --origin-ca-pool <PATH> ...`，不影响 quick tunnel。

## 7. 清理确认

```bash
$ tasklist | grep -i cloudflared
NONE
$ netstat -ano | grep -E ':7864\s' | grep -i listening
NO LISTENER (only TIME_WAIT may remain)
$ netstat -ano | grep 20241
NONE
$ curl -s -m 5 --noproxy '*' -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7864/
000        # curl exit=7 (connection refused) —— 端口已释放
$ where cloudflared  # 新 shell 里才会命中，老 shell 仍旧找不到
```

进程与端口均已回收，`127.0.0.1:7864` 只剩内核的 TIME_WAIT 条目，没有 LISTENING。

## 8. 踩到的坑（按重要性）

1. **URL 在 stderr，stdout 恒为 0 字节。** 只接 stdout 的实现永远拿不到地址。
2. **Windows 上 `taskkill /IM cloudflared.exe`（不带 `/F`）会失败**：
   `只能强制终止此进程(带 /F 选项)`。退出必须 `taskkill /F /PID <pid>` 或 `taskkill /F /IM cloudflared.exe`。
   我这轮就因此漏了两个进程（12456 / 32460），第二个还把 20241 端口占了。
3. **cloudflared 不会自己退出。** 失败时（见坑 4）会退出；成功时则常驻，不会因为「没人访问」而收摊。必须自己管生命周期。
4. **quick tunnel 创建请求失败时 cloudflared 直接退出，不重试。** 日志：
   `failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`，
   随后进程消失。实现方必须在**进程层**做重试（重新拉起 + 重新解析 URL，URL 会换）。
5. **本机出网不稳定，必须考虑代理**：直连 `api.trycloudflare.com` 时好时坏 ——
   同一台机器上，一次 `curl -m 10 https://api.trycloudflare.com/tunnel` 返回 `code=000 exit=35`（TLS 失败），
   另一次（几分钟后）`-X POST` 直连返回 `200`（time=5.16 s）；带 `-x http://127.0.0.1:18791` 则稳定 `200`（time=3.4 s）。
   第一次启动就是因为没带代理而超时失败。**建议实现方启动 cloudflared 时注入
   `HTTPS_PROXY=http://127.0.0.1:18791`**（端口读 `BILLION_CONTEXT_PROXY`，先 curl 验 200 再用）。
   注意：QUIC 隧道走 UDP，不走 HTTP 代理；本机 UDP 7844 直连是通的（precheck `UDP Connectivity ... QUIC connection successful`），
   所以「代理只用于 API 那一步」是成立的。
6. **验证用的 curl 不要走代理。** 代理对 `*.trycloudflare.com` 能建 CONNECT，但会把请求打到别处/返回 405，
   把「隧道已就绪」误判成失败。验证时加 `--noproxy '*'`，或从子进程环境里剔除 `HTTPS_PROXY`。
7. **宽松正则抓错 URL。** `grep -o 'https://[a-z0-9-]*\.trycloudflare\.com'` 会先命中失败日志里的
   `https://api.trycloudflare.com`，于是我一直去 curl `api.trycloudflare.com`，拿到 405
   `{"success":false,"errors":[{"code":10005,"message":"Method Not Allowed"}]}`，白折腾一轮。
   用第 3 节的框线锚定正则。
8. **MSYS 的 `/tmp` 不可靠**：`mkdir -p /tmp/cfprobe` 成功，但紧随的 `cd /tmp/cfprobe` 报
   `No such file or directory`（每次 bash 调用的 TMPDIR 指向不同）。探针工作目录一律放真实路径，
   我用的是 `./probes/_run`。
9. **`bc` 未安装**（`./poll.sh: line 22: bc: command not found`，导致计时全变成 `[t=s]`）。
   计时用 `date +%s%3N` 做整数减法。
10. 安装落在 `Program Files (x86)` 而非 `Program Files`，`WinGet\Packages` 下也没有实体目录 ——
    装完 `where cloudflared` 找得到要靠新 shell 的 PATH；找不到时靠注册表卸载项或
    `Get-ChildItem -Filter cloudflared*.exe -Recurse` 定位。
11. **`--url` 与 ingress 规则互斥**：
    用 `--url` 时 `--proxy-*` 系列才生效；本机只用 `--url` 足够。

## 9. 给实现方的落地清单

```text
exe:      C:\Program Files (x86)\cloudflared\cloudflared.exe   (2026.10.6)
args:     tunnel --url http://127.0.0.1:7864
env:      HTTPS_PROXY / HTTP_PROXY = http://127.0.0.1:18791（可选；本机强烈建议）
读取流:   stderr（stdout 恒空）
解析:     /\|\s{1,}(https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com)\s{0,}\|/
超时预算: 等 URL 15 s；等首个 200 30 s（实测 6.4 s + 12 s）
就绪判据: curl --noproxy '*' 返回 200 且 body 匹配源站内容
失败判据: HTTP 530 + body 内含 "errorCode:1033"
失败重试: 整个进程重拉（cloudflared 不自我重试，且 URL 会变）
停止:     taskkill /F /PID <pid>   （不带 /F 无效）
副作用:   额外占用 127.0.0.1:20241/metrics
无需:     浏览器授权 / --no-autoupdate
```
