// Everything that can change the hub is decided here: given the view and one input, the facts to record and the answer
// to give. Time and secrets come in as arguments, so the same input on the same view always decides the same.
import { credential, digest, type Environment } from "./credentials.ts";
import { latestBefore, nextRun, parseCron } from "./cron.ts";
import { deadlines, MINUTE, OFFLINE_AFTER, RUN_LEASE, WORKER_FRESH } from "./due.ts";
import { AuthError, Conflict, InputError, NotFound } from "./errors.ts";
import { iso, rows, type Change, type Fact, type Row, type Table, type View } from "./evolve.ts";
import {
  agentsOf,
  cardView,
  configuration,
  eventsOf,
  jobOf,
  openInScope,
  sourceOf,
  waitingOn,
  workerOf,
  workers,
} from "./query.ts";
import { cronOf, eventRule, SCHEDULE, typeMatches, type Rule, type Rules } from "./rules.ts";
import {
  canonicalProjectTask,
  parseProjectTaskInput,
  parseStageResult,
  type ProjectTaskInput,
  type StageResult,
} from "../protocol/project-tasks.ts";
import {
  addUsage,
  parseEvent,
  parseResult,
  parseStarted,
  type Later,
  type Rejected,
  type Result,
} from "../protocol/validate.ts";

export type Input = { type: string; args: any[] };

/** Minutes after the first try that a card is sent to a channel again. */
const RESEND_AT = [0, 1, 3, 7, 15, 25, 35, 45, 55];
/** The last resend and the minute it holds the card: after this a channel has given up. */
const RESEND_WINDOW = 57 * MINUTE;
/** How long a chain of events causing events can get before it stops being dispatched. */
const MAX_HOPS = 8;
const NOT_TRYING = { tries: 0, first_try_at: null, not_before: null };
const NOT_DELIVERED: Row = { version: 0, ref: null, ...NOT_TRYING, error: null, given_up: 0 };

const nulls = (...names: string[]) => Object.fromEntries(names.map((name) => [name, null]));
const CARD_BASICS = { text: "", options: "[]", recommend: null, about: "", state: "open", fyi: 0, quiet: 0 };
const DEFAULTS: Partial<Record<Table, Row>> = {
  runs: {
    attempts: 0,
    ...nulls("claim", "issued", "last_issued", "last_result", "last_answer", "cancel_at", "resume", "session", "link"),
    ...nulls("claimed_at", "seen_at", "finished_at", "summary", "error", "usage"),
  },
  project_tasks: {
    ...nulls("current_stage", "current_execution", "current_revision", "human_card", "completed_at"),
    requests: "{}",
    late_outcomes: "[]",
  },
  stage_executions: {
    ...nulls(
      "input_revision",
      "input_resolution",
      "output_revision",
      "verdict",
      "progress",
      "result",
      "started_at",
      "finished_at",
    ),
  },
  cards: {
    ...CARD_BASICS,
    ...nulls("choice", "answer", "by", "result", "rule"),
    lane: "",
    ...nulls("grp", "source", "agent", "session", "run_id", "answer_event"),
    version: 1,
    ...nulls("decided_at", "closed_at"),
  },
  deliveries: NOT_DELIVERED,
};

type Given = { type: string; seq: number; now: number; at: string; env: Environment; rules: Rules };
/** One input being decided: what holds throughout, and the view with its changes so far. */
type Draft = Given & { view: View; changes: Change[] };

export function decide(view: View, input: Input, now: number, env: Environment): { facts: Fact[]; value: any } {
  const { type, args } = input;
  if (!Object.hasOwn(HANDLERS, type)) throw new InputError(`不认识的输入：${type}`);
  const rules = configuration(view);
  const draft: Draft = { view: view.fork(), seq: view.seq + 1, type, now, at: iso(now), env, rules, changes: [] };
  const value = HANDLERS[type](draft, ...args);
  const due = deadlines(draft.view, now);
  for (const [key, row] of Object.entries(due)) {
    if (JSON.stringify(draft.view.get("due", key)) !== JSON.stringify(row)) put(draft, "due", key, row);
  }
  for (const { kind, key: name } of rows(draft.view, "due")) {
    const key = `${kind}:${name}`;
    if (!due[key]) set(draft, "due", key, null);
  }
  return { facts: draft.changes.length ? [factOf(draft, draft.changes)] : [], value };
}

function factOf({ seq, now, type }: Draft, changes: Change[]): Fact {
  return { version: 1, seq, at: now, type, changes };
}

function set(draft: Draft, table: Table, key: string | number, row: Row | null) {
  const change = { table, key: String(key), row };
  draft.changes.push(change);
  draft.view.set(table, String(key), row);
  return row!;
}

const put = (draft: Draft, table: Table, key: string | number, fields: Row) =>
  set(draft, table, key, { ...DEFAULTS[table], ...draft.view.get(table, key), ...fields });

function add(draft: Draft, table: Table, fields: Row) {
  const id = (draft.view.next[table] ?? 0) + 1;
  return put(draft, table, id, { ...fields, id });
}

const ruleNamed = (draft: Draft, name: string) => draft.rules.rules.find((rule) => rule.name === name);
const ruleForRun = (draft: Draft, run: Row) =>
  configuration(draft.view, run.rules_version).rules.find((rule) => rule.name === run.rule);
function assignQueued(draft: Draft, run: Row) {
  if (run.task_id) return;
  const config = draft.view.get("config", "rules")!;
  const rule = (config.value as Rules).rules.find((rule) => rule.name === run.rule);
  if (!rule) return;
  const session = rule.to === run.agent ? {} : nulls("session", "resume");
  put(draft, "runs", run.id, { agent: rule.to, rules_version: config.version, ...session });
}
const threadOf = (run: Row) => ({ rule: run.rule, lane: run.lane, grp: run.grp });
const hopsOf = (draft: Draft, run: Row) => Math.max(0, ...eventsOf(draft.view, run.id).map((event) => event.hops ?? 0));

function closeCard(draft: Draft, card: Row, result: string, by: string | null = null) {
  const closed = { state: "closed", closed_at: draft.at, version: card.version + 1 };
  put(draft, "cards", card.id, { ...closed, result, by: by ?? card.by });
}

function closeOpen(draft: Draft, matches: (key: string) => boolean, result: string) {
  const open = rows(draft.view, "cards", { state: "open" }).filter((card) => matches(card.key));
  for (const card of open) closeCard(draft, card, result);
}

const closeOffline = (draft: Draft, worker: string) =>
  closeOpen(draft, (key) => key.startsWith(`worker:${worker}:offline:`), "连上了");

function createCard(draft: Draft, spec: Row) {
  const cards = rows(draft.view, "cards", { key: spec.key, ...(!spec.once && { state: "open" }) }, 1, true);
  const existing = cards.findLast((card) => card.key === spec.key && (spec.once || card.state === "open"));
  if (existing) return { card: existing.id, duplicate: true };
  const { once, run, options, fyi, quiet, ...fields } = spec;
  const stored = {
    run_id: run ?? null,
    options: JSON.stringify(options ?? []),
    fyi: fyi ? 1 : 0,
    quiet: quiet ? 1 : 0,
  };
  const card = add(draft, "cards", { ...fields, ...stored, state: fyi ? "closed" : "open", created_at: draft.at });
  return { card: card.id, duplicate: false };
}

