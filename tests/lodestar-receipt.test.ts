// Failure modes: model prose fabricates revisions/checks, malformed or trailing receipt text completes a stage, failing
// trusted checks advance refs, uncommitted artifacts count as evidence, operator attestation is accepted from model text,
// or a crash after Git publication replaces the original measured receipt or reruns checks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { prepareStageWorkspace } from "../plugins/lodestar/git.ts";
import { buildStageResult, parseStageMessage } from "../plugins/lodestar/receipt.ts";
import { observeTurn, prepareTurn } from "../plugins/lodestar/run.ts";
import type { Turn } from "../worker/agents.ts";

const root = mkdtempSync(path.join(tmpdir(), "autoloop-lodestar-receipt-"));
after(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function fixture(name: string, checkExit = 0) {
  const source = path.join(root, `${name}-source`);
  const remote = path.join(root, `${name}.git`);
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Receipt Test");
  git(source, "config", "user.email", "receipt@example.invalid");
  writeFileSync(path.join(source, "README.md"), "base\n");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "base");
  git(root, "clone", "--bare", source, remote);
  const cwd = path.join(root, `${name}-project`);
  git(root, "clone", remote, cwd);
  git(cwd, "config", "user.name", "Receipt Test");
  git(cwd, "config", "user.email", "receipt@example.invalid");
  const stage = {
    task_id: `task-${name}`,
    execution_id: `execution-${name}`,
    generation: 1,
    stage_id: "execute",
    input_revision: null,
    workflow: {
      entry: "execute",
      max_transitions: 10,
      stages: {
        execute: {
          route: "writer",
          mode: "write" as const,
          max_visits: 2,
          on: { implemented: "review", blocked: "$human", execution_failed: "$human" },
          checks: [
            { name: "trusted", argv: [process.execPath, "-e", `process.exit(${checkExit})`], timeout_ms: 5_000 },
          ],
        },
      },
      git: {
        remote,
        base_ref: "refs/heads/main",
        task_ref_prefix: "refs/heads/autoloop/",
        artifact_paths: ["artifacts/result.txt"],
      },
      human: { options: [] },
    },
    route: { name: "writer", agent_id: "agent", worker: "writer", cwd, access: "full" },
    git: {
      remote,
      base_ref: "refs/heads/main",
      task_ref_prefix: "refs/heads/autoloop/",
      artifact_paths: ["artifacts/result.txt"],
    },
    checks: [{ name: "trusted", argv: [process.execPath, "-e", `process.exit(${checkExit})`], timeout_ms: 5_000 }],
    evidence: [],
  };
  const turn = {
    prompt: "stage work",
    session: "native-session",
    resume: null,
    cwd,
    access: "full",
    contextFile: path.join(cwd, "context.json"),
    folder: path.join(cwd, ".turn"),
    invocation: `invocation-${name}`,
    stage,
  } as Turn;
  mkdirSync(turn.folder);
  return { source, remote, cwd, turn, base: git(source, "rev-parse", "HEAD") };
}

const message = (body: object, suffix = "") =>
  `Measured result follows.\n\n\`\`\`agent-autoloop-stage\n${JSON.stringify(body)}\n\`\`\`${suffix}`;

test("strict stage receipt accepts only declarative verdict, summary, paths and findings", () => {
  const repo = fixture("parser");
  const valid = {
    verdict: "implemented",
    summary: "implementation committed",
    artifacts: ["artifacts/result.txt"],
    findings: [{ severity: "info", summary: "ready for review" }],
  };
  assert.deepEqual(parseStageMessage(message(valid), repo.turn), valid);
  for (const bad of [
    "plain prose",
    message(valid, "\ntrailing"),
    `${message(valid)}\n${message(valid)}`,
    message({ ...valid, output_revision: "a".repeat(40) }),
    message({ ...valid, checks: [{ name: "fake", exit_code: 0 }] }),
    message({ ...valid, resolution: { kind: "operator_attested" } }),
    message({ ...valid, verdict: "verified" }),
    message({ ...valid, artifacts: ["../escape"] }),
  ]) {
    assert.throws(() => parseStageMessage(bad, repo.turn));
  }
});

test("approved or verified receipts cannot coexist with a blocking finding", () => {
  const repo = fixture("blocking-verdict");
  const configured = repo.turn.stage!.workflow.stages.execute!;
  configured.on.approved = "$complete";
  configured.on.verified = "$complete";
  for (const verdict of ["approved", "verified"]) {
    assert.throws(() =>
      parseStageMessage(
        message({
          verdict,
          summary: "claims success",
          artifacts: [],
          findings: [{ severity: "blocking", summary: "must fix" }],
        }),
        repo.turn,
      ),
    );
  }
  assert.equal(
    parseStageMessage(
      message({
        verdict: "verified",
        summary: "verified with warning",
        artifacts: [],
        findings: [{ severity: "warning", summary: "follow-up" }],
      }),
      repo.turn,
    ).verdict,
    "verified",
  );
});

