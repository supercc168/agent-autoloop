// Failure modes: the three-machine recipe only passes in an in-memory shortcut, writer/reviewer share a workspace,
// evidence/human text never reaches the actual native input, sessions cross private working directories, recheck
// silently reuses the prior generation's commit, or lost publication readings repeat native work/checks.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  runLodestarInterop,
  runProjectWorkflowE2E,
  taskProgressFingerprint,
  waitForTask,
} from "./project-workflow-fixture.ts";

const recipe = join(import.meta.dirname, "..", "examples", "recipes", "project-workflow");

test("fixture stall tracking ignores heartbeat timestamps and observes semantic stage progress", () => {
  const running = {
    state: "running",
    generation: 1,
    transitions: 6,
    current_stage: "verify",
    current_execution: "exec-7",
    current_revision: "a".repeat(40),
    execution_count: 7,
    updated_at: "2026-11-04T00:00:00.000Z",
    executions: [
      { execution_id: "exec-7", stage_id: "verify", state: "running", progress: { remote_state: "running" } },
    ],
    runs: [{ id: 7, state: "claimed", session: "native-review" }],
  };
  assert.equal(
    taskProgressFingerprint(running),
    taskProgressFingerprint({ ...running, updated_at: "2026-11-04T00:10:00.000Z" }),
    "heartbeat-only timestamps cannot keep a hung fixture alive",
  );
  assert.notEqual(
    taskProgressFingerprint(running),
    taskProgressFingerprint({
      ...running,
      state: "completed",
      executions: [{ ...running.executions[0], state: "finished", verdict: "verified" }],
    }),
    "terminal evidence is semantic progress",
  );
});

test("fixture no-progress budget fails a heartbeat-only hang before the total cap", async () => {
  let heartbeat = 0;
  const client = {
    async projectTask() {
      heartbeat++;
      return {
        state: "running",
        generation: 1,
        transitions: 1,
        current_stage: "verify",
        current_execution: "exec-hung",
        execution_count: 1,
        updated_at: new Date(heartbeat * 1000).toISOString(),
        executions: [{ execution_id: "exec-hung", stage_id: "verify", state: "running" }],
        runs: [{ id: 1, state: "claimed" }],
      };
    },
  };
  const started = Date.now();
  await assert.rejects(
    () => waitForTask(client, "task-hung", "completed", { totalMs: 1000, noProgressMs: 60 }),
    /no semantic progress/,
  );
  assert.ok(Date.now() - started < 500, "semantic stall cap, not total cap, ended the wait");
});

test("real Hub and three isolated workers complete the shipped workflow with one human retry", async (t) => {
  const result = await runProjectWorkflowE2E(t, recipe);

  assert.equal(result.task.state, "completed");
  assert.deepEqual(result.task.visits, { plan: 2, execute: 1, review: 2, rework: 1, verify: 1 });
  assert.deepEqual(
    result.trace.map((item) => [item.worker, item.stage, item.verdict]),
    [
      ["mac-a", "plan", "blocked"],
      ["mac-a", "plan", "planned"],
      ["mac-b", "execute", "implemented"],
      ["mac-c", "review", "changes_requested"],
      ["mac-b", "rework", "implemented"],
      ["mac-c", "review", "approved"],
      ["mac-c", "verify", "verified"],
    ],
  );
  assert.equal(result.cliReplay.duplicate, true);
  assert.equal(result.humanAnswers, 1);
  assert.equal(result.physicalCards, 1, "the human round uses one versioned physical card");

  const accepted = result.task.executions.filter((item: any) => item.result?.output_revision);
  assert.ok(accepted.every((item: any) => /^[0-9a-f]{40}$/.test(item.result.output_revision)));
  assert.ok(
    accepted.every((item: any) =>
      item.result.artifacts.every((artifact: any) => artifact.revision === item.result.output_revision),
    ),
  );
  assert.ok(accepted.every((item: any) => item.result.checks.every((check: any) => check.exit_code === 0)));
  assert.equal(result.task.current_revision, result.remoteTaskRevision);
  assert.equal(result.artifactText, "rework:accepted\n");

  const workdirs = new Set(result.trace.map((item) => item.workDir));
  assert.equal(workdirs.size, 5, "each trusted route keeps an independent private workspace");
  for (const left of ["mac-a", "mac-b", "mac-c"])
    for (const right of ["mac-a", "mac-b", "mac-c"])
      if (left < right) {
        const l = new Set(result.trace.filter((item) => item.worker === left).map((item) => item.workDir));
        const r = new Set(result.trace.filter((item) => item.worker === right).map((item) => item.workDir));
        assert.ok(
          [...l].every((directory) => !r.has(directory)),
          `${left}/${right} workspaces must be independent`,
        );
      }
  assert.ok(
    result.trace.filter((item) => item.worker === "mac-c").every((item) => item.inputRevision === item.outputRevision),
  );
  const retry = result.trace.find((item) => item.stage === "plan" && item.verdict === "planned")!;
  const decision = retry.context.task_decisions.find((item: any) => item.text === result.humanNote);
  assert.ok(decision, "native retry must consume the owner's actual context.json text");
  assert.equal(decision.options[decision.choice].action, "retry");
  assert.equal(decision.by, "operator-fixture");
  assert.equal(decision.text_by, "本人");
  const rework = result.trace.find((item) => item.stage === "rework")!;
  const rejectedReview = result.trace.find((item) => item.verdict === "changes_requested")!;
  const evidence = rework.context.stage_evidence.find((item: any) => item.execution_id === rejectedReview.requestId);
  assert.equal(evidence.findings[0].summary, result.reviewFinding);
  assert.equal(evidence.output_revision, rework.inputRevision);
  assert.equal(evidence.generation, 1);
  for (const call of result.trace) {
    assert.ok(!call.prompt.includes(result.humanNote), "human text remains data rather than prompt instructions");
    assert.ok(
      !call.prompt.includes(result.reviewFinding),
      "review findings remain data rather than prompt instructions",
    );
    const prior = result.trace
      .slice(0, result.trace.indexOf(call))
      .filter((item) => item.workDir === call.workDir)
      .at(-1);
    assert.equal(call.requestedSession, prior?.session ?? null, "resume is scoped to the exact private workspace");
    if (prior) assert.equal(call.session, prior.session);
    for (const other of result.trace.filter((item) => item.workDir !== call.workDir))
      assert.notEqual(call.session, other.session, "different workspaces must not share a native session");
  }
  assert.equal(result.rejectedCrossWorkspaceResume, 409, "the native fake itself enforces session-to-cwd ownership");
  t.diagnostic(
    JSON.stringify({
      nativeStarts: result.trace.length,
      revision: result.task.current_revision,
      humanDecision: decision,
      reviewEvidence: evidence,
      sessions: result.trace.map((call) => ({
        stage: call.stage,
        session: call.session,
        resume: call.requestedSession,
      })),
    }),
  );
});

