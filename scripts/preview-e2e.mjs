import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const previewOrigin = "https://dev.preview.tasklutein.xswt.fyi";
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36";
const webToken = process.env.TASKLUTEIN_PREVIEW_WEB_TOKEN ?? "";
const agentToken = process.env.TASKLUTEIN_PREVIEW_AGENT_TOKEN ?? "";

if (webToken.length < 32 || agentToken.length < 32 || webToken === agentToken) {
  console.error("Preview E2E needs distinct Preview Web and Agent tokens in the current process environment.");
  process.exit(1);
}

let stage = "initialize";
let taskId;
let createAttempted = false;
let client;
let failed = false;
const marker = randomUUID();
const title = "[smoke-test] Tasklutein Preview E2E " + marker;
const userReport = "[smoke-test] Web report " + marker;
const agentReport = "[smoke-test] MCP Agent report " + marker;

async function apiRequest(token, method, path, body, expectedStatus) {
  const response = await fetch(new URL(path, previewOrigin), {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "User-Agent": browserUserAgent,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== expectedStatus) {
    throw new Error("unexpected HTTP status " + response.status + " for " + method + " " + path);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

try {
  stage = "create task with Preview Web token";
  createAttempted = true;
  const created = await apiRequest(webToken, "POST", "/api/tasks", {
    title,
    description: "Temporary [smoke-test] record for authenticated Preview API and MCP verification.",
  }, 201);
  taskId = created.task.id;

  stage = "read task back";
  let task = (await apiRequest(webToken, "GET", "/api/tasks/" + taskId, undefined, 200)).task;
  if (task.title !== title || task.status !== "todo") throw new Error("created task mismatch");

  stage = "update task status";
  task = (await apiRequest(webToken, "PATCH", "/api/tasks/" + taskId, { status: "in_progress" }, 200)).task;
  if (task.status !== "in_progress") throw new Error("updated task mismatch");

  stage = "create user report";
  const userResult = await apiRequest(webToken, "POST", "/api/tasks/" + taskId + "/reports", { content: userReport }, 201);
  if (userResult.report.source !== "user") throw new Error("user report attribution mismatch");

  stage = "connect to remote Preview MCP";
  client = new Client({ name: "tasklutein-preview-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(previewOrigin + "/mcp"), {
    requestInit: { headers: { Authorization: "Bearer " + agentToken, "User-Agent": browserUserAgent } },
  });
  await client.connect(transport);

  stage = "list MCP tools";
  const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  for (const required of ["add_report", "create_task", "get_task", "list_tasks", "update_task"]) {
    if (!toolNames.includes(required)) throw new Error("required tool missing");
  }

  stage = "call list_tasks";
  const taskList = await client.callTool({ name: "list_tasks", arguments: {} });
  const taskListText = taskList.content.find((item) => item.type === "text")?.text;
  if (taskList.isError || !taskListText || !JSON.parse(taskListText).tasks.some((item) => item.id === taskId)) {
    throw new Error("MCP task listing mismatch");
  }

  stage = "call add_report";
  const agentResult = await client.callTool({ name: "add_report", arguments: { task_id: taskId, content: agentReport } });
  if (agentResult.isError) throw new Error("MCP report call failed");

  stage = "read both reports through the Web API";
  const reports = (await apiRequest(webToken, "GET", "/api/tasks/" + taskId + "/reports", undefined, 200)).reports;
  const hasUser = reports.some((report) => report.source === "user" && report.content === userReport);
  const hasAgent = reports.some((report) => report.source === "agent" && report.content === agentReport);
  if (!hasUser || !hasAgent) throw new Error("report readback or attribution mismatch");
} catch {
  console.error("FAIL Preview API/MCP E2E at stage: " + stage);
  failed = true;
} finally {
  if (client) await client.close().catch(() => {});
  if (createAttempted) {
    try {
      if (!taskId) {
        stage = "find task after ambiguous create response";
        const tasks = (await apiRequest(webToken, "GET", "/api/tasks", undefined, 200)).tasks;
        const matches = tasks.filter((task) => task.title === title);
        if (matches.length > 1) throw new Error("ambiguous smoke task match");
        taskId = matches[0]?.id;
      }
      if (taskId) {
        stage = "cleanup tagged Preview task";
        await apiRequest(webToken, "DELETE", "/api/tasks/" + taskId, undefined, 204);
        await apiRequest(webToken, "GET", "/api/tasks/" + taskId, undefined, 404);
        await apiRequest(webToken, "GET", "/api/tasks/" + taskId + "/reports", undefined, 404);
      }
    } catch {
      console.error("FAIL Preview E2E cleanup for the uniquely tagged task; inspect Preview before rerunning.");
      failed = true;
    }
  }
}

if (failed) process.exitCode = 1;
else console.log("PASS Preview API/MCP E2E: Web CRUD/read-after-write, MCP tools/list_tasks/add_report, report sources, and tagged-task cleanup.");