test("write receipt publishes only committed artifact bytes and measured passing checks", () => {
  const repo = fixture("passing");
  const workspace = prepareStageWorkspace(repo.turn);
  mkdirSync(path.join(workspace.workDir, "artifacts"));
  writeFileSync(path.join(workspace.workDir, "artifacts", "result.txt"), "committed evidence\n");
  git(workspace.workDir, "add", "artifacts/result.txt");
  git(workspace.workDir, "commit", "-m", "result");
  const result = buildStageResult({
    turn: repo.turn,
    workspace,
    finalOutput: message({
      verdict: "implemented",
      summary: "implementation committed",
      artifacts: ["artifacts/result.txt"],
      findings: [],
    }),
    requestId: "request-passing",
    remoteRunId: "remote-passing",
    session: "native-passing",
    diagnosticDir: repo.turn.folder,
  });
  assert.equal(result.outcome, "done");
  assert.equal(result.stage?.verdict, "implemented");
  assert.equal(result.stage?.input_revision, repo.base);
  assert.equal(result.stage?.output_revision, git(workspace.workDir, "rev-parse", "HEAD"));
  assert.equal(result.stage?.checks[0]?.exit_code, 0);
  assert.equal(result.stage?.checks[0]?.revision, result.stage?.output_revision);
  assert.equal(result.stage?.artifacts[0]?.sha256.length, 64);
  assert.match(result.stage?.remote_ref ?? "", /^refs\/agent-autoloop\/executions\//);
  assert.equal(result.session, "native-passing");
});

test("malformed receipt and failing trusted check become execution_failed without advancing the task ref", () => {
  for (const [name, finalOutput, checkExit] of [
    ["malformed", "not a fenced receipt", 0],
    [
      "check-failure",
      message({ verdict: "implemented", summary: "fake pass", artifacts: ["artifacts/result.txt"], findings: [] }),
      7,
    ],
  ] as const) {
    const repo = fixture(name, checkExit);
    const workspace = prepareStageWorkspace(repo.turn);
    mkdirSync(path.join(workspace.workDir, "artifacts"));
    writeFileSync(path.join(workspace.workDir, "artifacts", "result.txt"), "not accepted\n");
    git(workspace.workDir, "add", "artifacts/result.txt");
    git(workspace.workDir, "commit", "-m", "unaccepted");
    const result = buildStageResult({
      turn: repo.turn,
      workspace,
      finalOutput,
      requestId: `request-${name}`,
      remoteRunId: `remote-${name}`,
      session: `native-${name}`,
      diagnosticDir: repo.turn.folder,
    });
    assert.equal(result.outcome, "done");
    assert.equal(result.stage?.verdict, "execution_failed");
    assert.equal(git(repo.source, "ls-remote", repo.remote, workspace.taskRef).split(/\s+/)[0], repo.base);
    if (checkExit) {
      assert.equal(result.stage?.checks[0]?.exit_code, checkExit);
      assert.ok(existsSync(path.join(repo.turn.folder, "stage-check-0.stdout.log")));
      assert.ok(existsSync(path.join(repo.turn.folder, "stage-check-0.stderr.log")));
    }
  }
});

test("operator resolution provenance comes from transport input, never model JSON", () => {
  const repo = fixture("resolution");
  const workspace = prepareStageWorkspace(repo.turn);
  const resolution = {
    kind: "operator_attested" as const,
    reason: "operator stopped native work",
    at: "2026-11-04T00:00:00.000Z",
    binding_id: "binding-one",
  };
  const result = buildStageResult({
    turn: repo.turn,
    workspace,
    finalOutput: "ignored after operator reconciliation",
    requestId: "request-resolution",
    remoteRunId: "remote-resolution",
    resolution,
    diagnosticDir: repo.turn.folder,
  });
  assert.equal(result.stage?.verdict, "execution_failed");
  assert.deepEqual(result.stage?.resolution, resolution);
  assert.ok(!readFileSync(path.join(repo.turn.folder, "stage-diagnostic.txt"), "utf8").includes("capability"));
});

test("completion racing cancellation publishes immutable evidence without advancing the task ref", () => {
  const repo = fixture("late");
  const workspace = prepareStageWorkspace(repo.turn);
  mkdirSync(path.join(workspace.workDir, "artifacts"));
  writeFileSync(path.join(workspace.workDir, "artifacts", "result.txt"), "late evidence\n");
  git(workspace.workDir, "add", "artifacts/result.txt");
  git(workspace.workDir, "commit", "-m", "late result");
  const result = buildStageResult({
    turn: repo.turn,
    workspace,
    finalOutput: message({
      verdict: "implemented",
      summary: "late result",
      artifacts: ["artifacts/result.txt"],
      findings: [],
    }),
    requestId: "request-late",
    remoteRunId: "remote-late",
    session: "native-late",
    diagnosticDir: repo.turn.folder,
    late: true,
  });
  assert.equal(result.stage?.verdict, "implemented");
  assert.notEqual(result.stage?.output_revision, repo.base);
  assert.match(result.stage?.remote_ref ?? "", /^refs\/agent-autoloop\/executions\//);
  assert.equal(git(repo.source, "ls-remote", repo.remote, workspace.taskRef).split(/\s+/)[0], repo.base);
});

test("real adapter submits the private workspace and returns measured stage progress and result", async (t) => {
  const repo = fixture("adapter");
  const finalOutput = message({
    verdict: "implemented",
    summary: "adapter result committed",
    artifacts: ["artifacts/result.txt"],
    findings: [],
  });
  let snapshot: any;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== "Bearer adapter-capability") return send(403, { error: "bad capability" });
    if (url.searchParams.get("project") !== "repo") return send(403, { error: "bad project" });
    if (url.pathname === "/agents/project-binding") {
      return send(200, {
        installation_id: "installation-adapter",
        binding_id: "binding-adapter",
        project: "repo",
        chat_id: "chat-adapter",
        work_dir: path.resolve(repo.cwd),
      });
    }
    if (url.pathname === "/agents/identities") {
      return send(200, { identities: [{ id: "executor", status: "ready", supported_efforts: ["high"] }] });
    }
    if (request.method === "POST" && url.pathname === "/agents/runs") {
      assert.equal(body.expected_binding, "binding-adapter");
      assert.notEqual(body.work_dir, repo.cwd);
      assert.ok(body.work_dir.startsWith(`${realpathSync(path.join(repo.cwd, ".git"))}${path.sep}`));
      mkdirSync(path.join(body.work_dir, "artifacts"));
      writeFileSync(path.join(body.work_dir, "artifacts", "result.txt"), "adapter evidence\n");
      git(body.work_dir, "config", "user.name", "Adapter Test");
      git(body.work_dir, "config", "user.email", "adapter@example.invalid");
      git(body.work_dir, "add", "artifacts/result.txt");
      git(body.work_dir, "commit", "-m", "adapter result");
      snapshot = {
        run_id: "remote-adapter",
        request_id: body.request_id,
        binding: "project",
        project: "repo",
        work_dir: body.work_dir,
        status: "completed",
        workers: [
          {
            identity_id: "executor",
            provider: "codex",
            status: "completed",
            session_id: "native-adapter",
            final_output: finalOutput,
            usage: { input_tokens: 5, output_tokens: 2 },
          },
        ],
      };
      return send(202, snapshot);
    }
    if (url.pathname.startsWith("/agents/requests/") && snapshot)
      return send(200, { request_id: snapshot.request_id, run_id: snapshot.run_id, state: "resolved", run: snapshot });
    return send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const clientFile = path.join(root, "adapter-client.json");
  writeFileSync(
    clientFile,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      capability: "adapter-capability",
    }),
  );
  repo.turn.command = ["--project", "repo", "--identity", "executor", "--client-file", clientFile];
  repo.turn.effort = "high";
  prepareTurn(repo.turn);
  const reading = await observeTurn(repo.turn);
  assert.equal(reading.finished, true);
  assert.equal(reading.session, "native-adapter");
  assert.equal(reading.stage?.execution_id, repo.turn.stage!.execution_id);
  assert.equal(reading.stage?.request_id.length! > 0, true);
  assert.equal(reading.stage?.remote_run_id, "remote-adapter");
  assert.equal(reading.stage?.binding?.binding_id, "binding-adapter");
  assert.equal(reading.result?.stage?.verdict, "implemented");
  assert.equal(reading.result?.stage?.checks[0]?.exit_code, 0);
  assert.equal(reading.result?.stage?.artifacts[0]?.sha256.length, 64);
});

