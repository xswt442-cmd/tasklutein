/**
 * Cloudflare Worker: the ONLY public app entrypoint.
 *
 * Serves Vite assets and proxies API / remote MCP traffic to a
 * private-origin hostname backed by Tencent Docker + Cloudflare Tunnel.
 * Cloudflare never hosts business logic, the MCP server, or PostgreSQL.
 */
export type EdgeEnv = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ORIGIN_URL?: string;
  ORIGIN_GATEWAY_TOKEN?: string;
};

const GATEWAY_HEADER = "X-Tasklutein-Gateway";
const MAX_REST_REQUEST_BYTES = 64 * 1024;
const ALLOWED_HEADERS = new Set([
  "authorization", "content-type", "accept", "accept-language",
  "mcp-protocol-version", "mcp-session-id", "last-event-id", "origin", "x-request-id",
]);

function gatewayError(detail: string, status: number, requestId: string): Response {
  return Response.json(
    { detail, code: detail, request_id: requestId },
    { status, headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } },
  );
}

function isGatewayPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") ||
    pathname === "/mcp" || pathname === "/mcp/";
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function isAllowedOrigin(address: string): URL | undefined {
  try {
    const url = new URL(address);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return;
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return;
    return url;
  } catch {
    return undefined;
  }
}

export async function proxyGateway(
  request: Request,
  env: EdgeEnv,
  fetchOrigin: (request: Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const incoming = new URL(request.url);
  const requestId = crypto.randomUUID();
  if (incoming.protocol === "http:" && !isLocalHostname(incoming.hostname)) {
    incoming.protocol = "https:";
    return new Response(null, {
      status: 308,
      headers: { Location: incoming.toString(), "X-Request-ID": requestId },
    });
  }
  if (!isGatewayPath(incoming.pathname)) return env.ASSETS.fetch(request);

  if (incoming.pathname !== "/api/health" &&
      !/^Bearer \S+$/.test(request.headers.get("Authorization") ?? "")) {
    return gatewayError("unauthorized", 401, requestId);
  }
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REST_REQUEST_BYTES) {
    return gatewayError("request_too_large", 413, requestId);
  }
  if (!env.ORIGIN_URL || !env.ORIGIN_GATEWAY_TOKEN || env.ORIGIN_GATEWAY_TOKEN.length < 32 ||
      env.ORIGIN_GATEWAY_TOKEN.startsWith("REPLACE_WITH")) {
    return gatewayError("gateway_not_configured", 503, requestId);
  }

  const origin = isAllowedOrigin(env.ORIGIN_URL);
  if (!origin) {
    return gatewayError("invalid_origin_configuration", 503, requestId);
  }

  // Copy the body/stream without materializing it. A strict header allowlist
  // prevents spoofing the gateway identity or forwarding browser cookies.
  const target = new URL(incoming.pathname + incoming.search, origin);
  const upstreamRequest = new Request(target.toString(), request);
  for (const name of [...upstreamRequest.headers.keys()]) {
    if (!ALLOWED_HEADERS.has(name.toLowerCase())) upstreamRequest.headers.delete(name);
  }
  upstreamRequest.headers.set(GATEWAY_HEADER, env.ORIGIN_GATEWAY_TOKEN);
  upstreamRequest.headers.set("X-Request-ID", requestId);

  try {
    const upstream = await fetchOrigin(upstreamRequest, { redirect: "manual" });
    // Never follow redirects with origin credentials attached.
    if (upstream.status >= 300 && upstream.status < 400) {
      return gatewayError("origin_redirect_rejected", 502, requestId);
    }
    const headers = new Headers(upstream.headers);
    headers.delete("set-cookie");
    headers.delete("server");
    headers.delete("x-powered-by");
    headers.delete("access-control-allow-origin");
    headers.delete("access-control-allow-credentials");
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Request-ID", requestId);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch {
    return gatewayError("origin_unavailable", 502, requestId);
  }
}

export default {
  fetch(request: Request, env: EdgeEnv): Promise<Response> {
    return proxyGateway(request, env);
  }
};
