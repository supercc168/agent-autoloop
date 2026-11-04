// Failure modes: a source submits as another source, a worker reads task state, malformed stage progress mutates the
// execution, ordinary runs accept stage receipts, task results mix generic actions, or legacy stop bypasses task fences.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setup } from "./helpers.ts";
import { checkSchema } from "../protocol/schema.ts";

const home = setup("project-tasks-http");
const rulesFile = join(home, "rules.json");
const rules = JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
rules.rules.push(
  {
    name: "项目入口",
    when: { source: "app", types: ["project.requested"] },
    to: "a1",
    cwd: "/trusted/intake",
    prompt: "接收任务。",
    workflow: "delivery",
  },
  {
    name: "规划阶段",
    when: { source: "app", types: ["internal.plan"] },
    to: "a1",
    cwd: "/trusted/plan",
    prompt: "规划。",
  },
);
rules.workflows = {
  delivery: {
    entry: "plan",
    max_transitions: 4,
    stages: {
      plan: {
        route: "规划阶段",
        mode: "inspect",
        max_visits: 2,
        on: { verified: "$complete", blocked: "$human", execution_failed: "$failed" },
        checks: [{ name: "plan", argv: ["node", "--version"], timeout_ms: 30_000 }],
      },
    },
    git: {
      remote: "file:///tmp/project.git",
      base_ref: "refs/heads/main",
      task_ref_prefix: "refs/heads/autoloop/",
      artifact_paths: ["PLAN.md"],
    },
    recheck: "plan",
    human: { options: [{ label: "重试", action: "retry" }] },
  },
};
writeFileSync(rulesFile, JSON.stringify(rules));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;

const runtime = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");
const { hubClient, HubError } = await import("../protocol/client.ts");
const keys = {
  app: runtime.addKey("source", "app"),
  ops: runtime.addKey("source", "ops"),
  worker: runtime.addKey("worker", "w1"),
  owner: runtime.addKey("owner", "owner"),
};
const server = serve(0, "127.0.0.1", { commit: "project-task-test" });
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  for (const table of ["run_events", "runs", "events", "project_tasks", "stage_executions", "cards", "deliveries"]) {
    runtime.fixtureClear(table as any);
  }
});

const task = () => ({
  id: "http-1",
  type: "project.requested",
  subject: "repo-1",
  goal: "Plan the accepted change",
  acceptance: ["Plan artifact is committed"],
  data: { ticket: "H-1" },
});
async function raw(path: string, key: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() } as { status: number; body: any };
}

test("source and owner intake have distinct authority and owner-only status", async () => {
  const sourceClient = hubClient(base, keys.app);
  const accepted = await sourceClient.submitProjectTask(task());
  assert.match(accepted.task_id, /^task_[0-9a-f]{32}$/);
  assert.equal(accepted.duplicate, false);
  assert.equal((await sourceClient.submitProjectTask(task())).duplicate, true);

  assert.equal((await raw("/v1/project-tasks", keys.worker, task())).status, 401);
  assert.equal((await raw("/v1/project-tasks", keys.app, { ...task(), source: "ops" })).status, 400);
  assert.equal((await raw(`/v1/project-tasks/${accepted.task_id}`, keys.app)).status, 401);

  const ownerClient = hubClient(base, keys.owner);
  const status = await ownerClient.projectTask(accepted.task_id);
  assert.equal(status.source, "app");
  assert.equal(status.input.goal, task().goal);
  assert.equal(status.state, "queued");
  const ownerAccepted = await ownerClient.submitProjectTask({ ...task(), id: "owner-1", source: "app" });
  assert.equal((await ownerClient.projectTask(ownerAccepted.task_id)).source, "app");
  await assert.rejects(() => ownerClient.submitProjectTask({ ...task(), id: "bad", source: "missing" }), HubError);
});

