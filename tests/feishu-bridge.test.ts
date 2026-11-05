// Prevent unsolicited pairing, duplicate orders after transport failure, authority from chat text, and stopping
// another order's merged run. All Feishu and Hub traffic stays inside local fakes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bridge, loadBridgeConfig, runBridge } from "../plugins/feishu/bridge.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function waitForJson(file: string, ready: (value: any) => boolean = () => true) {
  return new Promise<any>((resolve, reject) => {
    const done = (error?: Error, value?: unknown) => {
      clearTimeout(deadline);
      unwatchFile(file, check);
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      try {
        const value = JSON.parse(readFileSync(file, "utf8"));
        if (ready(value)) done(undefined, value);
      } catch {}
    };
    watchFile(file, { interval: 20 }, check);
    const deadline = setTimeout(() => done(new Error("fake transport barrier timed out")), 30_000);
    check();
  });
}
const message = (id: string, content: string, extra = {}) => ({
  type: "im.message.receive_v1",
  message_id: id,
  chat_id: "oc_owner",
  chat_type: "p2p",
  sender_id: "ou_owner",
  sender_type: "user",
  message_type: "text",
  content,
  ...extra,
});

async function fixture(t: any, overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-bridge-"));
  chmodSync(dir, 0o700);
  const calls: { method: string; path: string; auth: string; body: any }[] = [];
  let handler = (_call: (typeof calls)[number]): { status?: number; body?: any } => ({ body: {} });
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const call = {
      method: req.method!,
      path: req.url!,
      auth: req.headers.authorization ?? "",
      body: text ? JSON.parse(text) : null,
    };
    calls.push(call);
    const reply = handler(call);
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source.key");
  const owner = join(dir, "owner.key");
  writeFileSync(source, "source-test", { mode: 0o600 });
  writeFileSync(owner, "owner-test", { mode: 0o600 });
  const configFile = join(dir, "config.json");
  const config = {
    hub_url: `http://127.0.0.1:${(server.address() as any).port}`,
    source: { name: "feishu-orders", key_file: source },
    owner_key_file: owner,
    state_dir: join(dir, "state"),
    pairing: { sha256: hash("pairing-test-code"), expires_at: "2099-01-01T00:00:00Z" },
    routes: {},
    devices: [{ id: "mini", label: "Mini" }],
    ...overrides,
  };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const replies: { chat: string; text: string; key: string }[] = [];
  const logs: string[] = [];
  const bridge = new Bridge(loadBridgeConfig(configFile), {
    send: async (chat, text, key) => {
      replies.push({ chat, text, key });
    },
    log: (line) => logs.push(line),
  });
  t.after(() => bridge.close());
  return {
    dir,
    configFile,
    config,
    bridge,
    calls,
    replies,
    logs,
    setHandler: (fn: typeof handler) => {
      handler = fn;
    },
  };
}

test("pairing is one-time, expiring, private, and bound to both sender and chat", async (t) => {
  const f = await fixture(t);
  await f.bridge.handleMessage(message("om_group", "配对 pairing-test-code", { chat_type: "group" }));
  await f.bridge.handleMessage(message("om_wrong", "配对 wrong"));
  assert.equal(f.calls.length, 0);
  assert.match(f.replies.at(-1)!.text, /无效|过期/);
  await f.bridge.handleMessage(message("om_pair", "配对 pairing-test-code"));
  assert.match(f.replies.at(-1)!.text, /配对成功/);
  const count = f.replies.length;
  await f.bridge.handleMessage(message("om_other_user", "设备", { sender_id: "ou_other" }));
  await f.bridge.handleMessage(message("om_other_chat", "设备", { chat_id: "oc_other" }));
  await f.bridge.handleMessage(message("om_bot", "设备", { sender_type: "bot" }));
  assert.equal(f.replies.length, count);
  await f.bridge.handleMessage(message("om_devices", "设备"));
  assert.match(f.replies.at(-1)!.text, /Mini/);
  assert.match(f.replies.at(-1)!.text, /不代表在线/);
  assert.doesNotMatch(readFileSync(join(f.config.state_dir, "state.json"), "utf8"), /pairing-test-code/);
  assert.deepEqual(f.logs, [
    "feishu_bridge_rejected_chat_type",
    "feishu_bridge_rejected_access",
    "feishu_bridge_rejected_access",
    "feishu_bridge_rejected_sender_type",
  ]);
});