test("terminal strict-resume mismatch keeps accepted native session A out of rejected worker session B", async (t) => {
  const repo = fixture("resume-mismatch");
  repo.turn.resume = "native-A";
  repo.turn.session = "native-A";
  let posts = 0;
  let requestId = "";
  let workDir = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== "Bearer mismatch-capability") return send(403, { error: "bad capability" });
    if (url.searchParams.get("project") !== "repo") return send(403, { error: "bad project" });
    if (url.pathname === "/agents/project-binding") {
      return send(200, {
        installation_id: "installation-mismatch",
        binding_id: "binding-mismatch",
        project: "repo",
        chat_id: "chat-mismatch",
        work_dir: path.resolve(repo.cwd),
      });
    }
    if (url.pathname === "/agents/identities") {
      return send(200, { identities: [{ id: "executor", status: "ready", supported_efforts: ["high"] }] });
    }
    if (request.method === "POST" && url.pathname === "/agents/runs") {
      posts++;
      assert.equal(body.session_id, "native-A");
      requestId = body.request_id;
      workDir = body.work_dir;
      return send(202, {
        run_id: "remote-mismatch",
        request_id: requestId,
        binding: "project",
        project: "repo",
        work_dir: workDir,
        status: "running",
        workers: [{ identity_id: "executor", provider: "codex", status: "running", session_id: "native-A" }],
      });
    }
    if (request.method === "GET" && url.pathname === `/agents/requests/${requestId}`) {
      return send(200, {
        request_id: requestId,
        run_id: "remote-mismatch",
        state: "resolved",
        run: {
          run_id: "remote-mismatch",
          request_id: requestId,
          binding: "project",
          project: "repo",
          work_dir: workDir,
          status: "failed",
          error: "native resume returned another session",
          workers: [
            {
              identity_id: "executor",
              provider: "codex",
              status: "failed",
              session_id: "native-B",
              error: "native resume returned session B",
            },
          ],
        },
      });
    }
    return send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const clientFile = path.join(root, "mismatch-client.json");
  writeFileSync(
    clientFile,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      capability: "mismatch-capability",
    }),
  );
  repo.turn.command = ["--project", "repo", "--identity", "executor", "--client-file", clientFile];
  repo.turn.effort = "high";
  prepareTurn(repo.turn);
  const started = await observeTurn(repo.turn);
  assert.equal(started.pending, true);
  assert.equal(started.session, "native-A");
  const failed = await observeTurn(repo.turn);
  assert.equal(failed.result?.stage?.verdict, "execution_failed");
  assert.equal(failed.result?.session, "native-A");
  assert.notEqual(failed.result?.session, "native-B");
  assert.match(failed.result?.stage?.diagnostics?.[0] ?? "", /不同|恢复|会话/);
  assert.equal(posts, 1, "strict resume mismatch never starts a fresh call");
});

