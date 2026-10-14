import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type McpApiConfig = {
  apiBase: string;
  agentToken: string;
  gatewayToken?: string;
};

export function createTaskluteinMcpServer(config: McpApiConfig): McpServer {
  const endpoint = config.apiBase.replace(/\/$/, "");

  async function callApi(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: "Bearer " + config.agentToken,
      "Content-Type": "application/json",
    };
    if (config.gatewayToken) headers["X-Tasklutein-Gateway"] = config.gatewayToken;
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
    description: "List tasks in the Tasklutein workspace.",
    inputSchema: { status: z.enum(["todo", "in_progress", "done"]).optional() },
  }, async ({ status }) => result(await callApi("GET", "/tasks" + (status ? "?status=" + status : ""))));

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

  return server;
}
