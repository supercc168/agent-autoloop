// Stage receipts are declarations only. Revisions, checks, refs and artifact hashes are measured by this wrapper.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OperatorResolution, StageCheck, StageFinding, StageResult } from "../../protocol/project-tasks.ts";
import { parseResult, type Result, type Usage } from "../../protocol/validate.ts";
import type { Turn } from "../../worker/agents.ts";
import {
  GitStageError,
  GitStageUncertainError,
  reconcileWriteStage,
  stageRevision,
  verifyInspectStage,
  verifyStageArtifact,
  type StageWorkspace,
} from "./git.ts";

const STAGE_BLOCK = /```agent-autoloop-stage[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
const SAFE_PATH = (value: string) =>
  !path.isAbsolute(value) &&
  !value.includes("\0") &&
  !value.split(/[\\/]/).some((part) => !part || part === "." || part === "..");

export type ModelStageReceipt = {
  verdict: StageResult["verdict"];
  summary: string;
  artifacts: string[];
  findings: StageFinding[];
};

const points = (value: string) => [...value];
const clipped = (value: string, limit: number) => points(value).slice(0, limit).join("");

export function parseStageMessage(text: string, turn: Turn): ModelStageReceipt {
  if (!turn.stage) throw new Error("stage metadata is required");
  const matches = [...text.matchAll(STAGE_BLOCK)];
  if (matches.length !== 1 || text.slice((matches[0]!.index ?? 0) + matches[0]![0].length).trim()) {
    throw new Error("final message must end with exactly one agent-autoloop-stage block");
  }
  let value: unknown;
  try {
    value = JSON.parse(matches[0]![1]!);
  } catch (error) {
    throw new Error(`stage receipt is not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stage receipt must be an object");
  const item = value as Record<string, unknown>;
  const fields = ["verdict", "summary", "artifacts", "findings"];
  if (Object.keys(item).some((field) => !fields.includes(field)) || fields.some((field) => !(field in item))) {
    throw new Error("stage receipt contains unknown or missing fields");
  }
  const configured = turn.stage.workflow.stages[turn.stage.stage_id];
  if (!configured || typeof item.verdict !== "string" || !(item.verdict in configured.on)) {
    throw new Error("stage receipt verdict is not configured for this stage");
  }
  if (typeof item.summary !== "string" || !item.summary.trim() || points(item.summary).length > 500) {
    throw new Error("stage receipt summary must be nonempty and at most 500 characters");
  }
  if (
    !Array.isArray(item.artifacts) ||
    item.artifacts.length > 100 ||
    !item.artifacts.every(
      (artifact) =>
        typeof artifact === "string" && SAFE_PATH(artifact) && turn.stage!.git.artifact_paths.includes(artifact),
    ) ||
    new Set(item.artifacts).size !== item.artifacts.length
  ) {
    throw new Error("stage receipt artifacts must be unique allowed relative paths");
  }
  if (
    !Array.isArray(item.findings) ||
    item.findings.length > 100 ||
    !item.findings.every(
      (finding) =>
        !!finding &&
        typeof finding === "object" &&
        !Array.isArray(finding) &&
        Object.keys(finding).every((field) => ["severity", "summary"].includes(field)) &&
        ["blocking", "warning", "info"].includes(String((finding as any).severity)) &&
        typeof (finding as any).summary === "string" &&
        !!(finding as any).summary.trim() &&
        points((finding as any).summary).length <= 500,
    )
  ) {
    throw new Error("stage receipt findings are invalid");
  }
  if (
    ["approved", "verified"].includes(item.verdict as string) &&
    (item.findings as StageFinding[]).some((finding) => finding.severity === "blocking")
  ) {
    throw new Error("approved or verified stage receipt cannot contain blocking findings");
  }
  return {
    verdict: item.verdict as StageResult["verdict"],
    summary: item.summary,
    artifacts: [...item.artifacts],
    findings: structuredClone(item.findings) as StageFinding[],
  };
}

function checkEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^AGENT_AUTOLOOP_/.test(key) || /^LODESTAR_AGENT_/.test(key) || key === "DSH_LODESTAR_AGENT_CONTEXT") continue;
    env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0" };
}

function runChecks(turn: Turn, workspace: StageWorkspace, diagnosticDir: string): StageCheck[] {
  mkdirSync(diagnosticDir, { recursive: true, mode: 0o700 });
  const revision = stageRevision(workspace);
  const checks: StageCheck[] = [];
  for (let index = 0; index < turn.stage!.checks.length; index++) {
    const check = turn.stage!.checks[index]!;
    if (!check.argv.length) throw new GitStageError("trusted check command is empty");
    const result = spawnSync(check.argv[0]!, check.argv.slice(1), {
      cwd: workspace.workDir,
      env: checkEnvironment(),
      encoding: "utf8",
      shell: false,
      timeout: check.timeout_ms,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(path.join(diagnosticDir, `stage-check-${index}.stdout.log`), result.stdout ?? "", { mode: 0o600 });
    writeFileSync(path.join(diagnosticDir, `stage-check-${index}.stderr.log`), result.stderr ?? "", { mode: 0o600 });
    const exitCode =
      result.status ?? (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? 124 : 127);
    checks.push({ name: check.name, exit_code: exitCode, revision });
  }
  if (stageRevision(workspace) !== revision)
    throw new GitStageError("trusted checks changed the measured stage revision");
  return checks;
}

type Transport = {
  requestId: string;
  remoteRunId?: string;
  session?: string;
  usage?: Usage;
  resolution?: OperatorResolution;
  diagnosticDir: string;
  /** Completion raced cancellation: preserve immutable evidence but never advance the task ref. */
  late?: boolean;
};

function stageBase(
  turn: Turn,
  workspace: StageWorkspace | undefined,
  transport: Transport,
): Pick<StageResult, "execution_id" | "request_id" | "remote_run_id" | "input_revision"> {
  return {
    execution_id: turn.stage!.execution_id,
    request_id: transport.requestId,
    ...(transport.remoteRunId ? { remote_run_id: transport.remoteRunId } : {}),
    ...(workspace?.inputRevision
      ? { input_revision: workspace.inputRevision }
      : typeof turn.stage!.input_revision === "string"
        ? { input_revision: turn.stage!.input_revision }
        : {}),
  };
}

function diagnosticFile(directory: string, finalOutput: string, diagnostic?: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, "stage-final-output.txt"), finalOutput, { mode: 0o600 });
  if (diagnostic !== undefined)
    writeFileSync(path.join(directory, "stage-diagnostic.txt"), diagnostic, { mode: 0o600 });
}

function failedResult(
  turn: Turn,
  workspace: StageWorkspace | undefined,
  transport: Transport,
  diagnostic: string,
  options: { checks?: StageCheck[]; artifacts?: StageResult["artifacts"] } = {},
): Result {
  const bounded = clipped(diagnostic, 2_000);
  mkdirSync(transport.diagnosticDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(transport.diagnosticDir, "stage-diagnostic.txt"), diagnostic, { mode: 0o600 });
  return parseResult({
    outcome: "done",
    summary: clipped("阶段执行未通过本机证据校验", 500),
    ...(transport.session ? { session: transport.session } : {}),
    ...(transport.usage ? { usage: transport.usage } : {}),
    stage: {
      ...stageBase(turn, workspace, transport),
      verdict: "execution_failed",
      artifacts: options.artifacts ?? [],
      checks: options.checks ?? [],
      findings: [],
      diagnostics: [bounded],
      ...(transport.resolution ? { resolution: transport.resolution } : {}),
    },
  });
}

export function buildStageFailureResult(input: {
  turn: Turn;
  workspace?: StageWorkspace;
  requestId: string;
  diagnostic: string;
  remoteRunId?: string;
  session?: string;
  usage?: Usage;
  resolution?: OperatorResolution;
  diagnosticDir: string;
}): Result {
  if (!input.turn.stage) throw new Error("stage metadata is required");
  return failedResult(input.turn, input.workspace, input, input.diagnostic);
}

