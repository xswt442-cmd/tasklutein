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
const ALLOWED_HEADERS = new Set([
  "authorization", "content-type", "accept", "accept-language",
  "mcp-protocol-version", "mcp-session-id", "last-event-id", "origin",
]);

function isGatewayPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") ||
    pathname === "/mcp" || pathname === "/mcp/";
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
  if (!isGatewayPath(incoming.pathname)) return env.ASSETS.fetch(request);

  if (incoming.pathname !== "/api/health" &&
      !/^Bearer \S+$/.test(request.headers.get("Authorization") ?? "")) {
    return Response.json({ detail: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!env.ORIGIN_URL || !env.ORIGIN_GATEWAY_TOKEN || env.ORIGIN_GATEWAY_TOKEN.length < 32 ||
      env.ORIGIN_GATEWAY_TOKEN.startsWith("REPLACE_WITH")) {
    return Response.json({ detail: "gateway_not_configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const origin = isAllowedOrigin(env.ORIGIN_URL);
  if (!origin) {
    return Response.json({ detail: "invalid_origin_configuration" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  // Copy the body/stream without materializing it. A strict header allowlist
  // prevents spoofing the gateway identity or forwarding browser cookies.
  const target = new URL(incoming.pathname + incoming.search, origin);
  const upstreamRequest = new Request(target.toString(), request);
  for (const name of [...upstreamRequest.headers.keys()]) {
    if (!ALLOWED_HEADERS.has(name.toLowerCase())) upstreamRequest.headers.delete(name);
  }
  upstreamRequest.headers.set(GATEWAY_HEADER, env.ORIGIN_GATEWAY_TOKEN);

  try {
    const upstream = await fetchOrigin(upstreamRequest, { redirect: "manual" });
    // Never follow redirects with origin credentials attached.
    if (upstream.status >= 300 && upstream.status < 400) {
      return Response.json({ detail: "origin_redirect_rejected" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const headers = new Headers(upstream.headers);
    headers.delete("set-cookie");
    headers.delete("server");
    headers.delete("x-powered-by");
    headers.delete("access-control-allow-origin");
    headers.delete("access-control-allow-credentials");
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch {
    return Response.json({ detail: "origin_unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

export default {
  fetch(request: Request, env: EdgeEnv): Promise<Response> {
    return proxyGateway(request, env);
  }
};