async function completedAdapter(t: TestContext, name: string, configure?: (repo: ReturnType<typeof fixture>) => void) {
  const repo = fixture(name);
  configure?.(repo);
  const counter = path.join(root, `${name}-checks.txt`);
  repo.turn.stage!.checks[0]!.argv = [
    process.execPath,
    "-e",
    `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'check\\n')`,
  ];
  repo.turn.stage!.workflow.stages.execute!.checks = repo.turn.stage!.checks;
  const finalOutput = message({
    verdict: "implemented",
    summary: "original measured result",
    artifacts: repo.turn.stage!.workflow.stages.execute!.mode === "inspect" ? [] : ["artifacts/result.txt"],
    findings: [{ severity: "info", summary: "original finding" }],
  });
  let posts = 0;
  let run: any;
  const mode = {
    requestState: "resolved",
    postStatus: 0,
    missingRequest: false,
    snapshotStatus: "completed",
    provider: "codex",
    catalogProvider: "codex" as string | undefined,
    durableRunId: undefined as string | null | undefined,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/agents/project-binding") {
      return send(200, {
        installation_id: "installation-recovery",
        binding_id: "binding-recovery",
        project: "repo",
        chat_id: "chat-recovery",
        work_dir: repo.cwd,
      });
    }
    if (url.pathname === "/agents/identities")
      return send(200, { identities: [{ id: "executor", status: "ready", provider: mode.catalogProvider }] });
    if (request.method === "POST" && url.pathname === "/agents/runs") {
      posts++;
      assert.equal(posts, 1, "recovery must not start the model twice");
      if (repo.turn.stage!.workflow.stages.execute!.mode === "write") {
        mkdirSync(path.join(body.work_dir, "artifacts"));
        writeFileSync(path.join(body.work_dir, "artifacts", "result.txt"), "original committed evidence\n");
        git(body.work_dir, "config", "user.name", "Adapter Test");
        git(body.work_dir, "config", "user.email", "adapter@example.invalid");
        git(body.work_dir, "add", "artifacts/result.txt");
        git(body.work_dir, "commit", "-m", "original result");
      }
      run = {
        run_id: `remote-${name}`,
        request_id: body.request_id,
        binding: "project",
        project: "repo",
        work_dir: body.work_dir,
        status: mode.snapshotStatus,
        workers: [
          {
            identity_id: "executor",
            status: mode.snapshotStatus,
            provider: mode.provider,
            session_id: `native-${name}`,
            final_output: finalOutput,
          },
        ],
      };
      return mode.postStatus ? send(mode.postStatus, { error: "admission uncertain" }) : send(202, run);
    }
    if (url.pathname === `/agents/requests/${repo.turn.stage!.execution_id}` && run) {
      run.status = mode.snapshotStatus;
      run.workers[0].status = mode.snapshotStatus;
      run.workers[0].provider = mode.provider;
      return mode.missingRequest
        ? send(404, { error: "unavailable" })
        : send(200, {
            request_id: run.request_id,
            run_id: mode.durableRunId === undefined ? run.run_id : mode.durableRunId,
            state: mode.requestState,
            run,
          });
    }
    if (url.pathname === `/agents/requests/${repo.turn.stage!.execution_id}` && request.method === "DELETE")
      return send(200, { request_id: repo.turn.stage!.execution_id, run_id: null, state: "cancelled" });
    return send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const clientFile = path.join(root, `${name}-client.json`);
  writeFileSync(
    clientFile,
    JSON.stringify({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, capability: "fake" }),
  );
  repo.turn.command = ["--project", "repo", "--identity", "executor", "--client-file", clientFile];
  prepareTurn(repo.turn);
  const journalPath = path.join(repo.turn.folder, "lodestar-journal.json");
  return {
    ...repo,
    counter,
    journalPath,
    mode,
    journal: () => JSON.parse(readFileSync(journalPath, "utf8")),
    posts: () => posts,
  };
}

