/**
 * MCP tool schema contract test — verifies sd_retrieve's input schema shape.
 * sd_compress/sd_summarize/sd_classify/sd_extract are no longer registered as
 * agent-facing tools: DietCode's hooks and proxy call the Scaledown client
 * directly instead (see hooks/user-prompt-submit.ts, hooks/post-tool-use.ts,
 * src/proxy/transform.ts), so sd_retrieve is the only tool the agent needs to
 * reason about calling.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRetrieveTool } from "./tools/retrieve.js";

async function getToolSchemas() {
  const server = new McpServer({ name: "scaledown-test", version: "0.0.0" });
  registerRetrieveTool(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const { tools } = await mcpClient.listTools();
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

let tools: Awaited<ReturnType<typeof getToolSchemas>>;

beforeAll(async () => {
  tools = await getToolSchemas();
});

describe("tools/list", () => {
  it("returns exactly sd_retrieve", () => {
    expect(Object.keys(tools)).toEqual(["sd_retrieve"]);
  });
});

describe("sd_retrieve schema", () => {
  it("has id as required string", () => {
    const schema = tools["sd_retrieve"].inputSchema as {
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(schema.properties["id"].type).toBe("string");
    expect(schema.required).toContain("id");
  });

  it("has a description mentioning ScaleDown", () => {
    expect(tools["sd_retrieve"].description).toMatch(/scaledown/i);
  });
});
