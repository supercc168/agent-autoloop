// Failure mode: Node environment-proxy support tunnels loopback Agent capability and notify bodies through HTTP_PROXY.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { directLoopbackRequest } from "../plugins/lodestar/local-http.ts";

function child(code: string, env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--use-env-proxy", "--input-type=module", "-e", code], {
      cwd: globalThis.process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => (stdout += chunk));
    process.stderr.on("data", (chunk) => (stderr += chunk));
    process.on("error", reject);
    process.on("exit", (status) =>
      status === 0 ? resolve(stdout) : reject(new Error(`proxy probe child ${status}: ${stderr}`)),
    );
  });
}

test("Lodestar loopback transports bypass Node environment proxy without leaking capability or body", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "autoloop-direct-loopback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const proxySeen: string[] = [];
  const targetSeen: { url?: string; authorization?: string; body: string }[] = [];
  let notifyRequestId = "";
  const target = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    targetSeen.push({ url: request.url, authorization: request.headers.authorization, body });
    let parsed: any = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {}
    if (parsed.request_id) notifyRequestId = parsed.request_id;
    let value: any = { ok: true };
    if (request.url === "/notify") {
      value = {
        ok: true,
        chat_id: "chat",
        message_id: "om_target",
        notify_id: "nf_target",
        request_id: notifyRequestId,
        transport_state: "applied",
        version: 1,
        applied_version: 1,
      };
    } else if (request.url?.startsWith("/notify/result/")) {
      value = {
        notify_id: "nf_target",
        project: "repo",
        message_id: "om_target",
        resolved: false,
        request_id: notifyRequestId,
        transport_state: "applied",
        version: 1,
        applied_version: 1,
      };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    target.closeAllConnections();
    target.close();
  });

  const proxy = createServer();
  proxy.on("connect", (request, client, head) => {
    proxySeen.push(`CONNECT ${request.url}`);
    const [host, port] = request.url!.split(":");
    const upstream = connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.on("data", (chunk) => proxySeen.push(chunk.toString("utf8")));
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });

  const targetUrl = `http://127.0.0.1:${(target.address() as any).port}`;
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as any).port}`;
  const clientFile = path.join(directory, "client.json");
  const dataHome = path.join(directory, "home");
  mkdirSync(dataHome);
  writeFileSync(clientFile, JSON.stringify({ baseUrl: targetUrl, capability: "SYNTHETIC_CAPABILITY_SECRET" }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
    CLIENT: clientFile,
    AGENT_AUTOLOOP_HOME: dataHome,
  };
  for (const key of [
    "LODESTAR_AGENT_ROLE",
    "LODESTAR_AGENT_URL",
    "LODESTAR_AGENT_CAPABILITY",
    "LODESTAR_AGENT_SESSION",
    "DSH_LODESTAR_AGENT_CONTEXT",
  ]) {
    delete env[key];
  }

  await child(
    `const {localRequest}=await import("./plugins/lodestar/run.ts");` +
      `await localRequest({project:"repo",identity:"executor",clientFile:process.env.CLIENT},` +
      `"POST","/agents/runs",{secret:"LOCAL_BODY_SECRET"});`,
    env,
  );
  await child(
    `const channel=(await import("./plugins/lodestar/channel.ts")).default;` +
      `const stop=new AbortController();let sent=false;` +
      `await channel({hubOrigin:"https://hub.example.test",` +
      `options:{instance:"probe",project:"repo",client_file:process.env.CLIENT},log:()=>{},signal:stop.signal,hub:{` +
      `nextCard:async()=>sent?{card:null}:(sent=true,{card:{id:1,version:1,ref:null,kind:"ask",state:"open",` +
      `title:"Probe",text:"NOTIFY_BODY_SECRET",options:["Yes","No"],recommend:0,choice:null,answer:null,result:null,link:null}}),` +
      `delivered:async()=>stop.abort(),failed:async()=>({}),answer:async()=>({changed:true})}});`,
    env,
  );

  assert.deepEqual(proxySeen, [], "no CONNECT or request bytes may reach the configured environment proxy");
  assert.equal(targetSeen.length, 3);
  assert.equal(targetSeen[0]!.authorization, "Bearer SYNTHETIC_CAPABILITY_SECRET");
  assert.match(targetSeen[0]!.body, /LOCAL_BODY_SECRET/);
  assert.equal(targetSeen[1]!.authorization, undefined, "notify remains capability-free");
  assert.match(targetSeen[1]!.body, /NOTIFY_BODY_SECRET/);
});

test("direct loopback transport keeps no-redirect, timeout, UTF-8 and status/body semantics", async (t) => {
  let redirected = 0;
  const redirectTarget = createServer((_request, response) => {
    redirected++;
    response.end("unexpected");
  });
  await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    redirectTarget.closeAllConnections();
    redirectTarget.close();
  });
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `http://127.0.0.1:${(redirectTarget.address() as any).port}/leak` });
      response.end();
      return;
    }
    if (request.url === "/slow") return;
    if (request.url === "/error") {
      response.writeHead(409, { "content-type": "application/json" });
      response.end('{"error":"冲突"}');
      return;
    }
    const bytes = Buffer.from('{"text":"中文🎉"}');
    response.writeHead(200, { "content-type": "application/json" });
    response.write(bytes.subarray(0, 12));
    setImmediate(() => response.end(bytes.subarray(12)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const utf8 = await directLoopbackRequest(`${base}/utf8`, { method: "GET" });
  assert.deepEqual(JSON.parse(utf8.text), { text: "中文🎉" });
  const conflict = await directLoopbackRequest(`${base}/error`, { method: "GET" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.ok, false);
  assert.deepEqual(JSON.parse(conflict.text), { error: "冲突" });
  const redirect = await directLoopbackRequest(`${base}/redirect`, { method: "GET" });
  assert.equal(redirect.status, 302);
  assert.equal(redirected, 0);
  await assert.rejects(
    directLoopbackRequest(`${base}/slow`, { method: "GET", timeoutMs: 20 }),
    (error: any) => error?.name === "TimeoutError",
  );
});