test("rejected wire shapes report only fixed categories and cannot bind, submit, or reply", async (t) => {
  const f = await fixture(t);
  const cases: [unknown, string][] = [
    [null, "shape"],
    [message("om_private_fixture", "private fixture text", { type: "private-event-value" }), "event_type"],
    [message("om_private_fixture", "private fixture text", { sender_type: "bot" }), "sender_type"],
    [message("om_private_fixture", "private fixture text", { chat_type: "group" }), "chat_type"],
    [message("om_private_fixture", "private fixture text", { message_type: "image" }), "message_type"],
    [
      message("om_private_fixture", "private fixture text", { content: { text: "private fixture text" } }),
      "content_type",
    ],
    [message("om_private_fixture", "x".repeat(5001)), "content_length"],
    [message("private-message-value", "private fixture text"), "message_id"],
    [message("om_private_fixture", "private fixture text", { sender_id: "private-sender-value" }), "sender_id"],
    [message("om_private_fixture", "private fixture text", { chat_id: "private-chat-value" }), "chat_id"],
  ];
  for (const [event] of cases) await f.bridge.handleMessage(event);
  assert.deepEqual(
    f.logs,
    cases.map(([, reason]) => `feishu_bridge_rejected_${reason}`),
  );
  assert.equal(f.bridge.state.binding, undefined);
  assert.equal(Object.keys(f.bridge.state.messages).length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.replies.length, 0);
  assert.ok(f.logs.every((line) => /^feishu_bridge_rejected_[a-z_]+$/.test(line)));
  assert.doesNotMatch(f.logs.join("\n"), /private|om_|ou_|oc_|fixture|source-test|owner-test/);
});

test("plain CLI-rendered post messages support private pairing and orders without admitting other content types", async (t) => {
  const f = await fixture(t, { routes: { mini: { kind: "event", type: "notes.request" } } });
  f.setHandler(() => ({ body: { event: 4, duplicate: false, routed: ["notes"] } }));
  for (const messageType of ["image", "file", "interactive", "audio"]) {
    await f.bridge.handleMessage(
      message(`om_unsupported_${messageType}`, "配对 pairing-test-code", { message_type: messageType }),
    );
  }
  await f.bridge.handleMessage(
    message("om_post_bot", "配对 pairing-test-code", { message_type: "post", sender_type: "bot" }),
  );
  await f.bridge.handleMessage(
    message("om_post_group", "配对 pairing-test-code", { message_type: "post", chat_type: "group" }),
  );
  assert.equal(f.replies.length, 0);
  assert.equal(Object.keys(f.bridge.state.messages).length, 0);
  await f.bridge.handleMessage(message("om_post_pair", "配对 pairing-test-code", { message_type: "post" }));
  assert.match(f.replies.at(-1)!.text, /配对成功/);
  await f.bridge.handleMessage(message("om_post_order", "下单 mini\n检查登录并报告结果", { message_type: "post" }));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, "/v1/events");
  assert.equal(f.calls[0].body.detail, "检查登录并报告结果");
  await f.bridge.handleMessage(
    message("om_post_paired_group", "下单 mini\n不应派发", { message_type: "post", chat_type: "group" }),
  );
  assert.equal(f.calls.length, 1);
});