export function prepareStageResult(input: {
  turn: Turn;
  workspace: StageWorkspace;
  finalOutput: string;
  requestId: string;
  remoteRunId?: string;
  session?: string;
  usage?: Usage;
  resolution?: OperatorResolution;
  diagnosticDir: string;
  /** Completion raced cancellation: preserve immutable evidence but never advance the task ref. */
  late?: boolean;
}): Result {
  const { turn, workspace, finalOutput, diagnosticDir } = input;
  if (!turn.stage) throw new Error("stage metadata is required");
  diagnosticFile(diagnosticDir, finalOutput);
  const transport = { ...input, requestId: input.requestId };
  if (input.resolution) {
    return failedResult(turn, workspace, transport, `operator attested stop: ${input.resolution.reason}`);
  }
  let receipt: ModelStageReceipt;
  try {
    receipt = parseStageMessage(finalOutput, turn);
  } catch (error) {
    return failedResult(turn, workspace, transport, String((error as Error).message ?? error));
  }
  let artifacts: StageResult["artifacts"] = [];
  let checks: StageCheck[] = [];
  try {
    stageRevision(workspace);
    artifacts = receipt.artifacts.map((artifact) => verifyStageArtifact(workspace, artifact));
    checks = runChecks(turn, workspace, diagnosticDir);
    if (checks.some((check) => check.exit_code !== 0)) {
      return failedResult(turn, workspace, transport, "one or more trusted checks failed", { artifacts, checks });
    }
    const evidence =
      workspace.mode === "write"
        ? {
            outputRevision: stageRevision(workspace),
            remoteRef: workspace.executionRef,
            artifacts: receipt.artifacts.map((artifact) => verifyStageArtifact(workspace, artifact)),
          }
        : verifyInspectStage(workspace, receipt.artifacts);
    return parseResult({
      outcome: "done",
      summary: receipt.summary,
      ...(input.session ? { session: input.session } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      stage: {
        ...stageBase(turn, workspace, transport),
        verdict: receipt.verdict,
        output_revision: evidence.outputRevision,
        remote_ref: evidence.remoteRef,
        artifacts: evidence.artifacts,
        checks,
        findings: receipt.findings,
      },
    });
  } catch (error) {
    if (error instanceof GitStageUncertainError) throw error;
    return failedResult(turn, workspace, transport, String((error as Error).message ?? error), { artifacts, checks });
  }
}

export function publishPreparedStageResult(workspace: StageWorkspace, result: Result, advanceTask: () => boolean) {
  const stage = result.stage;
  if (!stage?.output_revision || !stage.remote_ref) return;
  if (workspace.mode === "write") {
    reconcileWriteStage(
      workspace,
      {
        inputRevision: stage.input_revision!,
        outputRevision: stage.output_revision,
        remoteRef: stage.remote_ref,
        artifacts: stage.artifacts,
      },
      advanceTask,
    );
  } else {
    const measured = verifyInspectStage(
      workspace,
      stage.artifacts.map((artifact) => artifact.path),
    );
    if (
      measured.outputRevision !== stage.output_revision ||
      measured.remoteRef !== stage.remote_ref ||
      JSON.stringify(measured.artifacts) !== JSON.stringify(stage.artifacts)
    )
      throw new GitStageError("prepared inspect evidence no longer matches its workspace");
  }
}

// Kept for direct callers; observeTurn uses the durable prepared-publication gate.
export function buildStageResult(input: Parameters<typeof prepareStageResult>[0]): Result {
  const result = prepareStageResult(input);
  try {
    publishPreparedStageResult(input.workspace, result, () => input.late !== true);
    return result;
  } catch (error) {
    if (error instanceof GitStageUncertainError) throw error;
    return failedResult(input.turn, input.workspace, input, String((error as Error).message ?? error), {
      artifacts: result.stage?.artifacts,
      checks: result.stage?.checks,
    });
  }
}
