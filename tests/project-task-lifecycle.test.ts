// Failure modes: review changes bypass bounded rework, completion accepts the wrong revision or fabricated checks, a
// blocked stage keeps a worker occupied, evidence is missing from context, sessions cross private workspaces,
// text chooses a route, or human admissions spend the final result transition or duplicate answers dispatch twice.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { rows } from "../kernel/evolve.ts";
import { at, setup } from "./helpers.ts";

const home = setup("project-task-lifecycle");
const file = join(home, "rules.json");
const rules = JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
rules.channels.lodestar = { name: "Lodestar", answerers: ["ou_owner"] };
const route = (name: string, type: string, to: string, mode: string) => ({
  name,
  when: { source: "app", types: [`internal.${type}`] },
  to,
  cwd: `/trusted/${type}`,
  prompt: `${name}可信说明。`,
  group: `project-${mode}`,
  parallel: 2,
});
rules.rules.push(
  {
    name: "项目入口",
    when: { source: "app", types: ["project.requested"] },
    to: "a1",
    cwd: "/trusted/intake",
    prompt: "接收任务。",
    workflow: "delivery",
  },
  route("规划阶段", "plan", "a1", "write"),
  route("执行阶段", "execute", "a1", "write"),
  route("审核阶段", "review", "a2", "inspect"),
  route("返工阶段", "rework", "a1", "write"),
  route("验收阶段", "verify", "a2", "inspect"),
);
const failure = { blocked: "$human", execution_failed: "$human" };
rules.workflows = {
  delivery: {
    entry: "plan",
    max_transitions: 12,
    stages: {
      plan: { route: "规划阶段", mode: "write", max_visits: 2, on: { planned: "execute", ...failure }, checks: [] },
      execute: {
        route: "执行阶段",
        mode: "write",
        max_visits: 2,
        on: { implemented: "review", ...failure },
        checks: [{ name: "tests", argv: ["npm", "test"], timeout_ms: 120_000 }],
      },
      review: {
        route: "审核阶段",
        mode: "inspect",
        max_visits: 3,
        on: { approved: "verify", changes_requested: "rework", ...failure },
        checks: [{ name: "review", argv: ["node", "review.js"], timeout_ms: 60_000 }],
      },
      rework: {
        route: "返工阶段",
        mode: "write",
        max_visits: 2,
        on: { implemented: "review", ...failure },
        checks: [{ name: "tests", argv: ["npm", "test"], timeout_ms: 120_000 }],
      },
      verify: {
        route: "验收阶段",
        mode: "inspect",
        max_visits: 2,
        on: { verified: "$complete", changes_requested: "rework", ...failure },
        checks: [{ name: "acceptance", argv: ["node", "verify.js"], timeout_ms: 60_000 }],
      },
    },
    git: {
      remote: "file:///tmp/project.git",
      base_ref: "refs/heads/main",
      task_ref_prefix: "refs/heads/autoloop/",
      artifact_paths: ["PLAN.md"],
    },
    recheck: "review",
    human: {
      options: [
        { label: "重试当前阶段", action: "retry" },
        { label: "重新审核", action: "resume", stage: "review" },
        { label: "结束任务", action: "fail" },
        { label: "取消任务", action: "cancel" },
      ],
    },
  },
};
writeFileSync(file, JSON.stringify(rules));
process.env.AGENT_AUTOLOOP_RULES = file;

const hub = await import("../host/runtime.ts");
const { AuthError, Conflict, InputError } = await import("../kernel/errors.ts");
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

const rev = (letter: string) => letter.repeat(40);
const sha = (letter: string) => letter.repeat(64);
const submit = (id: string) =>
  hub.execute(
    "submitProjectTask",
    ["app", { id, type: "project.requested", subject: id, goal: `Deliver ${id}`, acceptance: ["Verified"] }],
    at(0),
  ).task_id as string;
