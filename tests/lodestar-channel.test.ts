// Failure modes: a restart sends a second Feishu card, an unknown PUT is replayed, a forged operator/ref reaches the Hub,
// callback rejection freezes the card, or two channel instances advance one human decision twice.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { HubError } from "../protocol/client.ts";
import type { Card, ChannelContext } from "../host/channels.ts";
import { setup } from "./helpers.ts";

const home = setup("lodestar-channel");
const plugin = async () => (await import("../plugins/lodestar/channel.ts")).default;

const card = (over: Partial<Card> = {}): Card => ({
  id: 41,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "Choose next step",
  text: "Only an authorized operator may decide.",
  options: ["Retry", "Cancel"],
  recommend: 0,
  choice: null,
  answer: null,
  result: null,
  link: null,
  ...over,
});

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fakeNotify(
  options: {
    dropFirstCreate?: boolean;
    unknownPut?: boolean;
    redirectFirstCreate?: boolean;
    malformedGet?: boolean;
  } = {},
) {
  const records = new Map<string, any>();
  const requests: { method: string; path: string; body: any; authorization?: string }[] = [];
  let physicalCreates = 0;
  let putCalls = 0;
  let dropped = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({
      method: request.method!,
      path: url.pathname,
      body,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
    });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && url.pathname === "/notify") {
      if (options.redirectFirstCreate && !dropped) {
        dropped = true;
        response.writeHead(302, { location: "https://example.invalid/forbidden" });
        response.end();
        return;
      }
      let record = records.get(body.request_id);
      if (!record) {
        physicalCreates++;
        record = {
          request_id: body.request_id,
          notify_id: `nf_${physicalCreates}`,
          message_id: `om_${physicalCreates}`,
          chat_id: "chat",
          transport_state: "applied",
          version: body.version,
          applied_version: body.version,
          body,
          resolved: false,
        };
        records.set(body.request_id, record);
      } else {
        assert.deepEqual(body, record.body, "create replay must be byte-equivalent JSON data");
      }
      if (options.dropFirstCreate && !dropped) {
        dropped = true;
        request.socket.destroy();
        return;
      }
      return send(200, { ok: true, ...record });
    }
    if (request.method === "PUT" && url.pathname.startsWith("/notify/")) {
      putCalls++;
      const record = [...records.values()].find((item) => item.notify_id === decodeURIComponent(url.pathname.slice(8)));
      assert.ok(record);
      record.body = body;
      record.version = body.version;
      if (options.unknownPut) {
        record.transport_state = "unknown";
        return send(202, {
          error: "feishu_update_unknown",
          ok: false,
          ...record,
          applied_version: record.applied_version,
        });
      }
      record.transport_state = "applied";
      record.applied_version = body.version;
      return send(200, { ok: true, ...record });
    }
    if (request.method === "GET" && url.pathname.startsWith("/notify/result/")) {
      if (options.malformedGet) return send(200, { malformed: true });
      const id = decodeURIComponent(url.pathname.slice("/notify/result/".length));
      const record = [...records.values()].find((item) => item.notify_id === id);
      if (!record) return send(404, { error: "unknown notify_id" });
      return send(200, {
        notify_id: record.notify_id,
        request_id: record.request_id,
        project: "repo",
        message_id: record.message_id,
        resolved: record.resolved,
        transport_state: record.transport_state,
        version: record.version,
        applied_version: record.applied_version,
      });
    }
    return send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const clientFile = join(home, `client-${(server.address() as AddressInfo).port}.json`);
  await import("node:fs").then(({ writeFileSync }) =>
    writeFileSync(
      clientFile,
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        capability: "must-not-be-sent",
      }),
    ),
  );
  return {
    records,
    requests,
    clientFile,
    get physicalCreates() {
      return physicalCreates;
    },
    get putCalls() {
      return putCalls;
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

function context(
  notify: Awaited<ReturnType<typeof fakeNotify>>,
  instance: string,
  cards: Card[],
  answer: (card: number, body: any) => Promise<any>,
) {
  const delivered: any[] = [];
  const logs: string[] = [];
  const stop = new AbortController();
  const hub = {
    async nextCard() {
      const next = cards.shift() ?? null;
      if (!next) await new Promise((resolve) => setTimeout(resolve, 20));
      return { card: next };
    },
    async delivered(...args: any[]) {
      delivered.push(args);
      return {};
    },
    async failed() {
      return {};
    },
    answer,
  };
  return {
    context: {
      hub,
      hubOrigin: "https://hub.example.test",
      options: { instance, project: "repo", client_file: notify.clientFile },
      log: (line: string) => logs.push(line),
      signal: stop.signal,
    } as ChannelContext,
    delivered,
    logs,
    stop,
  };
}

test("loopback callback keeps unauthorized clicks retryable and forwards the real operator and message ref once", async (t) => {
  const notify = await fakeNotify();
  t.after(notify.close);
  const answers: any[] = [];
  const cards = [card()];
  const run = context(notify, "primary", cards, async (_card, body) => {
    answers.push(body);
    if (body.by !== "ou_authorized") throw new HubError(403, "not an allowed answerer");
    return { changed: true, state: "decided" };
  });
  const channel = await plugin();
  const running = channel(run.context);
  t.after(() => run.stop.abort());
  await waitFor(() => run.delivered.length === 1, "initial delivery");
  const create = notify.requests.find((request) => request.method === "POST")!;
  assert.equal(create.authorization, undefined, "project capability is never sent to notify");
  assert.match(create.body.request_id, /^hub_[0-9a-f]{40}$/);
  const callback = create.body.callback as string;
  const record = [...notify.records.values()][0];
  const click = (operator: string, over: object = {}) =>
    fetch(callback, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notify_id: record.notify_id,
        message_id: record.message_id,
        chat_id: "chat",
        project: "repo",
        version: 1,
        button: { id: "0", text: "Retry", type: "primary" },
        operator: { open_id: operator },
        timestamp: 1,
        ...over,
      }),
    });
  assert.equal((await click("ou_wrong")).status, 403);
  assert.equal((await click("ou_authorized")).status, 200);
  assert.deepEqual(answers, [
    { choice: 0, by: "ou_wrong", ref: record.message_id },
    { choice: 0, by: "ou_authorized", ref: record.message_id },
  ]);
  record.resolved = true;
  cards.push(card({ version: 2, ref: record.message_id, state: "decided", choice: 0 }));
  await waitFor(() => run.delivered.some((entry) => entry[1] === 2), "resolved Hub card delivery");
  assert.equal(notify.putCalls, 0, "Lodestar finalizes an accepted callback; the channel does not PUT a closed card");
  run.stop.abort();
  await running;
});