test("group mode pairs one operator and conversation, survives restart, and preserves deduplication", async (t) => {
  const f = await fixture(t, { chat_type: "group", routes: { mini: { kind: "event", type: "notes.request" } } });
  f.setHandler(() => ({ body: { event: 4, duplicate: false, routed: ["notes"] } }));
  const group = (id: string, content: string, extra = {}) =>
    message(id, content, { chat_type: "group", chat_id: "oc_group", ...extra });
  await f.bridge.handleMessage(message("om_group_mode_private", "配对 pairing-test-code"));
  assert.equal(f.replies.length, 0);
  await f.bridge.handleMessage(group("om_group_pair", "配对 pairing-test-code", { message_type: "post" }));
  assert.match(f.replies.at(-1)!.text, /配对成功/);
  assert.match(f.replies.at(-1)!.text, /当前群/);
  assert.equal(f.bridge.state.binding?.chat_type, "group");
  const order = group("om_group_order", "下单 mini\n检查登录");
  await f.bridge.handleMessage(order);
  assert.equal(f.calls.length, 1);
  const id = /O[0-9a-f]{24}/.exec(f.replies.at(-1)!.text)![0];
  const before = f.replies.length;
  for (const [index, command] of [
    `查询 ${id}`,
    `停止 ${id}`,
    `复查 ${id}`,
    "配对 pairing-test-code",
    "下单 mini\n越权任务",
  ].entries()) {
    await f.bridge.handleMessage(group(`om_group_other_user_${index}`, command, { sender_id: "ou_other" }));
    await f.bridge.handleMessage(group(`om_group_other_chat_${index}`, command, { chat_id: "oc_other_group" }));
    await f.bridge.handleMessage(group(`om_group_wrong_type_${index}`, command, { chat_type: "p2p" }));
  }
  assert.equal(f.replies.length, before);
  assert.equal(f.calls.length, 1);
  f.bridge.close();
  const replies: string[] = [];
  const restart = new Bridge(loadBridgeConfig(f.configFile), {
    send: async (_chat, text) => {
      replies.push(text);
    },
  });
  t.after(() => restart.close());
  await restart.handleMessage(order);
  assert.equal(f.calls.length, 1);
  assert.equal(replies.length, 0);
  await restart.handleMessage(group("om_group_after_restart", "路线", { message_type: "post" }));
  assert.match(replies[0], /mini/);
});

test("a bound conversation cannot be reinterpreted by a mode change; legacy bindings mean private chat", async (t) => {
  const f = await fixture(t);
  await f.bridge.handleMessage(message("om_legacy_pair", "配对 pairing-test-code"));
  f.bridge.close();
  const stateFile = join(f.config.state_dir, "state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  delete state.binding.chat_type;
  writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  const legacy = new Bridge(loadBridgeConfig(f.configFile), { send: async () => {} });
  legacy.close();
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, chat_type: "group" }), { mode: 0o600 });
  assert.throws(() => new Bridge(loadBridgeConfig(f.configFile)), /mode|chat|会话/);
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, chat_type: "unexpected" }), { mode: 0o600 });
  assert.throws(() => loadBridgeConfig(f.configFile), /mode|chat|会话/);
});

test("group commands remove only the exact leading trusted bot mention described by CLI metadata", async (t) => {
  const f = await fixture(t, {
    chat_type: "group",
    bot_open_id: "ou_dispatch_bot",
    routes: { mini: { kind: "event", type: "notes.request" } },
  });
  f.setHandler(() => ({ body: { event: 4, duplicate: false, routed: ["notes"] } }));
  const mention = { key: "@_user_1", id: "ou_dispatch_bot", name: "Dispatch Bot" };
  const group = (id: string, content: string, extra = {}) =>
    message(id, content, { chat_type: "group", mentions: [mention], ...extra });
  await f.bridge.handleMessage(
    group("om_untrusted_mention", "@Dispatch Bot 配对 pairing-test-code", {
      mentions: [{ ...mention, id: "ou_other_bot" }],
    }),
  );
  await f.bridge.handleMessage(group("om_literal_mention", "@Dispatch Bot 配对 pairing-test-code", { mentions: [] }));
  assert.equal(f.bridge.state.binding, undefined);
  await f.bridge.handleMessage(group("om_mentioned_pair", "@Dispatch Bot\u2005配对 pairing-test-code"));
  assert.match(f.replies.at(-1)!.text, /配对成功/);
  for (const [index, prefix] of [
    "@Dispatch Bot",
    "@_user_1",
    '<at user_id="ou_dispatch_bot">Dispatch Bot</at>',
  ].entries()) {
    await f.bridge.handleMessage(
      group(`om_mentioned_order_${index}`, `${prefix} 下单 mini\n检查登录`, { message_type: "post" }),
    );
  }
  assert.equal(f.calls.length, 3);
  await f.bridge.handleMessage(group("om_mention_prefix_collision", "@Dispatch BotExtra 下单 mini\n不应派发"));
  await f.bridge.handleMessage(group("om_mention_nonleading", "任意前言 @Dispatch Bot 下单 mini\n不应派发"));
  assert.equal(f.calls.length, 3);
});