const notify = (draft: Draft, key: string, title: string, text: string, extra: Row = {}) =>
  createCard(draft, { key, kind: "notice", title, text, ...extra });

/** A queued run of this rule and subject takes the event, so what comes in while it waits is handled together. */
function enqueue(draft: Draft, rule: Rule, event: number, subject: string, resume?: string | null) {
  const lane = rule.parallel ? subject : "";
  const rulesVersion = draft.view.get("config", "rules")!.version;
  const stamps = { not_before: draft.at, created_at: draft.at, rules_version: rulesVersion };
  const isSameQueued = (run: Row) => run.rule === rule.name && run.lane === lane && run.state === "queued";
  const run =
    rows(draft.view, "runs", { rule: rule.name, lane, state: "queued" }).find(isSameQueued) ??
    add(draft, "runs", { rule: rule.name, agent: rule.to, grp: rule.group, lane, state: "queued", ...stamps });
  put(draft, "run_events", `${run.id}:${event}`, { run_id: run.id, event_id: event });
  if (resume) put(draft, "runs", run.id, { resume });
}

function routeSnapshot(rules: Rules, workflowName: string) {
  const workflow = rules.workflows[workflowName];
  return Object.fromEntries(
    Object.entries(workflow.stages).map(([stageId, stage]) => {
      const rule = rules.rules.find((candidate) => candidate.name === stage.route)!;
      return [stageId, { rule, agent_id: rule.to, agent: rules.agents[rule.to] }];
    }),
  );
}

function workflowIntake(draft: Draft, source: string, type: string) {
  return draft.rules.rules.filter(
    (rule) => rule.workflow && eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, type),
  );
}

function canEnqueueTaskStage(task: Row, stageId: string, transitions = task.transitions) {
  const workflow = JSON.parse(task.workflow);
  const stage = workflow.stages[stageId];
  const visits = JSON.parse(task.visits);
  return !!stage && transitions < workflow.max_transitions && (visits[stageId] ?? 0) < stage.max_visits;
}

function nextTaskInput(draft: Draft, task: Row): [string | null, "task_ref" | null] {
  const execution = draft.view.get("stage_executions", task.current_execution);
  return execution && execution.generation === task.generation && execution.input_resolution === "task_ref"
    ? [execution.input_revision, "task_ref"]
    : [task.current_revision, null];
}

function enqueueTaskStage(
  draft: Draft,
  task: Row,
  stageId: string,
  inputRevision: string | null,
  inputResolution: "task_ref" | null = null,
) {
  const workflow = JSON.parse(task.workflow);
  const stage = workflow.stages[stageId];
  if (!stage) throw new Conflict(`任务的 stage 不存在：${stageId}`);
  const visits = JSON.parse(task.visits) as Record<string, number>;
  const nextVisit = (visits[stageId] ?? 0) + 1;
  if (!canEnqueueTaskStage(task, stageId)) return false;
  const rules = configuration(draft.view, task.rules_version);
  const rule = rules.rules.find((candidate) => candidate.name === stage.route);
  if (!rule) throw new Conflict(`任务冻结的 route 不存在：${stage.route}`);
  const priorSession = rows(draft.view, "runs", { task_id: task.task_id })
    .filter((candidate) => {
      const prior = draft.view.get("stage_executions", candidate.execution_id);
      return (
        candidate.rules_version === task.rules_version &&
        candidate.agent === rule.to &&
        candidate.rule === rule.name &&
        prior &&
        workflow.stages[prior.stage_id]?.mode === stage.mode &&
        typeof candidate.session === "string" &&
        candidate.session.trim() !== ""
      );
    })
    .at(-1)?.session;
  const sequence = task.execution_count + 1;
  const executionId = `${task.task_id}:g${task.generation}:e${sequence}`;
  const run = add(draft, "runs", {
    rule: rule.name,
    agent: rule.to,
    grp: rule.group,
    lane: task.task_id,
    state: "queued",
    not_before: draft.at,
    created_at: draft.at,
    rules_version: task.rules_version,
    task_id: task.task_id,
    execution_id: executionId,
    ...(priorSession ? { resume: priorSession } : {}),
  });
  put(draft, "stage_executions", executionId, {
    execution_id: executionId,
    task_id: task.task_id,
    generation: task.generation,
    sequence,
    stage_id: stageId,
    run_id: run.id,
    request_id: executionId,
    state: "queued",
    input_revision: inputRevision,
    input_resolution: inputResolution,
    created_at: draft.at,
  });
  put(draft, "project_tasks", task.task_id, {
    state: "queued",
    current_stage: stageId,
    current_execution: executionId,
    execution_count: sequence,
    visits: JSON.stringify({ ...visits, [stageId]: nextVisit }),
    updated_at: draft.at,
  });
  return true;
}

function submitProjectTask(draft: Draft, source: string, given: unknown, selectedRule?: Rule) {
  if (!draft.rules.sources[source]) throw new InputError(`没有这个来源：${source}`);
  const input = parseProjectTaskInput(given);
  const hash = digest(canonicalProjectTask(input));
  const taskId = `task_${digest(`project-task\0${source}\0${input.id}`).slice(0, 32)}`;
  const existing = draft.view.get("project_tasks", taskId);
  if (existing) {
    if (existing.source !== source || existing.source_id !== input.id || existing.input_hash !== hash) {
      throw new Conflict("同一来源的任务编号已经提交过不一样的内容");
    }
    return { task_id: taskId, duplicate: true };
  }
  const candidates = selectedRule ? [selectedRule] : workflowIntake(draft, source, input.type);
  if (candidates.length !== 1 || !candidates[0].workflow) {
    throw new InputError(candidates.length ? "项目任务匹配了不止一个可信工作流" : "没有匹配这个来源和类型的可信工作流");
  }
  const intake = candidates[0];
  const workflowName = intake.workflow!;
  const workflow = draft.rules.workflows[workflowName];
  const rulesVersion = draft.view.get("config", "rules")!.version;
  const task = put(draft, "project_tasks", taskId, {
    task_id: taskId,
    source,
    source_id: input.id,
    input_hash: hash,
    input: JSON.stringify(input),
    workflow_name: workflowName,
    workflow: JSON.stringify(workflow),
    routes: JSON.stringify(routeSnapshot(draft.rules, workflowName)),
    rules_version: rulesVersion,
    state: "queued",
    generation: 1,
    transitions: 0,
    visits: "{}",
    execution_count: 0,
    created_at: draft.at,
    updated_at: draft.at,
  });
  if (!enqueueTaskStage(draft, task, workflow.entry, null)) throw new Conflict("工作流入口已经超过访问上限");
  return { task_id: taskId, duplicate: false };
}

/** Keeps an event under a key of its own: one the hub makes up mustn't collide with one a source sent. */
function recordEvent(draft: Draft, source: string, event: Row, routed: string[]): number {
  let key = event.id;
  for (let suffix = 1; rows(draft.view, "events", { source, key }).length; suffix++) {
    key = `${event.id}:${suffix}`;
  }
  return add(draft, "events", {
    source,
    key,
    type: event.type,
    subject: event.subject ?? "",
    summary: event.summary ?? "",
    detail: event.detail ?? "",
    link: event.link ?? "",
    hops: event.hops ?? 0,
    routed: JSON.stringify(routed),
    received_at: draft.at,
  }).id;
}