test("restart reconciles a lost create response with the same key and without a second physical card", async (t) => {
  const notify = await fakeNotify({ dropFirstCreate: true });
  t.after(notify.close);
  const first = context(notify, "restart", [card({ id: 42 })], async () => ({ changed: true }));
  const channel = await plugin();
  const firstRun = channel(first.context);
  await waitFor(() => notify.requests.some((request) => request.method === "POST"), "lost create attempt");
  first.stop.abort();
  await firstRun;

  const accepted: any[] = [];
  const second = context(notify, "restart", [], async (_card, body) => {
    accepted.push(body);
    return { changed: true };
  });
  const secondRun = channel(second.context);
  t.after(() => second.stop.abort());
  await waitFor(() => second.delivered.length === 1, "recovered delivery acknowledgment");
  assert.equal(notify.physicalCreates, 1);
  const posts = notify.requests.filter((request) => request.method === "POST");
  assert.ok(posts.length >= 2);
  assert.equal(posts[0]!.body.request_id, posts.at(-1)!.body.request_id);
  const record = [...notify.records.values()].find((item) => item.body.request_id === posts[0]!.body.request_id)!;
  const callback = posts[0]!.body.callback;
  assert.equal(
    (
      await fetch(callback, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notify_id: record.notify_id,
          message_id: record.message_id,
          chat_id: "chat",
          project: "repo",
          version: 1,
          button: { id: "0", text: "Retry", type: "primary" },
          operator: { open_id: "ou_authorized" },
          timestamp: 1,
        }),
      })
    ).status,
    200,
    "the original persisted callback address is live after restart",
  );
  assert.equal(accepted.length, 1);
  second.stop.abort();
  await secondRun;
});

test("restart retries the same Hub delivered acknowledgment after its response was lost", async (t) => {
  const notify = await fakeNotify();
  t.after(notify.close);
  const first = context(notify, "delivered-loss", [card({ id: 45 })], async () => ({ changed: true }));
  let attempts = 0;
  (first.context.hub as any).delivered = async (...args: any[]) => {
    attempts++;
    first.delivered.push(args);
    throw new Error("Hub response lost after commit");
  };
  const channel = await plugin();
  const firstRun = channel(first.context);
  await waitFor(() => attempts >= 1, "lost delivered response");
  first.stop.abort();
  await firstRun;

  const second = context(notify, "delivered-loss", [], async () => ({ changed: true }));
  const secondRun = channel(second.context);
  t.after(() => second.stop.abort());
  await waitFor(() => second.delivered.length === 1, "delivered retry after restart");
  assert.deepEqual(first.delivered[0], second.delivered[0]);
  assert.equal(notify.physicalCreates, 1);
  second.stop.abort();
  await secondRun;
});

