// Failure modes: the public recipe names nonexistent fields or commands, puts a worker/channel on the cloud Hub,
// assigns review to the writer, leaves workflow cycles unbounded, lets inspect imply a sandbox, or documents an
// uncertain/cancelled execution as safe to replay without a separate operator attestation and human decision.
// Fresh installs must not probe models, replace the cloud owner, or require Hub rules on worker-only machines.
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";
import { rows } from "../kernel/evolve.ts";
import { hubClient } from "../protocol/client.ts";

const root = join(import.meta.dirname, "..");
const recipe = join(root, "examples", "recipes", "project-workflow");
const rulesFile = join(recipe, "rules.json");
const configsFile = join(recipe, "configs.json");
const taskFile = join(recipe, "task.json");
const readmeFile = join(recipe, "README.md");
const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
const configs = JSON.parse(readFileSync(configsFile, "utf8"));
const taskInput = JSON.parse(readFileSync(taskFile, "utf8"));
const readme = readFileSync(readmeFile, "utf8");
const home = setup("project-workflow-example", rulesFile);

const hub = await import("../host/runtime.ts");
const { projectTask } = await import("../kernel/query.ts");
const { parseProjectTaskInput } = await import("../protocol/project-tasks.ts");

const revision = (letter: string) => letter.repeat(40);
const sha = (letter: string) => letter.repeat(64);
const claim = (worker: string, key: string, minute: number) => hub.claimNext(worker, key, at(minute))!;
function receipt(job: any, verdict: string, input: string, output = input) {
  return {
    outcome: "done",
    summary: `${job.stage.stage_id}:${verdict}`,
    stage: {
      execution_id: job.stage.execution_id,
      request_id: job.stage.execution_id,
      verdict,
      input_revision: input,
      output_revision: output,
      remote_ref: `refs/heads/autoloop/${job.stage.task_id}`,
      artifacts: [{ path: "PLAN.md", revision: output, sha256: sha("f") }],
      checks: job.stage.checks.map((check: any) => ({ name: check.name, exit_code: 0, revision: output })),
      findings: verdict === "changes_requested" ? [{ severity: "blocking", summary: "Fix the rejected behavior" }] : [],
    },
  };
}

test("recipe rules validate a bounded three-Mac plan/write/review/rework/verify graph", () => {
  const parsed = hub.parseRules(JSON.stringify(rules), at(0));
  const workflow = parsed.workflows["project-workflow"];
  assert.equal(workflow.entry, "plan");
  assert.equal(workflow.recheck, "review");
  assert.ok(workflow.max_transitions > 0 && workflow.max_transitions <= 20);
  assert.deepEqual(Object.keys(workflow.stages), ["plan", "execute", "review", "rework", "verify"]);
  assert.equal(workflow.stages.review.on.changes_requested, "rework");
  assert.equal(workflow.stages.verify.on.changes_requested, "rework");
  assert.equal(workflow.stages.verify.on.verified, "$complete");
  assert.ok(Object.values(workflow.stages).every((stage: any) => stage.max_visits > 0));
  assert.ok(workflow.human.options.some((option: any) => option.action === "retry"));
  assert.ok(workflow.human.options.some((option: any) => option.action === "cancel"));

  const byName = new Map(parsed.rules.map((rule: any) => [rule.name, rule]));
  const stageWorkers = Object.values(workflow.stages).map((stage: any) => {
    const route: any = byName.get(stage.route);
    const agent = parsed.agents[route.to];
    const command = agent.command!;
    assert.equal(agent.use, "lodestar");
    assert.equal(agent.access, "full");
    assert.deepEqual(command.slice(0, 2), ["--project", "sample-app"]);
    assert.ok(command.includes("--identity"));
    assert.ok(command.includes("--client-file"));
    assert.equal(route.when.source, "workflow-internal");
    return agent.worker;
  });
  assert.deepEqual(new Set(stageWorkers), new Set(["mac-a", "mac-b", "mac-c"]));
  assert.equal(configs.cloud.source.name, "projects");
  assert.equal(
    (byName.get(workflow.stages.execute.route) as any).to,
    (byName.get(workflow.stages.rework.route) as any).to,
  );
  assert.notEqual(
    (byName.get(workflow.stages.execute.route) as any).to,
    (byName.get(workflow.stages.review.route) as any).to,
  );
  assert.equal(workflow.stages.review.mode, "inspect");
  assert.equal(parsed.agents[(byName.get(workflow.stages.review.route) as any).to].access, "full");
});

