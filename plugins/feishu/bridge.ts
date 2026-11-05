// A separate, owner-operated Feishu ingress. It uses the official CLI's shared event bus; neither the kernel nor
// a model receives Feishu credentials. Chat text supplies task data, never executable routing configuration.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

type Route = { kind: "event" | "workflow"; type: string; acceptance?: string[] };
export type BridgeConfig = {
  hub_url: string;
  source: { name: string; key_file: string };
  owner_key_file?: string;
  lark?: string;
  state_dir: string;
  pairing?: { sha256: string; expires_at: string };
  routes: Record<string, Route>;
  devices?: { id: string; label: string }[];
};
type Message = {
  type: string;
  message_id: string;
  chat_id: string;
  chat_type: string;
  sender_id: string;
  sender_type: string;
  message_type: string;
  content: string;
};
type Reply = { text: string; key: string; sent: boolean };
type RecordedMessage = { fingerprint: string; reply?: Reply; order?: string };
type Order = {
  id: string;
  message_id: string;
  user: string;
  chat: string;
  kind: "event" | "workflow";
  body: Record<string, any>;
  state: "pending" | "accepted" | "rejected";
  task_id?: string;
  event_id?: number;
  routed?: string[];
  rejected_status?: number;
  stop_fenced?: boolean;
};
type State = {
  version: 1;
  hub_url: string;
  source: string;
  binding?: { user: string; chat: string };
  messages: Record<string, RecordedMessage>;
  orders: Record<string, Order>;
};
type Options = {
  send?: (chat: string, text: string, key: string) => Promise<void>;
  log?: (line: string) => void;
  signal?: AbortSignal;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const HELP =
  "指令：帮助、路线、设备、下单 <路线别名>（下一行写目标）、查询 <订单编号>、停止 <订单编号>、复查 <订单编号>。目录、设备和模型由管理员登记的路线决定。";
const DEFAULT_ACCEPTANCE = ["完成目标并报告验证结果；无法完成时明确说明阻断。"];

function privateFile(file: string) {
  if (!path.isAbsolute(file)) throw new Error("private file path must be absolute");
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("private file must be owned by this user with mode 0600");
  }
  const parent = lstatSync(path.dirname(file));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o777) !== 0o700 ||
    (process.getuid && parent.uid !== process.getuid())
  ) {
    throw new Error("private file parent must be owned by this user with mode 0700");
  }
  return readFileSync(file, "utf8");
}

function privateDirectory(dir: string) {
  if (!path.isAbsolute(dir)) throw new Error("private directory path must be absolute");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("private directory must be owned by this user with mode 0700");
  }
}

function keyFrom(file: string) {
  const key = privateFile(file).trim();
  if (!key || /\s/.test(key)) throw new Error("invalid private key file");
  return key;
}

export function loadBridgeConfig(file: string): BridgeConfig {
  const config = JSON.parse(privateFile(file));
  if (
    !object(config) ||
    !object(config.source) ||
    !/^[a-z][a-z0-9-]*$/.test(config.source.name ?? "") ||
    !object(config.routes)
  ) {
    throw new Error("invalid bridge configuration");
  }
  const url = new URL(config.hub_url);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
  ) {
    throw new Error("Hub requires HTTPS or loopback HTTP");
  }
  config.hub_url = url.origin;
  if (
    typeof config.state_dir !== "string" ||
    !path.isAbsolute(config.state_dir) ||
    (config.lark !== undefined && (typeof config.lark !== "string" || !config.lark))
  ) {
    throw new Error("invalid private bridge paths");
  }
  keyFrom(config.source.key_file);
  if (config.owner_key_file !== undefined) keyFrom(config.owner_key_file);
  if (
    config.pairing !== undefined &&
    (!object(config.pairing) ||
      !/^[0-9a-f]{64}$/.test(config.pairing.sha256 ?? "") ||
      !Number.isFinite(Date.parse(config.pairing.expires_at)))
  ) {
    throw new Error("invalid pairing configuration");
  }
  for (const [alias, route] of Object.entries(config.routes)) {
    if (
      !/^[\p{L}\p{N}_.-]{1,40}$/u.test(alias) ||
      !object(route) ||
      !["event", "workflow"].includes(route.kind) ||
      !/^[a-z][a-z0-9_.-]{0,99}$/.test(route.type ?? "") ||
      Object.keys(route).some((key) => !["kind", "type", "acceptance"].includes(key)) ||
      (route.acceptance !== undefined &&
        (!Array.isArray(route.acceptance) ||
          !route.acceptance.length ||
          route.acceptance.length > 20 ||
          route.acceptance.some((item: unknown) => typeof item !== "string" || !item.trim() || item.length > 2000)))
    ) {
      throw new Error("invalid trusted bridge route");
    }
  }
  if (
    config.devices !== undefined &&
    (!Array.isArray(config.devices) ||
      config.devices.some(
        (device: unknown) =>
          !object(device) ||
          typeof device.id !== "string" ||
          typeof device.label !== "string" ||
          device.label.length > 100,
      ))
  ) {
    throw new Error("invalid registered device labels");
  }
  return config as BridgeConfig;
}

