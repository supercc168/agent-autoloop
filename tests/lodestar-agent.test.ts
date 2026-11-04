// Failure modes: progress/exit zero masquerades as completion, a lost POST starts a second task, a changed project
// binding replays work elsewhere, rejected resume becomes fresh, cancellation kills only the local observer, or
// project credentials are used from a managed Agent context. The first case uses the real HTTP Hub and worker.
// Terminal snapshots and HTTP errors also cannot release work without the durable request termination fact.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { hubClient } from "../protocol/client.ts";
import type { Turn } from "../worker/agents.ts";
import type { Job } from "../protocol/job.ts";
import { setup } from "./helpers.ts";

const home = setup("lodestar-agent");
const project = join(home, "project");
mkdirSync(project);
const managed = [
  "LODESTAR_AGENT_ROLE",
  "LODESTAR_AGENT_URL",
  "LODESTAR_AGENT_CAPABILITY",
  "LODESTAR_AGENT_SESSION",
  "DSH_LODESTAR_AGENT_CONTEXT",
];
const inherited = Object.fromEntries(managed.map((key) => [key, process.env[key]]));
for (const key of managed) delete process.env[key];
after(() => {
  for (const key of managed)
    if (inherited[key] === undefined) delete process.env[key];
    else process.env[key] = inherited[key];
});