test("ordinary intake executes independent review, bounded rework and exact verification on the configured workers", () => {
  const parsed = parseProjectTaskInput(taskInput);
  const accepted = hub.execute("submitProjectTask", ["projects", parsed], at(0));
  let job = claim("mac-a", "recipe-plan", 1);
  assert.equal(job.stage!.stage_id, "plan");
  hub.finish(job.run, job.token, receipt(job, "planned", revision("a"), revision("b")), at(2));

  job = claim("mac-b", "recipe-execute", 3);
  assert.equal(job.stage!.stage_id, "execute");
  hub.finish(job.run, job.token, receipt(job, "implemented", revision("b"), revision("c")), at(4));

  job = claim("mac-c", "recipe-review-1", 5);
  assert.equal(job.stage!.stage_id, "review");
  hub.finish(job.run, job.token, receipt(job, "changes_requested", revision("c")), at(6));

  job = claim("mac-b", "recipe-rework", 7);
  assert.equal(job.stage!.stage_id, "rework");
  hub.finish(job.run, job.token, receipt(job, "implemented", revision("c"), revision("d")), at(8));

  job = claim("mac-c", "recipe-review-2", 9);
  hub.finish(job.run, job.token, receipt(job, "approved", revision("d")), at(10));
  job = claim("mac-c", "recipe-verify", 11);
  assert.equal(job.stage!.stage_id, "verify");
  hub.finish(job.run, job.token, receipt(job, "verified", revision("d")), at(12));

  const status = projectTask(hub.getView(), accepted.task_id)!;
  assert.equal(status.state, "completed");
  assert.equal(status.current_revision, revision("d"));
  assert.deepEqual(status.visits, { plan: 1, execute: 1, review: 2, rework: 1, verify: 1 });
  assert.equal(status.transitions, 6);

  const recheck = hub.execute("recheckProjectTask", [accepted.task_id, { request_id: "recipe-recheck-1" }], at(13));
  assert.equal(recheck.generation, 2);
  assert.equal(
    hub.execute("recheckProjectTask", [accepted.task_id, { request_id: "recipe-recheck-1" }], at(14)).duplicate,
    true,
  );
  job = claim("mac-c", "recipe-recheck", 15);
  assert.equal(job.stage!.stage_id, "review");
  assert.equal(job.stage!.generation, 2);
  const cancelled = hub.execute("cancelProjectTask", [accepted.task_id, { request_id: "recipe-cancel-1" }], at(16));
  assert.equal(cancelled.state, "cancel_requested");
  hub.finish(job.run, job.token, { outcome: "cancelled", summary: "native process stopped" }, at(17));
  assert.equal(projectTask(hub.getView(), accepted.task_id)!.state, "cancelled");
});

test("scheduled workflow intake uses one stable occurrence and task data cannot select executable policy", () => {
  hub.tick(at(20));
  hub.tick(at(1_400));
  const scheduled = rows(hub.getView(), "project_tasks", { source: "schedule" });
  assert.equal(scheduled.length, 1);
  const taskId = scheduled[0].task_id;
  hub.tick(at(1_400));
  assert.equal(rows(hub.getView(), "project_tasks", { source: "schedule" })[0].task_id, taskId);
  for (const field of ["workflow", "worker", "cwd", "project", "identity", "access", "command", "stage"]) {
    assert.throws(() => parseProjectTaskInput({ ...taskInput, [field]: "untrusted" }), /不认识的字段/);
  }
  assert.equal(parseProjectTaskInput({ ...taskInput, source: "projects" }, true).source, "projects");
  assert.throws(() => parseProjectTaskInput({ ...taskInput, source: "projects" }), /source/);
});

