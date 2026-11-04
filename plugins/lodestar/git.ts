// Git is measured locally from trusted stage policy. Model prose never supplies revisions, refs, commands, or paths.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { StageArtifact } from "../../protocol/project-tasks.ts";
import type { Turn } from "../../worker/agents.ts";

const OID = /^[0-9a-f]{40,64}$/;
const FULL_REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export class GitStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitStageError";
  }
}

export class GitStageUncertainError extends GitStageError {
  constructor(message: string) {
    super(message);
    this.name = "GitStageUncertainError";
  }
}

export type StageWorkspace = {
  workDir: string;
  projectRoot: string;
  remote: string;
  inputRevision: string;
  inputRef: string;
  taskRef: string;
  executionRef: string;
  mode: "write" | "inspect";
  artifactPaths: string[];
};

export type StageGitEvidence = {
  inputRevision: string;
  outputRevision: string;
  remoteRef: string;
  artifacts: StageArtifact[];
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function git(cwd: string, args: string[], label: string, encoding: BufferEncoding | "buffer" = "utf8") {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      encoding: encoding === "buffer" ? null : encoding,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 60_000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new GitStageError(label);
  }
}

function gitText(cwd: string, args: string[], label: string) {
  return String(git(cwd, args, label)).trim();
}

function tryGit(cwd: string, args: string[]) {
  return spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function remoteOid(remote: string, ref: string): string | null {
  if (!FULL_REF.test(ref)) throw new GitStageError("trusted Git ref is invalid");
  const result = tryGit(process.cwd(), ["ls-remote", "--refs", remote, ref]);
  if (result.status !== 0) throw new GitStageError("unable to inspect trusted remote ref");
  const rows = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/, 2));
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0]?.[1] !== ref || !OID.test(rows[0][0]!)) {
    throw new GitStageError("trusted remote ref is ambiguous or invalid");
  }
  return rows[0][0]!;
}

function clean(workDir: string) {
  const status = gitText(
    workDir,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "unable to inspect stage workspace",
  );
  if (status) throw new GitStageError("stage workspace is dirty; preserved without reset or clean");
}

function head(workDir: string) {
  const value = gitText(workDir, ["rev-parse", "HEAD"], "unable to read stage HEAD");
  if (!OID.test(value)) throw new GitStageError("stage HEAD is invalid");
  return value;
}

function taskRefFor(prefix: string, taskId: string) {
  if (!FULL_REF.test(`${prefix}probe`) || !prefix.endsWith("/"))
    throw new GitStageError("trusted task_ref_prefix is invalid");
  return `${prefix}${digest(taskId).slice(0, 40)}`;
}

function executionRefFor(executionId: string) {
  return `refs/agent-autoloop/executions/${digest(executionId)}`;
}

function inputRefFor(turn: Turn) {
  const stage = turn.stage!;
  if (stage.input_resolution === "task_ref") return taskRefFor(stage.git.task_ref_prefix, stage.task_id);
  return stage.input_revision === null ? stage.git.base_ref : previousRemoteRef(turn, stage.input_revision);
}

export function validateStageWorkspace(turn: Turn, workspace: StageWorkspace) {
  const stage = turn.stage!;
  const configured = stage.workflow.stages[stage.stage_id];
  const root = realpathSync(turn.cwd);
  const gitDir = gitText(root, ["rev-parse", "--absolute-git-dir"], "trusted project is not a Git repository");
  const expectedDir = path.join(
    gitDir,
    "agent-autoloop-workspaces",
    digest(`${stage.task_id}\0${stage.route.name}\0${configured?.mode}`),
  );
  if (
    !configured ||
    configured.route !== stage.route.name ||
    root !== realpathSync(stage.route.cwd) ||
    workspace.projectRoot !== root ||
    workspace.workDir !== expectedDir ||
    realpathSync(workspace.workDir) !== expectedDir ||
    workspace.remote !== stage.git.remote ||
    workspace.mode !== configured.mode ||
    workspace.taskRef !== taskRefFor(stage.git.task_ref_prefix, stage.task_id) ||
    workspace.executionRef !== executionRefFor(stage.execution_id) ||
    !OID.test(workspace.inputRevision) ||
    (stage.input_revision !== null && workspace.inputRevision !== stage.input_revision) ||
    workspace.inputRef !== inputRefFor(turn) ||
    JSON.stringify(workspace.artifactPaths) !== JSON.stringify(stage.git.artifact_paths) ||
    gitText(workspace.workDir, ["remote", "get-url", "origin"], "private stage clone has no origin") !==
      workspace.remote
  )
    throw new GitStageError("persisted stage workspace does not match the trusted turn");
}

