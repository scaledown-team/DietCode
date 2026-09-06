import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

export const CONFIG_FILE = resolve(homedir(), ".scaledown", "config.json");

export interface Config {
  apiKey: string;
  compressThreshold: number;
  compressRate: number | "auto";
  niahDisable: boolean;
  postToolDisable: boolean;
  postToolThreshold: number;
  compactThreshold: number;
  showProgress: boolean;
  maxContextTokens: number;
  proxy: ProxyConfig;
}

export interface ProxyConfig {
  /** Port the local proxy listens on (foreground `dietcode proxy`). */
  port: number;
  /** Upstream Anthropic API base URL the proxy forwards to. */
  upstream: string;
  /** Number of most-recent turns left verbatim (never compacted). */
  recentTurns: number;
  /** Min tokens for the optional per-block tool-output compressor. */
  blockThreshold: number;
  /** Total estimated tokens (summary + tail) that triggers a compaction step. */
  compactThreshold: number;
  /** Disable proxy transforms entirely (pure passthrough). */
  disable: boolean;
  /** Enable the optional per-block tool_result compressor (off by default). */
  blockCompress: boolean;
  /** Force a compaction step after this many new turns, even under compactThreshold. */
  foldEveryTurns: number;
  /** Disable adding a cache_control breakpoint to the folded summary block. */
  cacheControlDisable: boolean;
}

export function loadProxyConfig(): ProxyConfig {
  const intEnv = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  return {
    port: intEnv("SCALEDOWN_PROXY_PORT", 8788),
    upstream:
      process.env.SCALEDOWN_PROXY_UPSTREAM ?? "https://api.anthropic.com",
    recentTurns: intEnv("SCALEDOWN_PROXY_RECENT_TURNS", 4),
    blockThreshold: intEnv("SCALEDOWN_PROXY_BLOCK_THRESHOLD", 2000),
    // Must stay below Claude's native auto-compact trigger so OUR compaction
    // fires first. The plugin sets CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 (~100k of
    // a 200k window), so default well under that at 50k.
    compactThreshold: intEnv("SCALEDOWN_PROXY_COMPACT_THRESHOLD", 50000),
    disable: process.env.SCALEDOWN_PROXY_DISABLE === "true",
    blockCompress: process.env.SCALEDOWN_PROXY_BLOCK_COMPRESS === "true",
    foldEveryTurns: intEnv("SCALEDOWN_PROXY_FOLD_TURNS", 3),
    cacheControlDisable: process.env.SCALEDOWN_PROXY_CACHE_CONTROL_DISABLE === "true",
  };
}

function readConfigFile(): { apiKey?: string } {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch {
    // Malformed config file — ignore
  }
  return {};
}

export function loadConfig(): Config {
  const apiKey = process.env.SCALEDOWN_API_KEY ?? readConfigFile().apiKey;
  if (!apiKey) {
    throw new Error(
      "SCALEDOWN_API_KEY is not set.\n" +
        "Get your API key at https://scaledown.ai/dashboard, then run:\n" +
        "  dietcode setup\n" +
        "or set the environment variable manually."
    );
  }

  const thresholdRaw = process.env.SCALEDOWN_COMPRESS_THRESHOLD;
  const compressThreshold = thresholdRaw ? parseInt(thresholdRaw, 10) : 10000;

  const rateRaw = process.env.SCALEDOWN_COMPRESS_RATE ?? "0.3";
  const compressRate: number | "auto" =
    rateRaw === "auto" ? "auto" : parseFloat(rateRaw);

  const niahDisable = process.env.SCALEDOWN_NIAH_DISABLE === "true";

  const postToolDisable = process.env.SCALEDOWN_POST_TOOL_DISABLE === "true";

  const postToolThresholdRaw = process.env.SCALEDOWN_POST_TOOL_THRESHOLD;
  const postToolThreshold = postToolThresholdRaw
    ? parseInt(postToolThresholdRaw, 10)
    : 4000;

  const compactThresholdRaw = process.env.SCALEDOWN_COMPACT_THRESHOLD;
  const compactThreshold = compactThresholdRaw
    ? parseInt(compactThresholdRaw, 10)
    : 50;

  const showProgress = process.env.SCALEDOWN_SHOW_PROGRESS !== "false";

  const maxContextTokensRaw = process.env.SCALEDOWN_MAX_CONTEXT_TOKENS;
  const maxContextTokens = maxContextTokensRaw ? parseInt(maxContextTokensRaw, 10) : 200000;

  return {
    apiKey,
    compressThreshold,
    compressRate,
    niahDisable,
    postToolDisable,
    postToolThreshold,
    compactThreshold,
    showProgress,
    maxContextTokens,
    proxy: loadProxyConfig(),
  };
}