test("MCP recheck pins an advanced task ref for review and verify without changing historical evidence or writing refs", async (t) => {
  const result = await runProjectWorkflowE2E(t, recipe, { recheck: true });
  assert.equal(result.task.state, "completed");
  assert.equal(result.task.generation, 2);
  assert.equal(result.mcpReplay.duplicate, true);
  const recheck = result.task.executions.filter((item: any) => item.generation === 2);
  assert.deepEqual(
    recheck.map((item: any) => item.stage_id),
    ["review", "verify"],
  );
  assert.notEqual(result.recheckRevision, result.firstGenerationRevision);
  assert.ok(recheck.every((item: any) => item.input_revision === result.recheckRevision));
  assert.ok(recheck.every((item: any) => item.input_resolution === "task_ref"));
  assert.ok(recheck.every((item: any) => item.result.output_revision === result.recheckRevision));
  assert.ok(
    recheck.every((item: any) => item.result.checks.every((check: any) => check.revision === result.recheckRevision)),
  );
  assert.deepEqual(
    result.task.executions.filter((item: any) => item.generation === 1),
    result.firstGenerationEvidence,
  );
  assert.equal(result.refsAfterRecheck, result.refsBeforeRecheck, "Mac C review/verify have no Git write requirement");
  assert.equal(result.task.current_revision, result.recheckRevision);
  t.diagnostic(
    JSON.stringify({
      oldRevision: result.firstGenerationRevision,
      pinnedRevision: result.recheckRevision,
      generation: result.task.generation,
      receipts: recheck.map((execution: any) => execution.result),
      historicalEvidenceUnchanged: true,
      refsUnchanged: true,
    }),
  );
});

test("real worker recovers a lost post-CAS reading from the prepared receipt without another native start or check", async (t) => {
  const result = await runProjectWorkflowE2E(t, recipe, { publicationLoss: true });
  assert.equal(result.task.state, "completed");
  assert.ok(result.publicationRecovery?.prepared, "fault must occur only after the canonical receipt was saved");
  assert.deepEqual(result.publicationRecovery.recovered, result.publicationRecovery.prepared);
  assert.equal(result.publicationRecovery.checksAfter, result.publicationRecovery.checksBefore);
  assert.equal(result.trace.filter((item) => item.stage === "execute").length, 1);
  assert.equal(result.task.executions.length, 7);
  assert.equal(result.task.current_revision, result.remoteTaskRevision);
  t.diagnostic(JSON.stringify({ nativeStarts: result.trace.length, publicationRecovery: result.publicationRecovery }));
});

const lodestarRepo = process.env.AGENT_AUTOLOOP_LODESTAR_REPO;
const pinnedBun = process.env.AGENT_AUTOLOOP_PINNED_BUN;
test(
  "opt-in adapter interop uses the real Lodestar API and AgentService terminal shapes",
  { skip: !lodestarRepo || !pinnedBun },
  async (t) => {
    const result = await runLodestarInterop(t, { lodestarRepo: lodestarRepo!, bun: pinnedBun! });
    assert.equal(result.completed.finished, true);
    assert.equal(
      result.completed.text,
      "real AgentService terminal",
      `unexpected real AgentService completion reading: ${JSON.stringify(result.completed)}`,
    );
    assert.equal(result.completed.session, "native-interop");
    assert.equal(result.cancelled.finished, true);
    assert.equal(result.cancelled.result?.outcome, "cancelled");
    assert.equal(result.cancelled.result?.stage, undefined);
    t.diagnostic(JSON.stringify({ completed: result.completed, cancelled: result.cancelled }));
  },
);
