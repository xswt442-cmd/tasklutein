// @vitest-environment jsdom
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import App from "../apps/web/src/App";
import { createHttpMcpServer } from "../apps/mcp/src/http";

const root = process.cwd();
const backend = join(root, "apps", "api");
const webToken = "web-browser-test-token-" + "a".repeat(40);
const agentToken = "agent-browser-test-token-" + "b".repeat(40);
const gatewayToken = "gateway-browser-integration-token-" + "g".repeat(40);
const databaseDirectory = join(root, "node_modules", ".cache", "tasklutein", "web-test");
const databasePath = join(databaseDirectory, `.web-e2e-${process.pid}.sqlite3`);
const databaseUrl = "sqlite+pysqlite:///" + databasePath.replaceAll("\\", "/");
const pythonFromVirtualEnv = join(root, ".venv", "Scripts", "python.exe");
const python = process.env.TASKLUTEIN_TEST_PYTHON ?? (existsSync(pythonFromVirtualEnv) ? pythonFromVirtualEnv : "python");
const nativeFetch = globalThis.fetch.bind(globalThis);

let apiOrigin = "";
let apiProcess: ChildProcess | undefined;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local API port");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

beforeAll(async () => {
  await mkdir(databaseDirectory, { recursive: true });
  const initializeDatabase = spawnSync(python, ["tests/prepare_sqlite_web_db.py", databaseUrl], {
    cwd: backend,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: backend },
  });
  if (initializeDatabase.status !== 0) {
    throw new Error("Could not prepare an isolated SQLite database for the browser UI: " + initializeDatabase.stderr);
  }

  const port = await freePort();
  apiOrigin = `http://127.0.0.1:${port}`;
  const apiEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: backend,
    DATABASE_URL: databaseUrl,
    WEB_ACCESS_TOKEN: webToken,
    AGENT_ACCESS_TOKEN: agentToken,
    EDGE_GATEWAY_TOKEN: gatewayToken,
  };
  apiProcess = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: backend,
    env: apiEnv,
    stdio: "ignore",
    windowsHide: true,
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) throw new Error("The local FastAPI process stopped during startup");
    try {
      const response = await nativeFetch(new URL("/api/health", apiOrigin), {
        headers: { "X-Tasklutein-Gateway": gatewayToken },
      });
      if (response.status === 200) return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  apiProcess.kill();
  throw new Error("The local FastAPI process did not become ready within 10 seconds");
});

afterAll(async () => {
  if (apiProcess && apiProcess.exitCode === null) {
    const exited = new Promise<void>((resolveExit) => apiProcess?.once("exit", () => resolveExit()));
    apiProcess.kill();
    await Promise.race([exited, new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3000))]);
  }
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(path, { force: true });
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EBUSY" || attempt === 20) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
  }
});

beforeEach(async () => {
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const localUrl = typeof input === "string" && input.startsWith("/") ? new URL(input, apiOrigin) : input;
    const headers = new Headers(init?.headers);
    headers.set("X-Tasklutein-Gateway", gatewayToken);
    return nativeFetch(localUrl, { ...init, headers });
  });
  const response = await nativeFetch(new URL("/api/tasks?limit=200", apiOrigin), {
    headers: { Authorization: "Bearer " + webToken, "X-Tasklutein-Gateway": gatewayToken },
  });
  if (!response.ok) throw new Error("Could not reset the isolated browser-test workspace");
  const page = await response.json() as { tasks: Array<{ id: string }> };
  for (const task of page.tasks) {
    const deleted = await nativeFetch(new URL("/api/tasks/" + task.id, apiOrigin), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + webToken, "X-Tasklutein-Gateway": gatewayToken },
    });
    if (deleted.status !== 204) throw new Error("Could not clear an isolated browser-test task");
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function enterWorkspace() {
  render(createElement(App));
  fireEvent.change(screen.getByLabelText("工作空间访问令牌"), { target: { value: webToken } });
  fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await screen.findByRole("heading", { name: "Overview" });
}

