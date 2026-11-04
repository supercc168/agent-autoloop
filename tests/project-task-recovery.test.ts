// Failure modes: queued cancellation leaves work claimable, active/unknown cancellation claims success before remote
// confirmation, a late terminal advances the workflow, attestation loses provenance, heartbeats hide uncertainty,
// cancellation or an explicit empty value replaces a fixed native session, or recheck resets budgets.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { at, setup } from "./helpers.ts";
import { empty, evolve } from "../kernel/evolve.ts";

const home = setup("project-task-recovery");
const file = join(home, "rules.json");
const rules = JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
rules.rules.push(
  {
    name: "项目入口",
    when: { source: "app", types: ["project.requested"] },
    to: "a1",
    cwd: "/trusted/intake",
    prompt: "接收任务。",
    workflow: "recovery",
  },
  {
    name: "验收阶段",
    when: { source: "app", types: ["internal.verify"] },
    to: "a1",
    cwd: "/trusted/verify",
    prompt: "验收。",
    group: "project-verify",
    parallel: 2,
  },
  ...["review", "rework"].map((name) => ({
    name,
    when: { source: "app", types: [`internal.${name}`] },
    to: "a1",
    cwd: `/trusted/${name}`,
    prompt: name,
    group: `project-${name}`,
    parallel: 2,
  })),
);
rules.workflows = {
  recovery: {
    entry: "verify",
    max_transitions: 8,
    stages: {
      verify: {
        route: "验收阶段",
        mode: "inspect",
        max_visits: 4,
        on: { verified: "$complete", changes_requested: "rework", blocked: "$human", execution_failed: "$human" },
        checks: [{ name: "acceptance", argv: ["node", "verify.js"], timeout_ms: 60_000 }],
      },
      review: {
        route: "review",
        mode: "inspect",
        max_visits: 4,
        on: { approved: "verify", changes_requested: "rework", blocked: "$human", execution_failed: "$human" },
        checks: [],
      },
      rework: {
        route: "rework",
        mode: "write",
        max_visits: 4,
        on: { implemented: "review", blocked: "$human", execution_failed: "$human" },
        checks: [],
      },
    },
    git: {
      remote: "file:///tmp/project.git",
      base_ref: "refs/heads/main",
      task_ref_prefix: "refs/heads/autoloop/",
      artifact_paths: ["PLAN.md"],
    },
    recheck: "verify",
    human: {
      options: [
        { label: "重试", action: "retry" },
        { label: "取消", action: "cancel" },
      ],
    },
  },
};
writeFileSync(file, JSON.stringify(rules));
process.env.AGENT_AUTOLOOP_RULES = file;

const hub = await import("../host/runtime.ts");
const { Conflict, InputError } = await import("../kernel/errors.ts");
const { projectTask } = await import("../kernel/query.ts");

beforeEach(() => {
  for (const table of [
    "run_events",
    "runs",
    "events",
    "project_tasks",
    "stage_executions",
    "cards",
    "deliveries",
    "seen",
  ]) {
    hub.fixtureClear(table as any);
  }
});

const revision = "a".repeat(40);
const submit = (id: string, now = at(0)) =>
  hub.execute(
    "submitProjectTask",
    ["app", { id, type: "project.requested", subject: id, goal: `Verify ${id}`, acceptance: ["Verified"] }],
    now,
  ).task_id as string;
const claim = (name: string, now: number) => hub.claimNext("w1", `${name}-${Math.random()}`, now)!;
function stage(job: any, verdict = "verified", extra: Record<string, unknown> = {}) {
  return {
    outcome: "done",
    summary: verdict,
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      verdict,
      input_revision: revision,
      output_revision: revision,
      remote_ref: `refs/heads/autoloop/${job.stage.task_id}`,
      artifacts: [{ path: "PLAN.md", revision, sha256: "b".repeat(64) }],
      checks: [{ name: "acceptance", exit_code: 0, revision }],
      findings: [],
      ...extra,
    },
  };
}

