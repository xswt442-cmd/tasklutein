import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { api } from "../api";
import type { Inbox } from "../api";
import { ApiFeedback } from "../components/ApiFeedback";
import { useWorkspace } from "../workspace";

export function InboxPage() {
  const { workspace } = useWorkspace();
  const [offset, setOffset] = useState(0);
  const inbox = useQuery({ queryKey: ["inbox", workspace.id, 25, offset], queryFn: () => api<Inbox>(`/inbox?limit=25&offset=${offset}`) });
  useEffect(() => {
    if (!inbox.data || offset === 0 || offset < inbox.data.total) return;
    const lastOffset = inbox.data.total === 0
      ? 0
      : Math.floor((inbox.data.total - 1) / inbox.data.limit) * inbox.data.limit;
    setOffset(lastOffset);
  }, [inbox.data, offset]);
  return <div className="space-y-5"><header><p className="eyebrow">工作入口</p><h2 className="page-title">待我处理</h2><p className="mt-2 text-sm text-[#56655a]">当前工作区分配给你的任务，以及等待你评审的最新汇报。</p></header>
    {inbox.isError && <ApiFeedback error={inbox.error} onRetry={() => void inbox.refetch()} />}
    {inbox.isPending && <section className="card py-10 text-center text-sm">正在加载待处理事项…</section>}
    {inbox.data && <><section className="card"><h3 className="text-lg font-semibold">分配给我的任务 <span className="text-sm font-normal text-[#68766c]">{inbox.data.tasks.length}</span></h3>{inbox.data.tasks.length === 0 && <p className="py-6 text-center text-sm text-[#68766c]">这一页没有分配给你的任务。</p>}<div className="divide-y divide-[#edf1ea]">{inbox.data.tasks.map((task) => <Link key={task.id} to={`/tasks/${task.id}`} className="flex items-center gap-3 py-3"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{task.title}</span><span className="block truncate text-xs text-[#68766c]">{task.description || "暂无说明"}</span></span><span className="text-xs text-[#4e6c56]">{task.status === "todo" ? "待处理" : task.status === "in_progress" ? "进行中" : "已完成"}</span><ArrowRight size={16} /></Link>)}</div></section>
      <section className="card"><h3 className="text-lg font-semibold">待我评审的汇报 <span className="text-sm font-normal text-[#68766c]">{inbox.data.reports.length}</span></h3>{inbox.data.reports.length === 0 && <p className="py-6 text-center text-sm text-[#68766c]">这一页没有等待评审的汇报。</p>}<div className="divide-y divide-[#edf1ea]">{inbox.data.reports.map(({ report, task_id, task_title }) => <Link key={report.id} to={`/tasks/${task_id}`} className="block py-4"><div className="flex flex-wrap justify-between gap-2"><span className="text-sm font-semibold">{task_title}</span><span className="text-xs text-[#68766c]">{report.actor_name || (report.source === "agent" ? "Agent" : "成员")} · {new Date(report.created_at).toLocaleString("zh-CN")}</span></div><p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-[#46574c]">{report.content}</p><span className="quiet-link mt-1">查看并评审 <ArrowRight size={14} /></span></Link>)}</div></section>
      {(inbox.data.total > inbox.data.limit || offset > 0) && <section className="flex items-center justify-end gap-3 text-xs text-[#66746a]"><span>第 {Math.floor(offset / inbox.data.limit) + 1} / {Math.max(1, Math.ceil(inbox.data.total / inbox.data.limit))} 页</span><button className="icon-btn" aria-label="上一页待处理事项" disabled={offset === 0 || inbox.isFetching} onClick={() => setOffset(Math.max(0, offset - inbox.data.limit))}><ArrowLeft size={16} /></button><button className="icon-btn" aria-label="下一页待处理事项" disabled={offset + inbox.data.limit >= inbox.data.total || inbox.isFetching} onClick={() => setOffset(offset + inbox.data.limit)}><ArrowRight size={16} /></button></section>}</>}
  </div>;
}