function ingest(draft: Draft, source: string, given: unknown) {
  const event = parseEvent(given);
  const existing = rows(draft.view, "events", { source, key: event.id })[0];
  if (existing) return { event: existing.id, duplicate: true, routed: JSON.parse(existing.routed) };
  const tooDeep = event.hops > MAX_HOPS;
  const takes = (rule: Rule) =>
    !rule.workflow && eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, event.type);
  const matched = tooDeep ? [] : draft.rules.rules.filter(takes);
  const routed = matched.map((rule) => rule.name);
  const id = recordEvent(draft, source, event, routed);
  if (tooDeep) {
    const words = `同一条处理链已超过 ${MAX_HOPS} 层，后续事件已记录，没有继续派发。`;
    notify(draft, `hops:${source}:${event.id}`, "事件循环已停止", words, { once: true });
  }
  for (const rule of matched) enqueue(draft, rule, id, event.subject);
  return { event: id, duplicate: false, routed };
}

function heldRun(draft: Draft, id: number, token: string, states: string[]) {
  const run = draft.view.get("runs", id);
  const issued = run && states.includes(run.state) && run.issued !== null;
  if (!issued || credential(draft.env, "run", id, run.issued) !== token) throw new AuthError("这件活不归这个令牌");
  return run;
}

function checkTaskSession(run: Row, session: string | undefined) {
  if (
    run.task_id &&
    run.session !== null &&
    run.session !== undefined &&
    session !== undefined &&
    session !== run.session
  ) {
    throw new Conflict("任务执行的 native session 已经固定");
  }
}

function cardFromReceipt(draft: Draft, run: Row, kind: string, card: Row) {
  const name = card.key ?? digest(`${card.title}\n${card.text}`).slice(0, 32);
  const session = draft.view.get("runs", run.id)!.session;
  const quiet = kind === "notice" && ruleNamed(draft, run.rule)?.tell === "never";
  const origin = { source: sourceOf(draft.view, run.id), agent: run.agent, session, run: run.id };
  const key = `thread:${run.rule}:${run.lane}:${name}`;
  createCard(draft, { ...card, hops: hopsOf(draft, run), key, kind, quiet, ...threadOf(run), ...origin });
}

/** Notices what has gone quiet: a worker that stopped coming, a run its worker stopped mentioning. */
function sweep(draft: Draft) {
  const { now } = draft;
  for (const worker of workers(draft.view)) {
    const seen = draft.view.get("seen", `worker:${worker}`);
    const lastSeen = seen ? Date.parse(seen.seen_at) : undefined;
    if (lastSeen !== undefined && now - lastSeen <= WORKER_FRESH) {
      closeOffline(draft, worker);
      const inDoubt = (run: Row) =>
        run.state === "claimed" && workerOf(draft.view, run) === worker && Date.parse(run.seen_at) < now - RUN_LEASE;
      for (const run of rows(draft.view, "runs", { state: "claimed" }).filter(inDoubt)) {
        put(draft, "runs", run.id, { state: "unknown" });
        if (run.task_id) {
          put(draft, "stage_executions", run.execution_id, { state: "unknown" });
          put(draft, "project_tasks", run.task_id, { state: "unknown", updated_at: draft.at });
        }
        const agent = configuration(draft.view, run.rules_version).agents[run.agent].name;
        const words = `交给 ${agent} 后超过 5 分钟没有回音，不确定做没做完；后续新任务照常处理。`;
        notify(draft, `run:${run.id}:unknown`, run.rule, words, threadOf(run));
      }
    }
    const waiting = waitingOn(draft.view, worker, now);
    if (!waiting.length) continue;
    const since = now - (lastSeen ?? Date.parse(waiting[0].created_at));
    if (since <= OFFLINE_AFTER) continue;
    const minutes = Math.floor(since / MINUTE);
    const neverSeen = lastSeen === undefined;
    const situation = neverSeen
      ? `${worker} 一直没连上中台，有 ${waiting.length} 件任务等了 ${minutes} 分钟没人接`
      : `${worker} 已经 ${minutes} 分钟没连上中台，有 ${waiting.length} 件任务在排队或在跑`;
    const check = neverSeen ? "有没有开机联网" : "是不是关机、休眠或断网了";
    const key = `worker:${worker}:offline:${neverSeen ? "never" : iso(lastSeen)}`;
    notify(draft, key, "接单程序没连上", `${situation}（请看一眼那台电脑${check}）。`);
  }
}

function claimNext(draft: Draft, worker: string, claim: string) {
  const agents = agentsOf(draft.view, worker);
  const runs = rows(draft.view, "runs", { state: ["queued", "claimed"] });
  const claimed = runs.filter((run) => run.state === "claimed");
  const groupLimit = (run: Row) => ruleForRun(draft, run)?.parallel ?? 1;
  const claimable = (run: Row) =>
    run.state === "queued" &&
    (run.task_id ? workerOf(draft.view, run) === worker : agents.includes(ruleNamed(draft, run.rule)?.to ?? "")) &&
    Date.parse(run.not_before) <= draft.now &&
    (run.task_id ? ruleForRun(draft, run) : ruleNamed(draft, run.rule)) &&
    !claimed.some((other) => other.grp === run.grp && other.lane === run.lane) &&
    claimed.filter((other) => other.grp === run.grp).length < groupLimit(run);
  // The same claim again means the answer got lost: it gets back the run it already has.
  const held = claimed.find((run) => run.claim === claim && workerOf(draft.view, run) === worker);
  const run = held ?? runs.find(claimable);
  if (!run) return null;
  if (!held) assignQueued(draft, run);
  const since = held ? { claimed_at: run.claimed_at, link: run.link } : { claimed_at: draft.at, link: null };
  const rules_version = held || run.task_id ? run.rules_version : draft.view.get("config", "rules")!.version;
  const claiming = { state: "claimed", claim, issued: draft.seq, seen_at: draft.at, rules_version, ...since };
  put(draft, "runs", run.id, { ...claiming, ...nulls("last_issued", "last_result", "last_answer") });
  if (run.execution_id) put(draft, "stage_executions", run.execution_id, { state: "claimed" });
  if (run.task_id) put(draft, "project_tasks", run.task_id, { state: "running", updated_at: draft.at });
  return jobOf(draft.view, draft.view.get("runs", run.id)!, draft.env);
}

