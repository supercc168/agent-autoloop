// The command line: what a person, or their Agent, types.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { hubClient } from "../protocol/client.ts";
import { CONFIG_FILE, readConfig, writeConfig, type Config } from "../host/config.ts";
import { HOME, RULES_FILE } from "../host/home.ts";
import { installService, removeService, serviceRunning } from "../host/service.ts";
import { versionLine } from "../host/version.ts";
import { spendLine } from "./spend.ts";
import { parseProjectTaskInput } from "../protocol/project-tasks.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PROGRAM = path.join(ROOT, "bin", "agent-autoloop.ts");

const HELP = `Agent 自动化中台

  agent-autoloop init [--agent claude|codex] [--command '某个命令 {prompt}'] [--port 3350] [--no-service]
                                    在这台电脑上装好：一个人一台电脑就够
  agent-autoloop init --hub-only [--listen 127.0.0.1:3350] [--public-url https://中台地址] [--no-service]
                                    只安装云中台，不需要本机模型
  agent-autoloop try                     用你的 Agent 跑一遍完整流程
  agent-autoloop why <第几轮> [--json]  查看时间线；--json 输出原始事实
  agent-autoloop conformance <地址> --config <测试凭据文件>
                                    在测试中台上检查协议
  agent-autoloop status                  现在什么情况：谁在线、等你什么、在做什么、做过什么、花了多少
  agent-autoloop answer <卡片> [序号] [--text 别的想法]
                                    回答一张卡片；通知不用写序号
  agent-autoloop resolve <卡片> <结果>   这件事不用决定了，写一句结果
  agent-autoloop doctor                  查哪里没配好
  agent-autoloop check                   检查 rules.json
  agent-autoloop emit <类型> [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key 来源密钥]
                                    发一条事件
  agent-autoloop tell <编号> [--task 定时任务名]
                                    直接告诉你一件事，内容从标准输入读
  agent-autoloop stop <第几轮>           停掉一轮
  agent-autoloop task submit [--file 任务.json] [--source 来源] [--json]
                                    登记项目任务；省略文件则从标准输入读取 JSON，重试沿用 id
  agent-autoloop task status <任务编号> [--json]
  agent-autoloop task cancel|recheck <任务编号> --request-id <固定请求编号> [--json]
                                    查看、停止或复查项目任务
  agent-autoloop key new <source|worker|channel|owner> <名字>
                                    新建一把密钥（只显示这一次）
  agent-autoloop key list                有哪些密钥
  agent-autoloop key remove <种类> <名字>  立即收回一把密钥
  agent-autoloop add <git 地址>           安装插件，不自动更新
  agent-autoloop mcp                      用标准输入输出连接 MCP 客户端
  agent-autoloop join <中台地址> --worker <名字> --key <密钥>
                                    另一台电脑只接活时用
  agent-autoloop update                  更新到最新版
  agent-autoloop uninstall [--yes]       卸载程序并保留数据；--yes 跳过确认
  agent-autoloop --version               版本和当前提交
  agent-autoloop up                      启动（平时由系统服务调用）
  agent-autoloop service install|remove  系统服务

配置和数据在 ${HOME}。规则在 ${RULES_FILE}，改了自动生效。`;

type Flags = Record<string, string | true>;

function flags(args: string[]) {
  const named: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      rest.push(args[i]);
      continue;
    }
    const name = args[i].slice(2);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) named[name] = args[++i];
    else named[name] = true;
  }
  return { named, rest };
}
const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);
const fail = (words: string): never => {
  console.error(words);
  process.exit(1);
};

const client = (key: string, config = readConfig()) => hubClient(config.url, key);
const ownerClient = (config = readConfig()) =>
  client(config.owner ?? fail("这台电脑上没有本人的密钥（只接活的电脑看不了）"), config);

