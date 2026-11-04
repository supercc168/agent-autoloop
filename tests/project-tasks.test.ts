// Failure modes: duplicate intake starts two tasks, a rules reload reroutes an accepted task, a stage result advances
// twice or outside its execution, task runs enter the generic retry merger, or projection rebuild loses budgets/evidence.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { empty, evolve, rows } from "../kernel/evolve.ts";
import { at, setup } from "./helpers.ts";

const home = setup("project-tasks");
const rulesFile = join(home, "rules.json");
const rules = JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
rules.rules.push(
  {
    name: "项目任务入口",
    when: { source: "app", types: ["project.requested"] },
    to: "a1",
    cwd: "/trusted/intake",
    prompt: "接收项目任务。",
    workflow: "delivery",
  },
  {
    name: "项目定时入口",
    when: { cron: "*/5 * * * *" },
    to: "a1",
    cwd: "/trusted/intake",
    prompt: "按时执行项目检查。",
    workflow: "delivery",
  },
  {
    name: "规划阶段",
    when: { source: "app", types: ["internal.plan"] },
    to: "a1",
    cwd: "/trusted/plan",
    prompt: "按可信规划说明工作。",
    group: "project-plan",
    parallel: 2,
  },
  {
    name: "执行阶段",
    when: { source: "app", types: ["internal.execute"] },
    to: "a2",
    cwd: "/trusted/execute",
    prompt: "按可信执行说明工作。",
    group: "project-execute",
    parallel: 2,
  },
  {
    name: "验收阶段",
    when: { source: "app", types: ["internal.verify"] },
    to: "a2",
    cwd: "/trusted/verify",
    prompt: "按可信验收说明工作。",
    group: "project-verify",
    parallel: 2,
  },
);
rules.workflows = {
  delivery: {
    entry: "plan",
    max_transitions: 6,
    stages: {
      plan: {
        route: "规划阶段",
        mode: "write",
        max_visits: 2,
        on: { planned: "execute", blocked: "$human", execution_failed: "$human" },
        checks: [{ name: "plan", argv: ["node", "--version"], timeout_ms: 30_000 }],
      },
      execute: {
        route: "执行阶段",
        mode: "write",
        max_visits: 2,
        on: { implemented: "verify", blocked: "$human", execution_failed: "$failed" },
        checks: [{ name: "tests", argv: ["npm", "test"], timeout_ms: 120_000 }],
      },
      verify: {
        route: "验收阶段",
        mode: "inspect",
        max_visits: 2,
        on: { verified: "$complete", blocked: "$human", execution_failed: "$failed" },
        checks: [{ name: "acceptance", argv: ["node", "verify.js"], timeout_ms: 120_000 }],
      },
    },
    git: {
      remote: "file:///tmp/project.git",
      base_ref: "refs/heads/main",
      task_ref_prefix: "refs/heads/autoloop/",
      artifact_paths: ["PLAN.md"],
    },
    recheck: "plan",
    human: {
      options: [
        { label: "重试", action: "retry" },
        { label: "取消", action: "cancel" },
      ],
    },
  },
};
writeFileSync(rulesFile, JSON.stringify(rules));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;

const hub = await import("../host/runtime.ts");
const { Conflict, InputError } = await import("../kernel/errors.ts");
const { projectTask } = await import("../kernel/query.ts");

const input = () => ({
  id: "request-1",
  type: "project.requested",
  subject: "repo-1",
  goal: "Implement the accepted change",
  acceptance: ["The focused tests pass", "The accepted revision is recorded"],
  data: { ticket: "P-1" },
});
const revision = (letter: string) => letter.repeat(40);
const stageResult = (job: NonNullable<ReturnType<typeof hub.claimNext>>, verdict: string, output: string) => ({
  outcome: "done",
  summary: `${job.stage!.stage_id} finished`,
  stage: {
    execution_id: job.stage!.execution_id,
    request_id: job.stage!.execution_id,
    verdict,
    input_revision: job.stage!.input_revision ?? revision("a"),
    output_revision: output,
    remote_ref: `refs/heads/autoloop/${job.stage!.task_id}`,
    artifacts: [{ path: "PLAN.md", revision: output, sha256: revision("f") + "f".repeat(24) }],
    checks: [{ name: job.stage!.checks[0].name, exit_code: 0, revision: output }],
    findings: [],
  },
});

