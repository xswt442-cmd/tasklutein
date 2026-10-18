import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Archive, Clock3, FileText, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import type { Activity, ActivityEventType, ActivityPage, ActivitySource, ArchivedTask, ArchivedTaskPage, ReportPage, TaskStatus } from "../api";
import { ApiFeedback } from "../components/ApiFeedback";

const statusLabels: Record<TaskStatus, string> = {
  todo: "待处理",
  in_progress: "进行中",
  done: "已完成",
};

const eventLabels: Record<ActivityEventType, string> = {
  "task.created": "创建任务",
  "task.updated": "更新任务",
  "task.status_changed": "更改任务状态",
  "task.deleted": "归档任务",
  "report.created": "新增工作汇报",
};

const fieldLabels: Record<string, string> = {
  title: "标题",
  description: "说明",
  status: "状态",
};

const validEventTypes = new Set<ActivityEventType>(Object.keys(eventLabels) as ActivityEventType[]);
const validSources = new Set<ActivitySource>(["user", "agent"]);

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function activitySummary(activity: Activity) {
  const summary = activity.summary;
  const fields = Array.isArray(summary.changed_fields)
    ? summary.changed_fields.filter((field): field is string => typeof field === "string").map((field) => fieldLabels[field] ?? field)
    : [];
  if (typeof summary.status_before === "string" && typeof summary.status_after === "string") {
    return `状态：${statusLabels[summary.status_before as TaskStatus] ?? summary.status_before} → ${statusLabels[summary.status_after as TaskStatus] ?? summary.status_after}`;
  }
  if (fields.length > 0) return `修改了${fields.join("、")}`;
  if (activity.event_type === "report.created") return "记录了一条工作汇报";
  if (activity.event_type === "task.deleted") return `归档时状态：${statusLabels[String(summary.status) as TaskStatus] ?? String(summary.status ?? "未知")}`;
  return "记录了任务变更";
}

function HistoryPager({
  offset,
  limit,
  total,
  fetching,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  fetching: boolean;
  onChange: (offset: number) => void;
}) {
  const pageNumber = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  return <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#edf1ea] pt-4">
    <span className="text-xs text-[#66746a]">共 {total} 项</span>
    <div className="flex items-center gap-2 text-sm">
      <span className="mr-1 text-xs text-[#66746a]">第 {pageNumber} / {pageCount} 页</span>
      <button type="button" aria-label="上一页" className="icon-btn" disabled={offset === 0 || fetching}
        onClick={() => onChange(Math.max(0, offset - limit))}><ArrowLeft size={16} /></button>
      <button type="button" aria-label="下一页" className="icon-btn" disabled={offset + limit >= total || fetching}
        onClick={() => onChange(offset + limit)}><ArrowRight size={16} /></button>
    </div>
  </div>;
}