async function bodyOf(req: IncomingMessage) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function fakeLodestar() {
  const binding = {
    installation_id: "node-a",
    binding_id: "binding-a",
    project: "repo",
    chat_id: "chat-a",
    work_dir: project,
  };
  const calls: { method: string; path: string; body?: any }[] = [];
  const runs = new Map<string, any>();
  const fences = new Set<string>();
  const rejected = new Set<string>();
  const sessions = new Map<string, string>();
  const mode = {
    complete: true,
    dropPost: false,
    rejectResume: false,
    cancelPending: false,
    unknown: false,
    completedWorker: false,
    postStatus: 0,
    requestState: "",
    terminalStatus: "completed",
    hideRun: false,
    missingRequest: false,
    durableRunId: undefined as string | null | undefined,
    omitRejectedRunId: false,
    omitRunId: false,
    workspaceGuard: false,
    stageVerdicts: [] as string[],
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://127.0.0.1");
      const body = await bodyOf(req);
      calls.push({ method: req.method!, path: url.pathname, body });
      const send = (code: number, value: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== "Bearer test-project-capability") return send(403, { error: "bad capability" });
      if (url.searchParams.get("project") !== "repo") return send(403, { error: "bad project" });
      if (url.pathname === "/agents/project-binding") return send(200, binding);
      if (url.pathname === "/agents/identities")
        return send(200, {
          identities: [
            { id: "executor", status: "ready", provider: "codex", supported_efforts: ["high"], default_effort: "high" },
          ],
        });
      if ((body.expected_binding ?? url.searchParams.get("expected_binding")) !== binding.binding_id)
        return send(409, { error: "project_binding_changed" });
      if (req.method === "POST" && url.pathname === "/agents/runs") {
        if (fences.has(body.request_id)) return send(409, { error: "request cancelled" });
        if (body.session_id && mode.rejectResume) {
          rejected.add(body.request_id);
          return send(409, { error: "native session unavailable" });
        }
        if (mode.workspaceGuard && body.session_id && sessions.get(body.session_id) !== body.work_dir) {
          rejected.add(body.request_id);
          return send(409, { error: "native session header cwd mismatch" });
        }
        let run = runs.get(body.request_id);
        if (!run) {
          const nativeSession =
            body.session_id || (mode.workspaceGuard ? `native-workspace-${sessions.size + 1}` : "native-session");
          sessions.set(nativeSession, body.work_dir);
          const verdict = mode.stageVerdicts.shift();
          run = {
            run_id: `remote-${runs.size + 1}`,
            request_id: body.request_id,
            binding: "project",
            project: "repo",
            work_dir: body.work_dir,
            status: mode.complete ? mode.terminalStatus : "running",
            workers: [
              {
                identity_id: "executor",
                provider: "codex",
                status: mode.complete ? mode.terminalStatus : "running",
                session_id: nativeSession,
                output: "我先看看项目。\n没跑成：这是过程正文",
                final_output: mode.complete
                  ? verdict
                    ? `\`\`\`agent-autoloop-stage\n${JSON.stringify({ verdict, summary: verdict, artifacts: [], findings: [] })}\n\`\`\``
                    : "真正完成"
                  : undefined,
                usage: { input_tokens: 10, output_tokens: 2 },
              },
            ],
          };
          runs.set(body.request_id, run);
        }
        if (mode.dropPost) {
          mode.dropPost = false;
          req.socket.destroy();
          return;
        }
        if (mode.postStatus) return send(mode.postStatus, { error: "admission persistence failed" });
        return send(202, run);
      }
      const match = url.pathname.match(/^\/agents\/requests\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const run = runs.get(id);
        if (mode.missingRequest) return send(404, { error: "request temporarily unavailable" });
        if (req.method === "DELETE") {
          fences.add(id);
          if (run?.status === "completed")
            return send(200, { request_id: id, run_id: run.run_id, state: "resolved", run });
          if (mode.cancelPending && run) return send(202, { request_id: id, state: "cancel_requested", run });
          if (run) {
            run.status = "cancelled";
            if (!mode.completedWorker) run.workers[0].status = "cancelled";
          }
          return send(200, { request_id: id, run_id: run?.run_id ?? null, state: "cancelled", run });
        }
        if (mode.unknown && run) {
          run.status = "failed";
          run.workers[0].status = "failed";
          return send(200, { request_id: id, state: "unknown", run });
        }
        if (fences.has(id))
          return send(200, {
            request_id: id,
            run_id: run?.run_id ?? null,
            state: mode.cancelPending && run?.status !== "cancelled" ? "cancel_requested" : "cancelled",
            run,
          });
        if (rejected.has(id))
          return send(200, { request_id: id, ...(mode.omitRejectedRunId ? {} : { run_id: null }), state: "resolved" });
        return run
          ? send(200, {
              request_id: id,
              ...(mode.omitRunId ? {} : { run_id: mode.durableRunId === undefined ? run.run_id : mode.durableRunId }),
              state:
                mode.requestState ||
                (["completed", "failed", "cancelled"].includes(run.status) ? "resolved" : "admitted"),
              ...(mode.hideRun ? {} : { run }),
            })
          : send(404, { error: "not found" });
      }
      return send(404, { error: "not found" });
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clientFile = join(home, `client-${(server.address() as AddressInfo).port}.json`);
  writeFileSync(clientFile, JSON.stringify({ baseUrl, capability: "test-project-capability" }), { mode: 0o600 });
  return {
    binding,
    calls,
    runs,
    fences,
    sessions,
    mode,
    clientFile,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

let sequence = 0;
function turnFor(clientFile: string): Turn {
  const folder = join(home, `turn-${++sequence}`);
  mkdirSync(folder);
  const contextFile = join(folder, "context.json");
  writeFileSync(contextFile, "{}");
  return {
    prompt: "完成这一项检查",
    session: `new-${sequence}`,
    resume: null,
    cwd: project,
    access: "full",
    contextFile,
    folder,
    command: ["--project", "repo", "--identity", "executor", "--client-file", clientFile],
  };
}
const plugin = async () => (await import("../plugins/lodestar/agent.ts")).default;

test("real Hub and worker settle the final message, not the accumulated progress", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  const ruleFile = join(home, "rules.json");
  writeFileSync(
    ruleFile,
    JSON.stringify({
      sources: { app: { name: "应用" } },
      agents: {
        local: {
          name: "本机",
          worker: "mac",
          use: "lodestar",
          access: "full",
          command: turnFor(fake.clientFile).command,
        },
      },
      channels: {},
      rules: [
        {
          name: "集成",
          when: { source: "app", types: ["task.test"] },
          to: "local",
          cwd: project,
          prompt: "完成检查。",
        },
      ],
    }),
  );
  process.env.AGENT_AUTOLOOP_RULES = ruleFile;
  const { serve } = await import("../host/http.ts");
  const runtime = await import("../host/runtime.ts");
  const { createWorker } = await import("../worker/worker.ts");
  const sourceKey = runtime.addKey("source", "app");
  const workerKey = runtime.addKey("worker", "mac");
  const server = serve(0, "127.0.0.1", { commit: "test" });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await hubClient(base, sourceKey).event({
    id: "one",
    type: "task.test",
    subject: "case-1",
    detail: "这是资料，不可改调用身份",
  });
  const worker = createWorker({ hub: hubClient(base, workerKey), name: "mac", wait: 0 });
  const deadline = Date.now() + 15_000;
  let row: any;
  do {
    await worker.tick();
    row = runtime.one("SELECT * FROM runs WHERE rule='集成'");
    if (row?.state === "done" || row?.error) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  assert.equal(row?.state, "done", JSON.stringify(row));
  assert.equal(row.summary, "真正完成");
  assert.equal(fake.runs.size, 1);
  const submitted = fake.calls.find((call) => call.method === "POST")!.body;
  assert.deepEqual(submitted.identity_ids, ["executor"]);
  assert.equal(submitted.expected_binding, "binding-a");
  assert.ok(!submitted.prompt.includes("这是资料，不可改调用身份"));
});

test("read/edit/default permissions and managed context are rejected before credentials or network", async () => {
  const adapter = await plugin();
  const turn = turnFor("/must-not-read-project-credentials");
  for (const access of ["read", "edit"] as const) assert.throws(() => adapter.command({ ...turn, access }), /full/);
  process.env.LODESTAR_AGENT_ROLE = "worker";
  try {
    assert.throws(() => adapter.command(turn), /managed|受管|独立/);
  } finally {
    delete process.env.LODESTAR_AGENT_ROLE;
  }
});

test("lost admission response is recovered by request id without another POST", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.dropPost = true;
  const adapter = await plugin();
  const turn = turnFor(fake.clientFile);
  adapter.command(turn);
  const first = await adapter.reconcile!(turn);
  assert.ok(!first.finished && !first.text);
  const next = await adapter.reconcile!(turn);
  assert.equal(next.text, "真正完成");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(fake.runs.size, 1);
  const journal = readFileSync(join(turn.folder, "lodestar-journal.json"), "utf8");
  assert.ok(!journal.includes("test-project-capability"));
});

test("terminal POST and admitted terminal snapshots stay unknown until durable request resolution", async (t) => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const fake = await fakeLodestar();
    t.after(fake.close);
    fake.mode.terminalStatus = status;
    fake.mode.requestState = "admitted";
    const adapter = await plugin();
    const turn = turnFor(fake.clientFile);
    adapter.command(turn);
    const first = await adapter.reconcile!(turn);
    assert.equal(first.pending, true, status);
    assert.equal(first.finished, undefined, status);
    adapter.command(turn);
    const restarted = await adapter.reconcile!(turn);
    assert.equal(restarted.pending, true, status);
    assert.equal(restarted.finished, undefined, status);
    fake.mode.requestState = status === "cancelled" ? "cancelled" : "resolved";
    assert.equal((await adapter.reconcile!(turn)).finished, true, status);
    assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1, status);
  }
});