test("queued cancellation is terminal and active cancellation waits for confirmed remote stop", () => {
  const queued = submit("cancel-queued");
  assert.deepEqual(hub.execute("cancelProjectTask", [queued, { request_id: "cancel-q" }], at(1)), {
    task_id: queued,
    state: "cancelled",
    duplicate: false,
  });
  assert.equal(projectTask(hub.getView(), queued)!.state, "cancelled");
  assert.equal(hub.claimNext("w1", "cancelled-queued", at(2)), null);

  const active = submit("cancel-active", at(3));
  const job = claim("active", at(4));
  const pending = hub.execute("cancelProjectTask", [active, { request_id: "cancel-a" }], at(5));
  assert.equal(pending.state, "cancel_requested");
  assert.deepEqual(hub.cancels("w1"), [job.run]);
  assert.equal(projectTask(hub.getView(), active)!.state, "cancel_requested");
  hub.started(
    job.run,
    job.token,
    {
      session: "native-after-cancel",
      stage: {
        execution_id: job.stage!.execution_id,
        request_id: job.stage!.execution_id,
        input_revision: revision,
        remote_state: "completed",
      },
    },
    at(5.5),
  );
  assert.equal(
    projectTask(hub.getView(), active)!.state,
    "cancel_requested",
    "late progress cannot clear cancel intent",
  );
  hub.finish(job.run, job.token, { outcome: "cancelled", summary: "remote process stopped" }, at(6));
  assert.equal(projectTask(hub.getView(), active)!.state, "cancelled");
  assert.deepEqual(hub.cancels("w1"), []);
});

test("unknown keeps its execution and cancellation intent; late done is history, not advancement", () => {
  const taskId = submit("late-done", at(10));
  const job = claim("late", at(10));
  hub.heartbeat("w1", [job.run], at(11));
  hub.heartbeat("w1", [], at(17));
  hub.sweep(at(17));
  assert.equal(projectTask(hub.getView(), taskId)!.state, "unknown");

  hub.execute("cancelProjectTask", [taskId, { request_id: "cancel-late" }], at(18));
  assert.deepEqual(hub.cancels("w1"), [job.run], "unknown task runs still receive cancel");
  hub.heartbeat("w1", [job.run], at(19));
  assert.equal(projectTask(hub.getView(), taskId)!.state, "unknown");
  assert.deepEqual(hub.cancels("w1"), [job.run], "heartbeat recovery preserves cancel intent");

  const late = stage(job);
  hub.finish(job.run, job.token, late, at(20));
  assert.equal(hub.finish(job.run, job.token, late, at(21)).duplicate, true);
  assert.throws(() => hub.finish(job.run, job.token, { ...late, summary: "different" }, at(21)), Conflict);
  const status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "waiting_human");
  assert.equal(status.transitions, 0);
  assert.equal(status.executions.length, 1);
  assert.equal(status.late_outcomes[0].stage.verdict, "verified");
  assert.equal(hub.claimNext("w1", "no-next-after-late", at(22)), null);
  assert.ok(status.human_card, "the completion/cancel race is visible to the owner");
});

test("cancel intent survives a later unknown sweep, late receipt replay and fact reconstruction", () => {
  const taskId = submit("cancel-then-unknown", at(23));
  const job = claim("cancel-then-unknown", at(23));
  hub.execute("cancelProjectTask", [taskId, { request_id: "cancel-first" }], at(24));
  hub.heartbeat("w1", [], at(30));
  hub.sweep(at(30));
  assert.equal(projectTask(hub.getView(), taskId)!.state, "unknown");
  const late = stage(job);
  hub.finish(job.run, job.token, late, at(31));
  assert.equal(hub.finish(job.run, job.token, late, at(32)).duplicate, true);
  const status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "waiting_human");
  assert.equal(status.transitions, 0);
  assert.equal(status.late_outcomes.length, 1);
  assert.equal(status.executions.length, 1);
  const rebuilt = evolve(empty(), hub.logAfter());
  try {
    assert.deepEqual(projectTask(rebuilt, taskId), status);
  } finally {
    rebuilt.close();
  }
});