const claim = (worker: string, name: string, now: number) => hub.claimNext(worker, `${name}-${Math.random()}`, now)!;
function receipt(
  job: any,
  verdict: string,
  input: string,
  output = input,
  checks?: { name: string; exit_code: number; revision: string }[],
  findings?: { severity: "blocking" | "warning" | "info"; summary: string }[],
  session?: string,
) {
  return {
    outcome: "done",
    summary: `${job.stage.stage_id}:${verdict}`,
    ...(session ? { session } : {}),
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      verdict,
      input_revision: input,
      output_revision: output,
      remote_ref: `refs/heads/autoloop/${job.stage.task_id}`,
      artifacts: [{ path: "PLAN.md", revision: output, sha256: sha("f") }],
      checks: checks ?? job.stage.checks.map((check: any) => ({ name: check.name, exit_code: 0, revision: output })),
      findings: findings ?? (verdict === "changes_requested" ? [{ severity: "blocking", summary: "Needs a fix" }] : []),
    },
  };
}

test("plan, execute, review, bounded rework and exact verify complete one revision", () => {
  const taskId = submit("full-loop");
  let job = claim("w1", "plan", at(1));
  hub.finish(
    job.run,
    job.token,
    receipt(job, "planned", rev("a"), rev("b"), undefined, undefined, "native-plan"),
    at(2),
  );
  job = claim("w1", "execute", at(3));
  assert.equal(job.session, null, "plan and execute use distinct private workspaces");
  hub.finish(
    job.run,
    job.token,
    receipt(job, "implemented", rev("b"), rev("c"), undefined, undefined, "native-writer"),
    at(4),
  );
  job = claim("w2", "review-1", at(5));
  hub.finish(
    job.run,
    job.token,
    receipt(job, "changes_requested", rev("c"), rev("c"), undefined, undefined, "native-reviewer"),
    at(6),
  );
  job = claim("w1", "rework", at(7));
  assert.equal(job.session, null, "execute and rework use distinct private workspaces");
  assert.deepEqual(job.context.stage_evidence, job.stage!.evidence);
  assert.equal(job.context.stage_evidence!.at(-1)!.findings[0].summary, "Needs a fix");
  hub.finish(
    job.run,
    job.token,
    receipt(job, "implemented", rev("c"), rev("d"), undefined, undefined, "native-writer"),
    at(8),
  );
  job = claim("w2", "review-2", at(9));
  assert.equal(job.session, "native-reviewer");
  assert.throws(
    () =>
      hub.finish(
        job.run,
        job.token,
        receipt(job, "approved", rev("d"), rev("d"), undefined, [
          { severity: "blocking", summary: "still blocks approval" },
        ]),
        at(10),
      ),
    InputError,
  );
  hub.finish(
    job.run,
    job.token,
    receipt(job, "approved", rev("d"), rev("d"), undefined, undefined, "native-reviewer"),
    at(10),
  );
  job = claim("w2", "verify", at(11));
  assert.equal(job.session, null, "review and verify use distinct private workspaces");
  assert.throws(
    () =>
      hub.finish(
        job.run,
        job.token,
        receipt(job, "verified", rev("d"), rev("d"), undefined, [
          { severity: "blocking", summary: "verification found a blocker" },
        ]),
        at(12),
      ),
    InputError,
  );
  assert.throws(
    () => hub.finish(job.run, job.token, receipt(job, "verified", rev("d"), rev("d"), []), at(12)),
    InputError,
    "verified without the configured check is not completion evidence",
  );
  hub.finish(
    job.run,
    job.token,
    receipt(job, "verified", rev("d"), rev("d"), undefined, undefined, "native-reviewer"),
    at(13),
  );

  const status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "completed");
  assert.equal(status.current_revision, rev("d"));
  assert.equal(status.transitions, 6);
  assert.deepEqual(status.visits, { plan: 1, execute: 1, review: 2, rework: 1, verify: 1 });
  assert.deepEqual(
    status.executions.map((item: any) => item.result.verdict),
    ["planned", "implemented", "changes_requested", "implemented", "approved", "verified"],
  );
});

