// Local daemon traffic must never inherit Node's global environment proxy, even when the process enables it globally.
import { Agent, request } from "node:http";

const DIRECT_AGENT = new Agent({ keepAlive: false });

export type LocalHttpResponse = { status: number; ok: boolean; text: string };

function loopback(url: URL) {
  const host = url.hostname.replace(/^\[|]$/g, "");
  return url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(host) && !url.username && !url.password;
}

export function directLoopbackRequest(
  input: URL | string,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  },
): Promise<LocalHttpResponse> {
  const url = input instanceof URL ? input : new URL(input);
  if (!loopback(url)) return Promise.reject(new Error("local Lodestar request must use loopback HTTP"));
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers };
    if (options.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }
    const req = request(url, {
      method: options.method,
      headers,
      agent: DIRECT_AGENT,
    });
    let settled = false;
    const finish = (error?: Error, response?: LocalHttpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(() => {
      const error = new Error(`local Lodestar request timed out after ${timeoutMs}ms`);
      error.name = "TimeoutError";
      req.destroy(error);
    }, timeoutMs);
    req.on("response", (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        finish(undefined, { status, ok: status >= 200 && status < 300, text });
      });
      response.on("error", (error) => finish(error));
    });
    req.on("error", (error) => finish(error));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
