# 给邮箱面板配好 Microsoft 登录（Entra 应用注册）

邮箱面板里选 **Outlook（个人账号）** 或 **Microsoft 365（公司 / 学校）** 时，认证只能走 Microsoft 登录（OAuth）——微软已经关掉了这两类信箱的 IMAP/SMTP 基础认证，应用密码也不行（D281）。桥不需要内置任何密钥，用的是**你自己在 Microsoft Entra 里注册的一个公共客户端应用**。

下面这套步骤只需要做一次，十分钟以内，全部在浏览器里点。你没有权限做某一步时会写清该找谁。

---

## 一、注册应用

1. 打开 <https://entra.microsoft.com>，左侧 **Applications → App registrations**（或直接搜 "App registrations"），点 **＋ New registration**。
2. **Name**：随便起，比如 `pi-web-client mail`。
3. **Supported account types**：
   - 公司/学校信箱只知道一个组织 → 选 **Accounts in this organizational directory only (Single tenant)**；
   - 个人 Outlook 账号，或想同时登多个组织 → 选 **Accounts in any organizational directory and personal Microsoft accounts**。
   这一步决定后面「租户」填什么（见第三节）。
4. **Redirect URI**：**留空**。设备码登录不需要回调地址，这也是选它的原因之一（D281）。
5. 点 **Register**。注册完的概览页上有一串 **Application (client) ID**，形如 `11111111-2222-3333-4444-555555555555` —— 这是要填进邮箱面板的那个。

## 二、打开设备码流

左侧 **Authentication → Advanced settings → Allow public client flows**，选 **Yes**，点 **Save**。

不开这一步，登录时会报 `AADSTS7000218` / `invalid_client`（"public client flows are not enabled"）。

## 三、加两个权限

左侧 **API permissions → ＋ Add a permission**：

1. 切到 **APIs my organization uses** 这一栏（不是 "Microsoft Graph"），搜 **Office 365 Exchange Online** → 点进去。
2. 选 **Delegated permissions**，勾上这两项：
   - `IMAP.AccessAsUser.All`
   - `SMTP.Send`
3. 点 **Add permissions**。

桥用的就是 IMAP/SMTP 这两条作用域，不需要 Microsoft Graph 的 `Mail.Read` / `Mail.Send`。

### 管理员同意

同一页上看一眼状态：如果那两项后面是绿色的「Granted for …」就没事。出现黄色「Not granted」并且登录时提示需要管理员同意（`AADSTS65001`、`AADSTS90094`）——很多公司租户禁止用户自助同意——就把这个应用和上面两条权限发给你的 IT 管理员，请他点一次 **Grant admin consent for 〈你的组织〉**。这一步只需要一次。

## 四、把两样东西填进邮箱面板

顶栏 `📮 邮箱` → **账号** → **＋ 添加账号**：

| 字段 | 填什么 |
| --- | --- |
| 地址 | 你的完整邮箱地址（`you@corp.com`） |
| 预设 | **Microsoft 365（公司 / 学校）**，个人 outlook.com 选 **Outlook** |
| 登录方式 | 只有「Microsoft 登录」，无需选择 |
| 应用（客户端）ID | 第一节复制的那串 GUID |
| 租户 | 单租户应用填 **Directory (tenant) ID**（Entra 概览页上有，也是一串 GUID，或你的域名 `corp.com`）；多租户 / 个人账号填 `common` |

点 **保存**。还是「未登录」状态的话，点行上的 **用 Microsoft 登录**：面板给你一个 8 位码和 `microsoft.com/devicelogin` 的链接，在那个页面上输码、用**你的工作账号**登一次（这一步走的就是你机器上被 IT 管着的那套浏览器会话，桥不碰你的密码和 cookie）。回来后行上会变成 `已登录 you@corp.com`。

令牌只存在桥的配置文件里（与本机授权码同级、权限 0600），页面和 AI 工具都只看得到「已登录 / 未登录」。过期前 90 秒桥自己续；被撤销（改密码、管理员撤了授权、长期不用）时会提示「需要重新用 Microsoft 登录」，再点一次即可。

---

## 常见报错对照

| 现象 / 报错 | 原因 | 怎么办 |
| --- | --- | --- |
| `AADSTS700016` / `invalid_client` | 应用 ID 打错，或租户填的不是这个应用所在的租户 | 重新复制 Application (client) ID；单租户应用填它自己的租户 ID |
| `AADSTS7000218` | 没开 public client flows | 回到第二节打开并 Save |
| `AADSTS65001` / `AADSTS90094` | 委派权限没被同意 | 让管理员 Grant admin consent |
| `AADSTS70011` / `invalid_scope` | 权限加错了 API（加到了 Microsoft Graph） | 删掉，改加 **Office 365 Exchange Online** 的两条 |
| 输码页面一直说码无效 / `AADSTS53003` | 组织的条件访问策略禁用了设备码流 | 让 IT 给这个应用开例外，或改用被允许的登录方式（本仓库目前只支持设备码） |
| 登录成功但读信回 `auth-failed` | Exchange Online 的协议被组织关掉（IMAP/SMTP 被禁） | 让管理员在 Exchange 管理中心为这个邮箱开启 IMAP / SMTP |
| `oauth-needed`（用了一阵之后） | 刷新令牌过期或被撤销 | 行上点「重新登录」 |