/** The first rules of a new install: its agents and one rule to try the whole loop with. */
function starterRules(agents: Record<string, object>, first: string) {
  return {
    sources: { local: { name: "本机" } },
    agents,
    channels: { desktop: { name: "桌面通知" } },
    rules: [
      {
        name: "试一下",
        when: { source: "local", types: ["try.*"] },
        to: first,
        cwd: path.join(HOME, "try"),
        prompt:
          "这是 agent-autoloop try 的试跑，不要改任何文件，不要做别的事。读资料文件。" +
          "如果 answers 是空的，就问一个问题：title 写“试跑：选一个颜色”，text 写“这是一次试跑，选哪个都行。”，" +
          'options 写 ["蓝色","绿色"]，key 写 try-color，第一行结论写“问了一个问题”。' +
          "如果 answers 不是空的，第一行结论写“你选了某某，试跑通过”，把某某换成 answers 里选的那一项，不附回执。",
      },
    ],
    elsewhere: [],
  };
}

/** Shows the user's Agents how to set it up. Only for the install in its usual place, never over their own. */
function linkSkill() {
  if (process.env.AGENT_AUTOLOOP_HOME) return;
  for (const agent of [".claude", ".codex"]) {
    if (!existsSync(path.join(homedir(), agent))) continue;
    const link = path.join(homedir(), agent, "skills", "agent-autoloop");
    if (lstatSync(link, { throwIfNoEntry: false })) continue;
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(ROOT, "skills", "agent-autoloop"), link);
  }
}

/** What to type to run this program: its name if that's what a shell finds, otherwise where it is. */
function howToRun() {
  const found = spawnSync("/bin/sh", ["-c", "command -v agent-autoloop"], { encoding: "utf8" }).stdout.trim();
  if (found && realpathSync(found) === realpathSync(PROGRAM)) return "agent-autoloop";
  return /\s/.test(PROGRAM) ? `'${PROGRAM}'` : PROGRAM;
}

/** What was asked for on the command line, or whichever of the usual Agents is installed. */
async function agentsToUse(named: Flags, worker: string) {
  const agents: Record<string, { name: string; worker: string; use: string; command?: string[] }> = {};
  const command = text(named.command);
  if (command) {
    agents.agent = { name: "Agent", worker, use: "command", command: command.split(/\s+/) };
    return agents;
  }
  const wanted = text(named.agent);
  const { adapterFor } = await import("../worker/agents.ts");
  const emptyTurn = {
    prompt: "",
    session: "",
    resume: null,
    cwd: "",
    access: "edit",
    contextFile: "",
    folder: "",
  } as const;
  for (const name of ["claude", "codex"]) {
    if (wanted && wanted !== name) continue;
    const adapter = await adapterFor(name);
    try {
      // An adapter finds its program to build the command line, and throws if it's not there.
      adapter.command(emptyTurn);
      agents[name] = { name: name === "claude" ? "Claude Code" : "Codex", worker, use: name };
    } catch {}
  }
  return agents;
}

