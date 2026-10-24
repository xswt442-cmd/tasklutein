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
import { api, ApiError, setApiWorkspaceId } from "../apps/web/src/api";
import { createHttpMcpServer } from "../apps/mcp/src/http";

const root = process.cwd();
const backend = join(root, "apps", "api");
const testIssuer = "https://access.example.test";
const testSubject = "browser-integration-user";
const testEmail = "browser-integration@example.test";
const gatewayToken = "gateway-browser-integration-token-" + "g".repeat(40);
const databaseDirectory = join(root, "node_modules", ".cache", "tasklutein", "web-test");
const databasePath = join(databaseDirectory, `.web-e2e-${process.pid}.sqlite3`);
const databaseUrl = "sqlite+pysqlite:///" + databasePath.replaceAll("\\", "/");
const pythonFromVirtualEnv = join(root, ".venv", "Scripts", "python.exe");
const python = process.env.TASKLUTEIN_TEST_PYTHON ?? (existsSync(pythonFromVirtualEnv) ? pythonFromVirtualEnv : "python");
const nativeFetch = globalThis.fetch.bind(globalThis);

let apiOrigin = "";
let apiProcess: ChildProcess | undefined;
let browserRequests: Array<{ url: string; method: string; headers: Headers }> = [];
let unavailableWorkspaceId: string | null = null;

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
  window.history.replaceState({}, "", "/");
  setApiWorkspaceId(null);
  unavailableWorkspaceId = null;
  browserRequests = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const localUrl = typeof input === "string" && input.startsWith("/") ? new URL(input, apiOrigin) : input;
    const headers = new Headers(init?.headers);
    headers.set("X-Tasklutein-Gateway", gatewayToken);
    headers.set("X-Tasklutein-Access-Issuer", testIssuer);
    headers.set("X-Tasklutein-Access-Subject", testSubject);
    headers.set("X-Tasklutein-Access-Email", testEmail);
    headers.set("Origin", "http://localhost:5173");
    browserRequests.push({ url: String(localUrl), method: init?.method ?? "GET", headers });
    const requestUrl = new URL(String(localUrl), apiOrigin);
    if (unavailableWorkspaceId && requestUrl.pathname === "/api/workspaces" && headers.get("X-Tasklutein-Workspace-ID") === unavailableWorkspaceId) {
      return Promise.resolve(new Response(JSON.stringify({ detail: "workspace_not_found", code: "workspace_not_found" }), {
        status: 404, headers: { "Content-Type": "application/json" },
      }));
    }
    return nativeFetch(localUrl, { ...init, headers });
  });
  const bootstrap = await nativeFetch(new URL("/api/session/bootstrap", apiOrigin), {
    method: "POST", headers: { ...testHeaders(), "Content-Type": "application/json" }, body: "{}",
  });
  if (!bootstrap.ok) throw new Error("Could not bootstrap the isolated browser-test user");
  const response = await nativeFetch(new URL("/api/tasks?limit=200", apiOrigin), {
    headers: testHeaders(),
  });
  if (!response.ok) throw new Error("Could not reset the isolated browser-test workspace");
  const page = await response.json() as { tasks: Array<{ id: string }> };
  for (const task of page.tasks) {
    const deleted = await nativeFetch(new URL("/api/tasks/" + task.id, apiOrigin), {
      method: "DELETE",
      headers: testHeaders(),
    });
    if (deleted.status !== 204) throw new Error("Could not clear an isolated browser-test task");
  }
  const archivedResponse = await nativeFetch(new URL("/api/history/tasks?limit=200&offset=0", apiOrigin), {
    headers: testHeaders(),
  });
  if (!archivedResponse.ok) {
    const error = await archivedResponse.json().catch(() => ({})) as { code?: unknown };
    throw new Error(`Could not reset archived tasks in the isolated browser-test workspace: HTTP ${archivedResponse.status}${typeof error.code === "string" ? ` (${error.code})` : ""}`);
  }
  const archivedPage = await archivedResponse.json() as { tasks: Array<{ id: string }> };
  for (const task of archivedPage.tasks) {
    const deleted = await nativeFetch(new URL("/api/history/tasks/" + task.id, apiOrigin), {
      method: "DELETE",
      headers: testHeaders(),
    });
    if (deleted.status !== 204) throw new Error("Could not clear an isolated archived browser-test task");
  }
  const activityResponse = await nativeFetch(new URL("/api/activity?limit=100&offset=0", apiOrigin), { headers: testHeaders() });
  if (!activityResponse.ok) throw new Error(`Could not reset browser-test activity: HTTP ${activityResponse.status}`);
  const activityPage = await activityResponse.json() as { activities: Array<{ id: string }> };
  for (const activity of activityPage.activities) {
    const deleted = await nativeFetch(new URL("/api/activity/" + activity.id, apiOrigin), {
      method: "DELETE",
      headers: testHeaders(),
    });
    if (deleted.status !== 204) throw new Error("Could not clear an isolated browser-test activity");
  }
});