describe("Tasklutein browser workflow over the real FastAPI HTTP API", () => {
  it("creates, searches, updates, reports, and refreshes real API data", async () => {
    await enterWorkspace();
    const title = `E2E Release 50%_literal ${Date.now()}`;

    fireEvent.click(screen.getAllByRole("link", { name: "任务" })[0]);
    await screen.findByRole("heading", { name: "任务" });
    fireEvent.change(screen.getByLabelText("新任务标题"), { target: { value: title } });
    fireEvent.change(screen.getByLabelText("新任务说明"), { target: { value: "Created through the browser and FastAPI." } });
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    await screen.findByRole("heading", { name: title });

    fireEvent.change(screen.getByLabelText("任务状态"), { target: { value: "in_progress" } });
    await waitFor(() => expect((screen.getByLabelText("任务状态") as HTMLSelectElement).value).toBe("in_progress"));

    fireEvent.change(screen.getByLabelText("工作汇报内容"), {
      target: { value: "Browser report saved through the FastAPI report endpoint." },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加汇报" }));
    await screen.findByText("Browser report saved through the FastAPI report endpoint.");

    fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));
    await screen.findByText(title);
    await screen.findByText("Browser report saved through the FastAPI report endpoint.");

    const tasksResponse = await nativeFetch(new URL("/api/tasks?q=" + encodeURIComponent(title), apiOrigin), {
      headers: { Authorization: "Bearer " + webToken, "X-Tasklutein-Gateway": gatewayToken },
    });
    const tasks = await tasksResponse.json() as { total: number; tasks: Array<{ status: string; title: string }> };
    expect(tasks.total).toBe(1);
    expect(tasks.tasks[0]).toMatchObject({ title, status: "in_progress" });

    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(sessionStorage.getItem("tasklutein_token")).toBeNull();
    expect(await screen.findByLabelText("工作空间访问令牌")).toBeTruthy();
  });

  it("preserves task filters in the URL and filters through the backend", async () => {
    await enterWorkspace();
    const title = `E2E Search 50%_exact ${Date.now()}`;
    const response = await nativeFetch(new URL("/api/tasks", apiOrigin), {
      method: "POST",
        headers: {
          Authorization: "Bearer " + webToken,
          "X-Tasklutein-Gateway": gatewayToken,
          "Content-Type": "application/json",
        },
      body: JSON.stringify({ title, status: "done" }),
    });
    expect(response.status).toBe(201);

    fireEvent.click(screen.getAllByRole("link", { name: "任务" })[0]);
    await screen.findByRole("heading", { name: "任务" });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索任务" }), { target: { value: "50%_exact" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await screen.findByText(title);

    fireEvent.change(screen.getByLabelText("按任务状态筛选"), { target: { value: "done" } });
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("status")).toBe("done"));
    expect(new URL(window.location.href).searchParams.get("q")).toBe("50%_exact");
    expect(screen.getByText(title)).toBeTruthy();
    expect(within(screen.getByLabelText("任务状态")).queryByText("done")).toBeNull();
  });

  it("opens the next backend page through the URL controls", async () => {
    await enterWorkspace();
    const marker = `E2E Pagination ${Date.now()}`;
    for (let index = 0; index < 26; index += 1) {
      const response = await nativeFetch(new URL("/api/tasks", apiOrigin), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + webToken,
          "X-Tasklutein-Gateway": gatewayToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: `${marker} ${index}` }),
      });
      expect(response.status).toBe(201);
    }

    const pageResponse = await nativeFetch(new URL("/api/tasks?limit=25&offset=25", apiOrigin), {
      headers: { Authorization: "Bearer " + webToken, "X-Tasklutein-Gateway": gatewayToken },
    });
    const page = await pageResponse.json() as { tasks: Array<{ title: string }>; total: number };
    expect(page.total).toBe(26);

    fireEvent.click(screen.getAllByRole("link", { name: "任务" })[0]);
    await screen.findByText("共 26 项");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText(page.tasks[0].title);
    expect(new URL(window.location.href).searchParams.get("offset")).toBe("25");
    expect(screen.getByRole("button", { name: "上一页" }).hasAttribute("disabled")).toBe(false);
  });

  it("shares the same FastAPI data and attribution through real HTTP MCP tools", async () => {
    await enterWorkspace();
    const mcpPort = await freePort();
    const mcpServer = createHttpMcpServer({ apiBase: apiOrigin, agentToken, gatewayToken });
    await new Promise<void>((resolveListen, rejectListen) => {
      mcpServer.once("error", rejectListen);
      mcpServer.listen(mcpPort, "127.0.0.1", resolveListen);
    });

    const client = new Client({ name: "tasklutein-browser-integration", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer " + agentToken,
          "X-Tasklutein-Gateway": gatewayToken,
          "X-Request-ID": randomUUID(),
        },
      },
    });

    const responseData = (result: Awaited<ReturnType<typeof client.callTool>>) => {
      const blocks: unknown = result.content;
      if (!Array.isArray(blocks)) throw new Error("MCP response has no content blocks");
      const textBlock = blocks.find((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null &&
        "type" in part && part.type === "text" &&
        "text" in part && typeof part.text === "string");
      if (!textBlock) throw new Error("MCP response has no text content");
      return JSON.parse(textBlock.text) as Record<string, unknown>;
    };

    try {
      await client.connect(transport);
      const title = `E2E MCP shared task ${Date.now()}`;
      const created = await client.callTool({ name: "create_task", arguments: { title } });
      expect(created.isError).not.toBe(true);
      const createdValue = responseData(created) as { task: { id: string; title: string } };
      expect(createdValue.task.title).toBe(title);

      const userReport = await nativeFetch(new URL(`/api/tasks/${createdValue.task.id}/reports`, apiOrigin), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + webToken,
          "X-Tasklutein-Gateway": gatewayToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Written through FastAPI with the Web credential." }),
      });
      expect(userReport.status).toBe(201);

      const agentReport = await client.callTool({
        name: "add_report",
        arguments: { task_id: createdValue.task.id, content: "Written through MCP with the Agent credential." },
      });
      expect(agentReport.isError).not.toBe(true);

      const reports = await client.callTool({
        name: "list_reports",
        arguments: { task_id: createdValue.task.id, limit: 10, offset: 0 },
      });
      expect(responseData(reports)).toMatchObject({
        total: 2,
        reports: [
          { source: "agent", content: "Written through MCP with the Agent credential." },
          { source: "user", content: "Written through FastAPI with the Web credential." },
        ],
      });

      const sharedTasks = await client.callTool({ name: "list_tasks", arguments: { q: title, limit: 5, offset: 0 } });
      expect(responseData(sharedTasks)).toMatchObject({ total: 1, tasks: [{ id: createdValue.task.id, title }] });
    } finally {
      await client.close();
      await new Promise<void>((resolveClose, rejectClose) => mcpServer.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  });

  it("clears an expired session when the authenticated backend returns 401", async () => {
    sessionStorage.setItem("tasklutein_token", "expired-local-token");
    render(createElement(App));
    await screen.findByLabelText("工作空间访问令牌");
    expect(sessionStorage.getItem("tasklutein_token")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("令牌已失效");
  });
});