async function init(args: string[]) {
  const { named } = flags(args);
  if (existsSync(CONFIG_FILE)) return fail(`已经装过了：${CONFIG_FILE}`);
  const hubOnly = named["hub-only"] !== undefined;
  if (hubOnly && (named["hub-only"] !== true || named.agent !== undefined || named.command !== undefined)) {
    return fail("--hub-only 不接参数，也不能同时选择本机 Agent 或 command");
  }
  const requestedPort = text(named.port) ?? "3350";
  const listen = text(named.listen) ?? `127.0.0.1:${requestedPort}`;
  const address = /^([a-zA-Z0-9.-]+):(\d+)$/.exec(listen);
  if (
    (named.listen !== undefined && !text(named.listen)) ||
    !address ||
    Number(address[2]) < 1 ||
    Number(address[2]) > 65535
  ) {
    return fail("listen 需要主机名或 IPv4 地址加有效端口，例如 127.0.0.1:3350");
  }
  if (named.listen !== undefined && named.port !== undefined && address[2] !== requestedPort)
    return fail("listen 与 port 的端口不一致");
  const url = `http://${address[1] === "0.0.0.0" ? "127.0.0.1" : address[1]}:${address[2]}`;
  const publicUrl = text(named["public-url"]) ?? url;
  try {
    const parsed = new URL(publicUrl);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (named["public-url"] !== undefined && !text(named["public-url"]))
    )
      throw new Error();
  } catch {
    return fail("public-url 需要不含账号、查询参数或片段的 HTTP(S) 地址");
  }
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if (!hubOnly) mkdirSync(path.join(HOME, "try"), { recursive: true });
  const hostName = hostname()
    .toLowerCase()
    .replace(/\.local$/, "");
  const worker = hostName.replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "this-machine";
  const agents = hubOnly ? {} : await agentsToUse(named, worker);
  if (!hubOnly && !Object.keys(agents).length) {
    return fail(
      "这台电脑上没找到 Claude Code 或 Codex。先装好并登录，" +
        "或者用 --command 指定别的命令行 Agent，比如 --command 'hermes chat -q {prompt}'",
    );
  }
  const ownRules = !existsSync(RULES_FILE);
  if (ownRules) {
    const initial = hubOnly
      ? { sources: { local: { name: "本机" } }, agents: {}, channels: {}, rules: [], elsewhere: [] }
      : starterRules(agents, Object.keys(agents)[0]);
    writeFileSync(RULES_FILE, `${JSON.stringify(initial, null, 2)}\n`);
  }
  const { addKey, rules: loadedRules } = await import("../host/runtime.ts");
  const sourceName = hubOnly
    ? Object.hasOwn(loadedRules.sources, "local")
      ? "local"
      : Object.keys(loadedRules.sources).find((name) => name !== "schedule")
    : "local";
  const config: Config = {
    url,
    hub: { listen, publicUrl },
    ...(!hubOnly && { worker: { name: worker, key: addKey("worker", worker) } }),
    ...(sourceName && { source: { name: sourceName, key: addKey("source", sourceName) } }),
    owner: addKey("owner", "owner"),
    // A channel only rules.json knows about, or only this file, would do nothing: it's on only if both are ours to write.
    ...(ownRules && !hubOnly && { channels: { desktop: { key: addKey("channel", "desktop") } } }),
  };
  writeConfig(config);
  if (!hubOnly) linkSkill();
  if (!named["no-service"]) installService();
  if (hubOnly) {
    console.log(
      `云中台已配置。\n  监听：${listen}\n  对外地址：${publicUrl}\n  规则：${RULES_FILE}\n\n${named["no-service"] ? `运行 ${howToRun()} up 启动中台。` : "系统服务已配置。"}请登记远端 worker 和任务规则，再为每个 worker 创建独立密钥。`,
    );
    return;
  }
  const names = Object.values(agents).map((agent) => agent.name);
  const reach = ownRules ? "  通道：桌面通知\n" : "";
  const run = howToRun();
  const next = named["no-service"]
    ? `先运行 ${run} up 启动中台，再开一个终端运行 ${run} try 跑一遍完整流程。`
    : `运行 ${run} try 跑一遍完整流程。`;
  console.log(`装好了。\n  Agent：${names.join("、")}\n${reach}  规则：${RULES_FILE}\n\n${next}`);
}

