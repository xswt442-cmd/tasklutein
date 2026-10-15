import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../apps/web/src/api";

describe("browser API adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("formats FastAPI validation detail arrays instead of displaying [object Object]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: [{
        type: "extra_forbidden",
        loc: ["body", "source"],
        msg: "Extra inputs are not permitted",
        input: "user",
      }],
    }), { status: 422, headers: { "Content-Type": "application/json" } })));

    await expect(api("local-test-token", "/tasks/task-1/reports", {
      method: "POST",
      body: JSON.stringify({ content: "report" }),
    })).rejects.toMatchObject({
      status: 422,
      message: "body.source: Extra inputs are not permitted",
    } satisfies Partial<ApiError>);
  });
});
