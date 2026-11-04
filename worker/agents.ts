// An agent is a process: give it a prompt, read its last message from what it prints. An adapter is what's different
// about one: its command line and how to read its output. `plugins/<use>/agent.ts`, in this install's folder first,
// then the ones that ship. Anything with a print mode needs no file at all: `use: "command"` with a command line in
// rules.json.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadPlugin } from "../host/plugins.ts";
import type { Result, Usage } from "../protocol/validate.ts";
import type { JobStage, StageProgress } from "../protocol/project-tasks.ts";

export type { Usage } from "../protocol/validate.ts";
export type Access = "read" | "edit" | "full";
/** One launch of an agent. `resume` is the session to go on in, if any; otherwise `session` is a new id it may use. */
export type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  access: Access;
  command?: string[];
  contextFile: string;
  folder: string;
  /** Stable across a lost wrapper or a worker restart, different for an intentional new turn. */
  invocation?: string;
  description?: string;
  /** Trusted immutable stage snapshot; ordinary runs omit it. */
  stage?: JobStage;
};
export type Reading = {
  text?: string;
  session?: string;
  usage?: Usage;
  error?: string;
  finished?: boolean;
  result?: Result;
  pending?: boolean;
  diagnostic?: string;
  /** Durable progress for a stage execution; it never completes the run. */
  stage?: StageProgress;
};
export type Adapter = {
  /** Its command line for this turn. */
  command(turn: Turn): string[];
  /** What its output says so far. `code` is null while it's still running or when it died without saying. */
  read(stdout: string, code: number | null, stderr: string): Reading;
  /** Where a person can open this session. */
  link?(session: string): string;
  /** Whether it's installed and signed in: what's wrong, in words a person can act on, or nothing. */
  check?(): string | null;
  resumePolicy?: "strict";
  /** A remote execution stays reserved until these hooks confirm its termination. */
  reconcile?(turn: Turn): Promise<Reading>;
  cancel?(turn: Turn): Promise<Reading>;
};

const adapters = new Map<string, Adapter>();

export async function adapterFor(use: string): Promise<Adapter> {
  const known = adapters.get(use);
  if (known) return known;
  const adapter = (await loadPlugin(use, "agent")) as Adapter;
  adapters.set(use, adapter);
  return adapter;
}

const found = new Map<string, string | null>();

/** Where a program is: on the login shell's PATH (launchd and systemd start with a bare one), or in one of these. */
export function findProgram(name: string, elsewhere: () => string[] = () => []) {
  if (!found.has(name)) {
    const shell = process.env.SHELL ?? "/bin/sh";
    let onPath: string | null = null;
    try {
      const printed = execFileSync(shell, ["-lc", `command -v ${name}`], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      onPath = printed.trim().split("\n").at(-1) || null;
    } catch {}
    found.set(name, onPath ?? elsewhere().find(existsSync) ?? null);
  }
  const program = found.get(name);
  if (!program) throw new Error(`找不到 ${name}：先装好并登录`);
  return program;
}

/** The end of some output, for saying why something failed. */
export const tail = (text: string, length = 300) => text.trim().slice(-length);
