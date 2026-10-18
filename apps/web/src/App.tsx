import { QueryClient, QueryClientProvider, useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, LayoutDashboard, ListTodo, LogOut, RefreshCw, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BrowserRouter, NavLink, Outlet, Route, Routes } from "react-router";
import { api } from "./api";
import type { Overview, Session } from "./api";
import { ApiFeedback } from "./components/ApiFeedback";
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
    queryFn: () => api<Session>("/session/bootstrap", { method: "POST", body: "{}" }),
  });
  const profile = useQuery({
    queryKey: ["session", "me"],
    queryFn: () => api<Session>("/me"),
    enabled: bootstrap.isSuccess,
  });

  useEffect(() => {
    const userId = profile.data?.user.id;
    if (!userId) return;
    if (previousUser.current && previousUser.current !== userId) client.clear();
    previousUser.current = userId;
  }, [client, profile.data?.user.id]);

  function signOut() {
    client.clear();
    previousUser.current = null;
    window.location.assign("/cdn-cgi/access/logout");
  }

  if (bootstrap.isPending || (bootstrap.isSuccess && profile.isPending)) {
    return <main className="flex min-h-screen items-center justify-center bg-[#f5f7f0] p-6"><p role="status">正在验证 Cloudflare Access 会话…</p></main>;
  }
  if (bootstrap.isError || profile.isError) {
    const error = bootstrap.error ?? profile.error;
    return <main className="flex min-h-screen items-center justify-center bg-[#f5f7f0] p-5"><section className="card w-full max-w-md">
      <img src="/mark.svg" width="60" height="60" alt="Tasklutein" />
      <h1 className="page-title">无法载入工作区</h1>
      <p className="mt-2 text-sm text-[#66736a]">请确认已通过 Cloudflare Access 登录，然后重试。</p>
      <div className="mt-4"><ApiFeedback error={error} onRetry={() => void (bootstrap.isError ? bootstrap.refetch() : profile.refetch())} /></div>
      <a className="primary-btn mt-4" href="/cdn-cgi/access/login">使用 Cloudflare Access 登录</a>
    </section></main>;
  }
  if (!profile.data) return <main className="flex min-h-screen items-center justify-center"><p role="status">正在载入账户资料…</p></main>;
  return <WorkspaceRoutes session={profile.data} signOut={signOut} />;
}

function WorkspaceRoutes({ session, signOut }: { session: Session; signOut: () => void }) {
  return <Routes><Route element={<WorkspaceLayout session={session} signOut={signOut} />}>
    <Route index element={<OverviewPage />} />
    <Route path="tasks" element={<TasksPage />} />
    <Route path="tasks/:taskId" element={<TaskDetailPage />} />
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
      <nav aria-label="主导航" className="flex w-full gap-2 overflow-x-auto pb-0.5 lg:hidden"><NavItem to="/" end><LayoutDashboard size={15} />Overview</NavItem><NavItem to="/tasks"><ListTodo size={15} />任务</NavItem><NavItem to="/settings"><Settings size={15} />设置</NavItem></nav>
    </div></header>
    <div className="mx-auto grid max-w-[1440px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:px-8 lg:py-8">
      <aside className="hidden lg:block"><div className="sticky top-28 rounded-2xl border border-[#e2e8dd] bg-white p-3"><p className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#768279]">工作区</p>
        <nav aria-label="侧边导航" className="space-y-1"><NavItem to="/" end><LayoutDashboard size={17} />Overview</NavItem><NavItem to="/tasks"><ListTodo size={17} />任务</NavItem><NavItem to="/settings"><Settings size={17} />设置</NavItem></nav>
        <div className="mt-5 border-t border-[#edf1ea] px-3 pt-4 text-xs leading-5 text-[#718076]"><span className="block font-medium text-[#53675a]">私人工作区</span>{session.workspace.name}</div>
      </div></aside>
      <main className="min-w-0"><Outlet /><footer className="py-8 text-center text-xs text-[#718076]">Tasklutein · People and agents working together</footer></main>
    </div>
  </div>;
}

function NavItem({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  return <NavLink to={to} end={end} className={({ isActive }) => `flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-medium transition ${isActive ? "bg-[#e9f3e6] text-[#24523a]" : "text-[#5c6e61] hover:bg-[#f3f7f0] hover:text-[#274a36]"}`}>{children}</NavLink>;
}
