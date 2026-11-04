# 协议

整个系统是一个循环，三个口子。

```
          事件                领活
  来源 ─────────▶  中台  ◀───────── 接单程序 ── Agent
                   ▲ │
              回答 │ │ 卡片
                   │ ▼
                  通道 ◀──▶ 你
```

**中台的内核不主动连接任何东西。** 来源、接单程序、通道都是它们自己连进来：内核不用知道它们在哪、用什么语言写、是哪家的产品，也不保管它们的凭据；你的电脑不用开放任何端口。协议就是下面这份 HTTP + JSON，写一个新插件只要会发 HTTP 请求。

一台电脑上用时，一条命令把三样都跑在一个进程里，它们之间照样走这份协议。

**中台没有界面。** 你和它打交道靠通道和命令行。想要一个页面或大屏，用「本人」一节的几个请求自己做，它和命令行是同等的客户端。

## 六个词

| 词 | 是什么 |
|---|---|
| **事件** | 发生了一件事：来源、编号、类型、对象、一句话、详情、回原处的链接。时间到了是事件，你点了卡片也是事件。 |
| **规则** | 写在 `rules.json` 里：什么事件，交给哪个 Agent，在哪个目录，用哪个 Skill，什么时候告诉你。 |
| **事项** | 同一条规则下同一个对象的事。事件归进事项，卡片、到期复查、会话都挂在事项上。规则没写 `parallel` 时，整条规则是一个事项。 |
| **一轮** | 一次执行：领一批事件，交一份回执，然后结束。一轮会结束，事项会继续。 |
| **回执** | Agent 的最后一条消息。它想让中台做的事全写在这里，这一轮结束时在一个事务里一次生效。 |
| **卡片** | 给你看的东西。带选项的是提问，你选了就是一条新事件，事项接着往前走；不带选项的是通知。 |

## 六条原则

1. **注意力最贵。** 默认安静。没事不说话，能自己做的自己做完，只有规则写明要先问的事、确实需要本人解除的阻塞才打断你。
2. **一切都是事件。** 外部系统、时间、到期复查、你的决定，走的是同一条路。
3. **一切都连进来。** 内核没有对外的请求。凭据留在用它的地方，出事的范围也留在那里。
4. **Agent 就是一个进程。** 给它提示词，它打印最后一条消息。Claude Code、Codex、任何命令行 Agent、一段脚本、一条 CI 流水线都一样，不需要 SDK。要启动远端工作的进程，负责跟到真正做完才退出。
5. **一轮不等人。** 要问你就结束这一轮，收到回答后再开始处理，尽量接着原来的会话。等你的时候不占进程、不花 Token，重启也不丢。
6. **规则才是指令。** 事件决定不了交给谁、在哪个目录、用哪个 Skill、给什么权限，这些只由规则决定。别人写的话不进提示词，只放进标明“是资料”的文件。这挡不住所有提示注入，但把最坏的结果限制在规则给定的范围里。

## 规则

```jsonc
{
  "timezone": "Asia/Shanghai",                       // 定时和“今天”用的时区，默认系统时区
  "askFirst": ["删数据", "停服", "花钱", "对外发消息"],  // 只有这几类事 Agent 才先问你
  "sources":  { "shop": { "name": "shop" }, "github": { "name": "GitHub", "adapter": "github" } },
  "agents": {
    "claude": { "name": "Claude Code", "worker": "mac-mini", "use": "claude", "model": "…", "effort": "high", "access": "edit" },
    "cursor": { "name": "Cursor", "worker": "mac-mini", "use": "command", "command": ["agent", "-p", "--trust", "{prompt}"] }
  },
  "channels": { "feishu": { "name": "飞书", "answerers": ["ou_xxx"] } },
  "rules": [{
    "name": "处理告警",
    "when": { "source": "shop", "types": ["alert.*"] },   // 或 { "cron": "0 9 * * *" }
    "to": "claude", "cwd": "~/code/shop", "skill": "run-ops", "prompt": "按其中……一节处理。",
    "group": "ops",                                        // 同一组一次一轮，默认就是规则名
    "parallel": 3,                                         // 写了就按对象分事项：同一对象一次一轮，这一组最多 3 轮
    "tell": "needed",                                      // always 每次 / needed 只在有卡片时（默认）/ never 不推送
    "emits": { "source": "shop", "types": ["pr.*"] }      // 回执里能发什么事件，不写就不能发
  }],
  "elsewhere": [{ "name": "每周清理", "source": "shop", "to": "claude", "cron": "0 6 * * 0", "where": "Claude 应用的定时任务" }]
}
```

`elsewhere` 是在别处定时跑的任务：中台不启动它们，只在 `agent-autoloop status` 里列出来，它们要找你时用 `POST /v1/tell`。规则写错了，文件改动不生效，旧规则继续跑，并推一张卡片告诉你错在哪。

排队和等待重试的任务在领取时一起采用最新的 Agent、目录、提示词和权限；换了 Agent 就不带旧 Agent 的会话。已经领取的任务保留领取时的 Job 配置和接单程序，重复 claim、心跳、停止和重启恢复都不随规则更新换人。事件已经归属的事项不重新拆分或合并；回执中的事件许可和通知方式仍按提交时的规则核验。

## 项目任务工作流

普通事件仍走上面的事项/一轮协议。需要跨机器传递明确 Git 版本、独立审核、有限返工和验收时，规则可以选择一个 `workflows` 条目。完整且可执行的云 Hub + 三台 Mac 示例在 [`examples/recipes/project-workflow/`](../examples/recipes/project-workflow/README.md)。

### 可信工作流配置

workflow 固定 `entry`、正整数 `max_transitions`、`stages`、Git 策略、人工选项和可选 `recheck`。每个 stage 固定：

- `route`：已有普通规则的名字，因此同时固定 Agent、worker、`cwd`、prompt/Skill、group 和权限；
- `mode`：`write` 或 `inspect`；
- `max_visits`：整个任务（含人工重试和 recheck）累计上限；
- `on`：每个允许 verdict 到下一 stage 或 `$complete` / `$human` / `$failed` 的完整映射；
- `checks`：可信的 `{name, argv, timeout_ms}` 参数数组，不经过 shell 插值。