function push(workDir: string, remote: string, args: string[]) {
  return tryGit(workDir, ["push", remote, ...args]);
}

function publishImmutable(workspace: StageWorkspace, revision: string) {
  const existing = remoteOid(workspace.remote, workspace.executionRef);
  if (existing) {
    if (existing !== revision) throw new GitStageError("immutable execution ref already points at another revision");
    return;
  }
  const result = push(workspace.workDir, workspace.remote, [
    `--force-with-lease=${workspace.executionRef}:`,
    `${revision}:${workspace.executionRef}`,
  ]);
  const observed = remoteOid(workspace.remote, workspace.executionRef);
  if (observed === revision) return;
  if (observed) throw new GitStageError("immutable execution ref changed unexpectedly");
  void result;
  throw new GitStageUncertainError("immutable ref publication is uncertain");
}

function compareAndSwapTask(workspace: StageWorkspace, revision: string) {
  const before = remoteOid(workspace.remote, workspace.taskRef);
  if (before === revision) return;
  if (before !== workspace.inputRevision) throw new GitStageError("task ref changed since this stage was admitted");
  const result = push(workspace.workDir, workspace.remote, [
    `--force-with-lease=${workspace.taskRef}:${workspace.inputRevision}`,
    `${revision}:${workspace.taskRef}`,
  ]);
  const observed = remoteOid(workspace.remote, workspace.taskRef);
  if (observed === revision) return;
  if (observed !== workspace.inputRevision) throw new GitStageError("task ref changed while publishing this stage");
  void result;
  throw new GitStageUncertainError("task ref publication is uncertain");
}

function initializeTaskRef(workspace: StageWorkspace) {
  const current = remoteOid(workspace.remote, workspace.taskRef);
  if (current === workspace.inputRevision) return;
  if (current) throw new GitStageError("task ref does not match the admitted input revision");
  const result = push(workspace.workDir, workspace.remote, [
    `--force-with-lease=${workspace.taskRef}:`,
    `${workspace.inputRevision}:${workspace.taskRef}`,
  ]);
  const observed = remoteOid(workspace.remote, workspace.taskRef);
  if (observed === workspace.inputRevision) return;
  if (observed) throw new GitStageError("task ref was initialized by another execution");
  void result;
  throw new GitStageUncertainError("task ref initialization is uncertain");
}

function previousRemoteRef(turn: Turn, inputRevision: string) {
  const matches = turn.stage!.evidence.filter(
    (item) =>
      item.output_revision === inputRevision &&
      typeof item.remote_ref === "string" &&
      item.remote_ref.startsWith("refs/agent-autoloop/executions/"),
  );
  const ref = matches.at(-1)?.remote_ref;
  if (!ref || !FULL_REF.test(ref)) throw new GitStageError("previous immutable remote ref is missing");
  return ref;
}