test("cloud and Mac profiles extract exactly, keep execution local and use only synthetic deployment values", () => {
  assert.deepEqual(Object.keys(configs), ["cloud", "mac-a", "mac-b", "mac-c"]);
  assert.ok(configs.cloud.hub);
  assert.equal(configs.cloud.worker, undefined);
  assert.equal(configs.cloud.channels, undefined);
  assert.equal(configs.cloud.models, undefined);
  assert.match(configs.cloud.hub.publicUrl, /^https:\/\//);
  assert.equal(configs.cloud.hub.listen, "127.0.0.1:3350");

  const extraction = `const fs=require("node:fs");const [name,out]=process.argv.slice(1);const all=JSON.parse(fs.readFileSync("configs.json","utf8"));if(!all[name])throw new Error("unknown profile");fs.writeFileSync(out,JSON.stringify(all[name],null,2)+"\\n",{mode:0o600});`;
  for (const name of ["cloud", "mac-a", "mac-b", "mac-c"]) {
    const out = join(home, `${name}.json`);
    const result = spawnSync(process.execPath, ["-e", extraction, name, out], { cwd: recipe, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), configs[name]);
  }

  for (const name of ["mac-a", "mac-b", "mac-c"]) {
    assert.equal(configs[name].worker.name, name);
    assert.match(configs[name].url, /^https:\/\//);
    assert.ok(!configs[name].hub);
  }
  assert.equal(configs["mac-a"].channels, undefined);
  assert.equal(configs["mac-b"].channels, undefined);
  const channel = configs["mac-c"].channels["project-cards"];
  assert.equal(channel.use, "lodestar");
  assert.equal(channel.project, "sample-app");
  assert.ok(channel.client_file.startsWith("/"));
  assert.ok(!JSON.stringify(configs).includes("/Users/chiuan"));
  assert.ok(!JSON.stringify(configs).includes("127.0.0.1:9876"), "cloud never targets a Mac's loopback Lodestar");
});

test("documented bootstrap installs candidate HEAD in four homes and authenticates owner, workers and only Mac C's channel", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "autoloop-recipe-bootstrap-"));
  const children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }),
    );
    rmSync(scratch, { recursive: true, force: true });
  });
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const sideEffects = join(scratch, "service-or-desktop-call");
  for (const command of ["launchctl", "systemctl", "osascript", "notify-send"]) {
    writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${sideEffects}'\nexit 1\n`, {
      mode: 0o755,
    });
  }
  const machine = (name: string) => {
    const directory = join(scratch, name);
    const data = join(directory, ".agent-autoloop");
    mkdirSync(directory);
    // A local override prevents even desktop-app discovery from reaching a real installed model.
    for (const adapter of ["claude", "codex"]) {
      const folder = join(data, "plugins", adapter);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "agent.ts"),
        `import { writeFileSync } from 'node:fs'; export default { command() { writeFileSync(${JSON.stringify(join(directory, "model-probe"))}, 'probed'); throw new Error('no model installed'); }, read() { return {}; } };`,
      );
    }
    return {
      name,
      directory,
      data,
      env: {
        HOME: directory,
        PATH: `${join(directory, ".local", "bin")}:${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        AGENT_AUTOLOOP_HOME: data,
        WORKFLOW_PRIVATE: join(directory, "project-workflow-private"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    };
  };
  const machines = ["cloud", "mac-a", "mac-b", "mac-c"].map(machine);
  const [cloud] = machines;
  const command = (file: string, args: string[], cwd: string, env = cloud.env) => {
    const result = spawnSync(file, args, { cwd, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, `${file} ${args[0]} failed: ${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const snapshot = join(scratch, "candidate");
  mkdirSync(snapshot);
  const files = command("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
  for (const file of new Set(files.split("\0").filter(Boolean))) {
    if (/^(\.git|\.gsd|\.planning|node_modules|dist)(\/|$)/.test(file) || !existsSync(join(root, file))) continue;
    mkdirSync(dirname(join(snapshot, file)), { recursive: true });
    cpSync(join(root, file), join(snapshot, file));
  }
  command("git", ["init", "--quiet"], snapshot);
  command("git", ["add", "."], snapshot);
  command(
    "git",
    [
      "-c",
      "user.name=Bootstrap Test",
      "-c",
      "user.email=bootstrap@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "candidate source snapshot",
    ],
    snapshot,
  );
  const candidateHead = command("git", ["rev-parse", "HEAD"], snapshot).trim();
  const install = readme.match(/^AGENT_AUTOLOOP_REPO=.*install\.sh[^\n]*/m)?.[0];
  assert.ok(install, "the recipe must provide its actual install command");
  for (const host of machines) {
    command("/bin/sh", ["-ec", install], snapshot, host.env);
    assert.equal(command("git", ["rev-parse", "HEAD"], join(host.data, "app"), host.env).trim(), candidateHead);
    assert.equal(existsSync(join(host.directory, "model-probe")), false, `${host.name} probed a model`);
    assert.equal(existsSync(join(host.data, "try")), false);
  }
  assert.equal(existsSync(sideEffects), false);
  const initialOwner = JSON.parse(readFileSync(join(cloud.data, "config.json"), "utf8")).owner;
  const block = (name: string) => {
    const match = new RegExp(`<!-- bootstrap:${name} -->\\s*\\x60\\x60\\x60bash\\n([\\s\\S]*?)\\x60\\x60\\x60`).exec(
      readme,
    );
    assert.ok(match, `missing executable bootstrap step: ${name}`);
    return match[1];
  };
  const run = (host: (typeof machines)[number], script: string) =>
    command("/bin/sh", ["-ec", script], join(host.data, "app"), host.env);
  run(cloud, block("private-copy"));
  const privateRules = JSON.parse(readFileSync(join(cloud.env.WORKFLOW_PRIVATE, "rules.json"), "utf8"));
  const profiles = JSON.parse(readFileSync(join(cloud.env.WORKFLOW_PRIVATE, "configs.json"), "utf8"));
  assert.equal(profiles.cloud.owner, initialOwner, "capture the initialized owner before replacing config.json");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  profiles.cloud.url = url;
  profiles.cloud.hub = { listen: `127.0.0.1:${port}`, publicUrl: url };
  // Operator edits are synthetic. The ordinary probes exercise claiming without starting a model or a cron task.
  privateRules.rules = privateRules.rules.filter((route: any) => !route.when.cron);
  for (const host of machines.slice(1)) {
    profiles[host.name].url = url;
    for (const agent of Object.values(privateRules.agents) as any[]) {
      if (agent.worker !== host.name) continue;
      agent.command[agent.command.indexOf("--identity") + 1] = `test-${host.name}`;
      agent.command[agent.command.indexOf("--client-file") + 1] = join(
        host.directory,
        "never-read-project-client.json",
      );
    }
    for (const route of privateRules.rules) {
      if (privateRules.agents[route.to].worker === host.name) route.cwd = host.directory;
    }
    privateRules.agents[`probe-${host.name}`] = {
      name: `Bootstrap ${host.name}`,
      worker: host.name,
      use: "command",
      access: "full",
      command: [process.execPath, "-e", `console.log('bootstrap ${host.name}')`],
    };
    privateRules.rules.push({
      name: `bootstrap-${host.name}`,
      when: { source: "projects", types: [`bootstrap.${host.name}`] },
      to: `probe-${host.name}`,
      cwd: host.directory,
    });
  }
  profiles["mac-c"].channels["project-cards"].client_file = join(
    machines[3].directory,
    "never-read-project-client.json",
  );
  writeFileSync(join(cloud.env.WORKFLOW_PRIVATE, "rules.json"), JSON.stringify(privateRules));
  writeFileSync(join(cloud.env.WORKFLOW_PRIVATE, "configs.json"), JSON.stringify(profiles));
  run(cloud, block("cloud-keys"));
  run(cloud, block("extract-profiles"));
  const ready = JSON.parse(readFileSync(join(cloud.data, "config.json"), "utf8"));
  assert.equal(ready.owner, initialOwner);
  assert.equal(ready.worker, undefined);
  assert.equal(ready.channels, undefined);
  run(cloud, block("hub-check"));
  const start = (host: (typeof machines)[number]) => {
    const child = spawn(join(host.directory, ".local", "bin", "agent-autoloop"), ["up"], {
      env: host.env,
      stdio: "ignore",
    });
    children.push(child);
  };
  start(cloud);
  const until = async (condition: () => Promise<boolean>, description: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await condition().catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(description);
  };
  await until(async () => (await fetch(`${url}/healthz`)).ok, "the configured Hub did not listen");
  const owner = hubClient(url, ready.owner);
  await owner.state();
  for (const host of machines.slice(1)) {
    const profile = join(cloud.env.WORKFLOW_PRIVATE, "profiles", `${host.name}.json`);
    assert.equal(statSync(profile).mode & 0o777, 0o600);
    cpSync(profile, join(host.directory, "agent-autoloop-profile.json"));
    run(host, block("mac-profile"));
    rmSync(join(host.data, "rules.json"));
    run(host, block("worker-preflight"));
    assert.equal(existsSync(join(host.data, "rules.json")), false, "Mac readiness must not load local rules");
    assert.equal(statSync(join(host.data, "config.json")).mode & 0o777, 0o600);
    // The channel authenticates against the real temporary Hub, but has no Lodestar or Feishu transport.
    const folder = join(host.data, "plugins", "lodestar");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "channel.ts"),
      `import { writeFileSync } from 'node:fs'; export default async ({ hub, signal }) => { await hub.nextCard(0); writeFileSync(${JSON.stringify(join(host.directory, "channel-started"))}, 'authenticated'); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); };`,
    );
    start(host);
  }
  await until(async () => {
    const state = await owner.state();
    return (
      state.agents.every((agent: any) => agent.online) &&
      state.channels.some((channel: any) => channel.id === "project-cards" && channel.online) &&
      existsSync(join(machines[3].directory, "channel-started"))
    );
  }, "all three configured workers and the Mac C channel must authenticate");
  const source = hubClient(url, ready.source.key);
  for (const host of machines.slice(1))
    await source.event({ id: host.name, type: `bootstrap.${host.name}`, subject: host.name });
  await until(async () => {
    const state = await owner.state();
    return machines.slice(1).every((host) => state.runs.some((run: any) => run.summary === `bootstrap ${host.name}`));
  }, "each installed worker must claim and return its synthetic command result");
  const status = run(cloud, block("owner-status"));
  for (const host of machines.slice(1)) assert.ok(status.includes(host.name));
  for (const host of machines.slice(0, 3)) assert.equal(existsSync(join(host.directory, "channel-started")), false);
  assert.equal(existsSync(sideEffects), false);
});

