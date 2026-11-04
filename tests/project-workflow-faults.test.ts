// Failure modes: lost admission/result/card responses duplicate work, restart/rebuild releases an uncertain execution,
// stale revision/session/binding data advances, cancellation erases a late terminal, or push response loss reruns work.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, test } from "node:test";
import { empty, evolve, rows } from "../kernel/evolve.ts";
import { Conflict } from "../kernel/errors.ts";
import { projectTask } from "../kernel/query.ts";
import { prepareStageWorkspace, publishWriteStage } from "../plugins/lodestar/git.ts";
import { observeTurn, prepareTurn } from "../plugins/lodestar/run.ts";
import type { Turn } from "../worker/agents.ts";
import { at, setup } from "./helpers.ts";
import { startLodestarInterop } from "./project-workflow-fixture.ts";

const home = setup("project-workflow-faults");
const recipe = path.join(import.meta.dirname, "..", "examples", "recipes", "project-workflow", "rules.json");
const rules = JSON.parse(readFileSync(recipe, "utf8"));
for (const stage of Object.values(rules.workflows["project-workflow"].stages) as any[]) {
  stage.checks = stage.checks.map((check: any) => ({ ...check, argv: [process.execPath, "-e", "process.exit(0)"] }));
}
const rulesFile = path.join(home, "rules.json");
writeFileSync(rulesFile, JSON.stringify(rules));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;

const hub = await import("../host/runtime.ts");
const baseRules = structuredClone(hub.rules);

beforeEach(() => {
  for (const table of [
    "run_events",
    "runs",
    "events",
    "project_tasks",
    "stage_executions",
    "cards",
    "deliveries",
    "timers",
    "seen",
    "due",
  ])
    hub.fixtureClear(table as any);
  hub.execute("rules", [baseRules], Date.now());
});

const revision = (letter: string) => letter.repeat(40);
const sha = (letter: string) => letter.repeat(64);
const task = (id: string) => ({
  id,
  type: "project.requested",
  subject: id,
  goal: `exercise ${id}`,
  acceptance: ["measured evidence only"],
});
const claim = (worker: string, key: string, minute: number) => hub.claimNext(worker, key, at(minute))!;
function receipt(job: any, verdict: string, input: string, output = input, resolution?: any) {
  return {
    outcome: "done",
    summary: `${job.stage.stage_id}:${verdict}`,
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      verdict,
      input_revision: input,
      output_revision: output,
      remote_ref: `refs/heads/autoloop/${job.stage.task_id}`,
      artifacts: verdict === "blocked" ? [] : [{ path: "PLAN.md", revision: output, sha256: sha("f") }],
      checks: job.stage.checks.map((check: any) => ({ name: check.name, exit_code: 0, revision: output })),
      findings: [],
      ...(resolution ? { resolution } : {}),
    },
  };
}

test("lost admission/result responses and Hub rebuild preserve one execution and one next stage", () => {
  const input = task("response-loss");
  const accepted = hub.execute("submitProjectTask", ["projects", input], at(0));
  assert.equal(hub.execute("submitProjectTask", ["projects", input], at(1)).duplicate, true);
  const first = claim("mac-a", "lost-claim", 2);
  const recovered = claim("mac-a", "lost-claim", 3);
  assert.equal(recovered.run, first.run);
  const result = receipt(recovered, "planned", revision("a"), revision("b"));
  hub.finish(recovered.run, recovered.token, result, at(4));
  assert.equal(hub.finish(recovered.run, recovered.token, result, at(5)).duplicate, true);

  const current = projectTask(hub.getView(), accepted.task_id)!;
  assert.equal(current.executions.length, 2);
  assert.deepEqual(
    current.executions.map((item: any) => item.stage_id),
    ["plan", "execute"],
  );
  const rebuilt = evolve(empty(), hub.logAfter());
  try {
    assert.deepEqual(projectTask(rebuilt, accepted.task_id), current);
  } finally {
    rebuilt.close();
  }
});