export function HistoryPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const view = searchParams.get("view") === "activity" ? "activity" : "archive";
  const q = searchParams.get("q")?.trim() ?? "";
  const eventValue = searchParams.get("event_type");
  const eventType = eventValue && validEventTypes.has(eventValue as ActivityEventType) ? eventValue as ActivityEventType : "";
  const sourceValue = searchParams.get("source");
  const source = sourceValue && validSources.has(sourceValue as ActivitySource) ? sourceValue as ActivitySource : "";
  const taskFilter = searchParams.get("task_id")?.trim() ?? "";
  const limitValue = Number(searchParams.get("limit") ?? 25);
  const limit = [25, 50, 100].includes(limitValue) ? limitValue : 25;
  const archiveOffsetValue = Number(searchParams.get("archive_offset") ?? 0);
  const archiveOffset = Number.isSafeInteger(archiveOffsetValue) && archiveOffsetValue >= 0 ? archiveOffsetValue : 0;
  const activityOffsetValue = Number(searchParams.get("activity_offset") ?? 0);
  const activityOffset = Number.isSafeInteger(activityOffsetValue) && activityOffsetValue >= 0 ? activityOffsetValue : 0;
  const reportOffsetValue = Number(searchParams.get("reports_offset") ?? 0);
  const reportOffset = Number.isSafeInteger(reportOffsetValue) && reportOffsetValue >= 0 ? reportOffsetValue : 0;
  const [searchDraft, setSearchDraft] = useState(q);
  const [taskDraft, setTaskDraft] = useState(taskFilter);

  useEffect(() => setSearchDraft(q), [q]);
  useEffect(() => setTaskDraft(taskFilter), [taskFilter]);

  const archivesQuery = useQuery({
    queryKey: ["history", "tasks", q, limit, archiveOffset],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(archiveOffset) });
      if (q) params.set("q", q);
      return api<ArchivedTaskPage>("/history/tasks?" + params.toString());
    },
    enabled: !taskId && view === "archive",
    placeholderData: keepPreviousData,
  });
  const activityQuery = useQuery({
    queryKey: ["activity", eventType, source, taskFilter, limit, activityOffset],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(activityOffset) });
      if (eventType) params.set("event_type", eventType);
      if (source) params.set("source", source);
      if (taskFilter) params.set("task_id", taskFilter);
      return api<ActivityPage>("/activity?" + params.toString());
    },
    enabled: !taskId && view === "activity",
    placeholderData: keepPreviousData,
  });
  const taskQuery = useQuery({
    queryKey: ["history", "task", taskId],
    queryFn: () => api<{ task: ArchivedTask }>(`/history/tasks/${taskId}`),
    enabled: Boolean(taskId),
  });
  const reportsQuery = useQuery({
    queryKey: ["history", "reports", taskId, 25, reportOffset],
    queryFn: () => api<ReportPage>(`/history/tasks/${taskId}/reports?limit=25&offset=${reportOffset}`),
    enabled: Boolean(taskId),
  });

  const deleteActivity = useMutation({
    mutationFn: (eventId: string) => api<void>(`/activity/${eventId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["activity"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
    },
  });
  const clearTaskHistory = useMutation({
    mutationFn: (id: string) => api<void>(`/history/tasks/${id}`, { method: "DELETE" }),
    onSuccess: async (_result, id) => {
      if (id === taskId) navigate("/history?view=archive");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["activity"] }),
        queryClient.invalidateQueries({ queryKey: ["history"] }),
        queryClient.invalidateQueries({ queryKey: ["reports", id] }),
        queryClient.invalidateQueries({ queryKey: ["history", "reports", id] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      ]);
    },
  });

  useEffect(() => {
    if (taskId || !archivesQuery.data || archivesQuery.isPlaceholderData || archiveOffset === 0 || archiveOffset < archivesQuery.data.total) return;
    const lastOffset = archivesQuery.data.total === 0 ? 0 : Math.floor((archivesQuery.data.total - 1) / limit) * limit;
    updateFilters({ archive_offset: lastOffset ? String(lastOffset) : null });
  }, [archiveOffset, archivesQuery.data, archivesQuery.isPlaceholderData, limit, taskId]);

  useEffect(() => {
    if (taskId || !activityQuery.data || activityQuery.isPlaceholderData || activityOffset === 0 || activityOffset < activityQuery.data.total) return;
    const lastOffset = activityQuery.data.total === 0 ? 0 : Math.floor((activityQuery.data.total - 1) / limit) * limit;
    updateFilters({ activity_offset: lastOffset ? String(lastOffset) : null });
  }, [activityOffset, activityQuery.data, activityQuery.isPlaceholderData, limit, taskId]);

  useEffect(() => {
    if (!reportsQuery.data || reportOffset === 0 || reportOffset < reportsQuery.data.total) return;
    const lastOffset = reportsQuery.data.total === 0 ? 0 : Math.floor((reportsQuery.data.total - 1) / reportsQuery.data.limit) * reportsQuery.data.limit;
    updateFilters({ reports_offset: lastOffset ? String(lastOffset) : null });
  }, [reportOffset, reportsQuery.data]);

  function updateFilters(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next);
  }

  function setView(nextView: "archive" | "activity") {
    updateFilters({ view: nextView === "archive" ? null : nextView });
  }

  function submitArchiveSearch(event: FormEvent) {
    event.preventDefault();
    updateFilters({ q: searchDraft.trim() || null, archive_offset: null });
  }

  function submitTaskFilter(event: FormEvent) {
    event.preventDefault();
    updateFilters({ task_id: taskDraft.trim() || null, activity_offset: null });
  }

  function changeArchivePage(offset: number) {
    updateFilters({ archive_offset: offset > 0 ? String(offset) : null });
  }

  function changeActivityPage(offset: number) {
    updateFilters({ activity_offset: offset > 0 ? String(offset) : null });
  }

  function changeReportPage(offset: number) {
    updateFilters({ reports_offset: offset > 0 ? String(offset) : null });
  }

  function removeActivity(activity: Activity) {
    if (deleteActivity.isPending || clearTaskHistory.isPending) return;
    if (!window.confirm("只删除这条活动记录？任务和工作汇报会保留。")) return;
    deleteActivity.mutate(activity.id);
  }

  function confirmClearTaskHistory(id: string, state: "archived" | "current" | "unknown") {
    if (deleteActivity.isPending || clearTaskHistory.isPending) return;
    const impact = state === "archived"
      ? "永久删除此归档任务、全部工作汇报和全部活动记录。"
      : state === "current"
        ? "永久删除此任务的全部工作汇报和活动记录；当前任务及其状态会保留。"
        : "永久删除此任务的全部历史。若任务仍在当前列表中，只删除工作汇报和活动并保留任务；若任务已归档，则连同归档任务一起删除。";
    if (!window.confirm(`${impact}此操作无法撤销。`)) return;
    if (!window.confirm(`请再次确认：${impact}`)) return;
    clearTaskHistory.mutate(id);
  }

  if (taskId) {
    if (taskQuery.isPending) return <p role="status" className="py-16 text-center text-sm text-[#69776d]">正在加载归档任务…</p>;
    if (taskQuery.isError) return <div className="space-y-4"><Link className="quiet-link" to="/history?view=archive"><ArrowLeft size={15} /> 返回历史记录</Link><ApiFeedback error={taskQuery.error} onRetry={() => void taskQuery.refetch()} /></div>;
    const task = taskQuery.data.task;
    const reportData = reportsQuery.data;
    const reportPages = reportData ? Math.max(1, Math.ceil(reportData.total / reportData.limit)) : 1;
    const reportPage = reportData ? Math.floor(reportData.offset / reportData.limit) + 1 : 1;
    return <div className="space-y-5">
      <Link className="quiet-link" to="/history?view=archive"><ArrowLeft size={15} /> 返回历史记录</Link>
      <section className="card">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="eyebrow">归档任务 · 只读</p>
            <h2 className="page-title mt-1 break-words">{task.title}</h2>
          </div>
          <button type="button" className="danger-btn shrink-0" disabled={clearTaskHistory.isPending}
            onClick={() => confirmClearTaskHistory(task.id, "archived")}>
            <Trash2 size={15} />{clearTaskHistory.isPending ? "正在清除…" : "清除归档及全部历史"}
          </button>
        </div>
        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          <div><dt className="eyebrow">任务说明</dt><dd className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[#46574c]">{task.description || "暂无说明"}</dd></div>
          <div className="grid content-start gap-4 sm:grid-cols-2">
            <div><dt className="eyebrow">删除时状态</dt><dd className="mt-2 text-sm">{statusLabels[task.status]}</dd></div>
            <div><dt className="eyebrow">任务 ID</dt><dd className="mt-2 break-all font-mono text-xs text-[#66746a]">{task.id}</dd></div>
            <div><dt className="eyebrow">创建时间</dt><dd className="mt-2 text-sm">{formatDate(task.created_at)}</dd></div>
            <div><dt className="eyebrow">最后更新</dt><dd className="mt-2 text-sm">{formatDate(task.updated_at)}</dd></div>
            <div><dt className="eyebrow">归档时间</dt><dd className="mt-2 text-sm">{formatDate(task.archived_at)}</dd></div>
          </div>
        </dl>
        <p className="mt-5 rounded-lg bg-[#f2f6ef] p-3 text-xs leading-5 text-[#53675a]">归档内容只读。清除归档会删除此任务、全部报告和与任务相关的全部活动。</p>
        {clearTaskHistory.isError && <div className="mt-4"><ApiFeedback error={clearTaskHistory.error} /></div>}
      </section>

      <section className="card">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div><p className="eyebrow">完整历史</p><h3 className="mt-1 text-lg font-semibold">工作汇报</h3></div>
          <span className="text-xs text-[#6a776e]">{reportData ? `共 ${reportData.total} 条` : ""}</span>
        </div>
        {reportsQuery.isError && <ApiFeedback error={reportsQuery.error} onRetry={() => void reportsQuery.refetch()} />}
        {reportsQuery.isPending && <p role="status" className="py-8 text-center text-sm text-[#69776d]">正在加载历史汇报…</p>}
        {reportData?.reports.length === 0 && <p className="py-8 text-center text-sm text-[#69776d]">此任务没有工作汇报。</p>}
        {reportData && reportData.reports.length > 0 && <div className="divide-y divide-[#edf1ea]">
          {reportData.reports.map((report) => <article key={report.id} className="py-4 first:pt-1 last:pb-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-[#2f7253]">{report.actor_name || (report.source === "agent" ? "Agent" : "用户")}</span>
              <time className="text-xs text-[#718076]">{formatDate(report.created_at)}</time>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[#46574c]">{report.content}</p>
          </article>)}
        </div>}
        {reportData && reportData.total > reportData.limit && <div className="mt-4 flex items-center justify-end gap-3 border-t border-[#edf1ea] pt-4">
          <span className="text-xs text-[#66746a]">第 {reportPage} / {reportPages} 页</span>
          <button type="button" aria-label="上一页汇报" className="icon-btn" disabled={reportOffset === 0 || reportsQuery.isFetching}
            onClick={() => changeReportPage(Math.max(0, reportOffset - reportData.limit))}><ArrowLeft size={16} /></button>
          <button type="button" aria-label="下一页汇报" className="icon-btn" disabled={reportOffset + reportData.limit >= reportData.total || reportsQuery.isFetching}
            onClick={() => changeReportPage(reportOffset + reportData.limit)}><ArrowRight size={16} /></button>
        </div>}
      </section>
    </div>;
  }

  const archiveData = archivesQuery.data;
  const activityData = activityQuery.data;
  return <div className="space-y-6">
    <div>
      <p className="eyebrow">工作区</p>
      <h2 className="page-title">历史</h2>
      <p className="mt-2 text-sm text-[#56655a]">查看只读归档任务和可管理的活动记录。</p>
    </div>

    <div role="group" aria-label="历史类型" className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={view === "archive"} className={view === "archive" ? "primary-btn" : "secondary-btn"} onClick={() => setView("archive")}>
        <Archive size={15} />归档任务
      </button>
      <button type="button" aria-pressed={view === "activity"} className={view === "activity" ? "primary-btn" : "secondary-btn"} onClick={() => setView("activity")}>
        <Clock3 size={15} />活动记录
      </button>
    </div>

    {view === "archive" && <section aria-label="归档任务" className="card min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><p className="eyebrow">只读快照</p><h3 className="mt-1 text-lg font-semibold">归档任务</h3></div>
        <span className="text-sm text-[#68766c]">{archiveData ? `共 ${archiveData.total} 项` : "正在读取…"}</span>
      </div>
      <form onSubmit={submitArchiveSearch} className="mb-4 flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="history-search">搜索归档任务</label>
        <input id="history-search" className="input min-w-0 flex-1" type="search" maxLength={200} placeholder="搜索标题或说明"
          value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
        <button type="submit" className="secondary-btn">搜索</button>
      </form>
      {archivesQuery.isError && <ApiFeedback error={archivesQuery.error} onRetry={() => void archivesQuery.refetch()} />}
      {archivesQuery.isPending && <p role="status" className="py-12 text-center text-sm text-[#69776d]">正在加载归档任务…</p>}
      {archiveData && archiveData.tasks.length === 0 && <p className="py-12 text-center text-sm text-[#69776d]">{q ? "没有符合条件的归档任务。" : "还没有归档任务。"}</p>}
      {archiveData && archiveData.tasks.length > 0 && <div className="divide-y divide-[#edf1ea]">
        {archiveData.tasks.map((task: ArchivedTask) => <Link key={task.id} to={`/history/tasks/${task.id}`} className="flex min-h-16 items-center gap-3 py-3 first:pt-1">
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-semibold text-[#203e30]">{task.title}</span>
            <span className="mt-1 block truncate text-xs text-[#69776d]">{task.description || "暂无说明"}</span>
          </span>
          <span className="shrink-0 rounded-full bg-[#f2f6ef] px-2.5 py-1 text-xs text-[#4e6c56]">{statusLabels[task.status]}</span>
          <time className="hidden shrink-0 text-xs text-[#718076] sm:block">归档于 {formatDate(task.archived_at)}</time>
          <ArrowRight className="shrink-0 text-[#789180]" size={16} />
        </Link>)}
      </div>}
      {archiveData && <HistoryPager offset={archiveOffset} limit={archiveData.limit} total={archiveData.total} fetching={archivesQuery.isFetching} onChange={changeArchivePage} />}
    </section>}

    {view === "activity" && <section aria-label="活动记录" className="card min-w-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><p className="eyebrow">工作区记录</p><h3 className="mt-1 text-lg font-semibold">活动记录</h3></div>
        <span className="text-sm text-[#68766c]">{activityData ? `共 ${activityData.total} 条` : "正在读取…"}</span>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs font-medium text-[#56655a]">活动类型
          <select aria-label="按活动类型筛选" className="input mt-1.5" value={eventType}
            onChange={(event) => updateFilters({ event_type: event.target.value || null, activity_offset: null })}>
            <option value="">全部类型</option>
            {(Object.entries(eventLabels) as [ActivityEventType, string][]).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-[#56655a]">来源
          <select aria-label="按来源筛选" className="input mt-1.5" value={source}
            onChange={(event) => updateFilters({ source: event.target.value || null, activity_offset: null })}>
            <option value="">全部来源</option><option value="user">用户</option><option value="agent">Agent</option>
          </select>
        </label>
        <form onSubmit={submitTaskFilter} className="sm:col-span-2">
          <label className="block text-xs font-medium text-[#56655a]" htmlFor="activity-task-id">任务 ID</label>
          <div className="mt-1.5 flex min-w-0 gap-2">
            <input id="activity-task-id" className="input min-w-0 flex-1" value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} placeholder="输入任务 ID" />
            <button type="submit" className="secondary-btn">筛选</button>
          </div>
        </form>
      </div>
      {(deleteActivity.isError || clearTaskHistory.isError) && <div className="mb-4"><ApiFeedback error={deleteActivity.error ?? clearTaskHistory.error} /></div>}
      {activityQuery.isError && <ApiFeedback error={activityQuery.error} onRetry={() => void activityQuery.refetch()} />}
      {activityQuery.isPending && <p role="status" className="py-12 text-center text-sm text-[#69776d]">正在加载活动记录…</p>}
      {activityData && activityData.activities.length === 0 && <p className="py-12 text-center text-sm text-[#69776d]">没有符合条件的活动记录。</p>}
      {activityData && activityData.activities.length > 0 && <div className="divide-y divide-[#edf1ea]">
        {activityData.activities.map((activity) => <article key={activity.id} className="min-w-0 py-4 first:pt-1">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[#e9f3e6] px-2.5 py-1 text-xs font-semibold text-[#24523a]">{eventLabels[activity.event_type]}</span>
                <span className="text-xs text-[#66746a]">{activity.actor_name || (activity.actor_type === "agent" ? "Agent" : "用户")}</span>
                <time className="text-xs text-[#718076]">{formatDate(activity.occurred_at)}</time>
              </div>
              <p className="mt-2 break-words text-sm font-semibold text-[#203e30]">{activity.task_title}</p>
              <p className="mt-1 break-words text-xs leading-5 text-[#66746a]">{activitySummary(activity)}</p>
              <p className="mt-1 break-all font-mono text-[11px] text-[#89958c]">任务 ID：{activity.task_id}</p>
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <button type="button" className="secondary-btn" disabled={deleteActivity.isPending || clearTaskHistory.isPending}
                onClick={() => removeActivity(activity)}><Trash2 size={14} />删除此活动</button>
              <button type="button" className="danger-btn" disabled={deleteActivity.isPending || clearTaskHistory.isPending}
                onClick={() => confirmClearTaskHistory(activity.task_id, "unknown")}>
                <FileText size={14} />清除任务全部历史
              </button>
            </div>
          </div>
        </article>)}
      </div>}
      {activityData && <HistoryPager offset={activityOffset} limit={activityData.limit} total={activityData.total} fetching={activityQuery.isFetching} onChange={changeActivityPage} />}
    </section>}
  </div>;
}
