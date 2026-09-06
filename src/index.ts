#!/usr/bin/env node
// Only sd_retrieve is exposed to the agent — it's the one tool that only the
// agent can know when it needs (pulling back an original behind a proxy
// summary marker). Compress/summarize/classify/extract are applied
// automatically by DietCode's own hooks and proxy (see hooks/user-prompt-submit.ts,
// hooks/post-tool-use.ts, src/proxy/transform.ts) rather than left for the
// agent to decide to call, so they never need a tool-call round trip and never
// add their schemas to every request's `tools` array.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerRetrieveTool } from "./tools/retrieve.js";

const server = new McpServer({
  name: "dietcode",
  version: "0.5.0",
});

registerRetrieveTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);