test("post-admission 409 and 503 query the same live request without releasing or resubmitting", async (t) => {
  for (const code of [409, 503]) {
    const fake = await fakeLodestar();
    t.after(fake.close);
    fake.mode.postStatus = code;
    fake.mode.terminalStatus = "failed";
    fake.mode.requestState = "admitted";
    const adapter = await plugin();
    const turn = turnFor(fake.clientFile);
    adapter.command(turn);
    const first = await adapter.reconcile!(turn);
    assert.equal(first.pending, true, String(code));
    assert.equal(first.finished, undefined, String(code));
    assert.ok(fake.calls.some((call) => call.method === "GET" && call.path.startsWith("/agents/requests/")));
    assert.equal((await adapter.reconcile!(turn)).pending, true);
    fake.mode.requestState = "resolved";
    assert.equal((await adapter.reconcile!(turn)).finished, true);
    assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
  }
});

test("a missing known run or a single request 404 preserves the original request and execution", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.complete = false;
  const adapter = await plugin();
  const turn = turnFor(fake.clientFile);
  adapter.command(turn);
  await adapter.reconcile!(turn);
  fake.mode.hideRun = true;
  fake.mode.requestState = "resolved";
  assert.equal((await adapter.reconcile!(turn)).pending, true);
  fake.mode.missingRequest = true;
  assert.equal((await adapter.reconcile!(turn)).pending, true);
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
  fake.mode.missingRequest = false;
  fake.mode.hideRun = false;
  const run = [...fake.runs.values()][0];
  run.status = run.workers[0].status = "completed";
  run.workers[0].final_output = "original recovered";
  assert.equal((await adapter.reconcile!(turn)).text, "original recovered");
});

