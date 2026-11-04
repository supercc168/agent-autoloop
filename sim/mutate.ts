import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const edits: [string, string, string, string][] = [
  ["event-duplicate", "decide.ts", "if (existing) return { event:", "if (false && existing) return { event:"],
  [
    "source-boundary",
    "decide.ts",
    "!rule.workflow && eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, event.type)",
    "!rule.workflow && eventRule(rule) && true && typeMatches(rule.when.types, event.type)",
  ],
  ["parallel-lane", "decide.ts", 'const lane = rule.parallel ? subject : ""', 'const lane = ""'],
  ["group-capacity", "decide.ts", "claimed.filter((other) => other.grp === run.grp).length <", "0 <"],
  ["lane-exclusion", "decide.ts", "!claimed.some((other) => other.grp === run.grp && other.lane === run.lane)", "true"],
  [
    "worker-boundary",
    "decide.ts",
    '(run.task_id ? workerOf(draft.view, run) === worker : agents.includes(ruleNamed(draft, run.rule)?.to ?? ""))',
    "true",
  ],
  ["retry-delay", "decide.ts", "5 * MINUTE * 2 ** (attempts - 1)", "0 * MINUTE * 2 ** (attempts - 1)"],
  [
    "receipt-replay",
    "decide.ts",
    "if (prior && prior.last_issued !== null &&",
    "if (false && prior && prior.last_issued !== null &&",
  ],
  ["receipt-conflict", "decide.ts", "if (prior.last_result !== hash)", "if (false)"],
  ["run-capability", "decide.ts", 'credential(draft.env, "run", id, run.issued) !== token', "false"],
  [
    "answer-first",
    "decide.ts",
    'if (card.state !== "open") return { changed: false, state: card.state };',
    "if (false) return { changed: false, state: card.state };",
  ],
  ["answer-person", "decide.ts", 'if (allowed && !allowed.includes(given.by ?? ""))', "if (false)"],
  ["answer-message", "decide.ts", "if (!delivery?.ref || delivery.ref !== given.ref)", "if (false)"],
  [
    "answer-wakeup",
    "decide.ts",
    "if (rule) enqueue(draft, rule, eventId, card.lane,",
    "if (false) enqueue(draft, rule, eventId, card.lane,",
  ],
  ["quiet-delivery", "decide.ts", "if (card.quiet ||", "if (false ||"],
  ["delivery-lease", "decide.ts", "not_before: iso(now + MINUTE)", "not_before: iso(now)"],
  ["delivery-version", "decide.ts", "version: Math.max(delivery.version, version)", "version: version"],
  [
    "timer-fire",
    "decide.ts",
    "timer.event_id === null && Date.parse(timer.at) <= now",
    "timer.event_id !== null && Date.parse(timer.at) <= now",
  ],
  [
    "cron-latest",
    "decide.ts",
    "latestBefore(cron, Date.parse(schedule.next_at), now, timezone)",
    "Date.parse(schedule.next_at)",
  ],
  [
    "retry-deadline",
    "due.ts",
    'run.state === "queued" && notBefore > now',
    'run.state === "queued" && notBefore < now',
  ],
  ["projection-drop", "evolve.ts", "if (row === null)", 'if (row === null || table === "cards")'],
  ["log-order", "store.ts", "ORDER BY seq", "ORDER BY seq DESC"],
  ["stale-commit", "store.ts", "if (latest !== view.seq)", "if (false)"],
  ["log-append", "store.ts", "for (const fact of facts) insert.run", "for (const fact of []) insert.run"],
  ["transaction-removed", "store.ts", "return transaction(db, () => {", "return ((work) => work())(() => {"],
];
const tests = ["kernel", "events", "cards", "runs", "schedule", "stream", "purity"].map((n) => `tests/${n}.test.ts`);

export function applyMutation(name: string, text: string) {
  const edit = edits.find(([candidate]) => candidate === name);
  if (!edit) throw new Error(`unknown mutation: ${name}`);
  const before = edit[2];
  const matches = text.split(before).length - 1;
  assert.equal(matches, 1, `${name}: expected exactly one mutation anchor, found ${matches}`);
  return text.replace(before, edit[3]);
}

export function mutate() {
  const root = join(import.meta.dirname, "..");
  const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-mutation-"));
  // An inherited test-runner context bypasses the child CLI's test selection.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", "--test-reporter=tap", ...tests], {
      cwd: folder,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
  try {
    for (const name of ["kernel", "protocol", "host", "tests", "package.json"])
      cpSync(join(root, name), join(folder, name), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(folder, "node_modules"));
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    assert.ok(Number(/# tests (\d+)/.exec(baseline.stdout)?.[1]) > 50, "基线必须确实执行行为测试");
    const mutations = edits.map(([name, file]) => ({
      name,
      file,
      change: (text: string) => applyMutation(name, text),
    }));
    const survived: string[] = [];
    const invalid: string[] = [];
    let killed = 0;
    for (const mutation of mutations) {
      const file = join(folder, "kernel", mutation.file);
      const original = readFileSync(file, "utf8");
      try {
        writeFileSync(file, mutation.change(original));
        const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
        if (syntax.status !== 0) {
          invalid.push(mutation.name);
          continue;
        }
        const result = run();
        if (result.status === 0) survived.push(mutation.name);
        else {
          assert.ok(!result.error, `${mutation.name}: ${result.error}`);
          killed++;
        }
        console.log(`${mutation.name}: ${result.status === 0 ? "漏过" : "抓到"}`);
      } finally {
        writeFileSync(file, original);
      }
    }
    return { total: mutations.length, killed, survived, invalid, ratio: killed / mutations.length };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
if (import.meta.main) console.log(JSON.stringify(mutate(), null, 2));