test("operator instructions preserve uncertainty, separate authority and honest deployment boundaries", () => {
  for (const words of [
    "agent-operator-client.json",
    "operator_attested",
    "requests reconcile",
    "unknown",
    "access: full",
    "inspect",
    "不是只读沙箱",
    "DNS",
    "TLS",
    "没有完成真实三机部署",
    "configs.json",
  ]) {
    assert.ok(readme.includes(words), `README is missing ${words}`);
  }
  assert.ok(!readme.includes("自动重试 unknown"));
  assert.ok(!readme.includes("inspect 就是只读"));
  assert.match(readme, /git clone .*YOUR_FORK|git clone .*你的 fork/i);
  assert.match(readme, /AGENT_AUTOLOOP_REPO=.*install\.sh/);
});

test("public protocol, plugin, installation and operator docs link the executable workflow without inventing a sandbox", () => {
  const files = {
    protocol: readFileSync(join(root, "docs", "protocol.md"), "utf8"),
    plugins: readFileSync(join(root, "docs", "plugins.md"), "utf8"),
    readme: readFileSync(join(root, "README.md"), "utf8"),
    english: readFileSync(join(root, "README.en.md"), "utf8"),
    install: readFileSync(join(root, "INSTALL.md"), "utf8"),
    skill: readFileSync(join(root, "skills", "agent-autoloop", "SKILL.md"), "utf8"),
    security: readFileSync(join(root, "SECURITY.md"), "utf8"),
  };
  for (const [name, text] of Object.entries(files)) {
    assert.match(text, /project-workflow/, `${name} must link or name the executable recipe`);
  }
  for (const phrase of [
    "POST /v1/project-tasks",
    "GET /v1/project-tasks/:task_id",
    "agent-autoloop-stage",
    "operator_attested",
    "request_id",
    "access: full",
  ]) {
    assert.ok(files.protocol.includes(phrase), `protocol is missing ${phrase}`);
  }
  assert.match(files.protocol, /inspect.*不是.*只读沙箱/s);
  assert.match(files.plugins, /Lodestar.*项目/s);
  assert.match(files.install, /纯 Hub|Hub.*不运行.*模型/s);
  assert.match(files.security, /agent-operator-client\.json/);
  assert.match(files.security, /unknown.*不.*重试/s);
  assert.match(files.skill, /task submit/);
  assert.match(files.skill, /task cancel/);
  assert.match(files.skill, /task recheck/);
});

test("architecture, CI scope and Lodestar usage expose the maintained generic seams", () => {
  const architecture = readFileSync(join(root, "docs", "architecture.svg"), "utf8");
  assert.match(architecture, /项目工作流/);
  assert.doesNotMatch(architecture, /约 1650 行/);
  const scope = readFileSync(join(root, "scripts", "ci-scope.sh"), "utf8");
  for (const path of [
    "examples/recipes/project-workflow",
    "tests/project-workflow-",
    "plugins/lodestar",
    "docs/protocol.md",
    "docs/architecture.svg",
  ]) {
    assert.ok(scope.includes(path), `ci-scope is missing ${path}`);
  }
  const usage = readFileSync(join(root, "..", "lodestar", "docs", "usage.md"), "utf8");
  for (const phrase of [
    "final_output",
    "/agents/project-binding",
    "/agents/requests/",
    "agent-operator-client.json",
    "request_id",
    "PUT /notify/",
    "transport_state",
    "operator_attested",
  ]) {
    assert.ok(usage.includes(phrase), `Lodestar usage is missing ${phrase}`);
  }
});
