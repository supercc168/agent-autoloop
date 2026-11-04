# 写插件

先看 [README 的内置插件目录](../README.md#插件体系四个方向都能自由替换)选择已有实现；需要扩展时，从下面三个可运行的最小模板开始，替换业务部分：

| 模板 | 已经演示了什么 | 你要替换什么 |
|---|---|---|
| [Agent 模板](../examples/plugins/hello-agent/agent.ts) | 用 `echo` 模拟执行，读取输出与会话编号 | 新 Agent 的启动命令和输出解析 |
| [通道模板](../examples/plugins/hello-channel/channel.ts) | 领卡片、写到文件、报告送达；通过命令行回答 | 目标平台的发送、更新和回答回调 |
| [事件插件模板](../examples/plugins/hello-source/source.ts) | 验证 HMAC-SHA256 签名，把模拟订单转换成事件 | 业务系统的验签方式和字段映射 |

事件插件、接单程序、通道和命令行共用同一套 HTTP + JSON 接口。只用 Shell 接协议，可以看 [接单脚本](../examples/worker.sh) 和 [通道脚本](../examples/channel.sh)：设置中台地址与密钥后运行，需要 `curl`、`jq`。它们适合演示短任务；长任务使用内置接单程序的心跳、停止和恢复能力。

一个插件就是一个目录，入口为 `agent.ts`、`channel.ts` 或 `source.ts`。只用 `node:` 模块和自己目录里的文件，类型在插件里声明；不要相对引用引擎源码。

用 `agent-autoloop add <git 地址>` 安装到 `~/.agent-autoloop/plugins/<仓库名>`，也接受本地 Git 仓库。它只克隆，不装依赖、不跑安装脚本、不自动更新。加载时会执行插件，安装目录的同名插件优先。

## 先跑起来

在引擎目录运行这条命令：它把三个例子分别装进临时中台，实际走完验签、派活、运行、通知和报告，退出后清理。

```bash
node --disable-warning=ExperimentalWarning --test --test-name-pattern='agent-autoloop add' tests/example-plugins.test.ts
```

## Agent 插件

从 [hello-agent/agent.ts](../examples/plugins/hello-agent/agent.ts) 开始。它用 `echo` 代替模型，克隆到别处也能运行。

| 导出对象的方法 | 作用 |
|---|---|
| `command(turn)` | 返回命令参数数组；参数不作为 shell 代码执行 |
| `read(stdout, code, stderr)` | 返回 `text`、`session`、`usage`、`error`、`finished`；运行中 `code` 为 `null` |
| `link(session)` | 可选，会话链接；支持会话的插件可只重写错误回执 |
| `check()` | 可选，能用返回 `null`，否则返回下一步怎么做 |

`turn` 包含 `prompt`、`session`、`resume`、`cwd`、`access`、`model`、`effort`、`command`、`contextFile`、`folder`。`contextFile` 是资料文件，受限 CLI 需要允许读取 `folder`。`read` 要能处理未写完的输出；CLI 真正完成后才返回 `text`。

在规则里选择这个插件：

```json
{ "name": "Hello", "worker": "my-computer", "use": "hello-agent", "access": "read" }
```

只需要打印最后一条消息时，用内置 `command` 加参数数组即可，不必写插件。

### Lodestar 项目工作流适配器

内置 [`plugins/lodestar/`](../plugins/lodestar/) 让独立软件通过本机 Lodestar 项目调用执行可信 stage，并由 Hub 继续使用原 runs 队列。完整云 Hub + 三台 Mac 配置见 [`project-workflow` recipe](../examples/recipes/project-workflow/README.md)。

规则中的 Agent 必须写 `use: "lodestar"`、显式 `access: full`，并提供固定参数数组：

```json
{
  "worker": "mac-a",
  "use": "lodestar",
  "access": "full",
  "command": [
    "--project", "sample-app",
    "--identity", "<本机 ready identity id>",
    "--client-file", "/本机私有路径/agent-project-client.json"
  ]
}
```

项目名、identity、client file、目录、Git remote/ref、checks 和权限只能来自可信规则；任务文字不能覆盖。`client-file` 必须是执行 Mac 上的绝对路径，凭据不复制给 Hub、任务资料或另一台 Mac。适配器拒绝受管 Agent 借项目凭据逃离当前会话，也拒绝 `read`/`edit`。

Mac 上的 Lodestar 必须是与本适配器共同验证过的 matching revision。接口前提包括 `/agents/project-binding`、带 `request_id`/`expected_binding` 的 admission/lookup/cancel、`/agents/requests/:id` 的持久 request 状态、终态 worker `final_output` 和独立 operator reconciliation；只会响应 `identities` 的旧 daemon 不够。通道还需要稳定 create key、`PUT /notify/:id`、`transport_state` 查询与回答回调。安装 Autoloop 不会更新或重启现有 Lodestar。

可信根目录必须是干净的 standalone clone，`.git` 和 common Git directory 都留在根目录内；当前不支持 linked worktree。适配器按 task + route + mode 创建私有 clone。Hub 只从同 task、冻结 rules_version、Agent、route、mode 的已知 execution 选择 resume，并由 Lodestar 校验实际 binding/provider/cwd；review 再次执行可续接，execute→rework、review→verify 不跨工作区续接。新工作区首次启动新会话；已选 resume 采用 strict 恢复，不在失败时 fresh fallback。

适配器只用终态 worker 的 `final_output` 解析唯一 `agent-autoloop-stage` 区块，再由本机 Git/检查实测生成结构化 stage 回执。写 stage 要留下已提交且干净的结果；inspect stage 只核对指定版本前后未变化，**不是 read-only sandbox**，实际 Agent 仍以 full 权限运行。独立审核的 Mac C 使用 Git 服务端只读凭据；它不发布 task/execution ref。

owner recheck 的 `input_resolution: "task_ref"` 授权适配器在模型准入前解析并持久 pin 当前可信 task ref，首次 started 将 pin 登记给 Hub。之后该代的观察、重试及尚未接受新 write 输出的后继沿用同一 OID 和 locator 来源，不重新取样；ref 变化就停止本次尝试。确定在准入前缺 ref 可以进入人工 execution_failed，不伪造 OID 或回退旧版本；可能已经执行的情形仍为 unknown。普通 stage 不能由文字、模型回执或未授权的 null revision 请求这种解析。

写结果先测量并保存完整 prepared receipt，再发布不可变 execution ref 与 CAS task ref。发布后丢 reading 时，重新观察只验证 prepared 和远端 Git 事实，重发同一 Result，不重跑模型或检查；foreign ref、prepared 不一致或无法确认的读回不能冒充成功。late 模式只保存不可变证据，不推进 task ref；取消不能撤销已经完成的正常发布。

无论直接 POST 返回终态还是之后 GET 到终态快照，都必须核对同一 request 的持久 resolved/cancelled 与匹配终态，或明确的 operator_attested。pending/admitted/unknown/cancel_requested、HTTP 错误、404、failed 快照或重启后空 handle 都不能单独结束读取；普通 worker 心跳也不会清掉 unknown 或取消意图。未知执行继续占槽，不能自动重放业务。

`plugins/lodestar/channel.ts` 是另一条独立插件缝：它把 Hub 卡片经本机 Lodestar notify 发到飞书。配置选项只有 `instance`、`project`、`client_file`；通道必须运行在能读取该本机文件和 loopback daemon 的 Mac 上，不能放在云 Hub 后再访问 Mac 的 `localhost`。稳定 create key 不含卡片版本；`PUT` 的 unknown 结果只轮询，不盲目重发。回调把真实 operator、原始 message ref 和 applied version 交给 Hub，Hub 拒绝的回答保持可重试。

### 浏览器接入

浏览器工具装在运行 Agent 的电脑上，由该 CLI 的工具配置或项目 Skill 提供。Codex 插件启动的是后台 [`codex exec`](https://developers.openai.com/codex/noninteractive/)；可以使用它已配置的 [MCP 工具](https://developers.openai.com/codex/mcp/)，不能只凭桌面应用能打开网页就认定后台也能访问同一浏览器。

Claude 委托 Codex 的完整规则、Skill 和参数调用脚本见[浏览器交接模板](../examples/recipes/browser-handoff/README.md)。入口命令、目标与允许操作由本人配置；网页助手返回证据和会话编号，主任务负责业务与回执。

已有专用浏览器入口时，在规则的 `prompt` 或 `skill` 写明实际命令、会话接续方式和允许的操作。只交网页步骤，返回看到的内容、操作结果和阻塞原因；主任务负责业务和中台回执。浏览器入口不是必装组件，中台不捆绑某台电脑的脚本，也不自动修改 CLI 的工具配置。

需要网页验收的任务，要用同一后台启动方式实际打开目标页面，核对内容并接续一次会话。缺少可用入口或需要本人恢复连接、登录、验证时，保留未验收项，用现有 `ask` 等待恢复；不要写“没跑成”触发重派，也不能把 HTTP 查询当作已经完成网页验收。

## 通道插件

从 [hello-channel/channel.ts](../examples/plugins/hello-channel/channel.ts) 开始。它把卡片写进文件，用命令行回答。

默认导出异步函数，参数是 `{ hub, options, log, signal }`；`options` 来自 `config.json`，不含中台密钥。

| 调用 | 作用 |
|---|---|
| `hub.nextCard(50)` | 长轮询领卡片，没卡片返回 `{ card: null }` |
| `hub.delivered(id, version, ref)` | 报告送达，保存外部消息编号 |
| `hub.failed(id, version, error)` | 报告发送失败 |
| `hub.answer(id, { choice, by, ref })` | 转交回答；核对回答人和原消息 |

`ref` 为空就发新消息，有值就更新原消息；不能更新时只报告。没报告的卡片一分钟后重派。`signal` 中止时退出，函数异常退出后由外壳重启。

在 `rules.json` 登记通道、用 `agent-autoloop key new channel cards` 取密钥，再把下面这项放进 `config.json` 的 `channels`，重启中台：

```json
{ "cards": { "use": "hello-channel", "key": "通道密钥", "file": "/tmp/cards.txt" } }
```

能收回调的通道要在规则里设置 `answerers`；只能发文字的通道设置 `links: true`，发送 `card.link`。拿到链接的人能回答这张卡片。

通道和中台共用一个 Node 进程，外部调用应异步等待。内置飞书通道的用户查询、发送和更新均异步调用 CLI，发送期间中台仍能接收事件和心跳。

## 事件插件

从 [hello-source/source.ts](../examples/plugins/hello-source/source.ts) 开始。它检查 `x-shop-signature` 中的 HMAC-SHA256，再把订单变成事件。

默认导出同步函数，参数为 `{ headers, body, secret }`。先验签，再解析原文；返回事件数组，无事返回 `[]`，拒绝请求就抛异常。事件插件只翻译，不发请求。

在 `rules.json` 登记来源：

```json
{ "shop": { "name": "商店", "adapter": "hello-source" } }
```

请求地址是 `/v1/in/shop`；秘密放在 `secrets.env` 的 `AGENT_AUTOLOOP_SECRET_SHOP`，不写进规则。事件必须有稳定的 `id` 和合法的 `type`，可带 `subject`、`summary`、`detail`、`link`，上限见[协议](protocol.md#来源把世界变成事件)。

来源能直接发标准 JSON 时不必写插件，用来源密钥调用 `POST /v1/events` 即可。

## access 实际能做什么

`access` 由插件翻译，不是中台提供的系统沙箱。以下是未额外放宽本机权限时的行为。

| 插件 | `read` | `edit` | `full` |
|---|---|---|---|
| Codex | `read-only`：能跑 shell，不能写文件，命令默认不能联网 | `workspace-write`：能跑 shell、写工作目录和临时目录，命令默认不能联网 | `danger-full-access`：能写文件、跑 shell、联网，无审批 |
| Claude Code | `plan`：能读文件和运行只读命令；其他命令取决于自动审批及本机规则 | `acceptEdits`：再允许目录内文件编辑和常见文件操作；任意 shell 或联网仍需放行 | `bypassPermissions`：跳过工具审批，没有额外系统隔离 |

Codex 的三个档位已用插件命令实跑；Claude Code 依据[官方权限说明](https://code.claude.com/docs/en/permission-modes)整理，没有调用模型实跑。Codex 的命令网络限制与托管搜索、MCP 不是同一个边界，详见[官方沙箱说明](https://learn.chatgpt.com/docs/agent-approvals-security)。用户的 CLI 配置可能改变上述能力；`read` 也不代表读不到本机密钥。

场景模板据此选权限：早报用 `edit` 写本地文件，issue 用 `edit` 改代码并让固定脚本联网取正文，告警用 `read` 看代码和事件附带的调用栈。反馈处理和飞书摘要用 `edit`，网站排查用 `read`；固定巡检与飞书读取脚本负责联网，摘要 Agent 只读完整快照。`command` 和固定脚本以本机账号运行，不受 `access` 约束。

## 一致性测试

在引擎目录运行协议的现有 HTTP 检查，全部使用临时数据和随机端口：

```bash
node --disable-warning=ExperimentalWarning --test tests/conformance.test.ts
```

检查其他中台实现时，用 `agent-autoloop conformance <测试地址> --config <测试凭据文件>`，文件格式见[协议](protocol.md#一致性和复现)。它会写事件和卡片，只对专用测试中台运行。

插件本身的完整接入测试见 [tests/example-plugins.test.ts](../tests/example-plugins.test.ts)。用其他语言写独立进程也可以，参考 [curl/jq 通道](../examples/channel.sh)和[接单程序](../examples/worker.sh)。
