import { QueryClient, QueryClientProvider, useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, CheckCircle2, Circle, LayoutDashboard, ListTodo, LogOut, RefreshCw, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BrowserRouter, NavLink, Outlet, Route, Routes } from "react-router";
import { api, probeSession } from "./api";
import type { Overview, Session } from "./api";
import { ApiFeedback } from "./components/ApiFeedback";
import { HistoryPage } from "./pages/HistoryPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { TasksPage } from "./pages/TasksPage";

export default function App() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 10_000 }, mutations: { retry: false } },
  }));
  return <QueryClientProvider client={queryClient}><BrowserRouter><Workspace /></BrowserRouter></QueryClientProvider>;
}

function Workspace() {
  const client = useQueryClient();
  const previousUser = useRef<string | null>(null);
  const bootstrap = useQuery({
    queryKey: ["session", "bootstrap"],
    queryFn: probeSession,
  });

  useEffect(() => {
    const userId = bootstrap.data?.user.id;
    if (!userId) return;
    if (previousUser.current && previousUser.current !== userId) client.clear();
    previousUser.current = userId;
  }, [bootstrap.data?.user.id, client]);

  function signOut() {
    client.clear();
    previousUser.current = null;
    window.location.assign("/cdn-cgi/access/logout");
  }

  if (bootstrap.isPending) {
    return <main className="flex min-h-screen items-center justify-center bg-[#f5f7f0] p-6"><p role="status">正在载入 Tasklutein…</p></main>;
  }
  if (bootstrap.isError) {
    return <GuestPreview error={bootstrap.error} onRetry={() => void bootstrap.refetch()} />;
  }
  if (!bootstrap.data) return <GuestPreview />;
  return <WorkspaceRoutes session={bootstrap.data} signOut={signOut} />;
}

