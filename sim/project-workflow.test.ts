// Failure modes: task retries exceed trusted visits/transitions, duplicate result delivery creates another execution,
// cancel/late-result interleavings complete falsely, recheck skips its first input pin or rewrites prior history,
// or a completed projection lacks exact verified check evidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Conflict } from "../kernel/errors.ts";
import { rows } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { World, rules as baseRules } from "./world.ts";

const revision = "a".repeat(40);

function workflowRules() {
  const value: any = structuredClone(baseRules);
  delete value.sources.schedule;
  value.rules.push(
    {
      name: "task-intake",
      when: { source: "app", types: ["project.requested"] },
      to: "a",
      cwd: "/tmp",
      prompt: "trusted intake",
      group: "task-intake",
      tell: "needed",
      workflow: "bounded",
    },
    {
      name: "task-verify",
      when: { source: "app", types: ["internal.verify"] },
      to: "a",
      cwd: "/tmp",
      prompt: "trusted verify",
      group: "task-verify",
      tell: "needed",
    },
  );
  value.workflows = {
    bounded: {
      entry: "verify",
      max_transitions: 4,
      stages: {
        verify: {
          route: "task-verify",
          mode: "inspect",
          max_visits: 2,
          on: { verified: "$complete", blocked: "$human", execution_failed: "$human" },
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
      human: {
        options: [
          { label: "retry", action: "retry" },
          { label: "cancel", action: "cancel" },
        ],
      },
    },
  };
  return parseRules(JSON.stringify(value), 0, "UTC");
}

function world() {
  const w = new World();
  w.call("rules", workflowRules());
  return w;
}

function submit(w: World, id: string) {
  return w.call("submitProjectTask", "app", {
    id,
    type: "project.requested",
    subject: id,
    goal: `verify ${id}`,
    acceptance: ["proof passes"],
  });
}

function result(job: any, verdict: "verified" | "blocked" | "execution_failed" = "verified") {
  return {
    outcome: "done",
    summary: verdict,
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      verdict,
      input_revision: revision,
      output_revision: revision,
      remote_ref: `refs/heads/tasks/${job.stage.task_id}`,
      artifacts: [],
      checks: [{ name: "proof", exit_code: 0, revision }],
      findings: [],
    },
  };
}

test("submit/claim/result replay produces one verified execution and one immutable completion", () => {
  const w = world();
  const accepted = submit(w, "replay");
  assert.equal(submit(w, "replay").duplicate, true);
  const first = w.call("claimNext", "w1", "claim");
  const job = w.call("claimNext", "w1", "claim");
  assert.equal(job.run, first.run);
  const receipt = result(job);
  w.call("finish", job.run, job.token, receipt);
  assert.equal(w.call("finish", job.run, job.token, receipt).duplicate, true);
  const task = w.view.get("project_tasks", accepted.task_id)!;
  assert.equal(task.state, "completed");
  assert.equal(rows(w.view, "stage_executions", { task_id: accepted.task_id }).length, 1);
  assert.equal(rows(w.view, "runs", { task_id: accepted.task_id }).length, 1);
});

test("human retry and recheck share cumulative caps; text and duplicate answers never select work", () => {
  const w = world();
  const accepted = submit(w, "bounded");
  let job = w.call("claimNext", "w1", "first");
  w.call("finish", job.run, job.token, result(job, "blocked"));
  let task = w.view.get("project_tasks", accepted.task_id)!;
  assert.equal(task.state, "waiting_human");
  const firstCard = task.human_card;
  assert.deepEqual(w.call("answer", firstCard, { text: "explain first" }), { changed: true, state: "open" });
  assert.equal(w.call("claimNext", "w1", "no-text-route"), null);
  assert.equal(w.call("answer", firstCard, { choice: 0 }).changed, true);
  assert.equal(w.call("answer", firstCard, { choice: 0 }).changed, false);

  job = w.call("claimNext", "w1", "second");
  w.call("finish", job.run, job.token, result(job, "blocked"));
  task = w.view.get("project_tasks", accepted.task_id)!;
  assert.equal(JSON.parse(task.visits).verify, 2);
  assert.throws(() => w.call("answer", task.human_card, { choice: 0 }), Conflict);
  assert.equal(rows(w.view, "runs", { task_id: accepted.task_id }).length, 2);
});

test("cancel-before-claim and completion racing cancellation never create a next execution", () => {
  const before = world();
  const queued = submit(before, "cancel-before");
  before.call("cancelProjectTask", queued.task_id, { request_id: "cancel-before" });
  assert.equal(before.view.get("project_tasks", queued.task_id)!.state, "cancelled");
  assert.equal(before.call("claimNext", "w1", "none"), null);

  const late = world();
  const accepted = submit(late, "late");
  const job = late.call("claimNext", "w1", "late-claim");
  late.call("cancelProjectTask", accepted.task_id, { request_id: "cancel-active" });
  late.call("finish", job.run, job.token, result(job));
  const task = late.view.get("project_tasks", accepted.task_id)!;
  assert.equal(task.state, "waiting_human");
  assert.equal(task.transitions, 0);
  assert.equal(JSON.parse(task.late_outcomes).length, 1);
  assert.equal(rows(late.view, "runs", { task_id: accepted.task_id }).length, 1);
  assert.equal(late.call("claimNext", "w1", "no-late-replay"), null);
});

test("bounded recheck generations retain history and cannot overlap", () => {
  const w = world();
  const accepted = submit(w, "recheck");
  let job = w.call("claimNext", "w1", "verify-one");
  w.call("finish", job.run, job.token, result(job));
  const original = structuredClone(w.view.get("stage_executions", job.stage.execution_id)!);
  const mutation = { request_id: "recheck-1" };
  assert.equal(w.call("recheckProjectTask", accepted.task_id, mutation).generation, 2);
  assert.equal(w.call("recheckProjectTask", accepted.task_id, mutation).duplicate, true);
  assert.throws(() => w.call("recheckProjectTask", accepted.task_id, { request_id: "overlap" }), Conflict);
  job = w.call("claimNext", "w1", "verify-two");
  assert.equal(job.stage.input_resolution, "task_ref");
  assert.equal(job.stage.input_revision, null);
  w.call("started", job.run, job.token, {
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      input_revision: revision,
      remote_state: "running",
    },
  });
  assert.equal(w.view.get("stage_executions", job.stage.execution_id)!.input_revision, revision);
  w.call("finish", job.run, job.token, result(job));
  const task = w.view.get("project_tasks", accepted.task_id)!;
  assert.equal(task.state, "completed");
  assert.equal(task.generation, 2);
  assert.equal(task.transitions, 3);
  assert.equal(JSON.parse(task.visits).verify, 2);
  assert.deepEqual(w.view.get("stage_executions", original.execution_id), original);
});

test("an automatic transition is not enqueued when no transition budget remains", () => {
  const limited: any = structuredClone(workflowRules());
  limited.rules.push({
    name: "task-plan",
    when: { source: "app", types: ["internal.plan"] },
    to: "a",
    cwd: "/tmp",
    prompt: "trusted plan",
    group: "task-plan",
    tell: "needed",
  });
  limited.workflows.bounded.entry = "plan";
  limited.workflows.bounded.max_transitions = 1;
  limited.workflows.bounded.stages.plan = {
    route: "task-plan",
    mode: "write",
    max_visits: 1,
    on: { planned: "verify", blocked: "$human", execution_failed: "$human" },
    checks: [],
  };
  const w = new World();
  w.call("rules", limited);
  const accepted = submit(w, "transition-cap");
  const job = w.call("claimNext", "w1", "plan");
  w.call("finish", job.run, job.token, {
    outcome: "done",
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      verdict: "planned",
      input_revision: revision,
      output_revision: revision,
      artifacts: [],
      checks: [],
      findings: [],
    },
  });
  const task = w.view.get("project_tasks", accepted.task_id)!;
  assert.equal(task.state, "waiting_human");
  assert.equal(rows(w.view, "runs", { task_id: accepted.task_id }).length, 1);
});