test("lost card delivery and duplicate/stale answers create one trusted retry only", () => {
  const accepted = hub.execute("submitProjectTask", ["projects", task("card-loss")], at(0));
  const job = claim("mac-a", "blocked", 1);
  hub.finish(job.run, job.token, receipt(job, "blocked", revision("a")), at(2));
  const status = projectTask(hub.getView(), accepted.task_id)!;
  const card = hub.nextCard("project-cards", at(3))!;
  assert.equal(card.id, status.human_card);
  assert.equal(hub.nextCard("project-cards", at(3)), null);
  const repeated = hub.nextCard("project-cards", at(5))!;
  assert.equal(repeated.id, card.id, "lost delivery report returns the same logical card");
  hub.delivered("project-cards", card.id, card.version, "message-one", at(5));
  assert.throws(
    () => hub.answer(card.id, { choice: 0, by: "not-owner", channel: "project-cards", ref: "message-one" }, at(6)),
    /不能回答/,
  );
  assert.throws(
    () =>
      hub.answer(
        card.id,
        { choice: 0, by: "ou_REPLACE_WITH_OWNER_OPEN_ID", channel: "project-cards", ref: "stale" },
        at(6),
      ),
    /不是发出去/,
  );
  assert.equal(
    hub.answer(
      card.id,
      { choice: 0, by: "ou_REPLACE_WITH_OWNER_OPEN_ID", channel: "project-cards", ref: "message-one" },
      at(7),
    ).changed,
    true,
  );
  assert.equal(hub.answer(card.id, { choice: 0 }, at(8)).changed, false);
  assert.equal(rows(hub.getView(), "runs", { task_id: accepted.task_id }).length, 2);
});

test("wrong execution/session/binding and stale revision cannot mutate the active stage", () => {
  const accepted = hub.execute("submitProjectTask", ["projects", task("ownership")], at(0));
  const plan = claim("mac-a", "ownership-plan", 1);
  const progress = {
    execution_id: plan.stage!.execution_id,
    request_id: plan.stage!.execution_id,
    input_revision: revision("a"),
    remote_run_id: "remote-one",
    binding: { binding_id: "binding-a", project: "repo", identity: "planner", worker: "mac-a" },
  };
  hub.started(plan.run, plan.token, { session: "native-one", stage: progress }, at(2));
  assert.throws(() => hub.started(plan.run, plan.token, { session: "native-two", stage: progress }, at(3)), Conflict);
  assert.throws(
    () =>
      hub.started(
        plan.run,
        plan.token,
        { session: "native-one", stage: { ...progress, binding: { ...progress.binding, identity: "other" } } },
        at(3),
      ),
    Conflict,
  );
  assert.throws(
    () =>
      hub.started(
        plan.run,
        plan.token,
        { session: "native-one", stage: { ...progress, execution_id: "other" } },
        at(3),
      ),
    Conflict,
  );
  hub.finish(plan.run, plan.token, receipt(plan, "planned", revision("a"), revision("b")), at(4));
  const execute = claim("mac-b", "ownership-execute", 5);
  assert.throws(
    () => hub.finish(execute.run, execute.token, receipt(execute, "implemented", revision("c"), revision("d")), at(6)),
    Conflict,
  );
  assert.equal(projectTask(hub.getView(), accepted.task_id)!.state, "running");
});