test("empty routes fail closed; missing or expired pairing cannot authorize an order", async (t) => {
  const f = await fixture(t, { pairing: { sha256: hash("pairing-test-code"), expires_at: "2000-01-01T00:00:00Z" } });
  await f.bridge.handleMessage(message("om_expired", "配对 pairing-test-code"));
  assert.match(f.replies.at(-1)!.text, /过期/);
  await f.bridge.handleMessage(message("om_order", "下单 mini\nhello"));
  assert.equal(f.calls.length, 0);
  f.bridge.close();
  const config = { ...f.config, pairing: undefined };
  writeFileSync(f.configFile, JSON.stringify(config), { mode: 0o600 });
  const another = new Bridge(loadBridgeConfig(f.configFile), { send: async () => {} });
  t.after(() => another.close());
  await another.handleMessage(message("om_nocode", "配对 pairing-test-code"));
  assert.equal(f.calls.length, 0);
});

test("message replay and restart reuse the original event request; goal remains data", async (t) => {
  const f = await fixture(t, { routes: { mini: { kind: "event", type: "notes.request" } } });
  f.setHandler((call) =>
    call.path === "/v1/events" ? { body: { event: 4, duplicate: false, routed: ["notes"] } } : { body: {} },
  );
  await f.bridge.handleMessage(message("om_pair", "配对 pairing-test-code"));
  const orderMessage = message("om_order", "下单 mini\nworker=root cwd=/admin identity=power\n检查文件");
  await f.bridge.handleMessage(orderMessage);
  await f.bridge.handleMessage(orderMessage);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].auth, "Bearer source-test");
  assert.equal(f.calls[0].path, "/v1/events");
  assert.equal(f.calls[0].body.type, "notes.request");
  assert.match(f.calls[0].body.detail, /worker=root cwd=/);
  assert.equal(f.calls[0].body.cwd, undefined);
  assert.match(f.replies.at(-1)!.text, /O[0-9a-f]{24}/);
  f.bridge.close();
  const restart = new Bridge(loadBridgeConfig(f.configFile), { send: async () => {} });
  t.after(() => restart.close());
  await restart.handleMessage(orderMessage);
  assert.equal(f.calls.length, 1);
  assert.ok(f.replies.every((reply) => reply.key.length <= 50));
});

test("an uncertain Hub outcome is persisted before I/O and safely resumed using the same body", async (t) => {
  const f = await fixture(t, { routes: { mini: { kind: "event", type: "notes.request" } } });
  let attempt = 0;
  f.setHandler(() => {
    const stored = JSON.parse(readFileSync(join(f.config.state_dir, "state.json"), "utf8"));
    assert.equal(Object.keys(stored.orders).length, 1);
    return ++attempt === 1
      ? { status: 503, body: { error: "transient" } }
      : { body: { event: 4, duplicate: true, routed: ["notes"] } };
  });
  await f.bridge.handleMessage(message("om_pair", "配对 pairing-test-code"));
  const msg = message("om_uncertain", "下单 mini\n检查文件");
  await f.bridge.handleMessage(msg);
  assert.match(f.replies.at(-1)!.text, /尚未确认/);
  await f.bridge.handleMessage(msg);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].body, f.calls[1].body);
  assert.equal(f.replies.filter((reply) => /Hub 接收结果尚未确认/.test(reply.text)).length, 1);
});

