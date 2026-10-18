/**
 * Remote MCP Streamable HTTP service, hosted ONLY inside Tencent Docker.
 * Stateless transport: no sticky sessions, no server-initiated notifications.
 * Each POST uses an independent MCP transport to avoid concurrent-request
 * state and to allow horizontal scaling later.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createTaskluteinMcpServer, type McpApiConfig } from "./server";

export type HttpMcpConfig = Omit<McpApiConfig, "agentToken"> & {
  gatewayToken: string;
  allowedOrigins?: string[];
};

function sameSecret(provided: string | undefined, expected: string): boolean {
  if (!provided || expected.length < 32) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function error(res: ServerResponse, status: number, detail: string, requestId: string) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  res.end(JSON.stringify({ detail, code: detail, request_id: requestId }));
}

export function createHttpMcpServer(config: HttpMcpConfig): Server {
  if (config.gatewayToken.length < 32 || config.gatewayToken.startsWith("REPLACE_WITH")) {
    throw new Error("MCP requires a strong origin gateway secret");
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const suppliedRequestId = req.headers["x-request-id"];
    let requestId: string = randomUUID();
    if (
      typeof suppliedRequestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedRequestId)
    ) {
      requestId = suppliedRequestId.toLowerCase();
    }
    if (req.url === "/health" && req.method === "GET") {
      error(res, 200, "ok", requestId);
      return;
    }
    if (req.url !== "/mcp" && req.url !== "/mcp/") {
      error(res, 404, "not_found", requestId);
      return;
    }

    if (!sameSecret(req.headers["x-tasklutein-gateway"] as string | undefined, config.gatewayToken)) {
      error(res, 403, "invalid_gateway", requestId);
      return;
    }
    const authorization = req.headers.authorization ?? "";
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match || match[1].length < 32 || match[1].startsWith("REPLACE_WITH")) {
      res.setHeader("WWW-Authenticate", "Bearer");
      error(res, 401, "unauthorized", requestId);
      return;
    }
    const agentToken = match[1];

    // Deny unapproved browser Origin headers (MCP DNS rebinding guidance).
    const requestOrigin = req.headers.origin;
    if (requestOrigin && !(config.allowedOrigins ?? []).includes(requestOrigin)) {
      error(res, 403, "origin_not_allowed", requestId);
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      error(res, 405, "method_not_allowed", requestId);
      return;
    }
    if (Number(req.headers["content-length"] ?? 0) > 1024 * 1024) {
      error(res, 413, "request_too_large", requestId);
      return;
    }

    let identity: Response;
    try {
      identity = await fetch(config.apiBase.replace(/\/$/, "") + "/api/agent/whoami", {
        method: "GET",
        headers: {
          Authorization: "Bearer " + agentToken,
          "X-Tasklutein-Gateway": config.gatewayToken,
          "X-Request-ID": requestId,
        },
        redirect: "manual",
      });
    } catch {
      error(res, 502, "identity_service_unavailable", requestId);
      return;
    }
    if (!identity.ok) {
      res.setHeader("WWW-Authenticate", "Bearer");
      error(res, 401, "unauthorized", requestId);
      return;
    }
    await identity.body?.cancel();

    // The MCP SDK owns request parsing and streaming. No body parsing here.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 1024 * 1024,
    });
    const server = createTaskluteinMcpServer({
      apiBase: config.apiBase,
      gatewayToken: config.gatewayToken,
      agentToken,
      requestId,
    });
    res.setHeader("X-Request-ID", requestId);
    res.on("close", () => {
      void server.close().catch((err: unknown) => console.error("MCP cleanup failed", err));
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("MCP request failed request_id=" + requestId);
      if (!res.headersSent) error(res, 500, "internal_error", requestId);
      else res.end();
    }
  });
}