/** A run that didn't get through waits to try again, and takes along whatever came in for the same thing meanwhile. */
function retryLater(draft: Draft, run: Row, result: Result) {
  const { id } = run;
  const attempts = run.attempts + 1;
  const notBefore = draft.now + Math.min(5 * MINUTE * 2 ** (attempts - 1), 60 * MINUTE);
  const error = (result.error ?? "").trim().replace(/[。.]+$/, "") || "没说原因";
  const unclaimed = nulls("claim", "claimed_at", "seen_at", "cancel_at");
  put(draft, "runs", id, { state: "queued", attempts, not_before: iso(notBefore), error, ...unclaimed });
  const sameThread = (other: Row) => other.id !== id && other.rule === run.rule && other.lane === run.lane;
  for (const other of rows(draft.view, "runs", { rule: run.rule, lane: run.lane, state: "queued" }).filter(
    sameThread,
  )) {
    for (const link of rows(draft.view, "run_events", { run_id: other.id })) {
      put(draft, "run_events", `${id}:${link.event_id}`, { run_id: id, event_id: link.event_id });
      set(draft, "run_events", `${other.id}:${link.event_id}`, null);
    }
    set(draft, "runs", other.id, null);
    if (other.resume) put(draft, "runs", id, { resume: other.resume });
  }
  const rejected: Rejected[] = [];
  for (const what of ["ask", "resolve", "later", "events"] as const) {
    for (const _ of result[what] ?? []) rejected.push({ what, reason: "没跑成的一轮只能发通知" });
  }
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice);
  if (!result.notice?.length && attempts === 3) {
    const clock = { timeZone: draft.rules.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const time = new Intl.DateTimeFormat("zh-CN", clock).format(notBefore);
    const words = `连续 3 次自动处理没跑完（卡在：${error}），${time} 会自动再试。`;
    notify(draft, `run:${id}:failing`, run.rule, words, threadOf(run));
  }
  assignQueued(draft, draft.view.get("runs", id)!);
  return rejected;
}

function scheduleReview(draft: Draft, run: Row, later: Later) {
  const { rule, lane } = run;
  const existing = rows(draft.view, "timers", { rule, lane, key: later.key, event_id: null }).find(
    (timer) => timer.rule === rule && timer.lane === lane && timer.key === later.key && timer.event_id === null,
  );
  if (later.cancel) {
    if (existing) set(draft, "timers", existing.id, null);
    return;
  }
  const session = draft.view.get("runs", run.id)!.session;
  const fields = { at: iso(Date.parse(later.at!)), about: later.about, session, hops: hopsOf(draft, run) };
  if (existing) return void put(draft, "timers", existing.id, fields);
  const source = sourceOf(draft.view, run.id) ?? SCHEDULE;
  add(draft, "timers", { ...fields, rule, lane, key: later.key, source, event_id: null, created_at: draft.at });
}

/** A receipt takes effect here, all of it in the one fact. */
function applyReceipt(draft: Draft, run: Row, result: Result) {
  const { id } = run;
  const rule = ruleNamed(draft, run.rule);
  const summary = result.summary ?? "";
  const rejected: Rejected[] = [];
  put(draft, "runs", id, { state: result.outcome, finished_at: draft.at, summary, error: null, cancel_at: null });
  closeOpen(draft, (key) => key === `run:${id}:failing`, "后来跑成了");
  closeOpen(draft, (key) => key === `run:${id}:unknown`, "结果回来了");
  const eventIds = eventsOf(draft.view, id).map((event) => event.id);
  const isAnswered = (card: Row) => card.state === "decided" && eventIds.includes(card.answer_event);
  for (const card of rows(draft.view, "cards", { answer_event: eventIds, state: "decided" }).filter(isAnswered)) {
    put(draft, "cards", card.id, { state: "done", result: summary, closed_at: draft.at, version: card.version + 1 });
  }
  for (const item of result.resolve ?? []) {
    const card = openInScope(draft.view, run).find((card) => card.id === item.card);
    if (card) closeCard(draft, card, item.reason.trim(), `第 ${id} 轮`);
    else rejected.push({ card: item.card, reason: "不在本轮核对范围" });
  }
  for (const ask of result.ask ?? []) cardFromReceipt(draft, run, "ask", ask);
  for (const notice of result.notice ?? []) cardFromReceipt(draft, run, "notice", notice);
  if (rule?.tell === "always" && result.outcome === "done") {
    const once = { fyi: true, once: true, ...threadOf(run), source: sourceOf(draft.view, id), run: id };
    notify(draft, `run:${id}:done`, run.rule, summary, once);
  }
  for (const later of result.later ?? []) scheduleReview(draft, run, later);
  for (const event of result.events ?? []) {
    if (rule?.emits && typeMatches(rule.emits.types, event.type)) {
      ingest(draft, rule.emits.source, { ...event, hops: hopsOf(draft, run) + 1 });
    } else rejected.push({ what: "events", reason: `规则「${run.rule}」没有写可以发 ${event.type}` });
  }
  return rejected;
}

function taskDecisionCard(draft: Draft, task: Row, execution: Row, reason: string, detail = "") {
  const workflow = JSON.parse(task.workflow);
  const input = JSON.parse(task.input) as ProjectTaskInput;
  const options = workflow.human.options.map((option: { label: string }) => option.label);
  const explanation =
    reason === "late_outcome"
      ? "取消或不确定期间收到了真实终态，已保留结果但没有继续推进。"
      : reason === "operator_attested"
        ? "这次执行由 operator_attested 人工核实停止，未自动重试。"
        : reason === "budget_exhausted"
          ? "工作流的累计访问或转换上限已经用完，不会自动扩大上限。"
          : "当前阶段已结束，需要本人选择下一步。";
  const card = createCard(draft, {
    key: `task:${task.task_id}:decision:${task.generation}:${execution.execution_id}:${reason}`,
    kind: "ask",
    title: `项目任务 ${input.id} 需要决定`,
    text: [explanation, detail].filter(Boolean).join("\n"),
    options,
    about: `任务 ${task.task_id}，阶段 ${execution.stage_id}，当前版本 ${task.current_revision ?? "尚未确定"}`,
    task_id: task.task_id,
    task_generation: task.generation,
    task_execution: execution.execution_id,
    task_revision: task.current_revision,
    task_reason: reason,
    task_actions: JSON.stringify(workflow.human.options),
    source: task.source,
    created_at: draft.at,
  });
  put(draft, "project_tasks", task.task_id, { state: "waiting_human", human_card: card.card, updated_at: draft.at });
  return card.card;
}

function validCompletion(configured: any, stage: StageResult, revision: string | null) {
  if (stage.verdict !== "verified" || !revision) return false;
  if (stage.findings.some((finding) => finding.severity === "blocking")) return false;
  if (stage.input_revision !== revision || stage.output_revision !== revision) return false;
  if (stage.artifacts.some((artifact) => artifact.revision !== revision)) return false;
  return configured.checks.every((required: { name: string }) =>
    stage.checks.some((check) => check.name === required.name && check.exit_code === 0 && check.revision === revision),
  );
}