test("pending stop intent fences creation retries through query, redelivery, and restart", async (t) => {
  const f = await fixture(t, { routes: { mini: { kind: "event", type: "notes.request" } } });
  f.setHandler(() => ({ status: 503, body: { error: "uncertain" } }));
  await f.bridge.handleMessage(message("om_pair", "配对 pairing-test-code"));
  const original = message("om_fenced_order", "下单 mini\n检查");
  await f.bridge.handleMessage(original);
  const id = /O[0-9a-f]{24}/.exec(f.replies.at(-1)!.text)![0];
  await f.bridge.handleMessage(message("om_fence_stop", `停止 ${id}`));
  await f.bridge.handleMessage(message("om_fence_query", `查询 ${id}`));
  await f.bridge.handleMessage(original);
  assert.equal(f.calls.length, 1, "stop intent must prevent all creating retries");
  f.bridge.close();
  const replies: string[] = [];
  const restart = new Bridge(loadBridgeConfig(f.configFile), {
    send: async (_chat, text) => {
      replies.push(text);
    },
  });
  t.after(() => restart.close());
  await restart.handleMessage(message("om_fence_restart_query", `查询 ${id}`));
  await restart.handleMessage(original);
  assert.equal(f.calls.length, 1);
  assert.match(replies[0], /停止意图|管理员/);
  assert.doesNotMatch(replies[0], /已停止|已取消/);
});

test("a paired user cannot dispatch through an empty or inherited route alias", async (t) => {
  const f = await fixture(t);
  await f.bridge.handleMessage(message("om_pair", "配对 pairing-test-code"));
  await f.bridge.handleMessage(message("om_unconfigured", "下单 mini\n检查"));
  await f.bridge.handleMessage(message("om_inherited", "下单 constructor\n检查"));
  assert.equal(f.calls.length, 0);
  assert.match(f.replies.at(-1)!.text, /尚未登记/);
});

test("workflow submit/status/cancel/recheck keep source and owner capabilities separate", async (t) => {
  const taskId = `task_${"a".repeat(32)}`;
  const f = await fixture(t, {
    routes: { app: { kind: "workflow", type: "project.change", acceptance: ["验证登录"] } },
  });
  f.setHandler((call) => {
    if (call.path === "/v1/project-tasks") return { body: { task_id: taskId, duplicate: false } };
    if (call.path.endsWith("/cancel")) return { body: { task_id: taskId, state: "cancel_requested" } };
    if (call.path.endsWith("/recheck")) return { body: { task_id: taskId, state: "queued" } };
    return {
      body: {
        task_id: taskId,
        source: "feishu-orders",
        source_id: f.calls[0].body.id,
        state: "running",
        input: f.calls[0].body,
      },
    };
  });
  await f.bridge.handleMessage(message("om_pair", "配对 pairing-test-code"));
  await f.bridge.handleMessage(message("om_project", "下单 app\n修改登录"));
  const id = /O[0-9a-f]{24}/.exec(f.replies.at(-1)!.text)![0];
  await f.bridge.handleMessage(message("om_status", `查询 ${id}`));
  await f.bridge.handleMessage(message("om_cancel", `停止 ${id}`));
  assert.match(f.replies.at(-1)!.text, /已请求停止/);
  assert.doesNotMatch(f.replies.at(-1)!.text, /已停止|已取消/);
  await f.bridge.handleMessage(message("om_recheck", `复查 ${id}`));
  assert.equal(f.calls[0].auth, "Bearer source-test");
  assert.ok(f.calls.slice(1).every((call) => call.auth === "Bearer owner-test"));
  assert.deepEqual(f.calls[0].body.acceptance, ["验证登录"]);
  assert.equal(f.calls[0].body.source, undefined);
  assert.equal(f.calls.find((call) => call.path.endsWith("/cancel"))!.body.request_id.length > 0, true);
  const count = f.calls.length;
  await f.bridge.handleMessage(message("om_forged", `停止 O${"b".repeat(24)}`));
  assert.equal(f.calls.length, count);
});

