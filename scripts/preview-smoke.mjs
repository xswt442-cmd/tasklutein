const previewWebUrl = new URL(process.env.TASKLUTEIN_PREVIEW_URL ?? "https://dev.preview.tasklutein.xswt.fyi");
const previewMcpUrlValue = process.env.TASKLUTEIN_PREVIEW_MCP_URL;
const originUrl = new URL(process.env.TASKLUTEIN_PREVIEW_ORIGIN ?? "https://preview-origin-tasklutein.xswt.fyi");
const accessCookie = process.env.TASKLUTEIN_PREVIEW_ACCESS_COOKIE ?? "";

if (!previewMcpUrlValue) {
  throw new Error("TASKLUTEIN_PREVIEW_MCP_URL must point to the dedicated Preview MCP hostname");
}
const previewMcpUrl = new URL(previewMcpUrlValue);
if ([previewWebUrl, previewMcpUrl, originUrl].some((url) => url.protocol !== "https:" || url.pathname !== "/")) {
  throw new Error("Preview smoke endpoints must be HTTPS base URLs without a path");
}

const checks = accessCookie ? [
  {
    name: "Authenticated Preview API health",
    url: new URL("/api/health", previewWebUrl),
    method: "GET",
    expectedStatuses: [200],
    expectedBody: (body) => body?.status === "ok",
    headers: { Cookie: accessCookie },
  },
  {
    name: "Preview Web host rejects MCP paths",
    url: new URL("/mcp", previewWebUrl),
    method: "GET",
    expectedStatuses: [404],
    expectedBody: (body) => body?.code === "path_not_allowed",
    headers: { Cookie: accessCookie },
  },
] : [
  {
    name: "Preview Web host blocks unauthenticated API access",
    url: new URL("/api/tasks", previewWebUrl),
    method: "GET",
    expectedStatuses: [302, 401, 403],
    expectedBody: () => true,
  },
];

checks.push(
  {
    name: "Preview MCP host rejects static assets",
    url: previewMcpUrl,
    method: "GET",
    expectedStatuses: [404],
    expectedBody: (body) => body?.code === "path_not_allowed",
  },
  {
    name: "Preview MCP host rejects Web API paths",
    url: new URL("/api/health", previewMcpUrl),
    method: "GET",
    expectedStatuses: [404],
    expectedBody: (body) => body?.code === "path_not_allowed",
  },
  {
    name: "Preview MCP rejects anonymous access",
    url: new URL("/mcp", previewMcpUrl),
    method: "GET",
    expectedStatuses: [401],
    expectedBody: (body) => body?.detail === "unauthorized",
  },
  {
    name: "Preview origin blocks unauthenticated API health",
    url: new URL("/api/health", originUrl),
    method: "GET",
    expectedStatuses: [403],
    expectedBody: (body) => body?.detail === "invalid_gateway",
  },
  {
    name: "Preview origin blocks unauthenticated MCP access",
    url: new URL("/mcp", originUrl),
    method: "GET",
    expectedStatuses: [403],
    expectedBody: (body) => body?.detail === "invalid_gateway",
  },
);

let failed = false;
for (const check of checks) {
  try {
    const response = await fetch(check.url, {
      method: check.method,
      redirect: "manual",
      headers: { Accept: "application/json", Origin: previewWebUrl.origin, ...check.headers },
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const ok = check.expectedStatuses.includes(response.status) && check.expectedBody(body);
    console.log(`${ok ? "PASS" : "FAIL"} ${check.name}: HTTP ${response.status}`);
    if (!ok) failed = true;
  } catch (error) {
    console.error(`FAIL ${check.name}: ${error instanceof Error ? error.message : "request failed"}`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