test("cancel then unknown accepts operator provenance without workflow advancement", () => {
  const taskId = submit("cancel-unknown-attested", at(32));
  const job = claim("cancel-unknown-attested", at(32));
  hub.execute("cancelProjectTask", [taskId, { request_id: "cancel-attested" }], at(33));
  hub.heartbeat("w1", [], at(39));
  hub.sweep(at(39));
  const resolution = {
    kind: "operator_attested",
    reason: "Native tree checked stopped",
    at: new Date(at(40)).toISOString(),
    binding_id: "binding-cancelled",
  };
  hub.finish(job.run, job.token, stage(job, "execution_failed", { resolution }), at(40));
  const status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "cancelled");
  assert.equal(status.transitions, 0);
  assert.equal(status.executions.length, 1);
  assert.equal(status.executions[0].state, "resolved");
  assert.deepEqual(status.resolution, resolution);
});

test("remote unknown survives heartbeats and only reliable stage progress clears it", () => {
  const taskId = submit("remote-unknown", at(41));
  const job = claim("remote-unknown", at(41));
  const progress = {
    execution_id: job.stage!.execution_id,
    request_id: job.stage!.execution_id,
    input_revision: revision,
    remote_state: "unknown",
  };
  hub.started(job.run, job.token, { session: "native-unknown", stage: progress }, at(42));
  hub.heartbeat("w1", [job.run], at(43));
  hub.started(job.run, job.token, { session: "native-unknown" }, at(44));
  assert.equal(projectTask(hub.getView(), taskId)!.state, "unknown");
  assert.equal(projectTask(hub.getView(), taskId)!.executions[0].state, "unknown");
  hub.started(job.run, job.token, { stage: { ...progress, remote_state: "running" } }, at(45));
  assert.equal(projectTask(hub.getView(), taskId)!.state, "running");
  hub.execute("cancelProjectTask", [taskId, { request_id: "stop" }], at(46));
  hub.started(job.run, job.token, { stage: progress }, at(47));
  hub.heartbeat("w1", [job.run], at(48));
  assert.equal(projectTask(hub.getView(), taskId)!.state, "unknown");
  assert.ok(hub.cancels("w1").includes(job.run));
  assert.throws(() => hub.finish(job.run, job.token, { outcome: "cancelled", session: "other" }, at(49)), Conflict);
  assert.throws(() => hub.finish(job.run, job.token, { outcome: "cancelled", session: "" }, at(49)), Conflict);
  assert.throws(() => hub.finish(job.run, job.token, { outcome: "cancelled", session: null }, at(49)), InputError);
  assert.equal(projectTask(hub.getView(), taskId)!.runs[0].session, "native-unknown");
  const result = { outcome: "cancelled", session: "native-unknown" };
  hub.finish(job.run, job.token, result, at(50));
  assert.equal(hub.finish(job.run, job.token, result, at(51)).duplicate, true);
  assert.equal(projectTask(hub.getView(), taskId)!.state, "cancelled");
});

test("operator attestation releases an unknown execution with visible provenance and no silent retry", () => {
  const taskId = submit("operator-attested", at(30));
  const job = claim("attested", at(30));
  hub.heartbeat("w1", [job.run], at(31));
  hub.heartbeat("w1", [], at(37));
  hub.sweep(at(37));
  const resolution = {
    kind: "operator_attested",
    reason: "Operator verified the native process is stopped",
    at: new Date(at(38)).toISOString(),
    binding_id: "binding-original",
  };
  hub.finish(job.run, job.token, stage(job, "execution_failed", { resolution }), at(38));
  const status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "waiting_human");
  assert.deepEqual(status.executions[0].result.resolution, resolution);
  assert.equal(hub.claimNext("w1", "no-automatic-retry", at(39)), null);
  const card = hub.getView().get("cards", status.human_card)!;
  assert.match(card.text, /operator_attested|人工核实/);
});

