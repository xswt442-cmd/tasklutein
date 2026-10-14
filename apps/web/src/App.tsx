import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, Circle, ClipboardList, LogOut, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { api, ApiError } from "./api";
import type { Report, Task, TaskStatus } from "./api";

const labels: Record<TaskStatus, string> = { todo: "待处理", in_progress: "进行中", done: "已完成" };
const statuses: TaskStatus[] = ["todo", "in_progress", "done"];
const formatDate = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("tasklutein_token") ?? "");
  const [draftToken, setDraftToken] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reportContent, setReportContent] = useState("");
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const visible = tasks.filter((task) => filter === "all" || task.status === filter);
  const counts = Object.fromEntries(statuses.map((status) => [status, tasks.filter((task) => task.status === status).length])) as Record<TaskStatus, number>;

  async function loadTasks(currentToken: string) {
    setLoading(true);
    try {
      const result = await api<{ tasks: Task[] }>(currentToken, "/tasks");
      setTasks(result.tasks);
      setSelectedId((id) => id && result.tasks.some((task) => task.id === id) ? id : result.tasks[0]?.id ?? null);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法加载任务");
      if (err instanceof ApiError && err.status === 401) {
        sessionStorage.removeItem("tasklutein_token");
        setToken("");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) void loadTasks(token);
  }, [token]);

  useEffect(() => {
    if (!token || !selectedId) {
      setReports([]);
      return;
    }
    let active = true;
    void api<{ reports: Report[] }>(token, "/tasks/" + selectedId + "/reports")
      .then((result) => { if (active) setReports(result.reports); })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : "读取汇报失败"); });
    return () => { active = false; };
  }, [token, selectedId]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(draftToken.trim(), "/tasks");
      sessionStorage.setItem("tasklutein_token", draftToken.trim());
      setToken(draftToken.trim());
      setDraftToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接失败");
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    sessionStorage.removeItem("tasklutein_token");
    setToken("");
    setTasks([]);
    setReports([]);
    setSelectedId(null);
    setMessage("");
    setError("");
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try { await task(); } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally { setBusy(false); }
  }

  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    await run(async () => {
      const result = await api<{ task: Task }>(token, "/tasks", {
        method: "POST", body: JSON.stringify({ title: title.trim(), description })
      });
      setTitle("");
      setDescription("");
      await loadTasks(token);
      setSelectedId(result.task.id);
      setMessage("任务已创建");
    });
  }

  async function updateStatus(id: string, status: TaskStatus) {
    await run(async () => {
      await api(token, "/tasks/" + id, { method: "PATCH", body: JSON.stringify({ status }) });
      await loadTasks(token);
      setMessage("状态已更新");
    });
  }

  async function deleteTask(id: string) {
    if (!window.confirm("确定删除任务及其全部汇报？")) return;
    await run(async () => {
      await api(token, "/tasks/" + id, { method: "DELETE" });
      await loadTasks(token);
      setMessage("任务已删除");
    });
  }

  async function addReport(event: FormEvent) {
    event.preventDefault();
    if (!selectedId || !reportContent.trim()) return;
    await run(async () => {
      const result = await api<{ report: Report }>(token, "/tasks/" + selectedId + "/reports", {
        method: "POST", body: JSON.stringify({ content: reportContent.trim(), source: "user" })
      });
      setReports((current) => [result.report, ...current]);
      setReportContent("");
      setMessage("汇报已保存");
    });
  }

  if (!token) {
    return <main className="min-h-screen flex items-center justify-center p-5 bg-[#f5f7f0]">
      <section className="w-full max-w-md rounded-3xl bg-white border border-[#e3e9df] p-8 shadow-sm">
        <img src="/mark.svg" width="60" height="60" alt="Tasklutein" />
        <p className="text-xs uppercase tracking-[0.25em] text-emerald-700 mt-5">Human × Agent Workflow</p>
        <h1 className="text-3xl font-bold mt-2 text-[#18382a]">Tasklutein</h1>
        <p className="text-[#66736a] mt-3 mb-8 leading-relaxed">让你的任务、AI Agent 的进度与工作汇报同步在一个地方。</p>
        <form onSubmit={(event) => void signIn(event)} className="space-y-4">
          <label className="block text-sm font-semibold text-[#284437]">工作空间访问令牌
            <input type="password" value={draftToken} onChange={(event) => setDraftToken(event.target.value)} placeholder="输入 WEB_ACCESS_TOKEN" autoComplete="off" required className="mt-2 w-full input" />
          </label>
          <button className="primary-btn w-full" disabled={busy}>进入工作空间 <ArrowRight size={16} /></button>
        </form>
        {error && <p role="alert" className="text-red-700 mt-4 text-sm">{error}</p>}
        <p className="text-xs text-[#859087] mt-6">首版为单人工作空间。令牌仅保存在此浏览器会话中，不会写进构建文件。</p>
      </section>
    </main>;
  }

  return <div className="min-h-screen bg-[#f5f7f0] text-[#18382a]">
    <header className="bg-white border-b border-[#e2e8dd] sticky top-0 z-10">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <img src="/mark.svg" width="40" height="40" alt="" />
          <div><h1 className="font-bold text-xl tracking-tight">Tasklutein</h1><p className="text-xs text-[#7c887d]">Tasks for people & agents</p></div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void loadTasks(token)} title="刷新任务" className="icon-btn" aria-label="刷新任务" disabled={loading}><RefreshCw size={18} /></button>
          <button type="button" onClick={signOut} title="退出" className="icon-btn" aria-label="退出"><LogOut size={18} /></button>
        </div>
      </div>
    </header>
    <main className="max-w-6xl mx-auto px-4 sm:px-8 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-7">
        <div><p className="text-sm text-emerald-700 font-medium">WORKSPACE</p><h2 className="text-3xl font-bold mt-1">任务与汇报</h2><p className="text-[#738175] mt-2">你和已授权的 Agent 看到的是同一份数据。</p></div>
        <span className="inline-flex items-center gap-2 rounded-full border border-[#d6e3d2] bg-[#edf6e8] px-3 py-2 text-sm text-[#386945]"><CheckCircle2 size={15} /> Connected</span>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-6">
        {statuses.map((status) => <div key={status} className="rounded-2xl bg-white border border-[#e2e8dd] p-4"><p className="text-xs sm:text-sm text-[#66776b]">{labels[status]}</p><p className="text-3xl font-bold mt-1">{counts[status]}</p></div>)}
      </div>
      {message && <p role="status" className="mb-4 rounded-lg bg-[#e7f4df] px-4 py-3 text-sm text-[#365f39]">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(290px,0.9fr)] gap-5">
        <section className="card">
          <div className="flex items-center justify-between gap-3 mb-5">
            <h3 className="font-bold text-lg flex items-center gap-2"><ClipboardList size={20}/> 任务列表</h3>
            <span className="text-xs text-[#7b887c]">{tasks.length} tasks</span>
          </div>
          <form onSubmit={(event) => void createTask(event)} className="space-y-3 p-4 rounded-xl bg-[#f6f9f3] border border-[#e6ece3] mb-5">
            <input className="input" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="添加一个新任务…" required />
            <textarea className="input min-h-[70px] resize-y" value={description} maxLength={4000} onChange={(event) => setDescription(event.target.value)} placeholder="可选：任务说明" />
            <button type="submit" className="primary-btn" disabled={busy || !title.trim()}><Plus size={17} /> 创建任务</button>
          </form>
          <div className="flex flex-wrap gap-2 mb-4">
            {(["all", ...statuses] as const).map((status) => <button key={status} type="button" onClick={() => setFilter(status)} className={filter === status ? "filter active" : "filter"}>{status === "all" ? "全部" : labels[status]}</button>)}
          </div>
          <div className="space-y-2">
            {visible.map((task) => <button key={task.id} type="button" onClick={() => setSelectedId(task.id)} className={"text-left task-row " + (selectedId === task.id ? "selected" : "")}>
              {task.status === "done" ? <CheckCircle2 className="text-emerald-700 shrink-0" size={20}/> : <Circle className="text-[#a6b5a9] shrink-0" size={20}/>}
              <span className="flex-1 min-w-0"><span className="block font-semibold truncate">{task.title}</span><span className="block text-xs text-[#849084] mt-1">{labels[task.status]} · {formatDate(task.updated_at)}</span></span>
              <ArrowRight size={16} className="text-[#a3afa2] shrink-0"/>
            </button>)}
            {!visible.length && <div className="py-10 text-center text-sm text-[#89968a]">{loading ? "正在加载…" : "这里还没有任务"}</div>}
          </div>
        </section>
        <section className="card">
          {selected ? <>
            <div className="flex justify-between items-start gap-3 mb-5">
              <div><p className="text-xs uppercase tracking-widest text-[#799282]">TASK DETAIL</p><h3 className="text-xl font-bold mt-2 break-words">{selected.title}</h3></div>
              <button type="button" title="删除任务" aria-label="删除任务" className="icon-btn text-red-700" disabled={busy} onClick={() => void deleteTask(selected.id)}><Trash2 size={18}/></button>
            </div>
            <p className="text-sm text-[#738175] whitespace-pre-wrap mb-5">{selected.description || "没有任务说明"}</p>
            <label className="block text-sm font-semibold mb-5">任务状态
              <select className="input mt-2" value={selected.status} disabled={busy} onChange={(event) => void updateStatus(selected.id, event.target.value as TaskStatus)}>
                {statuses.map((status) => <option key={status} value={status}>{labels[status]}</option>)}
              </select>
            </label>
            <div className="border-t border-[#e9eee6] pt-5">
              <h4 className="font-bold mb-4">工作汇报 <span className="text-[#9ba89e] font-normal text-sm">({reports.length})</span></h4>
              <form onSubmit={(event) => void addReport(event)} className="space-y-3 mb-6">
                <textarea value={reportContent} onChange={(event) => setReportContent(event.target.value)} maxLength={8000} placeholder="记录实际完成的工作、测试和结果…" className="input resize-y min-h-24" required/>
                <button className="primary-btn" disabled={busy || !reportContent.trim()}><Send size={16}/> 添加汇报</button>
              </form>
              <div className="space-y-3">
                {reports.map((report) => <article key={report.id} className="rounded-xl bg-[#f8faf5] border border-[#edf1ea] p-4">
                  <div className="flex items-center justify-between gap-2 mb-2"><span className="text-xs font-semibold uppercase text-[#458466]">{report.source === "agent" ? "Agent" : "You"}</span><time className="text-xs text-[#8b978d]">{formatDate(report.created_at)}</time></div>
                  <p className="text-sm whitespace-pre-wrap break-words">{report.content}</p>
                </article>)}
                {!reports.length && <p className="text-sm text-[#9aa69b]">暂无汇报，Agent 也可以通过 MCP 在这里留下进度。</p>}
              </div>
            </div>
          </> : <div className="text-center py-16"><ArrowLeft size={24} className="mx-auto text-[#a1b0a3] mb-3"/><p className="text-[#8a968c] text-sm">选择左侧任务以查看详情</p></div>}
        </section>
      </div>
      <footer className="text-center text-xs text-[#95a097] py-9">Tasklutein · Open-source task tracking for humans and agents</footer>
    </main>
  </div>;
}
