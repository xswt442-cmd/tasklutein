import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createHttpMcpServer } from "../apps/mcp/src/http";
import { proxyGateway, type EdgeEnv } from "../apps/edge/src/index";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = join(repositoryRoot, "apps", "api");
const scratchDirectory = join(repositoryRoot, "testplace");
const gatewaySecret = randomBytes(32).toString("hex");
const accessIssuer = "https://team.integration.test";
const accessAudience = "tasklutein-edge-integration";
const webHost = "web.tasklutein.integration.test";
const mcpHost = "mcp.tasklutein.integration.test";
const webOrigin = `https://${webHost}`;
const userA = { subject: "integration-user-a-" + randomUUID(), email: "edge-a@example.test" };
const userB = { subject: "integration-user-b-" + randomUUID(), email: "edge-b@example.test" };

let apiProcess: ChildProcess | undefined;
let mcpServer: Server | undefined;
let originRouter: Server | undefined;
let databasePath: string | undefined;
let apiBase: string;
let apiEnv: EdgeEnv;
let jwks: ReturnType<typeof createLocalJWKSet>;
const realFetch = globalThis.fetch.bind(globalThis);

async function fetchLocalOrigin(request: Request, init?: RequestInit): Promise<Response> {
  // Give Node fetch a replayable body source for this local HTTP integration path.
  const body = request.body ? await request.arrayBuffer() : undefined;
  const headers = new Headers(request.headers);
  if (body) headers.set("Content-Length", String(body.byteLength));
  return realFetch(new Request(request.url, {
    method: request.method,
    headers,
    body,
    redirect: init?.redirect,
  }));
}
let signAccess: (identity: typeof userA, claims?: { iss?: string; aud?: string; exp?: number }) => Promise<string>;

async function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else rejectRun(new Error(`${command} exited with code ${String(code)}: ${stderr}`));
    });
  });
}

async function freePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    reservation.once("error", rejectListen);
    reservation.listen(0, "127.0.0.1", resolveListen);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local TCP port");
  await new Promise<void>((resolveClose, rejectClose) =>
    reservation.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

async function pythonExecutable(): Promise<string> {
  return run("uv", ["run", "--locked", "python", "-c", "import sys; print(sys.executable)"], apiDirectory);
}

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (apiProcess?.exitCode !== null && apiProcess?.exitCode !== undefined) {
      throw new Error(`FastAPI exited before becoming ready (code ${apiProcess.exitCode})`);
    }
    try {
      const response = await fetch(apiBase + "/api/health", {
        headers: { "X-Tasklutein-Gateway": gatewaySecret },
      });
      if (response.ok) return;
    } catch {
      // The API process is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("FastAPI did not become ready within 30 seconds");
}

async function startServer(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server TCP address missing");
  return address.port;
}

function createOriginRouter(apiOrigin: string, mcpOrigin: string): Server {
  // Forward each Worker path to the corresponding real local service.
  return createServer(async (incoming, outgoing) => {
    try {
      const route = incoming.url ?? "/";
      const targetOrigin = route === "/mcp" || route.startsWith("/mcp?") ? mcpOrigin : apiOrigin;
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined || ["host", "content-length", "connection", "transfer-encoding"].includes(name)) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const chunks: Buffer[] = [];
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      if (body) headers.set("Content-Length", String(body.byteLength));
      const upstream = await realFetch(new Request(new URL(route, targetOrigin), {
        method: incoming.method,
        headers,
        body,
        redirect: "manual",
      }));
      outgoing.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      outgoing.end(new Uint8Array(await upstream.arrayBuffer()));
    } catch {
      outgoing.destroy();
    }
  });
}

function workerFetch(host: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (typeof init.body === "string") headers.set("Content-Length", String(new TextEncoder().encode(init.body).byteLength));
  const request = new Request(`https://${host}${path}`, { ...init, headers, redirect: "manual" });
  return proxyGateway(request, apiEnv, fetchLocalOrigin, jwks);
}

async function accessHeaders(identity: typeof userA, extra: HeadersInit = {}): Promise<Headers> {
  return new Headers({
    "Cf-Access-Jwt-Assertion": await signAccess(identity),
    Origin: webOrigin,
    ...Object.fromEntries(new Headers(extra).entries()),
  });
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  if (process.platform === "win32" && child.pid) {
    try {
      await run("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], repositoryRoot);
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolveClose) => originRouter ? originRouter.close(() => resolveClose()) : resolveClose()),
    new Promise<void>((resolveClose) => mcpServer ? mcpServer.close(() => resolveClose()) : resolveClose()),
    stopProcess(apiProcess),
  ]);
  if (databasePath) {
    await Promise.all([
      rm(databasePath, { force: true }),
      rm(databasePath + "-wal", { force: true }),
      rm(databasePath + "-shm", { force: true }),
    ]);
  }
});

