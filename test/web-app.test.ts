// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import App from "../apps/web/src/App";
import { api, ApiError } from "../apps/web/src/api";
import type { Report, Task } from "../apps/web/src/api";

vi.mock("../apps/web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../apps/web/src/api")>("../apps/web/src/api");
  return { ...actual, api: vi.fn() };
});

const apiMock = vi.mocked(api);
const baseTask: Task = {
  id: "task-1",
  title: "Original title",
  description: "Original description",
  status: "todo",
  created_at: "2026-10-15T00:00:00Z",
  updated_at: "2026-10-15T00:00:00Z",
};

function installApiMock(options: {
  reports?: Report[];
  onPatch?: (body: Record<string, unknown>) => Promise<unknown> | unknown;
} = {}) {
  const reports = options.reports ?? [];
  apiMock.mockImplementation(async (_token, path, request) => {
    if (path === "/tasks" && request?.method === "POST") {
      return { task: { ...baseTask, title: JSON.parse(String(request.body)).title } } as never;
    }
    if (path === "/tasks" && request?.method !== "PATCH") {
      return { tasks: [{ ...baseTask }] } as never;
    }
    if (path === "/tasks/task-1/reports" && request?.method === "POST") {
      return { report: { id: "report-created", task_id: "task-1", content: "saved", source: "user", created_at: "2026-10-15T01:00:00Z" } } as never;
    }
    if (path === "/tasks/task-1/reports") {
      return { reports: [...reports] } as never;
    }
    if (path === "/tasks/task-1" && request?.method === "PATCH") {
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      return (await options.onPatch?.(body)) as never;
    }
    throw new Error(`Unexpected API call: ${request?.method ?? "GET"} ${path}`);
  });
}

async function enterWorkspace() {
  render(createElement(App));
  fireEvent.change(screen.getByLabelText("工作空间访问令牌"), { target: { value: "local-web-token" } });
  fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await screen.findByRole("heading", { name: baseTask.title });
}

