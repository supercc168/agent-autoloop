# 飞书向云 Hub 下单

通过一个独立的飞书调度机器人，把私聊任务交给云 Hub，再由各台电脑的 worker 和本机 Agent 执行。入口运行在 `plugins/feishu/bridge.ts`，使用外部官方 `lark-cli` 收发消息；Hub 内核和安装包仍无运行时依赖。

```text
本人飞书私聊 -> 云端收单入口 -> Hub HTTP API -> 目标电脑 worker -> 本机 Agent
                    ^
                    +--- 下单回执、手动查询结果
```

这份入口提供私聊配对、帮助、路线、设备、下单和查询；停止与复查只支持 Git 工作流。它不使用模型解析自由聊天，不自动订阅任务进度；审批卡片另由已有 Feishu channel 处理。示例地址、设备和路径都是占位符，测试使用假 CLI 和临时 Hub，不证明真实飞书、模型或多机业务已验收。

| 路线 | 下单 | 查询 | 停止 | 复查 |
|---|---|---|---|---|
| `event` 普通任务 | 支持，可用非 Git 目录 | 核实完整事件归属后，仅返回执行轮次状态 | 不支持，所有执行状态都交管理员处理 | 不支持工作流复查 |
| `workflow` Git 工作流 | 支持，须先配好可信工作流 | 返回已关联任务的状态 | 提交停止意图，等待远端确认 | 工作流允许且无 active/unknown execution 时可请求 |

查询、停止和复查还须配置服务端 owner 密钥。普通任务的轮次结束不等于业务目标已经验收；归属混合或无法核实时，入口拒绝读取详情。普通事件可能在核查后重新排队并合并其它订单，因此即使当时已领取也不会通过飞书发停止请求。

## 1. 准备专用机器人和 CLI

为云端创建一个独立的飞书自建应用，并开启机器人能力。不要复用已在另一台电脑连接的应用；同一个应用的跨机器长连接会竞争消息。已有三台电脑的 Lodestar 机器人可以继续各自使用。

