import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "apps/mcp/src/index.ts"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    TASKLUTEIN_API_TOKEN: "local-smoke-agent-token-" + "a".repeat(40),
    TASKLUTEIN_API_BASE: "http://127.0.0.1:8000"
  }
});

const client = new Client({ name: "tasklutein-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const actual = listed.tools.map((tool) => tool.name).sort();
  const expected = ["add_report", "create_task", "get_task", "list_reports", "list_tasks", "update_task"];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Unexpected MCP tools: " + actual.join(", "));
  }
  console.log("MCP stdio handshake ok:", actual.join(", "));
} finally {
  await client.close();
}
