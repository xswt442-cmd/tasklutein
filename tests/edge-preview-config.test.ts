import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { expect, it } from "vitest";

const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const configResult = ts.readConfigFile(configPath, (path) => readFileSync(path, "utf8"));

if (configResult.error) {
  throw new Error(ts.flattenDiagnosticMessageText(configResult.error.messageText, "\n"));
}

it("preserves existing Dashboard-managed production variables during Wrangler deploy", () => {
  expect(configResult.config.keep_vars).toBe(true);
});

it("routes Worker Preview builds to the dedicated HTTPS origin", () => {
  const previewOrigin = configResult.config.previews?.vars?.ORIGIN_URL;
  expect(previewOrigin).toBe("https://preview-origin-tasklutein.xswt.fyi");
});

it("configures the Web and MCP branch Previews with isolated Access settings", () => {
  const previewVars = configResult.config.previews?.vars;
  expect(previewVars).toMatchObject({
    WEB_HOST: "dev.preview.tasklutein.xswt.fyi",
    MCP_HOST: "mcp.preview.tasklutein.xswt.fyi",
    ACCESS_TEAM_DOMAIN: "black-credit-e420.cloudflareaccess.com",
    ACCESS_AUD: "ded870d0b45493adf15d058b50f77ac3f83a0e37b3c752ad2bb2eae77247413b",
  });
  expect(previewVars?.WEB_HOST).not.toBe(previewVars?.MCP_HOST);
  expect(previewVars).not.toHaveProperty("ORIGIN_GATEWAY_TOKEN");
});

it("runs every request through the Worker before serving static assets", () => {
  const workerFirst = configResult.config.assets?.run_worker_first;
  expect(workerFirst).toBe(true);
});