function taskResult(draft: Draft, run: Row, given: unknown) {
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new InputError("结果要是一个 JSON 对象");
  const raw = { ...(given as Record<string, unknown>) };
  const stage = parseStageResult(raw.stage);
  delete raw.stage;
  const result = parseResult(raw);
  if (result.outcome !== "done" && result.outcome !== "nothing") {
    throw new InputError("任务阶段要以 done 或 nothing 结束，并提交 stage verdict");
  }
  if ([result.ask, result.notice, result.resolve, result.later, result.events].some((items) => items?.length)) {
    throw new InputError("任务阶段不能提交 ask、notice、resolve、later 或 events；工作流负责推进");
  }
  const task = draft.view.get("project_tasks", run.task_id);
  const execution = draft.view.get("stage_executions", run.execution_id);
  if (!task || !execution || task.current_execution !== execution.execution_id || execution.run_id !== run.id) {
    throw new Conflict("这不是任务当前的阶段执行");
  }
  checkTaskSession(run, result.session);
  if (result.session && !run.session) put(draft, "runs", run.id, { session: result.session });
  if (stage.execution_id !== execution.execution_id || stage.request_id !== execution.request_id) {
    throw new Conflict("stage 的 execution_id 或 request_id 不属于这次执行");
  }
  const workflow = JSON.parse(task.workflow);
  const configured = workflow.stages[execution.stage_id];
  if (!configured || !Object.hasOwn(configured.on, stage.verdict)) {
    throw new InputError(`stage ${execution.stage_id} 不接受 verdict ${stage.verdict}`);
  }
  if (
    (stage.verdict === "approved" || stage.verdict === "verified") &&
    stage.findings.some((finding) => finding.severity === "blocking")
  ) {
    throw new InputError(`${stage.verdict} 不能同时包含 blocking finding`);
  }
  const unpinned = execution.input_resolution === "task_ref" && execution.input_revision === null;
  const preAdmissionFailure =
    unpinned &&
    stage.verdict === "execution_failed" &&
    stage.input_revision === undefined &&
    stage.output_revision === undefined &&
    stage.remote_ref === undefined &&
    stage.remote_run_id === undefined &&
    stage.resolution === undefined &&
    stage.artifacts.length === 0 &&
    stage.checks.length === 0 &&
    !execution.started_at &&
    !run.session &&
    run.state !== "unknown";
  if (unpinned && !preAdmissionFailure) throw new Conflict("复查要先用 started 固定 input_revision，才能提交阶段结果");
  const acceptedInput = unpinned ? null : (execution.input_revision ?? stage.input_revision ?? task.current_revision);
  if (execution.input_revision && stage.input_revision !== execution.input_revision) {
    throw new Conflict("stage 的 input_revision 和已接受版本不一致");
  }
  if (!preAdmissionFailure && task.current_revision && acceptedInput !== task.current_revision) {
    throw new Conflict("stage 的 input_revision 不是任务当前版本");
  }
  if (configured.mode === "inspect" && stage.output_revision && stage.output_revision !== acceptedInput) {
    throw new Conflict("inspect stage 不能改变版本");
  }
  const outputRevision = stage.output_revision ?? acceptedInput ?? null;
  if (run.cancel_at && stage.resolution) {
    const resolved = {
      ...stage,
      input_revision: acceptedInput ?? undefined,
      output_revision: outputRevision ?? undefined,
    };
    put(draft, "stage_executions", execution.execution_id, {
      state: "resolved",
      input_revision: acceptedInput,
      output_revision: outputRevision,
      verdict: stage.verdict,
      result: JSON.stringify(resolved),
      finished_at: draft.at,
    });
    put(draft, "runs", run.id, {
      state: "cancelled",
      finished_at: draft.at,
      summary: result.summary ?? "",
      error: null,
      cancel_at: null,
    });
    put(draft, "project_tasks", task.task_id, {
      state: "cancelled",
      completed_at: draft.at,
      updated_at: draft.at,
      resolution: JSON.stringify(stage.resolution),
    });
    notify(
      draft,
      `task:${task.task_id}:operator-attested-cancel`,
      "项目任务已按人工核实取消",
      `operator_attested: ${stage.resolution.reason}`,
      { once: true, source: task.source },
    );
    return { result, stage: resolved };
  }
  if (run.cancel_at) {
    const late = { result, stage, received_at: draft.at };
    const outcomes = JSON.parse(task.late_outcomes ?? "[]");
    put(draft, "stage_executions", execution.execution_id, {
      state: "late",
      input_revision: acceptedInput,
      output_revision: outputRevision,
      verdict: stage.verdict,
      result: JSON.stringify(stage),
      finished_at: draft.at,
    });
    put(draft, "runs", run.id, {
      state: result.outcome,
      finished_at: draft.at,
      summary: result.summary ?? "",
      error: null,
      cancel_at: null,
    });
    put(draft, "project_tasks", task.task_id, {
      late_outcomes: JSON.stringify([...outcomes, late]),
      updated_at: draft.at,
    });
    taskDecisionCard(draft, draft.view.get("project_tasks", task.task_id)!, execution, "late_outcome");
    return { result, stage };
  }
  const transitions = task.transitions + 1;
  const target = configured.on[stage.verdict];
  if (!preAdmissionFailure && target === "$complete" && !validCompletion(configured, stage, outputRevision)) {
    throw new InputError("只有 verified、精确当前版本和全部通过的配置检查才能完成任务");
  }
  const finished = {
    ...stage,
    input_revision: acceptedInput ?? undefined,
    output_revision: outputRevision ?? undefined,
  };
  // The adapter attests the immutable output locator. The same fact adopts that output and ends task-ref resolution.
  const acceptedWrite = configured.mode === "write" && stage.output_revision && stage.remote_ref && !stage.resolution;
  put(draft, "stage_executions", execution.execution_id, {
    state: "finished",
    input_revision: acceptedInput,
    input_resolution: acceptedWrite ? null : execution.input_resolution,
    output_revision: outputRevision,
    verdict: stage.verdict,
    result: JSON.stringify(finished),
    finished_at: draft.at,
  });
  put(draft, "runs", run.id, {
    state: result.outcome,
    finished_at: draft.at,
    summary: result.summary ?? "",
    error: null,
    cancel_at: null,
  });
  put(draft, "project_tasks", task.task_id, {
    transitions,
    current_revision: preAdmissionFailure ? task.current_revision : outputRevision,
    updated_at: draft.at,
  });
  const current = draft.view.get("project_tasks", task.task_id)!;
  if (preAdmissionFailure) {
    taskDecisionCard(draft, current, execution, "execution_failed");
  } else if (transitions > workflow.max_transitions) {
    taskDecisionCard(draft, current, execution, "budget_exhausted");
  } else if (target === "$complete") {
    put(draft, "project_tasks", task.task_id, { state: "completed", completed_at: draft.at });
  } else if (target === "$failed") {
    put(draft, "project_tasks", task.task_id, { state: "failed", completed_at: draft.at });
  } else if (target === "$human") {
    taskDecisionCard(
      draft,
      current,
      execution,
      stage.resolution ? "operator_attested" : stage.verdict,
      stage.resolution ? `${stage.resolution.kind}: ${stage.resolution.reason}` : "",
    );
  } else if (!enqueueTaskStage(draft, current, target, ...nextTaskInput(draft, current))) {
    taskDecisionCard(draft, current, execution, "budget_exhausted");
  }
  return { result, stage: finished };
}

function cancelledTaskResult(draft: Draft, run: Row, given: unknown) {
  const result = parseResult(given);
  checkTaskSession(run, result.session);
  if (result.outcome !== "cancelled") throw new InputError("不是取消结果");
  if (result.stage) throw new InputError("已确认取消不能带 stage；真实终态要用 done 提交为迟到结果");
  if ([result.ask, result.notice, result.resolve, result.later, result.events].some((items) => items?.length)) {
    throw new InputError("取消结果不能带通用回执动作");
  }
  const task = draft.view.get("project_tasks", run.task_id);
  const execution = draft.view.get("stage_executions", run.execution_id);
  if (!task || !execution) throw new Conflict("没有这次任务执行");
  put(draft, "stage_executions", execution.execution_id, {
    state: "cancelled",
    finished_at: draft.at,
  });
  put(draft, "runs", run.id, {
    state: "cancelled",
    finished_at: draft.at,
    summary: result.summary ?? "",
    error: null,
    cancel_at: null,
  });
  put(draft, "project_tasks", task.task_id, {
    state: "cancelled",
    completed_at: draft.at,
    updated_at: draft.at,
  });
  return { result };
}