test("durable terminal facts must name the same run and legacy empty resolved responses remain unknown", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.durableRunId = "foreign-run";
  const adapter = await plugin();
  const turn = turnFor(fake.clientFile);
  adapter.command(turn);
  assert.equal((await adapter.reconcile!(turn)).pending, true);
  fake.mode.durableRunId = null;
  assert.equal((await adapter.reconcile!(turn)).pending, true);
  fake.mode.durableRunId = undefined;
  assert.equal((await adapter.reconcile!(turn)).finished, true);
  fake.mode.rejectResume = true;
  fake.mode.omitRejectedRunId = true;
  const rejected = { ...turnFor(fake.clientFile), resume: "unknown-session" };
  adapter.command(rejected);
  assert.equal((await adapter.reconcile!(rejected)).pending, true);
  fake.mode.omitRejectedRunId = false;
  assert.equal((await adapter.reconcile!(rejected)).finished, true);
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 2);
});

test("legacy terminal readings without request termination proof cannot release an admitted execution", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.requestState = "admitted";
  const adapter = await plugin();
  const turn = turnFor(fake.clientFile);
  adapter.command(turn);
  assert.equal((await adapter.reconcile!(turn)).pending, true);
  const file = join(turn.folder, "lodestar-journal.json");
  const journal = JSON.parse(readFileSync(file, "utf8"));
  journal.reading = { finished: true, error: "legacy failed snapshot" };
  delete journal.termination;
  writeFileSync(file, JSON.stringify(journal));
  assert.equal((await adapter.reconcile!(turn)).pending, true);
  fake.mode.requestState = "resolved";
  assert.equal((await adapter.reconcile!(turn)).text, "真正完成");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
});

test("resolved or cancelled terminal snapshots without durable run_id remain unknown", async (t) => {
  for (const status of ["completed", "cancelled"]) {
    const fake = await fakeLodestar();
    t.after(fake.close);
    fake.mode.terminalStatus = status;
    fake.mode.requestState = status === "cancelled" ? "cancelled" : "resolved";
    fake.mode.omitRunId = true;
    const adapter = await plugin();
    const turn = turnFor(fake.clientFile);
    adapter.command(turn);
    const unproven = await adapter.reconcile!(turn);
    assert.equal(unproven.finished, undefined, status);
    assert.equal(unproven.pending, true, status);
    fake.mode.omitRunId = false;
    assert.equal((await adapter.reconcile!(turn)).finished, true, status);
    assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1, status);
  }
});

test("a rebind after lost admission stays uncertain and never replays elsewhere", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.dropPost = true;
  const adapter = await plugin();
  const turn = turnFor(fake.clientFile);
  adapter.command(turn);
  await adapter.reconcile!(turn);
  fake.binding.binding_id = "other-binding";
  const seen = await adapter.reconcile!(turn);
  assert.ok(!seen.finished && !seen.text && !seen.result);
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
});

