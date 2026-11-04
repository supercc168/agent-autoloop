# 云 Hub + 三台 Mac 项目工作流

这套示例把一个普通项目任务按固定路线走完：Mac A 规划，Mac B 实现/返工，Mac C 独立审核/验收。云主机只保存事实、排队、分派和卡片，不运行模型；三台 Mac 主动连云端，各自通过本机 Lodestar 执行项目 Agent。审核要求修改时最多按配置返工，只有指定版本通过独立验收才完成。

仓库里的地址、用户、项目、身份和密钥都是虚构占位符。自动测试只使用临时目录、随机本机端口、本地 Git 和假 Lodestar/飞书，**没有完成真实三机部署**，也不证明你的 DNS、TLS、Git 权限、Lodestar 身份或飞书应用已经可用。

## 四个文件

| 文件 | 用途 |
|---|---|
| `rules.json` | 云 Hub 的可信路线、三台 Mac 的 Lodestar Agent、有限阶段图、Git/检查策略和人工选项 |
| `configs.json` | `cloud`、`mac-a`、`mac-b`、`mac-c` 四份可提取配置；值全是占位符 |
| `task.json` | 普通来源提交的 inert 项目资料；没有 worker、目录、身份、命令或权限字段 |
| `README.md` | 安装、提取、提交、停止、复查和不确定状态的操作顺序 |

`project-workflow` 的固定图是：

```text
plan (Mac A, write)
  -> execute (Mac B, write)
  -> review (Mac C, inspect)
       approved -> verify (Mac C, inspect) -> verified -> complete
       changes_requested -> rework (Mac B, write) -> review
verify changes_requested -> rework
blocked / execution_failed -> Hub 人工卡片
```

外部只给 `projects` 来源生成密钥。`workflow-internal` 只让冻结 stage 引用普通规则形状，**不要**为它创建来源密钥或向 `/v1/events` 发送 `internal.*`；项目 task API 会直接按 route 名构造 stage run。

`max_transitions`、每个 `max_visits` 和人工选项都有限。到达边界只会生成一张人工卡片，不会自行放大预算。`recheck` 从 `review` 开始，保留旧代次和累计次数。

## 权限与证据边界

- 三个 Lodestar Agent 都必须显式 `access: full`。当前适配器拒绝 `read`/`edit`；它不会伪装成系统沙箱。
- `mode: inspect` **不是只读沙箱**。Agent 仍以 full 权限运行；包装器只是在审核前后核对 HEAD、工作树和远端任务 ref 没变，发现修改就失败并保留现场。
- 任务文字只进入资料文件。worker、Lodestar project/identity、`cwd`、Git remote/ref、检查命令、阶段和权限只来自 `rules.json` 的冻结快照。
- 写阶段必须自己提交干净结果。包装器不替 Agent `git add`/`commit`；它核对版本、祖先、检查、产物哈希，再用不可变 execution ref 和 CAS 更新 task ref。
- 审核/验收使用 Mac C 的独立私有 clone，不复用 Mac B 的写工作区。Mac C 的 Git 凭据只授予读取权限；模型文字里的 commit、测试或 push 声明不算证据。
- 原生会话只在同一 task、冻结规则版本、Agent、route 和 mode 对应的工作区续接。同一 review 再次执行可以续接；execute→rework、review→verify 使用不同工作区，首次启动新会话。已选择续接的会话失败时，不自动换成 fresh 重做。

先把示例中的 `npm test`、`PLAN.md`、`docs/acceptance.md` 换成项目真实且已存在的检查与产物。不要为了让示例通过而造空脚本。

## 1. 从自己的 fork 安装

四台机器都从你审核过的 fork 和提交安装，不要在别的 checkout 里直接运行上游安装脚本：

```bash
git clone git@github.com:YOUR_FORK/agent-autoloop.git
cd agent-autoloop
git checkout <REVIEWED_COMMIT_OR_BRANCH>
test -z "$(git status --porcelain)" || { echo '先提交或清理本地改动'; exit 1; }
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop"
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
AGENT_AUTOLOOP_REPO="$PWD" sh ./install.sh --hub-only --no-service
```

本地安装器克隆的是该仓库 **HEAD**；未提交文件不会被安装。发布版也应固定到你审核的提交或 tag，不能因为当前目录名字相同就假定装的是这份代码。

四台都先用 `--hub-only --no-service` 安装工具和初始私有目录，跳过 Claude/Codex 探测，也不安装或启动系统服务。Mac 随后换成自己的 worker profile；不要用这份初始 Hub 配置启动 Mac。

