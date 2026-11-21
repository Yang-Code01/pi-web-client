# pi-web-client

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[简体中文](README.md) · **English** · [日本語](README.ja.md)

> One window is the entire surface between you and the agent.

The same pi session: a terminal when you are at the desk, a browser when you are not. And everything that revolves around that session — approving a `git push`, opening a real terminal, glancing at an artifact, editing one line of config, installing an extension, logging in, updating pi itself, sending a screenshot to a colleague on the LAN, jotting down a bug you just thought of — lives in that same window too.

This is not ten features stuffed into one page. It is every **working surface** around the thing you are actually doing, gathered into one place. One window fewer means one fewer piece of state to carry around; context stops being ferried between applications by your own head, and stays where it was.

## Why one window

- **The session is the subject.** The left column is **every** pi session on disk (not tabs, not "recently opened"), the middle is the streaming conversation, the right is "things that need you". You switch the subject, not the window — and everything else stays where it was.
- **Anything the terminal can do, this window has a door to.** Approvals, a real terminal, file browsing and in-place editing, installing and toggling extensions and MCP servers, pi login, upgrading pi, reading the changelog — each has its own place, but none is its own program. One less "switch over and switch back" is one less "…what was I doing?".
- **Other devices, other people, other contexts — same window.** The phone gets the same components; a colleague's window on the LAN plugs straight in (the 内网通 page); the interface speaks Chinese, English and Japanese, and switching is instant — no page reload.
- **One window is not a sandbox.** A single writer per session, read-only over the tunnel, dangerous commands held for your approval, previews that stop at binaries and oversized files — the window we saved was not bought by hiding the costs (see [Boundaries](#boundaries-the-important-ones)).

## What it looks like

Desktop: every pi session on disk on the left (drag to reorder, pin, archive), the streaming conversation in the middle — with a "turn ruler" down its right edge, one tick per turn — and "things that need you" on the right.

![Desktop](docs/shots/desktop.png)

`📂 Artifacts` in the top bar lists the files this session wrote or changed; `📁 File manager` browses from the drive letters and edits text in place; and a real PowerShell on this machine can be pulled up from below the conversation:

| File manager: browse / preview / edit are one panel (line numbers + syntax highlighting) | Real terminal: `node-pty` running local PowerShell, floating, multi-tab, draggable and resizable |
| --- | --- |
| ![File manager](docs/shots/files.png) | ![Terminal](docs/shots/terminal.png) |

The phone gets the same components, with three tabs at the bottom (sessions / chat / needs you); dangerous commands and model questions open right above the composer — rejecting and approving are both one click:

| Chat | Approval | Question |
| --- | --- | --- |
| ![Mobile chat](docs/shots/mobile-chat.png) | ![Mobile approval](docs/shots/mobile-approval.png) | ![Question drawer](docs/shots/ask-drawer.png) |

The LAN page (内网通) is another face of the same window: who is online, click a person to talk, drop a file to send it — and the agent can send and read for you.

| Online list: multicast discovery, manual address as a fallback | Conversation: text, files, delivery receipts, `🤖 sent by agent` |
| --- | --- |
| ![LAN online](docs/shots/peer-online.png) | ![LAN chat](docs/shots/peer-agent.png) |

Interface language (the "Appearance & language" panel; switching is instant, and Japanese gets its own font stack rather than simplified-Chinese glyphs):

| English | 日本語 |
| --- | --- |
| ![English UI](docs/shots/i18n-en.png) | ![Japanese UI](docs/shots/i18n-ja.png) |

The six desktop / files / terminal / phone shots are not hand-captured: `node probes/readme-shots.mjs` starts a throwaway bridge in `.scratch/`, builds a fixture session (fake conversation, real rendering, real file browsing, real PowerShell), pushes the approval and question drawers from a local stub, and never touches the real sessions in `~/.pi/agent` or spends a model call. The LAN and i18n shots come from their own integration scripts (`bridge/tests/peer-e2e.mjs`, `bridge/tests/i18n-ui.mjs`).

## LAN (内网通): colleagues on the same network, in the same window

This is why there is a second, independent process `peer/` (7865) next to `bridge` (7864): one per machine, discovering each other over UDP multicast, node ↔ node delivery, history kept only on each machine. The bridge forks it and restarts it with 1s → 2s → 4s backoff, giving up after the fourth death and saying "exited N times in a row" on the page; exit code 2 means the port is taken (another peer is running) and is never retried. `PI_PEER=0` turns the whole thing off.

- **Discovery**: a multicast announce every 10 seconds (`239.255.42.99:7866`); an unknown `hello` is answered with a unicast `POST /peer/hello`, so a new peer shows up in seconds instead of waiting for the next round. When the switch drops multicast, type `192.168.1.7:7865` by hand and it is remembered — that fallback is the difference between "works" and "does not", not a nicety.
- **Contacts and friends**: friend requests are confirmed both ways (requests and accepts reuse `/peer/inbox`, inheriting retry, dedupe and receipts). "Accept" requires the other side to be online; otherwise the button says so — better to do nothing than to create "I have a friend, he still has a pending request", a split that nothing would ever converge.
- **Talking**: text up to 32 KB; every message has a delivery receipt (`delivered` / `failed`), and the receipt is a newly appended line, never a rewrite of the original. Offline messages go to an outbox and are replayed when the peer appears, for up to 24 hours.
- **Files**: drop a file or paste a screenshot. The receiver checks three things first (source IP, **is this a friend**, free space on the inbox drive leaving 5 GB and 10%), and only then issues a short-lived token; chunks resume by offset, and `end` verifies size and sha256 before renaming the file into place and appending **one** file card. No token, nothing is written; a non-friend sending files gets 403.
- **Three switches**: hidden (no announces, no hello replies, passive recording only — so you see everyone and nobody sees you), pause file receiving, do-not-disturb.
- **The agent is in the loop**: `peer_find` / `peer_history` / `peer_send` are registered in the approval-gate extension and talk straight to the peer loopback. Messages sent by the agent carry `via:"pi"` and both sides show `🤖 sent by agent` — whether a line came from a human decides whether you trust it. Read-only mode still blocks `peer_send` (it reaches other people).
- **Where it lives**: the `🌐 内网通` button in the top bar opens it as a dialog without leaving the session; `/peer` opens it directly. State lives in `~/.pi-peer` (`PI_PEER_STATE`), the inbox defaults to `~/.pi-peer/inbox` (`PI_PEER_INBOX`), and history is an append-only JSONL file per conversation.
- **Boundaries**: plaintext HTTP, no end-to-end encryption, no key pairs — anyone sniffing the same network sees nicknames, text and file contents. Identity is a stable `nodeId` per machine with no signatures (impersonation inside the subnet is only fenced off by IP sets plus a handshake, see [D103](docs/DECISIONS.md)). v1 has no group chat, the phone cannot be a sender, and there is no recall (over P2P you can only delete your local copy — a button would be lying to you).
- **The name**: unrelated to "内网通 / IMO 内网通", the commercial LAN messenger by 南通艾睦 — here it just describes "messages that travel inside one network" (D363).

## Requirements

- **Node ≥ 22.19** (v24.11.1 here; LTS 22/24 both fine). `.nvmrc` points at 24.
- **pi ≥ 1.5.0**. It is not an npm dependency of this project, but `npm install` installs it for you (see "What this project needs" below); a machine that already has ≥ 1.5.0 is left alone. At startup the bridge only looks for its `cli.js` on disk and, if it cannot find it, fails with every path it tried.
  - Search order: `PI_BIN` → nvm (`%LOCALAPPDATA%\nvm\v*`, Windows only) → the `pi` / `pi.cmd` / `pi.bat` launcher on `PATH` → `node_modules` next to node → `npm root -g` → `%APPDATA%\npm`, `%ProgramData%\npm` (Windows only).
  - In other words: **a global npm install is found automatically** (Linux/macOS via `npm root -g`); with pnpm / bun / a project-local install, point `PI_BIN` at `.../pi-coding-agent/dist/bundle/cli.js`.
- Optional: cloudflared (`winget install Cloudflare.cloudflared` on Windows, `brew install cloudflared` on macOS), only needed for public access. It is looked up as `CLOUDFLARED_BIN` → `PATH` → a few common install locations.
- When deploying, **`bridge/ext/` has to travel with the rest**: the approval gate is `approval-gate.ts` there (the three LAN agent tools are registered in the same file), and `bridge/dist/` does not contain it — copying only `dist/` silently loses every approval intercept and the agent's LAN access.

### What this project needs

Part of the web page does not live in this repository but in pi extensions (`pi install` puts them into `~/.pi/agent`; cloning the code does not get them).
Missing them usually shows up as **one silently missing tool**, so `npm install` fills the gap:

| Package | Version | What you lose without it |
| --- | --- | --- |
| `pi-subagents` | pinned to `0.86.0` | settings → subagents, the background cards and the subagent tools are all gone; the page reads its session directory (`%TEMP%\pi-subagents-*`) and async JSON events directly, so a changed layout reads as nothing — hence the pin |
| `@juicesharp/rpiv-ask-user-question` | pinned to `2.15.0` | questionnaires on the page cannot be answered: `bridge/src/questionnaire.ts` fills the answers back in its per-question dialog format |
| `@juicesharp/rpiv-todo` | pinned to `2.15.0` | the run panel has no AI plan; the page shows progress from its `details.tasks` snapshot |
| `pi-web-access` | latest | `web_search` / `fetch_content` / `source_check` are missing, leaving diagnosis and "quick ask" with local abilities only |

The versions in the table and the `pi ≥ 1.5.0` above are copied from `bridge/src/deps.ts` (the list lives only there); `npm run test:deps` compares this table against it.

`npm install` runs `scripts/bootstrap.mjs`, which does three things in order:

1. Find pi: only if it is missing, or older than 1.5.0 (pre-releases like `1.5.0-rc.x` count as older), it runs `npm i -g @earendil-works/pi-coding-agent@latest`; anything already ≥ 1.5.0 is left alone.
2. Asks `pi list` which packages the user level has, matches them by name against the four above, and `pi install`s only the missing ones. A same-named package installed from npm, git or a local path counts as installed and is not duplicated with the npm build; one installed only inside a project (project-level `.pi/settings.json`) does not count.
3. Installs the dependencies of bridge / peer / web (the three `npm --prefix … install` lines).

**Packages already installed are left alone**: no upgrade, no downgrade, even when the version is older than the pin (the page says "older than x, works").
The page's "what this project needs" check uses the same rules, so whatever the page marks ✓ the script will not install either.
The result is written to `bootstrap.json` in the state directory; "settings → extensions" shows it at the top under "what this project needs", with a copyable command when something is missing.

- Check only, install nothing: `node scripts/bootstrap.mjs --check` (exit code 1 when something is missing).
- Leave the global directory alone: `PI_WEB_NO_AUTOINSTALL=1 npm install` (or use it in CI). Only step 3 happens; pi and the extensions are untouched.
- `npm install --ignore-scripts` skips **all three** steps, sub-package dependencies included; if you use it, run the three `npm --prefix bridge|peer|web install` yourself.
- A failing step does not make `npm install` exit non-zero: the reason goes into `bootstrap.json` in the state directory and the page says so; once you install things by hand the warning disappears by itself.
- In CI (a `CI` environment variable) only sub-package dependencies are installed; nothing is written into the build machine's global directory.
- On Windows without npm at all, the script suggests `winget install OpenJS.NodeJS.LTS` first, then reopening the terminal.
- It runs without `billion-context`, except that `acp_delegate` at the bottom of "settings → subagents" is greyed out with the install instructions.

## Run it

```bash
npm install   # one command is enough: postinstall runs scripts/bootstrap.mjs, filling in pi / the four extensions / the three sub-packages' dependencies
npm start     # tsc builds bridge + bundles peer and web/dist, then runs dist/index.js (~2s)
```

From then on every start is just `npm start`; it recompiles every time, so after a `git pull` that only changed code, `npm start` is enough.
If a pulled change touched a sub-package's dependencies (the `package-lock.json` in `bridge/` `peer/` `web/`), `npm start` stops before compiling, lists the mismatched packages and asks you to run `npm install` first. The same goes for the pi extensions under "what this project needs": `npm start` first checks that every extension in the table is installed and, when one is missing, names it and asks for `npm install` (D224). That check runs `pi list` (a dozen seconds), so it really runs only on the first start after the list, pi, or pi's `settings.json` changed; once everything is there the answer is remembered and later starts pay nothing.

When you run `npm start` / `npm run start:nobuild` by hand in a terminal, the server also opens the page in your default browser once it is up. Background restarts (watchdog, hot deploy, test environments) write their output to pipes or files rather than a terminal, so they leave the browser alone. `PI_WEB_OPEN=0` / `PI_WEB_OPEN=1` forces it off or on.

The first start prints a passphrase once (also written to `passphrase.txt` in the state directory):

```text
pi-web-client 0.1.0 — pi 1.5.0 @ C:\...\dist\bundle\cli.js
listening on http://127.0.0.1:7864
passphrase (generated once, shown only this time): nectar-juniper-willow-238
```

Join the same WiFi on your phone, open `http://<this machine's LAN IP>:7864`, enter the passphrase.

```bash
# reachable from the LAN (default is 127.0.0.1 only)
PI_WEB_HOST=0.0.0.0 npm start
```

## Environment variables

All variables, defaults and meanings are listed once, in the Chinese README: [`README.md` → 环境变量](README.md#环境变量). The ones that matter for LAN access are `PI_WEB_HOST=0.0.0.0`, `PI_WEB_PORT`, `PI_PEER=0` (disable the LAN process), `PI_PEER_STATE`, `PI_PEER_INBOX`, and `PI_BIN`.

## What it does

- **One window, nearly everything**: sessions, chat, approvals, terminal, files, artifacts, notes, LAN, settings, login, extensions, pi upgrades — one row of doors in the top bar, each opening above the current page and closing back onto the sentence you were on.
- **Session list**: 190+ pi sessions on disk, pinned in **creation-time** order (a finished answer does not jump to the front); the card only shows `pending` / `done` / `running`, and opening one reads it (read-only preview). To continue it, press "take over session" above the composer — the writer becomes the web page, and model / thinking / interrupt all work. Once taken over the same button has two labels: sessions taken from disk say "hand back to terminal" (release the writer and continue in the terminal), sessions created in the web page say "stop running" (kill that pi child process; history stays on disk and can be taken over again).
- **Organising sessions**: hovering a card shows a ⣿ handle — drag to reorder (drop into the pinned section to pin, drag back out to unpin); ☆ pins/unpins in one click. "Manage" enters multi-select: pin / unpin / archive / restore / delete, where delete needs a second click within 4 seconds and running or pending sessions cannot be deleted. The filter box at the top matches names and directories. Order and archives live in the bridge's `state/manage.json` and survive a bridge restart; archiving only folds a session away — not one byte of pi's session file changes. **Opening a session no longer reorders anything** (D146 retires D125) — ★ now only means "first inside its group", so opening a session you never pinned no longer pushes it into ★ and never rescues an archived one; with the left column collapsed the chip in the top bar tells you which session you are in. When the pins no longer fit on one line the strip folds its tail into a `＋N` button that opens the full list, and the current session is never folded away while it is in the strip.
- **Renaming**: hovering shows ✎ in the corner; type in place, Enter saves, Esc cancels, clicking elsewhere saves too. Taken-over sessions go through pi's `set_session_name`, so the name lands in the session file and the terminal sees it; read-only sessions are stored in the bridge's `state/names.json` (the bridge never writes pi's jsonl), and if pi renames later (`/name`) the newer timestamp wins.
- **Sending messages**: streaming text, collapsible thinking, tool cards (command, duration, output, failures in red) — and a failure is diagnosed into one line of "what happened / why / what next" (a rule table that runs offline, no extra model call).
- **Approvals**: dangerous patterns (`rm`, `git push`, writes outside the cwd, `sudo`, …) are intercepted by the `bridge/ext/approval-gate.ts` extension; rejecting and approving are one click each on the page. "Allow this kind in this session" is also one click, and the remembered rule applies only to the current session (in `state/allow/<session id>.json`), matching only the program name (+ subcommand) at the start of the command — compound commands with `;`, `&&`, `|` or redirection are always asked separately; 5 minutes without an answer counts as a refusal.
- **Interrupting**: pending approvals are cleared with it (pi's `abort` never returns while a dialog is pending, so the bridge sends `cancelled` first and then `abort`).
- **Queuing**: keep typing while it runs — Enter steers the current task, Alt+Enter queues for the next turn (followUp), in the same terminal; the "queued" bar above the composer can pull queued messages back into the input (D75).
- `!command` / `!!command`: run inside pi and come back as cards; `!` output joins the context with your next message, `!!` does not. The model panel's "session" section has cumulative tokens, cost, the session file, and "compact now" with instructions (`/session`, `/compact <instructions>` also land here).
- **Branches and export** (D77): `/tree` opens the session tree (indentation = branch, ● = the one pi will continue), any user message can be ⑂ forked into a new session (the message goes back into the composer), `/clone` copies the current branch, `/import <path>` imports a session file from elsewhere; `/export` opens pi's own HTML export in a new tab (`/export jsonl` downloads the raw file), `/copy` or the ⧉ on a message copies the original text.
- **Completion** (D77): type `/` at the start of the input to list built-in commands + extension commands + prompt templates + skills; type `@` anywhere to fuzzy-search files in the working directory. The terminal's `＋` lets you pick a shell (PowerShell / Git Bash / cmd; `$SHELL` on macOS / Linux).
- **Skill store** (D126): the "store" button at the bottom right of the skills panel opens a dialog — the "store" tab searches skills.sh (the community skill directory, sorted by installs, descriptions read from each repo's `SKILL.md`) and installs into the global `<agentDir>/skills` or the current project's `.pi/skills`; "install by address" takes `owner/repo`, GitHub links (optionally `/tree/<ref>/<path>`) and local directories; "installed" lists every skill pi will load, grouped user / project, user skills can be uninstalled (second click within 4 seconds, a junction is only unlinked) and project skills are read-only. When it is done the dialog offers a "reload the current session" button at the top, and it is read-only over the public tunnel. Every row also gained "use / view": use puts the skill into the composer, view opens that `SKILL.md` in the preview panel — looking is not using, so no session is created and no model is called, and over the public tunnel absolute paths are withheld (D281).
- **pi settings and project trust** (D78): "pi settings" in the right column (or `/settings`) edits the global / project `settings.json` — common keys as a form, everything else via "edit JSON"; writes go through pi's own file lock and only touch fields you changed. `/trust` decides whether the project's `.pi` config is loaded (writes `trust.json`, the same file the terminal uses; pi cannot prompt for trust inside the web page, so projects with no decision get a hint above the composer). `/reload` restarts this session's pi to pick up the latest settings; `/changelog` shows pi's release notes. The "advanced" section when creating a session can set `--model` `--thinking` `--tools` `-e` `--skill` `--append-system-prompt` `-ne` `-nc` `--no-mcp` `--offline` for that session, and taking it over later keeps them.
- **Login, extensions, terminal interlock** (D79): "pi settings → login / credentials" is `/login` `/logout` — pi runs its own flow (API key or OAuth) and the page only relays its questions, authorization links and device codes; credentials are written by pi into `auth.json`. "Extensions & MCP" runs pi's `install / remove / update` and `mcp add / list / remove / login / logout`. At the bottom of the "global" page you can install the "session lock" extension into pi's global extensions: the terminal's pi then registers the sessions it has open, the page will not take them over (it shows "held by terminal"), and the terminal warns before opening a session the page is writing.
- **Upgrading pi itself** (D112): a "pi itself" row at the top of "Extensions & MCP" — current version, latest version (with its source), `check again`, `update pi`. Checking is lazy and cached per source for 30 minutes (npm registry first, then pi.dev); updating asks for confirmation first (needs network, may take minutes, replaces the global pi, no automatic rollback). Afterwards the bridge re-reads the version from disk and broadcasts it, so the number in the page changes immediately without restarting the bridge; running sessions still use the old code, so you get a "restart this session" button.
- **Sharing and bug reports** (D80): `/share` uploads the session in pi's own order — Radius if you are logged in there, otherwise a private gist via the GitHub CLI — and returns pi's view link; `/bug` uses pi's own report format (settings sanitized, no API keys, session log optional) and uploads to pi's developers or exports a zip. Both say what they are taking before they leave.
- **Plugin manager** (D81 / D270): the "plugins" button under the composer next to "skills" (can be turned off in pi settings → extensions & MCP; shows a numeric badge when updates exist) opens plugin and MCP management. The "plugin marketplace" is a redraw of the local DeepSeek Harness dshmarket 1.73.19: a three-column discovery grid, search / categories / sorting, recent arrivals, favourites and blocks, fed by npm packages carrying the `pi-package` keyword (the same source as the pi.dev gallery) and sorted by monthly downloads; "installed" lives on the same page and lists pi packages (with versions), built-in and standalone extensions, MCP servers and their tools, checks for updates when opened, and only shows "update / update all" when something is newer; plugins and MCP servers can be toggled, uninstalling needs a second click within 4 seconds. The "MCP marketplace" draws the official MCP Registry with the same card / masonry layout, sorted by GitHub stars, with search, categories (npm / PyPI / Docker / remote) and one-click install (MCP supports npx / uvx / Docker / remote HTTP; secrets only as `${variables}` in mcp.json). Read-only over the public tunnel. A pi package can also be **disabled** rather than uninstalled: that writes `autoload: false`, leaves the files on disk and can be re-enabled at any time, with no extra switch of its own; a session already open has to be reloaded to notice, and a project-level package of the same name overrides the global one (D287).
- **LAN market** (D248): one more page inside the plugin panel — skills / extensions / MCP servers can be published onto the LAN; others see the list, confirm where it came from, and install in one click, after which they are a mirror too; when the publisher goes offline the bytes still come from another node (verified by sha256). The protocol lives in [`docs/lan-market-protocol.md`](docs/lan-market-protocol.md); over the public tunnel it is read-only.
- **Mail 📮** (D264): the `📮 mail` button in the top bar opens a console with five sections — mail / compose / accounts / AI permissions / sent & drafts. Multiple accounts (authorization codes and OAuth tokens stay in the bridge; the page only sees masks and a "signed in" state; 163 / QQ / Gmail / iCloud take an app password, **Outlook and work or school Microsoft 365 must sign in with Microsoft** — basic auth is long gone there, app passwords included (D282): picking either preset asks for the **public client application ID** you registered in Entra yourself (steps in [`docs/MAIL-OAUTH-SETUP.md`](docs/MAIL-OAUTH-SETUP.md): ten minutes, with troubleshooting), delegated scopes `IMAP.AccessAsUser.All` + `SMTP.Send`, device-code flow allowed; "sign in with Microsoft" sends you to `microsoft.com/devicelogin` with the code the panel shows, tokens renew themselves and a revoked one comes back as "sign in with Microsoft again"), the list is fetched **by mail time** (not by IMAP sequence number: in a mailbox restored from backup or with mail moved back out of the trash the two disagree, which used to show only 2022 mail), "unread only" goes through the server's `SEARCH UNSEEN`, and "load earlier" keeps paging; click a message to read it on the right, collapse the list with "collapse list" and give the whole width to the body; the body is rendered as HTML (a sandboxed iframe, scripts cannot run, the mail's own styling survives); inline images display, remote images do not load until you press "show images (N)", attachments download directly (what you download yourself is not governed by the AI "fetch attachments" switch). The agent's `mail_*` tools are not mounted by default — they appear once you mention mail / email in the conversation (D280). When the AI reads an HTML message, images stay as `[image]` / `[image: alt]`, and `mail_image` can look at one inline image. On the AI side there are six switches (read / send / draft / fetch attachments / confirm before sending / daily limit, plus recipient allowlist and which accounts), and they only govern the AI: a send pops a confirmation with recipients, cc, subject and the first 800 characters, and only "send" actually sends — not pressing it, Esc, or clicking the backdrop all count as not sending; sends, drafts and failures each leave a line in "sent & drafts". A broken config puts a banner on top of the panel and **refuses to save** — better to block than to overwrite your accounts and app passwords with defaults.
- **Notes 🐞** (D108): the bug button in the top bar is always visible (`Ctrl+Shift+B`) and does not follow the session — it collects "things I have to deal with later": four kinds (bug / change / idea / chore), three input modes (one line / form / long), screenshots pasted or dragged in. Archive and trash are independent axes (how far you got ≠ whether it should still occupy the list); archiving and trashing just stamp a time, and only "delete permanently" touches the disk. Three exits: copy Markdown, export everything, **hand to the agent** (prefill the current session's composer, or create a new session and prefill that one — never auto-send). Stored as `notes/bug-notes.json` plus `notes/assets/<id>/` in the state directory.
- **Machine console** (D246 / D286): "pi settings → connection & settings → tools → machine console" opens a console with five sections — overview, network & DNS, ports & services (who holds a port; one click restarts WinNAT when Hyper-V / WSL reserved it), services (state and start type), and working hours. "Working hours" treats the first unlock of the day as the start, the shift defaults to 9 hours and is editable, and once the countdown reaches zero it says "off work +X", counting workdays and days off separately; unlock times are established in three tiers (the recorder's events are the most accurate, then a 15-second poll, and the Security log can backfill up to 90 days). The recorder installs and uninstalls from the page itself, writing a HKCU startup entry and needing no administrator, and it only starts after the next sign-in; the card distinguishes "running / registered but not running / not installed" instead of papering over it with "installed".
- **Hot deploy** (D254 / D255): "pi settings → tools → hot deploy" swaps this bridge for the build of a branch — compile the front end and the bridge, replace the process, wait for the health check, and the page reloads itself onto the new version; with uncommitted changes in the main checkout you can "stash, then hot deploy", which restores them afterwards (they are not part of that build). Before you press it, it says how many running sessions will be cut (this one included).
- **Questions**: when the model calls `question` / `questionnaire`, the questions open as a bottom drawer (tabs plus submit for multiple, click-to-answer for single, "type your own" or cancel), and a "waiting for you" bar sits above the composer; answered Q/A stay in the chat as bubbles and survive a refresh. The same tool in the terminal looks exactly as before.
- **Images**: pick from the phone gallery, or paste a screenshot with `Ctrl+V` / `⌘V` on the desktop (downscaled to ≤2048px JPEG before sending); click "+N images" in the composer to see thumbnails, delete one or clear all.
- **Artifacts and files** (D50): `📂 Artifacts` is "files this session wrote or changed" (derived from tool calls, no cooperation from pi needed) — click to preview: md / html rendered, images inline, code with line numbers and syntax highlighting. `📁 File manager` is whole-disk browsing: browse / preview / edit share one panel, and next to "⌂ working dir" on the path line is "⧉ copy path" (D71). Text is edited in place and saved with `Ctrl+S`; if the file changed on disk (by pi) since you loaded it, saving stops and asks "overwrite / save a copy / discard". **On this machine everything except binaries and files over 2 MB is readable and writable**, so do not hand the passphrase to people you do not trust. `📂 Artifacts` now also collects files opened through `open_preview` — a script-generated xlsx or html that was only ever delivered by preview is no longer missing, and those rows say plainly that no writing tool produced them (D275).
- **Spreadsheets** (D256–D266): an `.xlsx` / `.xlsm` opens as a real grid drawn with the styles stored in the file (fonts, fills, four-side borders, row heights and column widths, merges, wrapping, gridlines, rich text), with images and charts anchored where the file puts them; press "edit" in the corner to change it in place, and the top becomes the WPS ribbon (home / insert / page / formulas / data / view) — 215 functions, WPS's number formats (including "unit: ten thousand" and Chinese uppercase numerals), palettes, format painter, fill handle, frozen panes, filters and data-validation dropdowns, and `Ctrl+S` writes back to the original `.xlsx` (the first save leaves a `.bak`; other sheets are untouched). What is done, what is missing and why is a line-by-line table in [`docs/SHEET-WPS.md`](docs/SHEET-WPS.md).
- **A way out for formats it cannot open** (D69): previews only handle text / md / html / images (`.xlsx` / `.xlsm` go through the spreadsheet bullet above); `.pdf`, `.docx` and friends show "binary file" with two buttons — "open in a new tab / download" and "📂 show in folder". The latter asks the bridge to **open the containing folder and select the file** in your desktop file manager (Windows `explorer /select,`, macOS `open -R`, Linux opens the folder), so you double-click it into Excel or Acrobat without downloading a copy first. LAN / local only; over the public tunnel the bridge refuses.
- **Real terminal** (D52·D70·D92·D93): the bridge hosts `node-pty`; the ">_ terminal" button in the top bar (next to `📂 artifacts`) is a real PowerShell whose output returns to the page, starting in the session's cwd. It is a **dialog floating over the page**: it **opens multiple tabs** (D70) on one tab strip, `＋` opens another (at most 4), each tab its own process, `×` closes just that one; `－` only **minimises** — the dialog folds back into the top-bar button (which lights up and shows the count) while the tabs and the bridge processes keep running, and one click restores them. **It drags and resizes** (D93): drag the title bar's blank area to move, the bottom-right corner changes width and height, the top edge only height; double-click the title bar or grab the strip to restore, and position and size are remembered by the browser across reloads. Closing the page and coming back rebuilds the tabs from the live processes in the bridge (`term.list` plus full replay) but never pops the dialog on its own. Local and LAN; disabled over the public tunnel.
- **Floating windows stack by click** (D111): whichever of terminal and file preview was clicked / focused last is in front, so the window you clicked never feels stuck. The whole band stays below the passphrase modal and the bottom drawer — only real modals cover a tool window.
- **Turn ruler** (D60): a column of ticks down the right edge of the conversation, one per turn; hovering expands the list of each turn's input (single line, right-aligned, the current turn's tick is the long one) and clicking a line jumps to that turn. Sessions with 200 turns are sampled automatically, always keeping the first and last.
- **Context panel** (D271): the "context" button in the bottom row next to "skills" opens a panel — context statistics, session metering, token and duration donuts, a timeline, the current context, per-turn trends, events, file activity, command runs, and a **context browser**: one request is split into system prompt / tool definitions / injections / skills / assistant thinking, tool calls and text (seven classes), each request keeps its own snapshot, and even old session logs open. The composition numbers are still local estimates — the provider's own usage is shown side by side and never folded into the percentages.
- **Context insights** (D278): "pi settings → tools → context insights" is the cross-session side — KPIs, the last 7 days, 8 weeks of activity, ledgers for skills / tools / commands, per-project totals and session cards that jump straight to the session. It only reads numbers aggregated by the bridge; per-request bodies are not shipped into the settings page.
- **Appearance** (D276): font size and accent live in "appearance & language", and the default size is 125% (a new device's first visit, the login page, "reset" and double-clicking the track all land there; a browser that already stored a preference keeps it).
- **Three-language UI** (D110): Simplified Chinese / English / Japanese, the switch lives in "appearance & language", and the first visit follows the browser language. Switching re-renders instantly without reloading the page (a reload would drop the WS and the scroll position); times and numbers go through `Intl`, and Japanese gets its own font stack. Tool descriptions and decision logs that the model reads stay in Chinese — their readers are the model and the maintainers, and they should not fork into two wordings because the UI language changed.
- **Keyboard shortcuts**: 12 actions (new session, session manager, collapse the side columns, artifacts, file manager, notes, appearance, skills, attach a file, terminal, interrupt) can be bound by you; only `Ctrl+Shift+B` (notes) ships bound. Combos the browser owns (`Ctrl+W`, `Ctrl+R`, `F5`, …) are refused so the page cannot lock itself up. The "keyboard shortcuts (N set)" row in settings is gone — it only reopened the same panel (D277); the panel and the bindings are unchanged, and `/hotkeys` or a bound combo still opens it.
- **Permission modes**: "🛡 confirm when dangerous ▾" in the bottom-right of the composer switches four levels per session — read-only (whitelist: read / search / list directories and tools declaring readOnlyHint) / confirm each (writes, commands, MCP and extension tools all ask) / confirm when dangerous (the default, only the D1 set) / fully automatic. The gate extension reads the mode on every tool call, so a switch applies to the very next one.
- **Syntax highlighting** (Q-031, plus the tool-card spot this PR added): `highlight.js` is bundled per language on demand (20 grammars, not the 386-grammar build); previews, md fences, and **the command line and unified diffs in tool output** all use the same `hljs-*` colours. Unknown extensions, files over 200 KB, and any highlighter error fall back to plain text — a wrong guess never shortens the file, and the preview never crashes. Edit mode (`<textarea>`) is not highlighted.
- **Referencing files**: the `file` button or a paste (a screenshot, or Explorer's `Shift+right-click → copy as path`) — images become attachments, other files insert an absolute path into the composer so pi reads them itself; a path that does not exist on this machine says so instead of silently dropping a chunk. The "pick a file from this device" button at the top right of the file sheet is for the phone and for other computers: images still become compressed attachments, everything else uploads to the bridge's staging area and its absolute path is inserted at the caret (D274; web/src/fileconsole.ts:188,215).

## Boundaries (the important ones)

- **The writer is exclusive: one session, one writer at a time.** Before taking a session over, the terminal side must have exited: pi does not lock session files, and two processes writing the same `.jsonl` produce two sibling branches that cannot see each other. The bridge adds a guard rail — refuse to take over a file written within the last 20 seconds (no override offered).
- Connections over the public tunnel are **read-only** by default: sending a message or approving requires re-entering the passphrase (step-up, 1 day; D186).
- Session files are append-only with no cross-process lock, so the bridge uses its own `state/locks/<id>.lock` to keep exactly one writer per session.
- The LAN page speaks plaintext HTTP, so anyone on the same network can sniff it; identity is a per-machine `nodeId` with no signatures; v1 has no group chat and the phone cannot be a sender (peer is a Node process).

## Tests

The full matrix — every script, what it proves, and which decisions it covers — is listed once in the Chinese README: [`README.md` → 测试](README.md#测试). Two entries are worth knowing before you run anything: `node bridge/tests/peer-e2e.mjs` spins up two isolated LAN instances on one machine, and `node bridge/tests/i18n-ui.mjs` drives an `en-US` browser through all three languages. `npm run typecheck` runs `tsc --noEmit` for bridge, peer and web. The newer suites are all in `package.json` and each proves one thing: `npm run test:sheet` (spreadsheet), `node probes/sheet-hit.mjs` (D269), `npm run test:sysmanage` / `test:sysmanage:ui` (machine console), `npm run test:hotdeploy` (hot deploy), `npm run test:context` (the context panel, D271) and `npm run test:skill:ui` (D281).

## Isolated test instance

`/skill:pi-web-client-test-dev` brings up a web client that coexists with the production one in a single command: the passphrase is always `test`, the port is probed automatically from 17864, it supports multiple instances and takes a worktree or a branch, and it never touches the one running on 7864. The skill ships with the repo in `.pi/skills/pi-web-client-test-dev/` (`bin/env.mjs` is that script), and pi discovers it automatically when running **inside this repo or its subdirectories** — no separate install (D109).

```bash
node .pi/skills/pi-web-client-test-dev/bin/env.mjs start --dir <absolute repo or worktree path> [--name t1] [--peers 1] [--build]
node .pi/skills/pi-web-client-test-dev/bin/env.mjs list          # what is running
node .pi/skills/pi-web-client-test-dev/bin/env.mjs stop --id t1 # or --all
```

Ports, pids and per-instance state directories are recorded in `~/.pi/agent/state/pi-web-test-dev/instances.json`; 7864 / 7865 / 7866 stay reserved for the production instance. `--peers 1` also starts an isolated peer, so you can play "two machines" LAN on one box.

## Test books (`/pi-web-test-html`)

Runs a module's acceptance flow as a **test book**: isolated instance → screenshots step by step → xlsx (one sheet per case) → a single-file HTML that reproduces that sheet 1:1 → shut the instance down (D247).

```text
/pi-web-test-html                        # default: the 12 cases of machine console / working hours
/pi-web-test-html workclock add a 640px narrow case  # trailing words go to the skill as extra requirements
```

The three stages run on their own: `bin/run-book.mjs` (Playwright, produces `spec.json` + `shots/`), `bin/build-xlsx.py` (openpyxl; recalculates formula caches if LibreOffice is installed) and `bin/build-html.mjs` (reproduces the Excel look from `layout.json`, inlines both screenshots and the xlsx as data URIs so one file can be carried away). Cases live in `cases/<name>.mjs` and only use `h.openCase / h.step / h.ok / h.fail / h.shot`; how to write them is in `references/writing-cases.md`, the traps already hit are in `references/pitfalls.md`.

Output always lands in the **main checkout's** `.scratch/testbook/<case set>/`, even when the command ran in a worktree — `git worktree remove` deletes untracked files with everything else, and this book really was lost that way once. Finish with `bin/env.sh down`, and check that nothing (a recorder task, say) is left behind.

## Writing the changelog (`/whatsnew-write`)

`CHANGELOG.md` is written by the AI and skimmed by a human (D195); the writing step is one command (D196):

```text
/whatsnew-write               # read the commits merged into main after the anchor, write one batch, open a worktree → commit → PR
/whatsnew-write user-visible only  # trailing words go to the skill as extra requirements
```

The skill lives in `.pi/skills/whatsnew-write/` (`SKILL.md` is the flow, `references/writing-rules.md` is how an entry is written, `references/commands.md` is commands and recovery) and carries `disable-model-invocation: true` — the model will not pick it up by itself, only a command (or `/skill:whatsnew-write`) calls it. It only touches `CHANGELOG.md`, commits in its own worktree, and stops after opening the PR; merging is left to the author.

## Not built yet

The second half of M5 and all of M6 in [`docs/PLAN.md`](docs/PLAN.md): public-network verification, real-device checks for WeChat / Web Push, autostart and tray, diff cards, mobile gestures (swipe between tabs). The inventory of pi CLI parity lives in [#8](https://github.com/Yang-Code01/pi-web-client/issues/8) — everything listed there is done; what cannot be done (custom TUI components from extensions, attaching to a process already running in the terminal) is in its "architectural ceiling" section. Known LAN limitations (no group chat, no signatures, no recall, no phone sender) are at the end of that section and in [#45](https://github.com/Yang-Code01/pi-web-client/issues/45).

## Security model (do not skip)

This is not something to drop on the public internet for multiple tenants. It listens on `127.0.0.1` only by default, and login uses a randomly generated passphrase (three words plus three digits, about 2.7×10⁷ combinations; `node bridge/dist/index.js --passphrase <longer>` swaps in something stronger). It is stored as a scrypt hash plus an HMAC cookie, and HTTP login and step-up share a per-IP rate limit. When the tunnel is on, the tunnel is only transport and the passphrase is the only barrier; connections from the public internet are read-only by default, and sending or approving requires the passphrase again (step-up). Session files are append-only with no cross-process lock, so "one writer per session at a time" is a hard constraint: the bridge refuses, it never overwrites for you. The LAN page has its own budget: it binds `0.0.0.0:7865` for delivery inside the subnet, its history and config endpoints accept loopback only, its protocol surface is `/peer/hello` and `/peer/inbox`, and writing a file requires a token the receiver issued — but it is **neither encrypted nor signed**, so do not treat it as a confidential channel.

## License

[Apache-2.0](LICENSE) © 2026 Yang-Code01

The copyright and license notices for the third-party code in the UI (highlight.js, xterm.js, …) and for the bridge runtime dependencies live in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), generated from the lockfiles; the same text is available under Settings → About → “Open source licenses”. Ship that file with any build you redistribute.
