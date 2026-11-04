// Shared isolated Phase 1 fixture. It runs production Hub, worker, Lodestar adapter, Git handoff and channel code;
// only native model and Feishu/notify transport are loopback fakes.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";

const REPO = path.join(import.meta.dirname, "..");
const SELF = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);
// Full-suite parallel load can delay process scheduling after a stage has already produced its terminal journal.
// A hard cap bounds the entire child, while the semantic stall cap still fails a genuinely stuck stage quickly.
const SCENARIO_PROCESS_TIMEOUT_MS = 130_000;
const TASK_TOTAL_TIMEOUT_MS = 60_000;
const TASK_NO_PROGRESS_TIMEOUT_MS = 15_000;
const HUMAN_NOTE = "HUMAN-DATA-04: the missing acceptance detail is confirmed; preserve it in the plan";
const REVIEW_FINDING = "REVIEW-DATA-04: replace execute:needs-fix with the accepted implementation";

export type WorkflowTrace = {
  worker: string;
  stage: string;
  verdict: string;
  requestId: string;
  runId: string;
  workDir: string;
  inputRevision: string;
  outputRevision: string;
  requestedSession: string | null;
  session: string;
  context: any;
  prompt: string;
};

export type ProjectWorkflowResult = {
  task: any;
  trace: WorkflowTrace[];
  cliReplay: any;
  mcpReplay: any;
  humanAnswers: number;
  physicalCards: number;
  remoteTaskRevision: string;
  firstGenerationRevision: string;
  artifactText: string;
  humanNote: string;
  reviewFinding: string;
  rejectedCrossWorkspaceResume: number;
  recheckRevision?: string;
  firstGenerationEvidence: any[];
  refsBeforeRecheck?: string;
  refsAfterRecheck?: string;
  publicationRecovery?: any;
};

