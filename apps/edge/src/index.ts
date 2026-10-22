/**
 * Cloudflare Worker: the only public app entrypoint.
 * Web API requests are authenticated by Cloudflare Access; static Web assets are
 * public. MCP requests use personal Agent Bearer keys and are restricted to the
 * dedicated MCP hostname.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type EdgeEnv = Omit<Env, "ASSETS"> & {
  ASSETS: Pick<Fetcher, "fetch">;
  ORIGIN_URL?: string;
  ORIGIN_GATEWAY_TOKEN?: string;
  WEB_HOST?: string;
  MCP_HOST?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};

const GATEWAY_HEADER = "X-Tasklutein-Gateway";
const INTERNAL_IDENTITY_HEADERS = [
  "X-Tasklutein-Access-Issuer",
  "X-Tasklutein-Access-Subject",
  "X-Tasklutein-Access-Email",
];
const MAX_REST_REQUEST_BYTES = 64 * 1024;
const MAX_MCP_REQUEST_BYTES = 1024 * 1024;
const accessJwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const ALLOWED_HEADERS = new Set([
  "authorization", "content-type", "accept", "accept-language",
  "mcp-protocol-version", "mcp-session-id", "last-event-id", "origin", "x-request-id",
  ...INTERNAL_IDENTITY_HEADERS.map((name) => name.toLowerCase()),
]);

function gatewayError(detail: string, status: number, requestId: string): Response {
  return Response.json(
    { detail, code: detail, request_id: requestId },
    { status, headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } },
  );
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function isAllowedOrigin(address: string): URL | undefined {
  try {
    const url = new URL(address);
    const local = isLocalHostname(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return;
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return;
    return url;
  } catch {
    return undefined;
  }
}

function requestHost(request: Request, incoming: URL): string | undefined {
  const hostHeader = request.headers.get("Host");
  if (!hostHeader) return incoming.hostname.toLowerCase();
  if (hostHeader.includes(",")) return;
  try {
    const parsed = new URL(`${incoming.protocol}//${hostHeader}`);
    if (parsed.pathname !== "/" || parsed.username || parsed.password || parsed.search || parsed.hash ||
        parsed.host.toLowerCase() !== incoming.host.toLowerCase()) return;
    return parsed.hostname.toLowerCase();
  } catch {
    return;
  }
}

function accessConfig(env: EdgeEnv): { issuer: string; audience: string; jwks: ReturnType<typeof createRemoteJWKSet> } | undefined {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return;
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(domain.includes("://") ? domain : `https://${domain}`);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return;
  const issuer = parsed.origin;
  let jwks = accessJwksByIssuer.get(issuer);
  if (!jwks) {
    // Access signing keys are public and rotate; jose refreshes this resolver's
    // cache without retaining request-specific identity between Worker calls.
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    accessJwksByIssuer.set(issuer, jwks);
  }
  return {
    issuer,
    audience: env.ACCESS_AUD,
    jwks,
  };
}

function accessToken(request: Request): string | undefined {
  return request.headers.get("Cf-Access-Jwt-Assertion") ?? undefined;
}

async function verifiedAccessIdentity(
  request: Request,
  env: EdgeEnv,
  resolveKey?: JWTVerifyGetKey,
): Promise<{ issuer: string; subject: string; email: string } | undefined> {
  const config = accessConfig(env);
  const token = accessToken(request);
  if (!config || !token) return;
  try {
    const { payload, protectedHeader } = await jwtVerify(token, resolveKey ?? config.jwks, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "exp", "sub"],
    });
    if (protectedHeader.alg !== "RS256" || typeof payload.sub !== "string" || !payload.sub ||
        typeof payload.email !== "string" || !payload.email) return;
    return { issuer: config.issuer, subject: payload.sub, email: payload.email };
  } catch {
    return;
  }
}

export async function proxyGateway(
  request: Request,
  env: EdgeEnv,
  fetchOrigin: (request: Request, init?: RequestInit) => Promise<Response> = fetch,
  resolveAccessKey?: JWTVerifyGetKey,
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

  const host = requestHost(request, incoming);
  if (!host || !env.WEB_HOST || !env.MCP_HOST || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return gatewayError("gateway_not_configured", 503, requestId);
  }
  const webHost = env.WEB_HOST.toLowerCase();
  const mcpHost = env.MCP_HOST.toLowerCase();
  const isWeb = host === webHost;
  const isMcp = host === mcpHost;
  if (!isWeb && !isMcp) return gatewayError("host_not_allowed", 404, requestId);

  if (isMcp) {
    if (incoming.pathname !== "/mcp") return gatewayError("path_not_allowed", 404, requestId);
  } else {
    if (incoming.pathname === "/mcp" || incoming.pathname.startsWith("/mcp/")) {
      return gatewayError("path_not_allowed", 404, requestId);
    }
    if (!(incoming.pathname === "/api" || incoming.pathname.startsWith("/api/"))) {
      return env.ASSETS.fetch(request);
    }
  }

  const isHealth = isWeb && incoming.pathname === "/api/health";
  const identity = isWeb && !isHealth ? await verifiedAccessIdentity(request, env, resolveAccessKey) : undefined;
  if (isWeb && !isHealth && !identity) return gatewayError("unauthorized", 401, requestId);
  if (isWeb && incoming.pathname === "/api/session/login") {
    if (request.method !== "GET") return gatewayError("method_not_allowed", 405, requestId);
    return new Response(null, {
      status: 302,
      headers: { Location: "/", "Cache-Control": "no-store", "X-Request-ID": requestId },
    });
  }
  if (isMcp && !/^Bearer \S+$/.test(request.headers.get("Authorization") ?? "")) {
    return gatewayError("unauthorized", 401, requestId);
  }
  const contentLength = Number(request.headers.get("Content-Length"));
  const maxRequestBytes = isMcp ? MAX_MCP_REQUEST_BYTES : MAX_REST_REQUEST_BYTES;
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    return gatewayError("request_too_large", 413, requestId);
  }
  if (!env.ORIGIN_URL || !env.ORIGIN_GATEWAY_TOKEN || env.ORIGIN_GATEWAY_TOKEN.length < 32 ||
      env.ORIGIN_GATEWAY_TOKEN.startsWith("REPLACE_WITH")) {
    return gatewayError("gateway_not_configured", 503, requestId);
  }

  const origin = isAllowedOrigin(env.ORIGIN_URL);
  if (!origin) return gatewayError("invalid_origin_configuration", 503, requestId);

  const target = new URL(incoming.pathname + incoming.search, origin);
  const upstreamRequest = new Request(target.toString(), request);
  for (const name of [...upstreamRequest.headers.keys()]) {
    if (!ALLOWED_HEADERS.has(name.toLowerCase())) upstreamRequest.headers.delete(name);
  }
  for (const name of INTERNAL_IDENTITY_HEADERS) upstreamRequest.headers.delete(name);
  if (identity) {
    upstreamRequest.headers.set(INTERNAL_IDENTITY_HEADERS[0], identity.issuer);
    upstreamRequest.headers.set(INTERNAL_IDENTITY_HEADERS[1], identity.subject);
    upstreamRequest.headers.set(INTERNAL_IDENTITY_HEADERS[2], identity.email);
  }
  if (isWeb) upstreamRequest.headers.delete("authorization");
  upstreamRequest.headers.set(GATEWAY_HEADER, env.ORIGIN_GATEWAY_TOKEN);
  upstreamRequest.headers.set("X-Request-ID", requestId);

  try {
    const upstream = await fetchOrigin(upstreamRequest, { redirect: "manual" });
    if (upstream.status >= 300 && upstream.status < 400) return gatewayError("origin_redirect_rejected", 502, requestId);
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
  },
};