test("cancel before claim, unknown operator resolution and late completion never replay business work", () => {
  const queued = hub.execute("submitProjectTask", ["projects", task("cancel-before")], at(0));
  hub.execute("cancelProjectTask", [queued.task_id, { request_id: "cancel-before" }], at(1));
  assert.equal(projectTask(hub.getView(), queued.task_id)!.state, "cancelled");

  const unknown = hub.execute("submitProjectTask", ["projects", task("operator-resolution")], at(2));
  const uncertainJob = claim("mac-a", "uncertain", 3);
  hub.heartbeat("mac-a", [uncertainJob.run], at(4));
  hub.heartbeat("mac-a", [], at(10));
  hub.sweep(at(10));
  assert.equal(projectTask(hub.getView(), unknown.task_id)!.state, "unknown");
  const resolution = {
    kind: "operator_attested",
    reason: "operator checked and stopped native work",
    at: new Date(at(11)).toISOString(),
    binding_id: "binding-original",
  };
  hub.finish(
    uncertainJob.run,
    uncertainJob.token,
    receipt(uncertainJob, "execution_failed", revision("a"), revision("a"), resolution),
    at(11),
  );
  assert.equal(projectTask(hub.getView(), unknown.task_id)!.state, "waiting_human");
  assert.equal(hub.claimNext("mac-a", "no-automatic-replay", at(12)), null);

  const late = hub.execute("submitProjectTask", ["projects", task("late")], at(13));
  const lateJob = claim("mac-a", "late", 14);
  hub.execute("cancelProjectTask", [late.task_id, { request_id: "cancel-late" }], at(15));
  hub.finish(lateJob.run, lateJob.token, receipt(lateJob, "planned", revision("a"), revision("b")), at(16));
  const lateStatus = projectTask(hub.getView(), late.task_id)!;
  assert.equal(lateStatus.state, "waiting_human");
  assert.equal(lateStatus.transitions, 0);
  assert.equal(lateStatus.late_outcomes.length, 1);
  assert.equal(rows(hub.getView(), "runs", { task_id: late.task_id }).length, 1);
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

test("lost Git push response is reconciled from immutable refs without a second model execution", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autoloop-push-loss-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const project = path.join(root, "project");
  const bin = path.join(root, "bin");
  mkdirSync(source);
  mkdirSync(bin);
  try {
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "Push Loss");
    git(source, "config", "user.email", "push@example.invalid");
    writeFileSync(path.join(source, "README.md"), "base\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "base");
    git(root, "clone", "--bare", source, remote);
    git(root, "clone", remote, project);
    git(project, "config", "user.name", "Push Loss");
    git(project, "config", "user.email", "push@example.invalid");
    const turn = {
      prompt: "write",
      session: "native",
      resume: null,
      cwd: project,
      access: "full",
      contextFile: path.join(root, "context.json"),
      folder: path.join(root, "turn"),
      invocation: "push-loss",
      stage: {
        task_id: "task-push-loss",
        execution_id: "execution-push-loss",
        generation: 1,
        stage_id: "execute",
        input_revision: null,
        workflow: {
          entry: "execute",
          max_transitions: 2,
          stages: {
            execute: {
              route: "writer",
              mode: "write",
              max_visits: 1,
              on: { implemented: "$complete", blocked: "$human", execution_failed: "$human" },
              checks: [],
            },
          },
          git: {
            remote,
            base_ref: "refs/heads/main",
            task_ref_prefix: "refs/heads/tasks/",
            artifact_paths: ["result.txt"],
          },
          human: { options: [] },
        },
        route: { name: "writer", agent_id: "writer", worker: "mac", cwd: project, access: "full" },
        git: {
          remote,
          base_ref: "refs/heads/main",
          task_ref_prefix: "refs/heads/tasks/",
          artifact_paths: ["result.txt"],
        },
        checks: [],
        evidence: [],
      },
    } as Turn;
    mkdirSync(turn.folder);
    const workspace = prepareStageWorkspace(turn);
    writeFileSync(path.join(workspace.workDir, "result.txt"), "committed\n");
    git(workspace.workDir, "config", "user.name", "Push Loss");
    git(workspace.workDir, "config", "user.email", "push@example.invalid");
    git(workspace.workDir, "add", "result.txt");
    git(workspace.workDir, "commit", "-m", "result");

    const realGit = execFileSync("/bin/sh", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
    const marker = path.join(root, "lost-once");
    const shim = path.join(bin, "git");
    writeFileSync(
      shim,
      `#!/bin/sh\n"${realGit}" "$@"\nstatus=$?\ncase " $* " in\n  *" push "*) if [ ! -e "${marker}" ]; then : >"${marker}"; exit 1; fi;;\nesac\nexit $status\n`,
    );
    chmodSync(shim, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    try {
      const published = publishWriteStage(workspace, ["result.txt"]);
      assert.equal(published.outputRevision, git(workspace.workDir, "rev-parse", "HEAD"));
      assert.ok(existsSync(marker));
      assert.equal(
        git(root, "ls-remote", "--refs", remote, published.remoteRef).split(/\s+/, 1)[0],
        published.outputRevision,
      );
    } finally {
      process.env.PATH = previous;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function requestBody(request: IncomingMessage) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

test("lost Lodestar admission response and fake daemon restart reuse one request and native execution", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "autoloop-daemon-restart-"));
  const project = path.join(root, "project");
  const folder = path.join(root, "turn");
  mkdirSync(project);
  mkdirSync(folder);
  const requests = new Map<string, any>();
  let postCount = 0;
  let loseFirstPost = true;
  const binding = {
    installation_id: "installation-restart",
    binding_id: "binding-restart",
    project: "repo",
    chat_id: "chat-restart",
    work_dir: project,
  };
  const handler = async (request: IncomingMessage, response: any) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    const body = await requestBody(request);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== "Bearer restart-capability") return send(403, { error: "bad capability" });
    if (url.pathname === "/agents/project-binding") return send(200, binding);
    if (url.pathname === "/agents/identities") {
      return send(200, {
        identities: [{ id: "executor", status: "ready", provider: "codex", supported_efforts: ["high"] }],
      });
    }
    if (request.method === "POST" && url.pathname === "/agents/runs") {
      postCount++;
      const run = requests.get(body.request_id) ?? {
        run_id: "remote-restart",
        request_id: body.request_id,
        binding: "project",
        project: "repo",
        work_dir: body.work_dir,
        status: "completed",
        workers: [
          {
            identity_id: "executor",
            provider: "codex",
            status: "completed",
            session_id: "native-restart",
            final_output: "真正完成",
          },
        ],
      };
      requests.set(body.request_id, run);
      if (loseFirstPost) {
        loseFirstPost = false;
        request.socket.destroy();
        return;
      }
      return send(202, run);
    }
    const matched = /^\/agents\/requests\/([^/]+)$/.exec(url.pathname);
    if (matched) {
      const id = decodeURIComponent(matched[1]!);
      const run = requests.get(id);
      return run
        ? send(200, { request_id: id, run_id: run.run_id, state: "resolved", run })
        : send(404, { error: "not found" });
    }
    return send(404, { error: "not found" });
  };
  let server = createServer((request, response) => void handler(request, response));
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const clientFile = path.join(root, "client.json");
  writeFileSync(clientFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, capability: "restart-capability" }));
  const turn = {
    prompt: "ordinary project work",
    session: "local-placeholder",
    resume: null,
    cwd: project,
    access: "full",
    contextFile: path.join(folder, "context.json"),
    folder,
    invocation: "stable-admission-request",
    command: ["--project", "repo", "--identity", "executor", "--client-file", clientFile],
  } as Turn;
  writeFileSync(turn.contextFile, "{}");
  prepareTurn(turn);
  const uncertain = await observeTurn(turn);
  assert.ok(!uncertain.finished && !uncertain.text);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = createServer((request, response) => void handler(request, response));
  server.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const recovered = await observeTurn(turn);
  assert.equal(recovered.finished, true);
  assert.equal(recovered.text, "真正完成");
  assert.equal(recovered.session, "native-restart");
  assert.equal(postCount, 1, "restart recovery uses request lookup, never another POST");
});

