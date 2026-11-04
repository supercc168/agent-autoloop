// Hub cards use Lodestar only as a durable local Feishu transport. Hub authorization remains authoritative.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { HOME } from "../../host/home.ts";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { HubError } from "../../protocol/client.ts";
import { directLoopbackRequest } from "./local-http.ts";

type Options = { instance: string; project: string; clientFile: string };
type NotifyState = "pending" | "applied" | "unknown";
type NotifyBody = {
  request_id: string;
  version: number;
  project: string;
  title: string;
  text: string;
  buttons?: { id: string; text: string; type: "primary" | "default" }[];
  allow_reply?: true;
  callback?: string;
};
type AcceptedAnswer = { version: number; choice?: number; text?: string; by: string; ref: string };
type TransportRecord = {
  cardId: number;
  requestId: string;
  createBody: NotifyBody;
  createCard: Card;
  desiredBody: NotifyBody;
  desiredCard: Card;
  appliedCard?: Card;
  notifyId?: string;
  messageId?: string;
  chatId?: string;
  transportState: NotifyState;
  appliedVersion: number;
  hubDeliveredVersion: number;
  putAttemptedVersion?: number;
  uncertainVersion?: number;
  attempts: number;
  nextAttemptAt: number;
  notifyResolved?: boolean;
  answerAccepted?: AcceptedAnswer;
};
type State = {
  version: 1;
  hubOrigin: string;
  instance: string;
  project: string;
  callback: { port: number; token: string };
  records: Record<string, TransportRecord>;
};

const MAX_BODY = 1024 * 1024;
const BACKOFF = [1_000, 3_000, 8_000, 15_000];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function optionsOf(context: ChannelContext): Options {
  const allowed = new Set(["instance", "project", "client_file"]);
  if (Object.keys(context.options).some((key) => !allowed.has(key)))
    throw new Error("Lodestar channel has unknown options");
  const instance = typeof context.options.instance === "string" ? context.options.instance.trim() : "";
  const project = typeof context.options.project === "string" ? context.options.project.trim() : "";
  const clientFile = typeof context.options.client_file === "string" ? context.options.client_file.trim() : "";
  if (!instance || [...instance].length > 100 || !project || [...project].length > 100) {
    throw new Error("Lodestar channel requires short nonempty instance and project options");
  }
  if (!path.isAbsolute(clientFile)) throw new Error("Lodestar channel client_file must be an absolute path");
  if (!context.hubOrigin) throw new Error("Lodestar channel requires its canonical Hub origin");
  return { instance, project, clientFile };
}

function canonicalHubOrigin(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Lodestar channel Hub origin is invalid");
  }
  return url.toString().replace(/\/+$/, "");
}

function stateFile(hubOrigin: string, instance: string) {
  return path.join(HOME, "channels", "lodestar", `${digest(`${hubOrigin}\0${instance}`)}.json`);
}

function atomicJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
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

function validCard(value: any): value is Card {
  return (
    value &&
    Number.isSafeInteger(value.id) &&
    Number.isSafeInteger(value.version) &&
    typeof value.title === "string" &&
    typeof value.text === "string" &&
    Array.isArray(value.options) &&
    value.options.every((option: unknown) => typeof option === "string") &&
    ["ask", "notice"].includes(value.kind) &&
    ["open", "decided", "done", "closed"].includes(value.state) &&
    (value.ref === null || typeof value.ref === "string") &&
    (value.recommend === null || Number.isSafeInteger(value.recommend)) &&
    (value.choice === null || Number.isSafeInteger(value.choice)) &&
    (value.answer === null || typeof value.answer === "string") &&
    (value.result === null || typeof value.result === "string") &&
    (value.link === null || typeof value.link === "string")
  );
}

function validNotifyBody(value: any, requestId: string, project: string, version: number) {
  return (
    value &&
    value.request_id === requestId &&
    value.project === project &&
    value.version === version &&
    typeof value.title === "string" &&
    typeof value.text === "string" &&
    (value.buttons === undefined ||
      (Array.isArray(value.buttons) &&
        value.buttons.every(
          (button: any) =>
            button &&
            typeof button.id === "string" &&
            typeof button.text === "string" &&
            ["primary", "default"].includes(button.type),
        ))) &&
    (value.allow_reply === undefined || value.allow_reply === true) &&
    (value.callback === undefined || typeof value.callback === "string")
  );
}

