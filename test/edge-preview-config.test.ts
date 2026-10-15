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

it("keeps API and MCP paths Worker-first", () => {
  const workerFirst = configResult.config.assets?.run_worker_first;
  expect(workerFirst).toEqual(expect.arrayContaining(["/api", "/api/*", "/mcp", "/mcp/*"]));
});
