// Only the standalone worker may use project credentials. No model or Hub token is passed through this transport.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Reading, Turn, Usage } from "../../worker/agents.ts";
import { parseResult, type Result } from "../../protocol/validate.ts";
import {
  GitStageError,
  GitStageUncertainError,
  prepareStageWorkspace,
  stageRevision,
  validateStageWorkspace,
  type StageWorkspace,
} from "./git.ts";
import { buildStageFailureResult, prepareStageResult, publishPreparedStageResult } from "./receipt.ts";
import { directLoopbackRequest } from "./local-http.ts";

export type Options = { project: string; identity: string; clientFile: string };
type Binding = { installation_id: string; binding_id: string; project: string; chat_id: string; work_dir: string };
type Prepared = {
  input_hash: string;
  request_id: string;
  execution_id: string;
  workspace: StageWorkspace;
  result: Result;
  publication: "advance" | "late" | "inspect";
  digest: string;
};
type Journal = {
  version: 1;
  input_hash: string;
  request_id: string;
  attempted: boolean;
  binding?: Binding;
  provider?: string;
  body?: Record<string, unknown>;
  run_id?: string;
  session_id?: string;
  reading?: Reading;
  stage?: StageWorkspace;
  prepared?: Prepared;
  termination?: {
    request_id: string;
    state: "resolved" | "cancelled";
    run_id: string | null;
  };
};
const MANAGED = [
  "LODESTAR_AGENT_ROLE",
  "LODESTAR_AGENT_URL",
  "LODESTAR_AGENT_CAPABILITY",
  "LODESTAR_AGENT_SESSION",
  "DSH_LODESTAR_AGENT_CONTEXT",
];
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function independentContext(env = process.env) {
  if (MANAGED.some((key) => env[key] !== undefined)) throw new Error("受管 Agent 调用不能使用独立服务的项目凭据");
}

export function optionsFor(turn: Turn): Options {
  independentContext();
  if (turn.access !== "full") throw new Error("Lodestar 调用目前只支持显式 access: full");
  if (turn.resume !== null && (typeof turn.resume !== "string" || !turn.resume.trim()))
    throw new Error("恢复会话编号不能为空");
  const args = turn.command ?? [];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!["--project", "--identity", "--client-file"].includes(key) || values.has(key) || !value?.trim()) {
      throw new Error("Lodestar command 只接受不重复的 --project、--identity、--client-file 参数");
    }
    values.set(key, value);
  }
  const project = values.get("--project");
  const identity = values.get("--identity");
  const clientFile = values.get("--client-file");
  if (!project || !identity || !clientFile || !path.isAbsolute(clientFile))
    throw new Error("Lodestar 需要 project、identity 和绝对路径 client-file");
  return { project, identity, clientFile };
}

export function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const directory = openSync(path.dirname(file), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function createJsonOnce(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
  const directory = openSync(path.dirname(file), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

const journalFile = (turn: Turn) => path.join(turn.folder, "lodestar-journal.json");
const cancelFile = (turn: Turn) => path.join(turn.folder, "lodestar-cancel.json");
const bindingFile = (turn: Turn) => path.join(turn.folder, "lodestar-binding.json");
const hashOf = (turn: Turn) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        prompt: turn.prompt,
        resume: turn.resume,
        cwd: realpathSync(turn.stage?.route.cwd ?? turn.cwd),
        command: turn.command,
        effort: turn.effort,
        stage: turn.stage,
      }),
    )
    .digest("hex");

function readJournal(turn: Turn): Journal {
  let value: any;
  try {
    value = JSON.parse(readFileSync(journalFile(turn), "utf8"));
  } catch {
    throw new Error("Lodestar 执行记录缺失或损坏，已保留任务，需核对后恢复");
  }
  if (
    value?.version !== 1 ||
    typeof value.request_id !== "string" ||
    typeof value.attempted !== "boolean" ||
    value.input_hash !== hashOf(turn)
  ) {
    throw new Error("Lodestar 执行记录与当前任务不一致，禁止重新执行");
  }
  // Old terminal readings can preserve the provider they already reported;
  // a current catalog cannot establish an older execution's backend.
  const reported = value.reading?.stage?.binding;
  if (
    value.provider === undefined &&
    typeof reported?.provider === "string" &&
    reported.binding_id === value.binding?.binding_id &&
    reported.installation_id === value.binding?.installation_id
  )
    value.provider = reported.provider;
  return value as Journal;
}