function workerFaultRules(use: string) {
  return hub.parseRules(
    JSON.stringify({
      timezone: "UTC",
      sources: { projects: { name: "projects" } },
      agents: { fault: { name: "fault", worker: "fault-mac", use, access: "full" } },
      channels: {},
      rules: [
        {
          name: "fault-intake",
          when: { source: "projects", types: ["project.requested"] },
          to: "fault",
          cwd: home,
          prompt: "trusted",
          workflow: "fault",
        },
        {
          name: "fault-stage",
          when: { source: "projects", types: ["workflow-internal"] },
          to: "fault",
          cwd: home,
          prompt: "trusted",
        },
      ],
      workflows: {
        fault: {
          entry: "verify",
          max_transitions: 2,
          stages: {
            verify: {
              route: "fault-stage",
              mode: "inspect",
              max_visits: 1,
              on: { verified: "$complete", blocked: "$human", execution_failed: "$human" },
              checks: [{ name: "proof", argv: [process.execPath, "--version"], timeout_ms: 1000 }],
            },
          },
          git: {
            remote: "file:///tmp/fault.git",
            base_ref: "refs/heads/main",
            task_ref_prefix: "refs/heads/tasks/",
            artifact_paths: [],
          },
          human: { options: [{ label: "cancel", action: "cancel" }] },
        },
      },
      elsewhere: [],
    }),
  );
}

