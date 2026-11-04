// Project-task data and stage evidence cross the public protocol. This module validates their bounded, inert shape;
// executable routing stays in the trusted Rules snapshot.
import { InputError } from "../kernel/errors.ts";
import type { Workflow, WorkflowCheck, WorkflowGit, WorkflowStage } from "../kernel/rules.ts";

export const STAGE_VERDICTS = [
  "planned",
  "implemented",
  "approved",
  "changes_requested",
  "verified",
  "blocked",
  "execution_failed",
] as const;
export type StageVerdict = (typeof STAGE_VERDICTS)[number];
export type TaskState =
  "queued" | "running" | "waiting_human" | "cancel_requested" | "unknown" | "completed" | "failed" | "cancelled";

export type ProjectTaskInput = {
  id: string;
  type: string;
  subject: string;
  goal: string;
  acceptance: string[];
  data?: JsonValue;
  source?: string;
};
export type TaskMutationRequest = { request_id: string };

export type StageArtifact = { path: string; revision: string; sha256: string };
export type StageCheck = { name: string; exit_code: number; revision: string };
export type StageFinding = { severity: "blocking" | "warning" | "info"; summary: string };
export type OperatorResolution = {
  kind: "operator_attested";
  reason: string;
  at: string;
  binding_id: string;
};
export type StageBinding = {
  binding_id?: string;
  installation_id?: string;
  worker?: string;
  project?: string;
  provider?: string;
  identity?: string;
  workdir?: string;
  chat?: string;
};
export type StageProgress = {
  execution_id: string;
  request_id: string;
  remote_run_id?: string;
  input_revision?: string;
  remote_state?: string;
  binding?: StageBinding;
};
export type StageResult = {
  execution_id: string;
  verdict: StageVerdict;
  request_id: string;
  remote_run_id?: string;
  input_revision?: string;
  output_revision?: string;
  remote_ref?: string;
  artifacts: StageArtifact[];
  checks: StageCheck[];
  findings: StageFinding[];
  diagnostics?: string[];
  resolution?: OperatorResolution;
};
export type AcceptedStageEvidence = Pick<
  StageResult,
  "execution_id" | "verdict" | "input_revision" | "output_revision" | "remote_ref" | "artifacts" | "checks" | "findings"
> & { stage_id: string; generation: number };
export type JobStage = {
  task_id: string;
  execution_id: string;
  generation: number;
  stage_id: string;
  input_revision: string | null;
  /** Owner-authorized task-ref locator; null input may be resolved once, a pinned input must only be verified. */
  input_resolution?: "task_ref";
  workflow: Workflow;
  route: {
    name: string;
    agent_id: string;
    worker: string;
    cwd: string;
    skill?: string;
    prompt?: string;
    access: string;
  };
  git: WorkflowGit;
  checks: WorkflowCheck[];
  evidence: AcceptedStageEvidence[];
};
export type WorkflowSnapshot = {
  name: string;
  entry: string;
  max_transitions: number;
  stages: Record<string, WorkflowStage>;
  git: WorkflowGit;
  recheck?: string;
  human: Workflow["human"];
};

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type Item = Record<string, unknown>;

const SUBJECT = /^[A-Za-z0-9#._:/@-]*$/;
const TASK_EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
const REVISION = /^[0-9a-f]{40,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_DIAGNOSTICS = 100;

const isItem = (value: unknown): value is Item => typeof value === "object" && value !== null && !Array.isArray(value);
const codePoints = (value: string) => [...value].length;
const text = (value: unknown, limit: number, empty = false): value is string =>
  typeof value === "string" && (empty || value.trim() !== "") && codePoints(value) <= limit;
const only = (value: Item, fields: readonly string[], where: string) => {
  const unknown = Object.keys(value).find((field) => !fields.includes(field));
  if (unknown) throw new InputError(`${where}有不认识的字段 ${unknown}`);
};
const positiveSafe = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
const jsonValue = (value: unknown, seen = new Set<object>()): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value as object)) return false;
  seen.add(value as object);
  const valid = Array.isArray(value)
    ? value.every((item) => jsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((item) => jsonValue(item, seen));
  seen.delete(value as object);
  return valid;
};

