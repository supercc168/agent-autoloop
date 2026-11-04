// Failure modes: the safety tests pass after an authorization, deduplication, queue, receipt, deadline, replay or transaction
// guard is removed; mutation reporting counts syntax errors as detections or silently omits surviving mutations.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyMutation, mutate } from "./mutate.ts";

test("source and worker mutations target the current legacy intake and claim guards exactly once", () => {
  const source = readFileSync(new URL("../kernel/decide.ts", import.meta.url), "utf8");
  const sourceMutant = applyMutation("source-boundary", source);
  assert.match(
    sourceMutant,
    /workflow && eventRule\(rule\) && rule\.when\.source === source/,
    "workflow task intake must remain unchanged",
  );
  assert.match(sourceMutant, /!rule\.workflow && eventRule\(rule\) && true && typeMatches/);

  const workerMutant = applyMutation("worker-boundary", source);
  assert.match(workerMutant, /run\.state === "queued" &&\s+true &&\s+Date\.parse/);
  assert.doesNotMatch(workerMutant, /run\.task_id \? workerOf\(draft\.view, run\) === worker/);
});

test("at least 95 percent of executable kernel mutations are detected", () => {
  const result = mutate();
  console.log(JSON.stringify(result));
  assert.equal(result.invalid.length, 0);
  assert.ok(result.killed / result.total >= 0.95, JSON.stringify(result.survived));
});