function finish(draft: Draft, id: number, token: string, given: unknown) {
  const hash = digest(JSON.stringify(given ?? null));
  const prior = draft.view.get("runs", id);
  // The same execution handing in again means the answer got lost: it gets the same answer, and nothing happens twice.
  if (prior && prior.last_issued !== null && credential(draft.env, "run", id, prior.last_issued) === token) {
    if (prior.last_result !== hash) throw new Conflict("这一次执行已经交过不一样的结果");
    return { rejected: JSON.parse(prior.last_answer ?? "[]"), duplicate: true };
  }
  const run = heldRun(draft, id, token, ["claimed", "unknown"]);
  const parsedTask = run.task_id
    ? (given as Record<string, unknown> | null)?.outcome === "cancelled"
      ? cancelledTaskResult(draft, run, given)
      : taskResult(draft, run, given)
    : undefined;
  const result = parsedTask?.result ?? parseResult(given);
  if (!run.task_id && result.stage) throw new InputError("普通结果不能带 stage");
  const session = result.session ?? run.session;
  const usage = result.usage
    ? JSON.stringify(addUsage(run.usage ? JSON.parse(run.usage) : undefined, result.usage))
    : run.usage;
  put(draft, "runs", id, { last_issued: run.issued, last_result: hash, issued: null, session, usage });
  let rejected: Rejected[] = [];
  if (parsedTask) {
    // taskResult atomically recorded the receipt and next workflow state above.
  } else if (result.outcome === "failed") rejected = retryLater(draft, run, result);
  else if (result.outcome === "cancelled") {
    put(draft, "runs", id, {
      state: "cancelled",
      finished_at: draft.at,
      summary: result.summary ?? "",
      cancel_at: null,
    });
  } else rejected = applyReceipt(draft, run, result);
  put(draft, "runs", id, { last_answer: JSON.stringify(rejected) });
  return { rejected };
}

function answerTaskCard(draft: Draft, card: Row, given: Row) {
  const task = draft.view.get("project_tasks", card.task_id);
  const current =
    task &&
    task.state === "waiting_human" &&
    task.human_card === card.id &&
    task.generation === card.task_generation &&
    task.current_execution === card.task_execution &&
    task.current_revision === card.task_revision;
  if (!current) return { changed: false, state: card.state };
  if (given.choice === undefined) {
    if (typeof given.text !== "string" || !given.text.trim()) throw new InputError("回答要是非空文字或一个选项");
    if (card.answer !== null) return { changed: false, state: "open" };
    put(draft, "cards", card.id, {
      answer: given.text.trim(),
      by: given.by ?? null,
      answer_by: given.by ?? null,
      answered_at: draft.at,
      version: card.version + 1,
    });
    return { changed: true, state: "open" };
  }
  const actions = JSON.parse(card.task_actions);
  if (!Number.isInteger(given.choice) || given.choice < 0 || given.choice >= actions.length) {
    throw new InputError("没有这个选项");
  }
  const action = actions[given.choice];
  const target = action.action === "resume" ? action.stage : task.current_stage;
  if (action.action === "resume" || action.action === "retry") {
    if (!canEnqueueTaskStage(task, target, task.transitions + 1)) {
      throw new Conflict("工作流累计上限已经用完，人工选择不能扩大上限");
    }
  }
  const decision = {
    state: "decided",
    choice: given.choice,
    by: given.by ?? null,
    decided_at: draft.at,
    version: card.version + 1,
  };
  put(draft, "cards", card.id, decision);
  if (action.action === "fail") {
    put(draft, "project_tasks", task.task_id, {
      state: "failed",
      human_card: null,
      completed_at: draft.at,
      updated_at: draft.at,
    });
  } else if (action.action === "cancel") {
    put(draft, "project_tasks", task.task_id, {
      state: "cancelled",
      human_card: null,
      completed_at: draft.at,
      updated_at: draft.at,
    });
  } else {
    put(draft, "project_tasks", task.task_id, {
      transitions: task.transitions + 1,
      human_card: null,
      updated_at: draft.at,
    });
    const current = draft.view.get("project_tasks", task.task_id)!;
    enqueueTaskStage(draft, current, target, ...nextTaskInput(draft, current));
  }
  return { changed: true, state: "decided" };
}

function taskMutation(task: Row, kind: string, given: unknown) {
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new InputError("请求要是 JSON 对象");
  const fields = Object.keys(given);
  if (fields.length !== 1 || fields[0] !== "request_id") throw new InputError("请求只能有 request_id");
  const requestId = (given as Row).request_id;
  if (typeof requestId !== "string" || !requestId.trim() || [...requestId].length > 200) {
    throw new InputError("request_id 必填，最多 200 个字");
  }
  const hash = digest(JSON.stringify({ kind, request_id: requestId }));
  const requests = JSON.parse(task.requests ?? "{}") as Record<string, { hash: string; answer: Row }>;
  const previous = requests[requestId];
  if (previous && previous.hash !== hash) throw new Conflict("同一个 request_id 已经用于另一个请求");
  return { requestId, hash, requests, previous };
}

function rememberTaskMutation(
  draft: Draft,
  taskId: string,
  requestId: string,
  hash: string,
  requests: Record<string, { hash: string; answer: Row }>,
  answer: Row,
) {
  put(draft, "project_tasks", taskId, {
    requests: JSON.stringify({ ...requests, [requestId]: { hash, answer } }),
    updated_at: draft.at,
  });
}

function cancelTask(draft: Draft, task: Row) {
  const taskId = task.task_id;
  if (["completed", "failed", "cancelled"].includes(task.state)) throw new InputError("这个项目任务已经结束");
  const run = task.current_execution
    ? rows(draft.view, "runs", { execution_id: task.current_execution })[0]
    : undefined;
  const execution = task.current_execution ? draft.view.get("stage_executions", task.current_execution) : undefined;
  let state: string;
  if (task.state === "queued" || task.state === "waiting_human") {
    state = "cancelled";
    if (run?.state === "queued") put(draft, "runs", run.id, { state, finished_at: draft.at });
    if (execution && !["finished", "late", "resolved"].includes(execution.state)) {
      put(draft, "stage_executions", execution.execution_id, { state, finished_at: draft.at });
    }
    if (task.human_card) {
      const card = draft.view.get("cards", task.human_card);
      if (card?.state === "open") closeCard(draft, card, "任务已取消", "本人");
    }
    put(draft, "project_tasks", taskId, {
      state,
      human_card: null,
      completed_at: draft.at,
      updated_at: draft.at,
    });
  } else {
    state = "cancel_requested";
    if (!run || !["claimed", "unknown"].includes(run.state)) throw new Conflict("任务没有可确认停止的活动执行");
    put(draft, "runs", run.id, { cancel_at: run.cancel_at ?? draft.at });
    const observedState = run.state === "unknown" ? "unknown" : state;
    if (execution) put(draft, "stage_executions", execution.execution_id, { state: observedState });
    put(draft, "project_tasks", taskId, { state: observedState, updated_at: draft.at });
  }
  return { task_id: taskId, state };
}

