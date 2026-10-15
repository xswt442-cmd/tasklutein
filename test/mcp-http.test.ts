import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpMcpServer } from "../packages/mcp/src/http";
import { createServer, type Server } from "node:http";

const agentToken = "agent-" + "a".repeat(56);
const gatewayToken = "gateway-" + "g".repeat(56);
const live: Server[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

async function serve(apiBase = "http://127.0.0.1:1") {
  const http = createHttpMcpServer({
    apiBase,
    agentToken,
    gatewayToken,
    allowedOrigins: ["https://app.example.test"],
  });
  live.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("TCP address missing");
  return "http://127.0.0.1:" + address.port + "/mcp";
}

describe("Tencent Streamable HTTP MCP", () => {
  it("requires the Worker secret and the agent token", async () => {
    const url = await serve();
    const body = JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} });
    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    expect((await fetch(url, { method: "POST", body,
      headers: { "X-Tasklutein-Gateway": gatewayToken }
    })).status).toBe(401);
    expect((await fetch(url, { method: "POST", body,
      headers: { "X-Tasklutein-Gateway": gatewayToken, Authorization: "Bearer " + agentToken,
        Origin: "https://evil.example.test" }
    })).status).toBe(403);
  });

  it("enforces JSON content type and a streaming request-body limit", async () => {
    const url = await serve();
    const headers = {
      "X-Tasklutein-Gateway": gatewayToken,
      Authorization: "Bearer " + agentToken,
      Accept: "application/json, text/event-stream",
    };
    const jsonBody = JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} });
    const wrongType = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: jsonBody,
    });
    expect(wrongType.status).toBe(415);

    const unsupportedMethod = await fetch(url, { method: "GET", headers });
    expect(unsupportedMethod.status).toBe(405);
    expect(unsupportedMethod.headers.get("allow")).toBe("POST");

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(jsonBody));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    const oversizedRequest = {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: oversizedBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" };
    const oversized = await fetch(url, oversizedRequest);
    expect(oversized.status).toBe(413);
  });

  it("executes agent tools through the shared authenticated backend", async () => {
    const backend = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer " + agentToken);
      expect(req.headers["x-tasklutein-gateway"]).toBe(gatewayToken);
      expect(req.url).toBe("/api/tasks?status=done");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tasks: [{ id: "saved-task", status: "done" }] }));
    });
    live.push(backend);
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address();
    if (!address || typeof address === "string") throw new Error("backend address missing");

    const url = await serve("http://127.0.0.1:" + address.port);
    const client = new Client({ name: "integration-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: {
        Authorization: "Bearer " + agentToken,
        "X-Tasklutein-Gateway": gatewayToken
      } }
    });
    try {
      await client.connect(transport);
      const toolResult = await client.callTool({ name: "list_tasks", arguments: { status: "done" } });
      const contents: unknown = toolResult.content;
      if (!Array.isArray(contents)) throw new Error("MCP result content is not an array");
      const textBlocks = contents.filter((part: unknown): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null &&
        "type" in part && part.type === "text" &&
        "text" in part && typeof part.text === "string");
      expect(textBlocks).toHaveLength(1);
      expect(JSON.parse(textBlocks[0].text)).toMatchObject({
        tasks: [{ id: "saved-task", status: "done" }]
      });
    } finally {
      await client.close();
    }
  });

  it("speaks real MCP Streamable HTTP and exposes the 5 tools", async () => {
    const url = await serve();
    const client = new Client({ name: "remote-mcp-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          Authorization: "Bearer " + agentToken,
          "X-Tasklutein-Gateway": gatewayToken,
        }
      },
    });
    try {
      await client.connect(transport);
      const actual = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(actual).toEqual(["add_report", "create_task", "get_task", "list_tasks", "update_task"]);
    } finally {
      await client.close();
    }
  });
});