async function join(args: string[]) {
  const { named, rest } = flags(args);
  const [url] = rest;
  const name = text(named.worker);
  const key = text(named.key);
  if (!url || !name || !key) return fail("用法：agent-autoloop join <中台地址> --worker <名字> --key <密钥>");
  writeConfig({ url, worker: { name, key } });
  if (!named["no-service"]) installService();
  console.log(`这台电脑以 ${name} 的身份接活了。`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Card = { id: number; kind: string; title: string; text: string; options: string[]; recommend: number | null };

function showCard(card: Card) {
  console.log(`\n【${card.kind === "ask" ? "等你决定" : "要你留意"}】#${card.id} ${card.title}`);
  if (card.text) console.log(card.text);
  if (card.kind !== "ask") return;
  card.options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option}${index === card.recommend ? "（推荐）" : ""}`);
  });
}

const howToAnswer = (card: Card) =>
  card.kind === "ask" ? `回答：agent-autoloop answer ${card.id} <序号>` : `处理完了：agent-autoloop answer ${card.id}`;

async function chooseAt(terminal: ReturnType<typeof createInterface>, card: Card) {
  for (;;) {
    const choice = Number(await terminal.question("\n选几？"));
    if (Number.isInteger(choice) && choice >= 1 && choice <= card.options.length) return choice - 1;
    console.log(`输入 1 到 ${card.options.length}。`);
  }
}

async function tryIt() {
  const config = readConfig();
  if (!config.source) return fail("这台电脑上没有来源的密钥。");
  const owner = ownerClient(config);
  const stamp = Date.now();
  await client(config.source.key, config)
    .event({ id: `try-${stamp}`, type: "try.start", subject: `#${stamp}` })
    .catch((error) => fail(`连不上中台（${error.message}）：先 agent-autoloop up 或 agent-autoloop service install`));
  console.log("事件发出去了，Agent 开始干活……");
  let asked: number | null = null;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const state = await owner.state();
    const failed = state.runs.find(
      (run: { rule: string; state: string; attempts: number; error: string }) =>
        run.rule === "试一下" && run.state === "queued" && run.attempts > 0,
    );
    if (failed) return fail(`Agent 没跑成：${failed.error}\n运行 agent-autoloop doctor 看看。`);
    if (asked === null) {
      const card: Card | undefined = state.cards.find(
        (open: Card) => open.kind === "ask" && open.title.startsWith("试跑"),
      );
      if (!card) continue;
      asked = card.id;
      console.log("\nAgent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。");
      showCard(card);
      if (!process.stdin.isTTY) {
        console.log(`${howToAnswer(card)}\n答完运行 agent-autoloop status，能看到它接着把活干完。`);
        return;
      }
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const choice = await chooseAt(terminal, card);
      terminal.close();
      await owner.answer(card.id, { choice });
      console.log("收到，Agent 接着干……");
      continue;
    }
    const done = state.recentCards.find(
      (card: { id: number; state: string }) => card.id === asked && card.state === "done",
    );
    if (done) {
      console.log(
        `它把活干完了：${done.result}\n\n通了。接下来把 ${RULES_FILE} 改成你自己的规则，或者跟你的 Agent 说一句。`,
      );
      return;
    }
  }
  fail("五分钟没等到结果。运行 agent-autoloop doctor 看看。");
}

const RUN_STATES: Record<string, string> = {
  claimed: "在跑",
  queued: "排队",
  done: "做完了",
  nothing: "没事可做",
  unknown: "不确定",
  cancelled: "停了",
};

async function status() {
  const owner = ownerClient();
  const state = await owner.state();
  const { totals } = state;
  const clock = { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  const at = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: state.timezone, ...clock });
  console.log(
    `在跑 ${totals.running} · 排队 ${totals.queued} · 今天做完 ${totals.doneToday} · 等你 ${state.cards.length}`,
  );
  console.log(`${spendLine(state.spending)}\n`);
  for (const agent of state.agents) console.log(`${agent.online ? "●" : "○"} ${agent.name}（${agent.worker}）`);
  for (const channel of state.channels) console.log(`${channel.online ? "●" : "○"} ${channel.name}`);
  for (const card of state.cards) {
    showCard(card);
    console.log(howToAnswer(card));
  }
  const timed = [...state.lines.filter((line: { every: string | null }) => line.every), ...state.elsewhere];
  if (timed.length) console.log("\n定时");
  for (const { name, where, every, next } of timed) {
    console.log(`  ${name}${where ? `（在别处：${where}）` : ""}：${every}，下次 ${at(next)}`);
  }
  if (state.recentCards.length) console.log("\n最近的卡片");
  for (const card of state.recentCards.slice(0, 5)) {
    const chosen = card.choice !== null ? card.options[card.choice] : card.answer;
    console.log(`  #${card.id} ${card.title}：${[chosen, card.result].filter(Boolean).join("。") || card.text}`);
  }
  if (state.runs.length) console.log("\n最近几轮");
  for (const run of state.runs.slice(0, 8)) {
    const shown = run.state === "queued" && run.attempts > 0 ? "等重派" : (RUN_STATES[run.state] ?? run.state);
    const outcome = run.summary || run.error;
    console.log(`  #${run.id} ${run.rule} ${shown}${outcome ? `：${outcome}` : ""}`);
  }
  if (state.unrouted.length) console.log("\n没有规则接的事件");
  for (const { source, type, subject, summary } of state.unrouted.slice(0, 5)) {
    console.log(`  ${source} ${type} ${subject}${summary ? `：${summary}` : ""}`);
  }
}