test("terminal task result cannot replace the native session fixed by started", () => {
  const taskId = submit("session-immutable", at(39));
  const job = claim("session-immutable", at(39));
  hub.started(
    job.run,
    job.token,
    {
      session: "native-A",
      stage: {
        execution_id: job.stage!.execution_id,
        request_id: job.stage!.execution_id,
        input_revision: revision,
        remote_state: "running",
      },
    },
    at(39),
  );
  const failed = stage(job, "execution_failed");
  assert.throws(() => hub.finish(job.run, job.token, { ...failed, session: "native-B" }, at(39.1)), Conflict);
  assert.throws(() => hub.finish(job.run, job.token, { ...failed, session: "" }, at(39.1)), Conflict);
  assert.throws(() => hub.finish(job.run, job.token, { ...failed, session: null }, at(39.1)), InputError);
  let status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "running");
  assert.equal(status.runs[0].session, "native-A");
  assert.equal(status.executions[0].result, null);

  hub.finish(job.run, job.token, { ...failed, session: "native-A" }, at(39.2));
  status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "waiting_human");
  hub.answer(status.human_card, { choice: 0, by: "owner" }, at(39.3));
  const retry = claim("session-retry", at(39.4));
  assert.equal(retry.stage!.task_id, taskId);
  assert.equal(retry.session, "native-A");
});

for (const outcome of ["done", "cancelled"]) {
  test(`omitted and undefined task sessions preserve the fixed id through ${outcome} and replay`, () => {
    const taskId = submit(`optional-session-${outcome}`, at(39));
    const job = claim(`optional-session-${outcome}`, at(39));
    hub.started(job.run, job.token, { session: "native-fixed" }, at(39));
    for (const input of [{}, { session: undefined }, { session: "native-fixed" }]) {
      hub.started(job.run, job.token, input, at(39.1));
      assert.equal(projectTask(hub.getView(), taskId)!.runs[0].session, "native-fixed");
    }
    assert.throws(() => hub.started(job.run, job.token, { session: null }, at(39.1)), InputError);
    assert.throws(() => hub.started(job.run, job.token, { session: "" }, at(39.1)), Conflict);
    if (outcome === "cancelled") hub.execute("cancelProjectTask", [taskId, { request_id: "stop" }], at(39.2));
    const result = outcome === "done" ? stage(job) : { outcome: "cancelled" };
    hub.finish(job.run, job.token, { ...result, session: undefined }, at(39.3));
    assert.equal(hub.finish(job.run, job.token, result, at(39.4)).duplicate, true);
    assert.equal(projectTask(hub.getView(), taskId)!.runs[0].session, "native-fixed");
  });
}

test("an accepted empty task session is fixed by presence, while ordinary runs retain legacy empty-session behavior", () => {
  const taskId = submit("empty-initial-session", at(39));
  const job = claim("empty-initial-session", at(39));
  assert.equal(projectTask(hub.getView(), taskId)!.runs[0].session, null);
  hub.started(job.run, job.token, { session: undefined }, at(39.1));
  assert.equal(projectTask(hub.getView(), taskId)!.runs[0].session, null);
  assert.throws(() => hub.started(job.run, job.token, { session: null }, at(39.1)), InputError);
  hub.started(job.run, job.token, { session: "" }, at(39.2));
  hub.started(job.run, job.token, { session: "" }, at(39.3));
  assert.throws(() => hub.started(job.run, job.token, { session: "replacement" }, at(39.4)), Conflict);
  const result = { outcome: "cancelled", session: "" };
  hub.finish(job.run, job.token, result, at(39.5));
  assert.equal(hub.finish(job.run, job.token, result, at(39.6)).duplicate, true);
  assert.equal(projectTask(hub.getView(), taskId)!.runs[0].session, "");

  hub.ingest("app", { id: "ordinary-empty-session", type: "feedback.new", subject: "ordinary-empty" }, at(40));
  const ordinary = claim("ordinary-empty-session", at(41));
  assert.equal(ordinary.stage, undefined);
  hub.started(ordinary.run, ordinary.token, { session: "ordinary-native" }, at(42));
  hub.started(ordinary.run, ordinary.token, { session: "" }, at(43));
  hub.started(ordinary.run, ordinary.token, { session: "ordinary-replacement" }, at(44));
  assert.throws(() => hub.started(ordinary.run, ordinary.token, { session: null }, at(44)), InputError);
  const ordinaryResult = { outcome: "done", session: "" };
  hub.finish(ordinary.run, ordinary.token, ordinaryResult, at(45));
  assert.equal(hub.finish(ordinary.run, ordinary.token, ordinaryResult, at(46)).duplicate, true);
  assert.equal(hub.getView().get("runs", ordinary.run)!.session, "");
});

