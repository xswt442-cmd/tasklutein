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
    const json = await response.json().catch(() => ({})) as { detail?: string; error?: string };
    throw new ApiError(response.status, json.detail ?? json.error ?? "HTTP " + response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