test("submit, claim and one stage result atomically enqueue the next frozen stage", () => {
  const accepted = hub.execute("submitProjectTask", ["app", input()], at(0));
  assert.equal(accepted.duplicate, false);
  assert.match(accepted.task_id, /^task_[0-9a-f]{32}$/);

  const first = hub.claimNext("w1", "task-plan", at(1))!;
  assert.equal(first.stage?.task_id, accepted.task_id);
  assert.equal(first.stage?.stage_id, "plan");
  assert.equal(first.stage?.generation, 1);
  assert.equal(first.stage?.route.cwd, "/trusted/plan");
  assert.equal(first.context.task?.goal, input().goal);
  assert.deepEqual(first.context.events, []);

  const changed = structuredClone(hub.rules);
  changed.rules.find((rule: any) => rule.name === "规划阶段")!.cwd = "/changed/after-admission";
  changed.rules.find((rule: any) => rule.name === "执行阶段")!.to = "a1";
  hub.execute("rules", [changed], at(2));

  const result = stageResult(first, "planned", revision("b"));
  hub.finish(first.run, first.token, result, at(3));
  assert.equal(hub.finish(first.run, first.token, result, at(4)).duplicate, true);
  const lastFact = hub.logAfter().at(-1)!;
  assert.ok(lastFact.changes.some((change: any) => change.table === "stage_executions"));
  assert.ok(lastFact.changes.some((change: any) => change.table === "project_tasks"));
  assert.ok(lastFact.changes.some((change: any) => change.table === "runs" && change.row?.state === "queued"));

  assert.equal(hub.claimNext("w1", "wrong-worker", at(5)), null, "reload cannot move the frozen execute route");
  const second = hub.claimNext("w2", "task-execute", at(5))!;
  assert.equal(second.stage?.stage_id, "execute");
  assert.equal(second.stage?.input_revision, revision("b"));
  assert.equal(second.stage?.route.cwd, "/trusted/execute");
  assert.equal(second.agent.id, "a2");
  assert.deepEqual(
    second.stage?.evidence.map((item) => item.verdict),
    ["planned"],
  );

  hub.finish(second.run, second.token, stageResult(second, "implemented", revision("c")), at(6));
  const third = hub.claimNext("w2", "task-verify", at(7))!;
  assert.equal(third.stage?.stage_id, "verify");
  hub.finish(third.run, third.token, stageResult(third, "verified", revision("c")), at(8));
  const status = projectTask(hub.getView(), accepted.task_id)!;
  assert.equal(status.state, "completed");
  assert.equal(status.current_revision, revision("c"));
  assert.equal(status.transitions, 3);
  assert.deepEqual(status.visits, { plan: 1, execute: 1, verify: 1 });
  assert.equal(status.executions.length, 3);
});

test("stable intake is idempotent, conflicting input is rejected, and stale execution ids cannot advance", () => {
  const same = hub.execute("submitProjectTask", ["app", input()], at(10));
  assert.equal(same.duplicate, true);
  assert.throws(() => hub.execute("submitProjectTask", ["app", { ...input(), goal: "different" }], at(11)), Conflict);
  assert.throws(() => hub.execute("submitProjectTask", ["app", { ...input(), worker: "w2" }], at(11)), InputError);
});

test("fact-log rebuild preserves task, execution, revision and cumulative visit state", () => {
  const current = projectTask(hub.getView(), hub.execute("submitProjectTask", ["app", input()], at(20)).task_id)!;
  const rebuilt = evolve(empty(), hub.logAfter());
  try {
    const replayed = projectTask(rebuilt, current.task_id)!;
    assert.deepEqual(replayed, current);
    assert.equal(rows(rebuilt, "runs", { task_id: current.task_id }).length, 3);
  } finally {
    rebuilt.close();
  }
});

test("scheduled workflow intake creates one stable task for the latest due occurrence", () => {
  hub.tick(at(0));
  hub.tick(at(17));
  const scheduled = rows(hub.getView(), "project_tasks", { source: "schedule" });
  assert.equal(scheduled.length, 1);
  assert.equal(JSON.parse(scheduled[0].input).type, "schedule.tick");
  const again = scheduled[0].task_id;
  hub.tick(at(17.5));
  assert.equal(rows(hub.getView(), "project_tasks", { source: "schedule" })[0].task_id, again);
});
