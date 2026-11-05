# 安装说明（写给 Agent）

用户请你装好 Agent 自动化中台。先安装，再走一遍提问和继续处理；能自己做的直接做。

## 安装

支持 macOS、Linux，暂不支持 Windows。需要 Node.js 24 或更新、Git、curl，以及一个已经登录的命令行 Agent。

先检查 `node --version`。Homebrew 的 `node@24` 默认不进 PATH，装好后还要运行 `export PATH="$(brew --prefix node@24)/bin:$PATH"`；需要长期生效时再写入用户的 shell 配置。不要替用户登录，也不要读取或复制登录凭据。

本仓库已公开，安装脚本和代码都可匿名下载，不需要 GitHub 账号、登录或 GitHub CLI（`gh`）。下面的命令安装并启用登录后常驻服务：

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

GitHub Issue 轮询和 PR 交付等功能另需已登录的 `gh`，按对应场景说明配置；运行 Agent 也仍需该 Agent 自己的登录或授权。

用户指定本地仓库时，用该目录的安装脚本，并把 `AGENT_AUTOLOOP_REPO` 设成它的绝对路径。不要下载 GitHub 的旧脚本，也不要用未提交的文件冒充已安装版本；安装器克隆的是本地仓库的 HEAD。

下面以 `/path/to/agent-autoloop` 为例，使用已经登录的 Codex：

```bash
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex
```

`--agent claude` 选择 Claude Code；只有其他 CLI 时加 `--command 'hermes chat -q {prompt}'`。不指定时会检测本机安装的 Agent，第一种作为试跑对象。

程序装进 `~/.agent-autoloop/app`，配置和记录留在 `~/.agent-autoloop`。默认打开桌面通知；没有图形会话时安静跳过，问题仍能用 `agent-autoloop status` 查看。命令优先放在 PATH 中的 `~/.local/bin`，否则选 PATH 里第一个可写目录，不用 sudo、不覆盖其他程序；没有位置时使用安装器打印的完整路径。

安装器和中台启动时都会把数据目录设为 `0700`，包括已有目录，阻止其他系统用户读取数据库、事件和运行输出。升级后同步重启中台与接单程序；新版 `status` 使用中台提供的费用汇总。

升级时若投影格式有变化，会自动从旧日志逐条重建，历史多时首次启动需要等待；之后正常启动直接复用投影。原日志和已有卡片链接保留，不需要手动迁移。

## 临时 HOME、CI 或没有服务管理器

使用临时 HOME 时不要装系统服务，不改真实用户的 shell 配置和 Agent 配置。保留调用者给定的 `AGENT_AUTOLOOP_HOME`；用真实 `CODEX_HOME` 只为了沿用已经完成的 Codex 登录。

在临时环境中选一个空闲端口，运行本地安装脚本，随后启动中台：

```bash
port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex --no-service --port "$port"
agent-autoloop up
```

`up` 会一直运行。在 Agent 的命令工具里保留它返回的运行中会话，再用另一条命令完成验证；不要用 `nohup … &` 代替，命令工具可能在退出时清理后台进程。看到监听地址后再运行验证命令；启动失败就先处理该会话里的错误。

PATH 没有命令时，把 `agent-autoloop` 换成安装器打印的完整路径。临时测试使用假的 `osascript`、`notify-send`，不要发送真实消息；不要给已在线的飞书应用再开监听。

## 验证

先查看安装和连接情况，再用真实 Agent 跑完整问答：

```bash
agent-autoloop --version
agent-autoloop doctor
agent-autoloop try
```

`try` 会使用用户的模型额度。在非交互终端，它打印问题和 `agent-autoloop answer` 命令后退出；这是正常等待，不是失败。把问题转给用户，按他的选择回答，再运行 `agent-autoloop status`，看到“试跑通过”才算接通。仅为安装验证时，可以选择第二项绿色完成试跑。

Claude 要委托 Codex 处理网页时，可用[浏览器交接模板](examples/recipes/browser-handoff/README.md)，先配置现成入口，再验收首次调用与原会话续办。模板不安装浏览器驱动、不自动放宽 Claude 命令权限。