Git 策略固定显式 remote URL/绝对路径、`base_ref`、`task_ref_prefix` 和允许的 `artifact_paths`。任务资料不能提供或覆盖 workflow、worker、目录、项目、身份、权限、命令、仓库、ref、stage 或原生会话。任务接受时冻结完整 workflow/route/Git/check 快照和规则版本；之后改规则只影响新任务。

内置 Lodestar 项目适配器目前只接受显式 `access: full`。`mode: inspect` **不是只读沙箱**：Agent 仍有 full 权限，包装器只在前后核对 HEAD、干净工作树和远端 task ref 没变。需要系统级隔离时使用不同系统账号、容器和 Git 服务端权限。

### 提交、查询、停止和复查

```text
POST /v1/project-tasks
Authorization: Bearer <来源或本人的密钥>
{ "id", "type", "subject", "goal", "acceptance", "data"? }

GET /v1/project-tasks/:task_id
POST /v1/project-tasks/:task_id/cancel   { "request_id": "稳定编号" }
POST /v1/project-tasks/:task_id/recheck  { "request_id": "稳定编号" }
Authorization: Bearer <本人的密钥>
```

来源密钥只能以自己的来源提交，不能写 `source`；本人密钥可以在正文写一个已配置来源。`id` 在该来源内稳定：同一规范正文返回原任务，不同正文返回 409。cancel/recheck 的 `request_id` 同样幂等，同一个编号不能表示两种动作，也不能重置累计次数。

任务状态是 `queued`、`running`、`waiting_human`、`cancel_requested`、`unknown`、`completed`、`failed`、`cancelled`。`cancel_requested` 只是停止意图；远端原生进程确认停止后才是 `cancelled`。recheck 只在没有 active/unknown execution 且 workflow 配了 `recheck` 时创建新 generation，沿用当前 task ref、历史证据和累计上限。

需要派新 execution 的自动转换、人工决定和 recheck，都必须在消耗本次转换后仍留有一次接收结果的转换预算；重放同一 mutation 不重复计数，也不重置 visits/transitions。旧 run cancel 与 task cancel 对项目任务写入同一套取消事实。

CLI 与 MCP 使用同一接口：

```bash
agent-autoloop task submit --file task.json --json
agent-autoloop task status '<task_id>' --json
agent-autoloop task cancel '<task_id>' --request-id '<stable-id>' --json
agent-autoloop task recheck '<task_id>' --request-id '<stable-id>' --json
```

MCP 工具名是 `task_submit`、`task_status`、`task_cancel`、`task_recheck`。它们不创建密钥，也不能绕过来源/本人边界。

### Stage Job、进度和权威回执

项目 stage 仍使用现有 runs 队列。`Job.stage` 带不可变的 `task_id`、`execution_id`、generation、stage id、input revision、workflow/route/Git/check 快照和已接受证据。`Job.context` 将该 task 已接受的 stage 证据和人工决定交给 worker 写入 `context.json`，保留 generation/execution/revision/operator 关联；目标、验收条件、data、findings 和人工文字都只作资料，固定提示词只引用校验后的 id 和资料路径。

原生会话按同一 task、冻结 rules_version、Agent、route 和 mode 选择；这个范围也固定 worker、cwd 和 Lodestar project/identity。相同 review 路线再次执行可以续接，execute→rework、review→verify 不跨私有 clone 续接。新工作区首次启动新会话；已经指定 resume 的恢复失败不能改成 fresh fallback。Lodestar 仍独立校验 binding/provider 和后端实际工作目录。

`POST /v1/runs/:id/started` 可带 `stage` 进度：`execution_id`、`request_id`、remote run/session、input revision、remote state 和非秘密 binding 元数据。第一次接受的 input revision 和原生会话不能换。

owner recheck 为新代次首个 execution 写入可选 `Job.stage.input_resolution: "task_ref"`，授权适配器按冻结的 task_ref_prefix + task_id 解析当前 task ref；普通 stage 只能继承已有来源，不能自行申请解析。此时 `input_revision: null` 表示尚未 pin，不能用旧 current_revision 回填。适配器在模型准入前持久保存实际 locator 与 OID，首次可靠 started 在同一事实事务中登记该代 input/current_revision；后续观察不重新解析。

非空 pin 与 `input_resolution` 一起传给该代重试及后继，包括 review/verify changes_requested 后的 rework/write，直到接受新的 write 输出才切换到不可变 execution ref。带 pin 的 task ref 只允许校验仍指向同一 OID；不能因远端又前进而重新取样，也不要求只读审核方创建 ref。旧代次回执保持不变。确定发生在模型准入前的缺 ref 等失败，可以不带 OID、remote_ref、checks/artifacts，以 execution_failed 结束并等待人工，保留旧 current_revision；准入可能已发生时必须保留 unknown。未 pin 的 confirmed cancellation 也可结束，但成功或携带 OID 的结果不能绕过首次 started admission。

Agent 最后一条完整消息必须以唯一的严格区块结束，后面不能再有正文：

````text
```agent-autoloop-stage
{"verdict":"implemented","summary":"…","artifacts":["PLAN.md"],"findings":[]}
```
````

本地包装器只读取终态 worker 的 `final_output`，不拿累计过程输出补齐。它从 Git/文件/检查实测构造 `Result.stage`：execution/request id、verdict、原生 run、input/output revision、remote ref、带 SHA-256 的 artifacts、带 revision/exit code 的 checks、findings、diagnostics 和可选 resolution。模型写的 commit、检查或 push 成功不算证据，回执也不能指定下一 stage。

写阶段发布前先持久保存 prepared 记录，包含执行归属、workspace、input/output OID、refs、检查/产物哈希、完整 canonical Result 和 advance/late 模式。崩溃恢复核对这份记录与 Git 后重发同一回执，不重跑模型或业务检查。不可变 ref 只能不存在或等于记录的 output；task ref 只能等于 input，或在 matching execution ref + prepared 证明下等于本次 output。仅 HEAD 碰巧相同不算证明，foreign ref 或记录篡改不能通过。可能已写入但读回失败时保留 pending/unknown；late 模式只留不可变证据，不推进 task ref。

