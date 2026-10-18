import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import type { TaskPage, TaskSort, TaskStatus } from "../api";
import { ApiFeedback } from "../components/ApiFeedback";

const statusLabels: Record<TaskStatus, string> = {
  todo: "待处理",
  in_progress: "进行中",
  done: "已完成",
};

const validStatuses = new Set<TaskStatus>(["todo", "in_progress", "done"]);
const validSorts = new Set<TaskSort>(["updated_desc", "created_desc"]);

export function TasksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statusValue = searchParams.get("status");
  const status = statusValue && validStatuses.has(statusValue as TaskStatus) ? statusValue as TaskStatus : "all";
  const q = searchParams.get("q")?.trim() ?? "";
  const sortValue = searchParams.get("sort");
  const sort = sortValue && validSorts.has(sortValue as TaskSort) ? sortValue as TaskSort : "updated_desc";
  const limitValue = Number(searchParams.get("limit") ?? 25);
  const limit = [25, 50, 100].includes(limitValue) ? limitValue : 25;
  const offsetValue = Number(searchParams.get("offset") ?? 0);
  const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
  const [searchDraft, setSearchDraft] = useState(q);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => setSearchDraft(q), [q]);

  const tasks = useQuery({
    queryKey: ["tasks", status, q, sort, limit, offset],
    queryFn: () => {
      const params = new URLSearchParams({ sort, limit: String(limit), offset: String(offset) });
      if (status !== "all") params.set("status", status);
      if (q) params.set("q", q);
      return api<TaskPage>("/tasks?" + params.toString());
    },
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (!tasks.data || tasks.isPlaceholderData || offset === 0 || offset < tasks.data.total) return;
    const lastOffset = tasks.data.total === 0
      ? 0
      : Math.floor((tasks.data.total - 1) / limit) * limit;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (lastOffset === 0) next.delete("offset");
      else next.set("offset", String(lastOffset));
      return next;
    }, { replace: true });
  }, [limit, offset, setSearchParams, tasks.data, tasks.isPlaceholderData]);

  const createTask = useMutation({
    mutationFn: () => api<{ task: { id: string } }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: title.trim(), description }),
    }),
    onSuccess: async ({ task }) => {
      setTitle("");
      setDescription("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      navigate(`/tasks/${task.id}`);
    },
  });

  function updateFilters(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next);
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    updateFilters({ q: searchDraft.trim() || null, offset: "0" });
  }

  function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || createTask.isPending) return;
    createTask.mutate();
  }

  const data = tasks.data;
  const pageNumber = data ? Math.floor(data.offset / data.limit) + 1 : 1;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return <div className="space-y-6">
    <div>
      <p className="eyebrow">工作区</p>
      <h2 className="page-title">任务</h2>
      <p className="mt-2 text-sm text-[#56655a]">搜索、筛选和更新当前任务。任务删除会连同工作汇报一起清除，不保留历史。</p>
    </div>

    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className="card min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">任务列表</h3>
          <span className="text-sm text-[#68766c]">{data ? `共 ${data.total} 项` : "正在读取…"}</span>
        </div>

        <form onSubmit={submitSearch} className="mb-4 flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="task-search">搜索任务</label>
          <input id="task-search" className="input min-w-0 flex-1" type="search" maxLength={200}
            placeholder="搜索标题或说明" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
          <button type="submit" className="secondary-btn"><Search size={16} /> 搜索</button>
        </form>

        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
          <label className="text-xs font-medium text-[#56655a]">任务状态
            <select aria-label="按任务状态筛选" className="input mt-1.5" value={status}
              onChange={(event) => updateFilters({ status: event.target.value === "all" ? null : event.target.value, offset: "0" })}>
              <option value="all">全部状态</option>
              {(Object.entries(statusLabels) as [TaskStatus, string][]).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-[#56655a]">排序
            <select aria-label="任务排序" className="input mt-1.5" value={sort}
              onChange={(event) => updateFilters({ sort: event.target.value, offset: "0" })}>
              <option value="updated_desc">最近更新</option>
              <option value="created_desc">最近创建</option>
            </select>
          </label>
        </div>

        {tasks.isError && <ApiFeedback error={tasks.error} onRetry={() => void tasks.refetch()} />}
        {tasks.isPending && <p className="py-12 text-center text-sm text-[#69776d]">正在加载任务…</p>}
        {data && data.tasks.length === 0 && <p className="py-12 text-center text-sm text-[#69776d]">
          {q || status !== "all" ? "没有符合条件的任务。" : "这里还没有任务。"}
        </p>}
        {data && data.tasks.length > 0 && <div className="divide-y divide-[#edf1ea]">
          {data.tasks.map((task) => <Link key={task.id} to={`/tasks/${task.id}`} className="task-list-row">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-[#203e30]">{task.title}</span>
              <span className="mt-1 block truncate text-xs text-[#69776d]">{task.description || "暂无说明"}</span>
            </span>
            <span className="shrink-0 rounded-full bg-[#f2f6ef] px-2.5 py-1 text-xs text-[#4e6c56]">{statusLabels[task.status]}</span>
            <time className="hidden shrink-0 text-xs text-[#718076] sm:block">{new Date(task.updated_at).toLocaleDateString("zh-CN")}</time>
            <ArrowRight className="shrink-0 text-[#789180]" size={16} />
          </Link>)}
        </div>}

        {data && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#edf1ea] pt-4">
          <label className="flex items-center gap-2 text-xs text-[#66746a]">每页
            <select aria-label="每页条数" className="input w-auto py-2" value={limit}
              onChange={(event) => updateFilters({ limit: event.target.value, offset: "0" })}>
              {[25, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-2 text-sm">
            <span className="mr-1 text-xs text-[#66746a]">第 {pageNumber} / {pageCount} 页</span>
            <button type="button" aria-label="上一页" className="icon-btn" disabled={offset === 0 || tasks.isFetching}
              onClick={() => updateFilters({ offset: String(Math.max(0, offset - limit)) })}><ArrowLeft size={16} /></button>
            <button type="button" aria-label="下一页" className="icon-btn" disabled={offset + limit >= data.total || tasks.isFetching}
              onClick={() => updateFilters({ offset: String(offset + limit) })}><ArrowRight size={16} /></button>
          </div>
        </div>}
      </section>

      <section className="card">
        <p className="eyebrow">新任务</p>
        <h3 className="mb-4 mt-1 text-lg font-semibold">创建任务</h3>
        <form onSubmit={submitCreate} className="space-y-3">
          <label className="block text-sm font-medium">标题
            <input className="input mt-1.5" aria-label="新任务标题" value={title} maxLength={120}
              onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label className="block text-sm font-medium">说明
            <textarea className="input mt-1.5 min-h-28 resize-y" aria-label="新任务说明" value={description}
              maxLength={4000} onChange={(event) => setDescription(event.target.value)} />
          </label>
          {createTask.isError && <ApiFeedback error={createTask.error} />}
          <button className="primary-btn w-full" type="submit" disabled={!title.trim() || createTask.isPending}>
            <Plus size={16} />{createTask.isPending ? "正在创建…" : "创建任务"}
          </button>
        </form>
      </section>
    </div>
  </div>;
}