任务还需要网页操作时，另按[浏览器接入](docs/plugins.md#浏览器接入)用同一后台启动方式核实实际页面和会话接续。`try` 只证明问答流程；中台不自动提供浏览器连接或修改 Agent 的工具配置。需要本人恢复连接、登录或验证时，保留待验收项并交 `ask`，不要反复重跑已完成的业务。

没有安装系统服务时，`doctor` 会显示服务未运行；检查中台、Agent 和桌面通道是否在线即可，不要为了消除这条提示安装真实服务。

## 纯 Hub 与多台执行电脑

需要云端只管任务、由多台本机 Lodestar 分阶段执行时，使用 [`examples/recipes/project-workflow/`](examples/recipes/project-workflow/README.md)。这份 `project-workflow` recipe 提供 cloud/mac-a/mac-b/mac-c 配置、可信 workflow、普通任务 JSON 和恢复命令。

纯 Hub 配置只有监听、本人/来源客户端身份，**Hub 不运行 worker 或模型**；三台 Mac 各自向 HTTPS Hub 长轮询。Lodestar 通知通道必须放在能读取本机 `agent-project-client.json` 并访问本机 loopback daemon 的 Mac，不能让云主机访问 Mac 的 localhost。

从自有 fork 安装时先 `git clone` 并 checkout 审核过的提交，再设置 `AGENT_AUTOLOOP_REPO="$PWD"` 运行该 checkout 的 `install.sh`。本地安装器只克隆仓库 HEAD，未提交文件不会被安装；不要在另一个目录执行上游脚本后声称装的是当前 fork。真实部署还需另行配置 DNS/TLS、Git 权限、三台 Mac 的 Lodestar project/identity/binding 和飞书应用，隔离测试不证明这些步骤已经完成。

## 飞书下单入口

需要直接从飞书给云 Hub 下单时，使用 [`feishu-orders`](examples/recipes/feishu-orders/README.md)。它以独立进程运行 `plugins/feishu/bridge.ts --config <私有文件>`，外部官方 `lark-cli` 固定到已审核的版本，并使用独立应用及私有配置目录。云端运行账号保存来源密钥；需要查询、停止和复查时另配服务端 owner 密钥。模型和三台 Mac 不接触这些管理材料。

初始 `routes: {}` 可以先接通长连接，再由本人使用短时码私聊配对；没有路线不能下单，不会猜项目、创建 Git 仓库或启动模型。普通目录任务走 `/v1/events`，只支持下单与归属核实后的状态查询，停止和工作流复查都明确拒绝；完整 Git 工作流走 `/v1/project-tasks`，可按原协议查询、请求停止和复查。首单前再登记目标电脑、本机可信目录和实际就绪的 Agent。

Linux 无 keychain 时，CLI 配置使用文件 Secret 引用，文件 `0600`、目录 `0700`；不要把 App Secret 放进 argv、Git 或日志。消息事件和卡片回调分别在开发者后台配置并发布。不要给另一台电脑已经连接的应用再开监听；同机相同 CLI 配置目录的消息与唯一卡片 consumer 可共用本地 bus。入口的下单回执与手动查询不等于主动进度通知，后者和人工审批另配已有通道。

## 写第一条规则

安装验证完成后，按用户希望自动处理的事从 [README 的场景模板](README.md#拿来即用的场景模板)选一个，再照[配置手册](skills/agent-autoloop/SKILL.md)写规则；用户还没指定用途时再问。用 `agent-autoloop check` 检查；改动几秒内生效。

国内业务可从反馈处理、网站巡检、飞书周报与业务摘要三套模板开始。它们默认飞书本人私聊；替换占位符后，配置和业务资料留在私有目录，不提交到仓库。模板不替用户新建凭据或扩大飞书权限。

桌面通知只在这台电脑上显示。需要别的通道时，先确认接收位置，再按配置手册接入。不要直接测试发信或发群消息。`access` 的含义见[插件说明](docs/plugins.md#access-实际能做什么)，不要替用户扩大权限。

## 卸载

卸载程序，默认保留规则、密钥和记录：

```bash
agent-autoloop uninstall
```

终端里确认后才执行；非交互运行时加 `--yes` 跳过确认，数据同样保留。它只停自己的服务和进程、删除指向自身的命令及 Skill 链接，以及安装目录里的 `app`。其他同名文件不动；数据目录不删除。

临时安装验证完，用 `agent-autoloop uninstall --yes` 停掉本次进程，再清掉自己创建的临时目录。不要卸载用户已经在用的中台。

## 文档

- [配置手册](skills/agent-autoloop/SKILL.md)：接事件插件、通道、多台电脑和交付流水线。
- [协议](docs/protocol.md)：HTTP、回执、事实日志和故障恢复。
- [插件](docs/plugins.md)：三个可运行的最小例子。
- [安全边界](SECURITY.md)：密钥、执行权限和交付审查。

开发检查用 `npm test`、`npm run typecheck`、`npm run format:check`，完整故障与性能检查用 `npm run test:nightly`。备份同时保留 `hub.db` 和 `master.key`；后者权限应为 0600。
