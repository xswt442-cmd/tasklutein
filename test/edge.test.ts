import { describe, expect, it, vi } from "vitest";
import { proxyGateway, type EdgeEnv } from "../apps/edge/src/index";

const secret = "gateway-secret-" + "g".repeat(40);
const assets = { fetch: vi.fn(async () => new Response("index.html", { status: 200 })) };
const env: EdgeEnv = {
  ASSETS: assets,
  ORIGIN_URL: "https://origin.example.test",
  ORIGIN_GATEWAY_TOKEN: secret,
};

describe("Cloudflare ingress", () => {
  it("redirects public HTTP requests to HTTPS before serving assets or proxying auth", async () => {
    const localAssets = { fetch: vi.fn(async () => new Response("index.html")) };
    const origin = vi.fn();
    const request = new Request("http://app.example.test/api/tasks?status=done", {
      headers: { authorization: "Bearer web-user-token" },
    });

    const response = await proxyGateway(request, { ...env, ASSETS: localAssets }, origin);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://app.example.test/api/tasks?status=done");
    expect(origin).not.toHaveBeenCalled();
    expect(localAssets.fetch).not.toHaveBeenCalled();
  });

  it("allows localhost HTTP for local development", async () => {
    const localAssets = { fetch: vi.fn(async () => new Response("index.html")) };
    const response = await proxyGateway(new Request("http://localhost:5173/tasks"), { ...env, ASSETS: localAssets });

    expect(response.status).toBe(200);
    expect(localAssets.fetch).toHaveBeenCalledOnce();
  });

  it("serves application assets without requiring a backend", async () => {
    const response = await proxyGateway(new Request("https://app.example.test/tasks"), env);
    expect(await response.text()).toBe("index.html");
    expect(assets.fetch).toHaveBeenCalled();
  });

  it("rejects anonymous business and MCP requests without fetching origin", async () => {
    const origin = vi.fn();
    const result = await proxyGateway(new Request("https://app.example.test/mcp", { method: "POST" }), env, origin);
    expect(result.status).toBe(401);
    expect(origin).not.toHaveBeenCalled();
  });

  it("forwards only whitelisted headers and replaces forged gateway header", async () => {
    const origin = vi.fn(async (request: Request, opts?: RequestInit) => {
      expect(request.url).toBe("https://origin.example.test/api/tasks?status=done");
      expect(request.headers.get("X-Tasklutein-Gateway")).toBe(secret);
      expect(request.headers.get("Cookie")).toBeNull();
      expect(request.headers.get("X-Forged")).toBeNull();
      expect(request.headers.get("Authorization")).toBe("Bearer web-user-token");
      expect(opts?.redirect).toBe("manual");
      return new Response(JSON.stringify({ tasks: [] }), {
        headers: { "Content-Type": "application/json", "Set-Cookie": "bad=yes" }
      });
    });
    const req = new Request("https://app.example.test/api/tasks?status=done", {
      headers: {
        "Authorization": "Bearer web-user-token",
        "Cookie": "secret=session",
        "X-Forged": "value",
        "X-Tasklutein-Gateway": "bad"
      }
    });
    const result = await proxyGateway(req, env, origin);
    expect(result.status).toBe(200);
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(origin).toHaveBeenCalledTimes(1);
  });

  it("proxies MCP POST bodies and response content types", async () => {
    const origin = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(await request.text()).toBe('{"jsonrpc":"2.0"}');
      return new Response('{"jsonrpc":"2.0"}', { headers: { "content-type": "application/json" } });
    });
    const req = new Request("https://app.example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer agent-token", "content-type": "application/json" },
      body: '{"jsonrpc":"2.0"}'
    });
    const result = await proxyGateway(req, env, origin);
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(origin).toHaveBeenCalledOnce();
  });

  it("fails closed on missing secrets, unsafe origins, and redirects", async () => {
    const health = new Request("https://app.example.test/api/health");
    expect((await proxyGateway(health, { ASSETS: assets })).status).toBe(503);
    expect((await proxyGateway(health, { ...env, ORIGIN_URL: "http://attacker.example.test" })).status).toBe(503);
    const redirected = vi.fn(async () => Response.redirect("https://elsewhere.test", 302));
    expect((await proxyGateway(health, env, redirected)).status).toBe(502);
  });
});