test("ordinary queries require full provenance and ordinary stop never races a merged retry batch", async (t) => {
  const f = await fixture(t, { routes: { mini: { kind: "event", type: "notes.request" } } });
  let mixed = true;
  let runState = "claimed";
  f.setHandler((call) => {
    if (call.path === "/v1/events") return { body: { event: 5, duplicate: false, routed: ["notes"] } };
    const body = f.calls[0].body;
    if (call.path === "/v1/state")
      return {
        body: {
          runs: [{ id: 7, state: runState, events: [{ source: "feishu-orders", subject: body.subject }] }],
          hasMore: false,
        },
      };
    if (call.path === "/v1/runs/7/why")
      return {
        body: [
          {
            changes: [
              { table: "runs", key: "7", row: { id: 7, state: runState } },
              { table: "run_events", key: "7:5", row: { run_id: 7, event_id: 5 } },
              {
                table: "events",
                key: "5",
                row: { id: 5, source: "feishu-orders", key: body.id, subject: body.subject },
              },
              ...(mixed
                ? [
                    { table: "run_events", key: "7:6", row: { run_id: 7, event_id: 6 } },
                    { table: "events", key: "6", row: { id: 6, source: "other", key: "foreign", subject: "foreign" } },
                  ]
                : []),
            ],
          },
        ],
      };
    return { body: { ok: true } };
  });
  await f.bridge.handleMessage(message("om_pair", "配对 pairing-test-code"));
  await f.bridge.handleMessage(message("om_job", "下单 mini\n检查"));
  const id = /O[0-9a-f]{24}/.exec(f.replies.at(-1)!.text)![0];
  await f.bridge.handleMessage(message("om_mixed", `查询 ${id}`));
  assert.match(f.replies.at(-1)!.text, /归属|混合|安全/);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/cancel")).length, 0);
  mixed = false;
  runState = "queued";
  await f.bridge.handleMessage(message("om_queued", `停止 ${id}`));
  assert.match(f.replies.at(-1)!.text, /不支持|管理员/);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/cancel")).length, 0);
  runState = "claimed";
  await f.bridge.handleMessage(message("om_claimed", `停止 ${id}`));
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/cancel")).length,
    0,
    "even a claimed batch may requeue and merge after a provenance read",
  );
  await f.bridge.handleMessage(message("om_recheck_event", `复查 ${id}`));
  assert.match(f.replies.at(-1)!.text, /不支持|工作流/);
});

test("insecure private files and concurrent runner ownership are rejected", async (t) => {
  const f = await fixture(t);
  assert.throws(() => new Bridge(loadBridgeConfig(f.configFile)), /占用|running|lock/);
  chmodSync(f.configFile, 0o644);
  assert.throws(() => loadBridgeConfig(f.configFile), /0600|private/);
});

test("durable submissions and commands survive a crash before the first Feishu reply", async (t) => {
  const f = await fixture(t, { routes: { mini: { kind: "event", type: "notes.request" } } });
  f.setHandler(() => ({ body: { event: 4, duplicate: false, routed: ["notes"] } }));
  await f.bridge.handleMessage(message("om_pair", "配对 pairing-test-code"));
  await f.bridge.handleMessage(message("om_crash_order", "下单 mini\n检查"));
  f.bridge.close();
  const stateFile = join(f.config.state_dir, "state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  delete state.messages.om_crash_order.reply;
  state.messages.om_crash_help = { fingerprint: hash(JSON.stringify(["ou_owner", "oc_owner", "帮助"])) };
  writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  const replies: string[] = [];
  const restart = new Bridge(loadBridgeConfig(f.configFile), {
    send: async (_chat, text) => {
      replies.push(text);
    },
  });
  t.after(() => restart.close());
  await restart.handleMessage(message("om_crash_order", "下单 mini\n检查"));
  await restart.handleMessage(message("om_crash_help", "帮助"));
  assert.equal(f.calls.length, 1);
  assert.match(replies[0], /已提交订单/);
  assert.match(replies[1], /指令/);
});

test("CLI runner waits for the fixed ready marker and sends reply JSON via stdin", async (t) => {
  const f = await fixture(t);
  f.bridge.close();
  const lark = join(f.dir, "fake-lark");
  const output = join(f.dir, "sent.json");
  writeFileSync(
    lark,
    `#!${process.execPath}\nconst fs=require('node:fs');
if(process.argv[2]==='event') { process.stderr.write('[event] ready event_key=im.message.receive_v1\\n'); process.stdout.write(JSON.stringify(${JSON.stringify(message("om_pair_process", "配对 pairing-test-code"))})+'\\n'); process.stdin.resume(); }
else { let input=''; process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),input}));process.stdout.write(JSON.stringify({ok:true,data:{message_id:'om_reply'}}));}); }
`,
    { mode: 0o700 },
  );
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, lark }), { mode: 0o600 });
  const stop = new AbortController();
  const logs: string[] = [];
  const running = runBridge(f.configFile, { signal: stop.signal, log: (line) => logs.push(line) });
  t.after(() => stop.abort());
  await waitForJson(
    join(f.config.state_dir, "state.json"),
    (state) => state.messages.om_pair_process?.reply?.sent === true,
  );
  stop.abort();
  await running;
  const sent = JSON.parse(readFileSync(output, "utf8"));
  assert.match(JSON.parse(sent.input).text, /配对成功/);
  assert.ok(sent.args.includes("--idempotency-key"));
  assert.ok(logs.includes("feishu_bridge_ready"));
  assert.ok(logs.every((line) => !line.includes("ou_owner") && !line.includes("pairing-test-code")));
});