test("stage progress and receipt are strictly bound to the claimed task execution", async () => {
  const accepted = await hubClient(base, keys.app).submitProjectTask({ ...task(), id: "progress-1" });
  const work = await hubClient(base, keys.worker).work({ claim: "progress", wait: 0, running: [], capacity: true });
  const job = work.job!;
  assert.equal(job.stage.task_id, accepted.task_id);
  const progress = {
    execution_id: job.stage.execution_id,
    request_id: job.stage.execution_id,
    remote_run_id: "agent-1",
    input_revision: "a".repeat(40),
    remote_state: "running",
    binding: { binding_id: "binding-1", worker: "w1", project: "project-a", identity: "reviewer" },
  };
  await hubClient(base, keys.worker).started(job.run, job.token, { session: "native-1", stage: progress });
  await hubClient(base, keys.worker).started(job.run, job.token, { session: "native-1", stage: progress });
  assert.equal(
    (await raw(`/v1/runs/${job.run}/started`, job.token, { session: "native-2", stage: progress })).status,
    409,
  );
  assert.equal((await raw(`/v1/runs/${job.run}/started`, job.token, { session: "native-2" })).status, 409);
  assert.equal((await raw(`/v1/runs/${job.run}/started`, job.token, { session: "" })).status, 409);
  assert.equal((await raw(`/v1/runs/${job.run}/started`, job.token, { session: null })).status, 400);
  assert.equal((await raw(`/v1/runs/${job.run}/started`, job.token, {})).status, 200);
  assert.equal((await raw(`/v1/runs/${job.run}/started`, job.token, { session: "native-1" })).status, 200);
  assert.equal(
    (await raw(`/v1/runs/${job.run}/started`, job.token, { stage: { ...progress, execution_id: "other" } })).status,
    409,
  );
  const status = await hubClient(base, keys.owner).projectTask(accepted.task_id);
  assert.equal(status.executions[0].progress.binding.binding_id, "binding-1");
  assert.equal(status.executions[0].input_revision, "a".repeat(40));

  const stage = {
    execution_id: job.stage.execution_id,
    request_id: job.stage.execution_id,
    verdict: "verified",
    input_revision: "a".repeat(40),
    output_revision: "a".repeat(40),
    remote_ref: `refs/heads/autoloop/${accepted.task_id}`,
    artifacts: [{ path: "PLAN.md", revision: "a".repeat(40), sha256: "c".repeat(64) }],
    checks: [{ name: "plan", exit_code: 0, revision: "a".repeat(40) }],
    findings: [],
  };
  assert.equal((await raw(`/v1/runs/${job.run}/result`, job.token, { outcome: "done", stage, ask: [] })).status, 200);
  assert.equal((await hubClient(base, keys.owner).projectTask(accepted.task_id)).state, "completed");
});

test("legacy HTTP cancel atomically stops queued tasks and fences active terminal results", async () => {
  const source = hubClient(base, keys.app);
  const owner = hubClient(base, keys.owner);
  const queued = await source.submitProjectTask({ ...task(), id: "legacy-queued" });
  const queuedStatus = await owner.projectTask(queued.task_id);
  assert.equal((await raw(`/v1/runs/${queuedStatus.runs[0].id}/cancel`, keys.owner, {})).status, 200);
  const cancelled = await owner.projectTask(queued.task_id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.executions[0].state, "cancelled");

  const active = await source.submitProjectTask({ ...task(), id: "legacy-active" });
  const job = (
    await hubClient(base, keys.worker).work({ claim: "legacy-active", wait: 0, running: [], capacity: true })
  ).job!;
  assert.equal((await raw(`/v1/runs/${job.run}/cancel`, keys.owner, {})).status, 200);
  assert.equal((await owner.projectTask(active.task_id)).state, "cancel_requested");
  const result = {
    outcome: "done",
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      verdict: "blocked",
      input_revision: "a".repeat(40),
      output_revision: "a".repeat(40),
      artifacts: [],
      checks: [],
      findings: [],
    },
  };
  assert.equal((await raw(`/v1/runs/${job.run}/result`, job.token, result)).status, 200);
  const status = await owner.projectTask(active.task_id);
  assert.equal(status.state, "waiting_human");
  assert.equal(status.executions.length, 1);
  assert.equal(status.late_outcomes.length, 1);
  assert.equal(status.transitions, 0);

  await source.event({ id: "legacy-ordinary", type: "feedback.new", subject: "ordinary" });
  const ordinary = (
    await hubClient(base, keys.worker).work({ claim: "legacy-ordinary", wait: 0, running: [], capacity: true })
  ).job!;
  assert.equal(ordinary.stage, undefined);
  assert.equal((await raw(`/v1/runs/${ordinary.run}/cancel`, keys.owner, {})).status, 200);
  assert.equal((await raw(`/v1/runs/${ordinary.run}/result`, ordinary.token, { outcome: "cancelled" })).status, 200);
});