function loadState(file: string, hubOrigin: string, instance: string, project: string): State {
  if (!existsSync(file)) {
    const state: State = {
      version: 1,
      hubOrigin,
      instance,
      project,
      callback: { port: 0, token: randomUUID().replaceAll("-", "") },
      records: {},
    };
    atomicJson(file, state);
    return state;
  }
  let value: any;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Lodestar channel state is unreadable: ${(error as Error).message}`);
  }
  if (
    value?.version !== 1 ||
    value.hubOrigin !== hubOrigin ||
    value.instance !== instance ||
    value.project !== project ||
    !Number.isSafeInteger(value.callback?.port) ||
    value.callback.port < 0 ||
    typeof value.callback?.token !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.callback.token) ||
    !value.records ||
    typeof value.records !== "object" ||
    Array.isArray(value.records)
  ) {
    throw new Error("Lodestar channel state is invalid");
  }
  for (const [key, record] of Object.entries(value.records as Record<string, any>)) {
    const callbackUrl = `http://127.0.0.1:${value.callback.port}/callback/${value.callback.token}`;
    if (
      key !== String(record.cardId) ||
      !Number.isSafeInteger(record.cardId) ||
      typeof record.requestId !== "string" ||
      record.requestId !== stableRequestId(hubOrigin, instance, record.cardId) ||
      !validCard(record.createCard) ||
      !validCard(record.desiredCard) ||
      record.createCard.id !== record.cardId ||
      record.desiredCard.id !== record.cardId ||
      !validNotifyBody(record.createBody, record.requestId, project, record.createCard.version) ||
      !validNotifyBody(record.desiredBody, record.requestId, project, record.desiredCard.version) ||
      (record.createBody.callback !== undefined && record.createBody.callback !== callbackUrl) ||
      (record.desiredBody.callback !== undefined && record.desiredBody.callback !== callbackUrl) ||
      (Object.keys(value.records).length > 0 && value.callback.port === 0) ||
      !["pending", "applied", "unknown"].includes(record.transportState) ||
      !Number.isSafeInteger(record.appliedVersion) ||
      !Number.isSafeInteger(record.hubDeliveredVersion) ||
      !Number.isSafeInteger(record.attempts) ||
      !Number.isFinite(record.nextAttemptAt) ||
      (record.uncertainVersion !== undefined && !Number.isSafeInteger(record.uncertainVersion)) ||
      (record.notifyId !== undefined && typeof record.notifyId !== "string") ||
      (record.messageId !== undefined && typeof record.messageId !== "string") ||
      (record.chatId !== undefined && typeof record.chatId !== "string") ||
      (record.notifyResolved !== undefined && typeof record.notifyResolved !== "boolean")
    ) {
      throw new Error("Lodestar channel record is invalid");
    }
  }
  return value as State;
}

function readClient(options: Options) {
  let value: any;
  try {
    value = JSON.parse(readFileSync(options.clientFile, "utf8"));
  } catch {
    throw new Error("cannot read Lodestar channel client file");
  }
  let base: URL;
  try {
    base = new URL(value.baseUrl);
  } catch {
    throw new Error("Lodestar channel client URL is invalid");
  }
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    typeof value.capability !== "string" ||
    !value.capability
  ) {
    throw new Error("Lodestar channel client must be a loopback daemon endpoint");
  }
  return base;
}

async function notifyRequest(options: Options, method: string, route: string, body?: NotifyBody) {
  const base = readClient(options);
  const url = new URL(route, base);
  if (url.origin !== base.origin) throw new Error("Lodestar notify request cannot leave loopback");
  const response = await directLoopbackRequest(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    timeoutMs: 10_000,
  });
  let value: any;
  try {
    value = JSON.parse(response.text);
  } catch {
    throw new Error(`Lodestar notify returned invalid JSON (${response.status})`);
  }
  return { status: response.status, ok: response.ok, value };
}

function cardText(card: Card) {
  const outcome =
    card.state === "done" && card.result
      ? `\n\n已执行：${card.result}`
      : card.state === "closed" && card.result
        ? `\n\n已关闭：${card.result}`
        : card.state === "decided"
          ? `\n\n已决定：${card.choice !== null ? card.options[card.choice] : (card.answer ?? "已记录")}`
          : "";
  return `${card.text}${outcome}`;
}