export function parseProjectTaskInput(input: unknown, allowSource = false): ProjectTaskInput {
  if (!isItem(input)) throw new InputError("项目任务要是一个 JSON 对象");
  only(input, ["id", "type", "subject", "goal", "acceptance", "data", ...(allowSource ? ["source"] : [])], "项目任务");
  if (!text(input.id, 200)) throw new InputError("id 必填，最多 200 个字");
  if (!text(input.type, 64) || !TASK_EVENT_TYPE.test(input.type)) {
    throw new InputError("type 只能用小写字母、数字和 . _ -，以字母开头");
  }
  if (!text(input.subject, 100, true) || !SUBJECT.test(input.subject)) {
    throw new InputError("subject 最多 100 个字，只能用字母、数字和 # . _ : / @ -");
  }
  if (!text(input.goal, 20_000)) throw new InputError("goal 必填，最多 20000 个字");
  if (
    !Array.isArray(input.acceptance) ||
    input.acceptance.length < 1 ||
    input.acceptance.length > 100 ||
    !input.acceptance.every((item) => text(item, 2_000))
  ) {
    throw new InputError("acceptance 要有 1 到 100 条非空文字，每条最多 2000 个字");
  }
  if (input.data !== undefined && !jsonValue(input.data)) throw new InputError("data 要是合法的 JSON 值");
  if (allowSource && !text(input.source, 100)) throw new InputError("source 必填，最多 100 个字");
  return { ...input } as ProjectTaskInput;
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable request material for the kernel's existing digest helper. */
export function canonicalProjectTask(input: ProjectTaskInput): string {
  const value = { ...input } as Record<string, JsonValue | undefined>;
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return canonical(value as { [key: string]: JsonValue });
}

const optionalText = (value: unknown, limit: number) => value === undefined || text(value, limit);
const list = (value: unknown, limit: number, valid: (item: Item) => boolean): value is Item[] =>
  Array.isArray(value) && value.length <= limit && value.every((item) => isItem(item) && valid(item));
const validArtifact = (item: Item) =>
  Object.keys(item).every((field) => ["path", "revision", "sha256"].includes(field)) &&
  text(item.path, 500) &&
  !item.path.startsWith("/") &&
  !item.path.split("/").some((part) => part === "" || part === "." || part === "..") &&
  typeof item.revision === "string" &&
  REVISION.test(item.revision) &&
  typeof item.sha256 === "string" &&
  SHA256.test(item.sha256);
const validCheck = (item: Item) =>
  Object.keys(item).every((field) => ["name", "exit_code", "revision"].includes(field)) &&
  text(item.name, 200) &&
  Number.isSafeInteger(item.exit_code) &&
  typeof item.revision === "string" &&
  REVISION.test(item.revision);
const validFinding = (item: Item) =>
  Object.keys(item).every((field) => ["severity", "summary"].includes(field)) &&
  ["blocking", "warning", "info"].includes(item.severity as string) &&
  text(item.summary, 500);

export function parseStageResult(input: unknown): StageResult {
  if (!isItem(input)) throw new InputError("stage 要是一个 JSON 对象");
  only(
    input,
    [
      "execution_id",
      "verdict",
      "request_id",
      "remote_run_id",
      "input_revision",
      "output_revision",
      "remote_ref",
      "artifacts",
      "checks",
      "findings",
      "diagnostics",
      "resolution",
    ],
    "stage ",
  );
  if (!text(input.execution_id, 300) || !text(input.request_id, 300)) {
    throw new InputError("stage 的 execution_id 和 request_id 必填，最多 300 个字");
  }
  if (!STAGE_VERDICTS.includes(input.verdict as StageVerdict)) throw new InputError("stage 的 verdict 不受支持");
  if (!optionalText(input.remote_run_id, 500)) throw new InputError("remote_run_id 最多 500 个字");
  for (const field of ["input_revision", "output_revision"] as const) {
    if (input[field] !== undefined && (typeof input[field] !== "string" || !REVISION.test(input[field]))) {
      throw new InputError(`${field} 要是 40 到 64 位小写十六进制版本`);
    }
  }
  if (input.remote_ref !== undefined && (typeof input.remote_ref !== "string" || !REF.test(input.remote_ref))) {
    throw new InputError("remote_ref 要是完整 refs/ 引用");
  }
  if (!list(input.artifacts, 100, validArtifact))
    throw new InputError("artifacts 最多 100 项，路径、版本和 sha256 要完整");
  if (!list(input.checks, 100, validCheck)) throw new InputError("checks 最多 100 项，名称、退出码和版本要完整");
  if (!list(input.findings, 100, validFinding)) throw new InputError("findings 最多 100 项，严重级别和摘要要有效");
  if (
    input.diagnostics !== undefined &&
    (!Array.isArray(input.diagnostics) ||
      input.diagnostics.length > MAX_DIAGNOSTICS ||
      !input.diagnostics.every((item) => text(item, 2_000)))
  ) {
    throw new InputError("diagnostics 最多 100 项，每项最多 2000 个字");
  }
  if (input.resolution !== undefined) {
    if (!isItem(input.resolution)) throw new InputError("resolution 要是对象");
    only(input.resolution, ["kind", "reason", "at", "binding_id"], "resolution ");
    if (
      input.resolution.kind !== "operator_attested" ||
      !text(input.resolution.reason, 2_000) ||
      !text(input.resolution.at, 100) ||
      !text(input.resolution.binding_id, 500) ||
      !Number.isFinite(Date.parse(input.resolution.at as string))
    ) {
      throw new InputError("resolution 要有 operator_attested、reason、at 和 binding_id");
    }
  }
  return { ...input } as StageResult;
}

export function parseStageProgress(input: unknown): StageProgress {
  if (!isItem(input)) throw new InputError("started.stage 要是对象");
  only(
    input,
    ["execution_id", "request_id", "remote_run_id", "input_revision", "remote_state", "binding"],
    "started.stage ",
  );
  if (!text(input.execution_id, 300) || !text(input.request_id, 300)) {
    throw new InputError("started.stage 的 execution_id 和 request_id 必填");
  }
  if (!optionalText(input.remote_run_id, 500) || !optionalText(input.remote_state, 100)) {
    throw new InputError("started.stage 的远端字段太长");
  }
  if (
    input.input_revision !== undefined &&
    (typeof input.input_revision !== "string" || !REVISION.test(input.input_revision))
  ) {
    throw new InputError("started.stage 的 input_revision 无效");
  }
  if (input.binding !== undefined) {
    if (!isItem(input.binding)) throw new InputError("started.stage.binding 要是对象");
    const fields = ["binding_id", "installation_id", "worker", "project", "provider", "identity", "workdir", "chat"];
    only(input.binding, fields, "started.stage.binding ");
    if (!Object.values(input.binding).every((value) => text(value, 1_000))) {
      throw new InputError("started.stage.binding 的值要是 1000 字以内的非空文字");
    }
  }
  return { ...input } as StageProgress;
}

export const isPositiveSafeInteger = positiveSafe;
