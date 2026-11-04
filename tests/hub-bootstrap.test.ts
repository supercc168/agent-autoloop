// Failure modes: a cloud Hub probes model credentials, installs a local worker/desktop channel, overwrites rules,
// or cannot accept an authenticated remote worker. Every child uses a private home and a random loopback port.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { hubClient } from "../protocol/client.ts";

const CLI = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const scratch = mkdtempSync(join(tmpdir(), "autoloop-hub-bootstrap-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const environment = (home: string) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("AGENT_AUTOLOOP_") && key !== "NODE_TEST_CONTEXT"),
  ),
  AGENT_AUTOLOOP_HOME: home,
});
const command = (home: string, args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
    env: environment(home),
    encoding: "utf8",
  });

function cloudHome(name: string) {
  const home = join(scratch, name);
  mkdirSync(home);
  for (const adapter of ["codex", "claude"]) {
    const folder = join(home, "plugins", adapter);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "agent.ts"),
      `import { writeFileSync } from 'node:fs'; export default { command() { writeFileSync(${JSON.stringify(join(home, "probed-model"))}, 'probed'); throw new Error('no model installed'); }, read() { return {}; } };`,
    );
  }
  return home;
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("pure cloud initialization has no model probe, worker or desktop and serves a remote worker", async (t) => {
  const home = cloudHome("pure");
  const port = await freePort();
  const result = command(home, [
    "init",
    "--hub-only",
    "--no-service",
    "--listen",
    `127.0.0.1:${port}`,
    "--public-url",
    "https://hub.example.test",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(config.worker, undefined);
  assert.equal(config.channels, undefined);
  assert.equal(config.hub.publicUrl, "https://hub.example.test");
  assert.equal(existsSync(join(home, "probed-model")), false);
  assert.equal(existsSync(join(home, "try")), false);
  assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600);
  const rules = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
  assert.deepEqual(rules.agents, {});
  assert.deepEqual(rules.channels, {});
  assert.deepEqual(rules.rules, []);
  rules.agents.remote = { name: "外部执行节点", worker: "remote", use: "command", command: ["echo", "done"] };
  rules.rules = [{ name: "远程任务", when: { source: "local", types: ["remote.test"] }, to: "remote", cwd: home }];
  writeFileSync(join(home, "rules.json"), JSON.stringify(rules));
  const keyResult = command(home, ["key", "new", "worker", "remote"]);
  assert.equal(keyResult.status, 0, keyResult.stderr);
  const workerKey = keyResult.stdout.trim().split("\n").at(-1)!;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "up"], {
    env: environment(home),
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      if ((await fetch(`${config.url}/healthz`)).ok) break;
    } catch {}
    assert.ok(Date.now() < deadline, "cloud Hub did not listen");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await hubClient(config.url, config.source.key).event({ id: "remote-one", type: "remote.test", subject: "one" });
  const remote = hubClient(config.url, workerKey);
  const packet = await remote.work({ claim: "remote-claim", wait: 0, running: [], capacity: true });
  assert.equal(packet.job.agent.worker, "remote");
  await remote.result(packet.job.run, packet.job.token, { outcome: "done", summary: "远程验收完成" });
  const state = await hubClient(config.url, config.owner).state();
  assert.equal(state.runs[0].summary, "远程验收完成");
});

test("pure Hub preserves supplied rules and rejects conflicting or malformed bootstrap options", () => {
  const home = cloudHome("supplied");
  const rules = JSON.stringify({ sources: { local: { name: "本机" } }, agents: {}, channels: {}, rules: [] }, null, 2);
  writeFileSync(join(home, "rules.json"), rules);
  const result = command(home, ["init", "--hub-only", "--no-service"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(home, "rules.json"), "utf8"), rules);
  for (const [name, args] of [
    ["agent-conflict", ["--agent", "codex"]],
    ["bad-listen", ["--listen", "bad"]],
    ["bad-public", ["--public-url", "javascript:alert(1)"]],
  ] as const) {
    const invalid = cloudHome(name);
    const failed = command(invalid, ["init", "--hub-only", "--no-service", ...args]);
    assert.notEqual(failed.status, 0);
    assert.equal(existsSync(join(invalid, "config.json")), false);
    assert.equal(existsSync(join(invalid, "probed-model")), false);
  }
});
