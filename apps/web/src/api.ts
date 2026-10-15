export type TaskStatus = "todo" | "in_progress" | "done";
export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
};
export type Report = {
  id: string;
  task_id: string;
  content: string;
  source: "user" | "agent";
  created_at: string;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// Browser always talks to the same Cloudflare Worker origin.
// The Worker routes /api/* to Tencent; Vite proxies /api/* locally.
export async function api<T>(token: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({})) as { detail?: unknown; error?: string };
    let detail: string | undefined;
    if (typeof json.detail === "string") {
      detail = json.detail;
    } else if (Array.isArray(json.detail)) {
      detail = json.detail.map((item: unknown) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "Request validation failed";
        const entry = item as { loc?: unknown; msg?: unknown };
        const path = Array.isArray(entry.loc) ? entry.loc.map(String).join(".") : "";
        const message = typeof entry.msg === "string" ? entry.msg : "Request validation failed";
        return path ? `${path}: ${message}` : message;
      }).join("; ");
    }
    throw new ApiError(response.status, detail || json.error || "HTTP " + response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
