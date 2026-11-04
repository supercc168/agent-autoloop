// Failure modes: faults lose accepted events, duplicate execution or answers, exceed parallel limits, change receipts,
// diverge from replay, or strand work after recovery; an enumerator silently skips one ordering; mutation checks do not run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate } from "../sim/random.ts";
import { enumerate } from "../sim/enumerate.ts";
import { World } from "../sim/world.ts";
import { AuthError } from "../kernel/errors.ts";
import { empty, evolve, type Fact } from "../kernel/evolve.ts";
import { invariants } from "../sim/invariants.ts";

test("200000 deterministic fault steps preserve safety and recovered work terminates", () => {
  const result = simulate(0x5eed, 200000);
  assert.equal(result.steps, 200000);
  for (const fault of ["lost", "duplicate", "restart", "offline", "channel", "clock"])
    assert.ok(result.faults[fault] > 0, fault);
  assert.ok(result.completed > 0);
  console.log(JSON.stringify(result));
});

test("bounded exhaustive schedules use two workers, two events and one card", () => {
  const result = enumerate();
  assert.equal(result.paths, 40320);
  assert.equal(result.actions, 8);
  assert.ok(result.transitions >= 40320 * 8);
  console.log(JSON.stringify(result));
});

test("the simulator rejects a hub that refuses valid receipt replays", () => {
  const original = World.prototype.call;
  World.prototype.call = function (type: string, ...args: any[]) {
    const run = this.view.get("runs", args[0])!;
    if (type === "finish" && run?.last_issued && run.issued === null) throw new AuthError("故意拒绝有效重放");
    return original.call(this, type, ...args);
  };
  try {
    assert.throws(() => simulate(24301, 2048), /种子/);
  } finally {
    World.prototype.call = original;
  }
});

test("answer checks reject a run in the wrong subject lane", () => {
  const w = new World();
  w.call("createCard", {
    key: "q",
    kind: "ask",
    title: "选",
    options: ["甲", "乙"],
    rule: "one",
    lane: "#1",
    grp: "shared",
    source: "app",
  });
  w.call("answer", 1, { choice: 0 });
  const log = structuredClone(w.log);
  for (const f of log) for (const c of f.changes) if (c.table === "runs" && c.row) c.row.lane = "wrong-lane";
  assert.throws(() => invariants(evolve(new World().view, log.slice(1)), log), /原事项/);
});

test("the simulation catches omitted deadlines that strand deferred work", () => {
  const original = World.prototype.act;
  World.prototype.act = function (input) {
    const value = original.call(this, input);
    this.log = this.log.map((f) => ({ ...f, changes: f.changes.filter((c) => c.table !== "due") }));
    this.view.close();
    this.view = evolve(empty(), this.log);
    return value;
  };
  try {
    assert.throws(() => simulate(24301, 2048));
  } finally {
    World.prototype.act = original;
  }
});

test("project workflow invariants reject duplicate active stages and completion without verified evidence", () => {
  const workflow = {
    entry: "verify",
    max_transitions: 2,
    stages: {
      verify: {
        route: "one",
        mode: "inspect",
        max_visits: 2,
        on: { verified: "$complete", blocked: "$human", execution_failed: "$human" },
        checks: [{ name: "proof", argv: ["node", "--version"], timeout_ms: 1000 }],
      },
    },
    git: {
      remote: "file:///tmp/x.git",
      base_ref: "refs/heads/main",
      task_ref_prefix: "refs/heads/tasks/",
      artifact_paths: [],
    },
    human: { options: [] },
  };
  const duplicate = new World();
  const duplicateFact: Fact = {
    version: 1,
    seq: duplicate.view.seq + 1,
    at: 1,
    type: "forged-task",
    changes: [
      {
        table: "project_tasks",
        key: "task-forged",
        row: {
          task_id: "task-forged",
          state: "queued",
          workflow: JSON.stringify(workflow),
          visits: JSON.stringify({ verify: 2 }),
          transitions: 0,
          execution_count: 2,
          current_execution: "exec-1",
        },
      },
      ...[1, 2].flatMap((id) => [
        {
          table: "stage_executions" as const,
          key: `exec-${id}`,
          row: {
            execution_id: `exec-${id}`,
            task_id: "task-forged",
            run_id: id,
            stage_id: "verify",
            state: "queued",
          },
        },
        {
          table: "runs" as const,
          key: String(id),
          row: {
            id,
            task_id: "task-forged",
            execution_id: `exec-${id}`,
            state: "queued",
            grp: "task",
            lane: `lane-${id}`,
          },
        },
      ]),
    ],
  };
  const duplicateView = evolve(duplicate.view, [duplicateFact]);
  assert.throws(() => invariants(duplicateView, [...duplicate.log, duplicateFact]), /多个活动执行/);

  const unverified = new World();
  const unverifiedFact: Fact = {
    version: 1,
    seq: unverified.view.seq + 1,
    at: 1,
    type: "forged-completion",
    changes: [
      {
        table: "project_tasks",
        key: "task-complete",
        row: {
          task_id: "task-complete",
          state: "completed",
          workflow: JSON.stringify(workflow),
          visits: JSON.stringify({ verify: 1 }),
          transitions: 1,
          execution_count: 1,
          current_execution: "exec-complete",
          current_revision: "a".repeat(40),
        },
      },
      {
        table: "stage_executions",
        key: "exec-complete",
        row: {
          execution_id: "exec-complete",
          task_id: "task-complete",
          run_id: 1,
          stage_id: "verify",
          state: "finished",
          result: JSON.stringify({ verdict: "blocked", checks: [] }),
        },
      },
      {
        table: "runs",
        key: "1",
        row: {
          id: 1,
          task_id: "task-complete",
          execution_id: "exec-complete",
          state: "done",
          grp: "task",
          lane: "task-complete",
        },
      },
    ],
  };
  const unverifiedView = evolve(unverified.view, [unverifiedFact]);
  assert.throws(() => invariants(unverifiedView, [...unverified.log, unverifiedFact]), /没有 verified/);
});