function installManagedFaultAdapter(use: string, kind: "late" | "operator" | "cancelled") {
  const folder = path.join(home, "plugins", use);
  mkdirSync(folder, { recursive: true });
  const resolution =
    kind === "operator"
      ? `{kind:"operator_attested",reason:"operator stopped native work",at:"2026-11-04T00:00:00.000Z",binding_id:"binding"}`
      : "undefined";
  const result =
    kind === "cancelled"
      ? `{outcome:"cancelled",summary:"confirmed stop"}`
      : `{outcome:"done",summary:"${kind}",session:"native-fault",stage:{execution_id:turn.stage.execution_id,request_id:turn.stage.execution_id,verdict:"${kind === "operator" ? "execution_failed" : "verified"}",input_revision:REV,output_revision:REV,remote_ref:"refs/heads/tasks/fault",artifacts:[],checks:[{name:"proof",exit_code:0,revision:REV}],findings:[],...(RESOLUTION?{resolution:RESOLUTION}:{})}}`;
  writeFileSync(
    path.join(folder, "agent.ts"),
    `const REV="a".repeat(40);const RESOLUTION=${resolution};export default {resumePolicy:"strict",command(){return [process.execPath,"-e","setInterval(()=>{},1000)"]},read(){return {pending:true}},async reconcile(){return {pending:true}},async cancel(turn){return {finished:true,session:"native-fault",${kind === "cancelled" ? "" : 'stage:{execution_id:turn.stage.execution_id,request_id:turn.stage.execution_id,remote_state:"terminal"},'}result:${result}}}};`,
  );
}

async function runManagedWorkerFault(kind: "late" | "operator" | "cancelled") {
  const use = `fault-${kind}-${randomUUID()}`;
  installManagedFaultAdapter(use, kind);
  hub.execute("rules", [workerFaultRules(use)], Date.now());
  const { serve } = await import("../host/http.ts");
  const { hubClient } = await import("../protocol/client.ts");
  const { createWorker } = await import("../worker/worker.ts");
  const sourceKey = hub.addKey("source", "projects");
  const ownerKey = hub.addKey("owner", `owner-${kind}-${randomUUID()}`);
  const workerKey = hub.addKey("worker", "fault-mac");
  const server = serve(0, "127.0.0.1", { commit: "fault" });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const source = hubClient(url, sourceKey);
  const owner = hubClient(url, ownerKey);
  const worker = createWorker({ hub: hubClient(url, workerKey), name: "fault-mac", capacity: 1, wait: 0 });
  try {
    const accepted = await source.submitProjectTask(task(`worker-${kind}-${randomUUID()}`));
    await worker.tick();
    const cancelAck = await owner.cancelProjectTask(accepted.task_id, { request_id: `cancel-${kind}` });
    const observed: string[] = [`cancel:${cancelAck.state}`];
    let status: any;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await worker.tick();
      status = await owner.projectTask(accepted.task_id);
      observed.push(status.state);
      if (["waiting_human", "cancelled"].includes(status.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { ...status, _observed: observed };
  } finally {
    for (const entry of worker.entries())
      if (entry.pid)
        try {
          process.kill(-entry.pid, "SIGKILL");
        } catch {}
    server.closeAllConnections();
    server.close();
  }
}

test("real worker preserves structured cancel races and plain confirmed cancellation shapes", async () => {
  const late = await runManagedWorkerFault("late");
  assert.equal(late.state, "waiting_human", JSON.stringify(late._observed));
  assert.equal(late.late_outcomes[0].stage.verdict, "verified");
  const operator = await runManagedWorkerFault("operator");
  assert.equal(operator.state, "cancelled");
  assert.equal(operator.resolution.kind, "operator_attested");
  const cancelled = await runManagedWorkerFault("cancelled");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.executions[0].result, null);
});

test("real worker turns a missing task adapter into execution_failed evidence instead of dropping it", async () => {
  hub.execute("rules", [workerFaultRules(`missing-${randomUUID()}`)], Date.now());
  const { serve } = await import("../host/http.ts");
  const { hubClient } = await import("../protocol/client.ts");
  const { createWorker } = await import("../worker/worker.ts");
  const sourceKey = hub.addKey("source", "projects");
  const ownerKey = hub.addKey("owner", `owner-missing-${randomUUID()}`);
  const workerKey = hub.addKey("worker", "fault-mac");
  const server = serve(0, "127.0.0.1", { commit: "fault" });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = hubClient(url, ownerKey);
  const worker = createWorker({ hub: hubClient(url, workerKey), name: "fault-mac", capacity: 1, wait: 0 });
  try {
    const accepted = await hubClient(url, sourceKey).submitProjectTask(task(`missing-${randomUUID()}`));
    let status: any;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await worker.tick();
      status = await owner.projectTask(accepted.task_id);
      if (status.state === "waiting_human") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status.state, "waiting_human");
    assert.equal(status.executions[0].result.verdict, "execution_failed");
    assert.match(status.executions[0].result.diagnostics[0], /插件|adapter|module|找不到/i);
  } finally {
    for (const entry of worker.entries())
      if (entry.pid)
        try {
          process.kill(-entry.pid, "SIGKILL");
        } catch {}
    server.closeAllConnections();
    server.close();
  }
});