test("recheck keeps history and cumulative budgets, deduplicates requests, and cannot overlap", () => {
  const taskId = submit("recheck", at(40));
  let job = claim("verify-1", at(41));
  hub.finish(job.run, job.token, stage(job), at(42));
  assert.equal(projectTask(hub.getView(), taskId)!.state, "completed");
  const original = projectTask(hub.getView(), taskId)!.executions[0];

  const first = hub.execute("recheckProjectTask", [taskId, { request_id: "recheck-1" }], at(43));
  assert.deepEqual(first, { task_id: taskId, generation: 2, state: "queued", duplicate: false });
  assert.equal(hub.execute("recheckProjectTask", [taskId, { request_id: "recheck-1" }], at(44)).duplicate, true);
  assert.throws(
    () => hub.execute("cancelProjectTask", [taskId, { request_id: "recheck-1" }], at(44)),
    Conflict,
    "one owner request id cannot mean two mutations",
  );
  assert.throws(
    () => hub.execute("recheckProjectTask", [taskId, { request_id: "recheck-2" }], at(44)),
    Conflict,
    "active recheck cannot overlap",
  );
  job = claim("verify-2", at(45));
  assert.equal(job.stage!.generation, 2);
  assert.equal(job.stage!.input_resolution, "task_ref");
  assert.equal(job.stage!.input_revision, null);
  const updated = "b".repeat(40);
  const progress = {
    execution_id: job.stage!.execution_id,
    request_id: job.stage!.execution_id,
    input_revision: updated,
    remote_state: "running",
  };
  hub.started(job.run, job.token, { stage: progress }, at(45));
  hub.started(job.run, job.token, { stage: progress }, at(45));
  assert.throws(
    () => hub.started(job.run, job.token, { stage: { ...progress, input_revision: revision } }, at(45)),
    Conflict,
  );
  assert.equal(projectTask(hub.getView(), taskId)!.current_revision, updated);
  assert.equal(projectTask(hub.getView(), taskId)!.executions[1].input_resolution, "task_ref");
  hub.finish(job.run, job.token, measured(job, "verified", updated), at(46));
  const status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "completed");
  assert.equal(status.generation, 2);
  assert.equal(status.visits.verify, 2);
  assert.equal(status.transitions, 3);
  assert.deepEqual(status.executions[0], original, "recheck never edits an accepted older generation");
  assert.deepEqual(
    status.executions.map((item: any) => item.generation),
    [1, 2],
  );
  const rebuilt = evolve(empty(), hub.logAfter());
  try {
    assert.deepEqual(projectTask(rebuilt, taskId), status);
  } finally {
    rebuilt.close();
  }
});

function measured(job: any, verdict: string, input?: string, output = input, remoteRef?: string) {
  return {
    outcome: "done",
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      verdict,
      ...(input ? { input_revision: input } : {}),
      ...(output ? { output_revision: output } : {}),
      ...(remoteRef ? { remote_ref: remoteRef } : {}),
      artifacts: [],
      checks: input ? job.stage.checks.map((check: any) => ({ name: check.name, exit_code: 0, revision: output })) : [],
      findings: [],
    },
  };
}

function pin(job: any, input: string) {
  hub.started(
    job.run,
    job.token,
    {
      stage: {
        execution_id: job.stage.execution_id,
        request_id: job.stage.execution_id,
        input_revision: input,
        remote_state: "running",
      },
    },
    at(73),
  );
}

function completedRecheck(id: string) {
  const taskId = submit(id, at(70));
  const initial = claim(`${id}-initial`, at(71));
  hub.finish(initial.run, initial.token, stage(initial), at(72));
  const original = projectTask(hub.getView(), taskId)!.executions[0];
  hub.execute("recheckProjectTask", [taskId, { request_id: `${id}-recheck` }], at(73));
  return { taskId, original, job: claim(`${id}-recheck`, at(74)) };
}