任务 stage 的已知业务/格式/归属/Git 失败使用 `outcome:"done"` + `verdict:"execution_failed"`，进入 workflow 配置的人工/失败路线；**不能**用普通 `outcome:"failed"` 触发通用自动重派。任务回执不能同时提交 ask/resolve/later/events，下一步只由冻结的 workflow 决定。

### 不确定、取消和 operator attestation

每个 stage execution/request id 在传输重试中保持不变。请求是否已准入或远端是否已停止无法确认时，旧 execution 保留为 `unknown` 并继续占用任务槽；wrapper 退出、断线或本机进程组退出都不是远端停止证明。不能换 Mac fresh retry，也不能提交假失败来释放槽位。

observer 心跳只更新在线状态，不清除 unknown 或 run.cancel_at 中的持久取消意图。HTTP 4xx/5xx、一次 404、POST 或 GET 的 failed/completed/cancelled 快照都不是单独的终止证明：适配器必须核对同一 request 的持久 resolved/cancelled 事实与匹配终态，或明确的 operator_attested。request 仍为 pending/admitted/unknown/cancel_requested 时不能返回 finished。重启后空进程 handle 或失败快照也不能推导已停止；已知 run 暂时查不到时继续保留未知执行。

Lodestar 项目请求还用 installation/project/chat/canonical-root 的 `expected_binding` 保护 admission、lookup 和 cancel。项目或安装重新绑定返回冲突，不能把未知请求归给新 owner。取消先持久化 fence，再等待递归停止；完成与取消竞态保留真实 late outcome 并停在人工卡片。

只有本机操作者已在 API 之外核实原生工作停止后，才可用 Lodestar 的独立 operator capability 把 unknown 记为 `operator_attested`。普通 `agent-project-client.json`、worker 和适配器没有这项权限；operator 凭据单独保存在本机 `agent-operator-client.json`。attestation 不是进程证明或业务成功，只保留 provenance 并进入既有人工路线；owner 还要明确选择 retry/resume/fail/cancel，系统不会自动重放业务。命令和完整部署顺序见[项目工作流 recipe](../examples/recipes/project-workflow/README.md)。

## 来源：把世界变成事件

```
POST /v1/events                    Authorization: Bearer <来源的密钥>
{ "id": "12:new", "type": "feedback.new", "subject": "#12", "summary": "…", "detail": "…", "link": "https://…" }
→ 200 { "event": 34, "duplicate": false, "routed": ["处理意见"] }
```

- `id` 和 `type` 必填。同一来源同一 `id` 只记一次，所以来源尽管重发。
- `subject` 只能是标识符（字母、数字和 `# . _ : / @ -`），`link` 只能是纯 ASCII 网址，因为它们会进提示词。`summary`、`detail` 不进提示词。
- 没有规则匹配的事件也留着，`agent-autoloop status` 看得到。

三种别的进法，到中台都是同一种事件：

- **定时**：规则写 `cron`。错过的（比如电脑合盖了）醒来只补最近的一次。重复的时刻（夏令时）只跑第一次，不存在的时刻跳过。
- **别人家的 Webhook**：`POST /v1/in/<来源>`。来源配了 `adapter`，就交给 `plugins/<adapter>/source.ts` 里的函数验签、翻译成事件，它只翻译，不发请求。验签用的秘密放在 `secrets.env`，不进 `rules.json`。
- **轮询**：不用连公网，没新东西不花 Token。规则定时叫一段脚本（也是一个 Agent），脚本在回执的 `events` 里交回新事件。事件的 `id` 要稳定，读的范围可以重叠，中台会去重；脚本要在回执交出去之后才推进自己的游标，或者干脆不留游标。

来源或 `elsewhere` 任务有话要直接告诉你（不用 Agent 处理）：

```
POST /v1/tell    { "key": "weekly-44", "text": "…" }              Authorization: Bearer <来源的密钥>
POST /v1/tell    { "task": "每周清理", "key": "x", "text": "…" }   Authorization: Bearer <接单程序的密钥>
→ 200 { "card": 56, "duplicate": false }
```

## Agent：领活、干活、交回执

每台电脑上有一个接单程序，它只往外连。一台接单程序可以服务多个 Agent。

```
GET /v1/work?claim=<这次领活的编号>&wait=50&running=7,8&capacity=1    Authorization: Bearer <接单程序的密钥>
→ 200 { "job": null | Job, "cancel": [7] }
```

- 没活时最多等 `wait` 秒，新活一来立即返回。`running` 是手上在跑的，同时也是心跳。`capacity=0` 只报到、不领活。
- 响应丢了，用同一个 `claim` 再来一次，拿回的是同一份活。
- `cancel` 是要停掉的。接单程序先向整个进程组发停止信号，10 秒后仍有进程运行就强制结束；确认组内没有活进程后才交 `outcome: "cancelled"`，这个事项才放开。停止期间重启接单程序也继续这一步。

```jsonc
// Job：一轮的全部。token 只对这一轮的这一次执行有效。
{
  "run": 12, "token": "…", "attempt": 1,
  "rule": { "name": "处理告警", "cwd": "~/code/shop", "skill": "run-ops", "prompt": "按其中……处理。" },
  "agent": { "id": "claude", "name": "Claude Code", "use": "claude", "model": "…", "effort": "high", "access": "edit" },
  "session": null,       // 尽量接着的会话：重派时是上一次的，回答来了是提问那一轮的。接不上就开新的，所以它只是优化
  "askFirst": ["删数据", "…"],
  "context": {           // 接单程序把它写成文件交给 Agent，都是资料
    "events":  [{ "id", "source", "sourceName", "type", "subject", "summary", "detail", "link", "receivedAt" }],
    "answers": [{ "card", "title", "options", "choice", "text", "about", "by", "at" }],  // 这一轮要接着做的决定
    "timers":  [{ "key", "about", "at" }],                                               // 这一轮到期的复查
    "waiting": [{ "key", "about", "at" }],                                               // 这个事项还没到期的复查
    "open":    [{ "card", "title", "text", "at" }],                                      // 同来源同组还没收尾的卡片
    "decided": [{ "card", "title", "choice", "at" }]                                     // 这个事项定过的事，只对当时那件事有效
  }
}
```