async function answer(args: string[]) {
  const { named, rest } = flags(args);
  const card = Number(rest[0]);
  if (!Number.isInteger(card) || card < 1) return fail("用法：agent-autoloop answer <卡片> [序号] [--text 别的想法]");
  const words = text(named.text);
  const done = await ownerClient().answer(card, {
    ...(rest[1] !== undefined && { choice: Number(rest[1]) - 1 }),
    ...(words && { text: words }),
  });
  console.log(
    !done.changed
      ? "这张卡片已经处理过了，这次没有改动。"
      : done.state === "closed"
        ? "结案了。"
        : "收到，Agent 接着干。",
  );
}

async function resolve(args: string[]) {
  const [id, ...words] = args;
  const card = Number(id);
  if (!Number.isInteger(card) || card < 1 || !words.length) return fail("用法：agent-autoloop resolve <卡片> <结果>");
  const { changed } = await ownerClient().resolve(card, words.join(" "));
  console.log(changed ? "结案了。" : "这张卡片已经处理过了，这次没有改动。");
}

async function doctor() {
  let bad = 0;
  const say = (ok: boolean, words: string) => {
    console.log(`${ok ? "●" : "○"} ${words}`);
    if (!ok) bad += 1;
  };
  say(Number(process.versions.node.split(".")[0]) >= 24, `Node ${process.versions.node}`);
  if (!existsSync(CONFIG_FILE)) return say(false, "还没装好：运行 agent-autoloop init");
  const config = readConfig();
  if (config.hub) {
    const { parseRules } = await importRules();
    try {
      parseRules(readFileSync(RULES_FILE, "utf8"));
      say(true, `规则 ${RULES_FILE}`);
    } catch (error) {
      say(false, (error as Error).message);
    }
  }
  say(serviceRunning(), serviceRunning() ? "系统服务在跑" : "系统服务没在跑：agent-autoloop service install");
  try {
    const health = await (await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(5000) })).json();
    say(health.ok === true, `中台 ${config.url}（${String(health.commit).slice(0, 12)}）`);
  } catch (error) {
    say(false, `连不上中台 ${config.url}：${(error as Error).message}`);
  }
  if (config.owner) {
    try {
      const state = await ownerClient(config).state();
      for (const agent of state.agents) {
        say(agent.online, `${agent.name}（${agent.worker}）${agent.online ? "在线" : "不在线"}`);
        if (agent.worker === config.worker?.name) {
          const { adapterFor } = await import("../worker/agents.ts");
          const problem = await adapterFor(agent.use).then(
            (adapter) => adapter.check?.() ?? null,
            (error) => String(error.message),
          );
          say(!problem, problem ?? `${agent.name} 可以用`);
        }
      }
      for (const channel of state.channels) say(channel.online, `${channel.name}${channel.online ? "在线" : "不在线"}`);
      const manual = path.join(ROOT, "skills", "agent-autoloop", "SKILL.md");
      if (!state.channels.length) {
        console.log(`○ 还没接通道：Agent 问你时不会主动告诉你，要自己运行 agent-autoloop status 看。接法见 ${manual}`);
      } else if (state.channels.length === 1 && state.channels[0].id === "desktop") {
        console.log(
          "○ 只接了桌面通知：Agent 问你时只有这台电脑会弹通知，人不在电脑前、或者电脑没有图形界面就看不到。" +
            `要发到飞书、钉钉这些地方，接法见 ${manual}`,
        );
      }
    } catch (error) {
      say(false, `读不到中台状态：${(error as Error).message}`);
    }
  }
  if (bad) process.exit(1);
}

/** The rules module reads the rules file as it loads; the checks here need to survive a bad one. */
async function importRules() {
  try {
    return await import("../host/runtime.ts");
  } catch (error) {
    fail((error as Error).message);
    throw error;
  }
}

async function check() {
  const { parseRules } = await importRules();
  parseRules(readFileSync(RULES_FILE, "utf8"));
  console.log("规则没问题。");
}