export function prepareTurn(turn: Turn): string {
  optionsFor(turn);
  if (!statSync(turn.cwd).isDirectory()) throw new Error("执行目录不是文件夹");
  mkdirSync(turn.folder, { recursive: true, mode: 0o700 });
  if (!existsSync(journalFile(turn))) {
    atomicJson(journalFile(turn), {
      version: 1,
      input_hash: hashOf(turn),
      request_id: turn.stage?.execution_id ?? turn.invocation ?? randomUUID(),
      attempted: false,
    } satisfies Journal);
  }
  readJournal(turn);
  const file = path.join(turn.folder, "lodestar-turn.json");
  atomicJson(file, turn);
  return file;
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function localRequest(options: Options, method: string, route: string, body?: unknown, binding?: string) {
  independentContext();
  let client: any;
  try {
    client = JSON.parse(readFileSync(options.clientFile, "utf8"));
  } catch {
    throw new Error("无法读取 Lodestar 项目客户端配置，请确认本机 daemon 已启动");
  }
  let base: URL;
  try {
    base = new URL(client.baseUrl);
  } catch {
    throw new Error("Lodestar 项目客户端地址无效");
  }
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    typeof client.capability !== "string" ||
    !client.capability
  ) {
    throw new Error("Lodestar 项目客户端必须是本机 loopback 地址且具备有效凭据");
  }
  const url = new URL(route, base);
  if (url.origin !== base.origin) throw new Error("Lodestar 请求不能离开本机服务");
  url.searchParams.set("project", options.project);
  if (binding) url.searchParams.set("expected_binding", binding);
  const response = await directLoopbackRequest(url, {
    method,
    headers: {
      authorization: `Bearer ${client.capability}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    timeoutMs: 10_000,
  });
  let value: any;
  try {
    value = JSON.parse(response.text);
  } catch {
    throw new Error("Lodestar 返回了无法解析的响应");
  }
  if (!response.ok) {
    const message =
      typeof value?.error === "string"
        ? value.error.replaceAll(client.capability, "[凭据]")
        : `Lodestar HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return value;
}

function contained(root: string, folder: string) {
  const relative = path.relative(realpathSync(root), realpathSync(folder));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function checkedBinding(value: any, options: Options, turn: Turn): Binding {
  if (
    !["installation_id", "binding_id", "project", "chat_id", "work_dir"].every(
      (key) => typeof value?.[key] === "string" && value[key],
    ) ||
    value.project !== options.project ||
    !contained(value.work_dir, turn.cwd)
  ) {
    throw new Error("Lodestar 项目绑定或执行目录不匹配");
  }
  return value as Binding;
}

function usageOf(value: any): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage: Usage = {};
  for (const [from, to] of [
    ["input_tokens", "input"],
    ["output_tokens", "output"],
    ["cached_input_tokens", "cached"],
    ["cost_usd", "cost"],
  ] as const) {
    if (typeof value[from] === "number" && Number.isFinite(value[from]) && value[from] >= 0) usage[to] = value[from];
  }
  return Object.keys(usage).length ? usage : undefined;
}

function stageProgress(turn: Turn, journal: Journal, remoteState: string, run?: any): NonNullable<Reading["stage"]> {
  const binding = journal.binding;
  return {
    execution_id: turn.stage!.execution_id,
    request_id: journal.request_id,
    ...(typeof (run?.run_id ?? journal.run_id) === "string" ? { remote_run_id: run?.run_id ?? journal.run_id } : {}),
    ...(journal.stage ? { input_revision: journal.stage.inputRevision } : {}),
    remote_state: remoteState,
    ...(binding
      ? {
          binding: {
            binding_id: binding.binding_id,
            installation_id: binding.installation_id,
            worker: turn.stage!.route.worker,
            project: binding.project,
            ...(journal.provider ? { provider: journal.provider } : {}),
            identity: optionsFor(turn).identity,
            workdir: journal.stage?.workDir ?? binding.work_dir,
            chat: binding.chat_id,
          },
        }
      : {}),
  };
}

function stoppedReading(seen: Reading, completed = false, attested = false): Reading {
  const summary = attested ? "操作者已确认旧执行停止" : completed ? "取消前本轮执行已结束" : "本机任务已停止";
  const details = seen.text || seen.error;
  return {
    ...seen,
    error: undefined,
    finished: true,
    result: {
      outcome: "cancelled",
      summary,
      ...(seen.session ? { session: seen.session } : {}),
      ...(seen.usage ? { usage: seen.usage } : {}),
      ...(completed || details || attested
        ? {
            notice: [
              {
                title: summary,
                text: details
                  ? Array.from(details).slice(0, 1500).join("")
                  : attested
                    ? "停止依据是操作者确认，原执行的已有结果仍需核对。"
                    : "取消请求未抹除已发生的执行，请核对保留的结果。",
              },
            ],
          }
        : {}),
    },
  };
}

function stageFailureReading(
  turn: Turn,
  journal: Journal,
  diagnostic: string,
  options: { run?: any; worker?: any; resolution?: any } = {},
): Reading {
  // Failure provenance may mention a rejected worker session, but only the
  // previously accepted journal/resume id is safe to return to the Hub.
  const unpinned = turn.stage?.input_resolution === "task_ref" && !journal.stage && !journal.attempted;
  const session = unpinned ? undefined : (journal.session_id ?? turn.resume ?? undefined);
  return {
    ...(session ? { session } : {}),
    ...(turn.stage && !unpinned
      ? { stage: stageProgress(turn, journal, options.run?.status ?? "execution_failed", options.run) }
      : {}),
    finished: true,
    result: buildStageFailureResult({
      turn,
      workspace: journal.stage,
      requestId: journal.request_id,
      diagnostic,
      ...(typeof options.run?.run_id === "string"
        ? { remoteRunId: options.run.run_id }
        : journal.run_id
          ? { remoteRunId: journal.run_id }
          : {}),
      ...(session ? { session } : {}),
      ...(usageOf(options.worker?.usage) ? { usage: usageOf(options.worker.usage) } : {}),
      ...(options.resolution ? { resolution: options.resolution } : {}),
      diagnosticDir: turn.folder,
    }),
  };
}

function cancelledStageReading(seen: Reading): Reading {
  return {
    ...seen,
    error: undefined,
    text: undefined,
    finished: true,
    result: {
      outcome: "cancelled",
      summary: "本机任务已停止",
      ...(seen.session ? { session: seen.session } : {}),
      ...(seen.usage ? { usage: seen.usage } : {}),
    },
  };
}

function preparedDigest(prepared: Omit<Prepared, "digest"> | Prepared) {
  const { digest: ignored, ...record } = prepared as Prepared;
  void ignored;
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function preparedReading(turn: Turn, journal: Journal): Reading {
  const prepared = journal.prepared!;
  const stage = prepared.result?.stage;
  if (
    !journal.stage ||
    prepared.digest !== preparedDigest(prepared) ||
    prepared.input_hash !== journal.input_hash ||
    prepared.request_id !== journal.request_id ||
    prepared.execution_id !== turn.stage!.execution_id ||
    journal.request_id !== turn.stage!.execution_id ||
    JSON.stringify(prepared.workspace) !== JSON.stringify(journal.stage) ||
    journal.body?.work_dir !== journal.stage.workDir ||
    !stage ||
    stage.execution_id !== prepared.execution_id ||
    stage.request_id !== prepared.request_id ||
    stage.remote_run_id !== journal.run_id ||
    prepared.result.session !== journal.session_id ||
    stage.input_revision !== journal.stage.inputRevision ||
    !stage.output_revision ||
    stage.remote_ref !== (journal.stage.mode === "write" ? journal.stage.executionRef : journal.stage.inputRef) ||
    stage.checks.length !== turn.stage!.checks.length ||
    stage.checks.some(
      (check, index) =>
        check.name !== turn.stage!.checks[index]!.name ||
        check.exit_code !== 0 ||
        check.revision !== stage.output_revision,
    ) ||
    stage.artifacts.some(
      (artifact) =>
        !journal.stage!.artifactPaths.includes(artifact.path) || artifact.revision !== stage.output_revision,
    ) ||
    !["advance", "late", "inspect"].includes(prepared.publication) ||
    (journal.stage.mode === "inspect") !== (prepared.publication === "inspect") ||
    JSON.stringify(parseResult(prepared.result)) !== JSON.stringify(prepared.result)
  ) {
    throw new GitStageError("prepared receipt does not match its durable execution binding");
  }
  validateStageWorkspace(turn, journal.stage);
  publishPreparedStageResult(journal.stage, prepared.result, () => {
    if (prepared.publication === "advance" && existsSync(cancelFile(turn))) {
      prepared.publication = "late";
      prepared.digest = preparedDigest(prepared);
      atomicJson(journalFile(turn), journal);
    }
    return prepared.publication === "advance";
  });
  return {
    finished: true,
    ...(prepared.result.session ? { session: prepared.result.session } : {}),
    ...(prepared.result.usage ? { usage: prepared.result.usage } : {}),
    stage: stageProgress(turn, journal, "completed"),
    result: prepared.result,
  };
}

function stageResultReading(
  turn: Turn,
  journal: Journal,
  run: any,
  worker: any,
  observed: Reading,
  late = false,
): Reading {
  validateStageWorkspace(turn, journal.stage!);
  if (journal.prepared) return preparedReading(turn, journal);
  // A legacy terminal reading already contains the measured canonical receipt.
  // Reconfirm native termination before reusing it, then apply the same publication binding checks.
  const result =
    journal.reading?.finished && journal.reading.result?.stage?.output_revision
      ? journal.reading.result
      : prepareStageResult({
          turn,
          workspace: journal.stage!,
          finalOutput: worker.final_output,
          requestId: journal.request_id,
          remoteRunId: run.run_id,
          ...(observed.session ? { session: observed.session } : {}),
          ...(observed.usage ? { usage: observed.usage } : {}),
          diagnosticDir: turn.folder,
          late,
        });
  if (!result.stage?.output_revision) return { ...observed, finished: true, result };
  const prepared: Prepared = {
    input_hash: journal.input_hash,
    request_id: journal.request_id,
    execution_id: turn.stage!.execution_id,
    workspace: structuredClone(journal.stage!),
    result,
    publication:
      journal.stage!.mode === "inspect" ? "inspect" : late || existsSync(cancelFile(turn)) ? "late" : "advance",
    digest: "",
  };
  prepared.digest = preparedDigest(prepared);
  journal.prepared = prepared;
  atomicJson(journalFile(turn), journal);
  return { ...observed, ...preparedReading(turn, journal) };
}

function unknownReading(turn: Turn, journal: Journal, diagnostic: string): Reading {
  return {
    pending: true,
    diagnostic,
    ...(journal.session_id ? { session: journal.session_id } : {}),
    ...(turn.stage ? { stage: stageProgress(turn, journal, "unknown") } : {}),
  };
}

function hasTermination(journal: Journal) {
  return (
    journal.termination?.request_id === journal.request_id &&
    journal.termination.run_id === (journal.run_id ?? null) &&
    ["resolved", "cancelled"].includes(journal.termination.state)
  );
}

function recordTermination(journal: Journal, state: "resolved" | "cancelled") {
  journal.termination = { request_id: journal.request_id, state, run_id: journal.run_id ?? null };
}

function readRun(run: any, journal: Journal, options: Options, turn: Turn, requestState?: string): Reading {
  if (
    !run ||
    typeof run.run_id !== "string" ||
    (journal.run_id !== undefined && journal.run_id !== run.run_id) ||
    run.request_id !== journal.request_id ||
    run.binding !== "project" ||
    run.project !== options.project ||
    run.work_dir !== journal.body?.work_dir ||
    !Array.isArray(run.workers) ||
    run.workers.length !== 1 ||
    run.workers[0].identity_id !== options.identity
  ) {
    return unknownReading(turn, journal, "Lodestar 返回的执行归属不匹配，保留原任务等待核对");
  }
  journal.run_id = run.run_id;
  const worker = run.workers[0];
  const providerMismatch =
    journal.provider && typeof worker.provider === "string" && worker.provider !== journal.provider;
  const session = typeof worker.session_id === "string" && worker.session_id ? worker.session_id : undefined;
  if (
    !providerMismatch &&
    session &&
    (!turn.resume || turn.resume === session) &&
    (!journal.session_id || journal.session_id === session)
  )
    journal.session_id = session;
  const terminal = TERMINAL.has(run.status) && TERMINAL.has(worker.status);
  const confirmed =
    requestState === "cancelled"
      ? run.status === "cancelled"
      : requestState === "resolved" && ["completed", "failed"].includes(run.status);
  if (
    ((TERMINAL.has(run.status) || TERMINAL.has(worker.status)) && (!terminal || !confirmed)) ||
    (requestState !== undefined && !["admitted", "resolved", "cancelled"].includes(requestState)) ||
    (["resolved", "cancelled"].includes(requestState ?? "") && !terminal)
  ) {
    return unknownReading(turn, journal, "执行快照尚无匹配的持久终止事实，保留原任务等待确认");
  }
  if (terminal) recordTermination(journal, requestState as "resolved" | "cancelled");
  if (providerMismatch) {
    const diagnostic = "Lodestar 返回的 provider 与接纳前固定的身份不一致";
    return terminal
      ? turn.stage
        ? stageFailureReading(turn, journal, diagnostic, { run, worker })
        : { finished: true, error: diagnostic }
      : unknownReading(turn, journal, diagnostic);
  }
  if (
    (turn.resume && session && turn.resume !== session) ||
    (journal.session_id && session && journal.session_id !== session)
  ) {
    return terminal
      ? turn.stage
        ? stageFailureReading(turn, journal, "Lodestar 恢复返回了不同的原生会话，禁止新建替代", { run, worker })
        : { finished: true, error: "Lodestar 恢复返回了不同的原生会话，禁止新建替代" }
      : unknownReading(turn, journal, "原生会话归属发生变化，等待实际执行结束");
  }
  if (session) journal.session_id = session;
  const observed = {
    ...(session ? { session } : {}),
    ...(usageOf(worker.usage) ? { usage: usageOf(worker.usage) } : {}),
    ...(turn.stage ? { stage: stageProgress(turn, journal, run.status, run) } : {}),
  };
  if (!terminal) return { ...observed, pending: true };
  if (run.status === "cancelled" || worker.status === "cancelled") {
    if (turn.stage) {
      if (worker.status === "completed" && typeof worker.final_output === "string" && worker.final_output.trim()) {
        return stageResultReading(turn, journal, run, worker, observed, true);
      }
      return cancelledStageReading(observed);
    }
    return stoppedReading(
      { ...observed, ...(typeof worker.final_output === "string" ? { text: worker.final_output } : {}) },
      worker.status === "completed",
    );
  }
  if (run.status !== "completed" || worker.status !== "completed") {
    const diagnostic = String(worker.error || run.error || "Lodestar 执行失败");
    return turn.stage
      ? stageFailureReading(turn, journal, diagnostic, { run, worker })
      : { ...observed, finished: true, error: diagnostic };
  }
  if (!session) {
    return turn.stage
      ? stageFailureReading(turn, journal, "Lodestar 未返回可追踪的原生会话", { run, worker })
      : { finished: true, error: "Lodestar 未返回可追踪的原生会话" };
  }
  if (typeof worker.final_output !== "string" || !worker.final_output.trim()) {
    return turn.stage
      ? stageFailureReading(turn, journal, "Lodestar 未提供完整 final_output，不能用过程正文替代", { run, worker })
      : { ...observed, finished: true, error: "Lodestar 未提供完整 final_output，不能用过程正文替代" };
  }
  if (turn.stage) {
    return stageResultReading(turn, journal, run, worker, observed);
  }
  return { ...observed, finished: true, text: worker.final_output };
}

function readRequest(state: any, journal: Journal, options: Options, turn: Turn, cancelling: boolean): Reading {
  if (state?.request_id !== journal.request_id)
    return unknownReading(turn, journal, "Lodestar 请求记录与原 request_id 不匹配");
  if (
    state.state === "resolved" &&
    state.resolution?.kind === "operator_attested" &&
    state.resolution.binding_id === journal.binding?.binding_id
  ) {
    recordTermination(journal, "resolved");
    return turn.stage
      ? stageFailureReading(turn, journal, "operator attested stop", {
          run: state.run,
          worker: state.run?.workers?.[0],
          resolution: state.resolution,
        })
      : cancelling
        ? stoppedReading({ ...(journal.session_id ? { session: journal.session_id } : {}) }, false, true)
        : { finished: true, error: "操作者已确认旧执行停止；需显式决定后续处理" };
  }
  if (!state.run) {
    if (!journal.run_id && state.run_id === null && state.state === "cancelled") {
      recordTermination(journal, "cancelled");
      return turn.stage ? cancelledStageReading({}) : stoppedReading({});
    }
    if (!journal.run_id && state.run_id === null && state.state === "resolved") {
      recordTermination(journal, "resolved");
      const diagnostic = "Lodestar 已确认请求未启动；原生会话或提交输入被拒绝，需显式处理";
      return turn.stage ? stageFailureReading(turn, journal, diagnostic) : { finished: true, error: diagnostic };
    }
    return unknownReading(turn, journal, "原执行快照缺失，不能据此确认未启动或已停止");
  }
  if (
    (["resolved", "cancelled"].includes(state.state) && typeof state.run_id !== "string") ||
    (Object.hasOwn(state, "run_id") && state.run_id !== state.run.run_id)
  ) {
    const observed = readRun(state.run, journal, options, turn, "unknown");
    return { ...observed, diagnostic: "持久请求与执行快照的 run_id 不匹配，保留实际执行等待确认" };
  }
  const observed = readRun(state.run, journal, options, turn, state.state);
  if (cancelling && observed.finished && !turn.stage)
    return stoppedReading(observed, state.run.workers?.[0]?.status === "completed");
  return observed;
}

export async function observeTurn(turn: Turn, cancel = false): Promise<Reading> {
  const options = optionsFor(turn);
  if (cancel) createJsonOnce(cancelFile(turn), { requested: true });
  const journal = readJournal(turn);
  const cancelling = () => existsSync(cancelFile(turn));
  if (journal.reading?.finished && !cancelling() && (!journal.attempted || hasTermination(journal)))
    return journal.reading;
  const remember = (reading: Reading) => {
    if (reading.finished) journal.reading = reading;
    atomicJson(journalFile(turn), journal);
    return reading;
  };
  try {
    if (turn.stage && journal.prepared && hasTermination(journal)) return remember(preparedReading(turn, journal));
    if (turn.stage && journal.attempted && !journal.stage)
      return unknownReading(turn, journal, "已提交执行的固定工作区记录缺失，保留原请求等待核对");
    if (turn.stage && !journal.stage && !cancelling()) {
      journal.stage = prepareStageWorkspace(turn);
      atomicJson(journalFile(turn), journal);
    }
    if (turn.stage && journal.stage && !journal.attempted) {
      validateStageWorkspace(turn, journal.stage);
      stageRevision(journal.stage);
    }
    if (!journal.binding) {
      if (!existsSync(bindingFile(turn))) {
        const discovered = checkedBinding(await localRequest(options, "GET", "/agents/project-binding"), options, turn);
        createJsonOnce(bindingFile(turn), discovered);
      }
      journal.binding = checkedBinding(JSON.parse(readFileSync(bindingFile(turn), "utf8")), options, turn);
      atomicJson(journalFile(turn), journal);
    }
    const requestPath = `/agents/requests/${encodeURIComponent(journal.request_id)}`;
    if (cancelling()) {
      const state = await localRequest(options, "DELETE", requestPath, undefined, journal.binding.binding_id);
      return remember(readRequest(state, journal, options, turn, true));
    }
    if (journal.attempted) {
      const state = await localRequest(options, "GET", requestPath, undefined, journal.binding.binding_id);
      return remember(readRequest(state, journal, options, turn, false));
    }
    if (!journal.body) {
      const catalog = await localRequest(options, "GET", "/agents/identities");
      const identity = Array.isArray(catalog.identities)
        ? catalog.identities.find((item: any) => item.id === options.identity)
        : undefined;
      if (!identity || identity.status !== "ready") throw new Error("所选 Lodestar 身份不存在或尚未 ready");
      if (turn.effort && !identity.supported_efforts?.includes(turn.effort)) throw new Error("所选身份不支持该 effort");
      if (typeof identity.provider === "string" && identity.provider) journal.provider = identity.provider;
      journal.body = {
        identity_ids: [options.identity],
        description: (turn.description ?? "自动化任务").replace(/[\r\n]/g, " ").slice(0, 60),
        prompt: turn.prompt,
        request_id: journal.request_id,
        expected_binding: journal.binding.binding_id,
        work_dir: journal.stage?.workDir ?? realpathSync(turn.cwd),
        ...(turn.resume ? { session_id: turn.resume } : {}),
        ...(turn.effort ? { effort: turn.effort } : {}),
      };
    }
    if (cancelling()) return observeTurn(turn, true);
    journal.attempted = true;
    atomicJson(journalFile(turn), journal);
    try {
      const run = await localRequest(options, "POST", "/agents/runs", journal.body);
      const observed = readRun(run, journal, options, turn);
      atomicJson(journalFile(turn), journal);
      if (!TERMINAL.has(run?.status) && !run?.workers?.some((worker: any) => TERMINAL.has(worker.status)))
        return observed;
    } catch (error) {
      // A response code or lost response says nothing about native admission.
      if (!(error instanceof ApiError)) throw error;
    }
    const state = await localRequest(options, "GET", requestPath, undefined, journal.binding.binding_id);
    return remember(readRequest(state, journal, options, turn, cancelling()));
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : "Lodestar 通信失败";
    if (error instanceof GitStageUncertainError) return unknownReading(turn, journal, diagnostic);
    if (!journal.attempted && !cancelling()) {
      return remember(
        turn.stage ? stageFailureReading(turn, journal, diagnostic) : { finished: true, error: diagnostic },
      );
    }
    if (turn.stage && error instanceof GitStageError && hasTermination(journal))
      return remember(stageFailureReading(turn, journal, diagnostic));
    return unknownReading(turn, journal, diagnostic);
  }
}

async function main() {
  const file = process.argv[process.argv.indexOf("--turn") + 1];
  if (!file) throw new Error("缺少 --turn 执行描述文件");
  const turn = JSON.parse(readFileSync(file, "utf8")) as Turn;
  let cancel = false;
  process.on("SIGINT", () => {
    cancel = true;
  });
  process.on("SIGTERM", () => {
    cancel = true;
  });
  while (true) {
    const reading = await observeTurn(turn, cancel);
    process.stdout.write(`${JSON.stringify({ protocol: "lodestar-adapter-v1", reading })}\n`);
    if (reading.finished) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("Lodestar 观察进程未能完成；请核对保留的执行记录\n");
    process.exitCode = 1;
  });
}
