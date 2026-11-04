import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpMcpServer } from "../apps/mcp/src/http";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiDirectory = join(repositoryRoot, "apps", "api");
const scratchDirectory = join(repositoryRoot, "testplace");
const gatewaySecret = randomBytes(32).toString("hex");
const accessIssuer = "https://access.example.test";
const accessSubject = "mcp-integration-" + randomUUID();
const accessEmail = accessSubject + "@example.test";
const teammateSubject = "mcp-teammate-" + randomUUID();
const teammateEmail = teammateSubject + "@example.test";
const accessOrigin = "http://localhost:5173";

let apiProcess: ChildProcess | undefined;
let mcpServer: Server | undefined;
let databasePath: string | undefined;

function gatewayHeaders(): Record<string, string> {
  return { "X-Tasklutein-Gateway": gatewaySecret };
}

function userHeadersFor(subject: string, email: string, workspaceId?: string): Record<string, string> {
  return {
    ...gatewayHeaders(),
    "X-Tasklutein-Access-Issuer": accessIssuer,
    "X-Tasklutein-Access-Subject": subject,
    "X-Tasklutein-Access-Email": email,
    ...(workspaceId ? { "X-Tasklutein-Workspace-ID": workspaceId } : {}),
    Origin: accessOrigin,
  };
}