test("strict native resume rejection remains an error without a fresh call", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.rejectResume = true;
  const adapter = await plugin();
  const turn = { ...turnFor(fake.clientFile), resume: "old-native" };
  adapter.command(turn);
  const seen = await adapter.reconcile!(turn);
  assert.equal(adapter.resumePolicy, "strict");
  assert.ok(seen.finished && seen.error);
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(fake.calls.find((call) => call.method === "POST")!.body.session_id, "old-native");
});

test("cancellation before admission fences the request without creating a run", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  const adapter = await plugin();
  const turn = turnFor(fake.clientFile);
  adapter.command(turn);
  const seen = await adapter.cancel!(turn);
  assert.equal(seen.result?.outcome, "cancelled");
  assert.equal(fake.runs.size, 0);
  await adapter.reconcile!(turn);
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 0);
});

test("cancel waits for remote confirmation and restart failure is not process proof", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.complete = false;
  const adapter = await plugin();
  const turn = turnFor(fake.clientFile);
  adapter.command(turn);
  await adapter.reconcile!(turn);
  fake.mode.unknown = true;
  const unknown = await adapter.reconcile!(turn);
  assert.ok(!unknown.finished && !unknown.result);
  fake.mode.unknown = false;
  fake.mode.cancelPending = true;
  const pending = await adapter.cancel!(turn);
  assert.ok(!pending.finished && !pending.result);
  fake.mode.cancelPending = false;
  const cancelled = await adapter.cancel!(turn);
  assert.equal(cancelled.result?.outcome, "cancelled");
});

function lifecycleHub(clientFile: string, session: string | null = null) {
  const id = 100 + ++sequence;
  const job: Job = {
    run: id,
    attempt: 1,
    token: "test-turn-token",
    session,
    askFirst: [],
    rule: { name: "生命周期", cwd: project, prompt: "完成检查" },
    agent: { id: "local", name: "本机", use: "lodestar", access: "full", command: turnFor(clientFile).command },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
  const jobs = [job];
  const results: any[] = [];
  const cancels: number[] = [];
  const hub = {
    async work(query: any) {
      return { job: query.capacity ? (jobs.shift() ?? null) : null, cancel: cancels.splice(0) };
    },
    async started() {
      return { ok: true };
    },
    async result(_id: number, _token: string, result: any) {
      results.push(result);
      return { rejected: [] };
    },
  };
  return { id, hub, results, cancels };
}

async function ticks(worker: { tick(): Promise<boolean> }, done: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    assert.ok(Date.now() < deadline, "timed out waiting for observed lifecycle");
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("worker keeps a dead observer reserved, and cancellation awaits actual remote termination", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.complete = false;
  const { createWorker } = await import("../worker/worker.ts");
  const control = lifecycleHub(fake.clientFile);
  const worker = createWorker({ hub: control.hub, name: "mac", wait: 0 });
  t.after(() => {
    for (const entry of worker.entries())
      if (entry.pid) {
        try {
          process.kill(-entry.pid, "SIGKILL");
        } catch {}
      }
  });
  await ticks(worker, () => fake.runs.size === 1);
  const entry = worker.entries().find((item) => item.run === control.id)!;
  process.kill(-entry.pid!, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await worker.tick();
  assert.equal(control.results.length, 0, "observer death cannot settle remote work");
  fake.mode.cancelPending = true;
  control.cancels.push(control.id);
  await worker.tick();
  await worker.tick();
  assert.equal(control.results.length, 0, "cancel response is still pending");
  assert.ok(worker.entries().some((item) => item.run === control.id));
  fake.mode.cancelPending = false;
  await ticks(worker, () => control.results.length === 1);
  assert.equal(control.results[0].outcome, "cancelled");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
});

test("worker never fresh-falls back after Lodestar rejects native resume", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.rejectResume = true;
  const { createWorker } = await import("../worker/worker.ts");
  const control = lifecycleHub(fake.clientFile, "old-native");
  const worker = createWorker({ hub: control.hub, name: "mac", wait: 0 });
  await ticks(worker, () => control.results.length > 0);
  assert.equal(control.results[0].outcome, "failed");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
});

test("completion that wins a cancel is reported as a late outcome instead of waiting forever", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  const adapter = await plugin();
  const turn = turnFor(fake.clientFile);
  adapter.command(turn);
  await adapter.reconcile!(turn);
  const seen = await adapter.cancel!(turn);
  assert.equal(seen.finished, true);
  assert.equal(seen.text, "真正完成");
  assert.equal(seen.result?.outcome, "cancelled");
  assert.match(seen.result?.notice?.[0].title ?? "", /取消前.*已结束/);
});