```
POST /v1/runs/12/started   Authorization: Bearer <token>   { "session": "…", "link": "claude://…" }
POST /v1/runs/12/result    Authorization: Bearer <token>   Result
→ 200 { "rejected": [{ "card": 9, "reason": "不在本轮核对范围" }] }
```

```jsonc
// Result
{
  "outcome": "done" | "nothing" | "failed" | "cancelled",
  "summary": "一句话", "error": "没跑成的原因", "session": "…",
  "usage": { "input": 0, "output": 0, "cached": 0, "cost": 0 },
  // 下面就是回执，一个事务里一次生效
  "ask":     [{ "title", "text", "options": ["…", "…"], "recommend": 0, "about": "留给接着干的自己", "key": "这件事的固定名字" }],
  "notice":  [{ "title", "text", "key" }],
  "resolve": [{ "card": 3, "reason": "在哪核实了已解决" }],
  "later":   [{ "key": "…", "at": "2026-11-05T09:00:00+08:00", "about": "到时候查什么" }, { "key": "…", "cancel": true }],
  "events":  [{ "id", "type", "subject", "summary", "detail", "link" }]
}
```

- 结果可以重放：响应丢了，同一个 token 再交一次同样的内容，得到同样的确认；内容不同返回 409。
- `failed` 会重派，所以它只带 `notice`，其余的不生效。
- 需要本人恢复连接、登录或身份验证时，用 `done` 结束本轮并交 `ask`，不交 `failed`。`done` 表示本轮结束，未完成的事项由卡片继续跟进，不代表网页已经验收。同一阻塞已有 `open` 卡片时不重复提问，不用 `later` 定时重试；`waiting` 里同一阻塞已有的复查用 `cancel` 取消。保留已完成业务，`about` 写清恢复后只做哪些剩余步骤。
- `usage` 由接单程序上报本次执行的用量，包含这次执行的回执重写；每一项都可以没有：`input`、`output`、`cached` 是 Token 数，`cost` 是美元。中台把同一轮各次执行的已报数值相加，重复提交不重复计费；没有上报的字段保持缺省，不当成零。`agent-autoloop status` 按完成时间汇总今天和最近 7 天已结束的轮次，没上报的轮数如实写出来。升级不重算旧回执，升级前已经被覆盖的累计值不会自动补回。
- `ask` 的 `key` 范围是这个事项：同一个 `key` 的卡片还开着就不再发。关掉之后再问是新的一次。
- `resolve` 只能结同来源、同组、这一轮领活前就有的卡片，越界的写进 `rejected`，不影响这一轮的结果。
- `later` 的 `key` 范围是这个事项，同一个 `key` 再写一次就是改时间。
- `events` 的来源由规则的 `emits` 决定，回执改不了。

### Agent 只需要做一件事

接单程序把提示词交给 Agent，Agent 的最后一条消息就是回执：

````
第一行一句话结论。可自动重试的临时失败写「没跑成：原因」，需要本人恢复的阻塞写「待你处理：原因」并交 ask，没事可做写「没事可做：原因」。其余结束本轮，事项由回执继续跟进。

```agent-autoloop
{ "ask": [ … ], "notice": [ … ], "resolve": [ … ], "later": [ … ], "events": [ … ] }
```
````

代码块可有可无。Agent 不需要装任何东西、不需要连中台，所以沙箱里的、云端的 Agent 也能接。

回执写错不重做业务：接单程序接着原会话，只让它把最后一条消息重写一遍，最多两次。还是读不懂，或重写进程启动失败、报错、超时、没有输出，就保留原业务消息第一行的结局，回执作废，推一张卡片告诉你原文在哪；补回执失败不会把已完成的业务变成自动重试。

### 接一个新 Agent

规则里写一行，任何能打印最后一条消息的命令都行，退出码不是 0 就算没跑成：

```json
{ "name": "Hermes", "worker": "mac-mini", "use": "command", "command": ["hermes", "chat", "-Q", "-q", "{prompt}"] }
```

想要会话接续、打开会话的链接、用量统计，就在 `plugins/<名字>/agent.ts` 写一个文件（见 `plugins/claude/agent.ts`）：

```ts
export default {
  command: (run) => [...],                                // 这一轮的命令行，run.resume 是要接着的会话
  read: (output) => ({ text, session, usage, finished }), // 从输出里读出最后一条消息和会话
  link: (session) => "…",                                 // 可选：打开这个会话的链接
};
```

专用插件的 `access` 三档，翻译成各自 CLI 的权限：`read` 只读，`edit` 只改工作目录（默认），`full` 完整权限、不审批。只读不等于读不到密钥，要隔离密钥请用系统账号或容器。`command` 只传命令参数，不替任意程序限制权限。