test("ordinary and task results cannot cross their protocol modes", async () => {
  await hubClient(base, keys.app).event({ id: "ordinary", type: "feedback.new", subject: "ordinary" });
  const ordinary = (
    await hubClient(base, keys.worker).work({ claim: "ordinary", wait: 0, running: [], capacity: true })
  ).job!;
  const bogusStage = {
    execution_id: "x",
    request_id: "x",
    verdict: "planned",
    artifacts: [],
    checks: [],
    findings: [],
  };
  assert.equal(
    (await raw(`/v1/runs/${ordinary.run}/result`, ordinary.token, { outcome: "done", stage: bogusStage })).status,
    400,
  );

  const accepted = await hubClient(base, keys.app).submitProjectTask({ ...task(), id: "mixed-1" });
  const taskJob = (await hubClient(base, keys.worker).work({ claim: "mixed", wait: 0, running: [], capacity: true }))
    .job!;
  const stage = {
    execution_id: taskJob.stage.execution_id,
    request_id: taskJob.stage.execution_id,
    verdict: "planned",
    input_revision: "d".repeat(40),
    output_revision: "e".repeat(40),
    remote_ref: `refs/heads/autoloop/${accepted.task_id}`,
    artifacts: [],
    checks: [],
    findings: [],
  };
  assert.equal(
    (
      await raw(`/v1/runs/${taskJob.run}/result`, taskJob.token, {
        outcome: "done",
        stage,
        notice: [{ title: "route", text: "change it" }],
      })
    ).status,
    400,
  );
  assert.equal((await hubClient(base, keys.owner).projectTask(accepted.task_id)).state, "running");
});

test("published JSON schemas match task, progress and stage result validators", () => {
  const progress = {
    execution_id: "task:g1:e1",
    request_id: "task:g1:e1",
    input_revision: "a".repeat(40),
    binding: { binding_id: "binding", project: "project" },
  };
  const result = {
    execution_id: "task:g1:e1",
    request_id: "task:g1:e1",
    verdict: "approved",
    input_revision: "a".repeat(40),
    output_revision: "a".repeat(40),
    artifacts: [],
    checks: [],
    findings: [],
  };
  assert.deepEqual(checkSchema("project-task", task()), []);
  assert.deepEqual(checkSchema("stage-progress", progress), []);
  assert.deepEqual(checkSchema("stage-result", result), []);
  assert.ok(checkSchema("project-task", { ...task(), worker: "untrusted" }).length);
  assert.ok(checkSchema("stage-result", { ...result, next_stage: "execute" }).length);
});

test("owner cancel and recheck mutations require stable request ids and cannot be used by sources", async () => {
  const source = hubClient(base, keys.app);
  const owner = hubClient(base, keys.owner);
  const queued = await source.submitProjectTask({ ...task(), id: "http-cancel" });
  assert.equal(
    (await raw(`/v1/project-tasks/${queued.task_id}/cancel`, keys.app, { request_id: "cancel-1" })).status,
    401,
  );
  assert.equal((await raw(`/v1/project-tasks/${queued.task_id}/cancel`, keys.owner, {})).status, 400);
  assert.equal((await owner.cancelProjectTask(queued.task_id, { request_id: "cancel-1" })).state, "cancelled");
  assert.equal((await owner.cancelProjectTask(queued.task_id, { request_id: "cancel-1" })).duplicate, true);

  const accepted = await source.submitProjectTask({ ...task(), id: "http-recheck" });
  const job = (await hubClient(base, keys.worker).work({ claim: "http-recheck", wait: 0, running: [], capacity: true }))
    .job!;
  const stage = {
    execution_id: job.stage.execution_id,
    request_id: job.stage.execution_id,
    verdict: "verified",
    input_revision: "a".repeat(40),
    output_revision: "a".repeat(40),
    remote_ref: `refs/heads/autoloop/${accepted.task_id}`,
    artifacts: [{ path: "PLAN.md", revision: "a".repeat(40), sha256: "b".repeat(64) }],
    checks: [{ name: "plan", exit_code: 0, revision: "a".repeat(40) }],
    findings: [],
  };
  await hubClient(base, keys.worker).result(job.run, job.token, { outcome: "done", stage });
  const recheck = await owner.recheckProjectTask(accepted.task_id, { request_id: "recheck-1" });
  assert.equal(recheck.generation, 2);
  assert.equal((await owner.projectTask(accepted.task_id)).state, "queued");
});
