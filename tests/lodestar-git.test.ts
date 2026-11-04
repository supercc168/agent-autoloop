// Failure modes: two workers inspect different commits, dirty private work is reset, a changed task ref is overwritten,
// hooks execute task code, an escaped/symlink artifact is accepted as cross-machine evidence, or a recheck resamples
// an already pinned task ref or loses its trusted locator after an execution_failed receipt without remote_ref.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  GitStageError,
  prepareStageWorkspace,
  publishWriteStage,
  verifyInspectStage,
  verifyStageArtifact,
} from "../plugins/lodestar/git.ts";
import type { Turn } from "../worker/agents.ts";

const root = mkdtempSync(path.join(tmpdir(), "autoloop-lodestar-git-"));
after(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function fixture(name: string) {
  const source = path.join(root, `${name}-source`);
  const remote = path.join(root, `${name}.git`);
  const writer = path.join(root, `${name}-writer`);
  const reviewer = path.join(root, `${name}-reviewer`);
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Autoloop Test");
  git(source, "config", "user.email", "autoloop@example.invalid");
  writeFileSync(path.join(source, "README.md"), "base\n");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "base");
  git(root, "clone", "--bare", source, remote);
  git(root, "clone", remote, writer);
  git(root, "clone", remote, reviewer);
  for (const clone of [writer, reviewer]) {
    git(clone, "config", "user.name", "Autoloop Test");
    git(clone, "config", "user.email", "autoloop@example.invalid");
  }
  return { source, remote, writer, reviewer, base: git(source, "rev-parse", "HEAD") };
}

function turn(
  cwd: string,
  remote: string,
  options: { mode: "write" | "inspect"; route: string; input: string | null; evidence?: any[]; taskRef?: boolean },
): Turn {
  const stageId = options.mode === "write" ? "execute" : "review";
  return {
    prompt: "stage work",
    session: "native",
    resume: null,
    cwd,
    access: "full",
    contextFile: path.join(cwd, "context.json"),
    folder: path.join(cwd, ".turn"),
    invocation: `invocation-${options.route}`,
    stage: {
      task_id: "task-one",
      execution_id: `execution-${options.route}`,
      generation: 1,
      stage_id: stageId,
      input_revision: options.input,
      ...(options.taskRef ? { input_resolution: "task_ref" as const } : {}),
      workflow: {
        entry: "execute",
        max_transitions: 10,
        stages: {
          [stageId]: { route: options.route, mode: options.mode, max_visits: 2, on: {}, checks: [] },
        },
        git: {
          remote,
          base_ref: "refs/heads/main",
          task_ref_prefix: "refs/heads/autoloop/",
          artifact_paths: ["artifacts/result.txt"],
        },
        human: { options: [] },
      },
      route: { name: options.route, agent_id: "agent", worker: options.route, cwd, access: "full" },
      git: {
        remote,
        base_ref: "refs/heads/main",
        task_ref_prefix: "refs/heads/autoloop/",
        artifact_paths: ["artifacts/result.txt"],
      },
      checks: [],
      evidence: options.evidence ?? [],
    },
  } as Turn;
}