function bodyFor(card: Card, requestId: string, project: string, callback: string): NotifyBody {
  const body: NotifyBody = {
    request_id: requestId,
    version: card.version,
    project,
    title: card.title,
    text: cardText(card),
  };
  if (card.state === "open" && card.options.length) {
    body.buttons = card.options.map((text, index) => ({
      id: String(index),
      text,
      type: index === card.recommend ? "primary" : "default",
    }));
    body.callback = callback;
  } else if (card.state === "open" && card.kind === "ask") {
    body.allow_reply = true;
    body.callback = callback;
  }
  return body;
}

function stableRequestId(hubOrigin: string, instance: string, cardId: number) {
  return `hub_${digest(`${hubOrigin}\0${instance}\0${cardId}`).slice(0, 40)}`;
}

function validateTransport(record: TransportRecord, value: any) {
  if (
    !value ||
    value.request_id !== record.requestId ||
    typeof value.notify_id !== "string" ||
    !value.notify_id ||
    !["pending", "applied", "unknown"].includes(value.transport_state) ||
    !Number.isSafeInteger(value.version) ||
    !Number.isSafeInteger(value.applied_version)
  ) {
    throw new Error("Lodestar notify transport response is invalid");
  }
  if (record.notifyId && value.notify_id !== record.notifyId) throw new Error("Lodestar notify identity changed");
  if (record.messageId && value.message_id && value.message_id !== record.messageId) {
    throw new Error("Lodestar notify message identity changed");
  }
}

function nextBackoff(attempts: number) {
  return BACKOFF[Math.min(attempts, BACKOFF.length - 1)]!;
}

async function startCallbackServer(
  context: ChannelContext,
  options: Options,
  state: State,
  save: () => void,
): Promise<{ server: Server; url: string }> {
  const answering = new Set<string>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method !== "POST" || url.pathname !== `/callback/${state.callback.token}`) {
      request.resume();
      return send(404, { error: "not found" });
    }
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY) return send(413, { error: "callback too large" });
    }
    let value: any;
    try {
      value = JSON.parse(raw);
    } catch {
      return send(400, { error: "bad json" });
    }
    const record = Object.values(state.records).find((item) => item.notifyId === value.notify_id);
    if (!record || answering.has(record.requestId)) return send(409, { error: "callback unavailable" });
    const applied = record.appliedCard;
    const by = value.operator?.open_id;
    if (
      !applied ||
      value.project !== options.project ||
      value.message_id !== record.messageId ||
      value.chat_id !== record.chatId ||
      value.version !== record.appliedVersion ||
      typeof by !== "string" ||
      !by
    ) {
      return send(409, { error: "stale or forged callback" });
    }
    let answer: { choice?: number; text?: string; by: string; ref: string };
    if (value.button) {
      const choice = Number(value.button.id);
      if (
        !Number.isSafeInteger(choice) ||
        choice < 0 ||
        choice >= applied.options.length ||
        value.button.text !== applied.options[choice]
      ) {
        return send(409, { error: "invalid button" });
      }
      answer = { choice, by, ref: record.messageId! };
    } else if (
      value.response?.type === "text" &&
      typeof value.response.text === "string" &&
      value.response.text.trim()
    ) {
      if (applied.options.length) return send(409, { error: "text cannot choose an option card" });
      answer = { text: value.response.text, by, ref: record.messageId! };
    } else {
      return send(409, { error: "invalid callback" });
    }
    if (record.answerAccepted) {
      const same =
        JSON.stringify(record.answerAccepted) === JSON.stringify({ version: record.appliedVersion, ...answer });
      return send(same ? 200 : 409, same ? { text: "已记录" } : { error: "different answer already accepted" });
    }
    answering.add(record.requestId);
    try {
      const accepted = await context.hub.answer(record.cardId, answer);
      if (!accepted?.changed) return send(409, { error: "Hub did not accept this answer" });
      record.answerAccepted = { version: record.appliedVersion, ...answer };
      save();
      return send(200, { text: "已记录" });
    } catch (error) {
      const status = error instanceof HubError && [401, 403, 409].includes(error.status) ? error.status : 502;
      return send(status, { error: status === 403 ? "operator is not authorized" : "Hub answer was not accepted" });
    } finally {
      answering.delete(record.requestId);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.callback.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Lodestar callback server has no loopback port");
  if (state.callback.port === 0) {
    state.callback.port = address.port;
    save();
  }
  return { server, url: `http://127.0.0.1:${state.callback.port}/callback/${state.callback.token}` };
}

