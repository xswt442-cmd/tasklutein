/** Optional local stdio MCP adapter. Remote HTTP MCP runs on Tencent Cloud. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTaskluteinMcpServer } from "./server";

const personalAgentKey = process.env.TASKLUTEIN_API_TOKEN;
if (!personalAgentKey || personalAgentKey.length < 32) {
  throw new Error("TASKLUTEIN_API_TOKEN must be set to your personal Agent Key");
}
const server = createTaskluteinMcpServer({
  apiBase: process.env.TASKLUTEIN_API_BASE ?? "http://127.0.0.1:8000",
  agentToken: personalAgentKey,
  gatewayToken: process.env.TASKLUTEIN_GATEWAY_TOKEN,
});
await server.connect(new StdioServerTransport());