afterEach(() => {
  cleanup();
  setApiWorkspaceId(null);
  unavailableWorkspaceId = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function enterWorkspace() {
  render(createElement(App));
  await screen.findByRole("heading", { name: "Overview" });
}

function testHeaders(subject = testSubject, email = testEmail) {
  return {
    "X-Tasklutein-Gateway": gatewayToken,
    "X-Tasklutein-Access-Issuer": testIssuer,
    "X-Tasklutein-Access-Subject": subject,
    "X-Tasklutein-Access-Email": email,
    Origin: "http://localhost:5173",
  };
}

describe("Tasklutein browser workflow over the real FastAPI HTTP API", () => {
  it("creates a team, sends a registered-user invitation, and accepts it", async () => {
    const memberHeaders = testHeaders("web-team-member", "web-team-member@example.test");
    const memberBootstrap = await nativeFetch(new URL("/api/session/bootstrap", apiOrigin), {
      method: "POST", headers: { ...memberHeaders, "Content-Type": "application/json" }, body: "{}",
    });
    expect(memberBootstrap.status).toBe(200);

    await enterWorkspace();
    fireEvent.click(screen.getAllByRole("link", { name: "团队" })[0]!);
    await screen.findByRole("heading", { name: "工作区与团队" });
    const teamName = `Browser team ${Date.now()}`;
    fireEvent.change(screen.getByLabelText("团队名称"), { target: { value: teamName } });
    fireEvent.click(screen.getByRole("button", { name: "创建团队" }));
    await screen.findByText(`${teamName} 成员`);

    expect(screen.getAllByRole("option").some((option) => option.textContent?.includes(teamName))).toBe(true);
    const membersRequest = browserRequests.find(({ url, method }) =>
      method === "GET" && /\/api\/workspaces\/[^/]+\/members$/.test(new URL(url).pathname),
    );
    expect(membersRequest).toBeDefined();
    const workspaceId = new URL(membersRequest!.url).pathname.split("/")[3]!;
    fireEvent.change(screen.getByLabelText("受邀用户邮箱"), { target: { value: "web-team-member@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "发送邀请" }));

    let invitations: { invitations: Array<{ id: string; status: string }> } | undefined;
    await waitFor(async () => {
      const response = await nativeFetch(new URL(`/api/workspaces/${workspaceId}/invitations`, apiOrigin), {
        headers: testHeaders(),
      });
      expect(response.status).toBe(200);
      invitations = await response.json() as typeof invitations;
      expect(invitations?.invitations).toHaveLength(1);
    });
    const invitation = invitations?.invitations[0];
    expect(invitation).toBeDefined();
    const accepted = await nativeFetch(new URL(`/api/invitations/${invitation?.id}/accept`, apiOrigin), {
      method: "POST", headers: memberHeaders,
    });
    expect(accepted.status).toBe(200);
    const members = await nativeFetch(new URL(`/api/workspaces/${workspaceId}/members`, apiOrigin), {
      headers: memberHeaders,
    });
    const memberList = await members.json() as { members: Array<{ user_id: string; email: string; role: string }> };
    expect(memberList.members)
      .toContainEqual(expect.objectContaining({ email: "web-team-member@example.test", role: "member" }));
    expect(browserRequests.some(({ url, method, headers }) =>
      method === "POST" && url.endsWith(`/api/workspaces/${workspaceId}/invitations`) &&
      headers.get("X-Tasklutein-Workspace-ID") === workspaceId,
    )).toBe(true);

    const personalWorkspacesResponse = await nativeFetch(new URL("/api/workspaces", apiOrigin), { headers: testHeaders() });
    const personalWorkspaceId = (await personalWorkspacesResponse.json() as { current_workspace_id: string }).current_workspace_id;
    fireEvent.change(screen.getByLabelText("切换工作区"), { target: { value: workspaceId } });
    await waitFor(() => expect((document.getElementById("workspace-select") as unknown as { value: string }).value).toBe(workspaceId));
    fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));
    fireEvent.click(screen.getAllByRole("link", { name: "任务" })[0]!);
    await screen.findByRole("heading", { name: "任务" });
    const memberId = memberList.members.find((member) => member.email === "web-team-member@example.test")!.user_id;
    await screen.findByRole("option", { name: "web-team-member@example.test" });
    fireEvent.change(screen.getByLabelText("按负责人筛选"), { target: { value: memberId } });
    expect((screen.getByLabelText("按负责人筛选") as unknown as { value: string }).value).toBe(memberId);
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("assignee")).toBe(memberId));
    fireEvent.change(screen.getByLabelText("切换工作区"), { target: { value: personalWorkspaceId } });
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("assignee")).toBeNull());

    unavailableWorkspaceId = workspaceId;
    fireEvent.change(screen.getByLabelText("切换工作区"), { target: { value: workspaceId } });
    await waitFor(() => expect((document.getElementById("workspace-select") as unknown as { value: string }).value).toBe(workspaceId));
    const workspaceListRequestCount = browserRequests.filter(({ url, method }) => method === "GET" && new URL(url).pathname === "/api/workspaces").length;
    const refreshButton = screen.getByRole("button", { name: "刷新数据" });
    await waitFor(() => expect(refreshButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(refreshButton);
    await waitFor(() => expect((document.getElementById("workspace-select") as unknown as { value: string }).value).toBe(personalWorkspaceId));
    const workspaceListRequests = browserRequests.filter(({ url, method }) => method === "GET" && new URL(url).pathname === "/api/workspaces");
    expect(workspaceListRequests.length).toBeGreaterThan(workspaceListRequestCount);
    expect(workspaceListRequests.at(-1)?.headers.get("X-Tasklutein-Workspace-ID")).toBe(personalWorkspaceId);
    expect((document.getElementById("workspace-select") as unknown as { value: string }).value).toBe(personalWorkspaceId);
  }, 15_000);

  it("creates, searches, updates, reports, and refreshes real API data", async () => {
    await enterWorkspace();
    const title = `E2E Release 50%_literal ${Date.now()}`;

    fireEvent.click(screen.getAllByRole("link", { name: "任务" })[0]);
    await screen.findByRole("heading", { name: "任务" });
    fireEvent.change(screen.getByLabelText("新任务标题"), { target: { value: title } });
    fireEvent.change(screen.getByLabelText("新任务说明"), { target: { value: "Created through the browser and FastAPI." } });
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    await screen.findByRole("heading", { name: title });

    expect(screen.getByLabelText("负责人").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const draftDescription = "Local draft preserved after a concurrent update.";
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: draftDescription } });
    const currentTaskResponse = await nativeFetch(new URL("/api/tasks?q=" + encodeURIComponent(title), apiOrigin), { headers: testHeaders() });
    const currentTask = (await currentTaskResponse.json() as { tasks: Array<{ id: string; version: number }> }).tasks[0]!;
    const concurrentUpdate = await nativeFetch(new URL(`/api/tasks/${currentTask.id}`, apiOrigin), {
      method: "PATCH",
      headers: { ...testHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Concurrent server update.", expected_version: currentTask.version }),
    });
    expect(concurrentUpdate.status).toBe(200);
    const detailRequestCount = browserRequests.filter(({ url, method }) => method === "GET" && url.includes(`/api/tasks/${currentTask.id}`)).length;
    fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));
    await waitFor(() => expect(browserRequests.filter(({ url, method }) => method === "GET" && url.includes(`/api/tasks/${currentTask.id}`)).length).toBeGreaterThan(detailRequestCount));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/服务器当前版本为 v\d+/);
    expect((screen.getByLabelText("说明") as HTMLTextAreaElement).value).toBe(draftDescription);
    fireEvent.click(screen.getByRole("button", { name: "保留草稿并基于最新版本重新确认" }));
    expect((screen.getByLabelText("说明") as HTMLTextAreaElement).value).toBe(draftDescription);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(async () => {
      const updated = await nativeFetch(new URL(`/api/tasks/${currentTask.id}`, apiOrigin), { headers: testHeaders() });
      expect((await updated.json() as { task: { description: string } }).task.description).toBe(draftDescription);
    });

    fireEvent.change(screen.getByLabelText("任务状态"), { target: { value: "in_progress" } });
    await waitFor(async () => {
      const statusResponse = await nativeFetch(
        new URL("/api/tasks?q=" + encodeURIComponent(title), apiOrigin),
        { headers: testHeaders() },
      );
      const statusPage = await statusResponse.json() as { tasks: Array<{ status: string }> };
      expect(statusPage.tasks[0]?.status).toBe("in_progress");
    });

    fireEvent.change(screen.getByLabelText("工作汇报内容"), {
      target: { value: "Browser report saved through the FastAPI report endpoint." },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加汇报" }));
    await screen.findByText("Browser report saved through the FastAPI report endpoint.");
    const createdTaskResponse = await nativeFetch(new URL("/api/tasks?q=" + encodeURIComponent(title), apiOrigin), { headers: testHeaders() });
    const createdTask = (await createdTaskResponse.json() as { tasks: Array<{ id: string }> }).tasks[0];
    const reportResponse = await nativeFetch(new URL(`/api/tasks/${createdTask.id}/reports`, apiOrigin), { headers: testHeaders() });
    const report = (await reportResponse.json() as { reports: Array<{ id: string }> }).reports[0];
    expect(browserRequests.some(({ method, url }) => method === "GET" && url.includes(`/api/reports/${report.id}/comments`))).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "查看评论" }));
    await screen.findByLabelText("添加评论");
    await screen.findByText("还没有评论。");
    expect(browserRequests.some(({ method, url }) => method === "GET" && url.includes(`/api/reports/${report.id}/comments`))).toBe(true);
    fireEvent.change(screen.getByLabelText("添加评论"), { target: { value: "Comment created in the browser" } });
    fireEvent.click(screen.getByRole("button", { name: "评论" }));
    await screen.findByText("Comment created in the browser");
    for (let index = 0; index < 25; index += 1) {
      const response = await nativeFetch(new URL(`/api/reports/${report.id}/comments`, apiOrigin), {
        method: "POST", headers: { ...testHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ content: `Comment page ${index}` }),
      });
      expect(response.status).toBe(201);
    }
    fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));
    await screen.findByRole("button", { name: "下一页评论" });
    fireEvent.click(screen.getByRole("button", { name: "下一页评论" }));
    await screen.findByText("Comment page 24");
    const confirmCommentDelete = vi.spyOn(window, "confirm").mockReturnValue(true);
    const firstComment = screen.getByText("Comment page 24").closest(".rounded-lg");
    if (!(firstComment instanceof HTMLElement)) throw new Error("The paginated comment container was missing");
    fireEvent.click(within(firstComment).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(browserRequests.some(({ method, url }) => method === "DELETE" && url.includes(`/api/reports/${report.id}/comments/`))).toBe(true));
    await screen.findByText("Comment page 23");
    await waitFor(() => expect(screen.queryByText("Comment page 24")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));
    await screen.findByText(title);
    await screen.findByText("Browser report saved through the FastAPI report endpoint.");

    const tasksResponse = await nativeFetch(new URL("/api/tasks?q=" + encodeURIComponent(title), apiOrigin), {
      headers: testHeaders(),
    });
    const tasks = await tasksResponse.json() as { total: number; tasks: Array<{ status: string; title: string }> };
    expect(tasks.total).toBe(1);
    expect(tasks.tasks[0]).toMatchObject({ title, status: "in_progress" });

    expect(browserRequests.some(({ url }) => url.endsWith("/api/session/bootstrap"))).toBe(true);
    expect(browserRequests.some(({ url }) => url.endsWith("/api/me"))).toBe(false);
    expect(browserRequests.every(({ headers }) => !headers.has("Authorization"))).toBe(true);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  }, 20_000);

  it("returns to a valid Inbox page after items disappear from the current page", async () => {
    const userResponse = await nativeFetch(new URL("/api/me", apiOrigin), { headers: testHeaders() });
    const userId = (await userResponse.json() as { user: { id: string } }).user.id;
    const taskIds: Array<{ id: string; version: number }> = [];
    for (let index = 0; index < 26; index += 1) {
      const created = await nativeFetch(new URL("/api/tasks", apiOrigin), {
        method: "POST",
        headers: { ...testHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Inbox pagination ${Date.now()} ${index}` }),
      });
      expect(created.status).toBe(201);
      const task = (await created.json() as { task: { id: string; version: number } }).task;
      const assigned = await nativeFetch(new URL(`/api/tasks/${task.id}`, apiOrigin), {
        method: "PATCH",
        headers: { ...testHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ assignee_user_id: userId, expected_version: task.version }),
      });
      expect(assigned.status).toBe(200);
      taskIds.push(task);
    }

    await enterWorkspace();
    fireEvent.click(screen.getAllByRole("link", { name: "待我处理" })[0]!);
    await screen.findByRole("heading", { name: "分配给我的任务 25" });
    fireEvent.click(screen.getByRole("button", { name: "下一页待处理事项" }));
    await screen.findByRole("heading", { name: "分配给我的任务 1" });

    const removedFromInbox = await nativeFetch(new URL(`/api/tasks/${taskIds[0]!.id}`, apiOrigin), {
      method: "PATCH",
      headers: { ...testHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ assignee_user_id: null, expected_version: taskIds[0]!.version + 1 }),
    });
    expect(removedFromInbox.status).toBe(200);
    fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));
    await screen.findByRole("heading", { name: "分配给我的任务 25" });
    expect(screen.queryByText("这一页没有分配给你的任务。")).toBeNull();
  }, 20_000);

  it("shows a public guest preview without loading workspace data or running business operations", async () => {
    const guestFetch = vi.fn().mockResolvedValue({ type: "opaqueredirect", status: 0, ok: false } as Response);
    vi.stubGlobal("fetch", guestFetch);
    render(createElement(App));

    await screen.findByText("游客模式");
    expect(screen.getByRole("heading", { name: "任务与工作汇报" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "登录" }).getAttribute("href")).toBe("/api/session/login");
    expect(screen.getAllByText("任务").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "任务" })).toBeNull();
    expect(guestFetch).toHaveBeenCalledTimes(1);
    expect(guestFetch.mock.calls[0]?.[0]).toBe("/api/session/bootstrap");
    expect(guestFetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
  });

  it("archives a task through the UI and reads its complete report history from the real API", async () => {
    await enterWorkspace();
    const actorNameCountBeforeReport = screen.queryAllByText(testEmail).length;
    const title = `E2E Archive ${Date.now()}`;
    const description = "This archived description remains available as a read-only snapshot.";
    const initialReport = `Oldest archived report ${Date.now()}`;

    fireEvent.click(screen.getAllByRole("link", { name: "任务" })[0]);
    await screen.findByRole("heading", { name: "任务" });
    fireEvent.change(screen.getByLabelText("新任务标题"), { target: { value: title } });
    fireEvent.change(screen.getByLabelText("新任务说明"), { target: { value: description } });
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    await screen.findByRole("heading", { name: title });

    fireEvent.change(screen.getByLabelText("工作汇报内容"), { target: { value: initialReport } });
    fireEvent.click(screen.getByRole("button", { name: "添加汇报" }));
    await screen.findByText(initialReport);
    const taskBeforeArchiveResponse = await nativeFetch(new URL("/api/tasks?q=" + encodeURIComponent(title), apiOrigin), { headers: testHeaders() });
    const taskBeforeArchive = (await taskBeforeArchiveResponse.json() as { tasks: Array<{ id: string }> }).tasks[0];
    await waitFor(() => expect(screen.getAllByText(testEmail)).toHaveLength(actorNameCountBeforeReport + 1));
    const currentTaskResponse = await nativeFetch(new URL("/api/tasks?q=" + encodeURIComponent(title), apiOrigin), {
      headers: testHeaders(),
    });
    const currentTaskPage = await currentTaskResponse.json() as { tasks: Array<{ id: string }> };
    const taskId = currentTaskPage.tasks[0]?.id;
    if (!taskId) throw new Error("The UI-created task was missing from the current task API");
    let newestReportId = "";
    for (let index = 0; index < 25; index += 1) {
      const report = await nativeFetch(new URL(`/api/tasks/${taskId}/reports`, apiOrigin), {
        method: "POST",
        headers: { ...testHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ content: `Archive report page ${index}` }),
      });
      expect(report.status).toBe(201);
      newestReportId = (await report.json() as { report: { id: string } }).report.id;
    }
    const archivedComment = await nativeFetch(new URL(`/api/reports/${newestReportId}/comments`, apiOrigin), {
      method: "POST", headers: { ...testHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ content: "Archived comment remains readable" }),
    });
    expect(archivedComment.status).toBe(201);

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
    fireEvent.click(screen.getByRole("button", { name: "删除任务（保留历史，推荐）" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("任务字段、全部工作汇报和活动会保存到历史页面"));
    await screen.findByText("归档任务 · 只读");
    await screen.findByText("共 26 条");
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getAllByText(testEmail)).toHaveLength(actorNameCountBeforeReport + 25);
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "添加汇报" })).toBeNull();
    expect(screen.queryByRole("button", { name: "评论" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(browserRequests.some(({ method, url }) => method === "GET" && url.includes(`/api/reports/${newestReportId}/comments`))).toBe(false);
    fireEvent.click((await screen.findAllByRole("button", { name: "查看评论" }))[0]!);
    await screen.findByText("Archived comment remains readable");
    expect(browserRequests.some(({ method, url }) => method === "GET" && url.includes(`/api/reports/${newestReportId}/comments`))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "下一页汇报" }));
    await screen.findByText(initialReport);
    expect(screen.getAllByText(testEmail)).toHaveLength(actorNameCountBeforeReport + 1);
    const archivedTask = await nativeFetch(new URL(`/api/history/tasks/${taskId}`, apiOrigin), { headers: testHeaders() });
    expect(archivedTask.status).toBe(200);
    const archivedValue = await archivedTask.json() as { task: { archived_at: string; title: string } };
    expect(archivedValue.task).toMatchObject({ title, archived_at: expect.any(String) });
    const currentTasks = await nativeFetch(new URL("/api/tasks?q=" + encodeURIComponent(title), apiOrigin), { headers: testHeaders() });
    expect((await currentTasks.json() as { total: number }).total).toBe(0);

    fireEvent.click(screen.getAllByRole("link", { name: "历史" })[0]);
    await screen.findByRole("heading", { name: "历史" });
    fireEvent.click(screen.getByRole("button", { name: "活动记录" }));
    await screen.findAllByText("归档任务");
    expect(browserRequests.some(({ url, method }) => method === "DELETE" && url.includes(`/api/tasks/${taskId}?history=keep`))).toBe(true);
    expect(browserRequests.some(({ url }) => url.includes(`/api/history/tasks/${taskId}/reports?limit=25`))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "归档任务" }));
    fireEvent.click(await screen.findByRole("link", { name: new RegExp(title) }));
    await screen.findByText("归档任务 · 只读");
    fireEvent.click(screen.getByRole("button", { name: "清除归档及全部历史" }));
    await screen.findByText("还没有归档任务。");
    expect(confirm).toHaveBeenCalledTimes(3);
    const removedArchive = await nativeFetch(new URL(`/api/history/tasks/${taskId}`, apiOrigin), { headers: testHeaders() });
    expect(removedArchive.status).toBe(404);
    const removedActivities = await nativeFetch(new URL(`/api/activity?task_id=${taskId}`, apiOrigin), { headers: testHeaders() });
    expect((await removedActivities.json() as { total: number }).total).toBe(0);
    expect(browserRequests.some(({ url, method }) => method === "DELETE" && url.endsWith(`/api/history/tasks/${taskId}`))).toBe(true);
  }, 15_000);

  it("filters and deletes one real activity, then clears current task history while keeping the task", async () => {
    await enterWorkspace();
    const title = `E2E Activity ${Date.now()}`;
    const created = await nativeFetch(new URL("/api/tasks", apiOrigin), {
      method: "POST",
      headers: { ...testHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: "Current task retained after its report history is cleared." }),
    });
    expect(created.status).toBe(201);
    const createdTask = await created.json() as { task: { id: string } };
    const taskId = createdTask.task.id;
    const report = await nativeFetch(new URL(`/api/tasks/${taskId}/reports`, apiOrigin), {
      method: "POST",
      headers: { ...testHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "This report is cleared with task history." }),
    });
    expect(report.status).toBe(201);

    fireEvent.click(screen.getAllByRole("link", { name: "历史" })[0]);
    await screen.findByRole("heading", { name: "历史" });
    fireEvent.click(screen.getByRole("button", { name: "活动记录" }));
    await screen.findByText("新增工作汇报");
    fireEvent.change(screen.getByLabelText("按活动类型筛选"), { target: { value: "report.created" } });
    fireEvent.change(screen.getByLabelText("按来源筛选"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("任务 ID"), { target: { value: taskId } });
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    await screen.findByText(title);
    expect(screen.getAllByText("新增工作汇报").length).toBeGreaterThan(1);
    expect(screen.getByText(title)).toBeTruthy();

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除此活动" }));
    await screen.findByText("没有符合条件的活动记录。");
    expect(confirm).toHaveBeenCalledWith("只删除这条活动记录？任务和工作汇报会保留。");
    const reportsAfterSingleDelete = await nativeFetch(new URL(`/api/tasks/${taskId}/reports`, apiOrigin), { headers: testHeaders() });
    expect((await reportsAfterSingleDelete.json() as { total: number }).total).toBe(1);

    fireEvent.change(screen.getByLabelText("按活动类型筛选"), { target: { value: "" } });
    fireEvent.click(await screen.findByRole("button", { name: "清除任务全部历史" }));
    await screen.findByText("没有符合条件的活动记录。");
    expect(confirm).toHaveBeenCalledTimes(3);
    const retainedTask = await nativeFetch(new URL(`/api/tasks/${taskId}`, apiOrigin), { headers: testHeaders() });
    expect(retainedTask.status).toBe(200);
    const reportsAfterClear = await nativeFetch(new URL(`/api/tasks/${taskId}/reports`, apiOrigin), { headers: testHeaders() });
    expect((await reportsAfterClear.json() as { total: number }).total).toBe(0);
    const activitiesAfterClear = await nativeFetch(new URL(`/api/activity?task_id=${taskId}`, apiOrigin), { headers: testHeaders() });
    expect((await activitiesAfterClear.json() as { total: number }).total).toBe(0);
    expect(browserRequests.some(({ url }) => url.endsWith(`/api/activity?limit=25&offset=0&event_type=report.created&source=user&task_id=${taskId}`))).toBe(true);
    expect(browserRequests.some(({ url, method }) => method === "DELETE" && url.endsWith(`/api/history/tasks/${taskId}`))).toBe(true);
  });

  it("permanently deletes a current task and its history through the explicit UI option", async () => {
    await enterWorkspace();
    const title = `E2E Permanent delete ${Date.now()}`;
    fireEvent.click(screen.getAllByRole("link", { name: "任务" })[0]);
    await screen.findByRole("heading", { name: "任务" });
    fireEvent.change(screen.getByLabelText("新任务标题"), { target: { value: title } });
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    await screen.findByRole("heading", { name: title });
    const currentTaskResponse = await nativeFetch(new URL("/api/tasks?q=" + encodeURIComponent(title), apiOrigin), { headers: testHeaders() });
    const taskPage = await currentTaskResponse.json() as { tasks: Array<{ id: string }> };
    const taskId = taskPage.tasks[0]?.id;
    if (!taskId) throw new Error("The UI-created task was missing from the current task API");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
    fireEvent.click(screen.getByRole("button", { name: "删除任务及历史记录" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("任务、全部工作汇报和活动会立即永久删除"));
    await screen.findByText("这里还没有任务。");
    const removedTask = await nativeFetch(new URL(`/api/tasks/${taskId}`, apiOrigin), { headers: testHeaders() });
    expect(removedTask.status).toBe(404);
    const removedArchive = await nativeFetch(new URL(`/api/history/tasks/${taskId}`, apiOrigin), { headers: testHeaders() });
    expect(removedArchive.status).toBe(404);
    const removedActivities = await nativeFetch(new URL(`/api/activity?task_id=${taskId}`, apiOrigin), { headers: testHeaders() });
    expect((await removedActivities.json() as { total: number }).total).toBe(0);
    expect(browserRequests.some(({ url, method }) => method === "DELETE" && url.includes(`/api/tasks/${taskId}?history=delete`))).toBe(true);
  });

  it("preserves task filters in the URL and filters through the backend", async () => {
    await enterWorkspace();
    const title = `E2E Search 50%_exact ${Date.now()}`;
    const response = await nativeFetch(new URL("/api/tasks", apiOrigin), {
      method: "POST",
        headers: { ...testHeaders(), "Content-Type": "application/json" },
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
        headers: { ...testHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${marker} ${index}` }),
      });
      expect(response.status).toBe(201);
    }

    const pageResponse = await nativeFetch(new URL("/api/tasks?limit=25&offset=25", apiOrigin), {
      headers: testHeaders(),
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

  it("creates, lists, displays once, edits, and permanently deletes a personal Agent key", async () => {
    await enterWorkspace();
    fireEvent.click(screen.getAllByRole("link", { name: "设置" })[0]);
    await screen.findByRole("heading", { name: "设置" });
    expect(screen.getAllByText(testEmail)).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Browser integration key" } });
    fireEvent.click(screen.getByRole("button", { name: "创建密钥" }));
    const onceMessage = await screen.findByText("密钥仅显示这一次");
    const secretMessage = onceMessage.parentElement;
    if (!secretMessage) throw new Error("The one-time key notice did not contain its secret value");
    expect(secretMessage.textContent).toContain("密钥仅显示这一次");
    const secret = secretMessage.querySelector("code")?.textContent;
    expect(secret).toBeTruthy();

    const listed = await nativeFetch(new URL("/api/agent-tokens", apiOrigin), { headers: testHeaders() });
    const listing = await listed.json() as { tokens: Array<{ id: string; name: string; prefix: string }> };
    expect(listing.tokens).toHaveLength(1);
    expect(listing.tokens[0].name).toBe("Browser integration key");
    const displayPrefix = secret?.slice(0, 7);
    expect(listing.tokens[0].prefix).toBe(displayPrefix);
    expect(JSON.stringify(listing)).not.toContain(secret);
    await screen.findByText(displayPrefix ?? "");

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(document.body.textContent).not.toContain(secret);

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("编辑密钥名称"), { target: { value: "Renamed browser key" } });
    const futureExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const localExpiry = new Date(futureExpiry.getTime() - futureExpiry.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    fireEvent.change(screen.getByLabelText("编辑密钥过期时间"), { target: { value: localExpiry } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("Renamed browser key");
    const editedTokens = await nativeFetch(new URL("/api/agent-tokens", apiOrigin), { headers: testHeaders() });
    const editedListing = await editedTokens.json() as { tokens: Array<{ id: string; name: string; prefix: string; expires_at: string | null }> };
    expect(editedListing.tokens[0]).toMatchObject({ id: listing.tokens[0].id, name: "Renamed browser key", prefix: displayPrefix });
    expect(editedListing.tokens[0].expires_at).toEqual(expect.any(String));
    expect(JSON.stringify(editedListing)).not.toContain(secret);

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("永久删除“Renamed browser key”"));
    await screen.findByText("尚未创建 Agent 密钥。");
    const deletedTokens = await nativeFetch(new URL("/api/agent-tokens", apiOrigin), { headers: testHeaders() });
    const deletedListing = await deletedTokens.json() as { tokens: Array<{ id: string }> };
    expect(deletedListing.tokens).toEqual([]);
  });

  it("shares the same FastAPI data and attribution through real HTTP MCP tools", async () => {
    await enterWorkspace();
    const mcpPort = await freePort();
    const createdKey = await nativeFetch(new URL("/api/agent-tokens", apiOrigin), {
      method: "POST",
      headers: { ...testHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "browser test MCP" }),
    });
    const keyResult = await createdKey.json() as { secret: string };
    if (createdKey.status !== 201) throw new Error("Could not create an isolated Agent key for MCP integration test");
    const agentToken = keyResult.secret;
    const mcpServer = createHttpMcpServer({
      apiBase: apiOrigin,
      gatewayToken,
      allowedOrigins: ["http://localhost:5173"],
    });
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
          Origin: `http://127.0.0.1:${mcpPort}`,
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
          ...testHeaders(),
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

  it("formats a real FastAPI validation error without exposing rejected input", async () => {
    await enterWorkspace();
    const error = await api("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "Valid title", source: "forged" }),
    }).then(
      () => { throw new Error("FastAPI accepted an unexpected task field"); },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: "validation_error" });
    expect((error as ApiError).message).toContain("body.source: Extra inputs are not permitted");
    expect((error as ApiError).message).not.toContain("forged");
  });

});