test("published stage recovery replays the canonical prepared receipt without model or check execution", async (t) => {
  const repo = await completedAdapter(t, "prepared-replay");
  const first = await observeTurn(repo.turn);
  assert.equal(first.result?.stage?.verdict, "implemented");
  const journal = repo.journal();
  delete journal.reading;
  writeFileSync(repo.journalPath, JSON.stringify(journal));
  const recovered = await observeTurn(repo.turn);
  assert.deepEqual(recovered.result, first.result);
  assert.equal(repo.posts(), 1);
  assert.equal(readFileSync(repo.counter, "utf8"), "check\n");
  assert.deepEqual(repo.journal().prepared.result, first.result);
  const recorded = repo.journal();
  delete recorded.prepared;
  delete recorded.termination;
  writeFileSync(repo.journalPath, JSON.stringify(recorded));
  assert.deepEqual(
    (await observeTurn(repo.turn)).result,
    first.result,
    "an intact legacy canonical receipt is reused after verifying durable termination",
  );
  assert.equal(readFileSync(repo.counter, "utf8"), "check\n");
  const legacy = repo.journal();
  delete legacy.prepared;
  delete legacy.reading;
  writeFileSync(repo.journalPath, JSON.stringify(legacy));
  assert.equal(
    (await observeTurn(repo.turn)).result?.stage?.verdict,
    "execution_failed",
    "refs alone cannot reconstruct missing historical receipt evidence",
  );
});

async function faultObserver(repo: Awaited<ReturnType<typeof completedAdapter>>, fault: string) {
  const script = path.join(root, `${fault}-${path.basename(repo.cwd)}.mjs`);
  writeFileSync(
    script,
    `
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const journalFile = ${JSON.stringify(repo.journalPath)};
const fault = ${JSON.stringify(fault)};
const kill = () => process.kill(process.pid, 'SIGKILL');
const spawnSync = cp.spawnSync;
let loseReadback = false;
cp.spawnSync = function(command, args, options) {
  if (loseReadback && args.includes('ls-remote')) return { status: 1, stdout: '', stderr: 'offline' };
  const record = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : {};
  const outputPush = args.includes('push') && record.prepared;
  const immutable = outputPush && args.at(-1).endsWith(':' + record.stage.executionRef);
  const cas = outputPush && args.at(-1).endsWith(':' + record.stage.taskRef);
  if (immutable && fault === 'immutable-before' || cas && fault === 'cas-before') kill();
  if (outputPush && !record.prepared.result) throw new Error('ref write before canonical receipt');
  const value = spawnSync.call(this, command, args, options);
  if (immutable && fault === 'immutable-after' || cas && fault === 'cas-after') kill();
  if (cas && fault === 'readback-loss') loseReadback = true;
  return value;
};
const renameSync = fs.renameSync;
fs.renameSync = function(source, target) {
  const record = target === journalFile ? JSON.parse(fs.readFileSync(source, 'utf8')) : {};
  if (record.prepared && !record.reading && fault === 'prepare-write-failure') throw new Error('prepared fsync failure');
  if (record.reading && fault === 'reading-before') kill();
  const value = renameSync.call(this, source, target);
  if (record.stage && !record.attempted && fault === 'pin-after') kill();
  if (record.prepared && !record.reading && fault === 'prepared-after') kill();
  if (record.reading && fault === 'reading-after') kill();
  return value;
};
syncBuiltinESMExports();
const { observeTurn } = await import(${JSON.stringify(new URL("../plugins/lodestar/run.ts", import.meta.url).href)});
const turn = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(repo.turn.folder, "lodestar-turn.json"))}, 'utf8'));
console.log(JSON.stringify(await observeTurn(turn)));
`,
  );
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const ended = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  clearTimeout(timeout);
  return { ...ended, stdout, stderr };
}