test("cancelled run preserves a completed worker's final message and late-outcome notice", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.complete = false;
  const adapter = await plugin();
  const turn = turnFor(fake.clientFile);
  adapter.command(turn);
  await adapter.reconcile!(turn);
  const run = [...fake.runs.values()][0];
  run.workers[0].status = "completed";
  run.workers[0].final_output = "取消前完成";
  fake.mode.completedWorker = true;
  const seen = await adapter.cancel!(turn);
  assert.equal(seen.text, "取消前完成");
  assert.match(seen.result?.notice?.[0].title ?? "", /取消前.*已结束/);
});

test("real Hub sessions match actual private workspace paths and cross-route stages start without resume", async (t) => {
  const fake = await fakeLodestar();
  t.after(fake.close);
  fake.mode.workspaceGuard = true;
  fake.mode.stageVerdicts = ["implemented", "changes_requested", "implemented", "approved", "verified"];
  const cwd = join(project, "scope-repo");
  mkdirSync(cwd);
  const git = (directory: string, ...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Session Test");
  git(cwd, "config", "user.email", "session@example.invalid");
  writeFileSync(join(cwd, "README.md"), "workspace scope");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-m", "base");
  const remote = join(home, "scope.git");
  git(home, "clone", "--bare", cwd, remote);
  const adapter = await plugin();
  const command = turnFor(fake.clientFile).command;
  const ruleFile = join(home, "scope-rules.json");
  const failure = { blocked: "$human", execution_failed: "$human" };
  writeFileSync(
    ruleFile,
    JSON.stringify({
      sources: { app: { name: "应用" } },
      agents: { scope: { name: "scope", worker: "scope-mac", use: "lodestar", access: "full", command } },
      channels: {},
      rules: [
        {
          name: "scope-intake",
          when: { source: "app", types: ["scope.request"] },
          to: "scope",
          cwd,
          prompt: "scope",
          workflow: "scope",
        },
        ...["execute", "review", "rework", "verify"].map((name) => ({
          name,
          when: { source: "app", types: [`internal.${name}`] },
          to: "scope",
          cwd,
          prompt: name,
          group: name,
          parallel: 1,
        })),
      ],
      workflows: {
        scope: {
          entry: "execute",
          max_transitions: 12,
          stages: {
            execute: {
              route: "execute",
              mode: "write",
              max_visits: 2,
              on: { implemented: "review", ...failure },
              checks: [],
            },
            review: {
              route: "review",
              mode: "inspect",
              max_visits: 3,
              on: { changes_requested: "rework", approved: "verify", ...failure },
              checks: [],
            },
            rework: {
              route: "rework",
              mode: "write",
              max_visits: 2,
              on: { implemented: "review", ...failure },
              checks: [],
            },
            verify: {
              route: "verify",
              mode: "inspect",
              max_visits: 2,
              on: { verified: "$complete", ...failure },
              checks: [],
            },
          },
          git: { remote, base_ref: "refs/heads/main", task_ref_prefix: "refs/heads/autoloop/", artifact_paths: [] },
          human: { options: [{ label: "重试", action: "retry" }] },
        },
      },
    }),
  );
  const hub = await import("../host/runtime.ts");
  assert.equal(hub.reloadRules(ruleFile).problem, undefined);
  const taskId = hub.execute(
    "submitProjectTask",
    [
      "app",
      {
        id: "scope-task",
        type: "scope.request",
        subject: "scope",
        goal: "workspace binding",
        acceptance: ["same scoped native workspace"],
      },
    ],
    Date.now(),
  ).task_id;
  const sessionsSeen: (string | null)[] = [];
  const workDirs: string[] = [];
  for (let i = 0; i < 5; i++) {
    const job = hub.claimNext("scope-mac", `scope-token-${i}`, Date.now())!;
    assert.ok(job?.stage, `stage ${i} must be claimable`);
    sessionsSeen.push(job.session);
    const turn: Turn = {
      ...turnFor(fake.clientFile),
      prompt: job.rule.prompt!,
      cwd: job.rule.cwd!,
      resume: job.session,
      session: job.session ?? `new-${i}`,
      stage: job.stage,
      command: job.agent.command,
      description: job.stage.stage_id,
    };
    if (i < 2) {
      fake.mode.complete = false;
      fake.mode.postStatus = i === 1 ? 503 : 0;
      fake.mode.requestState = i === 1 ? "pending" : "admitted";
      fake.mode.durableRunId = i === 1 ? null : undefined;
    }
    adapter.command(turn);
    if (i < 2) {
      const initial = await adapter.reconcile!(turn);
      assert.equal(initial.stage?.binding?.provider, "codex");
      hub.started(job.run, job.token, { session: initial.session, stage: initial.stage }, Date.now());
      assert.equal(hub.getView().get("project_tasks", taskId)!.state, i === 1 ? "unknown" : "running");
      if (i === 0) {
        fake.mode.unknown = true;
        const unknown = await adapter.reconcile!(turn);
        assert.deepEqual(unknown.stage?.binding, initial.stage?.binding);
        hub.started(job.run, job.token, { session: unknown.session, stage: unknown.stage }, Date.now());
        assert.equal(hub.getView().get("project_tasks", taskId)!.state, "unknown");
        fake.mode.unknown = false;
      }
      const native = fake.runs.get(job.stage.execution_id)!;
      native.status = native.workers[0].status = "running";
      fake.mode.requestState = "admitted";
      fake.mode.durableRunId = undefined;
      const running = await adapter.reconcile!(turn);
      assert.deepEqual(running.stage?.binding, initial.stage?.binding);
      hub.started(job.run, job.token, { session: running.session, stage: running.stage }, Date.now());
      assert.equal(hub.getView().get("project_tasks", taskId)!.state, "running");
      native.status = native.workers[0].status = "completed";
      native.workers[0].final_output = `\`\`\`agent-autoloop-stage\n${JSON.stringify({ verdict: i === 0 ? "implemented" : "changes_requested", summary: "measured result", artifacts: [], findings: [] })}\n\`\`\``;
      fake.mode.complete = true;
      fake.mode.postStatus = 0;
      fake.mode.requestState = "resolved";
    }
    const seen = await adapter.reconcile!(turn);
    assert.equal(seen.finished, true, JSON.stringify(seen));
    assert.notEqual(seen.result?.stage?.verdict, "execution_failed");
    assert.ok(seen.session && seen.stage);
    workDirs.push(seen.stage.binding!.workdir!);
    hub.started(job.run, job.token, { session: seen.session, stage: seen.stage }, Date.now());
    hub.finish(job.run, job.token, seen.result!, Date.now());
  }
  assert.deepEqual(sessionsSeen, [null, null, null, "native-workspace-2", null]);
  assert.equal(workDirs[1], workDirs[3], "same route/mode reuses the same private clone");
  assert.equal(new Set(workDirs).size, 4, "all distinct routes have distinct private workspaces");
  const posts = fake.calls.filter((call) => call.method === "POST");
  assert.deepEqual(
    posts.map((call) => call.body.session_id ?? null),
    sessionsSeen,
  );
  assert.equal(posts.length, 5, "no rejected native resume is retried fresh");
  assert.equal((await import("../kernel/query.ts")).projectTask(hub.getView(), taskId)!.state, "completed");
});
