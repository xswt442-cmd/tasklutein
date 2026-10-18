import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Circle, Clock3, ListTodo, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { api } from "../api";
import type { Overview, Task, TaskPage, TaskStatus } from "../api";
import { ApiFeedback } from "../components/ApiFeedback";

const statusLabels: Record<TaskStatus, string> = {
  todo: "待处理",
  in_progress: "进行中",
  done: "已完成",
};

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function OverviewPage({ token }: { token: string }) {
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>(token, "/overview"),
  });
  const recentTasks = useQuery({
    queryKey: ["tasks", { sort: "updated_desc", limit: 6, offset: 0 }],
    queryFn: () => api<TaskPage>(token, "/tasks?sort=updated_desc&limit=6&offset=0"),
  });

  if (overview.isError) {
    return <ApiFeedback error={overview.error} onRetry={() => void overview.refetch()} />;
  }

  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="eyebrow">工作台</p>
        <h2 className="page-title">Overview</h2>
        <p className="mt-2 text-sm text-[#56655a]">概览当前工作区的任务状态与近期更新。</p>
      </div>
      <span className="text-xs text-[#6a776e]">
        {overview.data ? `统计于 ${formatDate(overview.data.generated_at)}` : "正在读取统计…"}
      </span>
    </div>

    <section aria-label="任务统计" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div className="metric-card col-span-2 lg:col-span-1">
        <span className="metric-icon"><ListTodo size={18} /></span>
        <p className="metric-label">当前任务总数</p>
        <p className="metric-value">{overview.data?.total ?? "—"}</p>
      </div>
      {(["todo", "in_progress", "done"] as const).map((status) => {
        const Icon = status === "done" ? CheckCircle2 : status === "in_progress" ? Clock3 : Circle;
        return <Link className="metric-card transition hover:border-[#b9d2bd] hover:shadow-sm" key={status}
          to={`/tasks?status=${status}&limit=25&offset=0`}>
          <span className="metric-icon"><Icon size={18} /></span>
          <p className="metric-label">{statusLabels[status]}</p>
          <p className="metric-value">{overview.data?.by_status[status] ?? "—"}</p>
        </Link>;
      })}
    </section>

    <section className="card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="eyebrow">最近更新</p>
          <h3 className="mt-1 text-lg font-semibold">任务</h3>
        </div>
        <Link className="quiet-link" to="/tasks">全部任务 <ArrowRight size={15} /></Link>
      </div>
      {recentTasks.isError && <ApiFeedback error={recentTasks.error} onRetry={() => void recentTasks.refetch()} />}
      {recentTasks.isPending && <p className="py-8 text-center text-sm text-[#647268]">正在加载任务…</p>}
      {recentTasks.data?.tasks.length === 0 && <p className="py-8 text-center text-sm text-[#647268]">还没有任务，可以从任务页面创建。</p>}
      {recentTasks.data && recentTasks.data.tasks.length > 0 && <div className="divide-y divide-[#edf1ea]">
        {recentTasks.data.tasks.map((task: Task) => <Link key={task.id} to={`/tasks/${task.id}`}
          className="flex min-h-16 items-center gap-3 py-3 first:pt-1 last:pb-1">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-[#203e30]">{task.title}</span>
            <span className="mt-1 block truncate text-xs text-[#66746a]">{task.description || "暂无说明"}</span>
          </span>
          <span className="shrink-0 rounded-full bg-[#f2f6ef] px-2.5 py-1 text-xs text-[#4e6c56]">{statusLabels[task.status]}</span>
          <time className="hidden shrink-0 text-xs text-[#718076] sm:block">{formatDate(task.updated_at)}</time>
          <ArrowRight className="shrink-0 text-[#789180]" size={16} />
        </Link>)}
      </div>}
      {recentTasks.isFetching && !recentTasks.isPending && <p className="mt-3 flex items-center gap-2 text-xs text-[#718076]"><RefreshCw size={13} /> 正在更新</p>}
    </section>
  </div>;
}