function GuestPreview({ error, onRetry }: { error?: Error; onRetry?: () => void }) {
  return <div className="min-h-screen bg-[#f5f7f0] text-[#18382a]">
    <header className="sticky top-0 z-10 border-b border-[#e2e8dd] bg-white"><div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3"><img src="/mark.svg" width="38" height="38" alt="" /><div><p className="font-bold tracking-tight">Tasklutein</p><p className="text-xs text-[#657369]">任务与工作汇报</p></div></div>
      <div className="flex items-center gap-3"><span className="text-xs text-[#53675a]">游客模式</span><a className="primary-btn" href="/api/session/login">登录</a></div>
      <nav aria-label="主导航预览" className="flex w-full gap-2 overflow-x-auto pb-0.5 lg:hidden"><span className="guest-nav-item">Overview</span><span className="guest-nav-item">任务</span><span className="guest-nav-item">历史</span><span className="guest-nav-item">设置</span></nav>
    </div></header>
    <div className="mx-auto grid max-w-[1440px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:px-8 lg:py-8">
      <aside className="hidden lg:block"><div className="sticky top-28 rounded-2xl border border-[#e2e8dd] bg-white p-3"><p className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#768279]">工作区</p>
        <nav aria-label="侧边导航预览" className="space-y-1"><span className="guest-nav-item">Overview</span><span className="guest-nav-item">任务</span><span className="guest-nav-item">历史</span><span className="guest-nav-item">设置</span></nav>
        <div className="mt-5 border-t border-[#edf1ea] px-3 pt-4 text-xs leading-5 text-[#718076]"><span className="block font-medium text-[#53675a]">私人工作区</span>登录后查看</div>
      </div></aside>
      <main className="min-w-0 space-y-6">
        <section className="card flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="eyebrow">工作台预览</p><h1 className="page-title">任务与工作汇报</h1><p className="mt-2 text-sm text-[#56655a]">登录后查看你的任务、统计和近期活动。</p></div><a className="primary-btn" href="/api/session/login">登录以进入工作区</a></section>
        <section aria-label="任务统计预览" className="grid grid-cols-2 gap-3 lg:grid-cols-4">{["当前任务总数", "待处理", "进行中", "已完成"].map((label) => <div className="metric-card" key={label}><span className="metric-icon"><ListTodo size={18} /></span><p className="metric-label">{label}</p><p className="metric-value">—</p></div>)}</section>
        <section className="card"><p className="eyebrow">最近更新</p><h2 className="mt-1 text-lg font-semibold">任务</h2><p className="py-8 text-center text-sm text-[#647268]">登录后查看工作区任务。</p></section>
        <section className="card"><p className="eyebrow">工作区动态</p><h2 className="mt-1 text-lg font-semibold">最近活动</h2><p className="py-6 text-center text-sm text-[#647268]">登录后查看工作区动态。</p></section>
        {error && <section className="card"><ApiFeedback error={error} onRetry={onRetry} /></section>}
        <footer className="py-4 text-center text-xs text-[#718076]">Tasklutein · People and agents working together</footer>
      </main>
    </div>
  </div>;
}

function WorkspaceRoutes({ session, signOut }: { session: Session; signOut: () => void }) {
  return <Routes><Route element={<WorkspaceLayout session={session} signOut={signOut} />}>
    <Route index element={<OverviewPage />} />
    <Route path="tasks" element={<TasksPage />} />
    <Route path="tasks/:taskId" element={<TaskDetailPage />} />
    <Route path="history" element={<HistoryPage />} />
    <Route path="history/tasks/:taskId" element={<HistoryPage />} />
    <Route path="settings" element={<SettingsPage session={session} />} />
    <Route path="*" element={<section className="card text-center"><p className="eyebrow">404</p><h2 className="mt-2 text-xl font-semibold">页面不存在</h2><NavLink to="/" className="primary-btn mt-5 inline-flex">返回工作台</NavLink></section>} />
  </Route></Routes>;
}

function WorkspaceLayout({ session, signOut }: { session: Session; signOut: () => void }) {
  const client = useQueryClient();
  const fetching = useIsFetching() > 0;
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/overview") });
  const status = overview.isError ? "服务暂不可用" : fetching || overview.isPending ? "正在同步" : "工作区已连接";
  return <div className="min-h-screen bg-[#f5f7f0] text-[#18382a]">
    <header className="sticky top-0 z-10 border-b border-[#e2e8dd] bg-white"><div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3"><img src="/mark.svg" width="38" height="38" alt="" /><div><p className="font-bold tracking-tight">Tasklutein</p><p className="text-xs text-[#657369]">任务与工作汇报</p></div></div>
      <div className="flex flex-wrap items-center gap-3"><span className="text-xs text-[#53675a]">{session.user.email}</span>
        <span role="status" aria-live="polite" className={`hidden items-center gap-2 text-xs sm:inline-flex ${overview.isError ? "text-red-700" : "text-[#5b7360]"}`}>
          {overview.isError ? <Circle size={13} /> : fetching ? <RefreshCw size={13} /> : <CheckCircle2 size={13} />}{status}
        </span>
        <button type="button" className="secondary-btn" aria-label="刷新数据" onClick={() => void client.invalidateQueries()} disabled={fetching}><RefreshCw size={15} /><span className="hidden sm:inline">刷新</span></button>
        <button type="button" className="secondary-btn" onClick={signOut}><LogOut size={15} /><span>退出</span></button>
      </div>
      <nav aria-label="主导航" className="flex w-full gap-2 overflow-x-auto pb-0.5 lg:hidden"><NavItem to="/" end><LayoutDashboard size={15} />Overview</NavItem><NavItem to="/tasks"><ListTodo size={15} />任务</NavItem><NavItem to="/history"><Archive size={15} />历史</NavItem><NavItem to="/settings"><Settings size={15} />设置</NavItem></nav>
    </div></header>
    <div className="mx-auto grid max-w-[1440px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:px-8 lg:py-8">
      <aside className="hidden lg:block"><div className="sticky top-28 rounded-2xl border border-[#e2e8dd] bg-white p-3"><p className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#768279]">工作区</p>
        <nav aria-label="侧边导航" className="space-y-1"><NavItem to="/" end><LayoutDashboard size={17} />Overview</NavItem><NavItem to="/tasks"><ListTodo size={17} />任务</NavItem><NavItem to="/history"><Archive size={17} />历史</NavItem><NavItem to="/settings"><Settings size={17} />设置</NavItem></nav>
        <div className="mt-5 border-t border-[#edf1ea] px-3 pt-4 text-xs leading-5 text-[#718076]"><span className="block font-medium text-[#53675a]">私人工作区</span>{session.workspace.name}</div>
      </div></aside>
      <main className="min-w-0"><Outlet /><footer className="py-8 text-center text-xs text-[#718076]">Tasklutein · People and agents working together</footer></main>
    </div>
  </div>;
}

function NavItem({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  return <NavLink to={to} end={end} className={({ isActive }) => `flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-medium transition ${isActive ? "bg-[#e9f3e6] text-[#24523a]" : "text-[#5c6e61] hover:bg-[#f3f7f0] hover:text-[#274a36]"}`}>{children}</NavLink>;
}
