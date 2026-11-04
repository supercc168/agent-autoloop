// Failure modes: untrusted task text selects executable routing, workflow loops have no finite bound, a workflow names
// a missing route, or adding workflows changes the legacy event/run contract before any project task is admitted.
import assert from "node:assert/strict";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup, at } from "./helpers.ts";

const home = setup("project-task-contract");

const { claimNext, execute, getView, ingest, parseRules, reloadRules } = await import("../host/runtime.ts");
const { configuration } = await import("../kernel/query.ts");
const { canonicalProjectTask, parseProjectTaskInput, parseStageResult } = await import("../protocol/project-tasks.ts");

const fixture = () => JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));

function configured() {
  const value = fixture();
  value.rules.push(
    {
      name: "项目任务入口",
      when: { source: "app", types: ["project.requested"] },
      to: "a2",
      cwd: "/tmp/project",
      prompt: "接收项目任务。",
      workflow: "delivery",
    },
    {
      name: "规划阶段",
      when: { source: "app", types: ["internal.plan"] },
      to: "a2",
      cwd: "/tmp/project",
      prompt: "按可信规划说明工作。",
    },
    {
      name: "执行阶段",
      when: { source: "app", types: ["internal.execute"] },
      to: "a2",
      cwd: "/tmp/project",
      prompt: "按可信执行说明工作。",
    },
  );
  value.workflows = {
    delivery: {
      entry: "plan",
      max_transitions: 8,
      stages: {
        plan: {
          route: "规划阶段",
          mode: "inspect",
          max_visits: 2,
          on: { planned: "execute", blocked: "$human", execution_failed: "$human" },
          checks: [{ name: "plan", argv: ["node", "--version"], timeout_ms: 30_000 }],
        },
        execute: {
          route: "执行阶段",
          mode: "write",
          max_visits: 3,
          on: { implemented: "$complete", blocked: "$human", execution_failed: "$failed" },
          checks: [],
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
          { label: "重试当前阶段", action: "retry" },
          { label: "重新规划", action: "resume", stage: "plan" },
          { label: "结束任务", action: "fail" },
          { label: "取消任务", action: "cancel" },
        ],
      },
    },
  };
  return value;
}

test("bounded workflow configuration loads without changing an ordinary claimed job", () => {
  const parsed = parseRules(JSON.stringify(configured()), at(0));
  assert.equal(parsed.workflows.delivery.entry, "plan");
  assert.equal(parsed.workflows.delivery.stages.execute.max_visits, 3);
  execute("rules", [parsed], at(0));

  ingest(
    "app",
    { id: "legacy", type: "feedback.new", subject: "item-1", summary: "old path", detail: "", link: "" },
    at(1),
  );
  const job = claimNext("w1", "ordinary-claim", at(2));
  assert.equal(job?.rule.name, "意见");
  assert.equal(job?.stage, undefined);
});

test("task input is strict, bounded and canonical without executable routing fields", () => {
  const a = parseProjectTaskInput({
    id: "request-1",
    type: "project.requested",
    subject: "repo-1",
    goal: "Implement the accepted change",
    acceptance: ["Tests pass"],
    data: { z: 1, nested: { b: true, a: false } },
  });
  const b = parseProjectTaskInput({
    acceptance: ["Tests pass"],
    goal: "Implement the accepted change",
    subject: "repo-1",
    type: "project.requested",
    id: "request-1",
    data: { nested: { a: false, b: true }, z: 1 },
  });
  assert.equal(canonicalProjectTask(a), canonicalProjectTask(b));

  for (const field of [
    "workflow",
    "worker",
    "cwd",
    "project",
    "identity",
    "access",
    "repository",
    "command",
    "stage",
    "session",
  ]) {
    assert.throws(() => parseProjectTaskInput({ ...a, [field]: "untrusted" }), new RegExp(`不认识的字段.*${field}`));
  }
  assert.throws(() => parseProjectTaskInput({ ...a, acceptance: [] }), /acceptance/);
  assert.throws(() => parseProjectTaskInput({ ...a, goal: "x".repeat(20_001) }), /goal/);
});

test("stage receipts carry evidence but can never select their next route", () => {
  const receipt = parseStageResult({
    execution_id: "task-1:g1:e1",
    verdict: "approved",
    request_id: "task-1:g1:e1",
    input_revision: "a".repeat(40),
    output_revision: "a".repeat(40),
    remote_ref: "refs/heads/autoloop/task-1",
    artifacts: [{ path: "PLAN.md", revision: "a".repeat(40), sha256: "b".repeat(64) }],
    checks: [{ name: "tests", exit_code: 0, revision: "a".repeat(40) }],
    findings: [],
  });
  assert.equal(receipt.verdict, "approved");
  assert.throws(() => parseStageResult({ ...receipt, next_stage: "execute" }), /不认识的字段.*next_stage/);
  assert.throws(
    () =>
      parseStageResult({
        ...receipt,
        findings: Array.from({ length: 101 }, () => ({ severity: "info", summary: "x" })),
      }),
    /findings/,
  );
});

test("unsafe workflows are rejected with actionable paths", () => {
  const problem = (change: (value: any) => void, words: RegExp) => {
    const value = configured();
    change(value);
    assert.throws(() => parseRules(JSON.stringify(value), at(0)), words);
  };
  problem((value) => delete value.workflows.delivery.max_transitions, /workflow delivery.*max_transitions/i);
  problem((value) => delete value.workflows.delivery.stages.plan.max_visits, /stage plan.*max_visits/i);
  problem((value) => (value.workflows.delivery.stages.plan.route = "missing"), /stage plan.*route.*missing/i);
  problem((value) => (value.workflows.delivery.stages.plan.on.planned = "missing"), /stage plan.*planned.*missing/i);
  problem((value) => (value.workflows.delivery.entry = "missing"), /workflow delivery.*entry.*missing/i);
  problem(
    (value) => value.rules.push({ ...value.rules.at(-3), name: "另一个项目入口", workflow: "delivery" }),
    /工作流入口.*重叠/,
  );
  problem(
    (value) => (value.workflows.delivery.human.options[1] = { label: "任意命令", action: "run", stage: "plan" }),
    /human.*action/i,
  );
  problem((value) => value.workflows.delivery.git.artifact_paths.push("PLAN.md"), /artifact_paths.*重复/i);
});

test("an invalid workflow reload leaves the active immutable routes unchanged", () => {
  const file = join(home, "workflow-rules.json");
  const active = configured();
  writeFileSync(file, JSON.stringify(active));
  utimesSync(file, new Date(at(20)), new Date(at(20)));
  assert.deepEqual(reloadRules(file), { changed: true });
  const before = configuration(getView());
  assert.equal(before.workflows.delivery.stages.plan.route, "规划阶段");

  const broken = configured();
  broken.workflows.delivery.stages.plan.route = "由任务选择";
  writeFileSync(file, JSON.stringify(broken));
  utimesSync(file, new Date(at(21)), new Date(at(21)));
  const answer = reloadRules(file);
  assert.equal(answer.changed, false);
  assert.match(answer.problem!, /route.*由任务选择/);
  const after = configuration(getView());
  assert.equal(after.workflows.delivery.stages.plan.route, "规划阶段");
  assert.deepEqual(after.workflows.delivery, before.workflows.delivery);
});