test("SIGKILL around prepared, immutable, CAS and reading writes preserves the same receipt and check count", async (t) => {
  for (const fault of [
    "prepared-after",
    "immutable-before",
    "immutable-after",
    "cas-before",
    "cas-after",
    "reading-before",
    "reading-after",
  ]) {
    const repo = await completedAdapter(t, `kill-${fault}`);
    const child = await faultObserver(repo, fault);
    assert.equal(child.signal, "SIGKILL", `${fault}: ${child.stderr}`);
    const prepared = repo.journal().prepared;
    assert.ok(prepared?.result, `durable preparation missing at ${fault}`);
    const recovered = await observeTurn(repo.turn);
    assert.equal(recovered.result?.stage?.verdict, "implemented", fault);
    assert.deepEqual(recovered.result, prepared.result, fault);
    assert.equal(repo.posts(), 1, fault);
    assert.equal(readFileSync(repo.counter, "utf8"), "check\n", fault);
  }
});

test("failed prepared persistence writes no output refs and lost post-CAS readback stays pending", async (t) => {
  const failed = await completedAdapter(t, "prepare-failure");
  const first = await faultObserver(failed, "prepare-write-failure");
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).pending, true);
  const journal = failed.journal();
  assert.equal(journal.prepared, undefined);
  assert.equal(git(failed.cwd, "ls-remote", failed.remote, journal.stage.executionRef), "");
  assert.equal(git(failed.cwd, "ls-remote", failed.remote, journal.stage.taskRef).split(/\s+/)[0], failed.base);
  const lost = await completedAdapter(t, "readback-loss");
  const uncertain = await faultObserver(lost, "readback-loss");
  assert.equal(uncertain.code, 0, uncertain.stderr);
  assert.equal(JSON.parse(uncertain.stdout).pending, true);
  assert.equal(JSON.parse(uncertain.stdout).stage.remote_state, "unknown");
  assert.equal(lost.journal().reading, undefined);
  const recovered = await observeTurn(lost.turn);
  assert.deepEqual(recovered.result, lost.journal().prepared.result);
  assert.equal(readFileSync(lost.counter, "utf8"), "check\n");
  assert.equal(lost.posts(), 1);
});

test("foreign refs, altered prepared bindings and a matching HEAD alone never prove publication", async (t) => {
  for (const conflict of ["immutable", "task", "head-only", "workspace", "result", "request"]) {
    const repo = await completedAdapter(t, `conflict-${conflict}`);
    await faultObserver(repo, "prepared-after");
    const journal = repo.journal();
    const workspace = journal.stage;
    if (conflict === "immutable") git(repo.cwd, "push", repo.remote, `${repo.base}:${workspace.executionRef}`);
    if (conflict === "head-only") git(workspace.workDir, "push", repo.remote, `HEAD:${workspace.taskRef}`);
    if (conflict === "task") {
      writeFileSync(path.join(repo.source, "foreign.txt"), "foreign");
      git(repo.source, "add", "foreign.txt");
      git(repo.source, "commit", "-m", "foreign");
      git(repo.source, "push", repo.remote, `HEAD:${workspace.taskRef}`);
    }
    if (conflict === "workspace") {
      journal.prepared.workspace.workDir = repo.cwd;
      journal.stage.workDir = repo.cwd;
      journal.body.work_dir = repo.cwd;
    }
    if (conflict === "result") journal.prepared.result.summary = "changed after verification";
    if (conflict === "request") journal.prepared.request_id = "another-request";
    if (["workspace", "request"].includes(conflict)) {
      const { digest, ...record } = journal.prepared;
      void digest;
      journal.prepared.digest = createHash("sha256").update(JSON.stringify(record)).digest("hex");
    }
    writeFileSync(repo.journalPath, JSON.stringify(journal));
    const observed = await observeTurn(repo.turn);
    assert.equal(observed.result?.stage?.verdict, "execution_failed", conflict);
    assert.equal(repo.posts(), 1, conflict);
    assert.equal(readFileSync(repo.counter, "utf8"), "check\n", conflict);
  }
});

test("cancel after durable preparation fences unstarted CAS but preserves an already published result", async (t) => {
  for (const fault of ["prepared-after", "immutable-after", "cas-after"]) {
    const repo = await completedAdapter(t, `cancel-${fault}`);
    await faultObserver(repo, fault);
    const original = repo.journal().prepared.result;
    const recovered = await observeTurn(repo.turn, true);
    assert.deepEqual(recovered.result, original);
    const journal = repo.journal();
    const expected = fault === "cas-after" ? original.stage.output_revision : repo.base;
    assert.equal(git(repo.cwd, "ls-remote", repo.remote, journal.stage.taskRef).split(/\s+/)[0], expected);
    assert.equal(journal.prepared.publication, fault === "cas-after" ? "advance" : "late");
    assert.equal(readFileSync(repo.counter, "utf8"), "check\n");
  }
});