云主机不需要 Agent、模型登录或 Lodestar。三台 Mac 需要各自已安装并运行的 **matching Lodestar revision**，即与这份适配器共同验证过、包含本项目工作流 API 的修订；旧 daemon 仅能列出 `identities` 不足以接入。逐台核对项目 binding（`/agents/project-binding`）、带 `request_id`/`expected_binding` 的 admission/lookup/cancel 与持久 request 状态、终态 worker 的 `final_output`、独立 operator reconciliation；Mac C 还需支持 notify 的稳定 create key、`PUT /notify/:id`、`transport_state` 查询和回答回调。能力与字段见 [Lodestar 对接约定](../../../docs/plugins.md#lodestar-项目工作流适配器)。升级与服务启停由部署者单独安排，安装 Autoloop 不会替你更新或重启 Lodestar。

三台 Mac 使用同一个 `sample-app` 项目绑定，各自至少有一个 `ready` 身份。可信项目根目录必须是独立的 **standalone clone**（自己的 `.git` 目录），当前适配器不支持 linked worktree，也不支持把 `.git` 或 common Git directory 放到可信根目录之外；需要 worktree 的项目先另外 clone 一份供此工作流使用。

## 2. 替换可信配置

只在云 Hub、仍位于上述 fork 根目录时，创建仓库外的私有副本，先保留初始化生成的 owner。下面的目录与文件不会进入源码 Git：

<!-- bootstrap:private-copy -->
```bash
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop"
export WORKFLOW_PRIVATE="$HOME/project-workflow-private"
umask 077
mkdir -p "$WORKFLOW_PRIVATE"
chmod 700 "$WORKFLOW_PRIVATE"
cp examples/recipes/project-workflow/rules.json "$WORKFLOW_PRIVATE/rules.json"
cp examples/recipes/project-workflow/configs.json "$WORKFLOW_PRIVATE/configs.json"
node <<'NODE'
const fs = require('node:fs');
const file = `${process.env.WORKFLOW_PRIVATE}/configs.json`;
const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
const initial = JSON.parse(fs.readFileSync(`${process.env.AGENT_AUTOLOOP_HOME}/config.json`, 'utf8'));
if (!initial.owner) throw new Error('初始化配置缺少 owner，先检查安装结果');
profiles.cloud.owner = initial.owner;
fs.writeFileSync(file, JSON.stringify(profiles, null, 2) + '\n', { mode: 0o600 });
NODE
```

这一步只做一次；再次从模板复制会覆盖你已经填写的私有值。编辑 `$WORKFLOW_PRIVATE/rules.json`：

1. 把 `sample-app`、三个 `cwd` 和 `git.remote` 换成真实项目。三台 Mac 的可信根目录都必须已存在、是干净的 standalone clone，并指向同一明确 remote。
2. 在每台 Mac 本机查询身份，选择实际 `status: "ready"` 的 id：

   ```bash
   lodestar-agent --project sample-app identities --json
   ```

   把三个 `REPLACE_WITH_READY_*_IDENTITY` 替换掉。不要从任务正文或云端模型名猜身份。
3. 把三个 `--client-file` 换成对应 Mac 私有的 `agent-project-client.json` 绝对路径。这个文件由本机 Lodestar daemon 生成；不得复制到云 Hub、Git、提示词或另一台 Mac。
4. 把 Git refs、真实检查 argv、超时和允许产物换成项目事实。命令数组不经过 shell 插值。
5. 把 `ou_REPLACE_WITH_OWNER_OPEN_ID` 换成允许回答项目卡片的真实用户；仍需在 Mac C 配置同名通道密钥。

三台机器都应先单独确认目标 remote/ref 可读，Mac A/B 的写身份能推 task/execution refs，Mac C 使用 Git 服务端只读凭据。不要把“Agent full 权限”误写成 Git 服务端有写权限；两者是不同边界。

再编辑 `$WORKFLOW_PRIVATE/configs.json` 的云域名、三台 Mac 的 HTTPS Hub 地址，以及 Mac C 本机 `project`/`client_file`。保留刚写入的 `cloud.owner`；其余五个密钥占位符由下一步生成。私有 rules/configs、生成的 profile 和密钥输出都不得提交 Git。

## 3. 先生成密钥，再提取并验证四份 config.json

仍在云 Hub 的同一 shell 中，先安装已编辑的可信规则，再生成 source、三把 worker 和 channel 密钥，直接填入私有配置，避免把密钥打印到终端记录：

<!-- bootstrap:cloud-keys -->
```bash
cp "$WORKFLOW_PRIVATE/rules.json" "$AGENT_AUTOLOOP_HOME/rules.json"
node <<'NODE'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const file = `${process.env.WORKFLOW_PRIVATE}/configs.json`;
const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
const key = (kind, name) => execFileSync('agent-autoloop', ['key', 'new', kind, name], { encoding: 'utf8' }).trim();
profiles.cloud.source.key = key('source', 'projects');
for (const name of ['mac-a', 'mac-b', 'mac-c']) profiles[name].worker.key = key('worker', name);
profiles['mac-c'].channels['project-cards'].key = key('channel', 'project-cards');
fs.writeFileSync(file, JSON.stringify(profiles, null, 2) + '\n', { mode: 0o600 });
NODE
```

此时规则、owner 和五把角色密钥已齐全，才提取最终 profile，并替换云 Hub 的 config：

<!-- bootstrap:extract-profiles -->
```bash
node <<'NODE'
const fs = require('node:fs');
const root = process.env.WORKFLOW_PRIVATE;
const profiles = JSON.parse(fs.readFileSync(`${root}/configs.json`, 'utf8'));
if (JSON.stringify(profiles).includes('REPLACE_WITH_')) throw new Error('先填完配置和密钥');
fs.mkdirSync(`${root}/profiles`, { recursive: true, mode: 0o700 });
for (const name of ['cloud', 'mac-a', 'mac-b', 'mac-c']) {
  const file = `${root}/profiles/${name}.json`;
  fs.writeFileSync(file, JSON.stringify(profiles[name], null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
fs.copyFileSync(`${root}/profiles/cloud.json`, `${process.env.AGENT_AUTOLOOP_HOME}/config.json`);
fs.chmodSync(`${process.env.AGENT_AUTOLOOP_HOME}/config.json`, 0o600);
NODE
```

通过你自己的安全传输方式，把 `profiles/mac-a.json` **只**交给 Mac A，另两台同理；在对应 Mac 保存为 `$HOME/agent-autoloop-profile.json`。不要传整个私有目录、cloud profile、其他 Mac 的密钥或 Lodestar client 文件。在每台 Mac 执行：

<!-- bootstrap:mac-profile -->
```bash
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop"
install -m 600 "$HOME/agent-autoloop-profile.json" "$AGENT_AUTOLOOP_HOME/config.json"
```

云配置只有 `hub`、owner/source 客户端身份和自己的 loopback URL，**没有 worker、模型或通道**。Mac A/B/C 只使用各自 config，不需要云端 rules，也不启动本地 Hub；bootstrap 留下的空 rules 不参与 worker 运行。只有 Mac C 运行 `project-cards` 通道，因为 Lodestar notify 和 `client_file` 都是 Mac C 本机 loopback 资源，不能让云主机访问 `127.0.0.1:9876`。

只有云 Hub 执行规则检查：

<!-- bootstrap:hub-check -->
```bash
agent-autoloop check
```

云 Hub 检查通过后，先在它的终端前台运行 `agent-autoloop up`。各 Mac 先执行下面的配置解析、`/healthz` 与带 worker 密钥的心跳请求。`capacity=0` 只验证领活接口的认证并报告在线，不领取业务；这不能证明模型、Git 或通知已能执行：

<!-- bootstrap:worker-preflight -->
```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync(`${process.env.AGENT_AUTOLOOP_HOME}/config.json`, 'utf8'));
if (config.hub || config.owner || config.source || !config.worker?.name || !config.worker?.key)
  throw new Error('需要本机 worker profile');
const health = await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(5000) });
if (!health.ok || (await health.json()).ok !== true) throw new Error('Hub healthz 未通过');
const query = new URLSearchParams({ claim: `preflight-${crypto.randomUUID()}`, wait: '0', running: '', capacity: '0' });
const response = await fetch(`${config.url}/v1/work?${query}`, {
  headers: { authorization: `Bearer ${config.worker.key}` }, signal: AbortSignal.timeout(5000)
});
if (!response.ok) throw new Error(`worker 认证失败：HTTP ${response.status}`);
console.log(`${config.worker.name}：配置、Hub 连接和 worker 心跳认证通过`);
NODE
```

然后在各 Mac 前台运行 `agent-autoloop up`，让 worker 使用真实配置长轮询。回到云 Hub，以保留的 owner 身份查看状态，确认三台 worker 和 Mac C 通道在线，并在受控任务中核实领取与回执：

<!-- bootstrap:owner-status -->
```bash
agent-autoloop status
```

`agent-autoloop check` 读取本地 Hub 规则，不能作为 Mac 的 readiness 检查；`doctor` 的退出码或“系统服务在跑”也不能证明 worker 已认证、领活或完成业务。前台验证后再由部署者安排系统服务；同一 profile 不能同时启动两份 worker/channel。

## 4. 提交普通任务与定时任务

使用 `projects` 来源配置时，`task.json` 不带 `source`：

```bash
agent-autoloop task submit --file ./task.json --json
```

owner 代某个已配置来源提交时必须显式指定，且 JSON 不能带另一个 source：

```bash
agent-autoloop task submit --source projects --file ./task.json --json
```

同一来源和同一 `id` 重发相同正文返回原任务；正文不同返回冲突。`data`、goal、acceptance 都不能选择 workflow、worker、目录、项目、身份、权限、命令、Git 或阶段。

`项目定时复查入口` 使用现有 cron/tick 创建同一工作流任务。休眠期间只补最近一次，重复时刻只创建一个稳定 occurrence；它不依赖外部 cron。若已有外部调度器，也可用稳定 task `id` 调同一个提交接口，不要同时启用两套相同定时来源。

查看状态、请求停止、复查已完成任务：

```bash
agent-autoloop task status '<task_id>' --json
agent-autoloop task cancel '<task_id>' --request-id 'cancel-20261104-001' --json
agent-autoloop task recheck '<task_id>' --request-id 'recheck-20261104-001' --json
```

mutation 的 `request_id` 必须稳定；同一编号不能同时表示 cancel 和 recheck。`cancel_requested` 只表示意图已记录，远端进程确认停止后才是 `cancelled`。完成与取消竞态会把真实结果保留为 late outcome 并停在人工处理，不会假装工作没发生。

recheck 的新代次先获准解析当前可信 task ref，适配器在模型启动前把它固定为一个 input OID，并由首次 started 事实登记。之后的观察、人工 retry、review/verify 或尚未接受新写入结果的 rework 都沿用这一个 OID，不重新抽取后来移动的 ref；task ref 变了就停止本次尝试。缺失 ref 等确定发生在模型准入前的失败进入人工处理，不回退到旧代次版本。Mac C 只读取 ref，不为复查创建新 ref；旧代次证据保持不变。

## 5. 卡片、离线与人工恢复

阻塞阶段结束当前 Agent 轮次并创建一张版本化 Hub 卡片。文字回答只保存资料，不能选择命令或阶段；可信选项才会创建下一次允许的执行，并继续受累计上限约束。Lodestar 通道把实际 `operator.open_id` 和原始 `message_id` 交给 Hub；回答人或消息引用不匹配时返回非 2xx，卡片仍可由授权用户重试。

Mac 或网络离线时，Hub 保留原执行槽和证据；不要把同一阶段改派到另一台 Mac。transport/result 为 `unknown` 时只观察同一个 request，不自动 fresh retry，也不能用本地 wrapper 退出证明远端停止。项目或安装 binding 改变会返回冲突；先恢复原绑定，再核对。

普通心跳只说明观察者还在线，不会清掉 unknown 或已经持久化的取消意图。HTTP 错误、一次 404、标成 failed/completed 的 run 快照都不能单独证明原生进程已停；结束读取必须核对同一 request 的持久 resolved/cancelled 事实或明确的 operator attestation。

写阶段先把实测版本、检查、产物和完整回执保存为 prepared 记录，再发布 execution/task refs。发布后丢了结果时，恢复只核对 prepared 与 Git 事实并重发原回执，不重跑模型或业务检查；ref 属于别的写入或记录无法核实时保留失败/unknown 现场。取消后的 late 证据不能推进 task ref，已经完成的发布也不会因取消而被倒退。

只有操作者已经在本机、Lodestar API 之外确认原生任务停止后，才能在对应 Mac 运行：

```bash
lodestar-agent --project sample-app requests reconcile \
  --request '<remote_request_id>' \
  --expected-binding '<original_binding_id>' \
  --stopped \
  --reason 'Operator verified the native process is stopped' \
  --json
```

这个命令读取单独的 `agent-operator-client.json`，普通项目调用使用的 `agent-project-client.json` 无权执行 reconciliation。operator capability 只留在本机，不复制给 worker、通道、云 Hub 或任务资料。

`operator_attested` 是人工声明，不是进程级证明，也不代表业务成功。它释放旧的未知执行时保留 resolution、binding 和 late outcome，并让任务进入已有的人工失败/恢复路径；必须再由 owner 在 Hub 卡片上明确选择 retry/resume/fail/cancel，才可能创建下一次执行。不得在 reconciliation 命令后自动重发业务。

## 6. 上线前仍需人工完成

本模板的隔离测试不能替代部署。至少还要逐项核实：

- 云主机真实域名、DNS、TLS 证书、反向代理和只监听 loopback 的 Hub；
- 四台机器安装的确切提交、服务账号、目录权限、备份与日志保留；
- 三台 Mac 到云 Hub 和 Git remote 的网络/SSH 权限，以及 task/execution ref 保护；
- 每台 Lodestar 的项目→chat→canonical root→installation binding、ready identity、project/operator client 文件权限；
- Mac C 的飞书机器人、本人 open_id、唯一事件监听、项目群绑定和应用权限；
- 项目真实 `npm test`（或替代 argv）、产物文件、超时和 main/base ref；
- 断网、daemon/worker/Hub 重启、取消、迟到结果、unknown 与 operator reconciliation 的演练。

完成这些步骤后，才可以说真实云端和三台 Mac 已部署。自动测试通过只证明示例结构和隔离行为与实现一致。