test("unpinned recheck requires started for versioned results and keeps deterministic pre-admission failures human", (t) => {
  const before = structuredClone(hub.rules);
  const configured = structuredClone(before);
  configured.workflows.recovery.stages.verify.on.execution_failed = "$complete";
  hub.execute("rules", [configured], at(69));
  t.after(() => hub.execute("rules", [before], at(84)));
  const { taskId, original, job } = completedRecheck("pre-pin-failure");
  assert.equal(job.stage!.input_revision, null);
  assert.equal(job.stage!.input_resolution, "task_ref");
  const failed = measured(job, "execution_failed");
  for (const result of [
    measured(job, "verified", "b".repeat(40)),
    measured(job, "execution_failed", "b".repeat(40)),
    { ...failed, stage: { ...failed.stage, remote_ref: "refs/heads/unverified" } },
    { ...failed, stage: { ...failed.stage, checks: [{ name: "acceptance", exit_code: 0, revision }] } },
    { ...failed, stage: { ...failed.stage, artifacts: [{ path: "PLAN.md", revision, sha256: "a".repeat(64) }] } },
  ])
    assert.throws(() => hub.finish(job.run, job.token, result, at(75)), Conflict);
  hub.finish(job.run, job.token, failed, at(76));
  assert.equal(hub.finish(job.run, job.token, failed, at(77)).duplicate, true);
  let status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "waiting_human");
  assert.equal(status.current_revision, revision);
  assert.equal(status.transitions, 3);
  assert.equal(status.executions[1].input_revision, null);
  assert.equal(status.executions[1].output_revision, null);
  assert.equal(status.executions[1].input_resolution, "task_ref");
  assert.deepEqual(status.executions[0], original);
  hub.answer(status.human_card, { choice: 0, by: "owner" }, at(78));
  const retry = claim("pre-pin-retry", at(79));
  assert.equal(retry.stage!.input_revision, null);
  assert.equal(retry.stage!.input_resolution, "task_ref");
  hub.started(
    retry.run,
    retry.token,
    {
      stage: {
        execution_id: retry.stage!.execution_id,
        request_id: retry.stage!.execution_id,
        remote_state: "unknown",
      },
    },
    at(80),
  );
  assert.throws(() => hub.finish(retry.run, retry.token, measured(retry, "execution_failed"), at(81)), Conflict);
  status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "unknown");
  assert.equal(status.transitions, 4);
  hub.execute("cancelProjectTask", [taskId, { request_id: "cancel-unpinned" }], at(82));
  hub.finish(retry.run, retry.token, { outcome: "cancelled" }, at(83));
  assert.equal(projectTask(hub.getView(), taskId)!.state, "cancelled");
  assert.equal(projectTask(hub.getView(), taskId)!.current_revision, revision);
});

test("a pinned failure without remote ref preserves its source through human retry and verify", () => {
  const before = structuredClone(hub.rules);
  const configured = structuredClone(before);
  configured.workflows.recovery.recheck = "review";
  hub.execute("rules", [configured], at(70));
  try {
    const { taskId, original, job } = completedRecheck("pinned-failure");
    const updated = "c".repeat(40);
    pin(job, updated);
    const failed = measured(job, "execution_failed", updated);
    delete (failed.stage as any).output_revision;
    hub.finish(job.run, job.token, failed, at(75));
    const card = projectTask(hub.getView(), taskId)!.human_card;
    hub.answer(card, { text: "keep this pin", by: "owner" }, at(76));
    hub.answer(card, { choice: 0, by: "owner" }, at(77));
    assert.equal(hub.answer(card, { choice: 0, by: "owner" }, at(78)).changed, false);
    const retry = claim("pinned-review-retry", at(79));
    assert.equal(retry.stage!.input_revision, updated);
    assert.equal(retry.stage!.input_resolution, "task_ref");
    assert.equal(retry.context.task_decisions!.at(-1)!.generation, 2);
    assert.equal(retry.context.task_decisions!.at(-1)!.revision, updated);
    assert.ok(retry.context.stage_evidence!.some((item) => item.generation === 1));
    assert.throws(() => pin(retry, "d".repeat(40)), Conflict);
    hub.finish(retry.run, retry.token, measured(retry, "approved", updated), at(80));
    const verify = claim("pinned-verify", at(81));
    assert.equal(verify.stage!.input_revision, updated);
    assert.equal(verify.stage!.input_resolution, "task_ref");
    hub.finish(verify.run, verify.token, measured(verify, "verified", updated), at(82));
    const status = projectTask(hub.getView(), taskId)!;
    assert.equal(status.state, "completed");
    assert.equal(status.current_revision, updated);
    assert.deepEqual(status.executions[0], original);
    const rebuilt = evolve(empty(), hub.logAfter());
    try {
      assert.deepEqual(projectTask(rebuilt, taskId), status);
    } finally {
      rebuilt.close();
    }
  } finally {
    hub.execute("rules", [before], at(83));
  }
});