function cancelProjectTask(draft: Draft, taskId: string, given: unknown) {
  const task = draft.view.get("project_tasks", taskId);
  if (!task) throw new NotFound("没有这个项目任务");
  const request = taskMutation(task, "cancel", given);
  if (request.previous) return { ...request.previous.answer, duplicate: true };
  const answer = cancelTask(draft, task);
  rememberTaskMutation(draft, taskId, request.requestId, request.hash, request.requests, answer);
  return { ...answer, duplicate: false };
}

function recheckProjectTask(draft: Draft, taskId: string, given: unknown) {
  const task = draft.view.get("project_tasks", taskId);
  if (!task) throw new NotFound("没有这个项目任务");
  const request = taskMutation(task, "recheck", given);
  if (request.previous) return { ...request.previous.answer, duplicate: true };
  if (task.state !== "completed") throw new Conflict("只有已完成且没有活动执行的任务能复查");
  const workflow = JSON.parse(task.workflow);
  if (!workflow.recheck) throw new InputError("这个工作流没有配置 recheck");
  if (!task.current_revision) throw new Conflict("任务还没有可复查的当前版本");
  const execution = draft.view.get("stage_executions", task.current_execution)!;
  const transitions = task.transitions + 1;
  if (!canEnqueueTaskStage(task, workflow.recheck, transitions)) {
    taskDecisionCard(draft, task, execution, "budget_exhausted");
    const answer = { task_id: taskId, generation: task.generation, state: "waiting_human" };
    rememberTaskMutation(draft, taskId, request.requestId, request.hash, request.requests, answer);
    return { ...answer, duplicate: false };
  }
  const generation = task.generation + 1;
  put(draft, "project_tasks", taskId, {
    state: "queued",
    generation,
    transitions,
    human_card: null,
    completed_at: null,
    updated_at: draft.at,
  });
  enqueueTaskStage(draft, draft.view.get("project_tasks", taskId)!, workflow.recheck, null, "task_ref");
  const answer = { task_id: taskId, generation, state: "queued" };
  rememberTaskMutation(draft, taskId, request.requestId, request.hash, request.requests, answer);
  return { ...answer, duplicate: false };
}

function answer(draft: Draft, id: number, given: Row) {
  const card = draft.view.get("cards", id);
  if (!card) throw new NotFound("没有这张卡片");
  if (given.channel !== undefined) {
    const allowed = draft.rules.channels[given.channel]?.answerers;
    if (allowed && !allowed.includes(given.by ?? "")) throw new AuthError("这个人不能回答这张卡片");
    const delivery = draft.view.get("deliveries", `${id}:${given.channel}`);
    if (!delivery?.ref || delivery.ref !== given.ref) throw new AuthError("不是发出去的那条消息");
  }
  if (card.state !== "open") return { changed: false, state: card.state };
  if (card.task_id) return answerTaskCard(draft, card, given);
  if (card.kind === "notice") {
    closeCard(draft, card, "已处理", given.by ?? null);
    return { changed: true, state: "closed" };
  }
  if (given.text !== undefined && typeof given.text !== "string") throw new InputError("回答要是文字");
  const text = given.text?.trim() || null;
  const optionCount = JSON.parse(card.options).length;
  const inRange = Number.isInteger(given.choice) && given.choice >= 0 && given.choice < optionCount;
  if (given.choice === undefined ? !text : !inRange) throw new InputError("没有这个选项");
  const rule = card.rule ? ruleNamed(draft, card.rule) : undefined;
  const { lane: subject, title: summary, hops = 0 } = card;
  const event = { id: `card:${id}`, type: "card.answered", subject, summary, hops };
  const eventId = recordEvent(draft, card.source ?? SCHEDULE, event, rule ? [rule.name] : []);
  const decision = { choice: given.choice ?? null, answer: text, by: given.by ?? null, decided_at: draft.at };
  put(draft, "cards", id, { state: "decided", ...decision, answer_event: eventId, version: card.version + 1 });
  if (rule) enqueue(draft, rule, eventId, card.lane, card.agent === rule.to ? card.session : null);
  return { changed: true, state: "decided" };
}

function nextCard(draft: Draft, channel: string) {
  const { now } = draft;
  for (const card of draft.view.deliveryCandidates(channel, now)) {
    const key = `${card.id}:${channel}`;
    const delivery = draft.view.get("deliveries", key) ?? NOT_DELIVERED;
    const recentNote = card.fyi && Date.parse(card.created_at) >= now - 24 * 60 * MINUTE;
    const worthSending = card.state === "open" || delivery.ref !== null || recentNote;
    const resting = delivery.not_before && Date.parse(delivery.not_before) > now;
    if (card.quiet || delivery.version >= card.version || delivery.given_up || resting || !worthSending) continue;
    const firstTry = delivery.first_try_at;
    if (delivery.tries >= RESEND_AT.length || (firstTry && now - Date.parse(firstTry) > RESEND_WINDOW)) {
      put(draft, "deliveries", key, { given_up: 1 });
      continue;
    }
    const attempt = { tries: delivery.tries + 1, first_try_at: firstTry ?? draft.at, not_before: iso(now + MINUTE) };
    put(draft, "deliveries", key, { card_id: card.id, channel, ...attempt });
    return cardView(card, draft.env, delivery.ref, draft.rules.channels[channel]?.links === true);
  }
  return null;
}

/** What the clock has brought: schedules come round, reviews come due, and anything gone quiet. */
function tick(draft: Draft) {
  const { now } = draft;
  const { rules, timezone } = draft.rules;
  for (const rule of rules) {
    if (eventRule(rule)) continue;
    const text = cronOf(rule);
    const cron = parseCron(text)!;
    const schedule = draft.view.get("schedules", rule.name);
    const nextAt = () => iso(nextRun(cron, now, timezone)!);
    if (!schedule || schedule.cron !== text) {
      put(draft, "schedules", rule.name, { rule: rule.name, cron: text, next_at: nextAt() });
      continue;
    }
    if (now < Date.parse(schedule.next_at)) continue;
    const key = `${rule.name}@${iso(latestBefore(cron, Date.parse(schedule.next_at), now, timezone))}`;
    if (!rows(draft.view, "events", { source: SCHEDULE, key }).length) {
      const eventId = recordEvent(draft, SCHEDULE, { id: key, type: "schedule.tick" }, [rule.name]);
      if (rule.workflow) {
        const accepted = submitProjectTask(
          draft,
          SCHEDULE,
          {
            id: key,
            type: "schedule.tick",
            subject: rule.workflow,
            goal: rule.prompt ?? `执行可信定时规则 ${rule.name}`,
            acceptance: ["按可信工作流完成，并通过配置的检查"],
            data: { rule: rule.name, occurred_at: key.slice(rule.name.length + 1) },
          },
          rule,
        );
        const task = draft.view.get("project_tasks", accepted.task_id)!;
        const execution = draft.view.get("stage_executions", task.current_execution)!;
        put(draft, "run_events", `${execution.run_id}:${eventId}`, { run_id: execution.run_id, event_id: eventId });
      } else enqueue(draft, rule, eventId, "");
    }
    put(draft, "schedules", rule.name, { next_at: nextAt() });
  }
  const isDue = (timer: Row) => timer.event_id === null && Date.parse(timer.at) <= now;
  const due = rows(draft.view, "timers", { event_id: null }).filter(isDue);
  for (const timer of due.sort((a, b) => a.at.localeCompare(b.at))) {
    const rule = ruleNamed(draft, timer.rule);
    const event = { id: `timer:${timer.id}`, type: "timer.due", subject: timer.lane, hops: timer.hops ?? 0 };
    const eventId = recordEvent(draft, timer.source, event, rule ? [rule.name] : []);
    put(draft, "timers", timer.id, { event_id: eventId });
    if (rule) enqueue(draft, rule, eventId, timer.lane, timer.session);
  }
  sweep(draft);
}

