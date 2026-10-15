const previewUrl = new URL(process.env.TASKLUTEIN_PREVIEW_URL ?? "https://dev.preview.tasklutein.xswt.fyi");
const originUrl = new URL(process.env.TASKLUTEIN_PREVIEW_ORIGIN ?? "https://preview-origin-tasklutein.xswt.fyi");

if (previewUrl.protocol !== "https:" || originUrl.protocol !== "https:") {
  throw new Error("Preview smoke endpoints must use HTTPS");
}

const checks = [
  {
    name: "Preview API health",
    url: new URL("/api/health", previewUrl),
    method: "GET",
    expectedStatus: 200,
    expectedBody: (body) => body?.status === "ok",
  },
  {
    name: "Preview API rejects anonymous task access",
    url: new URL("/api/tasks", previewUrl),
    method: "GET",
    expectedStatus: 401,
    expectedBody: (body) => body?.detail === "unauthorized",
  },
  {
    name: "Preview MCP rejects anonymous access",
    url: new URL("/mcp", previewUrl),
    method: "GET",
    expectedStatus: 401,
    expectedBody: (body) => body?.detail === "unauthorized",
  },
  {
    name: "Preview origin blocks unauthenticated API health",
    url: new URL("/api/health", originUrl),
    method: "GET",
    expectedStatus: 403,
    expectedBody: (body) => body?.detail === "invalid_gateway",
  },
  {
    name: "Preview origin blocks unauthenticated MCP access",
    url: new URL("/mcp", originUrl),
    method: "GET",
    expectedStatus: 403,
    expectedBody: (body) => body?.detail === "invalid_gateway",
  },
];

let failed = false;
for (const check of checks) {
  try {
    const response = await fetch(check.url, {
      method: check.method,
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const ok = response.status === check.expectedStatus && check.expectedBody(body);
    console.log(`${ok ? "PASS" : "FAIL"} ${check.name}: HTTP ${response.status}`);
    if (!ok) failed = true;
  } catch (error) {
    console.error(`FAIL ${check.name}: ${error instanceof Error ? error.message : "request failed"}`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
