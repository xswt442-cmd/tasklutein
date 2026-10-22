import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type McpApiConfig = {
  apiBase: string;
  agentToken: string;
  gatewayToken?: string;
  requestId?: string;
};

export function createTaskluteinMcpServer(config: McpApiConfig): McpServer {
  const endpoint = config.apiBase.replace(/\/$/, "");

  async function callApi(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: "Bearer " + config.agentToken,
      "Content-Type": "application/json",
    };
    if (config.gatewayToken) headers["X-Tasklutein-Gateway"] = config.gatewayToken;
    if (config.requestId) headers["X-Request-ID"] = config.requestId;
    const response = await fetch(endpoint + "/api" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    if (!response.ok) {
      // Deliberately do not echo an upstream error body; it could contain secrets.
      throw new Error("Tasklutein API request failed: HTTP " + response.status);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });

  const server = new McpServer({ name: "tasklutein", version: "0.1.0" });

  server.registerTool("list_tasks", {
    description: "List tasks in the Tasklutein workspace, optionally filtered and paginated.",
    inputSchema: {
      status: z.enum(["todo", "in_progress", "done"]).optional(),
      q: z.string().trim().max(200).optional(),
      sort: z.enum(["updated_desc", "created_desc"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, async ({ status, q, sort, limit, offset }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (q) params.set("q", q);
    if (sort) params.set("sort", sort);
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    const query = params.size ? "?" + params.toString() : "";
    return result(await callApi("GET", "/tasks" + query));
  });

  server.registerTool("list_reports", {
    description: "List a task's progress reports, optionally paginated.",
    inputSchema: {
      task_id: z.string().uuid(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, async ({ task_id, limit, offset }) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    const query = params.size ? "?" + params.toString() : "";
    return result(await callApi("GET", "/tasks/" + task_id + "/reports" + query));
  });

  server.registerTool("get_task", {
    description: "Read a task and its progress reports.",
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }) => {
    const [task, reports] = await Promise.all([
      callApi("GET", "/tasks/" + id),
      callApi("GET", "/tasks/" + id + "/reports"),
    ]);
    return result({ task, reports });
  });

  server.registerTool("create_task", {
    description: "Create a Tasklutein task.",
    inputSchema: {
      title: z.string().trim().min(1).max(120),
      description: z.string().max(4000).optional(),
    },
  }, async ({ title, description }) =>
    result(await callApi("POST", "/tasks", { title, description: description ?? "" })));

  server.registerTool("update_task", {
    description: "Update a task title, description, or status. Only mark done when work has been verified.",
    inputSchema: {
      id: z.string().uuid(),
      title: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(4000).optional(),
      status: z.enum(["todo", "in_progress", "done"]).optional(),
    },
  }, async ({ id, ...changes }) => result(await callApi("PATCH", "/tasks/" + id, changes)));

  server.registerTool("add_report", {
    description: "Append a factual task progress report, describing work actually performed and verified.",
    inputSchema: {
      task_id: z.string().uuid(),
      content: z.string().trim().min(1).max(8000),
    },
  }, async ({ task_id, content }) =>
    result(await callApi("POST", "/tasks/" + task_id + "/reports", { content })));

  server.registerTool("list_report_comments", {
    description: "List comments on a progress report, optionally paginated.",
    inputSchema: {
      report_id: z.string().uuid(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, async ({ report_id, limit, offset }) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    const query = params.size ? "?" + params.toString() : "";
    return result(await callApi("GET", "/reports/" + report_id + "/comments" + query));
  });

  server.registerTool("add_report_comment", {
    description: "Add a comment to a progress report.",
    inputSchema: {
      report_id: z.string().uuid(),
      content: z.string().trim().min(1).max(2000),
    },
  }, async ({ report_id, content }) =>
    result(await callApi("POST", "/reports/" + report_id + "/comments", { content })));

  return server;
}
