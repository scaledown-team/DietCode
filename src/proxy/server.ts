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

// Claude Code's own session id. It is sent as the x-claude-code-session-id
// header, and inside metadata.user_id: a JSON string with a session_id field
// in current versions, "user_<..>_account_<..>_session_<uuid>" in older ones.
export function clientSessionId(
  headers: IncomingMessage["headers"],
  body: MessagesBody
): string | undefined {
  const header = headers["x-claude-code-session-id"];
  if (typeof header === "string" && header) return header;
  const userId = (body.metadata as { user_id?: unknown } | undefined)?.user_id;
  if (typeof userId !== "string") return undefined;
  try {
    const parsed = JSON.parse(userId) as { session_id?: unknown };
    if (typeof parsed.session_id === "string" && parsed.session_id) return parsed.session_id;
  } catch {
    // Not JSON — try the older underscore format.
  }
  return /_session_([0-9a-f-]{8,})$/i.exec(userId)?.[1];
}

// A conversation key stable across a session's many requests but distinct per
// conversation. The system prompt + first message hash separates the
// conversations inside one Claude Code session (main thread, subagents, side
// requests); the client's session id, when present, keeps two sessions that
// open the same way apart. Without one, transformRequest's prefix check is
// what stops them sharing state.
export function deriveSessionId(body: MessagesBody, clientId?: string): string {
  const sys = JSON.stringify(body.system ?? "").slice(0, 4000);
  const first = body.messages?.[0];
  const firstText =
    first && typeof first.content === "string"
      ? first.content
      : JSON.stringify(first?.content ?? "");
  const hash = shortHash(sys + "::" + firstText.slice(0, 4000));
  return clientId ? `${clientId}_${hash}` : hash;
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
  // The structured `messages` are deliberately NOT forwarded: when the
  // summarize endpoint receives them it skips the model and returns the
  // transcript verbatim with only tool results stripped (~0% savings on
  // prompt-heavy turns). The flattened `text` alone gets a real summary.
  const summarize = (text: string, instructions?: string) =>
    client.summarize(text, instructions).then((r) => ({
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
        const clientId = clientSessionId(req.headers, body);
        const sessionId = deriveSessionId(body, clientId);
        const state = loadSessionState(sessionId);
        const result = await transformRequest(body, state, proxy, { summarize });

        if (result.compacted) {
          saveSessionState(sessionId, result.state);
          process.stderr.write(
            `dietcode proxy: compaction step (session ${sessionId.slice(0, 8)}) — ` +
              `saved ~${result.savedTokens} tokens (~$${result.netSavingsUsd.toFixed(4)})\n`
          );
        }
        // Attribute savings and requests to Claude Code's session id when known, the same
        // key the hooks use, so per-session stats line up.
        if (result.savedTokens > 0) addSaving(clientId ?? sessionId, result.savedTokens);
        addRequest(clientId ?? sessionId);
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