async function key(args: string[]) {
  const [action, kind, name] = args;
  if (action === "remove") {
    await ownerClient().removeKey(kind, name);
    console.log("密钥已失效。");
    return;
  }
  const { addKey, listKeys } = await import("../host/runtime.ts");
  if (action === "list") {
    for (const row of listKeys()) console.log(`${row.kind} ${row.name} ${row.created_at}`);
    return;
  }
  if (action !== "new" || !["source", "worker", "channel", "owner"].includes(kind) || !name) {
    return fail("用法：agent-autoloop key new <source|worker|channel|owner> <名字>");
  }
  console.log(addKey(kind as "source", name));
}

async function emit(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const type = rest[0] ?? fail("用法：agent-autoloop emit <类型>");
  const secret = text(named.key) ?? config.source?.key ?? fail("这台电脑上没有来源的密钥：用 --key");
  const answer = await client(secret, config).event({
    id: text(named.id) ?? randomUUID(),
    type,
    ...(text(named.subject) && { subject: text(named.subject) }),
    ...(text(named.summary) && { summary: text(named.summary) }),
    ...(text(named.detail) && { detail: text(named.detail) }),
    ...(text(named.link) && { link: text(named.link) }),
  });
  console.log(answer.routed.length ? `交给了：${answer.routed.join("、")}` : "记下了，没有规则接它。");
}

async function tell(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const matter = rest[0] ?? fail("用法：agent-autoloop tell <编号> [--task 定时任务名]，内容从标准输入读");
  const words = readFileSync(0, "utf8").trim();
  if (!words) return fail("要说的话从标准输入传，不能为空。");
  const task = text(named.task);
  const secret = task ? config.worker?.key : config.source?.key;
  if (!secret) return fail(task ? "这台电脑不是接单程序" : "这台电脑上没有来源的密钥");
  const answer = await client(secret, config).tell({ key: matter, text: words, ...(task && { task }) });
  console.log(answer.duplicate ? "这件事已经说过了，这次没再发。" : "说了。");
}

async function why(args: string[]) {
  const id = Number(args[0]);
  const facts = await ownerClient().why(id);
  if (args.includes("--json")) return console.log(JSON.stringify(facts, null, 2));
  const { formatWhy } = await import("./why.ts");
  console.log(formatWhy(id, facts));
}

async function checkConformance(args: string[]) {
  const { named, rest } = flags(args);
  const file = text(named.config) ?? process.env.AGENT_AUTOLOOP_CONFORMANCE;
  if (!rest[0] || !file) return fail("用法：agent-autoloop conformance <测试中台地址> --config <测试凭据文件>");
  const { conformance } = await import("../protocol/conformance.ts");
  console.log(JSON.stringify(await conformance(rest[0], JSON.parse(readFileSync(file, "utf8"))), null, 2));
}

async function stop(args: string[]) {
  await ownerClient().cancel(Number(args[0]));
  console.log("通知它停了。");
}

