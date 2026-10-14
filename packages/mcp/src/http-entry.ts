import { createHttpMcpServer } from "./http";

const agentToken = process.env.AGENT_ACCESS_TOKEN;
const gatewayToken = process.env.EDGE_GATEWAY_TOKEN;
if (!agentToken || !gatewayToken) {
  throw new Error("AGENT_ACCESS_TOKEN and EDGE_GATEWAY_TOKEN are required");
}

const port = Number(process.env.MCP_PORT ?? "3000");
const server = createHttpMcpServer({
  apiBase: process.env.MCP_API_BASE ?? "http://api:8000",
  agentToken,
  gatewayToken,
  allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
});
server.listen(port, "0.0.0.0", () => {
  // Logs to stderr; stdio MCP uses stdout for protocol messages.
  console.error("Tasklutein HTTP MCP listening on port " + port);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