浏览器由 Agent 的运行环境提供。Codex 使用后台 `codex exec`，不能假定桌面应用的浏览器连接自动可用；使用该轮实际可用的浏览器工具，或规则、Skill 明确配置的入口。入口只处理网页步骤并接续自己的会话，业务和回执仍由主任务负责。中台不附带浏览器桥接，不安装或授权浏览器工具；接入验收见[插件说明](plugins.md#浏览器接入)。

## 通道：把卡片送到你面前

通道是一个往外连的小程序。

```
GET /v1/cards/next?wait=50    Authorization: Bearer <通道的密钥>
→ 200 { "card": null | Card }

// Card：这张卡片现在的样子。内容创建后不变，只有状态会变
{ "id": 56, "version": 2, "ref": null, "kind": "ask", "state": "open",
  "title": "…", "text": "…", "options": ["…", "…"], "recommend": 0,
  "choice": null, "answer": null, "result": null, "link": null }
```

- `ref` 是空的就发一条新的；不是空的就把那条改成现在的样子，改不了就直接报告。
- 发完报告：`POST /v1/cards/56/delivered { "version": 2, "ref": "om_xxx" }`。没报告的过一分钟会再给你。**支持幂等键的平台，发新消息只用卡片编号，不带版本**。平台不支持时无法保证去重，Webhook 模板可能在报告丢失后重发。
- 发不出去：`POST /v1/cards/56/failed { "version": 2, "error": "…" }`。第一次发送隔得越来越久地重试，一小时后放弃（卡片还开着，`agent-autoloop status` 看得到）；通道一直没来领不算在内。
- 还没送达就已经解决的卡片不再打扰你。
- 你点了：`POST /v1/cards/56/answer { "choice": 1, "by": "ou_xxx", "ref": "om_xxx" }`。只有第一次算数，`by` 要在这个通道的 `answerers` 里，`ref` 要和送达的那条一致。不带选项的通知有一个“已处理”按钮，点了就结案。

最小的通道只要十几行：领卡片、发文字和 `link`、报告。`link` 只给配了 `"links": true` 的通道，其他通道这里是 `null`。它打开一个不跑脚本的普通表单页，这张卡片的文字和按钮都在上面，谁拿到链接谁就能答，有效期 7 天，适合只会发文字的群机器人、邮件。能发按钮、能收回调的通道（比如飞书）用按钮，身份由平台核验，更安全。一台电脑上用时 `link` 是本机地址，手机打不开，要手机批请把中台放到有公网地址的机器上，并配好 `publicUrl`。

## 本人：看全局、回答、结案、停止

```
GET  /v1/state              Authorization: Bearer <本人的密钥>
→ 200 { "totals", "cards", "recentCards", "agents", "channels", "sources", "lines", "elsewhere", "runs", "nextBefore", "unrouted" }

POST /v1/cards/56/answer    { "choice": 1 } 或 { "text": "别的想法" }
POST /v1/cards/56/resolve   { "reason": "不用决定了，因为……" }
POST /v1/runs/12/cancel     {}
```

`agent-autoloop status`、`answer`、`resolve`、`stop` 就是这几个请求。`/v1/state` 一次给最近 60 轮，`?before=<nextBefore>` 翻更早的。

`/v1/state` 的 `spending.today`、`spending.week` 独立于分页，按规则时区的今天和过去 7 × 24 小时的完成时间汇总。每项含 `rounds`、`tokens`、`cost`、`missingTokens`、`missingCost`，后两项是没报对应用量的轮数；从未开始就取消的轮次不计入。旧请求和响应字段保持不变，旧客户端可以忽略新增字段；新版 `status` 需要中台一起更新，不再逐页读取历史来算费用。

安装与卸载不改变 HTTP 协议。`agent-autoloop --version` 显示包版本与提交；`agent-autoloop uninstall` 确认后移除自身程序、链接和服务，始终保留规则、密钥和记录；`--yes` 只跳过确认。

## 失败时会怎样

| 出了什么事 | 会怎样 |
|---|---|
| 来源把同一条事件发了两遍 | 只记一次 |
| 领活的响应丢了 | 同一个 `claim` 拿回同一份活 |
| 交结果的响应丢了 | 重放得到同样的确认 |
| Agent 没跑成 | 5 分钟后重派，每次翻倍，最长 1 小时；期间来的同一事项的事件并进这一轮；连续第 3 次告诉你 |
| 需要本人恢复浏览器连接、登录或验证 | 本轮结束，保留已完成业务和待验收项，用问题卡片等回答，不自动重派 |
| 原会话接不上 | 开新会话，靠资料文件接着干 |
| 回执写错 | 只重写回执，不重做业务 |
| 接单程序重启 | 在跑的 Agent 不受影响，回来接着盯 |
| 接单程序在线，但 5 分钟没报手上的某一轮 | 标成“不确定”，放开这一组，告诉你；它后来交的结果照样收 |
| 接单程序整台不见了 | 活留着不放开，10 分钟后告诉你一次，回来后这张卡片自动收尾 |
| 中台重启 | 全在 SQLite 里，大家自动重连 |
| 定时错过了 | 醒来只补最近一次 |
| 你点了两次，或者两边同时点 | 只算第一次 |
| 提问之后问题自己好了 | 后面的 Agent 核实后在 `resolve` 里结掉，卡片自动改成“不用决定了” |
| 规则写错了 | 旧规则继续跑，告诉你错在哪 |

这是“至少一次”的系统：Agent 可能被叫两次，所以 Skill 里有副作用的动作要先核实当前状态。

## 谁能做什么

| 凭据 | 能做 | 不能做 |
|---|---|---|
| 来源的密钥 | 以自己的名义发事件、发消息 | 冒充别的来源，领活 |
| 接单程序的密钥 | 领交给它的活；以交给它的 `elsewhere` 任务的名义发消息 | 碰别人的活，发事件 |
| 一轮的 token | 报告这一轮的这一次执行 | 碰别的轮次 |
| 通道的密钥 | 领卡片、报告、转达 `answerers` 的回答 | 其他一切 |
| 带权限的卡片链接 | 回答这一张卡片 | 其他一切 |
| 本人的密钥 | 看全部、回答、结案、停止 | 发事件，领活，改规则（规则只在文件里） |

普通访问密钥只保存 SHA-256；本机主密钥另存 `master.key`。接单程序不把中台密钥放进 Agent 的提示词或资料文件，文件系统的访问范围由 Agent 权限决定。

## 日志与确定性

每次被接受的输入产生一批事实，`commit` 在 SQLite WAL + FULL 的同一个事务里完成判断、追加日志并让 `evolve` 更新视图，提交完成才应答。规则版本、密钥哈希、领活、回执和回答都在日志里；日志从不存轮次 token、卡片链接 token 或中台主密钥。主密钥由外壳保存在本机文件，轮次 token 和卡片链接用 HMAC 分别推导。重复 claim 仍重新签发 token，上一份立即失效，保持现有行为。

`decide(view, input, now, environment)` 不改传入视图和输入。`evolve(view, facts)` 是唯一的持久投影写入者；时钟、规则文件、随机材料、网络和单一定时器由外壳提供。事实包含版本、序号、时间、种类和规范化记录变更，重放不重新运行规则。视图通过 SQLite 索引按需读取；一次判断只保留本次改动，不复制整表，不在 JavaScript 中常驻全部历史。日志、投影、日志游标、编号高水位及派生索引一起提交；删掉记录也不复用其编号。正常启动直接打开投影。外壳自动计算投影实现、查询列定义和能力派生实现的格式指纹；旧版没有游标或指纹不匹配时，在同一事务内逐条读取日志、重建投影和索引，不能覆盖期间的新提交，不一次把日志读进内存。首次升级可能需要等待重建；不改旧事实，不需要数据迁移。模拟使用同一套投影和判断实现，数据库放在内存中。

Node 请求转换层保持在 50 行内；文件、SQLite 连接、监听和定时器也由外壳提供。

`GET /v1/stream?after=42` 仅接受本人的密钥，返回 SSE：`id` 是日志序号，`event: fact`，`data` 是事实 JSON。断线用 `Last-Event-ID` 或 `after` 从下一条继续；从 0 读全量，按订阅者读取速度逐条发送，不预先缓存全部日志。不给订阅者发送密钥哈希或能力凭据。

`GET /v1/runs/42/why` 仅接受本人的密钥，返回与本轮事件、每次执行的规则版本、领取、回执、卡片回答有关的事实。命令行 `agent-autoloop why 42` 使用同一接口，时间按本机时区显示为 `MM-DD HH:mm:ss`，默认显示事件、规则版本、领取者、起止时间、会话、回执、回答和接续轮次的时间线，不打印规则正文；`agent-autoloop why 42 --json` 输出原始事实。解释查询通过记录与日志序号的索引定位事实。这些接口沿用本人的访问权限。内部回答和定时事件遇到已存在的编号时按序加后缀，保持来源与编号唯一，不覆盖来源的事件。

## 一致性和复现

插件入口统一为 `plugins/<名字>/agent.ts`、`channel.ts` 或 `source.ts`，先找安装目录，再找引擎内置目录。`agent-autoloop add <git 地址>` 将插件仓库克隆到安装目录的 `plugins/<仓库名>`，仓库根目录直接放入口文件，不自动更新，不执行安装脚本。插件是本人安装的可信代码，事件不能指定插件路径。

事件接受可选的 `hops`，非负安全整数，缺省为 0。回执事件强制使用本轮所有事件最大 hops 加 1；提问的回答和 later 定时延续原深度。超过 8 的事件仍记录但不派发，并产生通知；重复提交不重复通知。这是中台内处理链的限制，外部来源直接发出的新事件可以从 0 开始。旧日志没有 hops 时按 0 读取。

`DELETE /v1/keys/<source|worker|channel|owner>/<名字>` 只接受本人密钥，返回 `{ok:true}`。`agent-autoloop key remove <种类> <名字>` 调用正在运行的中台，删除立即唤醒并拒绝该密钥的长轮询，关闭日志订阅。已领取的一轮继续用独立的轮次 token 交结果。

`protocol/schema.json` 使用 JSON Schema 2020-12，定义事件、回执、任务、卡片和日志的格式。`agent-autoloop conformance <测试地址> --config <文件>` 走真实 HTTP；文件包含 `keys`（source、worker、channel、owner 四把测试密钥）、能匹配测试规则的 `eventType` 和通道允许的 `answerer`。规则要能把该来源和类型交给该接单程序，`parallel` 至少为 2，通道要限制回答人。检查会写入事件和卡片，只在专用测试中台运行；同一个测试中台可以连续检查。各来源的签名格式由对应插件的测试检查。

文字上限按 Unicode 码点计算。`usage` 必须是数值非负且有限的对象，不能是数组；`later.at` 必须是真实日期的 ISO 日期时间，带 `Z` 或时区偏移。回执先核验整体，再执行。

`npm test` 包含种子 24301 的 200000 步模拟，以及两台接单程序、两条来源事件、一张问题卡片的全部 8! 种动作顺序。模拟每 128 步换一个独立场景，每个场景结束前停止故障并把工作处理完；每次状态转换都检查不变量和完整日志重放。定时事件由真实到期表触发，恢复后检查到期任务没有遗留。它证明这些有限场景，不代表任意大小状态空间已被穷尽。单独复现：`node sim/random.ts 24301 200000`、`node sim/enumerate.ts`。

`npm run test:nightly` 做 1000 次真进程 SIGKILL、25 处可执行的内核变异和性能检查。崩溃用真 SQLite WAL + FULL，核对已确认序号、完整性、视图、重放和重复提交；它测进程退出，不模拟整机断电。变异漏过的名字和比例直接输出，不能用语法错误算检出。`node sim/crash.ts 1000 12648430` 和 `node sim/mutate.ts` 可分别复现。

模拟的正确性检查必须通过；模拟速度只是开发效率的观察指标。性能检查使用逐条 HTTP 写入，事务落盘后才应答。空闲 RSS 和千连接负载 RSS 分开测；检查实现见 `scripts/metrics.ts`，实测数字见 README。大历史量（结果见[历史增长实测](#历史增长实测)）用 `node scripts/history.ts 1000 10000 100000` 验证真实业务、HTTP 响应、慢速日志订阅、强杀重试和完整重建；每个场景含两轮任务、提问、投递、回答和定时复查，逐笔 WAL + FULL 提交。请求走真实 HTTP，每类操作测 30 次取中位数，状态汇总测一次；持续写入、空闲及请求负载内存分别报告，不手动触发 GC。

### ACP 和 MCP

`use: "acp"` 配合 `command: ["某个 ACP 程序", "启动参数"]` 使用 stdio ACP v1。桥接先初始化，再新建或加载会话；加载时重放的历史不算这一轮的回复，思考和工具输出不进回执。只有 `end_turn` 且有最后一条文字消息才算完成。会话编号交给中台保存。没有声明文件读写、终端或交互登录能力，Agent 用自己的工具；需要登录时先用它自己的命令行登录。

权限只选一次性的选项：`read` 允许结构化的读和搜索，`edit` 再允许工作目录内的编辑（核对符号链接），`full` 允许其他操作。未提供相应选项就取消。权限依赖 Agent 遵守 ACP，不提供额外的系统隔离。核对依据：[初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话](https://agentclientprotocol.com/protocol/v1/session-setup)、[工具权限](https://agentclientprotocol.com/protocol/v1/tool-calls)。

`agent-autoloop mcp` 提供 stdio MCP，固定支持 [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) 版，不支持 2026-07-28 的无握手协议。工具为 `status`、`why`、`answer`、`resolve`、`stop`、`emit`、`tell`；按本机已有的本人或来源密钥展示工具。它调用同样的 HTTP 接口，不直接改数据库；密钥留在本机 `config.json`。MCP 客户端把程序设为 `node`，参数设为引擎的绝对路径 `bin/agent-autoloop.ts` 和 `mcp`，环境里指定 `AGENT_AUTOLOOP_HOME`。标准输出只写 JSON-RPC。

### 通道模板与命令行示例

Webhook 通道的 `config.json` 配置使用 `use: "webhook"`、`url` 和 `platform`，后者可选 `dingtalk`、`wecom`、`slack`、`discord`。不写 platform 时可用 `body` 自定义模板，字符串里的 `{text}` 替换为卡片内容。四个模板对照官方文档：[钉钉](https://open.dingtalk.com/document/orgapp/custom-bot-send-message-type)、[企微](https://developer.work.weixin.qq.com/document/path/91770)、[Slack](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)、[Discord](https://discord.com/developers/docs/resources/webhook#execute-webhook)。钉钉和企微检查响应的 `errcode`，Slack 检查 `ok`；Discord 禁止文字触发提及。超过企微 2048 字节或 Discord 2000 字的卡片会报告失败，不截断问题或回答链接。Webhook 本身没有幂等保证，消息发送成功但报告丢失时可能重发。

桌面通知 `desktop` 是新安装默认打开的通道：macOS 用 `osascript`，Linux 用 `notify-send`。通知标题是“Agent 问你一个问题”，正文是卡片标题和“运行 agent-autoloop status 查看”；文字通过 `--` 后的参数传入，不拼进脚本。没有图形会话时不调用通知程序，报告 `skipped-<卡片编号>`，不反复打扰；卡片仍可通过命令行查看和回答。有图形会话但通知命令不存在或失败时报告 `failed`，由中台安排重试。卡片更新只报告，不重复弹出。

`examples/worker.sh` 和 `examples/channel.sh` 只用 shell 内置命令、curl、jq。设置 `AGENT_AUTOLOOP_URL`、`AGENT_AUTOLOOP_KEY` 后运行；`AGENT_AUTOLOOP_ONCE=1` 只领一次。接单示例交回 `AGENT_AUTOLOOP_RECEIPT` 中的 JSON，默认交回完成；通道示例把卡片输出到终端，再报告送达。它们是短任务示例，不适合长任务；长任务使用 `worker/` 的心跳、停止和恢复。`tests/examples.test.ts` 在通过协议一致性检查的临时中台上实际运行两个脚本，覆盖提问、送达、回答、继续和错误密钥。

## 业务场景模板

`examples/recipes/` 提供七套场景。反馈处理、网站巡检和飞书周报与业务摘要默认使用飞书本人私聊与 `Asia/Shanghai`；都是现有规则、通道和 `command` 的组合，没有增加协议字段或内核产品知识。

反馈来源只负责唤醒同一事项，当前业务状态和授权从可信接口重新读取。网站检查以本规则未关闭的异常通知卡片作为故障记录：首次失败发通知及排查事件，持续失败安静，恢复结案并发恢复事件；手动关闭未恢复卡片后仍失败会重新报告。飞书采集完整读取后写私有快照并发事件，摘要核对快照编号，旧事件不使用新资料；采集与摘要同组串行。只有本人身份可读的数据参与汇总，不把不可见当成未提交。

浏览器交接模板是主任务对已安装入口的参数调用，不新增协议或浏览器驱动。可信配置固定命令、目标与允许操作，续办使用入口实际返回的 Codex 会话编号；网页内容和外部事件不能改这些范围。连接、登录或验证受阻时由主任务 `ask` 并结束本轮，回答后只继续剩余网页步骤，浏览器助手不再次委派或独立结案。

反馈、巡检和飞书摘要的脚本使用本地假 HTTP 和假飞书 CLI 验证，不调用真实业务数据、不发真消息。公开样例不含内部地址、账号或业务记录；用户替换后的资料不应提交到仓库。结构与通道职责未变，架构图沿用现有三口协议。

## 结构与预算

一条只追加的事实日志是业务状态的来源；视图可重建，重放不重新执行规则。cron、later、重试、租约和离线判断共用到期表，外壳只安排下一次到期的定时器。接口是 HTTP + JSON；专用 CLI、MCP、来源、接单程序和通道都使用同一组接口。

| 目录 | 职责 |
|---|---|
| `kernel/` | 确定性决策、演进、日志、到期、规则匹配、请求处理、卡片表单 |
| `host/` | Node HTTP、文件与 SQLite 连接、时钟、配置、后台服务和插件加载 |
| `protocol/` | 类型、JSON Schema、输入校验、HTTP 客户端与一致性检查 |
| `worker/` | 接单、Agent 进程、心跳与停止、回执读取和提交 |
| `cli/`、`bin/` | 用户命令、MCP 与命令行启动入口 |
| `plugins/` | Agent、事件、通道和交付插件，统一发现入口 |
| `examples/recipes/` | 完整场景的规则、任务 Skill 与启用说明 |
| `examples/plugins/`、`examples/skills/`、`examples/*.sh` | 最小插件、独立任务手册和 curl/jq 示例 |
| `skills/agent-autoloop/` | 中台的正式配置与操作手册，供用户和 Agent 使用 |
| `docs/` | 通信协议、插件开发说明与架构图 |
| `tests/` | 日常行为测试及测试辅助代码 |
| `sim/` | 固定种子模拟、有界穷举、强杀与变异 |
| `scripts/`、`.github/workflows/` | 性能与真机验证、安装冒烟和跨平台 CI |

现成场景与内置插件的入口见 [README](../README.md#拿来即用的场景模板)，开发模板见[写插件](plugins.md)。插件文件名仍使用协议中的 `source.ts`，对应面向用户的“事件插件”。

| 检查 | 上限或下限 |
|---|---|
| Node 运行时依赖 | 0 |
| 冷启动到监听 | ≤150 ms |
| 启动后空闲 1 秒 RSS | ≤60.4 MB；负载 RSS 单列观测 |
| 逐条 HTTP 提交、落盘后应答 | ≥2000 条/秒 |
| 事件到等待者领活 p99 | ≤10 ms |
| 同时长轮询 | ≥1000 |
| 模拟吞吐 | 记录耗时和步数，不设速度门槛 |

这些是在 Apple M5 Pro 上的本地检查，不代表服务器容量。Node 24.21.0 的原基线也会超过 60 MB，空闲内存预算按实测峰值 60.394 MB 取到 60.4 MB；不通过改变采样时间或主动触发 GC 降低读数。最新实测、机器、完整复现命令在 README。日志只追加，不压缩，磁盘占用仍随历史增长。常驻内存不保存全部历史，待处理工作及返回结果仍会占用内存；统计总量仍需遍历数据库索引。没有总览页、工作流画布、Agent 记忆、模型路由、多租户或插件市场。

### 历史增长实测

Apple M5 Pro、24 GB、Node 24.21.0，用 `node scripts/history.ts 1000 10000 100000` 复现：

| 已完成任务轮数（约） | 事实条数（约） | 正常启动 | 空闲 RSS | 领活 HTTP 中位数 | 状态汇总 |
|---|---:|---:|---:|---:|---:|
| 2,000 | 11,000 | 84.7 ms | 59.1 MB | 0.89 ms | 11.2 ms |
| 20,000 | 110,000 | 83.2 ms | 58.9 MB | 0.84 ms | 83.6 ms |
| 200,000 | 1,100,000 | 99.8 ms | 59.1 MB | 0.82 ms | 927.1 ms |

- 110 万条事实时，收事件、去重、交结果、心跳、空闲通道轮询和 `why` 的请求中位数为 0.39–0.69 ms；进程被强杀后正常恢复约 101 ms。
- 内存：持续写入历史时最高约 282 MB；业务请求加一个慢速日志订阅约 75 MB。
- 会随历史变大的：状态汇总耗时，以及日志和索引占的磁盘。
- 格式变化后首次启动要从日志全量重建：110 万条用时 43.1 秒，峰值约 141 MB，重建前后数据一致。平时重启不重放。
- 20 万步模拟（观察项）：93.8 秒，2131 步/秒。

## 交付插件

交付是 `plugins/delivery` 的普通 Agent 进程，内核不认识它。项目仍用 `ops/delivery.json`，标签仍是 `deliver`、`deliver-attended`、`deliver-review`、`ask-owner`，提交状态仍为 `delivery`。审查状态默认 `agent-review`，由 `review.status` 修改；命令由 `review.command` 修改。设置格式、规则与 Ship 示例见[配置手册](../skills/agent-autoloop/SKILL.md#交付流水线)。

来源只给事件，仓库与执行命令由中台规则固定。内置 `poll.ts` 读取待处理标签，以“仓库、事项、标签记录、当前提交”生成稳定事件编号，不另存游标。无标签、关闭且未合并、fork 或非 main 目标不启动交付。每个 PR 一个事项，并发由规则 `parallel` 和接单程序容量控制；进程失败使用中台的 5 分钟起重试和连续失败通知，不另建队列、槽位、失败计数或通知服务。

| 步骤 | 必须满足 |
|---|---|
| 读取设置 | 用本轮 main 的固定提交读项目设置和审查要点，不读 PR 里的版本 |
| 同步 | PR 已包含 main；缺少时请求 GitHub 同步后结束这一轮，由中台重试 |
| 审查 | 裸 Git 对象转文字差异；只审分支自己的提交，排除干净合入 main 的变化，保留冲突解决；普通内部文档可略过模型 |
| 审查进程 | 不检出 PR，不执行其中的代码、测试、设置或 hooks；默认 Codex 忽略用户配置和记忆，只读独立快照 |
| 完整检查 | 草稿先转 ready；只接受当前提交最新一次 pull_request 工作流和指定 job 都完成且成功，草稿或 skipped job 不算 |
| 合并 | 再读 PR head、main 和标签；变化就重来；检查通过后才写可配置的审查状态，按已审查 SHA 合并 |
| 自动合并与响应丢失 | 先关闭已有自动合并并读回确认；合并响应丢失先看是否已经合并，不盲目再提交；清标签失败也读回确认是否已移除 |
| 发布 | 等一个覆盖合并提交的 Ship 成功，再核对健康版本；健康 HTTP 200 不能覆盖 Ship 失败或尚未完成 |
| 后续发布 | 新版覆盖且确实上线可以完成旧交付；已经完成的交付不因后来的失败发布倒退 |

`deliver-review` 审查通过就结束并移除交付标签，不代表已检查、合并或上线；在等待检查期间加上这个标签，合并前也会停在只审查，不写允许合并的审查状态。审查发现问题写 `delivery=failure`，交回问题；`deliver-attended` 不额外产生通知卡片。普通 issue 的 `ask-owner` 只将可读正文变成问题卡片，去掉代码块和本机路径，答复后移除标签。不向 GitHub 发评论，不建立 PR 说明里的多轮审查账本，也不支持用“已处理”文字豁免发现的问题；新提交重新审查。

已经合并的 PR 直接继续跟踪 Ship 和健康检查。默认最多跟踪 30 分钟，超时交给中台重试；没有健康设置的项目明确报告只完成合并。发布范围对比**健康版本到目标提交的整个差异**：只有普通内部文档变化可跳过，可执行位、符号链接、重命名到外部路径、未知历史都要求发布；后来只有文档变化不能让尚未完成的代码发布被跳过。

Ship 使用本引擎仓库的 `plugins/delivery/action.yml`，项目固定到发布后的完整提交。Action 只输出 `release` 和 `superseded`，项目已有发布步骤根据输出运行。它与交付进程共用 `project.ts` 的范围与健康判断，不在项目里长期复制工具。

普通健康 URL 只允许 HTTPS。测试时必须显式传 `--test-local-health`，Action 同样要 `test-local-health: 'true'`，才接受 `http://127.0.0.1`；不接受其他 HTTP 地址。GitHub 合并规则由项目维护者设置。
