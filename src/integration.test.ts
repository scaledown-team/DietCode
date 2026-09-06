/**
 * In-process MCP integration test using InMemoryTransport.
 * sd_retrieve is the only tool registered for the agent — sd_compress,
 * sd_summarize, sd_classify, and sd_extract are invoked directly by DietCode's
 * own hooks/proxy (see hooks/user-prompt-submit.ts, hooks/post-tool-use.ts,
 * src/proxy/transform.ts), so they don't need a tool-call round trip and are
 * tested against the ScaledownClient directly (client.test.ts, real-api.test.ts).
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRetrieveTool } from "./tools/retrieve.js";
import { putOriginal } from "./proxy/store.js";

// putOriginal touches ~/.scaledown — sandbox HOME.
let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(resolve(tmpdir(), "dietcode-integration-"));
  process.env.HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

async function buildConnectedPair() {
  const server = new McpServer({ name: "scaledown-test", version: "0.0.0" });
  registerRetrieveTool(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });

  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  return { mcpClient, server };
}

describe("tools/list", () => {
  it("returns exactly sd_retrieve", async () => {
    const { mcpClient } = await buildConnectedPair();
    const result = await mcpClient.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(["sd_retrieve"]);
  });

  it("has a non-empty description", async () => {
    const { mcpClient } = await buildConnectedPair();
    const result = await mcpClient.listTools();
    expect(result.tools[0].description!.length).toBeGreaterThan(10);
  });
});

describe("sd_retrieve", () => {
  it("returns the stored original for a known id", async () => {
    const id = putOriginal("the full original text", "short summary");
    const { mcpClient } = await buildConnectedPair();

    const result = await mcpClient.callTool({ name: "sd_retrieve", arguments: { id } });

    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toBe("the full original text");
  });

  it("reports not found for an unknown id", async () => {
    const { mcpClient } = await buildConnectedPair();

    const result = await mcpClient.callTool({
      name: "sd_retrieve",
      arguments: { id: "doesnotexist" },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.found).toBe(false);
  });
});
