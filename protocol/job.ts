import type { Rule, WorkflowHumanOption } from "../kernel/rules.ts";
import type { AcceptedStageEvidence, JobStage, ProjectTaskInput } from "./project-tasks.ts";
export type Job = {
  run: number;
  token: string;
  attempt: number;
  rule: Pick<Rule, "name" | "cwd" | "skill" | "prompt" | "emits">;
  agent: {
    id: string;
    name: string;
    use: string;
    model?: string;
    effort?: string;
    access: string;
    command?: string[];
    timeout?: number;
  };
  session: string | null;
  askFirst: string[];
  stage?: JobStage;
  context: {
    task?: Omit<ProjectTaskInput, "id"> & { task_id: string; source: string };
    stage_evidence?: AcceptedStageEvidence[];
    task_decisions?: {
      card: number;
      generation: number;
      execution_id: string;
      revision: string | null;
      title: string;
      options: WorkflowHumanOption[];
      choice: number | null;
      text: string | null;
      by: string | null;
      at: string | null;
      text_by: string | null;
      text_at: string | null;
    }[];
    events: {
      id: string;
      source: string;
      sourceName: string;
      type: string;
      subject: string;
      summary: string;
      detail: string;
      link: string;
      receivedAt: string;
      hops?: number;
    }[];
    answers: {
      card: number;
      title: string;
      options: string[];
      choice: number | null;
      text: string | null;
      about: string;
      by: string | null;
      at: string;
    }[];
    timers: { key: string; about: string; at: string }[];
    waiting: { key: string; about: string; at: string }[];
    open: { card: number; title: string; text: string; at: string }[];
    decided: { card: number; title: string; choice: string | null; at: string }[];
  };
};