export function prepareStageWorkspace(turn: Turn): StageWorkspace {
  const stage = turn.stage;
  if (!stage) throw new GitStageError("stage metadata is required for Git transport");
  const configured = stage.workflow.stages[stage.stage_id];
  if (!configured || configured.route !== stage.route.name)
    throw new GitStageError("stage route snapshot is inconsistent");
  const projectRoot = realpathSync(turn.cwd);
  if (realpathSync(stage.route.cwd) !== projectRoot)
    throw new GitStageError("stage cwd no longer matches its trusted route");
  const gitDir = gitText(projectRoot, ["rev-parse", "--absolute-git-dir"], "trusted project is not a Git repository");
  const privateRoot = path.join(gitDir, "agent-autoloop-workspaces");
  const workDir = path.join(privateRoot, digest(`${stage.task_id}\0${stage.route.name}\0${configured.mode}`));
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  if (!existsSync(workDir)) {
    git(
      projectRoot,
      ["clone", "--no-checkout", "--origin", "origin", "--", stage.git.remote, workDir],
      "unable to create private stage clone",
    );
    gitText(workDir, ["config", "core.hooksPath", "/dev/null"], "unable to disable stage hooks");
  } else {
    if (!statSync(workDir).isDirectory()) throw new GitStageError("private stage workspace is not a directory");
    const origin = gitText(workDir, ["remote", "get-url", "origin"], "private stage clone has no origin");
    if (origin !== stage.git.remote)
      throw new GitStageError("private stage clone remote does not match trusted policy");
    clean(workDir);
  }

  const taskRef = taskRefFor(stage.git.task_ref_prefix, stage.task_id);
  const sourceRef = inputRefFor(turn);
  const expected = stage.input_revision ?? remoteOid(stage.git.remote, sourceRef);
  if (!expected || !OID.test(expected)) throw new GitStageError("unable to resolve the admitted input revision");
  if (remoteOid(stage.git.remote, sourceRef) !== expected)
    throw new GitStageError("immutable remote ref does not match input revision");
  gitText(workDir, ["fetch", "--no-tags", "--force", "origin", sourceRef], "unable to fetch admitted revision");
  if (gitText(workDir, ["rev-parse", "FETCH_HEAD"], "unable to inspect fetched revision") !== expected) {
    throw new GitStageError("fetched revision does not match admitted input");
  }
  gitText(workDir, ["checkout", "--detach", expected], "unable to check out admitted revision");
  clean(workDir);
  const workspace: StageWorkspace = {
    workDir,
    projectRoot,
    remote: stage.git.remote,
    inputRevision: expected,
    inputRef: sourceRef,
    taskRef,
    executionRef: executionRefFor(stage.execution_id),
    mode: configured.mode,
    artifactPaths: [...stage.git.artifact_paths],
  };
  if (stage.input_revision === null && stage.input_resolution !== "task_ref") initializeTaskRef(workspace);
  else if (remoteOid(workspace.remote, workspace.taskRef) !== expected) {
    throw new GitStageError("task ref does not match the admitted input revision");
  }
  return workspace;
}

function assertWorkspace(workspace: StageWorkspace) {
  clean(workspace.workDir);
  if (remoteOid(workspace.remote, workspace.taskRef) !== workspace.inputRevision) {
    throw new GitStageError("task ref changed since this stage was admitted");
  }
}

export function stageRevision(workspace: StageWorkspace) {
  assertWorkspace(workspace);
  const revision = head(workspace.workDir);
  if (workspace.mode === "inspect" && revision !== workspace.inputRevision) {
    throw new GitStageError("inspect stage changed HEAD");
  }
  if (workspace.mode === "write") {
    const ancestor = tryGit(workspace.workDir, ["merge-base", "--is-ancestor", workspace.inputRevision, revision]);
    if (ancestor.status !== 0) throw new GitStageError("stage output is not descended from its admitted input");
  }
  return revision;
}

function artifactPath(workspace: StageWorkspace, relativePath: string) {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    relativePath.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new GitStageError("artifact path must be a safe relative path");
  }
  if (!workspace.artifactPaths.includes(relativePath))
    throw new GitStageError("artifact path is not allowed by trusted policy");
  let current = workspace.workDir;
  for (const part of relativePath.split("/")) {
    current = path.join(current, part);
    if (!existsSync(current)) throw new GitStageError("declared artifact does not exist");
    if (lstatSync(current).isSymbolicLink()) throw new GitStageError("artifact path cannot contain symbolic links");
  }
  const resolved = realpathSync(current);
  const within = path.relative(realpathSync(workspace.workDir), resolved);
  if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new GitStageError("artifact escapes the private stage workspace");
  }
  if (!statSync(resolved).isFile()) throw new GitStageError("artifact must be a regular file");
  return resolved;
}

