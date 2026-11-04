import assert from "node:assert/strict";
import { snapshot, TABLES, type Fact, type View, type Row } from "../kernel/evolve.ts";

type Snapshot = ReturnType<typeof snapshot>;
const rows = (view: Snapshot, table: keyof Snapshot["tables"]) => Object.values(view.tables[table]);
// Independent replay oracle: it checks the indexed projection without using its write or query implementation.
export function replay(log: Fact[]): Snapshot {
  const tables = Object.fromEntries(TABLES.map((table) => [table, {}])) as Snapshot["tables"];
  const next: Record<string, number> = {};
  let seq = 0;
  for (const fact of log) {
    seq = fact.seq;
    for (const { table, key, row } of fact.changes) {
      if (row === null) delete tables[table][key];
      else {
        tables[table][key] = row;
        // Configuration versions are derived from each rules fact, including logs written before the lookup existed.
        if (table === "config" && key === "rules") tables.config[String(row.version)] = row;
        if (typeof row.id === "number") next[table] = Math.max(next[table] ?? 0, row.id);
      }
    }
  }
  return { seq, tables, next };
}
export function invariants(current: View, log: Fact[], before?: Snapshot) {
  const view = snapshot(current);
  assert.deepEqual(view, replay(log), "日志重放记录不同");
  for (const [index, fact] of log.entries()) assert.equal(fact.seq, index + 1, "日志序号不连续");
  const events = rows(view, "events");
  const runs = rows(view, "runs");
  const cards = rows(view, "cards");
  const links = rows(view, "run_events");
  const tasks = rows(view, "project_tasks");
  const executions = rows(view, "stage_executions");
  assert.equal(new Set(events.map((e) => JSON.stringify([e.source, e.key]))).size, events.length, "重复事件");
  const held = runs.filter((r) => r.state === "claimed");
  assert.equal(new Set(held.map((r) => JSON.stringify([r.grp, r.lane]))).size, held.length, "同一事项同时领了两轮");
  for (const group of new Set(held.map((r) => r.grp)))
    assert.ok(
      held.filter((r) => r.grp === group).length <=
        (view.tables.config.rules.value.rules.find((r: Row) => r.group === group)?.parallel ?? 1),
      "超出同组并发数",
    );
  for (const e of events)
    for (const rule of JSON.parse(e.routed))
      assert.ok(
        links.some((l) => l.event_id === e.id && view.tables.runs[l.run_id]?.rule === rule),
        "已收事件丢了派发关系",
      );
  for (const card of cards)
    if (card.answer_event !== null) {
      const event = view.tables.events[card.answer_event];
      assert.equal(event?.type, "card.answered");
      if (view.tables.config.rules.value.rules.some((r: Row) => r.name === card.rule))
        assert.ok(
          links.some(
            (l) =>
              l.event_id === card.answer_event &&
              view.tables.runs[l.run_id]?.rule === card.rule &&
              view.tables.runs[l.run_id]?.lane === card.lane,
          ),
          "回答没叫醒原事项",
        );
    }
  for (const task of tasks) {
    const workflow = JSON.parse(task.workflow);
    const visits = JSON.parse(task.visits) as Record<string, number>;
    const taskExecutions = executions.filter((execution) => execution.task_id === task.task_id);
    assert.equal(task.execution_count, taskExecutions.length, "任务执行计数与事实不一致");
    assert.ok(task.transitions <= workflow.max_transitions, "任务转换超过可信上限");
    for (const [stage, count] of Object.entries(visits)) {
      assert.ok(Number.isSafeInteger(count) && count >= 0, "任务访问计数无效");
      assert.ok(count <= workflow.stages[stage]?.max_visits, "任务阶段访问超过可信上限");
    }
    const current = task.current_execution
      ? taskExecutions.find((execution) => execution.execution_id === task.current_execution)
      : undefined;
    if (task.current_execution) assert.ok(current, "任务当前执行不存在");
    const active = taskExecutions.filter((execution) =>
      ["queued", "claimed", "running", "cancel_requested", "unknown"].includes(execution.state),
    );
    assert.ok(active.length <= 1, "同一项目任务有多个活动执行");
    if (["queued", "running", "cancel_requested", "unknown"].includes(task.state)) {
      assert.equal(active.length, 1, "活动项目任务没有唯一活动执行");
      assert.equal(active[0]?.execution_id, task.current_execution, "活动执行不是任务当前执行");
      assert.ok(task.transitions < workflow.max_transitions, "没有剩余转换预算却又排入了活动执行");
    } else {
      assert.equal(active.length, 0, "非活动项目任务仍有活动执行");
    }
    for (const execution of taskExecutions) {
      const linked = runs.filter((run) => run.execution_id === execution.execution_id);
      assert.equal(linked.length, 1, "阶段执行没有唯一 runs 队列记录");
      assert.equal(linked[0]?.id, execution.run_id, "阶段执行关联了错误的 run");
    }
    const openTaskCards = cards.filter((card) => card.task_id === task.task_id && card.state === "open");
    assert.ok(openTaskCards.length <= 1, "项目任务同时打开了多张决定卡");
    if (task.state === "waiting_human") {
      assert.equal(openTaskCards.length, 1, "等待决定的任务没有唯一打开卡片");
      assert.equal(openTaskCards[0]?.id, task.human_card, "任务等待的不是当前决定卡");
    }
    if (task.state === "completed") {
      assert.equal(current?.state, "finished", "完成任务的当前执行没有结束");
      const result = current?.result ? JSON.parse(current.result) : null;
      assert.equal(result?.verdict, "verified", "任务没有 verified 证据却标成完成");
      assert.equal(result?.input_revision, task.current_revision, "完成证据不是任务当前输入版本");
      assert.equal(result?.output_revision, task.current_revision, "完成证据不是任务当前输出版本");
      const required = workflow.stages[current.stage_id].checks as { name: string }[];
      for (const check of required) {
        assert.ok(
          result.checks.some(
            (actual: Row) =>
              actual.name === check.name && actual.exit_code === 0 && actual.revision === task.current_revision,
          ),
          "完成任务缺少可信检查证据",
        );
      }
    }
  }
  if (before) {
    for (const e of rows(before, "events")) assert.deepEqual(view.tables.events[e.id], e, "已落盘事件被改了或丢了");
    for (const c of rows(before, "cards"))
      if (c.answer_event !== null) {
        const now = view.tables.cards[c.id];
        assert.equal(now.answer_event, c.answer_event);
        assert.equal(now.choice, c.choice);
        assert.equal(now.answer, c.answer);
      }
    for (const r of rows(before, "runs"))
      if (["done", "nothing", "cancelled"].includes(r.state))
        assert.deepEqual(view.tables.runs[r.id], r, "完成的回执再次生效");
  }
  return view;
}
