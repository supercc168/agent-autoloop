// `agent-autoloop mcp`: the hub's doors as MCP tools over stdio, using the keys already in this machine's config.json.
import { createInterface } from "node:readline";
import { readConfig } from "../host/config.ts";
import { hubClient, type Hub } from "../protocol/client.ts";
import { parseProjectTaskInput } from "../protocol/project-tasks.ts";

const positive = { type: "integer", minimum: 1 };
const string = { type: "string", minLength: 1 };
const specs = [
  ["status", "查看现在的事项和卡片", {}, []],
  ["why", "查看一轮的事件、规则和结果", { run: positive }, ["run"]],
  [
    "answer",
    "回答卡片；选项从 0 开始，也可以写自己的答案",
    { card: positive, choice: { type: "integer", minimum: 0 }, text: string },
    ["card"],
  ],
  ["resolve", "将卡片结案，写明已核实的结果", { card: positive, reason: string }, ["card", "reason"]],
  ["stop", "停止一轮", { run: positive }, ["run"]],
  [
    "emit",
    "用本机来源发送事件；相同编号只记一次",
    { id: string, type: string, subject: string, summary: string, detail: string, link: string },
    ["id", "type"],
  ],
  ["tell", "用本机来源发送通知；相同编号只发一次", { key: string, text: string }, ["key", "text"]],
  [
    "task_submit",
    "登记项目任务；重试沿用同一 id，验收条件与资料不改变执行路由",
    {
      id: { ...string, maxLength: 200 },
      type: string,
      subject: { type: "string", maxLength: 100 },
      goal: { ...string, maxLength: 20_000 },
      acceptance: { type: "array", minItems: 1, maxItems: 100, items: { ...string, maxLength: 2000 } },
      data: {},
      source: string,
    },
    ["id", "type", "subject", "goal", "acceptance"],
  ],
  ["task_status", "查看项目任务的阶段、证据和实际状态", { task_id: string }, ["task_id"]],
  [
    "task_cancel",
    "请求停止项目任务；状态可能仍是正在停止或待核对",
    { task_id: string, request_id: { ...string, maxLength: 200 } },
    ["task_id", "request_id"],
  ],
  [
    "task_recheck",
    "复查已登记项目任务；重试沿用同一 request_id",
    { task_id: string, request_id: { ...string, maxLength: 200 } },
    ["task_id", "request_id"],
  ],
] as const;

const usesSourceKey = (name: string) => ["emit", "tell"].includes(name);

function toolsFor(config: ReturnType<typeof readConfig>) {
  return specs
    .filter(([name]) =>
      name === "task_submit" ? config.source || config.owner : usesSourceKey(name) ? config.source : config.owner,
    )
    .map(([name, description, properties, required]) => ({
      name,
      description,
      inputSchema: {
        type: "object",
        properties,
        required: [...required, ...(name === "task_submit" && !config.source ? ["source"] : [])],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: ["status", "why", "task_status"].includes(name),
        destructiveHint: ["stop", "task_cancel"].includes(name),
      },
    }));
}
type Tool = ReturnType<typeof toolsFor>[number];

function validArguments(tool: Tool, args: any, config: ReturnType<typeof readConfig>) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (tool.name === "task_submit") {
    const useOwner = args.source !== undefined || !config.source;
    if (useOwner && !config.owner) return false;
    try {
      parseProjectTaskInput(args, useOwner);
      return true;
    } catch {
      return false;
    }
  }
  if (!tool.inputSchema.required.every((key) => Object.hasOwn(args, key))) return false;
  const properties = tool.inputSchema.properties as Record<string, any>;
  const fits = ([key, value]: [string, unknown]) => {
    const schema = properties[key];
    if (!schema) return false;
    if (schema.type === "integer") return Number.isSafeInteger(value) && (value as number) >= schema.minimum;
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      (schema.maxLength === undefined || [...value].length <= schema.maxLength)
    );
  };
  if (!Object.entries(args).every(fits)) return false;
  return tool.name !== "answer" || (args.choice !== undefined) !== (args.text !== undefined);
}

function callTool(hub: Hub, name: Tool["name"], args: any) {
  switch (name) {
    case "status":
      return hub.state();
    case "why":
      return hub.why(args.run);
    case "answer": {
      const { card, ...answer } = args;
      return hub.answer(card, answer);
    }
    case "resolve":
      return hub.resolve(args.card, args.reason);
    case "stop":
      return hub.cancel(args.run);
    case "emit":
      return hub.event(args);
    case "tell":
      return hub.tell(args);
    case "task_submit":
      return hub.submitProjectTask(args);
    case "task_status":
      return hub.projectTask(args.task_id);
    case "task_cancel":
      return hub.cancelProjectTask(args.task_id, { request_id: args.request_id });
    case "task_recheck":
      return hub.recheckProjectTask(args.task_id, { request_id: args.request_id });
  }
}

export async function mcp() {
  const config = readConfig();
  const tools = toolsFor(config);
  let initialized = false;
  let ready = false;
  const reply = (id: unknown, body: object) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  const refuse = (id: unknown, code: number, message: string) => reply(id, { error: { code, message } });

  async function answerCall(id: unknown, params: any) {
    const tool = tools.find((tool) => tool.name === params?.name);
    const args = params?.arguments ?? {};
    if (!tool || !validArguments(tool, args, config)) return refuse(id, -32602, "工具名或参数不正确");
    const source =
      usesSourceKey(tool.name) || (tool.name === "task_submit" && args.source === undefined && !!config.source);
    const hub = hubClient(config.url, source ? config.source!.key : config.owner!);
    try {
      const result = await callTool(hub, tool.name, args);
      reply(id, { result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      reply(id, { result: { isError: true, content: [{ type: "text", text: (error as Error).message }] } });
    }
  }

  for await (const line of createInterface({ input: process.stdin })) {
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      refuse(null, -32700, "不是 JSON");
      continue;
    }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      refuse(request?.id ?? null, -32600, "请求格式不正确");
      continue;
    }
    const { id, method, params } = request;
    if (id === undefined) {
      if (method === "notifications/initialized" && initialized) ready = true;
    } else if (method === "initialize") {
      if (!params?.protocolVersion || !params?.capabilities || !params?.clientInfo) {
        refuse(id, -32602, "缺少初始化参数");
        continue;
      }
      initialized = true;
      const serverInfo = { name: "agent-autoloop", version: "1.0.0" };
      reply(id, { result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo } });
    } else if (method === "ping") reply(id, { result: {} });
    else if (!ready) refuse(id, -32600, "先完成 initialize");
    else if (method === "tools/list") reply(id, { result: { tools } });
    else if (method === "tools/call") await answerCall(id, params);
    else refuse(id, -32601, "没有这个方法");
  }
}
