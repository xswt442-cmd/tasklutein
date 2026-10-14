import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../apps/web/src/api";

afterEach(() => vi.unstubAllGlobals());

describe("browser API client", () => {
  it("sends a bearer token and accepts task lists", async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
    vi.stubGlobal("fetch", mock);
    await expect(api<{ tasks: [] }>("browser-token", "/tasks")).resolves.toEqual({ tasks: [] });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("/api/tasks");
    expect(init.headers.Authorization).toBe("Bearer browser-token");
    expect(init.cache).toBe("no-store");
  });

  it("surfaces HTTP errors without leaking auth headers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401 })));
    await expect(api("wrong", "/tasks")).rejects.toEqual(new ApiError(401, "unauthorized"));
  });
});