test("blocked stage ends, one versioned Hub card accepts one trusted action, and text cannot route", () => {
  const taskId = submit("human-loop");
  let job = claim("w1", "blocked", at(20));
  hub.finish(
    job.run,
    job.token,
    receipt(job, "blocked", rev("a"), rev("a"), undefined, undefined, "native-plan"),
    at(21),
  );
  let status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.state, "waiting_human");
  assert.equal(hub.claimNext("w1", "none", at(22)), null, "waiting does not keep a run alive");
  const card = hub.getView().get("cards", status.human_card)!;
  assert.equal(card.task_id, taskId);
  assert.equal(card.task_execution, job.stage!.execution_id);
  assert.equal(rows(hub.getView(), "cards", { task_id: taskId, state: "open" }).length, 1);

  assert.deepEqual(hub.answer(card.id, { text: "请先说明风险", by: "owner" }, at(23)), {
    changed: true,
    state: "open",
  });
  assert.equal(hub.claimNext("w1", "still-none", at(23)), null);
  assert.equal(hub.answer(card.id, { text: "另一个文本", by: "owner" }, at(24)).changed, false);
  assert.equal(hub.answer(card.id, { choice: 0, by: "owner" }, at(25)).changed, true);
  assert.equal(hub.answer(card.id, { choice: 0, by: "owner" }, at(26)).changed, false);
  job = claim("w1", "retry", at(26));
  assert.equal(job.stage!.stage_id, "plan");
  assert.equal(job.stage!.input_revision, rev("a"));
  assert.equal(job.session, "native-plan");
  assert.deepEqual(job.context.task_decisions, [
    {
      card: card.id,
      generation: 1,
      execution_id: card.task_execution,
      revision: rev("a"),
      title: card.title,
      options: rules.workflows.delivery.human.options,
      choice: 0,
      text: "请先说明风险",
      by: "owner",
      at: new Date(at(25)).toISOString(),
      text_by: "owner",
      text_at: new Date(at(23)).toISOString(),
    },
  ]);
  status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.visits.plan, 2);
  assert.equal(status.transitions, 2, "blocked and the human-authorized retry are cumulative transitions");
});

test("resolve/answer races and stale task cards never advance", () => {
  const taskId = submit("stale-card");
  const job = claim("w1", "stale", at(30));
  hub.finish(job.run, job.token, receipt(job, "blocked", rev("a")), at(31));
  const card = projectTask(hub.getView(), taskId)!.human_card;
  assert.equal(hub.resolve(card, "No longer needed", "owner", at(32)), true);
  assert.equal(hub.answer(card, { choice: 0, by: "owner" }, at(33)).changed, false);
  assert.equal(hub.claimNext("w1", "no-stale", at(34)), null);
});

test("task-aware cards do not change legacy card or hop behavior", () => {
  const taskId = submit("bounds");
  let job = claim("w1", "bound-1", at(40));
  hub.finish(job.run, job.token, receipt(job, "blocked", rev("a")), at(41));
  const first = projectTask(hub.getView(), taskId)!.human_card;
  hub.answer(first, { choice: 0 }, at(42));
  job = claim("w1", "bound-2", at(43));
  hub.finish(job.run, job.token, receipt(job, "blocked", rev("a")), at(44));
  const status = projectTask(hub.getView(), taskId)!;
  assert.equal(status.visits.plan, 2);
  assert.equal(rows(hub.getView(), "cards", { task_id: taskId, state: "open" }).length, 1);
  assert.throws(
    () => hub.answer(status.human_card, { choice: 0 }, at(45)),
    Conflict,
    "human choice cannot enlarge max_visits",
  );
});

