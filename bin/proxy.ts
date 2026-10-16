#!/usr/bin/env node
// `dietcode proxy`  — run the local compaction proxy in the foreground.
// `dietcode claude` — start the proxy on an ephemeral port and launch Claude
//                     Code pointed at it (ANTHROPIC_BASE_URL), tearing the proxy
//                     down when claude exits. The recommended, zero-config UX.

import { spawn } from "child_process";
import type { AddressInfo } from "net";
import { pathToFileURL } from "url";
import { ScaledownClient } from "../src/client.js";
import { loadConfig, loadProxyConfig, type Config } from "../src/config.js";
import { PROXY_AUTOCOMPACT_PCT, withAutocompactSettings } from "../src/proxy/launch.js";
import { startProxy } from "../src/proxy/server.js";

// Full config when an API key is present; otherwise a pure-passthrough config so
// `dietcode claude` still works (just without compaction) instead of crashing.
function resolveConfig(): Config {
  try {
    return loadConfig();
  } catch {
    process.stderr.write(
      "dietcode proxy: no SCALEDOWN_API_KEY found — running in passthrough mode (no compaction).\n"
    );
    return {
      apiKey: "",
      compressThreshold: 10000,
      compressRate: "auto",
      niahDisable: true,
      postToolDisable: true,
      postToolThreshold: 4000,
      compactThreshold: 50,
      showProgress: false,
      maxContextTokens: 200000,
      proxy: { ...loadProxyConfig(), disable: true },
    };
  }
}

function parsePort(args: string[], fallback: number): number {
  const i = args.indexOf("--port");
  if (i >= 0 && args[i + 1]) {
    const n = parseInt(args[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

export async function runProxy(args: string[]): Promise<void> {
  const config = resolveConfig();
  const port = parsePort(args, config.proxy.port);
  const client = new ScaledownClient(config.apiKey || "passthrough");
  const server = await startProxy(config, client, port);
  const addr = server.address() as AddressInfo;
  process.stderr.write(
    `dietcode proxy listening on http://127.0.0.1:${addr.port}\n` +
      `  point your client at it:  export ANTHROPIC_BASE_URL=http://127.0.0.1:${addr.port}\n` +
      `  (or just run: dietcode claude)\n`
  );
}

export async function runClaudeWrapper(args: string[]): Promise<void> {
  // Already inside a DietCode proxy session — don't stack a second proxy.
  if (process.env.DIETCODE_PROXY === "1") {
    spawnClaude(args, process.env, null);
    return;
  }

  const config = resolveConfig();
  const client = new ScaledownClient(config.apiKey || "passthrough");
  const server = await startProxy(config, client, 0); // ephemeral loopback port
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    DIETCODE_PROXY: "1", // marker the status line reads to show proxy-active state
  };
  // Backstop: keep Claude's own auto-compaction out of the way so ours owns it.
  env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = PROXY_AUTOCOMPACT_PCT;

  process.stderr.write(`dietcode: proxy on ${baseUrl} — launching claude...\n`);

  spawnClaude(withAutocompactSettings(args), env, server);
}

function spawnClaude(args: string[], env: NodeJS.ProcessEnv, server: { close: () => void } | null): void {
  // spawn (no shell) resolves the real `claude` binary on PATH, so a shell
  // `alias claude='dietcode claude'` does not cause recursion here.
  const child = spawn("claude", args, { stdio: "inherit", env });

  const shutdown = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  child.on("error", (err) => {
    process.stderr.write(
      `dietcode: could not launch claude (${String(err)}). Is Claude Code installed and on PATH?\n`
    );
    server?.close();
    process.exit(1);
  });
  child.on("exit", (code) => {
    server?.close();
    process.exit(code ?? 0);
  });
}

// Direct invocation only (`node dist/bin/proxy.js [claude|proxy] [...args]`).
// Guarded so importing runProxy/runClaudeWrapper from setup.ts doesn't auto-run.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === "claude") {
    runClaudeWrapper(rest);
  } else if (sub === "proxy") {
    runProxy(rest);
  } else {
    runProxy(process.argv.slice(2));
  }
}