test("unknown update is polled but never replayed or reported delivered", async (t) => {
  const notify = await fakeNotify({ unknownPut: true });
  t.after(notify.close);
  const cards = [card({ id: 43 }), card({ id: 43, version: 2, ref: "om_1", text: "updated" })];
  const run = context(notify, "unknown", cards, async () => ({ changed: true }));
  const channel = await plugin();
  const running = channel(run.context);
  t.after(() => run.stop.abort());
  await waitFor(() => notify.putCalls === 1, "unknown PUT");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(notify.putCalls, 1, "unknown PUT is not replayed");
  assert.deepEqual(
    run.delivered.map((entry) => entry[1]),
    [1],
  );
  assert.ok(
    notify.requests.some((request) => request.method === "GET"),
    "unknown transport is polled",
  );
  run.stop.abort();
  await running;
});

test("restart replays an exact PUT journaled before dispatch when daemon still reports the older applied version", async (t) => {
  const notify = await fakeNotify();
  t.after(notify.close);
  const first = context(notify, "put-before-dispatch", [card({ id: 48 })], async () => ({ changed: true }));
  const channel = await plugin();
  const firstRun = channel(first.context);
  await waitFor(() => first.delivered.length === 1, "version one delivery");
  first.stop.abort();
  await firstRun;

  const stateDir = join(home, "channels", "lodestar");
  const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const stateFile = readdirSync(stateDir)
    .map((name) => join(stateDir, name))
    .find((file) => JSON.parse(readFileSync(file, "utf8")).instance === "put-before-dispatch")!;
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const record = state.records["48"];
  record.desiredCard = card({ id: 48, version: 2, ref: record.messageId, text: "version two" });
  record.desiredBody = { ...record.createBody, version: 2, text: "version two" };
  record.putAttemptedVersion = 2;
  delete record.uncertainVersion;
  writeFileSync(stateFile, JSON.stringify(state));

  const second = context(notify, "put-before-dispatch", [], async () => ({ changed: true }));
  const secondRun = channel(second.context);
  t.after(() => second.stop.abort());
  await waitFor(() => notify.putCalls === 1, "safe replay of unsent PUT");
  await waitFor(() => second.delivered.some((entry) => entry[1] === 2), "version two delivery");
  assert.equal(notify.requests.filter((request) => request.method === "PUT").length, 1);
  second.stop.abort();
  await secondRun;
});

test("redirecting create and malformed poll responses stay transport failures, never workflow results", async (t) => {
  const redirect = await fakeNotify({ redirectFirstCreate: true });
  t.after(redirect.close);
  const redirected = context(redirect, "redirect", [card({ id: 46 })], async () => ({ changed: true }));
  const channel = await plugin();
  const redirectRun = channel(redirected.context);
  t.after(() => redirected.stop.abort());
  await waitFor(() => redirect.requests.length >= 1, "redirect refusal");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(redirected.delivered.length, 0);
  assert.ok(redirected.logs.some((line) => /pending|redirect|fetch/i.test(line)));
  redirected.stop.abort();
  await redirectRun;

  const malformed = await fakeNotify({ malformedGet: true });
  t.after(malformed.close);
  const polled = context(malformed, "malformed", [card({ id: 47 })], async () => ({ changed: true }));
  const pollRun = channel(polled.context);
  t.after(() => polled.stop.abort());
  await waitFor(() => malformed.requests.some((request) => request.method === "GET"), "malformed result poll");
  assert.equal(polled.delivered.length, 1, "the confirmed create remains delivered");
  assert.ok(polled.logs.some((line) => /invalid|reconciliation/i.test(line)));
  polled.stop.abort();
  await pollRun;
});

test("two channel instances race one Hub choice but only the authoritative acceptance returns 2xx", async (t) => {
  const notify = await fakeNotify();
  t.after(notify.close);
  let decided = false;
  let changes = 0;
  const answer = async (_card: number, _body: any) => {
    if (decided) return { changed: false, state: "decided" };
    decided = true;
    changes++;
    return { changed: true, state: "decided" };
  };
  const one = context(notify, "one", [card({ id: 44 })], answer);
  const two = context(notify, "two", [card({ id: 44 })], answer);
  const channel = await plugin();
  const runs = [channel(one.context), channel(two.context)];
  t.after(() => {
    one.stop.abort();
    two.stop.abort();
  });
  await waitFor(() => one.delivered.length === 1 && two.delivered.length === 1, "two deliveries");
  const records = [...notify.records.values()].filter((record) => record.body.text.includes("authorized operator"));
  assert.equal(records.length >= 2, true);
  const statuses: number[] = [];
  for (const record of records.slice(-2)) {
    statuses.push(
      (
        await fetch(record.body.callback, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            notify_id: record.notify_id,
            message_id: record.message_id,
            chat_id: "chat",
            project: "repo",
            version: 1,
            button: { id: "0", text: "Retry", type: "primary" },
            operator: { open_id: "ou_authorized" },
            timestamp: 1,
          }),
        })
      ).status,
    );
  }
  assert.deepEqual(statuses.sort(), [200, 409]);
  assert.equal(changes, 1);
  one.stop.abort();
  two.stop.abort();
  await Promise.all(runs);
});