test("a consumer failure drains accepted message work before releasing runner ownership", async (t) => {
  const f = await fixture(t);
  f.bridge.close();
  const lark = join(f.dir, "fake-lark-fail-after-message");
  const started = join(f.dir, "send-started.json");
  const release = join(f.dir, "release-send.json");
  writeFileSync(
    lark,
    `#!${process.execPath}\nconst fs=require('node:fs');
if(process.argv[2]==='event') {
  process.stderr.write('[event] ready event_key=im.message.receive_v1\\n');
  process.stdout.write(JSON.stringify(${JSON.stringify(message("om_drain_pair", "配对 pairing-test-code"))})+'\\n',()=>process.exit(1));
} else {
  process.stdin.resume(); process.stdin.on('end',()=>{
    const finish=()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.unwatchFile(${JSON.stringify(release)},finish);process.stdout.write(JSON.stringify({ok:true,data:{message_id:'om_reply'}}));}};
    fs.watchFile(${JSON.stringify(release)},{interval:20},finish);
    fs.writeFileSync(${JSON.stringify(started)},JSON.stringify({started:true}));finish();
  });
}
`,
    { mode: 0o700 },
  );
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, lark }), { mode: 0o600 });
  const stop = new AbortController();
  const running = runBridge(f.configFile, { signal: stop.signal }).then(
    () => null,
    (error: Error) => error,
  );
  t.after(() => {
    if (existsSync(f.dir)) writeFileSync(release, "{}");
    stop.abort();
  });
  await waitForJson(started);
  const heldWhileSending = existsSync(join(f.config.state_dir, "runner.lock"));
  writeFileSync(release, "{}");
  const failure = await running;
  assert.equal(heldWhileSending, true, "accepted message work must retain exclusive state ownership");
  assert.ok(failure instanceof Error);
  const state = JSON.parse(readFileSync(join(f.config.state_dir, "state.json"), "utf8"));
  assert.equal(state.messages.om_drain_pair.reply.sent, true);
  assert.equal(existsSync(join(f.config.state_dir, "runner.lock")), false);
});

test("an unrequested clean consumer exit is a service failure, so on-failure restarts it", async (t) => {
  const f = await fixture(t);
  f.bridge.close();
  const lark = join(f.dir, "fake-lark-exit-zero");
  writeFileSync(
    lark,
    `#!${process.execPath}\nprocess.stderr.write('[event] ready event_key=im.message.receive_v1\\n');\n`,
    { mode: 0o700 },
  );
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, lark }), { mode: 0o600 });
  const logs: string[] = [];
  await assert.rejects(runBridge(f.configFile, { log: (line) => logs.push(line) }), /exited unexpectedly/);
  assert.ok(logs.includes("feishu_bridge_ready"));
});