async function projectTask(args: string[]) {
  const [action, ...inputArgs] = args;
  if (!["submit", "status", "cancel", "recheck"].includes(action))
    return fail("用法：task submit|status|cancel|recheck");
  const values = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < inputArgs.length; i++) {
    const argument = inputArgs[i];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const allowed =
      action === "submit"
        ? ["--json", "--file", "--source"]
        : action === "status"
          ? ["--json"]
          : ["--json", "--request-id"];
    if (!allowed.includes(argument) || values.has(argument)) return fail(`不支持或重复的参数：${argument}`);
    if (argument === "--json") values.set(argument, true);
    else {
      const value = inputArgs[++i];
      if (!value?.trim() || value.startsWith("--")) return fail(`${argument} 需要一个值`);
      values.set(argument, value);
    }
  }
  const config = readConfig();
  let result: any;
  if (action === "submit") {
    if (positional.length) return fail("task submit 使用 --file 或标准输入提供任务 JSON");
    const file = values.get("--file");
    let body: any;
    try {
      body = JSON.parse(readFileSync(typeof file === "string" ? file : 0, "utf8"));
    } catch {
      return fail("任务输入必须是合法的 JSON 对象");
    }
    const source = values.get("--source");
    if (typeof source === "string") {
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        (body.source !== undefined && body.source !== source)
      )
        return fail("source 与任务 JSON 不一致");
      body.source = source;
    }
    const useOwner = body?.source !== undefined || !config.source;
    if (useOwner && !config.owner) return fail("指定 source 提交需要本人的密钥");
    if (!useOwner && !config.source) return fail("这台电脑没有可提交任务的来源");
    const parsed = parseProjectTaskInput(body, useOwner);
    result = await hubClient(config.url, useOwner ? config.owner! : config.source!.key).submitProjectTask(parsed);
  } else {
    if (positional.length !== 1 || !positional[0].trim()) return fail(`task ${action} 需要一个任务编号`);
    const hub = ownerClient(config);
    if (action === "status") result = await hub.projectTask(positional[0]);
    else {
      const requestId = values.get("--request-id");
      if (typeof requestId !== "string" || !requestId.trim() || [...requestId].length > 200)
        return fail("--request-id 必填，重试使用同一个请求编号，最多 200 个字");
      const request = { request_id: requestId };
      result =
        action === "cancel"
          ? await hub.cancelProjectTask(positional[0], request)
          : await hub.recheckProjectTask(positional[0], request);
    }
  }
  if (values.has("--json")) return console.log(JSON.stringify(result, null, 2));
  const labels: Record<string, string> = {
    queued: "待执行",
    running: "执行中",
    waiting_human: "等待决定",
    cancel_requested: "正在停止",
    unknown: "状态待核对",
    completed: "已验收",
    failed: "未完成",
    cancelled: "已停止",
  };
  const state = result.state ?? result.task?.state;
  console.log(
    `项目任务 ${result.task_id ?? positional[0]}：${labels[state] ?? state ?? "已登记"}${result.duplicate ? "（同一请求已记录）" : ""}`,
  );
}

function service(args: string[]) {
  if (args[0] === "install") return installService();
  if (args[0] === "remove") return removeService();
  fail("用法：agent-autoloop service install|remove");
}

/** A plugin is a folder of its own under this install, named after its repository. */
function addPlugin(args: string[]) {
  const url = args[0] ?? fail("用法：agent-autoloop add <git 地址>");
  const name = url
    .replace(/\/$/, "")
    .split(/[/:]/)
    .at(-1)!
    .replace(/\.git$/, "")
    .toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail("插件仓库名要用小写字母、数字和 -");
  mkdirSync(path.join(HOME, "plugins"), { recursive: true });
  const clone = spawnSync("git", ["clone", "--", url, path.join(HOME, "plugins", name)], { stdio: "inherit" });
  if (clone.status !== 0) fail("安装失败。");
  console.log(`已安装 ${name}。`);
}

async function update() {
  const pulled = spawnSync("git", ["-C", ROOT, "pull", "--ff-only"], { stdio: "inherit" });
  if (pulled.status !== 0) return fail("更新失败。");
  if (serviceRunning()) installService();
  console.log("更新好了。");
}

async function askAtTerminal(question: string) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(question);
  terminal.close();
  return answer;
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
  mcp: async () => (await import("./mcp.ts")).mcp(),
  add: () => addPlugin(args),
  init: () => init(args),
  join: () => join(args),
  up: async () => (await import("../host/up.ts")).up(),
  try: tryIt,
  status,
  why: () => why(args),
  conformance: () => checkConformance(args),
  answer: () => answer(args),
  resolve: () => resolve(args),
  doctor,
  check,
  key: () => key(args),
  emit: () => emit(args),
  tell: () => tell(args),
  stop: () => stop(args),
  task: () => projectTask(args),
  update,
  uninstall: async () => {
    const { uninstall } = await import("./uninstall.ts");
    await uninstall(flags(args).named.yes !== undefined, process.stdin.isTTY ? askAtTerminal : null);
  },
  service: () => service(args),
  help: () => console.log(HELP),
  "--version": () => console.log(versionLine()),
};
if (!command || !commands[command]) {
  console.log(HELP);
  if (command) process.exit(1);
} else {
  Promise.resolve()
    .then(commands[command])
    .catch((error) => fail(error.message ?? String(error)));
}