beforeEach(() => {
  sessionStorage.clear();
  apiMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Tasklutein workspace UI", () => {
  it("does not persist a rejected token, permits retry, and clears the session on sign-out", async () => {
    let rejectedFirstAttempt = false;
    apiMock.mockImplementation(async (_token, path, request) => {
      if (path === "/tasks" && request?.method !== "PATCH") {
        if (!rejectedFirstAttempt) {
          rejectedFirstAttempt = true;
          throw new ApiError(401, "unauthorized");
        }
        return { tasks: [] } as never;
      }
      throw new Error(`Unexpected API call: ${request?.method ?? "GET"} ${path}`);
    });
    render(createElement(App));

    const tokenInput = screen.getByLabelText("工作空间访问令牌");
    fireEvent.change(tokenInput, { target: { value: "rejected-local-token" } });
    fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
    await screen.findByRole("alert");
    expect(sessionStorage.getItem("tasklutein_token")).toBeNull();
    expect((tokenInput as HTMLInputElement).value).toBe("rejected-local-token");

    fireEvent.change(tokenInput, { target: { value: "accepted-local-token" } });
    fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
    await screen.findByRole("button", { name: "退出" });
    expect(sessionStorage.getItem("tasklutein_token")).toBe("accepted-local-token");

    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(sessionStorage.getItem("tasklutein_token")).toBeNull();
    expect(screen.getByLabelText("工作空间访问令牌")).toBeTruthy();
  });

  it("keeps an edit draft after a failed PATCH and updates the task after retry", async () => {
    let patchAttempts = 0;
    installApiMock({
      onPatch: (body) => {
        patchAttempts += 1;
        if (patchAttempts === 1) throw new ApiError(422, "title invalid");
        return { task: { ...baseTask, title: String(body.title), description: String(body.description) } };
      },
    });
    await enterWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "编辑任务" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Updated title" } });
    fireEvent.change(screen.getByLabelText("任务说明"), { target: { value: "Updated description" } });
    expect(screen.getByRole("button", { name: "退出" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "全部" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("Updated title");
    expect((screen.getByLabelText("任务说明") as HTMLTextAreaElement).value).toBe("Updated description");

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByRole("heading", { name: "Updated title" });
    expect(patchAttempts).toBe(2);
    expect(apiMock.mock.calls.filter(([, path, request]) => path === "/tasks/task-1" && request?.method === "PATCH")).toHaveLength(2);
  });

  it("reloads the report timeline when workspace refresh is clicked", async () => {
    const reports: Report[] = [{
      id: "report-first",
      task_id: "task-1",
      content: "Existing report",
      source: "user",
      created_at: "2026-10-15T00:30:00Z",
    }];
    installApiMock({ reports });
    await enterWorkspace();
    await screen.findByText("Existing report");

    reports.push({
      id: "report-agent",
      task_id: "task-1",
      content: "Agent report after refresh",
      source: "agent",
      created_at: "2026-10-15T01:00:00Z",
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新任务" }));

    await screen.findByText("Agent report after refresh");
    expect(screen.getByText("Agent", { selector: "span" })).toBeTruthy();
    await waitFor(() => {
      expect(apiMock.mock.calls.filter(([, path, request]) => path === "/tasks/task-1/reports" && request?.method !== "POST")).toHaveLength(2);
    });
  });

  it("updates status counts and filter results after a successful status PATCH", async () => {
    const tasks: Task[] = [
      { ...baseTask },
      { ...baseTask, id: "task-2", title: "Active task", status: "in_progress" },
    ];
    apiMock.mockImplementation(async (_token, path, request) => {
      if (path === "/tasks" && request?.method !== "PATCH") return { tasks: tasks.map((task) => ({ ...task })) } as never;
      if (path.endsWith("/reports")) return { reports: [] } as never;
      if (path === "/tasks/task-1" && request?.method === "PATCH") {
        const patch = JSON.parse(String(request.body)) as Partial<Task>;
        Object.assign(tasks[0], patch);
        return { task: { ...tasks[0] } } as never;
      }
      throw new Error(`Unexpected API call: ${request?.method ?? "GET"} ${path}`);
    });
    await enterWorkspace();

    const statusCount = (label: string) => {
      const labelElement = screen.getAllByText(label).find((element) => element.tagName === "P");
      if (!labelElement) throw new Error(`Status card not found: ${label}`);
      const card = labelElement.parentElement;
      return Number(card?.querySelectorAll("p")[1]?.textContent);
    };
    expect(statusCount("待处理")).toBe(1);
    expect(statusCount("进行中")).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "进行中" }));
    expect(screen.getByRole("button", { name: /Active task/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Original title/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    fireEvent.change(screen.getByLabelText("任务状态"), { target: { value: "done" } });
    await screen.findByText("状态已更新");
    expect(statusCount("待处理")).toBe(0);
    expect(statusCount("进行中")).toBe(1);
    expect(statusCount("已完成")).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "已完成" }));
    expect(screen.getByRole("button", { name: /Original title/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Active task/ })).toBeNull();
  });

  it("preserves a report draft after failure and clears it after retry", async () => {
    let attempts = 0;
    const savedReports: Report[] = [];
    apiMock.mockImplementation(async (_token, path, request) => {
      if (path === "/tasks") return { tasks: [{ ...baseTask }] } as never;
      if (path === "/tasks/task-1/reports" && request?.method === "POST") {
        attempts += 1;
        if (attempts === 1) throw new ApiError(503, "backend unavailable");
        const body = JSON.parse(String(request.body)) as { content: string };
        expect(body).toEqual({ content: "Factual report\nsecond line" });
        const report: Report = { id: "report-retry", task_id: "task-1", content: body.content, source: "user", created_at: "2026-10-15T01:00:00Z" };
        savedReports.unshift(report);
        return { report } as never;
      }
      if (path === "/tasks/task-1/reports") return { reports: [...savedReports] } as never;
      throw new Error(`Unexpected API call: ${request?.method ?? "GET"} ${path}`);
    });
    await enterWorkspace();

    const input = screen.getByPlaceholderText("记录实际完成的工作、测试和结果…");
    fireEvent.change(input, { target: { value: "Factual report\nsecond line" } });
    fireEvent.click(screen.getByRole("button", { name: "添加汇报" }));
    await screen.findByRole("alert");
    expect((input as HTMLTextAreaElement).value).toBe("Factual report\nsecond line");

    fireEvent.click(screen.getByRole("button", { name: "添加汇报" }));
    await screen.findByText("汇报已保存");
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === "Factual report\nsecond line")).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it.each([
    { status: 502, message: "后端暂时无法连接，请稍后重试。" },
    { status: 503, message: "服务暂时不可用，请稍后重试。" },
  ])("shows backend unavailability for HTTP $status and recovers on refresh", async ({ status, message }) => {
    let taskReads = 0;
    apiMock.mockImplementation(async (_token, path, request) => {
      if (path === "/tasks" && request?.method !== "PATCH") {
        taskReads += 1;
        if (taskReads === 2) throw new ApiError(status, "origin_unavailable");
        return { tasks: [{ ...baseTask }] } as never;
      }
      if (path === "/tasks/task-1/reports") return { reports: [] } as never;
      throw new Error(`Unexpected API call: ${request?.method ?? "GET"} ${path}`);
    });
    render(createElement(App));
    fireEvent.change(screen.getByLabelText("工作空间访问令牌"), { target: { value: "local-web-token" } });
    fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));

    await screen.findByText("连接暂不可用");
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(sessionStorage.getItem("tasklutein_token")).toBe("local-web-token");

    fireEvent.click(screen.getByRole("button", { name: "刷新任务" }));
    await screen.findByText("已连接");
    await screen.findByRole("heading", { name: baseTask.title });
  });

  it("clears an expired session when a report read returns 401", async () => {
    apiMock.mockImplementation(async (_token, path) => {
      if (path === "/tasks") return { tasks: [{ ...baseTask }] } as never;
      if (path === "/tasks/task-1/reports") throw new ApiError(401, "unauthorized");
      throw new Error(`Unexpected API call: GET ${path}`);
    });
    render(createElement(App));
    fireEvent.change(screen.getByLabelText("工作空间访问令牌"), { target: { value: "local-web-token" } });
    fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));

    await waitFor(() => expect(sessionStorage.getItem("tasklutein_token")).toBeNull());
    expect(await screen.findByLabelText("工作空间访问令牌")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("访问令牌无效或已失效，请重新输入。");
  });

  it("explains a network failure on sign-in without storing the token", async () => {
    apiMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(createElement(App));
    fireEvent.change(screen.getByLabelText("工作空间访问令牌"), { target: { value: "local-web-token" } });
    fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));

    expect((await screen.findByRole("alert")).textContent).toBe("网络连接失败，请检查网络后重试。");
    expect(sessionStorage.getItem("tasklutein_token")).toBeNull();
  });

  it("prevents duplicate report requests while the first submission is pending", async () => {
    let resolvePost: ((value: { report: Report }) => void) | undefined;
    let attempts = 0;
    const pendingPost = new Promise<{ report: Report }>((resolve) => { resolvePost = resolve; });
    apiMock.mockImplementation(async (_token, path, request) => {
      if (path === "/tasks") return { tasks: [{ ...baseTask }] } as never;
      if (path === "/tasks/task-1/reports" && request?.method === "POST") {
        attempts += 1;
        return pendingPost as never;
      }
      if (path === "/tasks/task-1/reports") return { reports: [] } as never;
      throw new Error(`Unexpected API call: ${request?.method ?? "GET"} ${path}`);
    });
    await enterWorkspace();

    fireEvent.change(screen.getByPlaceholderText("记录实际完成的工作、测试和结果…"), { target: { value: "one report" } });
    const submit = screen.getByRole("button", { name: "添加汇报" });
    fireEvent.click(submit);
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(submit);
    expect(attempts).toBe(1);

    resolvePost?.({ report: { id: "report-once", task_id: "task-1", content: "one report", source: "user", created_at: "2026-10-15T01:00:00Z" } });
    await screen.findByText("汇报已保存");
    expect(attempts).toBe(1);
  });
});
