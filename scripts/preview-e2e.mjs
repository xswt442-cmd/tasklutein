import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const previewWebUrl = new URL(process.env.TASKLUTEIN_PREVIEW_URL ?? "https://dev.preview.tasklutein.xswt.fyi");
const previewMcpUrlValue = process.env.TASKLUTEIN_PREVIEW_MCP_URL;
const previewAccessCookie = process.env.TASKLUTEIN_PREVIEW_ACCESS_COOKIE ?? "";
const agentKey = process.env.TASKLUTEIN_PREVIEW_AGENT_KEY ?? "";
const userAgent = "Tasklutein-Preview-E2E/1.0";

if (!previewMcpUrlValue || !previewAccessCookie.includes("CF_Authorization=") || !agentKey.startsWith("tlu_")) {
  console.error("Preview E2E needs a Web Access cookie, the dedicated MCP URL, and a personal Agent key in the current process environment.");
  process.exit(1);
}

const previewMcpUrl = new URL(previewMcpUrlValue);
if ([previewWebUrl, previewMcpUrl].some((url) => url.protocol !== "https:" || url.pathname !== "/")) {
  console.error("Preview Web and MCP endpoints must be HTTPS base URLs without a path.");
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
const userComment = "[smoke-test] Web report comment " + marker;
const agentComment = "[smoke-test] MCP Agent report comment " + marker;

function safeErrorDetail(error) {
  if (!(error instanceof Error)) return "request failed";
  return error.message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/CF_Authorization=[^;\s]+/gi, "CF_Authorization=[redacted]")
    .replace(/tlu_[A-Za-z0-9_-]+/g, "[redacted-agent-key]")
    .slice(0, 200);
}