test("recheck pin survives observer death and never resamples a changed task ref before admission", async (t) => {
  for (const moved of [false, true]) {
    let initial: ReturnType<typeof prepareStageWorkspace>;
    const repo = await completedAdapter(t, `pin-restart-${moved}`, (repo) => {
      initial = prepareStageWorkspace(repo.turn);
      repo.turn.stage!.input_resolution = "task_ref";
      repo.turn.stage!.execution_id += "-recheck";
      repo.turn.stage!.generation = 2;
      repo.turn.stage!.route.name = "reviewer";
      repo.turn.stage!.workflow.stages.execute!.route = "reviewer";
      repo.turn.stage!.workflow.stages.execute!.mode = "inspect";
    });
    assert.equal((await faultObserver(repo, "pin-after")).signal, "SIGKILL");
    const pinned = repo.journal().stage;
    assert.equal(pinned.inputRevision, repo.base);
    assert.equal(pinned.inputRef, initial!.taskRef);
    if (moved) {
      writeFileSync(path.join(repo.source, "new.txt"), "new");
      git(repo.source, "add", "new.txt");
      git(repo.source, "commit", "-m", "new external revision");
      git(repo.source, "push", repo.remote, `HEAD:${pinned.taskRef}`);
    }
    const result = await observeTurn(repo.turn);
    assert.equal(result.stage?.input_revision, repo.base);
    assert.equal(result.result?.stage?.input_revision, repo.base);
    assert.equal(result.result?.stage?.verdict, moved ? "execution_failed" : "implemented");
    assert.equal(repo.posts(), moved ? 0 : 1);
    assert.equal(repo.journal().stage.inputRevision, repo.base);
  }
});

test("missing recheck ref is a pure pre-admission failure without a fabricated pin or native session", async (t) => {
  const repo = await completedAdapter(t, "missing-recheck", (repo) => {
    repo.turn.stage!.input_resolution = "task_ref";
    repo.turn.resume = "prior-review-session";
  });
  const failed = await observeTurn(repo.turn);
  assert.equal(failed.result?.stage?.verdict, "execution_failed");
  assert.equal(failed.stage, undefined, "worker must not report started before a pin exists");
  assert.equal(failed.session, undefined);
  assert.equal(failed.result?.session, undefined);
  for (const key of ["input_revision", "output_revision", "remote_ref", "remote_run_id"])
    assert.equal((failed.result!.stage as any)[key], undefined, key);
  assert.deepEqual(failed.result?.stage?.checks, []);
  assert.deepEqual(failed.result?.stage?.artifacts, []);
  assert.equal(repo.posts(), 0);
  const cancelled = await completedAdapter(t, "missing-recheck-cancel", (repo) => {
    repo.turn.stage!.input_resolution = "task_ref";
  });
  const stopped = await observeTurn(cancelled.turn, true);
  assert.equal(stopped.result?.outcome, "cancelled");
  assert.equal(stopped.stage, undefined);
  assert.equal(cancelled.journal().stage, undefined);
  assert.equal(cancelled.posts(), 0);
});

test("stage terminal snapshots and transport loss preserve pinned input, binding and unknown state", async (t) => {
  for (const postStatus of [0, 409, 503]) {
    const repo = await completedAdapter(t, `stage-unknown-${postStatus}`);
    repo.mode.requestState = "admitted";
    repo.mode.postStatus = postStatus;
    const uncertain = await observeTurn(repo.turn);
    assert.equal(uncertain.pending, true);
    assert.equal(uncertain.stage?.remote_state, "unknown");
    assert.equal(uncertain.stage?.input_revision, repo.base);
    assert.equal(uncertain.stage?.binding?.binding_id, "binding-recovery");
    assert.equal(uncertain.stage?.remote_run_id, `remote-stage-unknown-${postStatus}`);
    assert.equal(uncertain.session, `native-stage-unknown-${postStatus}`);
    assert.equal(repo.journal().prepared, undefined);
    assert.equal(existsSync(repo.counter), false);
    repo.mode.missingRequest = true;
    const missing = await observeTurn(repo.turn);
    assert.equal(missing.stage?.remote_state, "unknown");
    assert.equal(missing.session, uncertain.session);
    repo.mode.missingRequest = false;
    repo.mode.requestState = "resolved";
    assert.equal((await observeTurn(repo.turn)).result?.stage?.verdict, "implemented");
    assert.equal(repo.posts(), 1);
  }
});

test("workspace mismatch after attempted admission cannot finish an unconfirmed native execution", async (t) => {
  const repo = await completedAdapter(t, "workspace-live");
  repo.mode.requestState = "admitted";
  assert.equal((await observeTurn(repo.turn)).pending, true);
  const journal = repo.journal();
  const original = structuredClone(journal.stage);
  journal.stage.workDir = repo.cwd;
  writeFileSync(repo.journalPath, JSON.stringify(journal));
  const uncertain = await observeTurn(repo.turn);
  assert.equal(uncertain.pending, true);
  assert.equal(uncertain.finished, undefined);
  assert.equal(uncertain.stage?.remote_state, "unknown");
  assert.equal(existsSync(repo.counter), false);
  const repaired = repo.journal();
  repaired.stage = original;
  writeFileSync(repo.journalPath, JSON.stringify(repaired));
  repo.mode.requestState = "resolved";
  assert.equal((await observeTurn(repo.turn)).result?.stage?.verdict, "implemented");
  assert.equal(repo.posts(), 1);
});