外部 CLI 固定到官方 [v1.0.99](https://github.com/larksuite/cli/releases/tag/v1.0.99)，按对应系统选择二进制，并核对同一 release 的 `checksums.txt`。它独立安装，不加入本仓库的 `dependencies`。云端以专用系统账号运行入口和 CLI，私有目录设为 `0700`，配置、来源密钥和状态文件设为 `0600`。

`lark-cli` 的配置目录通过 `LARKSUITE_CLI_CONFIG_DIR` 指定。Linux 服务器缺少 OS keychain 时，使用官方支持的文件 Secret 引用，在该目录的 `config.json` 中写：

```json
{
  "currentApp": "cli_REPLACE_WITH_APP_ID",
  "apps": [
    {
      "appId": "cli_REPLACE_WITH_APP_ID",
      "appSecret": {
        "source": "file",
        "id": "/var/lib/autoloop-feishu/private/app-secret"
      },
      "brand": "feishu",
      "defaultAs": "bot",
      "users": []
    }
  ]
}
```

Secret 值只保存在引用的私有文件里，不放进命令参数、Git、提示词或日志。仅用应用身份 `--as bot`，无需用户 OAuth 登录。配置格式与凭据行为见[官方配置源码](https://github.com/larksuite/cli/blob/v1.0.99/internal/core/config.go)及[文件 Secret 源码](https://github.com/larksuite/cli/blob/v1.0.99/internal/core/secret_resolve.go)。

在飞书开发者后台开通应用权限：

| 权限 | 用途 |
|---|---|
| `im:message.p2p_msg:readonly` | 接收本人发给机器人的私聊；也是 CLI 的消费预检要求 |
| `im:message:send_as_bot` | 返回下单与查询结果 |
| `im:message:readonly` | 以后启用已有 Feishu 卡片 channel 时读取卡片 |
| `im:message:update` | 以后启用已有 Feishu 卡片 channel 时更新卡片 |

在“事件与回调 → 事件配置”选择长连接，添加 `im.message.receive_v1`；启用卡片 channel 时，再在“回调配置”选择长连接并添加 `card.action.trigger`。连接在线后保存，发布版本，把本人纳入应用可用范围。入口只接受私聊，不需要读取群内全部消息。

CLI 对新建且尚无发布版本的应用会跳过 console 预检，可先启动消息入口让后台看到在线连接；已有发布版本但缺事件或权限时，按 CLI 的明确错误补齐后再启动。不要把进程存在当作订阅成功。[官方长连接说明](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)

## 2. 配置 Hub 和入口

在现有 Hub 的可信规则中登记 `feishu-orders` 来源，生成它自己的来源密钥，保存为入口账号可读的私有文件。保留已有 Hub 配置、规则和其它角色密钥；不要用示例覆盖正在用的中台。

把 [`config.example.json`](config.example.json) 复制到仓库外的私有目录，替换 `hub_url`、`source.name`、来源密钥路径、CLI 路径和 `state_dir`。配置、密钥和状态目录都由入口运行账号持有；私有文件只允许本人读写，文件及其直接父目录分别要求 `0600`、`0700`，不接受符号链接。`hub_url` 使用 HTTPS；同机调试允许 loopback HTTP。

配置字段：

| 字段 | 含义 |
|---|---|
| `hub_url` | 已部署的 Hub 地址 |
| `source.name` / `source.key_file` | 专用来源名及密钥文件的绝对路径 |
| `owner_key_file` | 可选，本人密钥文件的绝对路径；不配时查询、停止和复查不可用 |
| `lark` | 外部 CLI 路径，默认 `lark-cli` |
| `state_dir` | 配对、订单与投递状态的私有绝对路径 |
| `pairing.sha256` / `pairing.expires_at` | 可选，短时配对码的 SHA-256 十六进制摘要及 ISO 到期时间 |
| `routes` | 允许下单的别名，映射到固定 `kind`、`type` 和可选 `acceptance` |
| `devices` | 可选，设备的 `id`、`label` 登记清单 |

示例默认 `routes: {}`，也没有配对码或 owner 密钥；首次部署可先接通机器人，再完成配对和第一条可信路线。没有路线时不能下单；没有配对配置或已有绑定时，状态性命令不会开放。

仅提交用来源密钥。查询、停止和复查使用保存在服务端的 owner 密钥；入口只管理自己持久记录、且属于当前配对用户和私聊的订单，不接受任意 Hub 任务编号。owner 权限本身很大，入口运行账号与私有文件要隔离于模型执行账号，不能把该密钥复制给 Mac worker 或交给模型。

## 3. 私聊配对

由本机操作者生成随机短时配对码，把它的 SHA-256 摘要和到期时间写入私有入口配置；明文只交给本人，不写进配置或运行日志。建议有效期 15 分钟。本人向机器人私聊发送：

```text
配对 <本次配对码>
```

入口保存这次用户的 `open_id` 和准确的私聊 `chat_id`。它不会把第一个发消息的人自动当作本人；同应用里另一用户、另一对话或转发的文字不能接管。配对配置到期后失效，已经保存的绑定继续使用。妥善备份整个私有 `state_dir`；丢失订单状态后，入口不能从随意输入的 Hub 编号重新认领订单。

## 4. 登记首条任务路线

路线别名只从可信配置选择固定类型；聊天正文只能给目标和资料。设备、目录、Agent、模型身份、权限、命令和 Git 策略仍由 Hub 的 `rules.json` 决定。

普通日常任务可以使用非 Git 目录，配置示例：

```json
"routes": {
  "mini-notes": { "kind": "event", "type": "notes.request" }
}
```

同时在 Hub 配好匹配 `source: "feishu-orders"`、`types: ["notes.request"]` 的普通规则及目标 Agent、worker 和可信 `cwd`，再运行 `agent-autoloop check`。入口通过 `POST /v1/events` 提交；不因选择设备或下单而自动创建目录、仓库或模型身份。

需要跨机器规划、实现、独立审核和 Git 版本交接时，先按 [`project-workflow`](../project-workflow/README.md) 配好完整可信工作流，再配置：

```json
"routes": {
  "app-change": {
    "kind": "workflow",
    "type": "project.change",
    "acceptance": ["通过项目已有检查", "指定版本通过独立验收"]
  }
}
```

该类型须匹配使用 workflow 的来源规则，入口通过 `POST /v1/project-tasks` 提交。这里的验收条件是部署者登记的约定，实际检查和产物仍由可信 workflow 固定。`workflow` 路线要求已有的 Git 交接合同；不能把非 Git 目录直接塞进项目任务 API。

目标电脑还需确认相应 Lodestar API 版本、本机绑定与 `ready` 模型身份。`devices` 只是设备登记清单，不能证明设备在线、模型已就绪或业务目录可用。

## 5. 启动与使用

从已审核的 Autoloop checkout 运行，下面路径均替换为自己的私有绝对路径：

```bash
LARKSUITE_CLI_CONFIG_DIR=/var/lib/autoloop-feishu/lark \
node plugins/feishu/bridge.ts --config /var/lib/autoloop-feishu/private/config.json
```

正式运行交给自己的 systemd 或 launchd 服务，使用精确的 Node、入口和 CLI 路径。入口以保持 stdin 打开的子进程启动 `lark-cli event consume im.message.receive_v1 --as bot`；不要单独用 stdin 为 `/dev/null` 的无界 consumer 代替。

配对后可发送：

```text
帮助
路线
设备
```

下单首行指定已登记别名，下一行写目标：

```text
下单 mini-notes
整理本机工作区的笔记，输出待办报告。
```

收到 `O…` 订单编号后，以实际编号替换下面的 `O…`：

```text
查询 O…
停止 O…
复查 O…
```

查询和操作只针对本入口已关联的订单。普通 `event` 订单仅能下单、查询，所有停止与复查命令都会明确拒绝；管理员须从 Hub 核查普通事件的实际执行。Git 工作流停止表示提交停止意图，不等于远端已停；复查保留原版本证据、历史和累计预算，未知执行先核实，不能借复查重新下单。

原下单响应丢失时，查询或原消息重放会复用已保存的相同请求核实接收结果。如果此时发“停止”，入口只持久记录停止意图并封住后续重交：再次查询、重放原消息或重启入口都不会重新提交。它不能证明 Hub 已经接收或远端已经停止，必须由管理员核实实际结果。

这版入口提供下单回执和手动查询。需主动推送进度或人工审批时，另外配置已有 Feishu channel；它可与入口在同机、同应用、同 CLI 配置目录下共享本地事件 bus，卡片事件只留一个 consumer。Lodestar notify channel 则须留在能访问对应本机 daemon 的电脑。

## 去重与验证边界

入口以飞书 `message_id` 关联稳定请求，先保存订单与待发请求，再提交 Hub。相同消息重放或提交响应丢失时只恢复同一请求；已经持久确认的回复不重发。CLI 的短时发送幂等不能代替本地订单账本。正文仅作为资料，不能提供 owner、Hub 地址、worker、目录、身份或命令。

在临时目录、随机 loopback 端口、假 `lark-cli` 和测试来源中验证配对、重复消息、丢失响应、权限和恢复。真实应用连接、消息回复、模型执行与服务启停分别按用户授权验收；不能为了 smoke 给已在线应用另开跨机器监听。