const lodestarRepo = process.env.AGENT_AUTOLOOP_LODESTAR_REPO;
const pinnedBun = process.env.AGENT_AUTOLOOP_PINNED_BUN;
test(
  "opt-in real API persistence failures and failed-alive restart keep the original Hub executions occupied",
  { skip: !lodestarRepo || !pinnedBun },
  async (t) => {
    const remote = await startLodestarInterop(t, { lodestarRepo: lodestarRepo!, bun: pinnedBun!, faults: true });
    git(remote.project, "init", "-b", "main");
    git(remote.project, "config", "user.name", "Interop Fault");
    git(remote.project, "config", "user.email", "fault@example.invalid");
    writeFileSync(path.join(remote.project, "README.md"), "fault baseline\n");
    git(remote.project, "add", "README.md");
    git(remote.project, "commit", "-m", "fault baseline");
    const gitRemote = path.join(remote.root, "remote.git");
    git(remote.root, "clone", "--bare", remote.project, gitRemote);
    const names = ["admission", "failed-alive"];
    const policy: any = {
      sources: { projects: { name: "projects" } },
      agents: {},
      channels: {},
      rules: [],
      workflows: {},
    };
    for (const name of names) {
      const worker = "fault-interop";
      policy.agents[name] = {
        name,
        worker,
        use: "lodestar",
        access: "full",
        command: ["--project", "repo", "--identity", remote.identity, "--client-file", remote.clientFile],
      };
      policy.rules.push(
        {
          name: `intake-${name}`,
          when: { source: "projects", types: [`fault.${name}`] },
          workflow: name,
          to: name,
          cwd: remote.project,
          prompt: `trusted fault-${name}`,
        },
        {
          name: `route-${name}`,
          when: { source: "projects", types: [`internal.${name}`] },
          to: name,
          cwd: remote.project,
          prompt: `trusted fault-${name}`,
        },
      );
      policy.workflows[name] = {
        entry: "plan",
        max_transitions: 2,
        stages: {
          plan: {
            route: `route-${name}`,
            mode: "write",
            max_visits: 1,
            on: { planned: "$complete", blocked: "$human", execution_failed: "$human" },
            checks: [{ name: "proof", argv: [process.execPath, "--version"], timeout_ms: 1000 }],
          },
        },
        git: {
          remote: gitRemote,
          base_ref: "refs/heads/main",
          task_ref_prefix: "refs/heads/tasks/",
          artifact_paths: [],
        },
        human: { options: [{ label: "cancel", action: "cancel" }] },
      };
    }
    hub.execute("rules", [hub.parseRules(JSON.stringify(policy))], Date.now());
    const { serve } = await import("../host/http.ts");
    const { hubClient } = await import("../protocol/client.ts");
    const { createWorker } = await import("../worker/worker.ts");
    const sourceKey = hub.addKey("source", "projects");
    const ownerKey = hub.addKey("owner", "fault-interop-owner");
    const server = serve(0, "127.0.0.1", { commit: "real-api-fault" });
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const owner = hubClient(url, ownerKey);
    const source = hubClient(url, sourceKey);
    const workerLogs: string[] = [];
    // A worker home belongs to one observer. Its two slots let both uncertain native runs stay in hand.
    const workers = [
      createWorker({
        hub: hubClient(url, hub.addKey("worker", "fault-interop")),
        name: "fault-interop",
        capacity: 2,
        wait: 0,
        log: (line) => workerLogs.push(line),
      }),
    ];
    const priorHome = process.env.HOME;
    process.env.HOME = remote.root;
    const wait = async (condition: () => Promise<boolean>, explanation: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        for (const worker of workers) await worker.tick();
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(
        `${explanation}: ${JSON.stringify({
          tasks: await Promise.all(
            tasks.map(async (task) => {
              const current = await owner.projectTask(task.task_id);
              return { task_id: current.task_id, state: current.state, executions: current.executions };
            }),
          ),
          remote: await remote.control("state"),
          workerLogs: workerLogs.slice(-8),
          entries: workers.flatMap((worker) =>
            worker.entries().map((entry) => ({
              run: entry.run,
              turn: entry.turn,
              diagnostic: entry.diagnostic,
              result: entry.result,
            })),
          ),
        })}`,
      );
    };
    const tasks: any[] = [];
    try {
      await remote.control("block-admission");
      const created = await source.submitProjectTask({
        ...task(`interop-admission-${randomUUID()}`),
        type: "fault.admission",
      });
      tasks.push(await owner.projectTask(created.task_id));
      const admissionId = tasks[0].executions[0].execution_id;
      await wait(
        async () => (await owner.projectTask(created.task_id)).state === "unknown",
        "post-admission HTTP 503 must keep the Hub task unknown",
      );
      const admission = await remote.request(admissionId);
      const firstStats = await remote.control("state");
      assert.equal(admission.state, "pending");
      assert.equal(admission.run_id, null, "only the durable request record supplies this ID");
      assert.equal(admission.run.status, "running", "null durable run_id does not prove the native run never started");
      assert.deepEqual(firstStats.postStatuses, [503]);
      assert.equal(firstStats.starts, 1);
      assert.equal(firstStats.live, 1);

      await remote.control("allow-admission");
      const second = await source.submitProjectTask({
        ...task(`interop-failed-${randomUUID()}`),
        type: "fault.failed-alive",
      });
      tasks.push(await owner.projectTask(second.task_id));
      const failedId = tasks[1].executions[0].execution_id;
      await wait(
        async () => (await owner.projectTask(second.task_id)).state === "unknown",
        "failed snapshot with a live native handle must remain unknown in the Hub",
      );
      const failed = await remote.request(failedId);
      assert.equal(failed.state, "admitted");
      assert.equal(failed.run.status, "failed");
      assert.equal(failed.run_id, failed.run.run_id);
      assert.equal((await remote.control("state")).live, 2);

      await remote.control("restart");
      for (const task of tasks) {
        const state = await remote.request(task.executions[0].execution_id);
        assert.equal(state.state, "unknown");
        assert.equal(state.run.status, "failed");
      }
      const first = await owner.projectTask(created.task_id);
      await owner.cancel(first.runs[0].id);
      await wait(
        async () => (await owner.projectTask(created.task_id)).state === "unknown",
        "legacy run cancel must preserve uncertain native work",
      );
      for (let tick = 0; tick < 5; tick++) {
        for (const worker of workers) await worker.tick();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const finishedStats = await remote.control("state");
      assert.equal(finishedStats.starts, 2, "API errors, restart and cancel must never admit replacement native runs");
      assert.equal(finishedStats.live, 2);
      assert.deepEqual(finishedStats.postStatuses, [503, 202], "adapter re-observes the same requests after admission");
      for (const original of tasks) {
        const observed = await owner.projectTask(original.task_id);
        assert.equal(observed.state, "unknown", "observer heartbeats do not erase unknown");
        assert.equal(observed.current_execution, original.current_execution);
        assert.equal(observed.executions.length, 1);
        assert.equal(observed.runs.length, 1);
        assert.equal(observed.transitions, 0);
      }
      assert.ok(
        hub.getView().get("runs", first.runs[0].id)!.cancel_at,
        "legacy cancel leaves the durable fence in place",
      );
      assert.ok(hub.cancels("fault-interop").includes(first.runs[0].id));
      t.diagnostic(
        JSON.stringify({
          admission: {
            state: admission.state,
            run_id: admission.run_id,
            liveRun: admission.run.run_id,
            status: admission.run.status,
          },
          failed: { state: failed.state, run_id: failed.run_id, status: failed.run.status },
          afterRestart: await Promise.all(
            tasks.map(async (task) => {
              const request = await remote.request(task.executions[0].execution_id);
              return {
                request_id: request.request_id,
                run_id: request.run_id,
                state: request.state,
                status: request.run.status,
              };
            }),
          ),
          native: finishedStats,
          hubExecutions: tasks.map((task) => task.current_execution),
          cancelledRun: first.runs[0].id,
          durableCancelFence: true,
        }),
      );
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      for (const worker of workers)
        for (const entry of worker.entries())
          if (entry.pid) {
            try {
              process.kill(-entry.pid, "SIGKILL");
            } catch {}
          }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
