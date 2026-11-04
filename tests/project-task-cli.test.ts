// Failure modes: CLI/MCP silently invent task ids, bypass source/owner boundaries, lose acceptance arrays/data,
// claim a pending cancellation is stopped, or accept executable fields as task data. Calls reach a real isolated Hub.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./helpers.ts";
import { hubClient } from "../protocol/client.ts";

const home = setup("project-task-cli");
const rulesFile = join(home, "rules.json");
const rules = JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
rules.rules.push(
  {
    name: "项目入口",
    when: { source: "app", types: ["project.requested"] },
    to: "a1",
    cwd: home,
    prompt: "接收任务",
    workflow: "one",
  },
  { name: "核验", when: { source: "app", types: ["internal.verify"] }, to: "a1", cwd: home, prompt: "按验收条件核验" },
);
rules.workflows = {
  one: {
    entry: "verify",
    max_transitions: 8,
    stages: {
      verify: {
        route: "核验",
        mode: "inspect",
        max_visits: 4,
        on: { verified: "$complete", blocked: "$human", execution_failed: "$failed" },
        checks: [{ name: "proof", argv: ["node", "--version"], timeout_ms: 1000 }],
      },
    },
    git: {
      remote: "file:///tmp/fixture.git",
      base_ref: "refs/heads/main",
      task_ref_prefix: "refs/heads/tasks/",
      artifact_paths: [],
    },
    recheck: "verify",
    human: { options: [{ label: "重试", action: "retry" }] },
  },
};
writeFileSync(rulesFile, JSON.stringify(rules));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const runtime = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");
const keys = {
  source: runtime.addKey("source", "app"),
  owner: runtime.addKey("owner", "owner"),
  worker: runtime.addKey("worker", "w1"),
};
const server = serve(0, "127.0.0.1", { commit: "test" });
let url = "";
before(async () => {
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configure();
});
after(() => {
  server.closeAllConnections();
  server.close();
});
function configure(owner: string | null = keys.owner, source: string | null = keys.source) {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url, ...(owner ? { owner } : {}), ...(source ? { source: { name: "app", key: source } } : {}) }),
  );
}
async function cli(args: string[], input = "") {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", ...args], {
    cwd: join(import.meta.dirname, ".."),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "",
    err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  child.stdin.end(input);
  await once(child, "close");
  return { code: child.exitCode, out, err };
}
const input = (id: string) => ({
  id,
  type: "project.requested",
  subject: id,
  goal: "检查导出功能",
  acceptance: ["权限检查通过", "文件内容正确"],
  data: { ticket: { id: 7 }, flags: [true, false] },
});

test("CLI submits stable JSON tasks from stdin/file and exposes honest status/cancel", async () => {
  const task = input("cli-one");
  const first = await cli(["task", "submit", "--json"], JSON.stringify(task));
  assert.equal(first.code, 0, first.err);
  const created = JSON.parse(first.out);
  const file = join(home, "task.json");
  writeFileSync(file, JSON.stringify(task));
  const replay = await cli(["task", "submit", "--file", file, "--json"]);
  assert.equal(replay.code, 0, replay.err);
  assert.equal(JSON.parse(replay.out).task_id, created.task_id);
  assert.equal(JSON.parse(replay.out).duplicate, true);
  const status = await cli(["task", "status", created.task_id, "--json"]);
  assert.equal(status.code, 0, status.err);
  assert.deepEqual(JSON.parse(status.out).input.acceptance, task.acceptance);
  assert.deepEqual(JSON.parse(status.out).input.data, task.data);
  const cancel = await cli(["task", "cancel", created.task_id, "--request-id", "cancel-one", "--json"]);
  assert.equal(cancel.code, 0, cancel.err);
  const state = await hubClient(url, keys.owner).projectTask(created.task_id);
  assert.equal(state.state, "cancelled");
  assert.notEqual((await cli(["task", "cancel", created.task_id, "--json"])).code, 0, "mutation ids are explicit");
});

test("CLI rejects missing stable ids, executable routing fields and wrong credential kind", async () => {
  assert.notEqual(
    (await cli(["task", "submit", "--json"], JSON.stringify({ ...input("bad"), id: undefined }))).code,
    0,
  );
  assert.notEqual(
    (await cli(["task", "submit", "--json"], JSON.stringify({ ...input("bad"), cwd: "/untrusted" }))).code,
    0,
  );
  configure(keys.worker, keys.worker);
  try {
    assert.notEqual((await cli(["task", "submit", "--json"], JSON.stringify(input("wrong-key")))).code, 0);
  } finally {
    configure();
  }
});

test("CLI recheck creates one new generation for the same request key", async () => {
  const created = await hubClient(url, keys.source).submitProjectTask(input("recheck-one"));
  const worker = hubClient(url, keys.worker);
  const { job } = await worker.work({ claim: "recheck-worker", wait: 0, running: [], capacity: true });
  assert.equal(job.stage.task_id, created.task_id);
  const revision = "a".repeat(40);
  await worker.started(job.run, job.token, {
    session: "native",
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      input_revision: revision,
      remote_state: "completed",
    },
  });
  await worker.result(job.run, job.token, {
    outcome: "done",
    summary: "核验通过",
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      verdict: "verified",
      input_revision: revision,
      output_revision: revision,
      artifacts: [],
      checks: [{ name: "proof", exit_code: 0, revision }],
      findings: [],
    },
  });
  assert.equal((await hubClient(url, keys.owner).projectTask(created.task_id)).state, "completed");
  const request = ["task", "recheck", created.task_id, "--request-id", "recheck-one", "--json"];
  const first = await cli(request);
  assert.equal(first.code, 0, first.err);
  const replay = await cli(request);
  assert.equal(replay.code, 0, replay.err);
  const state = await hubClient(url, keys.owner).projectTask(created.task_id);
  assert.equal(state.generation, 2);
});

test("MCP task tools preserve nested JSON, expose owners correctly, and call the same Hub", async () => {
  const messages = [
    {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "task_submit", arguments: input("mcp-one") } },
    {
      id: 4,
      method: "tools/call",
      params: { name: "task_submit", arguments: { ...input("mcp-bad"), command: ["bad"] } },
    },
  ];
  const run = await cli(
    ["mcp"],
    messages.map((message) => JSON.stringify({ jsonrpc: "2.0", ...message })).join("\n") + "\n",
  );
  assert.equal(run.code, 0, run.err);
  const responses = run.out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const get = (id: number) => responses.find((response) => response.id === id);
  const names = get(2).result.tools.map((tool: any) => tool.name);
  for (const name of ["task_submit", "task_status", "task_cancel", "task_recheck"]) assert.ok(names.includes(name));
  const accepted = JSON.parse(get(3).result.content[0].text);
  assert.deepEqual(
    (await hubClient(url, keys.owner).projectTask(accepted.task_id)).input.acceptance,
    input("x").acceptance,
  );
  assert.equal(get(4).error.code, -32602);
  configure(null, keys.source);
  try {
    const limited = await cli(
      ["mcp"],
      messages
        .slice(0, 3)
        .map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }))
        .join("\n") + "\n",
    );
    const list = limited.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((response) => response.id === 2).result.tools;
    assert.ok(list.some((tool: any) => tool.name === "task_submit"));
    assert.ok(!list.some((tool: any) => tool.name === "task_cancel"));
  } finally {
    configure();
  }
});