test("known running to unknown and prepared completion preserve the exact durable provider binding", async (t) => {
  const repo = await completedAdapter(t, "provider-known-unknown");
  repo.mode.requestState = "admitted";
  repo.mode.snapshotStatus = "running";
  const running = await observeTurn(repo.turn);
  assert.equal(running.stage?.binding?.provider, "codex");
  repo.mode.snapshotStatus = "failed";
  prepareTurn(repo.turn);
  const unknown = await observeTurn(repo.turn);
  assert.equal(unknown.stage?.remote_state, "unknown");
  assert.deepEqual(unknown.stage?.binding, running.stage?.binding);
  repo.mode.missingRequest = true;
  assert.deepEqual((await observeTurn(repo.turn)).stage?.binding, running.stage?.binding);
  repo.mode.missingRequest = false;
  repo.mode.snapshotStatus = "completed";
  repo.mode.requestState = "resolved";
  const completed = await observeTurn(repo.turn);
  assert.equal(completed.result?.stage?.verdict, "implemented");
  assert.deepEqual(completed.stage?.binding, running.stage?.binding);
  assert.equal(repo.posts(), 1);
});

test("initial post-admission 503 unknown and later running keep the same catalog provider across restart", async (t) => {
  const repo = await completedAdapter(t, "provider-unknown-known");
  repo.mode.postStatus = 503;
  repo.mode.snapshotStatus = "running";
  repo.mode.requestState = "pending";
  repo.mode.durableRunId = null;
  const unknown = await observeTurn(repo.turn);
  assert.equal(unknown.stage?.remote_state, "unknown");
  assert.equal(unknown.stage?.binding?.provider, "codex");
  assert.equal(repo.journal().provider, "codex", "provider must be durable before admission response can fail");
  prepareTurn(repo.turn);
  repo.mode.requestState = "admitted";
  repo.mode.durableRunId = undefined;
  const running = await observeTurn(repo.turn);
  assert.equal(running.stage?.remote_state, "running");
  assert.deepEqual(running.stage?.binding, unknown.stage?.binding);
  repo.mode.snapshotStatus = "completed";
  repo.mode.requestState = "resolved";
  assert.deepEqual((await observeTurn(repo.turn)).stage?.binding, unknown.stage?.binding);
  assert.equal(repo.posts(), 1);
});

test("a snapshot provider conflict never changes the admitted binding and waits for native termination", async (t) => {
  const repo = await completedAdapter(t, "provider-conflict");
  repo.mode.snapshotStatus = "running";
  repo.mode.requestState = "admitted";
  const running = await observeTurn(repo.turn);
  repo.mode.provider = "claude";
  const unknown = await observeTurn(repo.turn);
  assert.equal(unknown.stage?.remote_state, "unknown");
  assert.equal(unknown.finished, undefined);
  assert.deepEqual(unknown.stage?.binding, running.stage?.binding);
  repo.mode.snapshotStatus = "completed";
  repo.mode.requestState = "resolved";
  const failed = await observeTurn(repo.turn);
  assert.equal(failed.result?.stage?.verdict, "execution_failed");
  assert.deepEqual(failed.stage?.binding, running.stage?.binding);
  assert.equal(repo.posts(), 1);
});

test("missing catalog provider stays absent and an old durable reading preserves only its recorded provider", async (t) => {
  const repo = await completedAdapter(t, "provider-absent");
  repo.mode.catalogProvider = undefined;
  repo.mode.postStatus = 503;
  repo.mode.missingRequest = true;
  repo.mode.snapshotStatus = "running";
  repo.mode.requestState = "admitted";
  const unknown = await observeTurn(repo.turn);
  assert.equal(unknown.stage?.binding?.provider, undefined);
  repo.mode.missingRequest = false;
  prepareTurn(repo.turn);
  const running = await observeTurn(repo.turn);
  assert.deepEqual(running.stage?.binding, unknown.stage?.binding);
  assert.equal(repo.journal().provider, undefined, "a later snapshot cannot fill an already reported binding");
  const legacy = await completedAdapter(t, "provider-legacy");
  const completed = await observeTurn(legacy.turn);
  const journal = legacy.journal();
  delete journal.provider;
  writeFileSync(legacy.journalPath, JSON.stringify(journal));
  const recovered = await observeTurn(legacy.turn, true);
  assert.deepEqual(recovered.stage?.binding, completed.stage?.binding);
  assert.equal(legacy.journal().provider, "codex");
});