describe("Cloudflare Worker with real local FastAPI and MCP services", () => {
  it("verifies Access identity, isolates users, and routes real MCP calls", async () => {
    await mkdir(scratchDirectory, { recursive: true });
    databasePath = join(scratchDirectory, "edge-integration-" + randomUUID() + ".sqlite");
    const databaseUrl = "sqlite:///" + databasePath.replaceAll("\\", "/");
    await run("uv", ["run", "--locked", "python", "tests/prepare_sqlite_web_db.py", databaseUrl], apiDirectory, {
      PYTHONPATH: apiDirectory,
    });

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "edge-integration-key";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";
    jwks = createLocalJWKSet({ keys: [publicJwk] });
    signAccess = async (identity, claims = {}) => new SignJWT({ email: identity.email })
      .setProtectedHeader({ alg: "RS256", kid: "edge-integration-key" })
      .setIssuer(claims.iss ?? accessIssuer)
      .setAudience(claims.aud ?? accessAudience)
      .setSubject(identity.subject)
      .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);

    const apiPort = await freePort();
    apiBase = `http://127.0.0.1:${apiPort}`;
    apiProcess = spawn(await pythonExecutable(), ["-m", "uvicorn", "app.main:app",
      "--host", "127.0.0.1", "--port", String(apiPort), "--log-level", "warning"], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        PYTHONPATH: apiDirectory,
        DATABASE_URL: databaseUrl,
        EDGE_GATEWAY_TOKEN: gatewaySecret,
        WEB_ORIGINS: webOrigin,
      },
      shell: false,
      stdio: "ignore",
    });
    await waitForApi();

    mcpServer = createHttpMcpServer({ apiBase, gatewayToken: gatewaySecret });
    const mcpPort = await startServer(mcpServer);
    const mcpBase = `http://127.0.0.1:${mcpPort}`;
    originRouter = createOriginRouter(apiBase, mcpBase);
    const originPort = await startServer(originRouter);
    const originBase = `http://127.0.0.1:${originPort}`;
    const assetBinding = { fetch: async () => { throw new Error("Unexpected static asset request in API/MCP integration"); } };
    apiEnv = {
      ASSETS: assetBinding,
      ORIGIN_URL: originBase,
      ORIGIN_GATEWAY_TOKEN: gatewaySecret,
      WEB_HOST: webHost,
      MCP_HOST: mcpHost,
      ACCESS_TEAM_DOMAIN: accessIssuer,
      ACCESS_AUD: accessAudience,
    };
    const insecureRequest = await proxyGateway(new Request(`http://${webHost}/api/health`), apiEnv, fetchLocalOrigin, jwks);
    expect(insecureRequest.status).toBe(308);
    expect(insecureRequest.headers.get("Location")).toBe(`https://${webHost}/api/health`);

    const unauthorized = await workerFetch(webHost, "/api/me");
    expect(unauthorized.status).toBe(401);

    const wrongIssuer = await signAccess(userA, { iss: "https://attacker.integration.test" });
    const issuerResponse = await workerFetch(webHost, "/api/me", { headers: { "Cf-Access-Jwt-Assertion": wrongIssuer } });
    expect(issuerResponse.status).toBe(401);
    const wrongAudience = await signAccess(userA, { aud: "wrong-audience" });
    const audienceResponse = await workerFetch(webHost, "/api/me", { headers: { "Cf-Access-Jwt-Assertion": wrongAudience } });
    expect(audienceResponse.status).toBe(401);
    const expired = await signAccess(userA, { exp: Math.floor(Date.now() / 1000) - 60 });
    const expiredResponse = await workerFetch(webHost, "/api/me", { headers: { "Cf-Access-Jwt-Assertion": expired } });
    expect(expiredResponse.status).toBe(401);

    const bootstrapA = await workerFetch(webHost, "/api/session/bootstrap", {
      method: "POST",
      headers: await accessHeaders(userA, {
        "X-Tasklutein-Access-Issuer": "https://attacker.integration.test",
        "X-Tasklutein-Access-Subject": "forged-subject",
        "X-Tasklutein-Access-Email": "forged@example.test",
        Authorization: "Bearer forged-web-bearer",
      }),
    });
    expect(bootstrapA.status).toBe(200);
    const provisionedA = await bootstrapA.json() as { user: { id: string; email: string }; workspace: { id: string } };
    expect(provisionedA.user.email).toBe(userA.email);
    const duplicateBootstrapA = await workerFetch(webHost, "/api/session/bootstrap", {
      method: "POST", headers: await accessHeaders(userA),
    });
    expect((await duplicateBootstrapA.json() as { workspace: { id: string } }).workspace.id).toBe(provisionedA.workspace.id);

    const redirectedOrigin = await workerFetch(webHost, "/api/tasks/", { headers: await accessHeaders(userA) });
    expect(redirectedOrigin.status).toBe(502);
    expect((await redirectedOrigin.json() as { code: string }).code).toBe("origin_redirect_rejected");

    const bootstrapB = await workerFetch(webHost, "/api/session/bootstrap", {
      method: "POST", headers: await accessHeaders(userB),
    });
    expect(bootstrapB.status).toBe(200);
    const provisionedB = await bootstrapB.json() as { user: { id: string; email: string }; workspace: { id: string } };
    expect(provisionedB.user.email).toBe(userB.email);
    expect(provisionedB.workspace.id).not.toBe(provisionedA.workspace.id);

    const keyResponse = await workerFetch(webHost, "/api/agent-tokens", {
      method: "POST",
      headers: new Headers(await accessHeaders(userB, { "Content-Type": "application/json" })),
      body: JSON.stringify({ name: "Worker integration Agent key" }),
    });
    expect(keyResponse.status).toBe(201);
    const keyResult = await keyResponse.json() as { token: { id: string }; secret: string };
    expect(keyResult.secret.length).toBeGreaterThan(32);

    const meA = await workerFetch(webHost, "/api/me", {
      headers: await accessHeaders(userA, {
        "X-Tasklutein-Access-Subject": userB.subject,
        "X-Tasklutein-Access-Email": userB.email,
        Authorization: "Bearer " + keyResult.secret,
      }),
    });
    expect(meA.status).toBe(200);
    expect((await meA.json() as { user: { id: string; email: string } }).user).toMatchObject({
      id: provisionedA.user.id,
      email: userA.email,
    });

    const createdTask = await workerFetch(webHost, "/api/tasks", {
      method: "POST",
      headers: await accessHeaders(userA, { "Content-Type": "application/json" }),
      body: JSON.stringify({ title: "Private Worker task", description: "Created through the real Worker and API." }),
    });
    expect(createdTask.status).toBe(201);
    const taskId = (await createdTask.json() as { task: { id: string } }).task.id;
    const crossUserTask = await workerFetch(webHost, `/api/tasks/${taskId}`, {
      headers: await accessHeaders(userB, {
        "X-Tasklutein-Access-Subject": userA.subject,
        "X-Tasklutein-Access-Email": userA.email,
      }),
    });
    expect(crossUserTask.status).toBe(404);

    const webToMcp = await workerFetch(webHost, "/mcp", {
      method: "POST",
      headers: await accessHeaders(userA, { "Content-Type": "application/json" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "edge-test", version: "1" } } }),
    });
    expect(webToMcp.status).toBe(404);
    expect((await workerFetch(mcpHost, "/")).status).toBe(404);
    expect((await workerFetch("unknown.tasklutein.integration.test", "/api/health")).status).toBe(404);

    const missingKey = await workerFetch(mcpHost, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "edge-test", version: "1" } } }),
    });
    expect(missingKey.status).toBe(401);
    const invalidKey = await workerFetch(mcpHost, "/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer tlu_" + "x".repeat(48), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "edge-test", version: "1" } } }),
    });
    expect(invalidKey.status).toBe(401);

    const initialize = await workerFetch(mcpHost, "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + keyResult.secret,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "edge-test", version: "1" } },
      }),
    });
    expect(initialize.status).toBe(200);
    expect(await initialize.json()).toMatchObject({ result: { serverInfo: { name: "tasklutein" } } });
    const toolCall = await workerFetch(mcpHost, "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + keyResult.secret,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { name: "list_tasks", arguments: { q: "Private Worker task", limit: 10, offset: 0 } },
      }),
    });
    expect(toolCall.status).toBe(200);
    const toolResult = await toolCall.json() as { result: { content: Array<{ type: string; text?: string }> } };
    const textContent = toolResult.result.content.find((item) => item.type === "text")?.text;
    expect(textContent).toBeTruthy();
    const mcpCreated = await workerFetch(mcpHost, "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + keyResult.secret,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 6, method: "tools/call",
        params: { name: "create_task", arguments: { title: "Private MCP task", description: "Created through the real MCP service." } },
      }),
    });
    expect(mcpCreated.status).toBe(200);
    const mcpCreatedResult = await mcpCreated.json() as { result: { content: Array<{ type: string; text?: string }> } };
    const mcpCreatedText = mcpCreatedResult.result.content.find((item) => item.type === "text")?.text;
    expect(mcpCreatedText).toBeTruthy();
    const mcpTaskId = (JSON.parse(mcpCreatedText!) as { task: { id: string } }).task.id;
    expect(mcpTaskId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(mcpTaskId).not.toBe(taskId);
    expect(JSON.parse(textContent!)).toMatchObject({ tasks: [], total: 0 });

    const oversized = await workerFetch(webHost, "/api/tasks", {
      method: "POST",
      headers: await accessHeaders(userA, { "Content-Type": "application/json" }),
      body: JSON.stringify({ title: "x".repeat(64 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    const oversizedMcpBody = "x".repeat(1024 * 1024 + 1);
    const oversizedMcp = await workerFetch(mcpHost, "/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer " + keyResult.secret, "Content-Type": "application/json" },
      body: oversizedMcpBody,
    });
    expect(oversizedMcp.status).toBe(413);
    expect(oversizedMcp.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  }, 120_000);
});
