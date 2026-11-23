# pi-subagents 0.90.0 的真样本

`bridge/src/bgruns.ts` 读的是 `pi-subagents` 落在临时目录里的产物（`status.json` /
`events.jsonl` / `workflow-receipt.json` / `workflow-children.jsonl`）。这些文件**不是**这个仓库的
东西，上游改了布局，网页不会报错，只会静默少一堆卡片 —— 所以把一份真跑出来的产物留在这里，
`bridge/tests/bgruns-unit.mjs` 拿它回放解析器。

- `meta.json` 里有版本号（**手写**，抓完自己填对）、抓取时间、以及每份产物的 run id。`bridge/tests/deps-unit.mjs` 断言
  `meta.json` 的版本跟 `bridge/src/deps.ts` 里 `pi-subagents` 的下限一致：**换钉子却忘了重取样本，
  单测会红**。
- 样本是**脱敏过的**：绝对路径换成 `<TMP>` / `<AGENT>` / `<CWD>` 占位（回放测试会把 `<TMP>` 换回
  它自己那份临时拷贝的路径），长字符串（孩子的消息正文）超过 400 字截断，其余原样。文件总数与
  目录形状与真机一致：`async-subagent-runs/<runId>/…`。

## 换钉子时怎么重取

本机先准备好一个**隔离**的 agent 目录，别动自己平时那份 `~/.pi/agent`，也别把鉴权拷到
`/tmp/xxx` 这种固定路径（同名目录可能被别的用户预先建好）：

```bash
umask 077                                    # 新建的目录/文件默认只给自己看
export PI_CODING_AGENT_DIR="$(mktemp -d)"    # 一次性目录，用完 rm -rf
cp ~/.pi/agent/auth.json ~/.pi/agent/models*.json "$PI_CODING_AGENT_DIR"/   # 只带鉴权与模型表
# settings.json 里写一个最小的：defaultProvider / defaultModel / packages: []
pi install npm:pi-subagents@<新版本>
```

抓完把那个目录删掉（里面有你的一份 `auth.json`）。

然后让模型真的派两次活（一次 async 单跑、一次 `workflow: "parallel"` 两个 task），跑完在
`$TMPDIR/pi-subagents-<scope>/async-subagent-runs/` 下取：

| 目录 | 取哪些文件 |
| --- | --- |
| 单跑 | `status.json`、`events.jsonl`、`output-0.log` |
| workflow | `status.json`、`events.jsonl`、`workflow-receipt.json`、`workflow-children.jsonl` |
| 每个孩子 | `status.json`（一个有 `events.jsonl` 就够） |

路径脱敏：把 `$TMPDIR/pi-subagents-*` 换成 `<TMP>`，本机 agent 目录换成 `<AGENT>`，cwd 换成
`<CWD>`；`*.jsonl` 逐行 JSON 解析后把超过 400 字的字符串截断再写回。改完跑
`npm run test:bgruns` 与 `npm run test:deps`。