test("no next stage is enqueued when the current transition consumes the remaining budget", () => {
  const before = structuredClone(hub.rules);
  const limited = structuredClone(before);
  limited.workflows.delivery.max_transitions = 1;
  hub.execute("rules", [limited], at(50));
  try {
    const taskId = submit("transition-budget");
    const job = claim("w1", "transition-budget", at(51));
    hub.finish(job.run, job.token, receipt(job, "planned", rev("a"), rev("b")), at(52));
    const status = projectTask(hub.getView(), taskId)!;
    assert.equal(status.state, "waiting_human");
    assert.equal(status.transitions, 1);
    assert.equal(status.executions.length, 1);
    assert.equal(rows(hub.getView(), "runs", { task_id: taskId }).length, 1);
  } finally {
    hub.execute("rules", [before], at(53));
  }
});

test("human retry reserves a result transition and repeated answers never spend budget twice", () => {
  const before = structuredClone(hub.rules);
  try {
    for (const max of [1, 2, 3]) {
      const limited = structuredClone(before);
      limited.workflows.delivery.entry = "verify";
      limited.workflows.delivery.max_transitions = max;
      hub.execute("rules", [limited], at(60));
      const taskId = submit(`human-result-budget-${max}`);
      let job = claim("w2", `budget-${max}`, at(61));
      hub.finish(job.run, job.token, receipt(job, "blocked", rev("a")), at(62));
      const status = projectTask(hub.getView(), taskId)!;
      const card = status.human_card;
      if (max < 3) {
        assert.throws(() => hub.answer(card, { choice: 0, by: "owner" }, at(63)), /上限/);
        assert.equal(projectTask(hub.getView(), taskId)!.transitions, 1);
        assert.equal(projectTask(hub.getView(), taskId)!.executions.length, 1);
      } else {
        assert.equal(hub.answer(card, { choice: 0, by: "owner" }, at(63)).changed, true);
        assert.equal(hub.answer(card, { choice: 0, by: "owner" }, at(64)).changed, false);
        assert.equal(projectTask(hub.getView(), taskId)!.transitions, 2);
        job = claim("w2", "last-completable", at(65));
        const result = receipt(job, "verified", rev("a"));
        hub.finish(job.run, job.token, result, at(66));
        assert.equal(hub.finish(job.run, job.token, result, at(67)).duplicate, true);
        assert.equal(projectTask(hub.getView(), taskId)!.state, "completed");
        assert.equal(projectTask(hub.getView(), taskId)!.transitions, 3);
      }
    }
  } finally {
    hub.execute("rules", [before], at(68));
  }
});

test("Lodestar transport answer advances once only after Hub validates operator and original message ref", () => {
  const taskId = submit("lodestar-answer");
  let job = claim("w1", "lodestar-blocked", at(50));
  hub.finish(job.run, job.token, receipt(job, "blocked", rev("a")), at(51));
  const status = projectTask(hub.getView(), taskId)!;
  const card = hub.getView().get("cards", status.human_card)!;
  hub.delivered("lodestar", card.id, card.version, "om_task_answer", at(52));
  assert.throws(
    () => hub.answer(card.id, { choice: 0, by: "ou_forged", channel: "lodestar", ref: "om_task_answer" }, at(53)),
    AuthError,
  );
  assert.throws(
    () => hub.answer(card.id, { choice: 0, by: "ou_owner", channel: "lodestar", ref: "om_wrong" }, at(54)),
    AuthError,
  );
  assert.equal(
    hub.answer(card.id, { choice: 0, by: "ou_owner", channel: "lodestar", ref: "om_task_answer" }, at(55)).changed,
    true,
  );
  assert.equal(
    hub.answer(card.id, { choice: 0, by: "ou_owner", channel: "lodestar", ref: "om_task_answer" }, at(56)).changed,
    false,
  );
  job = claim("w1", "lodestar-retry", at(57));
  assert.equal(job.stage!.stage_id, "plan");
  assert.equal(projectTask(hub.getView(), taskId)!.visits.plan, 2);
});
