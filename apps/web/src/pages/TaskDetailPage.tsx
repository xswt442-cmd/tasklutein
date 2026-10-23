import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Pencil, Save, Send, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import type { ReportCommentPage, ReportPage, Task, TaskStatus } from "../api";
import { ApiFeedback } from "../components/ApiFeedback";

const statusLabels: Record<TaskStatus, string> = {
  todo: "待处理",
  in_progress: "进行中",
  done: "已完成",
};

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ReportComments({ reportId }: { reportId: string }) {
  const [expanded, setExpanded] = useState(false);
  return <div className="mt-4 border-t border-[#edf1ea] pt-3">
    <button type="button" className="quiet-link" aria-expanded={expanded} aria-controls={`report-comments-${reportId}`} onClick={() => setExpanded((open) => !open)}>
      {expanded ? "收起评论" : "查看评论"}
    </button>
    <div id={`report-comments-${reportId}`} hidden={!expanded}>{expanded && <CurrentReportComments reportId={reportId} />}</div>
  </div>;
}

function CurrentReportComments({ reportId }: { reportId: string }) {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState("");
  const commentsQuery = useQuery({
    queryKey: ["report-comments", reportId, 25, offset],
    queryFn: () => api<ReportCommentPage>(`/reports/${reportId}/comments?limit=25&offset=${offset}`),
  });
  const createComment = useMutation({
    mutationFn: () => api(`/reports/${reportId}/comments`, { method: "POST", body: JSON.stringify({ content: draft.trim() }) }),
    onSuccess: async () => { setDraft(""); setOffset(0); await queryClient.invalidateQueries({ queryKey: ["report-comments", reportId] }); },
  });
  const deleteComment = useMutation({
    mutationFn: (commentId: string) => api<void>(`/reports/${reportId}/comments/${commentId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["report-comments", reportId] }),
  });
  function submit(event: FormEvent) { event.preventDefault(); if (draft.trim() && !createComment.isPending) createComment.mutate(); }
  return <div>
    <h4 className="text-xs font-semibold text-[#53675a]">评论</h4>
    <form onSubmit={submit} className="mt-2 flex flex-col gap-2 sm:flex-row">
      <label className="sr-only" htmlFor={`comment-${reportId}`}>添加评论</label>
      <input id={`comment-${reportId}`} className="input min-w-0 flex-1" maxLength={2000} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="添加评论…" />
      <button className="secondary-btn" type="submit" disabled={!draft.trim() || createComment.isPending}>{createComment.isPending ? "正在提交…" : "评论"}</button>
    </form>
    {createComment.isError && <ApiFeedback error={createComment.error} />}
    {commentsQuery.isError && <ApiFeedback error={commentsQuery.error} onRetry={() => void commentsQuery.refetch()} />}
    {commentsQuery.isPending && <p className="mt-2 text-xs text-[#69776d]">正在加载评论…</p>}
    {commentsQuery.data?.total === 0 && !commentsQuery.isError && <p className="mt-2 text-xs text-[#69776d]">还没有评论。</p>}
    {commentsQuery.data?.comments.map((comment) => <div key={comment.id} className="mt-3 flex items-start justify-between gap-3 rounded-lg bg-[#f8faf5] p-3">
      <div className="min-w-0"><div className="flex flex-wrap gap-2 text-[11px] text-[#718076]"><span>{comment.actor_name || (comment.source === "agent" ? "Agent" : "用户")}</span><time>{formatDate(comment.created_at)}</time></div><p className="mt-1 whitespace-pre-wrap break-words text-sm text-[#46574c]">{comment.content}</p></div>
      <button type="button" className="quiet-link shrink-0" disabled={deleteComment.isPending} onClick={() => { if (window.confirm("删除这条评论？")) deleteComment.mutate(comment.id); }}>删除</button>
    </div>)}
    {deleteComment.isError && <ApiFeedback error={deleteComment.error} />}
    {commentsQuery.data && commentsQuery.data.total > commentsQuery.data.limit && <div className="mt-2 flex items-center justify-end gap-2 text-xs text-[#66746a]">
      <span>评论 {offset + 1}–{Math.min(offset + commentsQuery.data.comments.length, commentsQuery.data.total)} / {commentsQuery.data.total}</span>
      <button type="button" className="icon-btn" aria-label="上一页评论" disabled={offset === 0 || commentsQuery.isFetching} onClick={() => setOffset(Math.max(0, offset - commentsQuery.data!.limit))}><ArrowLeft size={14} /></button>
      <button type="button" className="icon-btn" aria-label="下一页评论" disabled={offset + commentsQuery.data.limit >= commentsQuery.data.total || commentsQuery.isFetching} onClick={() => setOffset(offset + commentsQuery.data!.limit)}><ArrowRight size={14} /></button>
    </div>}
  </div>;
}

export function TaskDetailPage() {
  const { taskId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [showDeleteOptions, setShowDeleteOptions] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [reportDraft, setReportDraft] = useState("");
  const reportOffsetValue = Number(searchParams.get("reports_offset") ?? 0);
  const reportOffset = Number.isSafeInteger(reportOffsetValue) && reportOffsetValue >= 0 ? reportOffsetValue : 0;

  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api<{ task: Task }>("/tasks/" + taskId),
    enabled: Boolean(taskId),
  });
  const reportsQuery = useQuery({
    queryKey: ["reports", taskId, 25, reportOffset],
    queryFn: () => api<ReportPage>(`/tasks/${taskId}/reports?limit=25&offset=${reportOffset}`),
    enabled: Boolean(taskId),
  });

  useEffect(() => {
    if (!reportsQuery.data || reportOffset === 0 || reportOffset < reportsQuery.data.total) return;
    const lastOffset = reportsQuery.data.total === 0
      ? 0
      : Math.floor((reportsQuery.data.total - 1) / reportsQuery.data.limit) * reportsQuery.data.limit;
    const next = new URLSearchParams(searchParams);
    if (lastOffset === 0) next.delete("reports_offset");
    else next.set("reports_offset", String(lastOffset));
    setSearchParams(next, { replace: true });
  }, [reportOffset, reportsQuery.data, searchParams, setSearchParams]);

  const updateTask = useMutation({
    mutationFn: (changes: Partial<Pick<Task, "title" | "description" | "status">>) =>
      api<{ task: Task }>("/tasks/" + taskId, { method: "PATCH", body: JSON.stringify(changes) }),
    onSuccess: async ({ task }) => {
      queryClient.setQueryData(["task", taskId], { task });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["activity"] }),
      ]);
      setEditing(false);
    },
  });

  const addReport = useMutation({
    mutationFn: () => api(`/tasks/${taskId}/reports`, {
      method: "POST",
      body: JSON.stringify({ content: reportDraft.trim() }),
    }),
    onSuccess: async () => {
      setReportDraft("");
      const next = new URLSearchParams(searchParams);
      next.delete("reports_offset");
      setSearchParams(next, { replace: true });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["reports", taskId] }),
        queryClient.invalidateQueries({ queryKey: ["activity"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
    },
  });

  const deleteTask = useMutation({
    mutationFn: (history: "keep" | "delete") => api<void>(`/tasks/${taskId}?history=${history}`, { method: "DELETE" }),
    onSuccess: async (_result, history) => {
      navigate(history === "keep" ? `/history/tasks/${taskId}` : "/tasks");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["activity"] }),
        queryClient.invalidateQueries({ queryKey: ["history"] }),
        queryClient.invalidateQueries({ queryKey: ["reports", taskId] }),
        queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
      ]);
    },
  });

  function beginEditing(task: Task) {
    setEditTitle(task.title);
    setEditDescription(task.description);
    setEditing(true);
    updateTask.reset();
  }

  function saveDetails(event: FormEvent) {
    event.preventDefault();
    if (!editTitle.trim() || updateTask.isPending) return;
    updateTask.mutate({ title: editTitle.trim(), description: editDescription });
  }

  function submitReport(event: FormEvent) {
    event.preventDefault();
    if (!reportDraft.trim() || addReport.isPending) return;
    addReport.mutate();
  }

  function removeTask(history: "keep" | "delete") {
    if (deleteTask.isPending) return;
    const message = history === "keep"
      ? "删除当前任务并保留历史？任务字段、全部工作汇报和活动会保存到历史页面，只读查看。"
      : "删除任务及历史记录？任务、全部工作汇报和活动会立即永久删除。此操作无法撤销。";
    if (!window.confirm(message)) return;
    deleteTask.mutate(history);
  }

  function changeReportPage(offset: number) {
    const next = new URLSearchParams(searchParams);
    if (offset > 0) next.set("reports_offset", String(offset));
    else next.delete("reports_offset");
    setSearchParams(next);
  }

  if (taskQuery.isPending) return <p className="py-16 text-center text-sm text-[#69776d]">正在加载任务…</p>;
  if (taskQuery.isError) return <div className="space-y-4"><Link className="quiet-link" to="/tasks"><ArrowLeft size={15} /> 返回任务列表</Link><ApiFeedback error={taskQuery.error} onRetry={() => void taskQuery.refetch()} /></div>;

  const task = taskQuery.data.task;
  const reportData = reportsQuery.data;
  const reportPages = reportData ? Math.max(1, Math.ceil(reportData.total / reportData.limit)) : 1;
  const currentReportPage = reportData ? Math.floor(reportData.offset / reportData.limit) + 1 : 1;

  return <div className="space-y-5">
    <Link className="quiet-link" to="/tasks"><ArrowLeft size={15} /> 返回任务列表</Link>

    <section className="card">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">任务详情</p>
          {editing
            ? <h2 className="page-title mt-1">编辑任务</h2>
            : <h2 className="page-title mt-1 break-words">{task.title}</h2>}
          <p className="mt-2 flex flex-wrap gap-x-1 text-xs text-[#68766c]">
            <span>创建于 <time className="whitespace-nowrap">{formatDate(task.created_at)}</time></span>
            <span aria-hidden="true">·</span>
            <span>最近更新 <time className="whitespace-nowrap">{formatDate(task.updated_at)}</time></span>
          </p>
        </div>
        {!editing && <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
          <button type="button" className="secondary-btn" onClick={() => beginEditing(task)}><Pencil size={15} />编辑</button>
          <button type="button" className="danger-btn" aria-expanded={showDeleteOptions} aria-controls="task-delete-options"
            onClick={() => setShowDeleteOptions((shown) => !shown)} disabled={deleteTask.isPending}>
            <Trash2 size={15} />{deleteTask.isPending ? "正在删除…" : "删除任务"}
          </button>
        </div>}
      </div>

      {!editing && showDeleteOptions && <div id="task-delete-options" className="mt-5 rounded-xl border border-[#e6ece3] bg-[#f8faf5] p-4">
        <h3 className="text-sm font-semibold">选择删除方式</h3>
        <p className="mt-1 text-xs leading-5 text-[#66746a]">归档后任务从当前列表移除，任务字段、报告和活动会保留在历史页面。</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <button type="button" className="primary-btn justify-center" disabled={deleteTask.isPending} onClick={() => removeTask("keep")}>
            删除任务（保留历史，推荐）
          </button>
          <button type="button" className="danger-btn justify-center" disabled={deleteTask.isPending} onClick={() => removeTask("delete")}>
            删除任务及历史记录
          </button>
        </div>
        {deleteTask.isError && <div className="mt-3"><ApiFeedback error={deleteTask.error} /></div>}
      </div>}

      {editing
        ? <form onSubmit={saveDetails} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">标题
            <input className="input mt-1.5" value={editTitle} maxLength={120} required autoFocus
              onChange={(event) => setEditTitle(event.target.value)} />
          </label>
          <label className="block text-sm font-medium">说明
            <textarea className="input mt-1.5 min-h-32 resize-y" value={editDescription} maxLength={4000}
              onChange={(event) => setEditDescription(event.target.value)} />
          </label>
          {updateTask.isError && <ApiFeedback error={updateTask.error} />}
          <div className="flex justify-end gap-2">
            <button type="button" className="secondary-btn" onClick={() => setEditing(false)}><X size={15} />取消</button>
            <button type="submit" className="primary-btn" disabled={!editTitle.trim() || updateTask.isPending}>
              <Save size={15} />{updateTask.isPending ? "正在保存…" : "保存"}
            </button>
          </div>
        </form>
        : <div className="mt-6 grid gap-5 md:grid-cols-[1fr_220px]">
          <div>
            <h3 className="eyebrow">任务说明</h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[#46574c]">{task.description || "暂无说明"}</p>
          </div>
          <label className="block text-sm font-medium">任务状态
            <select className="input mt-1.5" value={task.status} disabled={updateTask.isPending}
              onChange={(event) => updateTask.mutate({ status: event.target.value as TaskStatus })}>
              {(Object.entries(statusLabels) as [TaskStatus, string][]).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
        </div>}
      {updateTask.isError && !editing && <div className="mt-4"><ApiFeedback error={updateTask.error} /></div>}
    </section>

    <section className="card">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <p className="eyebrow">任务记录</p>
          <h3 className="mt-1 text-lg font-semibold">工作汇报</h3>
        </div>
        <span className="text-xs text-[#6a776e]">{reportData ? `共 ${reportData.total} 条` : ""}</span>
      </div>

      <form onSubmit={submitReport} className="mb-6 space-y-3 rounded-xl border border-[#e6ece3] bg-[#f8faf5] p-4">
        <label htmlFor="report-content" className="text-sm font-medium">添加工作汇报</label>
        <textarea id="report-content" aria-label="工作汇报内容" className="input min-h-24 resize-y" maxLength={8000}
          value={reportDraft} placeholder="记录实际完成的工作、测试和结果…"
          onChange={(event) => setReportDraft(event.target.value)} required />
        {addReport.isError && <ApiFeedback error={addReport.error} />}
        <button type="submit" className="primary-btn" disabled={!reportDraft.trim() || addReport.isPending}>
          <Send size={15} />{addReport.isPending ? "正在提交…" : "添加汇报"}
        </button>
      </form>

      {reportsQuery.isError && <ApiFeedback error={reportsQuery.error} onRetry={() => void reportsQuery.refetch()} />}
      {reportsQuery.isPending && <p className="py-8 text-center text-sm text-[#69776d]">正在加载汇报…</p>}
      {reportData?.reports.length === 0 && <p className="py-8 text-center text-sm text-[#69776d]">暂无汇报。Agent 也可以通过 MCP 在这里记录进度。</p>}
      {reportData && reportData.reports.length > 0 && <div className="divide-y divide-[#edf1ea]">
        {reportData.reports.map((report) => <article key={report.id} className="py-4 first:pt-1 last:pb-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-[#2f7253]">{report.actor_name || (report.source === "agent" ? "Agent" : "人工")}</span>
            <time className="text-xs text-[#718076]">{formatDate(report.created_at)}</time>
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[#46574c]">{report.content}</p>
          <ReportComments reportId={report.id} />
        </article>)}
      </div>}

      {reportData && reportData.total > reportData.limit && <div className="mt-4 flex items-center justify-end gap-3 border-t border-[#edf1ea] pt-4">
        <span className="text-xs text-[#66746a]">第 {currentReportPage} / {reportPages} 页</span>
        <button type="button" aria-label="上一页汇报" className="icon-btn" disabled={reportOffset === 0 || reportsQuery.isFetching}
          onClick={() => changeReportPage(Math.max(0, reportOffset - reportData.limit))}><ArrowLeft size={16} /></button>
        <button type="button" aria-label="下一页汇报" className="icon-btn" disabled={reportOffset + reportData.limit >= reportData.total || reportsQuery.isFetching}
          onClick={() => changeReportPage(reportOffset + reportData.limit)}><ArrowRight size={16} /></button>
      </div>}
    </section>
  </div>;
}