function writePrivate(file: string, value: unknown) {
  if (existsSync(file)) privateFile(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
  const directory = openSync(path.dirname(file), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

class HubFailure extends Error {
  status: number;
  constructor(status: number) {
    super("Hub request failed");
    this.status = status;
  }
}

export class Bridge {
  readonly config: BridgeConfig;
  readonly state: State;
  readonly signal?: AbortSignal;
  private readonly file: string;
  private readonly lock: string;
  private readonly sourceKey: string;
  private readonly ownerKey?: string;
  private readonly options: Options;
  private readonly lockNonce = randomUUID();
  private locked = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(config: BridgeConfig, options: Options = {}) {
    this.config = config;
    this.options = options;
    this.signal = options.signal;
    this.sourceKey = keyFrom(config.source.key_file);
    this.ownerKey = config.owner_key_file ? keyFrom(config.owner_key_file) : undefined;
    privateDirectory(config.state_dir);
    this.file = path.join(config.state_dir, "state.json");
    this.lock = path.join(config.state_dir, "runner.lock");
    if (existsSync(this.lock)) {
      const previous = JSON.parse(privateFile(this.lock));
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error("invalid bridge lock");
      try {
        process.kill(previous.pid, 0);
        throw new Error("bridge state already running (lock)");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      unlinkSync(this.lock);
    }
    const lock = openSync(this.lock, "wx", 0o600);
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: this.lockNonce }));
      fsyncSync(lock);
    } finally {
      closeSync(lock);
    }
    this.locked = true;
    try {
      this.state = existsSync(this.file)
        ? JSON.parse(privateFile(this.file))
        : {
            version: 1,
            hub_url: config.hub_url,
            source: config.source.name,
            messages: {},
            orders: {},
          };
      if (
        this.state.version !== 1 ||
        this.state.hub_url !== config.hub_url ||
        this.state.source !== config.source.name ||
        !object(this.state.messages) ||
        !object(this.state.orders) ||
        (this.state.binding &&
          (!/^ou_[A-Za-z0-9_-]+$/.test(this.state.binding.user) ||
            !/^oc_[A-Za-z0-9_-]+$/.test(this.state.binding.chat)))
      ) {
        throw new Error("invalid or foreign private bridge state");
      }
      this.save();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    if (!this.locked) return;
    try {
      const current = JSON.parse(privateFile(this.lock));
      if (current.pid === process.pid && current.nonce === this.lockNonce) unlinkSync(this.lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.locked = false;
  }

  private save() {
    writePrivate(this.file, this.state);
  }

  private async hub(method: string, endpoint: string, body?: unknown, owner = false): Promise<any> {
    const key = owner ? this.ownerKey : this.sourceKey;
    if (!key) throw new HubFailure(401);
    const signals = [AbortSignal.timeout(10_000), ...(this.signal ? [this.signal] : [])];
    const response = await fetch(`${this.config.hub_url}${endpoint}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) throw new HubFailure(response.status);
    return response.json();
  }

  private async send(chat: string, text: string, key: string) {
    if (this.options.send) return this.options.send(chat, text, key);
    const args = [
      "im",
      "+messages-send",
      "--chat-id",
      chat,
      "--as",
      "bot",
      "--msg-type",
      "text",
      "--idempotency-key",
      key,
      "--content",
      "-",
    ];
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        this.config.lark ?? "lark-cli",
        args,
        { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, signal: this.signal },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.on("error", reject);
      child.stdin!.end(JSON.stringify({ text }));
    });
    const result = JSON.parse(output);
    if (result.ok !== true || result.error) throw new Error("Feishu reply failed");
  }

  private async reply(message: Message, record: RecordedMessage, text: string) {
    if (!record.reply) {
      record.reply = { text, key: `autoloop-reply-${hash(message.message_id).slice(0, 24)}`, sent: false };
      this.save();
    }
    if (record.reply.sent || this.signal?.aborted) return;
    try {
      await this.send(message.chat_id, record.reply.text, record.reply.key);
      record.reply.sent = true;
      this.save();
    } catch {
      this.options.log?.("feishu_bridge_reply_failed");
    }
  }

  handleMessage(value: unknown): Promise<void> {
    const next = this.queue.then(() => this.processMessage(value));
    this.queue = next.catch(() => {
      this.options.log?.("feishu_bridge_message_failed");
    });
    return next;
  }

  private async processMessage(value: unknown) {
    if (
      !this.locked ||
      this.signal?.aborted ||
      !object(value) ||
      value.type !== "im.message.receive_v1" ||
      value.sender_type !== "user" ||
      !["text", "post"].includes(value.message_type) ||
      value.chat_type !== "p2p" ||
      typeof value.content !== "string" ||
      value.content.length > 5000 ||
      !/^om_[A-Za-z0-9_-]{1,200}$/.test(value.message_id ?? "") ||
      !/^ou_[A-Za-z0-9_-]+$/.test(value.sender_id ?? "") ||
      !/^oc_[A-Za-z0-9_-]+$/.test(value.chat_id ?? "")
    )
      return;
    const message = value as Message;
    const binding = this.state.binding;
    if (binding ? binding.user !== message.sender_id || binding.chat !== message.chat_id : message.chat_type !== "p2p")
      return;
    const fingerprint = hash(JSON.stringify([message.sender_id, message.chat_id, message.content]));
    const existing = this.state.messages[message.message_id];
    if (existing) {
      if (existing.fingerprint !== fingerprint) return;
      if (existing.order) {
        const order = this.state.orders[existing.order];
        if (order?.state === "pending") await this.submit(order);
        if (order && !existing.reply) await this.reply(message, existing, this.submissionText(order));
        if (existing.reply) await this.reply(message, existing, existing.reply.text);
        return;
      }
      if (existing.reply) {
        await this.reply(message, existing, existing.reply.text);
        return;
      }
    }
    const record: RecordedMessage = existing ?? { fingerprint };
    this.state.messages[message.message_id] = record;
    this.save();
    const text = message.content.trim();
    if (!binding) {
      const pairing = /^配对\s+(\S{1,200})$/.exec(text);
      if (pairing) {
        const expected = this.config.pairing;
        if (
          !expected ||
          Date.parse(expected.expires_at) <= Date.now() ||
          !timingSafeEqual(Buffer.from(hash(pairing[1]), "hex"), Buffer.from(expected.sha256, "hex"))
        ) {
          await this.reply(message, record, "配对码无效或已过期，请联系部署者生成新码。");
          return;
        }
        this.state.binding = { user: message.sender_id, chat: message.chat_id };
        await this.reply(message, record, `配对成功，后续仅接受你在当前私聊的指令。${HELP}`);
      } else if (text === "帮助" || text === "hi") {
        await this.reply(message, record, "尚未配对。请在当前私聊发送：配对 <部署者提供的一次性配对码>。");
      }
      return;
    }
    if (text === "帮助" || text === "hi") return this.reply(message, record, HELP);
    if (text === "路线") {
      const routes = Object.keys(this.config.routes);
      return this.reply(
        message,
        record,
        routes.length
          ? `已登记路线：${routes.join("、")}。下单时下一行写目标。`
          : "尚未登记任务路线，当前不会派发任务。请先登记目标设备、本机工作区和就绪模型。",
      );
    }
    if (text === "设备") {
      const labels = this.config.devices?.map((device) => device.label) ?? [];
      return this.reply(
        message,
        record,
        `已登记设备：${labels.length ? labels.join("、") : "暂无"}。登记不代表在线，也不代表模型或工作区已就绪。`,
      );
    }
    const orderCommand = /^下单\s+([^\s]+)\s*\n([\s\S]+)$/.exec(text);
    if (orderCommand) {
      const route = Object.hasOwn(this.config.routes, orderCommand[1])
        ? this.config.routes[orderCommand[1]]
        : undefined;
      const goal = orderCommand[2].trim();
      if (!route) return this.reply(message, record, "这条路线尚未登记，未派发任务。发送“路线”查看可用入口。");
      if (!goal || goal.length > 4000) return this.reply(message, record, "目标需要 1 至 4000 字，写在路线下一行。");
      const digest = hash(`${this.config.source.name}\0${message.message_id}`);
      const id = `O${digest.slice(0, 24)}`;
      const body =
        route.kind === "workflow"
          ? {
              id: `feishu:${digest}`,
              type: route.type,
              subject: `feishu:${digest}`,
              goal,
              acceptance: route.acceptance ?? DEFAULT_ACCEPTANCE,
            }
          : {
              id: `feishu:${digest}`,
              type: route.type,
              subject: `feishu:${digest}`,
              summary: "飞书手动任务",
              detail: goal,
            };
      const order: Order = {
        id,
        message_id: message.message_id,
        user: message.sender_id,
        chat: message.chat_id,
        kind: route.kind,
        body,
        state: "pending",
      };
      this.state.orders[id] = order;
      record.order = id;
      this.save();
      await this.submit(order);
      return this.reply(message, record, this.submissionText(order));
    }
    const management = /^(查询|停止|复查)\s+(O[0-9a-f]{24})$/.exec(text);
    if (management) {
      const order = this.state.orders[management[2]];
      if (!order || order.user !== message.sender_id || order.chat !== message.chat_id)
        return this.reply(message, record, "没有属于当前用户及对话的这笔订单。");
      if (!this.ownerKey) return this.reply(message, record, "尚未配置服务端管理凭据，当前只能提交任务。");
      try {
        if (order.state === "pending" && management[1] === "停止") {
          order.stop_fenced = true;
          this.save();
          return this.reply(message, record, this.submissionText(order));
        }
        if (order.state === "pending" && management[1] !== "查询")
          return this.reply(
            message,
            record,
            `订单 ${order.id}：原下单结果尚未确认，本次不会重交原任务或发送停止/复查；请先查询或联系管理员核查。`,
          );
        if (order.state === "pending") await this.submit(order);
        if (order.state !== "accepted") return this.reply(message, record, this.submissionText(order));
        const outcome =
          order.kind === "workflow"
            ? await this.manageWorkflow(order, management[1], message.message_id)
            : await this.manageEvent(order, management[1]);
        return this.reply(message, record, outcome);
      } catch (error) {
        if (
          error instanceof HubFailure &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 429
        )
          return this.reply(
            message,
            record,
            `订单 ${order.id}：Hub 拒绝本次操作（HTTP ${error.status}），请查询当前状态或联系管理员。`,
          );
        return this.reply(message, record, `订单 ${order.id}：操作结果尚未确认。请查询确认，停止请求不代表已经停止。`);
      }
    }
    return this.reply(message, record, `未识别指令。${HELP}`);
  }

  private async submit(order: Order) {
    if (order.stop_fenced) return;
    try {
      const result = await this.hub("POST", order.kind === "workflow" ? "/v1/project-tasks" : "/v1/events", order.body);
      if (order.kind === "workflow") {
        if (!/^task_[0-9a-f]{32}$/.test(result.task_id ?? "")) throw new Error("invalid task response");
        order.task_id = result.task_id;
      } else {
        if (
          !Number.isSafeInteger(result.event) ||
          !Array.isArray(result.routed) ||
          result.routed.some((value: unknown) => typeof value !== "string")
        )
          throw new Error("invalid event response");
        order.event_id = result.event;
        order.routed = result.routed;
      }
      order.state = "accepted";
    } catch (error) {
      if (
        error instanceof HubFailure &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        order.state = "rejected";
        order.rejected_status = error.status;
      }
    }
    this.save();
  }

  private submissionText(order: Order) {
    if (order.stop_fenced)
      return `订单 ${order.id}：已记下停止意图，原下单结果仍未知；查询和原消息重发都不会重交任务，需管理员核查实际接收和停止结果。`;
    if (order.state === "pending")
      return `订单 ${order.id} 已登记，但 Hub 接收结果尚未确认；请查询此编号，不要重复下单。`;
    if (order.state === "rejected")
      return `订单 ${order.id} 被 Hub 拒绝（HTTP ${order.rejected_status}），未确认派发；请管理员检查路线及凭据。`;
    if (order.kind === "workflow") return `已提交订单 ${order.id}，任务编号 ${order.task_id}；后续可查询、停止或复查。`;
    if (!order.routed?.length) return `订单 ${order.id} 已被 Hub 记录，但没有匹配的任务规则，未派发。`;
    return `已提交订单 ${order.id}，Hub 匹配 ${order.routed.length} 条规则；可查询实际执行状态。`;
  }

  private async manageWorkflow(order: Order, action: string, messageId: string) {
    const endpoint = `/v1/project-tasks/${order.task_id}`;
    const task = await this.hub("GET", endpoint, undefined, true);
    if (
      task.task_id !== order.task_id ||
      task.source !== this.config.source.name ||
      task.source_id !== order.body.id ||
      task.input?.id !== order.body.id
    ) {
      return `订单 ${order.id}：任务归属无法核实，拒绝操作。`;
    }
    if (action === "查询") return `订单 ${order.id}，任务 ${order.task_id}：${this.taskState(task.state)}。`;
    const mutation = action === "停止" ? "cancel" : "recheck";
    const result = await this.hub(
      "POST",
      `${endpoint}/${mutation}`,
      { request_id: `feishu:${hash(`${messageId}\0${mutation}`)}` },
      true,
    );
    if (action === "停止")
      return `订单 ${order.id}：已请求停止，等待远端确认；当前${this.taskState(result.state ?? "cancel_requested")}。`;
    return `订单 ${order.id}：复查请求已接受，实际进度请查询。`;
  }

  private taskState(state: unknown) {
    const names: Record<string, string> = {
      queued: "排队中",
      running: "执行中",
      waiting_human: "等待人工处理",
      cancel_requested: "已请求停止，尚未确认停止",
      unknown: "执行状态未知，禁止自动重跑",
      completed: "工作流已完成",
      failed: "工作流失败",
      cancelled: "远端已确认停止",
    };
    return typeof state === "string" && Object.hasOwn(names, state) ? names[state] : "状态暂不可确认";
  }

  private async manageEvent(order: Order, action: string) {
    if (action === "停止")
      return `订单 ${order.id}：普通事件当前不支持通过飞书停止，请管理员核查处理。执行轮次可能在核查后重新排队并合并其他事件，本入口不会发送停止请求。`;
    if (action === "复查")
      return `订单 ${order.id}：普通事件任务不支持工作流复查，请单独下单；复查指令只适用于 Git 工作流。`;
    let before: number | undefined;
    const candidates = new Map<number, any>();
    for (let page = 0; page < 50; page++) {
      const state = await this.hub("GET", `/v1/state${before ? `?before=${before}` : ""}`, undefined, true);
      if (!Array.isArray(state.runs)) throw new Error("invalid state response");
      for (const run of state.runs)
        if (
          Number.isSafeInteger(run.id) &&
          Array.isArray(run.events) &&
          run.events.some(
            (event: any) => event.source === this.config.source.name && event.subject === order.body.subject,
          )
        )
          candidates.set(run.id, run);
      if (!state.hasMore || !Number.isSafeInteger(state.nextBefore)) break;
      before = state.nextBefore;
    }
    if (!candidates.size) return `订单 ${order.id}：Hub 已记录，暂未定位对应执行轮次；不据此判断已完成或未执行。`;
    const verified: { id: number; row: any }[] = [];
    for (const run of candidates.values()) {
      const facts = await this.hub("GET", `/v1/runs/${run.id}/why`, undefined, true);
      const related = new Map<string, any>();
      const events = new Map<number, any>();
      let current: any;
      if (!Array.isArray(facts)) throw new Error("invalid provenance response");
      for (const fact of facts)
        for (const change of fact.changes ?? []) {
          if (change.table === "run_events") {
            if (change.row) related.set(change.key, change.row);
            else related.delete(change.key);
          }
          if (change.table === "events" && change.row) events.set(change.row.id, change.row);
          if (change.table === "runs" && change.row?.id === run.id) current = change.row;
        }
      const own = [...related.values()].filter((relation) => relation.run_id === run.id);
      if (
        !current ||
        !own.length ||
        !own.every((relation) => {
          const event = events.get(relation.event_id);
          return (
            event?.source === this.config.source.name &&
            event.subject === order.body.subject &&
            event.key === order.body.id
          );
        })
      )
        return `订单 ${order.id}：执行轮次归属混合或无法核实，为安全起见拒绝读取详情及停止。`;
      verified.push({ id: run.id, row: current });
    }
    const names: Record<string, string> = {
      queued: "排队中",
      claimed: "执行中",
      unknown: "执行状态未知",
      done: "本轮已结束",
      nothing: "本轮无操作",
      cancelled: "本轮已停止",
    };
    return `订单 ${order.id}：${verified.map(({ id, row }) => `第 ${id} 轮${names[row.state] ?? "状态暂不可确认"}`).join("；")}。轮次结束不等同于业务目标验收完成。`;
  }
}

export async function runBridge(file: string, options: Omit<Options, "send"> = {}) {
  const config = loadBridgeConfig(file);
  const bridge = new Bridge(config, options);
  const log = options.log ?? (() => {});
  const child = spawn(config.lark ?? "lark-cli", ["event", "consume", "im.message.receive_v1", "--as", "bot"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let ready = false;
  let failed = false;
  let processing = Promise.resolve();
  const pending: string[] = [];
  const consume = (line: string) => {
    processing = processing.then(async () => {
      try {
        await bridge.handleMessage(JSON.parse(line));
      } catch {
        log("feishu_bridge_message_failed");
      }
    });
  };
  const errors = readline.createInterface({ input: child.stderr });
  errors.on("line", (line) => {
    if (line === "[event] ready event_key=im.message.receive_v1") {
      if (!ready) {
        ready = true;
        log("feishu_bridge_ready");
        for (const saved of pending.splice(0)) consume(saved);
      }
    } else if (/warn|error|fail/i.test(line)) log("feishu_bridge_transport_diagnostic");
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > 64 * 1024) {
      log("feishu_bridge_event_rejected");
      return;
    }
    if (ready) consume(line);
    else if (pending.length < 20) pending.push(line);
    else {
      failed = true;
      child.kill();
    }
  });
  const stop = () => {
    child.stdin.end();
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        options.signal?.aborted || code === 0 ? resolve() : reject(new Error("Feishu consumer stopped")),
      );
    });
    await processing;
    if ((!ready || failed) && !options.signal?.aborted) throw new Error("Feishu consumer not ready");
    if (!options.signal?.aborted) throw new Error("Feishu consumer exited unexpectedly");
  } finally {
    options.signal?.removeEventListener("abort", stop);
    lines.close();
    errors.close();
    try {
      await processing;
    } finally {
      bridge.close();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config" || !path.isAbsolute(args[1])) {
    console.error("用法：node plugins/feishu/bridge.ts --config /私有目录/config.json");
    process.exitCode = 1;
  } else {
    const stop = new AbortController();
    process.once("SIGTERM", () => stop.abort());
    process.once("SIGINT", () => stop.abort());
    runBridge(args[1], { signal: stop.signal, log: (line) => console.error(line) }).catch(() => {
      console.error("feishu_bridge_stopped_with_error");
      process.exitCode = 1;
    });
  }
}
