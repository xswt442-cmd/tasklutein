export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskSort = "updated_desc" | "created_desc";
export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
};
export type ArchivedTask = Task & { archived_at: string };
export type Report = {
  id: string;
  task_id: string;
  content: string;
  source: "user" | "agent";
  actor_name: string | null;
  created_at: string;
};
export type Page<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};
export type TaskPage = Omit<Page<Task>, "items"> & { tasks: Task[] };
export type ReportPage = Omit<Page<Report>, "items"> & { reports: Report[] };
export type ActivityEventType = "task.created" | "task.updated" | "task.status_changed" | "task.deleted" | "report.created";
export type ActivitySource = "user" | "agent";
export type Activity = {
  id: string;
  task_id: string;
  task_title: string;
  event_type: ActivityEventType;
  actor_type: ActivitySource;
  actor_name: string | null;
  request_id: string;
  summary: Record<string, unknown>;
  occurred_at: string;
};
export type ArchivedTaskPage = Omit<Page<ArchivedTask>, "items"> & { tasks: ArchivedTask[] };
export type ActivityPage = Omit<Page<Activity>, "items"> & { activities: Activity[] };
export type Overview = {
  total: number;
  by_status: Record<TaskStatus, number>;
  generated_at: string;
  recent_activities: Activity[];
};
export type User = { id: string; email: string; created_at: string };
export type Workspace = { id: string; name: string; created_at: string };
export type Session = { user: User; workspace: Workspace };
export type AgentToken = {
  id: string; name: string; prefix: string; created_at: string;
  expires_at: string | null; revoked_at?: string | null;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function apiError(response: Response): Promise<ApiError> {
  const json = await response.json().catch(() => ({})) as {
    detail?: unknown;
    error?: string;
    code?: unknown;
    request_id?: unknown;
  };
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
  return new ApiError(
    response.status,
    detail || json.error || "HTTP " + response.status,
    typeof json.code === "string" ? json.code : undefined,
    typeof json.request_id === "string" ? json.request_id : undefined,
  );
}

export async function probeSession(): Promise<Session | null> {
  const response = await fetch("/api/session/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "manual",
  });
  if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<Session>;
}

// Browser always talks to the same Cloudflare Worker origin.
// The Worker routes /api/* to Tencent; Vite proxies /api/* locally.
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    cache: "no-store",
    credentials: "same-origin",
    redirect: "manual",
  });
  if (response.type === "opaqueredirect") {
    window.location.assign("/api/session/login");
    throw new ApiError(401, "unauthorized", "unauthorized");
  }
  if (!response.ok) throw await apiError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
