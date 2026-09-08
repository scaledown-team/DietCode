// The DietCode local proxy: a thin HTTP forwarder between Claude Code and the
// Anthropic API. It transforms only the request body for /v1/messages (and
// count_tokens) via progressive compaction, then streams the upstream response
// back untouched. Everything else is verbatim passthrough. It must NEVER break a
// request — every error path forwards the original bytes.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import { Readable } from "stream";
import type { ScaledownClient } from "../client.js";
import type { Config } from "../config.js";
import { transformRequest, type MessagesBody } from "./transform.js";
import { loadSessionState, saveSessionState, shortHash } from "./store.js";
import { addRequest, addSaving } from "../stats.js";

// Hop-by-hop / body headers we must not copy onto the outbound fetch.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "accept-encoding",
  "connection",
]);

function isMessagesPath(pathname: string): boolean {
  return pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens";
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// A conversation key stable across a session's many requests but distinct per
// conversation — derived from the system prompt + first user message, since the
// Anthropic request carries no session id.
function deriveSessionId(body: MessagesBody): string {
  const sys = JSON.stringify(body.system ?? "").slice(0, 4000);
  const first = body.messages?.[0];
  const firstText =
    first && typeof first.content === "string"
      ? first.content
      : JSON.stringify(first?.content ?? "");
  return shortHash(sys + "::" + firstText.slice(0, 4000));
}

function outboundHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return headers;
}

// Headers describing the upstream *wire* response that no longer apply once
// undici's fetch has already decompressed the body for us (upstream.body):
// forwarding content-encoding/content-length here would tell the client to
// decompress an already-plain body, which fails (e.g. BrotliDecompressionError
// in Claude Code's own fetch client).
const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length"]);

async function pipeUpstream(
  upstream: Response,
  res: ServerResponse
): Promise<void> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    headers[key] = value;
  });
  res.writeHead(upstream.status, headers);
  if (upstream.body) {
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } else {
    res.end();
  }
}

export function createProxyServer(config: Config, client: ScaledownClient): Server {
  const { proxy } = config;
  const summarize = (text: string, instructions?: string, messages?: unknown[]) =>
    client.summarize(text, instructions, undefined, messages).then((r) => ({
      summary: r.summary,
      inputChars: r.input_chars,
      outputChars: r.output_chars,
    }));

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const target = proxy.upstream.replace(/\/$/, "") + url.pathname + url.search;
    const method = req.method ?? "GET";
    const raw = await readBody(req).catch(() => Buffer.alloc(0));

    let outBody: Buffer | string = raw;

    if (!proxy.disable && method === "POST" && isMessagesPath(url.pathname) && raw.length > 0) {
      try {
        const body = JSON.parse(raw.toString("utf8")) as MessagesBody;
        const sessionId = deriveSessionId(body);
        const state = loadSessionState(sessionId);
        const result = await transformRequest(body, state, proxy, { summarize });

        if (result.compacted) {
          saveSessionState(sessionId, result.state);
          process.stderr.write(
            `dietcode proxy: compaction step (session ${sessionId.slice(0, 8)}) — ` +
              `saved ~${result.savedTokens} tokens (~$${result.netSavingsUsd.toFixed(4)})\n`
          );
        }
        if (result.savedTokens > 0) addSaving(sessionId, result.savedTokens);
        addRequest();
        outBody = JSON.stringify(result.body);
      } catch (err) {
        // Fail-open: forward the original request unchanged.
        process.stderr.write(`dietcode proxy: transform skipped (${String(err)})\n`);
        outBody = raw;
      }
    }

    try {
      const headers = outboundHeaders(req);
      if (typeof outBody === "string") headers["content-type"] = "application/json";
      const noBody = method === "GET" || method === "HEAD";
      const upstream = await fetch(target, {
        method,
        headers,
        body: noBody ? undefined : typeof outBody === "string" ? outBody : new Uint8Array(outBody),
      });
      await pipeUpstream(upstream, res);
    } catch (err) {
      // Upstream unreachable — surface a clean 502 rather than hanging.
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "proxy_error", message: String(err) } }));
    }
  });
}

export function startProxy(config: Config, client: ScaledownClient, port: number): Promise<Server> {
  const server = createProxyServer(config, client);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