export default async function lodestarChannel(context: ChannelContext) {
  const options = optionsOf(context);
  const hubOrigin = canonicalHubOrigin(context.hubOrigin!);
  const file = stateFile(hubOrigin, options.instance);
  const state = loadState(file, hubOrigin, options.instance, options.project);
  const save = () => atomicJson(file, state);
  const callback = await startCallbackServer(context, options, state, save);

  const deliver = async (record: TransportRecord, version: number) => {
    if (!record.messageId || record.hubDeliveredVersion >= version) return;
    await context.hub.delivered(record.cardId, version, record.messageId);
    record.hubDeliveredVersion = version;
    save();
  };

  const adopt = (record: TransportRecord, value: any) => {
    validateTransport(record, value);
    record.notifyId = value.notify_id;
    if (typeof value.message_id === "string" && value.message_id) record.messageId = value.message_id;
    if (typeof value.chat_id === "string" && value.chat_id) {
      if (record.chatId && record.chatId !== value.chat_id) throw new Error("Lodestar notify chat identity changed");
      record.chatId = value.chat_id;
    }
    record.transportState = value.transport_state;
    record.appliedVersion = value.applied_version;
    if (record.transportState === "applied") {
      record.attempts = 0;
      record.nextAttemptAt = 0;
    }
    if (
      record.transportState === "applied" &&
      record.appliedVersion === record.createBody.version &&
      !record.appliedCard
    ) {
      record.appliedCard = structuredClone(record.createCard);
    }
    save();
  };

  const postCreate = async (record: TransportRecord) => {
    try {
      const response = await notifyRequest(options, "POST", "/notify", record.createBody);
      if (response.value?.request_id) adopt(record, response.value);
      if (!response.ok || record.transportState === "pending") {
        record.attempts++;
        record.nextAttemptAt = Date.now() + nextBackoff(record.attempts - 1);
        save();
        if (!response.value?.notify_id) throw new Error(`notify create failed (${response.status})`);
      }
    } catch (error) {
      record.attempts++;
      record.nextAttemptAt = Date.now() + nextBackoff(record.attempts - 1);
      save();
      context.log(`Lodestar notify create is pending: ${error instanceof Error ? error.message : error}`);
    }
  };

  const poll = async (record: TransportRecord) => {
    if (!record.notifyId) return;
    const response = await notifyRequest(options, "GET", `/notify/result/${encodeURIComponent(record.notifyId)}`);
    if (!response.ok) throw new Error(`notify result failed (${response.status})`);
    const attempted = record.putAttemptedVersion;
    const uncertain = record.uncertainVersion;
    adopt(record, response.value);
    const target = Math.max(attempted ?? 0, uncertain ?? 0);
    if (target > 0 && response.value.transport_state === "unknown" && response.value.version >= target) {
      record.putAttemptedVersion = target;
      record.uncertainVersion = target;
      record.transportState = "unknown";
    } else if (target > 0 && record.appliedVersion >= target) {
      delete record.putAttemptedVersion;
      delete record.uncertainVersion;
    } else if (target > 0 && response.value.version < target && response.value.transport_state !== "unknown") {
      // The daemon durably reports an older desired version, so the journaled PUT never entered its lifecycle.
      // Replaying the exact version/body is safe; daemon-side version/hash checks still arbitrate any race.
      delete record.putAttemptedVersion;
      delete record.uncertainVersion;
    }
    record.notifyResolved = response.value.resolved === true;
    save();
  };

  const putUpdate = async (record: TransportRecord) => {
    if (!record.notifyId || record.putAttemptedVersion === record.desiredBody.version) return;
    record.putAttemptedVersion = record.desiredBody.version;
    save();
    try {
      const response = await notifyRequest(
        options,
        "PUT",
        `/notify/${encodeURIComponent(record.notifyId)}`,
        record.desiredBody,
      );
      adopt(record, response.value);
      if (record.transportState === "unknown") record.uncertainVersion = record.desiredBody.version;
      else if (record.appliedVersion >= record.desiredBody.version) delete record.uncertainVersion;
      if (record.transportState === "applied" && record.appliedVersion === record.desiredCard.version) {
        record.appliedCard = structuredClone(record.desiredCard);
        save();
      }
    } catch (error) {
      record.transportState = "unknown";
      record.uncertainVersion = record.desiredBody.version;
      save();
      context.log(`Lodestar notify update outcome is unknown: ${error instanceof Error ? error.message : error}`);
    }
  };

  const reconcile = async (record: TransportRecord) => {
    if (!record.notifyId) {
      if (Date.now() >= record.nextAttemptAt) await postCreate(record);
      if (!record.notifyId) return;
    }
    if (record.transportState === "applied" && record.appliedVersion >= record.desiredCard.version) {
      record.appliedCard = structuredClone(record.desiredCard);
      save();
      await deliver(record, record.desiredCard.version);
    }
    await poll(record);
    if (record.transportState === "unknown") return;
    if (record.transportState === "pending") {
      if (record.putAttemptedVersion !== undefined) return;
      if (Date.now() >= record.nextAttemptAt) await postCreate(record);
      return;
    }
    if (
      record.answerAccepted &&
      record.desiredCard.state !== "open" &&
      (record.answerAccepted.choice === undefined || record.desiredCard.choice === record.answerAccepted.choice)
    ) {
      if (record.notifyResolved) await deliver(record, record.desiredCard.version);
      return;
    }
    if (record.desiredCard.version > record.appliedVersion) await putUpdate(record);
    if (record.transportState === "applied" && record.appliedVersion >= record.desiredCard.version) {
      record.appliedCard = structuredClone(record.desiredCard);
      save();
      await deliver(record, record.desiredCard.version);
    }
  };

  const acceptCard = async (card: Card) => {
    const key = String(card.id);
    let record = state.records[key];
    const requestId = stableRequestId(hubOrigin, options.instance, card.id);
    const desired = bodyFor(card, requestId, options.project, callback.url);
    if (!record) {
      record = {
        cardId: card.id,
        requestId,
        createBody: desired,
        createCard: structuredClone(card),
        desiredBody: desired,
        desiredCard: structuredClone(card),
        transportState: "pending",
        appliedVersion: 0,
        hubDeliveredVersion: 0,
        attempts: 0,
        nextAttemptAt: 0,
      };
      state.records[key] = record;
      save();
    } else {
      if (record.requestId !== requestId) throw new Error("Lodestar channel request identity changed");
      if (card.version < record.desiredCard.version) return;
      if (
        card.version === record.desiredCard.version &&
        JSON.stringify(desired) !== JSON.stringify(record.desiredBody)
      ) {
        throw new Error("same Hub card version changed its transport body");
      }
      if (record.messageId && card.ref && card.ref !== record.messageId)
        throw new Error("Hub card message ref changed");
      if (card.version > record.desiredCard.version) {
        record.desiredBody = desired;
        record.desiredCard = structuredClone(card);
        delete record.putAttemptedVersion;
        save();
      }
    }
    await reconcile(record);
  };

  const unresolved = (record: TransportRecord) =>
    !record.notifyId ||
    record.transportState !== "applied" ||
    record.hubDeliveredVersion < record.desiredCard.version ||
    (record.desiredCard.state === "open" && !record.notifyResolved);

  try {
    while (!context.signal.aborted) {
      for (const record of Object.values(state.records)) {
        if (!unresolved(record)) continue;
        try {
          await reconcile(record);
        } catch (error) {
          context.log(`Lodestar channel reconciliation failed: ${error instanceof Error ? error.message : error}`);
        }
      }
      let card: Card | null;
      try {
        ({ card } = await context.hub.nextCard(Object.values(state.records).some(unresolved) ? 1 : 50));
      } catch (error) {
        context.log(`Lodestar channel cannot reach Hub: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      if (!card) continue;
      try {
        await acceptCard(card);
      } catch (error) {
        context.log(`Lodestar channel card ${card.id} is pending: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    await new Promise<void>((resolve) => callback.server.close(() => resolve()));
  }
}