function userHeaders(): Record<string, string> {
  return userHeadersFor(accessSubject, accessEmail);
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
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
  if (!address || typeof address === "string") throw new Error("Could not reserve a local API port");
  await new Promise<void>((resolveClose, rejectClose) => reservation.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

async function createSchema(databaseUrl: string): Promise<void> {
  const pythonSetup = [
    "from sqlalchemy import create_engine, event",
    "from app.models import Base",
    `engine = create_engine(${JSON.stringify(databaseUrl)})`,
    "event.listen(engine, 'connect', lambda connection, _: connection.execute('PRAGMA foreign_keys=ON'))",
    "Base.metadata.create_all(engine)",
    "engine.dispose()",
  ].join("; ");
  await run("uv", ["run", "--locked", "python", "-c", pythonSetup], apiDirectory);
}

async function pythonExecutable(): Promise<string> {
  return run("uv", ["run", "--locked", "python", "-c", "import sys; print(sys.executable)"], apiDirectory);
}

async function waitForApi(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (apiProcess?.exitCode !== null && apiProcess?.exitCode !== undefined) {
      throw new Error(`FastAPI exited before becoming ready (code ${apiProcess.exitCode})`);
    }
    try {
      const response = await fetch(baseUrl + "/api/health", { headers: gatewayHeaders() });
      if (response.ok) return;
    } catch {
      // Wait briefly while the real local FastAPI process starts.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("FastAPI did not become ready within 30 seconds");
}

async function callApi(baseUrl: string, path: string, init: RequestInit): Promise<Response> {
  return fetch(baseUrl + path, {
    ...init,
    headers: { ...gatewayHeaders(), ...init.headers },
    redirect: "manual",
  });
}

async function connectMcp(url: string, key: string): Promise<Client> {
  const client = new Client({ name: "tasklutein-real-integration", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: "Bearer " + key, ...gatewayHeaders() } },
  });
  await client.connect(transport);
  return client;
}

function firstTextContent(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("MCP result content is not an array");
  }
  const block = result.content.find((item: unknown): item is { type: "text"; text: string } =>
    typeof item === "object" && item !== null && "type" in item && item.type === "text" &&
    "text" in item && typeof item.text === "string");
  if (!block) throw new Error("MCP result contains no text block");
  return block.text;
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

describe("Tasklutein HTTP MCP with a real local FastAPI process", () => {
  it("isolates workspace keys, runs all nine tools, and rejects deleted keys", async () => {
    await mkdir(scratchDirectory, { recursive: true });
    databasePath = join(scratchDirectory, "mcp-integration-" + randomUUID() + ".sqlite");
    const databaseUrl = "sqlite:///" + databasePath.replaceAll("\\", "/");
    await createSchema(databaseUrl);

    const port = await freePort();
    const apiBase = `http://127.0.0.1:${port}`;
    apiProcess = spawn(await pythonExecutable(), ["-m", "uvicorn", "app.main:app",
      "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        EDGE_GATEWAY_TOKEN: gatewaySecret,
        WEB_ORIGINS: accessOrigin,
      },
      shell: false,
      stdio: "ignore",
    });
    await waitForApi(apiBase);

    const bootstrap = await callApi(apiBase, "/api/session/bootstrap", {
      method: "POST",
      headers: userHeaders(),
    });
    expect(bootstrap.status).toBe(200);
    const teammateBootstrap = await callApi(apiBase, "/api/session/bootstrap", {
      method: "POST",
      headers: userHeadersFor(teammateSubject, teammateEmail),
    });
    expect(teammateBootstrap.status).toBe(200);
    const teammateUserId = (await teammateBootstrap.json() as { user: { id: string } }).user.id;

    const teamResponse = await callApi(apiBase, "/api/workspaces", {
      method: "POST",
      headers: { ...userHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "MCP team integration" }),
    });
    expect(teamResponse.status).toBe(201);
    const teamId = (await teamResponse.json() as { workspace: { id: string } }).workspace.id;
    const inviteResponse = await callApi(apiBase, `/api/workspaces/${teamId}/invitations`, {
      method: "POST",
      headers: { ...userHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ email: teammateEmail }),
    });
    expect(inviteResponse.status).toBe(201);
    const invitationId = (await inviteResponse.json() as { invitation: { id: string } }).invitation.id;
    const acceptResponse = await callApi(apiBase, `/api/invitations/${invitationId}/accept`, {
      method: "POST", headers: userHeadersFor(teammateSubject, teammateEmail),
    });
    expect(acceptResponse.status).toBe(200);

    const firstKeyResponse = await callApi(apiBase, "/api/agent-tokens", {
      method: "POST",
      headers: { ...userHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "MCP integration key one" }),
    });
    const secondKeyResponse = await callApi(apiBase, "/api/agent-tokens", {
      method: "POST",
      headers: { ...userHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "MCP integration key two" }),
    });
    expect(firstKeyResponse.status).toBe(201);
    expect(secondKeyResponse.status).toBe(201);
    const firstKey = await firstKeyResponse.json() as { token: { id: string }; secret: string };
    const secondKey = await secondKeyResponse.json() as { token: { id: string }; secret: string };
    expect(firstKey.secret).not.toBe(secondKey.secret);

    const ownerTeamKeyResponse = await callApi(apiBase, "/api/agent-tokens", {
      method: "POST",
      headers: { ...userHeadersFor(accessSubject, accessEmail, teamId), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "MCP team owner key" }),
    });
    const teammateTeamKeyResponse = await callApi(apiBase, "/api/agent-tokens", {
      method: "POST",
      headers: { ...userHeadersFor(teammateSubject, teammateEmail, teamId), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "MCP team member key" }),
    });
    expect(ownerTeamKeyResponse.status).toBe(201);
    expect(teammateTeamKeyResponse.status).toBe(201);
    const ownerTeamKey = await ownerTeamKeyResponse.json() as { token: { id: string }; secret: string };
    const teammateTeamKey = await teammateTeamKeyResponse.json() as { token: { id: string }; secret: string };

    mcpServer = createHttpMcpServer({ apiBase, gatewayToken: gatewaySecret });
    await new Promise<void>((resolveListen) => mcpServer!.listen(0, "127.0.0.1", resolveListen));
    const address = mcpServer.address();
    if (!address || typeof address === "string") throw new Error("MCP TCP address missing");
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

    const initializeBody = JSON.stringify({
      jsonrpc: "2.0", method: "initialize", id: 1,
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "integration", version: "1.0" } },
    });
    const missingKey = await fetch(mcpUrl, {
      method: "POST", headers: { ...gatewayHeaders(), "Content-Type": "application/json" }, body: initializeBody,
    });
    expect(missingKey.status).toBe(401);
    const invalidKey = await fetch(mcpUrl, {
      method: "POST",
      headers: { ...gatewayHeaders(), Authorization: "Bearer tlu_" + "x".repeat(48), "Content-Type": "application/json" },
      body: initializeBody,
    });
    expect(invalidKey.status).toBe(401);

    const client = await connectMcp(mcpUrl, ownerTeamKey.secret);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "add_report", "add_report_comment", "create_task", "get_task", "list_report_comments",
        "list_report_reviews", "list_reports", "list_tasks", "update_task",
      ]);
      const updateTaskSchema = tools.find((tool) => tool.name === "update_task")?.inputSchema as {
        properties?: Record<string, unknown>;
      };
      expect(updateTaskSchema.properties?.expected_version).toBeDefined();
      expect(updateTaskSchema.properties?.assignee_user_id).toBeDefined();
      expect(updateTaskSchema.properties?.workspace_id).toBeUndefined();

      const created = await client.callTool({
        name: "create_task", arguments: { title: "MCP integration check", description: "Created through real FastAPI." },
      });
      const createdValue = JSON.parse(firstTextContent(created)) as { task?: { id?: string } };
      const taskId = createdValue.task?.id;
      expect(taskId).toMatch(/^[0-9a-f-]{36}$/i);
      if (!taskId) throw new Error("create_task returned no task id");

      const initialTask = await client.callTool({ name: "get_task", arguments: { id: taskId } });
      const initialTaskValue = JSON.parse(firstTextContent(initialTask)) as {
        task?: { task?: { version?: number } };
      };
      const expectedVersion = initialTaskValue.task?.task?.version;
      expect(expectedVersion).toBe(1);
      if (expectedVersion === undefined) throw new Error("get_task did not return a task version");
      const missingVersion = await client.callTool({
        name: "update_task", arguments: { id: taskId, status: "in_progress" },
      });
      expect(missingVersion.isError).toBe(true);

      const updated = await client.callTool({
        name: "update_task", arguments: {
          id: taskId,
          expected_version: expectedVersion,
          assignee_user_id: teammateUserId,
          status: "in_progress",
        },
      });
      expect(firstTextContent(updated)).toContain(taskId);
      expect(firstTextContent(updated)).toContain(teammateUserId);
      const staleUpdate = await client.callTool({
        name: "update_task", arguments: { id: taskId, expected_version: expectedVersion, title: "Stale overwrite" },
      });
      expect(staleUpdate.isError).toBe(true);
      expect(firstTextContent(staleUpdate)).toContain("409");
      expect(firstTextContent(staleUpdate)).toContain('"code":"task_version_conflict"');
      expect(firstTextContent(staleUpdate)).toContain('"latest_task"');
      const clearedAssignee = await client.callTool({
        name: "update_task", arguments: { id: taskId, expected_version: expectedVersion + 1, assignee_user_id: null },
      });
      expect(clearedAssignee.isError).not.toBe(true);
      expect(JSON.parse(firstTextContent(clearedAssignee))).toMatchObject({
        task: { assignee_user_id: null, version: expectedVersion + 2 },
      });
      const nonMemberAssignment = await client.callTool({
        name: "update_task", arguments: {
          id: taskId,
          expected_version: expectedVersion + 2,
          assignee_user_id: randomUUID(),
        },
      });
      expect(nonMemberAssignment.isError).toBe(true);
      expect(firstTextContent(nonMemberAssignment)).toContain("404");

      const report = await client.callTool({
        name: "add_report", arguments: { task_id: taskId, content: "Verified through real FastAPI." },
      });
      expect(firstTextContent(report)).toContain("Verified through real FastAPI.");
      const reportValue = JSON.parse(firstTextContent(report)) as { report?: { id?: string } };
      const reportId = reportValue.report?.id;
      expect(reportId).toMatch(/^[0-9a-f-]{36}$/i);
      if (!reportId) throw new Error("add_report returned no report id");

      const reviewResponse = await callApi(apiBase, `/api/reports/${reportId}/review`, {
        method: "PUT",
        headers: { ...userHeadersFor(accessSubject, accessEmail, teamId), "Content-Type": "application/json" },
        body: JSON.stringify({ score: 5, verdict: "approved", note: "Verified by the integration test." }),
      });
      expect(reviewResponse.status).toBe(200);
      const reviews = await client.callTool({ name: "list_report_reviews", arguments: { report_id: reportId } });
      expect(reviews.isError).not.toBe(true);
      expect(firstTextContent(reviews)).toContain("Verified by the integration test.");

      const firstComment = await client.callTool({
        name: "add_report_comment", arguments: { report_id: reportId, content: "Checked the reported result." },
      });
      const firstCommentValue = JSON.parse(firstTextContent(firstComment)) as {
        comment?: { id?: string; report_id?: string; content?: string; source?: string; actor_name?: string; created_at?: string };
      };
      expect(firstCommentValue.comment).toMatchObject({
        report_id: reportId,
        content: "Checked the reported result.",
        source: "agent",
        actor_name: "MCP team owner key",
      });
      expect(firstCommentValue.comment?.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(firstCommentValue.comment?.created_at).toBeTruthy();
      await client.callTool({
        name: "add_report_comment", arguments: { report_id: reportId, content: "Second comment." },
      });

      const comments = await client.callTool({
        name: "list_report_comments", arguments: { report_id: reportId, limit: 1, offset: 0 },
      });
      expect(JSON.parse(firstTextContent(comments))).toMatchObject({
        total: 2,
        limit: 1,
        offset: 0,
        comments: [expect.objectContaining({ report_id: reportId, content: "Checked the reported result." })],
      });
      const nextCommentPage = await client.callTool({
        name: "list_report_comments", arguments: { report_id: reportId, limit: 1, offset: 1 },
      });
      expect(JSON.parse(firstTextContent(nextCommentPage))).toMatchObject({
        total: 2,
        limit: 1,
        offset: 1,
        comments: [expect.objectContaining({ report_id: reportId, content: "Second comment." })],
      });

      const detail = await client.callTool({ name: "get_task", arguments: { id: taskId } });
      const detailValue = JSON.parse(firstTextContent(detail)) as {
        task?: { task?: { id?: string; version?: number } };
        reports?: { reports?: Array<{ content?: string }> };
      };
      expect(detailValue.task?.task?.id).toBe(taskId);
      expect(detailValue.task?.task?.version).toBe(3);
      expect(detailValue.reports?.reports).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Verified through real FastAPI." })]),
      );

      const tasks = await client.callTool({ name: "list_tasks", arguments: { q: "MCP integration check", limit: 10, offset: 0 } });
      expect(JSON.parse(firstTextContent(tasks))).toMatchObject({
        tasks: expect.arrayContaining([expect.objectContaining({ id: taskId, version: 3 })]),
      });

      const reports = await client.callTool({ name: "list_reports", arguments: { task_id: taskId, limit: 10, offset: 0 } });
      expect(JSON.parse(firstTextContent(reports))).toMatchObject({
        reports: expect.arrayContaining([expect.objectContaining({ content: "Verified through real FastAPI." })]),
      });

      const revoked = await callApi(apiBase, `/api/agent-tokens/${firstKey.token.id}`, {
        method: "DELETE", headers: userHeaders(),
      });
      expect(revoked.status).toBe(204);
      const revokedIdentity = await callApi(apiBase, "/api/agent/whoami", {
        method: "GET", headers: { Authorization: "Bearer " + firstKey.secret },
      });
      expect(revokedIdentity.status).toBe(401);
      await expect(connectMcp(mcpUrl, firstKey.secret)).rejects.toThrow();

      const otherClient = await connectMcp(mcpUrl, teammateTeamKey.secret);
      try {
        const otherKeyComments = await otherClient.callTool({
          name: "list_report_comments", arguments: { report_id: reportId, limit: 10, offset: 0 },
        });
        expect(JSON.parse(firstTextContent(otherKeyComments))).toMatchObject({
          total: 2,
          comments: expect.arrayContaining([expect.objectContaining({ content: "Checked the reported result." })]),
        });
        const stillValid = await otherClient.callTool({ name: "list_tasks", arguments: { limit: 10, offset: 0 } });
        expect(JSON.parse(firstTextContent(stillValid))).toMatchObject({
          tasks: expect.arrayContaining([expect.objectContaining({ id: taskId })]),
        });
      } finally {
        await otherClient.close();
      }
    } finally {
      await client.close();
    }
  }, 90_000);
});