/** Every input there is, each with its arguments named. What one returns is what the caller is told. */
const HANDLERS: Record<string, (draft: Draft, ...args: any[]) => unknown> = {
  rules(draft, rules) {
    put(draft, "config", "rules", { value: rules, version: draft.seq });
    for (const run of rows(draft.view, "runs", { state: "queued" })) assignQueued(draft, run);
    closeOpen(draft, (key) => key.startsWith("rules:"), "改好了");
  },
  rulesError: (draft, problem) => notify(draft, `rules:${digest(problem)}`, "rules.json 写错了，还在用旧规则", problem),
  key: (draft, kind, name, hash) =>
    void put(draft, "keys", `${kind}:${name}`, { kind, name, hash, created_at: draft.at }),
  removeKey: (draft, kind, name) => void set(draft, "keys", `${kind}:${name}`, null),
  ingest,
  submitProjectTask,
  cancelProjectTask,
  recheckProjectTask,
  createCard,
  tell(draft, key, title, text) {
    const told = createCard(draft, { key, title, text, kind: "notice", fyi: true, once: true });
    if (!told.duplicate) return told;
    // Said again after every channel gave up on it: it gets another go.
    const isGivenUp = (delivery: Row) => delivery.card_id === told.card && delivery.given_up;
    const givenUp = rows(draft.view, "deliveries", { card_id: told.card }).filter(isGivenUp);
    for (const { card_id, channel } of givenUp) {
      put(draft, "deliveries", `${card_id}:${channel}`, { given_up: 0, ...NOT_TRYING });
    }
    if (!givenUp.length) return told;
    put(draft, "cards", told.card, { text, created_at: draft.at });
    return { ...told, duplicate: false };
  },
  heartbeat(draft, worker, running) {
    put(draft, "seen", `worker:${worker}`, { kind: "worker", name: worker, seen_at: draft.at });
    closeOffline(draft, worker);
    for (const id of running) {
      const run = draft.view.get("runs", id);
      if (run?.state === "claimed" && workerOf(draft.view, run) === worker) {
        put(draft, "runs", id, { seen_at: draft.at });
      } else if (run?.task_id && run.state === "unknown" && workerOf(draft.view, run) === worker) {
        put(draft, "runs", id, { seen_at: draft.at });
      }
    }
  },
  channelSeen: (draft, name) =>
    void put(draft, "seen", `channel:${name}`, { kind: "channel", name, seen_at: draft.at }),
  claimNext,
  started(draft, id, token, given) {
    const { session, link, stage } = parseStarted(given);
    const run = heldRun(draft, id, token, ["claimed", "unknown"]);
    if (!run.task_id && run.state === "unknown") throw new AuthError("这件活不归这个令牌");
    checkTaskSession(run, session);
    if (!run.task_id && stage) throw new InputError("普通运行的 started 不能带 stage");
    if (run.task_id && stage) {
      const execution = draft.view.get("stage_executions", run.execution_id);
      const task = draft.view.get("project_tasks", run.task_id);
      if (!execution || stage.execution_id !== execution.execution_id || stage.request_id !== execution.request_id) {
        throw new Conflict("started.stage 不属于这次任务执行");
      }
      if (execution.input_revision && stage.input_revision !== execution.input_revision) {
        throw new Conflict("started.stage 的 input_revision 已经固定");
      }
      const previous = execution.progress ? JSON.parse(execution.progress) : undefined;
      for (const field of ["remote_run_id", "binding"] as const) {
        if (previous?.[field] !== undefined && JSON.stringify(previous[field]) !== JSON.stringify(stage[field])) {
          throw new Conflict(`started.stage 的 ${field} 已经固定`);
        }
      }
      const cancelling = run.cancel_at !== null;
      const unknown = stage.remote_state === "unknown" || (run.state === "unknown" && !stage.remote_state);
      const state = unknown ? "unknown" : cancelling ? "cancel_requested" : "running";
      put(draft, "stage_executions", execution.execution_id, {
        state,
        input_revision: execution.input_revision ?? stage.input_revision ?? null,
        progress: JSON.stringify({ ...previous, ...stage }),
        started_at: execution.started_at ?? draft.at,
      });
      put(draft, "project_tasks", run.task_id, {
        state,
        ...(execution.input_resolution === "task_ref" && execution.input_revision === null && stage.input_revision
          ? { current_revision: stage.input_revision }
          : {}),
        updated_at: draft.at,
      });
      put(draft, "runs", id, { state: unknown ? "unknown" : "claimed" });
    }
    put(draft, "runs", id, { session: session ?? run.session, link: link ?? run.link, seen_at: draft.at });
  },
  finish,
  cancel(draft, id) {
    const run = draft.view.get("runs", id);
    if (!run) throw new NotFound("没有这一轮");
    if (run.task_id) {
      const task = draft.view.get("project_tasks", run.task_id);
      if (!task || task.current_execution !== run.execution_id) throw new InputError("这一轮已经结束了");
      cancelTask(draft, task);
      return;
    }
    if (run.state === "queued") put(draft, "runs", id, { state: "cancelled", finished_at: draft.at });
    else if (run.state === "claimed") put(draft, "runs", id, { cancel_at: draft.at });
    else throw new InputError("这一轮已经结束了");
  },
  resolve(draft, id, reason, by) {
    const card = draft.view.get("cards", id);
    if (!card) throw new NotFound("没有这张卡片");
    if (card.state !== "open") return false;
    closeCard(draft, card, reason, by);
    return true;
  },
  answer,
  nextCard,
  delivered(draft, channel, id, version, ref) {
    if (!draft.view.get("cards", id)) throw new NotFound("没有这张卡片");
    const delivery = draft.view.get("deliveries", `${id}:${channel}`) ?? NOT_DELIVERED;
    const sent = { version: Math.max(delivery.version, version), ref: delivery.ref ?? ref };
    put(draft, "deliveries", `${id}:${channel}`, { card_id: id, channel, ...sent, ...NOT_TRYING, error: null });
  },
  failed(draft, channel, id, version, error) {
    const card = draft.view.get("cards", id);
    const delivery = draft.view.get("deliveries", `${id}:${channel}`);
    if (!card || !delivery) throw new NotFound("这张卡片没有交给这个通道");
    const firstTry = delivery.first_try_at ? Date.parse(delivery.first_try_at) : draft.now;
    const next =
      version < card.version
        ? { not_before: null }
        : delivery.tries >= RESEND_AT.length
          ? { given_up: 1 }
          : { not_before: iso(firstTry + RESEND_AT[delivery.tries] * MINUTE) };
    put(draft, "deliveries", `${id}:${channel}`, { ...next, error: String(error).slice(0, 300) });
  },
  sweep,
  tick,
};