export function verifyStageArtifact(workspace: StageWorkspace, relativePath: string): StageArtifact {
  const file = artifactPath(workspace, relativePath);
  const revision = head(workspace.workDir);
  const tracked = tryGit(workspace.workDir, ["ls-files", "--error-unmatch", "--", relativePath]);
  if (tracked.status !== 0) throw new GitStageError("artifact is not committed at the measured revision");
  const committed = git(
    workspace.workDir,
    ["show", `${revision}:${relativePath}`],
    "unable to read committed artifact",
    "buffer",
  ) as Buffer;
  const bytes = readFileSync(file);
  if (!bytes.equals(committed)) throw new GitStageError("artifact bytes differ from the committed blob");
  return { path: relativePath, revision, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function verifyInspectStage(workspace: StageWorkspace, artifactPaths: string[]): StageGitEvidence {
  if (workspace.mode !== "inspect") throw new GitStageError("write workspace cannot produce an inspect receipt");
  stageRevision(workspace);
  const artifacts = artifactPaths.map((item) => verifyStageArtifact(workspace, item));
  stageRevision(workspace);
  return {
    inputRevision: workspace.inputRevision,
    outputRevision: workspace.inputRevision,
    remoteRef: workspace.inputRef,
    artifacts,
  };
}

export function publishWriteStage(
  workspace: StageWorkspace,
  artifactPaths: string[],
  options: { advanceTask?: boolean } = {},
): StageGitEvidence {
  if (workspace.mode !== "write") throw new GitStageError("inspect workspace cannot publish writes");
  const revision = stageRevision(workspace);
  const artifacts = artifactPaths.map((item) => verifyStageArtifact(workspace, item));
  const evidence = {
    inputRevision: workspace.inputRevision,
    outputRevision: revision,
    remoteRef: workspace.executionRef,
    artifacts,
  };
  reconcileWriteStage(workspace, evidence, () => options.advanceTask !== false);
  return evidence;
}

// The production caller must durably store the canonical receipt before entering this function.
export function reconcileWriteStage(workspace: StageWorkspace, evidence: StageGitEvidence, advanceTask: () => boolean) {
  if (
    workspace.mode !== "write" ||
    evidence.inputRevision !== workspace.inputRevision ||
    evidence.remoteRef !== workspace.executionRef ||
    !OID.test(evidence.outputRevision)
  ) {
    throw new GitStageError("prepared publication does not match its workspace");
  }
  clean(workspace.workDir);
  const revision = evidence.outputRevision;
  if (
    head(workspace.workDir) !== revision ||
    tryGit(workspace.workDir, ["merge-base", "--is-ancestor", workspace.inputRevision, revision]).status !== 0
  ) {
    throw new GitStageError("prepared output no longer matches its workspace");
  }
  for (const artifact of evidence.artifacts) {
    const verified = verifyStageArtifact(workspace, artifact.path);
    if (JSON.stringify(verified) !== JSON.stringify(artifact))
      throw new GitStageError("prepared artifact no longer matches the measured commit");
  }
  const readRefs = () => {
    try {
      return {
        immutable: remoteOid(workspace.remote, workspace.executionRef),
        task: remoteOid(workspace.remote, workspace.taskRef),
      };
    } catch {
      throw new GitStageUncertainError("prepared publication refs cannot be observed");
    }
  };
  const before = readRefs();
  if (before.immutable !== null && before.immutable !== revision)
    throw new GitStageError("immutable execution ref already points at another revision");
  if (before.task !== workspace.inputRevision && !(before.task === revision && before.immutable === revision))
    throw new GitStageError("task ref changed without this execution's prepared publication");
  if (before.task === revision && before.immutable === revision) return;
  let advance = advanceTask();
  try {
    publishImmutable(workspace, revision);
    // A cancellation arriving while the immutable push was in flight must fence the CAS too.
    advance = advanceTask() && advance;
    if (advance) compareAndSwapTask(workspace, revision);
  } catch (error) {
    if (error instanceof GitStageError && !/unable to inspect trusted remote ref/.test(error.message)) throw error;
    throw new GitStageUncertainError("prepared publication may have written refs; awaiting readback");
  }
  const after = readRefs();
  const expectedTask = advance ? revision : workspace.inputRevision;
  if (after.immutable !== revision || after.task !== expectedTask) {
    if (
      (after.immutable && after.immutable !== revision) ||
      (after.task !== workspace.inputRevision && after.task !== revision)
    )
      throw new GitStageError("published refs were changed by another execution");
    throw new GitStageUncertainError("published refs could not be confirmed");
  }
}