test("review or verify changes_requested carries task-ref provenance into write until an accepted output", () => {
  const before = structuredClone(hub.rules);
  try {
    for (const recheck of ["review", "verify"]) {
      const configured = structuredClone(before);
      configured.workflows.recovery.recheck = recheck;
      hub.execute("rules", [configured], at(70));
      const { taskId, job } = completedRecheck(`write-source-${recheck}`);
      const updated = "d".repeat(40);
      pin(job, updated);
      hub.finish(job.run, job.token, measured(job, "changes_requested", updated), at(75));
      const write = claim(`write-${recheck}`, at(76));
      assert.equal(write.stage!.stage_id, "rework");
      assert.equal(write.stage!.input_revision, updated);
      assert.equal(write.stage!.input_resolution, "task_ref");
      const output = "e".repeat(40);
      hub.finish(
        write.run,
        write.token,
        measured(write, "blocked", updated, output, `refs/immutable/${recheck}`),
        at(77),
      );
      const status = projectTask(hub.getView(), taskId)!;
      assert.equal(status.current_revision, output);
      assert.equal(status.executions.at(-1)!.input_resolution, null);
      hub.answer(status.human_card, { choice: 0, by: "owner" }, at(78));
      const retry = claim(`write-output-${recheck}`, at(79));
      assert.equal(retry.stage!.input_revision, output);
      assert.equal(retry.stage!.input_resolution, undefined);
      hub.finish(
        retry.run,
        retry.token,
        measured(retry, "implemented", output, output, `refs/immutable/retry-${recheck}`),
        at(80),
      );
      const review = claim(`new-output-review-${recheck}`, at(81));
      assert.equal(review.stage!.input_revision, output);
      assert.equal(review.stage!.input_resolution, undefined);
      hub.finish(review.run, review.token, measured(review, "blocked", output), at(82));
    }
  } finally {
    hub.execute("rules", [before], at(83));
  }
});

test("recheck reserves the final result transition, and repeated mutation does not spend it again", () => {
  const before = structuredClone(hub.rules);
  try {
    for (const max of [1, 2, 3]) {
      const configured = structuredClone(before);
      configured.workflows.recovery.max_transitions = max;
      hub.execute("rules", [configured], at(90));
      const id = submit(`recheck-budget-${max}`, at(91));
      let job = claim(`budget-first-${max}`, at(92));
      hub.finish(job.run, job.token, stage(job), at(93));
      const request = { request_id: "budget-recheck" };
      const result = hub.execute("recheckProjectTask", [id, request], at(94));
      assert.equal(hub.execute("recheckProjectTask", [id, request], at(95)).duplicate, true);
      if (max < 3) {
        assert.equal(result.state, "waiting_human");
        assert.equal(projectTask(hub.getView(), id)!.generation, 1);
        assert.equal(projectTask(hub.getView(), id)!.transitions, 1);
        assert.equal(projectTask(hub.getView(), id)!.executions.length, 1);
      } else {
        assert.equal(result.state, "queued");
        job = claim("last-recheck", at(96));
        pin(job, "f".repeat(40));
        hub.finish(job.run, job.token, measured(job, "verified", "f".repeat(40)), at(97));
        assert.equal(projectTask(hub.getView(), id)!.state, "completed");
        assert.equal(projectTask(hub.getView(), id)!.transitions, 3);
      }
    }
  } finally {
    hub.execute("rules", [before], at(98));
  }
});