async function webApiRequest(method, path, body, expectedStatus) {
  const response = await fetch(new URL(path, previewWebUrl), {
    method,
    headers: {
      Cookie: previewAccessCookie,
      Origin: previewWebUrl.origin,
      Accept: "application/json",
      "User-Agent": userAgent,
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
  if (response.status === 204 || response.status === 404) return undefined;
  return response.json();
}

try {
  stage = "bootstrap Preview Web identity";
  await webApiRequest("POST", "/api/session/bootstrap", {}, 200);

  stage = "create task with Preview Web identity";
  createAttempted = true;
  const created = await webApiRequest("POST", "/api/tasks", {
    title,
    description: "Temporary [smoke-test] record for authenticated Preview API and MCP verification.",
  }, 201);
  taskId = created.task.id;

  stage = "read task back";
  let task = (await webApiRequest("GET", "/api/tasks/" + taskId, undefined, 200)).task;
  if (task.title !== title || task.status !== "todo") throw new Error("created task mismatch");

  stage = "update task status";
  task = (await webApiRequest(
    "PATCH", "/api/tasks/" + taskId, { status: "in_progress", expected_version: task.version }, 200,
  )).task;
  if (task.status !== "in_progress") throw new Error("updated task mismatch");

  stage = "create user report";
  const userResult = await webApiRequest("POST", "/api/tasks/" + taskId + "/reports", { content: userReport }, 201);
  if (userResult.report.source !== "user") throw new Error("user report attribution mismatch");
  const reportId = userResult.report.id;

  stage = "review user report as Web identity";
  const userReview = await webApiRequest("PUT", "/api/reports/" + reportId + "/review", {
    score: 5, verdict: "approved", note: "[smoke-test] review visible to MCP",
  }, 200);
  if (userReview.review.verdict !== "approved") throw new Error("user report review mismatch");

  stage = "create Web report comment";
  const userCommentResult = await webApiRequest(
    "POST", "/api/reports/" + reportId + "/comments", { content: userComment }, 201,
  );
  if (userCommentResult.comment.source !== "user") throw new Error("user comment attribution mismatch");

  stage = "connect to remote Preview MCP";
  client = new Client({ name: "tasklutein-preview-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", previewMcpUrl), {
    requestInit: { headers: { Authorization: "Bearer " + agentKey, "User-Agent": userAgent } },
  });
  await client.connect(transport);

  stage = "list MCP tools";
  const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  for (const required of [
    "add_report", "add_report_comment", "create_task", "get_task", "list_report_comments",
    "list_report_reviews", "list_reports", "list_tasks", "update_task",
  ]) {
    if (!toolNames.includes(required)) throw new Error("required tool missing");
  }

  stage = "call list_tasks";
  const taskList = await client.callTool({ name: "list_tasks", arguments: { q: marker } });
  const taskListText = taskList.content.find((item) => item.type === "text")?.text;
  if (taskList.isError || !taskListText || !JSON.parse(taskListText).tasks.some((item) => item.id === taskId)) {
    throw new Error("MCP task listing mismatch");
  }

  stage = "call add_report";
  const agentResult = await client.callTool({ name: "add_report", arguments: { task_id: taskId, content: agentReport } });
  if (agentResult.isError) throw new Error("MCP report call failed");

  stage = "read report page through MCP";
  const reportPage = await client.callTool({ name: "list_reports", arguments: { task_id: taskId, limit: 10, offset: 0 } });
  const reportPageText = reportPage.content.find((item) => item.type === "text")?.text;
  if (
    reportPage.isError || !reportPageText ||
    !JSON.parse(reportPageText).reports.some((report) => report.source === "agent" && report.content === agentReport)
  ) throw new Error("MCP report page mismatch");

  stage = "create Agent report comment";
  const agentCommentResult = await client.callTool({
    name: "add_report_comment", arguments: { report_id: reportId, content: agentComment },
  });
  if (agentCommentResult.isError) throw new Error("MCP comment call failed");

  stage = "read report comments through MCP";
  const commentPage = await client.callTool({
    name: "list_report_comments", arguments: { report_id: reportId, limit: 25, offset: 0 },
  });
  const commentPageText = commentPage.content.find((item) => item.type === "text")?.text;
  if (commentPage.isError || !commentPageText) throw new Error("MCP comment listing failed");
  const agentComments = JSON.parse(commentPageText).comments;
  if (!agentComments.some((comment) => comment.source === "agent" && comment.content === agentComment)) {
    throw new Error("Agent comment readback or attribution mismatch");
  }

  stage = "read human report reviews through MCP";
  const reviewResult = await client.callTool({ name: "list_report_reviews", arguments: { report_id: reportId } });
  const reviewText = reviewResult.content.find((item) => item.type === "text")?.text;
  if (
    reviewResult.isError || !reviewText ||
    !JSON.parse(reviewText).reviews.some((review) => review.verdict === "approved" && review.note === "[smoke-test] review visible to MCP")
  ) throw new Error("MCP review readback mismatch");

  stage = "read both reports through the Web API";
  const reports = (await webApiRequest("GET", "/api/tasks/" + taskId + "/reports", undefined, 200)).reports;
  const hasUser = reports.some((report) => report.source === "user" && report.content === userReport);
  const hasAgent = reports.some((report) => report.source === "agent" && report.content === agentReport);
  if (!hasUser || !hasAgent) throw new Error("report readback or attribution mismatch");

  stage = "read report comments through the Web API";
  const comments = (await webApiRequest(
    "GET", "/api/reports/" + reportId + "/comments?limit=25&offset=0", undefined, 200,
  )).comments;
  if (
    !comments.some((comment) => comment.source === "user" && comment.content === userComment) ||
    !comments.some((comment) => comment.source === "agent" && comment.content === agentComment)
  ) throw new Error("Web comment readback or attribution mismatch");
} catch (error) {
  console.error("FAIL Preview API/MCP E2E at stage: " + stage + " (" + safeErrorDetail(error) + ")");
  failed = true;
} finally {
  if (client) await client.close().catch(() => {});
  if (createAttempted) {
    try {
      if (!taskId) {
        stage = "find task after ambiguous create response";
        const tasks = (await webApiRequest("GET", "/api/tasks", undefined, 200)).tasks;
        const matches = tasks.filter((task) => task.title === title);
        if (matches.length > 1) throw new Error("ambiguous smoke task match");
        taskId = matches[0]?.id;
      }
      if (taskId) {
        stage = "cleanup tagged Preview task";
        await webApiRequest("DELETE", "/api/tasks/" + taskId, undefined, 204);
        await webApiRequest("GET", "/api/tasks/" + taskId, undefined, 404);
        await webApiRequest("GET", "/api/tasks/" + taskId + "/reports", undefined, 404);
      }
    } catch {
      console.error("FAIL Preview E2E cleanup for the uniquely tagged task; inspect Preview before rerunning.");
      failed = true;
    }
  }
}

if (failed) process.exitCode = 1;
else console.log("PASS Preview API/MCP E2E: Access identity, Web CRUD/read-after-write, MCP task/report/comment tools, attribution, and tagged-task cleanup.");