export async function runProjectWorkflowE2E(
  t: TestContext,
  recipe: string,
  options: { recheck?: boolean; publicationLoss?: boolean } = {},
): Promise<ProjectWorkflowResult> {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", SELF, "scenario", recipe, JSON.stringify(options)],
    { cwd: REPO, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const timeout = setTimeout(() => child.kill("SIGKILL"), SCENARIO_PROCESS_TIMEOUT_MS);
  await once(child, "close");
  clearTimeout(timeout);
  if (child.exitCode !== 0) throw new Error(`project workflow fixture failed (${child.exitCode}): ${stderr || stdout}`);
  return JSON.parse(stdout) as ProjectWorkflowResult;
}

export async function startLodestarInterop(
  t: TestContext,
  options: { lodestarRepo: string; bun: string; faults?: boolean },
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-autoloop-lodestar-interop-")));
  const project = path.join(root, "project");
  mkdirSync(project);
  const config = path.join(root, "harness.json");
  const ready = path.join(root, "ready.json");
  const stop = path.join(root, "stop");
  writeFileSync(
    config,
    JSON.stringify({ root, project, ready, stop, faults: options.faults, capability: "interop-capability" }),
  );
  const child = spawn(
    options.bun,
    ["--preload", path.join(options.lodestarRepo, "src", "test-preload.ts"), SELF, "lodestar-harness", config],
    {
      cwd: options.lodestarRepo,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  t.after(async () => {
    writeFileSync(stop, "stop");
    if (child.exitCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 15_000;
  while (!existsSync(ready) && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Lodestar interop harness exited: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!existsSync(ready)) throw new Error(`Lodestar interop harness did not start: ${stderr}`);
  const connection = JSON.parse(readFileSync(ready, "utf8"));
  const clientFile = path.join(root, "client.json");
  writeFileSync(clientFile, JSON.stringify({ baseUrl: connection.baseUrl, capability: connection.capability }));
  const identityResponse = await fetch(`${connection.baseUrl}/agents/identities?project=repo`, {
    headers: { authorization: `Bearer ${connection.capability}` },
  });
  const identityCatalog = await identityResponse.json();
  const identity = identityCatalog.identities?.find((item: any) => item.status === "ready")?.id;
  if (!identityResponse.ok || typeof identity !== "string") {
    throw new Error(`real Lodestar identity catalog has no ready identity: ${JSON.stringify(identityCatalog)}`);
  }
  const call = async (method: string, pathname: string) => {
    const response = await fetch(`${connection.baseUrl}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${connection.capability}` },
      signal: AbortSignal.timeout(5000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`interop ${pathname}: HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
  };
  const binding = await call("GET", "/agents/project-binding?project=repo");
  return {
    root,
    project,
    clientFile,
    identity,
    stop,
    control: (action: string) => call("POST", `/fixture/${action}`),
    request: (id: string) =>
      call(
        "GET",
        `/agents/requests/${encodeURIComponent(id)}?project=repo&expected_binding=${encodeURIComponent(binding.binding_id)}`,
      ),
  };
}

export async function runLodestarInterop(
  t: TestContext,
  options: { lodestarRepo: string; bun: string },
): Promise<{ completed: any; cancelled: any }> {
  const { root, project, clientFile, identity, stop } = await startLodestarInterop(t, options);
  const { prepareTurn, observeTurn } = await import("../plugins/lodestar/run.ts");
  const turn = (name: string, prompt: string) => {
    const folder = path.join(root, name);
    mkdirSync(folder);
    const value = {
      prompt,
      session: `local-${name}`,
      resume: null,
      cwd: project,
      access: "full" as const,
      contextFile: path.join(folder, "context.json"),
      folder,
      invocation: `interop-${name}`,
      command: ["--project", "repo", "--identity", identity, "--client-file", clientFile],
    };
    writeFileSync(value.contextFile, "{}");
    prepareTurn(value);
    return value;
  };
  const completeTurn = turn("complete", "complete through real AgentService");
  let completed: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    completed = await observeTurn(completeTurn);
    if (completed.finished) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!completed?.finished) throw new Error("real Lodestar AgentService completion did not settle");
  const cancelTurn = turn("cancel", "cancel through real AgentService");
  await observeTurn(cancelTurn);
  let cancelled: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    cancelled = await observeTurn(cancelTurn, true);
    if (cancelled.finished) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!cancelled?.finished) throw new Error("real Lodestar AgentService cancellation did not settle");
  writeFileSync(stop, "stop");
  return { completed, cancelled };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(root: string) {
  const source = path.join(root, "source");
  const remote = path.join(root, "project.git");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Workflow Fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(source, "README.md"), "fixture base\n");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "base");
  git(root, "clone", "--bare", source, remote);
  const roots = Object.fromEntries(
    ["mac-a", "mac-b", "mac-c"].map((worker) => {
      const cwd = path.join(root, worker, "project");
      mkdirSync(path.dirname(cwd), { recursive: true });
      git(root, "clone", remote, cwd);
      git(cwd, "config", "user.name", `Fixture ${worker}`);
      git(cwd, "config", "user.email", `${worker}@example.invalid`);
      return [worker, realpathSync(cwd)];
    }),
  );
  return { source, remote: realpathSync(remote), roots, base: git(source, "rev-parse", "HEAD") };
}

async function bodyOf(request: IncomingMessage) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(response: any, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function stageOf(prompt: string) {
  const matched = /项目阶段 ([a-z][a-z0-9-]*)/.exec(prompt);
  if (!matched) throw new Error("fake Lodestar did not receive a stage prompt");
  return matched[1]!;
}

function stageVerdict(stage: string, context: any, workDir: string, artifact: string, revision: string) {
  if (stage === "plan") {
    const decision = context.task_decisions?.find((item: any) => item.text === HUMAN_NOTE);
    return decision?.options[decision.choice]?.action === "retry" ? "planned" : "blocked";
  }
  if (stage === "execute") return "implemented";
  if (stage === "rework") {
    const reviewed = context.stage_evidence?.some(
      (item: any) =>
        item.verdict === "changes_requested" &&
        item.output_revision === revision &&
        item.findings.some((finding: any) => finding.summary === REVIEW_FINDING),
    );
    return reviewed ? "implemented" : "blocked";
  }
  const contents = readFileSync(path.join(workDir, artifact), "utf8");
  if (stage === "review") return contents === "rework:accepted\n" ? "approved" : "changes_requested";
  if (stage === "verify") return contents === "rework:accepted\n" ? "verified" : "changes_requested";
  throw new Error(`unexpected stage ${stage}`);
}

async function fakeLodestar(input: {
  root: string;
  worker: string;
  projectRoot: string;
  artifactPaths: string[];
  capability: string;
  trace: WorkflowTrace[];
}) {
  const requests = new Map<string, any>();
  const sessions = new Map<string, string>();
  const binding = {
    installation_id: `installation-${input.worker}`,
    binding_id: `binding-${input.worker}`,
    project: "fixture-project",
    chat_id: `chat-${input.worker}`,
    work_dir: input.projectRoot,
  };
  const identity = `identity-${input.worker}`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://127.0.0.1");
      const body = await bodyOf(request);
      if (request.headers.authorization !== `Bearer ${input.capability}`)
        return send(response, 403, { error: "bad capability" });
      if (url.searchParams.get("project") !== "fixture-project") return send(response, 403, { error: "bad project" });
      if (url.pathname === "/agents/project-binding") return send(response, 200, binding);
      if (url.pathname === "/agents/identities") {
        return send(response, 200, {
          identities: [{ id: identity, status: "ready", provider: "codex", supported_efforts: ["high"] }],
        });
      }
      const expected = body.expected_binding ?? url.searchParams.get("expected_binding");
      if (expected !== binding.binding_id) return send(response, 409, { error: "project_binding_changed" });
      if (request.method === "POST" && url.pathname === "/agents/runs") {
        const existing = requests.get(body.request_id);
        if (existing) return send(response, 202, existing);
        const workDir = realpathSync(String(body.work_dir));
        if (body.session_id && sessions.get(body.session_id) !== workDir)
          return send(response, 409, { error: "native session belongs to another cwd" });
        const session = body.session_id ?? `native-${input.worker}-${sessions.size + 1}`;
        sessions.set(session, workDir);
        const prompt = String(body.prompt ?? "");
        const stage = stageOf(prompt);
        const contextFile = /只在 (.+?\/context\.json)。/.exec(prompt)?.[1];
        if (!contextFile || !contextFile.startsWith(input.root + path.sep))
          throw new Error("missing private native context file");
        const context = JSON.parse(readFileSync(contextFile, "utf8"));
        const inputRevision = git(workDir, "rev-parse", "HEAD");
        const verdict = stageVerdict(stage, context, workDir, input.artifactPaths[0]!, inputRevision);
        if (["plan", "execute", "rework"].includes(stage) && verdict !== "blocked") {
          for (const artifact of input.artifactPaths) {
            const file = path.join(workDir, artifact);
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, `${stage}:${stage === "execute" ? "needs-fix" : "accepted"}\n`);
          }
          git(workDir, "add", "--", ...input.artifactPaths);
          git(workDir, "commit", "-m", `${stage} fixture result`);
        }
        const outputRevision = git(workDir, "rev-parse", "HEAD");
        const finalOutput = [
          `${stage} ${verdict}`,
          "```agent-autoloop-stage",
          JSON.stringify({
            verdict,
            summary: `${stage}:${verdict}`,
            artifacts: verdict === "blocked" ? [] : input.artifactPaths,
            findings: verdict === "changes_requested" ? [{ severity: "blocking", summary: REVIEW_FINDING }] : [],
          }),
          "```",
        ].join("\n");
        const run = {
          run_id: `remote-${input.worker}-${requests.size + 1}`,
          request_id: body.request_id,
          binding: "project",
          project: "fixture-project",
          work_dir: workDir,
          status: "completed",
          workers: [
            {
              identity_id: identity,
              provider: "codex",
              status: "completed",
              session_id: session,
              final_output: finalOutput,
              usage: { input_tokens: 10, output_tokens: 4 },
            },
          ],
        };
        requests.set(body.request_id, run);
        input.trace.push({
          worker: input.worker,
          stage,
          verdict,
          requestId: body.request_id,
          runId: run.run_id,
          workDir,
          inputRevision,
          outputRevision,
          requestedSession: typeof body.session_id === "string" ? body.session_id : null,
          session,
          context,
          prompt,
        });
        return send(response, 202, run);
      }
      const matched = /^\/agents\/requests\/([^/]+)$/.exec(url.pathname);
      if (matched) {
        const requestId = decodeURIComponent(matched[1]!);
        const run = requests.get(requestId);
        if (!run) return send(response, 404, { error: "not found" });
        if (request.method === "DELETE") {
          run.status = "cancelled";
          run.workers[0].status = "cancelled";
          return send(response, 200, { request_id: requestId, run_id: run.run_id, state: "cancelled", run });
        }
        return send(response, 200, { request_id: requestId, run_id: run.run_id, state: "resolved", run });
      }
      return send(response, 404, { error: "not found" });
    } catch (error) {
      return send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clientFile = path.join(input.root, `${input.worker}-agent-client.json`);
  writeFileSync(clientFile, JSON.stringify({ baseUrl, capability: input.capability }), { mode: 0o600 });
  return {
    server,
    clientFile,
    async rejectCrossWorkspaceResume(call: WorkflowTrace) {
      const response = await fetch(`${baseUrl}/agents/runs?project=fixture-project`, {
        method: "POST",
        headers: { authorization: `Bearer ${input.capability}`, "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "cross-workspace-negative-control",
          expected_binding: binding.binding_id,
          work_dir: input.projectRoot,
          session_id: call.session,
          prompt: call.prompt,
        }),
      });
      return response.status;
    },
  };
}

async function fakeNotify(root: string, beforeChoice: () => Promise<void>) {
  const records = new Map<string, any>();
  let physicalCards = 0;
  let humanAnswers = 0;
  const answerInFlight = new Set<string>();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://127.0.0.1");
      const body = await bodyOf(request);
      if (request.method === "POST" && url.pathname === "/notify") {
        let record = records.get(body.request_id);
        if (!record) {
          physicalCards++;
          record = {
            notify_id: `notify-${physicalCards}`,
            message_id: `message-${physicalCards}`,
            chat_id: "chat-fixture",
            request_id: body.request_id,
            body,
          };
          records.set(body.request_id, record);
        }
        const value = {
          request_id: record.request_id,
          notify_id: record.notify_id,
          message_id: record.message_id,
          chat_id: record.chat_id,
          transport_state: "applied",
          version: body.version,
          applied_version: body.version,
          resolved: false,
        };
        send(response, 200, value);
        if (body.callback && Array.isArray(body.buttons) && !answerInFlight.has(body.request_id)) {
          answerInFlight.add(body.request_id);
          const selected = body.buttons.find((button: any) => String(button.text).includes("重试")) ?? body.buttons[0];
          void (async () => {
            let textSaved = false;
            for (let attempt = 0; attempt < 40; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              try {
                if (!textSaved) {
                  await beforeChoice();
                  textSaved = true;
                }
                const accepted = await fetch(body.callback, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    notify_id: record.notify_id,
                    project: body.project,
                    version: body.version,
                    chat_id: record.chat_id,
                    message_id: record.message_id,
                    operator: { open_id: "operator-fixture" },
                    button: { id: selected.id, text: selected.text },
                  }),
                });
                if (accepted.ok) {
                  humanAnswers++;
                  break;
                }
              } catch {}
            }
          })();
        }
        return;
      }
      const update = /^\/notify\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PUT" && update) {
        const record = [...records.values()].find((item) => item.notify_id === decodeURIComponent(update[1]!));
        if (!record) return send(response, 404, { error: "not found" });
        record.body = body;
        return send(response, 200, {
          request_id: record.request_id,
          notify_id: record.notify_id,
          message_id: record.message_id,
          chat_id: record.chat_id,
          transport_state: "applied",
          version: body.version,
          applied_version: body.version,
          resolved: body.version > 1,
        });
      }
      const result = /^\/notify\/result\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && result) {
        const record = [...records.values()].find((item) => item.notify_id === decodeURIComponent(result[1]!));
        if (!record) return send(response, 404, { error: "not found" });
        return send(response, 200, {
          request_id: record.request_id,
          notify_id: record.notify_id,
          message_id: record.message_id,
          chat_id: record.chat_id,
          transport_state: "applied",
          version: record.body.version,
          applied_version: record.body.version,
          resolved: false,
        });
      }
      return send(response, 404, { error: "not found" });
    } catch (error) {
      return send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clientFile = path.join(root, "notify-client.json");
  writeFileSync(clientFile, JSON.stringify({ baseUrl, capability: "notify-fixture" }), { mode: 0o600 });
  return {
    server,
    clientFile,
    stats: () => ({ physicalCards, humanAnswers }),
  };
}