test("writer and reviewer use independent private clones at the exact handed-off commit", () => {
  const repo = fixture("handoff");
  const writer = prepareStageWorkspace(turn(repo.writer, repo.remote, { mode: "write", route: "writer", input: null }));
  assert.equal(writer.inputRevision, repo.base);
  assert.ok(writer.workDir.startsWith(`${realpathSync(path.join(repo.writer, ".git"))}${path.sep}`));
  mkdirSync(path.join(writer.workDir, "artifacts"));
  writeFileSync(path.join(writer.workDir, "artifacts", "result.txt"), "verified bytes\n");
  const hook = path.join(writer.workDir, ".git", "hooks", "pre-commit");
  mkdirSync(path.dirname(hook), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\nexit 99\n");
  chmodSync(hook, 0o755);
  git(writer.workDir, "add", "artifacts/result.txt");
  git(writer.workDir, "commit", "-m", "writer result");
  const published = publishWriteStage(writer, ["artifacts/result.txt"]);
  assert.notEqual(published.outputRevision, repo.base);
  assert.match(published.remoteRef, /^refs\/agent-autoloop\/executions\//);
  assert.equal(published.artifacts[0]?.revision, published.outputRevision);

  const reviewerTurn = turn(repo.reviewer, repo.remote, {
    mode: "inspect",
    route: "reviewer",
    input: published.outputRevision,
    evidence: [
      {
        execution_id: "execution-writer",
        stage_id: "execute",
        generation: 1,
        verdict: "implemented",
        input_revision: repo.base,
        output_revision: published.outputRevision,
        remote_ref: published.remoteRef,
        artifacts: published.artifacts,
        checks: [],
        findings: [],
      },
    ],
  });
  const reviewer = prepareStageWorkspace(reviewerTurn);
  assert.notEqual(reviewer.workDir, writer.workDir);
  assert.equal(readFileSync(path.join(reviewer.workDir, "artifacts", "result.txt"), "utf8"), "verified bytes\n");
  const inspected = verifyInspectStage(reviewer, ["artifacts/result.txt"]);
  assert.equal(inspected.outputRevision, published.outputRevision);
  assert.deepEqual(inspected.artifacts, published.artifacts);
});

test("dirty workspaces, escaped artifacts, wrong immutable refs and changed task refs halt without reset", () => {
  const repo = fixture("guards");
  const firstTurn = turn(repo.writer, repo.remote, { mode: "write", route: "writer", input: null });
  const workspace = prepareStageWorkspace(firstTurn);
  writeFileSync(path.join(workspace.workDir, "untracked.txt"), "preserve me");
  assert.throws(() => prepareStageWorkspace(firstTurn), /dirty|not clean/i);
  assert.equal(readFileSync(path.join(workspace.workDir, "untracked.txt"), "utf8"), "preserve me");
  assert.throws(() => verifyStageArtifact(workspace, "../outside"), /artifact|path|outside/i);

  rmSync(path.join(workspace.workDir, "untracked.txt"));
  mkdirSync(path.join(workspace.workDir, "artifacts"));
  writeFileSync(path.join(workspace.workDir, "artifacts", "result.txt"), "first\n");
  git(workspace.workDir, "add", "artifacts/result.txt");
  git(workspace.workDir, "commit", "-m", "first");
  const originalHead = git(workspace.workDir, "rev-parse", "HEAD");

  writeFileSync(path.join(repo.source, "other.txt"), "other\n");
  git(repo.source, "add", "other.txt");
  git(repo.source, "commit", "-m", "other");
  const other = git(repo.source, "rev-parse", "HEAD");
  git(repo.source, "push", repo.remote, `${other}:${workspace.taskRef}`, "--force");
  assert.throws(() => publishWriteStage(workspace, ["artifacts/result.txt"]), GitStageError);
  assert.equal(git(workspace.workDir, "rev-parse", "HEAD"), originalHead, "the private worktree was preserved");

  const wrong = turn(repo.reviewer, repo.remote, {
    mode: "inspect",
    route: "reviewer",
    input: originalHead,
    evidence: [
      {
        execution_id: "wrong",
        stage_id: "execute",
        generation: 1,
        verdict: "implemented",
        input_revision: repo.base,
        output_revision: originalHead,
        remote_ref: "refs/agent-autoloop/executions/does-not-exist",
        artifacts: [],
        checks: [],
        findings: [],
      },
    ],
  });
  assert.throws(() => prepareStageWorkspace(wrong), /remote ref|immutable|revision/i);
});

test("recheck pins the current task ref and retains its locator through failed retry, verify and rework", () => {
  const repo = fixture("recheck-locator");
  const original = prepareStageWorkspace(
    turn(repo.writer, repo.remote, { mode: "write", route: "writer", input: null }),
  );
  writeFileSync(path.join(original.workDir, "first.txt"), "first");
  git(original.workDir, "add", "first.txt");
  git(original.workDir, "commit", "-m", "first");
  const published = publishWriteStage(original, []);
  writeFileSync(path.join(original.workDir, "external.txt"), "external fast-forward");
  git(original.workDir, "add", "external.txt");
  git(original.workDir, "commit", "-m", "external");
  const current = git(original.workDir, "rev-parse", "HEAD");
  git(original.workDir, "push", repo.remote, `HEAD:${original.taskRef}`);
  const refs = git(repo.source, "ls-remote", "--refs", repo.remote);
  const reviewTurn = turn(repo.reviewer, repo.remote, {
    mode: "inspect",
    route: "reviewer",
    input: null,
    taskRef: true,
  });
  reviewTurn.stage!.generation = 2;
  const review = prepareStageWorkspace(reviewTurn);
  assert.equal(review.inputRevision, current);
  assert.notEqual(review.inputRevision, published.outputRevision);
  assert.equal(review.inputRef, original.taskRef);
  const failure = {
    execution_id: reviewTurn.stage!.execution_id,
    input_revision: current,
    verdict: "execution_failed",
    artifacts: [],
    checks: [],
    findings: [],
  };
  for (const route of ["retry-reviewer", "verify"]) {
    const next = prepareStageWorkspace(
      turn(repo.reviewer, repo.remote, { mode: "inspect", route, input: current, taskRef: true, evidence: [failure] }),
    );
    assert.equal(next.inputRevision, current);
    assert.equal(verifyInspectStage(next, []).remoteRef, original.taskRef);
  }
  assert.equal(git(repo.source, "ls-remote", "--refs", repo.remote), refs, "review and verify never write refs");
  const rework = prepareStageWorkspace(
    turn(repo.writer, repo.remote, {
      mode: "write",
      route: "rework",
      input: current,
      taskRef: true,
      evidence: [failure],
    }),
  );
  assert.equal(rework.inputRef, original.taskRef);
  writeFileSync(path.join(rework.workDir, "rework.txt"), "rework");
  git(rework.workDir, "add", "rework.txt");
  git(rework.workDir, "commit", "-m", "rework");
  const replacement = publishWriteStage(rework, []);
  const next = prepareStageWorkspace(
    turn(repo.reviewer, repo.remote, {
      mode: "inspect",
      route: "after-write",
      input: replacement.outputRevision,
      evidence: [{ output_revision: replacement.outputRevision, remote_ref: replacement.remoteRef }],
    }),
  );
  assert.equal(next.inputRef, replacement.remoteRef);
  assert.equal(
    git(repo.source, "ls-remote", repo.remote, published.remoteRef).split(/\s+/)[0],
    published.outputRevision,
    "old execution evidence is unchanged",
  );
});

test("a pinned task-ref locator rejects movement and an absent recheck ref never falls back or initializes", () => {
  const repo = fixture("recheck-guards");
  const absent = turn(repo.reviewer, repo.remote, { mode: "inspect", route: "missing", input: null, taskRef: true });
  const refs = git(repo.source, "ls-remote", "--refs", repo.remote);
  assert.throws(() => prepareStageWorkspace(absent), /revision|task ref/);
  assert.equal(git(repo.source, "ls-remote", "--refs", repo.remote), refs);
  const writer = prepareStageWorkspace(turn(repo.writer, repo.remote, { mode: "write", route: "writer", input: null }));
  const pinned = turn(repo.reviewer, repo.remote, {
    mode: "inspect",
    route: "pinned",
    input: repo.base,
    taskRef: true,
  });
  assert.equal(prepareStageWorkspace(pinned).inputRevision, repo.base);
  writeFileSync(path.join(writer.workDir, "moved.txt"), "moved");
  git(writer.workDir, "add", "moved.txt");
  git(writer.workDir, "commit", "-m", "moved");
  git(writer.workDir, "push", repo.remote, `HEAD:${writer.taskRef}`);
  assert.throws(() => prepareStageWorkspace(pinned), /revision|ref/);
});