function transformRules(
  rules: any,
  repo: ReturnType<typeof repository>,
  clients: Record<string, string>,
  checksFile: string,
) {
  const copy = structuredClone(rules);
  const workflow = copy.workflows["project-workflow"];
  if (!workflow) throw new Error("recipe does not define project-workflow");
  workflow.git.remote = repo.remote;
  workflow.git.base_ref = "refs/heads/main";
  workflow.git.task_ref_prefix = "refs/heads/autoloop/";
  for (const [stageId, stage] of Object.entries(workflow.stages) as [string, any][]) {
    stage.checks = stage.checks.map((check: any) => ({
      ...check,
      argv: [
        process.execPath,
        "-e",
        `require('node:fs').appendFileSync(${JSON.stringify(checksFile)}, ${JSON.stringify(stageId + "\n")})`,
      ],
      timeout_ms: 10_000,
    }));
  }
  for (const [agentId, agent] of Object.entries(copy.agents) as [string, any][]) {
    if (agent.use !== "lodestar") continue;
    const worker = agent.worker;
    agent.command = [
      "--project",
      "fixture-project",
      "--identity",
      `identity-${worker}`,
      "--client-file",
      clients[worker],
    ];
    if (!repo.roots[worker]) throw new Error(`recipe agent ${agentId} uses unknown worker ${worker}`);
  }
  for (const rule of copy.rules) {
    if (rule.workflow) continue;
    const agent = copy.agents[rule.to];
    if (agent?.worker && repo.roots[agent.worker]) rule.cwd = repo.roots[agent.worker];
  }
  for (const channel of Object.values(copy.channels ?? {}) as any[]) {
    channel.answerers = ["operator-fixture"];
  }
  return copy;
}

async function runCli(home: string, args: string[], input = "") {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", ...args], {
    cwd: REPO,
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.stdin!.end(input);
  await once(child, "close");
  if (child.exitCode !== 0) throw new Error(`CLI failed: ${stderr || stdout}`);
  return JSON.parse(stdout);
}

async function mcpTool(home: string, name: string, args: object) {
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ];
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", "mcp"], {
    cwd: REPO,
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.stdin!.end(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
  await once(child, "close");
  if (child.exitCode !== 0) throw new Error(`MCP failed: ${stderr || stdout}`);
  const reply = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((item) => item.id === 2);
  if (reply?.result?.isError) throw new Error(reply.result.content?.[0]?.text ?? "MCP tool failed");
  return JSON.parse(reply.result.content[0].text);
}

function startWorker(config: any) {
  const file = path.join(config.home, "fixture-worker.json");
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SELF, "worker", file], {
    cwd: REPO,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function stopWorkers(workers: ChildProcess[], homes: string[]) {
  for (const worker of workers) if (worker.exitCode === null) worker.kill("SIGTERM");
  await Promise.race([
    Promise.all(workers.map((worker) => (worker.exitCode === null ? once(worker, "close") : Promise.resolve()))),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  for (const worker of workers) if (worker.exitCode === null) worker.kill("SIGKILL");
  for (const home of homes) {
    const runs = path.join(home, "worker", "runs");
    if (!existsSync(runs)) continue;
    for (const file of walk(runs, "entry.json")) {
      try {
        const entry = JSON.parse(readFileSync(file, "utf8"));
        if (entry.pid) process.kill(-entry.pid, "SIGKILL");
      } catch {}
    }
  }
}

function walk(root: string, name: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of execFileSync("find", [root, "-name", name, "-type", "f"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean))
    found.push(entry);
  return found;
}

export function taskProgressFingerprint(task: any) {
  return JSON.stringify({
    state: task?.state,
    generation: task?.generation,
    transitions: task?.transitions,
    current_stage: task?.current_stage,
    current_execution: task?.current_execution,
    current_revision: task?.current_revision,
    human_card: task?.human_card,
    execution_count: task?.execution_count,
    late_outcomes: Array.isArray(task?.late_outcomes) ? task.late_outcomes.length : 0,
    resolution: task?.resolution ?? null,
    executions: (task?.executions ?? []).map((execution: any) => ({
      execution_id: execution.execution_id,
      generation: execution.generation,
      stage_id: execution.stage_id,
      state: execution.state,
      input_revision: execution.input_revision,
      output_revision: execution.output_revision,
      verdict: execution.verdict,
      progress: execution.progress
        ? {
            request_id: execution.progress.request_id,
            remote_run_id: execution.progress.remote_run_id,
            input_revision: execution.progress.input_revision,
            remote_state: execution.progress.remote_state,
            binding: execution.progress.binding,
          }
        : null,
      result: execution.result
        ? {
            verdict: execution.result.verdict,
            input_revision: execution.result.input_revision,
            output_revision: execution.result.output_revision,
            remote_ref: execution.result.remote_ref,
            artifacts: execution.result.artifacts,
            checks: execution.result.checks,
            findings: execution.result.findings,
            resolution: execution.result.resolution,
          }
        : null,
    })),
    runs: (task?.runs ?? []).map((run: any) => ({
      id: run.id,
      state: run.state,
      session: run.session,
      summary: run.summary,
      error: run.error,
    })),
  });
}

export async function waitForTask(
  client: any,
  taskId: string,
  state: string,
  limits: { totalMs?: number; noProgressMs?: number } = {},
  diagnostics: () => string = () => "",
) {
  const totalMs = limits.totalMs ?? TASK_TOTAL_TIMEOUT_MS;
  const noProgressMs = limits.noProgressMs ?? TASK_NO_PROGRESS_TIMEOUT_MS;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let fingerprint = "";
  let latest: any;
  while (Date.now() - startedAt < totalMs && Date.now() - lastProgressAt < noProgressMs) {
    latest = await client.projectTask(taskId);
    const next = taskProgressFingerprint(latest);
    if (next !== fingerprint) {
      fingerprint = next;
      lastProgressAt = Date.now();
    }
    if (latest.state === state) return latest;
    if (["failed", "cancelled"].includes(latest.state) && latest.state !== state) {
      throw new Error(`task reached ${latest.state}: ${JSON.stringify(latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const elapsed = Date.now() - startedAt;
  const stalled = Date.now() - lastProgressAt;
  const reason = stalled >= noProgressMs ? `no semantic progress for ${stalled}ms` : `total budget ${elapsed}ms`;
  throw new Error(
    `task did not reach ${state} (${reason}): ${JSON.stringify(latest)}\nfixture diagnostics:\n${diagnostics()}`,
  );
}

function installPublicationLoss(home: string, evidence: string, checks: string) {
  const folder = path.join(home, "plugins", "lodestar");
  mkdirSync(folder, { recursive: true });
  // The adapter's SIGKILL matrix lives in lodestar-receipt.test.ts. Here the real worker loses exactly one
  // post-publication reading, then must deliver the production adapter's same prepared receipt to the Hub.
  writeFileSync(
    path.join(folder, "agent.ts"),
    `
import fs from 'node:fs';
import path from 'node:path';
import adapter from ${JSON.stringify(pathToFileURL(path.join(REPO, "plugins", "lodestar", "agent.ts")).href)};
import { prepareTurn } from ${JSON.stringify(pathToFileURL(path.join(REPO, "plugins", "lodestar", "run.ts")).href)};
const evidence = ${JSON.stringify(evidence)};
const checks = ${JSON.stringify(checks)};
export default {
  ...adapter,
  command(turn) { prepareTurn(turn); return [process.execPath, '-e', 'process.exit(0)']; },
  async reconcile(turn) {
    const reading = await adapter.reconcile(turn);
    if (turn.stage.stage_id !== 'execute' || !reading.finished) return reading;
    if (!fs.existsSync(evidence)) {
      const file = path.join(turn.folder, 'lodestar-journal.json');
      const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!journal.prepared?.result) throw new Error('publication fault requires a durable prepared receipt');
      fs.writeFileSync(evidence, JSON.stringify({ prepared: journal.prepared.result, checksBefore: fs.readFileSync(checks, 'utf8') }));
      delete journal.reading;
      fs.writeFileSync(file, JSON.stringify(journal));
      return { pending: true, session: reading.session, stage: { ...reading.stage, remote_state: 'unknown' } };
    }
    const saved = JSON.parse(fs.readFileSync(evidence, 'utf8'));
    if (!saved.recovered) fs.writeFileSync(evidence, JSON.stringify({ ...saved, recovered: reading.result, checksAfter: fs.readFileSync(checks, 'utf8') }));
    return reading;
  }
};
`,
  );
}

async function scenario(recipe: string, options: { recheck?: boolean; publicationLoss?: boolean }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-autoloop-project-e2e-")));
  const workers: ChildProcess[] = [];
  const workerLogs: string[] = [];
  const servers: Server[] = [];
  try {
    const rulesFile = path.join(recipe, "rules.json");
    const configsFile = path.join(recipe, "configs.json");
    const taskFile = path.join(recipe, "task.json");
    if (![rulesFile, configsFile, taskFile].every(existsSync)) throw new Error("project-workflow recipe is not ready");
    const recipeRules = JSON.parse(readFileSync(rulesFile, "utf8"));
    const configs = JSON.parse(readFileSync(configsFile, "utf8"));
    const taskInput = JSON.parse(readFileSync(taskFile, "utf8"));
    const repo = repository(root);
    const workflow = recipeRules.workflows["project-workflow"];
    const artifactPaths = workflow.git.artifact_paths as string[];
    const trace: WorkflowTrace[] = [];
    const lodestars: Record<string, Awaited<ReturnType<typeof fakeLodestar>>> = {};
    for (const worker of ["mac-a", "mac-b", "mac-c"]) {
      lodestars[worker] = await fakeLodestar({
        root,
        worker,
        projectRoot: repo.roots[worker],
        artifactPaths,
        capability: `capability-${worker}`,
        trace,
      });
      servers.push(lodestars[worker].server);
    }
    let owner: any;
    let taskId = "";
    const notify = await fakeNotify(root, async () => {
      if (!owner || !taskId) throw new Error("waiting for task intake");
      const task = await owner.projectTask(taskId);
      await owner.answer(task.human_card, { text: HUMAN_NOTE });
      if ((await owner.projectTask(taskId)).state !== "waiting_human")
        throw new Error("human text must remain data until the trusted retry choice is accepted");
    });
    servers.push(notify.server);
    const rules = transformRules(
      recipeRules,
      repo,
      Object.fromEntries(Object.entries(lodestars).map(([worker, value]) => [worker, value.clientFile])),
      path.join(root, "checks.log"),
    );
    const hubHome = path.join(root, "hub-home");
    mkdirSync(hubHome, { recursive: true, mode: 0o700 });
    const isolatedRules = path.join(hubHome, "rules.json");
    writeFileSync(isolatedRules, JSON.stringify(rules));
    process.env.AGENT_AUTOLOOP_HOME = hubHome;
    process.env.AGENT_AUTOLOOP_RULES = isolatedRules;
    process.env.AGENT_AUTOLOOP_PUBLIC_URL = "http://127.0.0.1";
    const runtime = await import("../host/runtime.ts");
    const { serve } = await import("../host/http.ts");
    const { hubClient } = await import("../protocol/client.ts");
    const keys = {
      source: runtime.addKey("source", "projects"),
      owner: runtime.addKey("owner", "owner"),
      workers: Object.fromEntries(
        ["mac-a", "mac-b", "mac-c"].map((worker) => [worker, runtime.addKey("worker", worker)]),
      ),
      channel: runtime.addKey("channel", "project-cards"),
    };
    const hubServer = serve(0, "127.0.0.1", { commit: "fixture" });
    await once(hubServer, "listening");
    servers.push(hubServer);
    const url = `http://127.0.0.1:${(hubServer.address() as AddressInfo).port}`;
    writeFileSync(
      path.join(hubHome, "config.json"),
      JSON.stringify({ url, source: { name: "projects", key: keys.source }, owner: keys.owner }),
      { mode: 0o600 },
    );
    const workerHomes = ["mac-a", "mac-b", "mac-c"].map((worker) => path.join(root, `${worker}-home`));
    if (options.publicationLoss)
      installPublicationLoss(workerHomes[1]!, path.join(root, "publication-loss.json"), path.join(root, "checks.log"));
    for (const [index, worker] of ["mac-a", "mac-b", "mac-c"].entries()) {
      const channelTemplate = configs[worker]?.channels?.["project-cards"];
      const child = startWorker({
        home: workerHomes[index],
        url,
        name: worker,
        key: keys.workers[worker],
        ...(worker === "mac-c"
          ? {
              channel: {
                id: "project-cards",
                key: keys.channel,
                use: channelTemplate?.use ?? "lodestar",
                options: {
                  instance: channelTemplate?.instance ?? "fixture-cards",
                  project: "fixture-project",
                  client_file: notify.clientFile,
                },
              },
            }
          : {}),
      });
      child.stderr?.on("data", (chunk) => workerLogs.push(`${worker}: ${chunk}`));
      workers.push(child);
    }
    const task = { ...taskInput, id: `fixture-${randomUUID()}`, subject: `fixture-${randomUUID()}` };
    const created = await runCli(hubHome, ["task", "submit", "--json"], JSON.stringify(task));
    const cliReplay = await runCli(hubHome, ["task", "submit", "--json"], JSON.stringify(task));
    owner = hubClient(url, keys.owner);
    taskId = created.task_id;
    const diagnostics = () => {
      const files = workerHomes.flatMap((home) =>
        walk(path.join(home, "worker", "runs"), "entry.json").flatMap((entry) => {
          const folder = path.dirname(entry);
          return [
            entry,
            ...walk(folder, "lodestar-journal.json"),
            ...walk(folder, "stdout-1.log"),
            ...walk(folder, "stderr-1.log"),
          ];
        }),
      );
      return [
        ...workerLogs,
        `trace=${JSON.stringify(trace)}`,
        ...files.map((file) => `${file}: ${readFileSync(file, "utf8")}`),
      ].join("\n");
    };
    let completed = await waitForTask(owner, created.task_id, "completed", {}, diagnostics);
    const firstGenerationRevision = completed.current_revision;
    const firstGenerationEvidence = structuredClone(completed.executions);
    const taskRef = `refs/heads/autoloop/${createHash("sha256").update(created.task_id).digest("hex").slice(0, 40)}`;
    let mcpReplay: any = {};
    let recheckRevision: string | undefined;
    let refsBeforeRecheck: string | undefined;
    let refsAfterRecheck: string | undefined;
    if (options.recheck) {
      git(repo.source, "fetch", repo.remote, taskRef);
      git(repo.source, "checkout", "--detach", "FETCH_HEAD");
      writeFileSync(path.join(repo.source, "README.md"), "external task-ref advance before recheck\n");
      git(repo.source, "add", "README.md");
      git(repo.source, "commit", "-m", "advance task ref outside the completed generation");
      git(repo.source, "push", repo.remote, `HEAD:${taskRef}`);
      recheckRevision = git(repo.source, "rev-parse", "HEAD");
      refsBeforeRecheck = git(repo.source, "ls-remote", "--refs", repo.remote);
      const request = { task_id: created.task_id, request_id: `recheck-${created.task_id}` };
      await mcpTool(hubHome, "task_recheck", request);
      mcpReplay = await mcpTool(hubHome, "task_recheck", request);
      completed = await waitForTask(owner, created.task_id, "completed", {}, diagnostics);
      refsAfterRecheck = git(repo.source, "ls-remote", "--refs", repo.remote);
    }
    const rejectedCrossWorkspaceResume = await lodestars["mac-b"]!.rejectCrossWorkspaceResume(
      trace.find((item) => item.stage === "execute")!,
    );
    const remoteTaskRevision = git(REPO, "ls-remote", "--refs", repo.remote, taskRef).split(/\s+/, 1)[0]!;
    const artifactText = String(
      execFileSync("git", ["--git-dir", repo.remote, "show", `${remoteTaskRevision}:${artifactPaths[0]}`], {
        encoding: "utf8",
      }),
    );
    return {
      task: completed,
      trace,
      cliReplay,
      mcpReplay,
      ...notify.stats(),
      remoteTaskRevision,
      firstGenerationRevision,
      artifactText,
      humanNote: HUMAN_NOTE,
      reviewFinding: REVIEW_FINDING,
      rejectedCrossWorkspaceResume,
      firstGenerationEvidence,
      recheckRevision,
      refsBeforeRecheck,
      refsAfterRecheck,
      ...(options.publicationLoss
        ? { publicationRecovery: JSON.parse(readFileSync(path.join(root, "publication-loss.json"), "utf8")) }
        : {}),
    } satisfies ProjectWorkflowResult;
  } finally {
    await stopWorkers(
      workers,
      ["mac-a", "mac-b", "mac-c"].map((worker) => path.join(root, `${worker}-home`)),
    );
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function workerMain(file: string) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  process.env.AGENT_AUTOLOOP_HOME = config.home;
  for (const key of [
    "LODESTAR_AGENT_ROLE",
    "LODESTAR_AGENT_URL",
    "LODESTAR_AGENT_CAPABILITY",
    "LODESTAR_AGENT_SESSION",
    "DSH_LODESTAR_AGENT_CONTEXT",
  ])
    delete process.env[key];
  const { hubClient } = await import("../protocol/client.ts");
  const { createWorker } = await import("../worker/worker.ts");
  const stop = new AbortController();
  let stopping = false;
  const halt = () => {
    stopping = true;
    stop.abort();
  };
  process.on("SIGTERM", halt);
  process.on("SIGINT", halt);
  const worker = createWorker({
    hub: hubClient(config.url, config.key),
    name: config.name,
    capacity: 1,
    wait: 0,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const jobs: Promise<unknown>[] = [];
  if (config.channel) {
    const { loadChannel } = await import("../host/channels.ts");
    const start = await loadChannel(config.channel.use);
    jobs.push(
      start({
        hub: hubClient(config.url, config.channel.key),
        hubOrigin: config.url,
        options: config.channel.options,
        log: () => {},
        signal: stop.signal,
      }),
    );
  }
  while (!stopping) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await Promise.allSettled(jobs);
}

async function lodestarHarness(file: string) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const lodestar = process.cwd();
  const [{ AgentService }, { AgentRequestStore }, { handleAgentRequest }, identities, tokenSources] = await Promise.all(
    [
      import(pathToFileURL(path.join(lodestar, "src", "agent-service.ts")).href),
      import(pathToFileURL(path.join(lodestar, "src", "agent-request-store.ts")).href),
      import(pathToFileURL(path.join(lodestar, "src", "agent-api.ts")).href),
      import(pathToFileURL(path.join(lodestar, "src", "agent-identities.ts")).href),
      import(pathToFileURL(path.join(lodestar, "src", "token-source.ts")).href),
    ],
  );
  tokenSources.registerTokenSource({
    id: "interop-source",
    kind: "api-test",
    agent: "claude",
    display: "Interop",
    enabled: true,
    models: [{ model: "interop-model", display: "Interop", efforts: ["max"], defaultEffort: "max" }],
    defaultModel: "interop-model",
    modelCatalogState: { status: "ready", updatedAt: Date.now() },
    refreshModels: async () => {},
    spawnEnv: (env: Record<string, string | undefined>) => env,
    resolveSpawnModel: (model: string) => model,
  });
  const artifacts = new Map<string, any>();
  const textArtifacts = new Map<string, string>();
  const liveNative = new Set<number>();
  const postStatuses: number[] = [];
  let starts = 0;
  let blockAdmission = false;
  const storePath = path.join(config.root, "request-store.json");
  const requestStore = new AgentRequestStore({ path: storePath });
  const markAdmitted = requestStore.markAdmitted.bind(requestStore);
  requestStore.markAdmitted = (...args: any[]) => {
    if (!blockAdmission) return markAdmitted(...args);
    // Match the real persistence boundary: rename cannot replace a directory. The original store is restored
    // after every failed write so the adapter can still look up the same pending request and live run.
    const saved = `${storePath}.saved`;
    renameSync(storePath, saved);
    mkdirSync(storePath);
    try {
      return markAdmitted(...args);
    } finally {
      rmSync(storePath, { recursive: true });
      renameSync(saved, storePath);
    }
  };
  const startWorker = (options: any) => {
    starts++;
    if (config.faults) {
      const native = starts;
      liveNative.add(native);
      const done = String(options.prompt).includes("fault-failed-alive")
        ? Promise.reject(new Error("native turn failed while cleanup left the process alive"))
        : new Promise(() => {});
      void done.catch(() => {});
      return {
        done,
        pendingInput: () => null,
        answer() {},
        isAlive: () => liveNative.has(native),
        async cancel() {
          throw new Error("native termination is not confirmed");
        },
      };
    }
    if (String(options.prompt).includes("cancel through")) {
      let reject!: (error: Error) => void;
      let alive = true;
      const done = new Promise((_resolve, failure) => (reject = failure));
      return {
        done,
        pendingInput: () => null,
        answer() {},
        isAlive: () => alive,
        async cancel(reason = "cancelled") {
          alive = false;
          reject(new Error(reason));
          await done.catch(() => {});
        },
      };
    }
    return {
      done: Promise.resolve({
        output: "progress that is not terminal",
        finalOutput: "real AgentService terminal",
        outputTruncated: false,
        sessionId: "native-interop",
        durationMs: 1,
        usage: null,
      }),
      pendingInput: () => null,
      answer() {},
      isAlive: () => false,
      async cancel() {},
    };
  };
  const deps: any = {
    requestStore,
    getCatalog: identities.getAgentIdentityCatalog,
    startWorker,
    sendCard: async () => "message-interop",
    sendTextRaw: async () => true,
    getChatTailMessageId: async () => null,
    getElementCount: () => 1,
    addElementResult: async () => ({ landed: true }),
    deleteElementChecked: async () => true,
    convertMessageToCard: async () => "message-interop",
    recordCardCreated: () => {},
    replaceElementResult: async () => ({ landed: true }),
    cancelSummary: () => {},
    patchSettingsChecked: async () => true,
    dispose: async () => {},
    writeArtifact: (file: string, value: any) => {
      artifacts.set(file, structuredClone(value));
    },
    writeTextArtifact: (file: string, value: string) => {
      textArtifacts.set(file, value);
    },
    readTextArtifact: (name: string, label: string) => {
      const value = [...textArtifacts].find(([file]) => file.endsWith(`/${name}`))?.[1];
      if (value === undefined) throw new Error(`${label} is unreadable`);
      return value;
    },
    loadArtifacts: () => [],
  };
  let service = new AgentService(deps);
  const owner = { kind: "project" as const, name: "repo", chatId: "chat-interop", workDir: config.project };
  let principal = service.projectPrincipal({ owner });
  const server = createServer((request, response) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    if (config.faults && request.method === "POST" && url.pathname.startsWith("/fixture/")) {
      if (request.headers.authorization !== `Bearer ${config.capability}`)
        return send(response, 403, { error: "bad fixture capability" });
      if (url.pathname === "/fixture/block-admission") blockAdmission = true;
      else if (url.pathname === "/fixture/allow-admission") blockAdmission = false;
      else if (url.pathname === "/fixture/restart") {
        blockAdmission = false;
        service = new AgentService({
          ...deps,
          requestStore: new AgentRequestStore({ path: storePath }),
          loadArtifacts: () => [...artifacts.values()].map((value) => structuredClone(value)),
        });
        principal = service.projectPrincipal({ owner });
      } else if (url.pathname !== "/fixture/state") return send(response, 404, { error: "unknown fixture action" });
      return send(response, 200, { starts, live: liveNative.size, postStatuses });
    }
    if (request.method === "POST" && url.pathname === "/agents/runs")
      response.once("finish", () => postStatuses.push(response.statusCode));
    void handleAgentRequest(request, response, url, {
      service,
      authorizeSession: () => null,
      authorizeProject: (capability: string, project: string) =>
        capability === config.capability && project === "repo" ? principal : null,
      authorizeOperator: () => null,
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(config.ready, JSON.stringify({ baseUrl, capability: config.capability }), { mode: 0o600 });
  while (!existsSync(config.stop)) await new Promise((resolve) => setTimeout(resolve, 25));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const mode = process.argv[2];
  if (mode === "scenario") {
    scenario(process.argv[3]!, JSON.parse(process.argv[4] ?? "{}")).then(
      (result) => process.stdout.write(JSON.stringify(result)),
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
        process.exitCode = 1;
      },
    );
  } else if (mode === "worker") {
    workerMain(process.argv[3]!).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
      process.exitCode = 1;
    });
  } else if (mode === "lodestar-harness") {
    lodestarHarness(process.argv[3]!).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
      process.exitCode = 1;
    });
  }
}
