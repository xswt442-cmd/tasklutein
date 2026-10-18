import { QueryClient, QueryClientProvider, useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Circle, LayoutDashboard, ListTodo, LogOut, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { BrowserRouter, NavLink, Outlet, Route, Routes } from "react-router";
import { api, ApiError } from "./api";
import type { Overview } from "./api";
import { ApiFeedback } from "./components/ApiFeedback";
import { OverviewPage } from "./pages/OverviewPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { TasksPage } from "./pages/TasksPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 10_000 },
    mutations: { retry: false },
  },
});

export default function App() {
  return <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <Workspace />
    </BrowserRouter>
  </QueryClientProvider>;
}

function Workspace() {
  const client = useQueryClient();
  const [token, setToken] = useState(() => {
    client.clear();
    return sessionStorage.getItem("tasklutein_token") ?? "";
  });
  const [draftToken, setDraftToken] = useState("");
  const [loginError, setLoginError] = useState<unknown>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [expiredMessage, setExpiredMessage] = useState("");

  async function signIn(event: FormEvent) {
    event.preventDefault();
    const newToken = draftToken.trim();
    if (!newToken || signingIn) return;
    setSigningIn(true);
    setLoginError(null);
    try {
      await api(newToken, "/tasks?limit=1");
      client.clear();
      sessionStorage.setItem("tasklutein_token", newToken);
      setToken(newToken);
      setDraftToken("");
      setExpiredMessage("");
    } catch (error) {
      setLoginError(error);
    } finally {
      setSigningIn(false);
    }
  }

  function signOut(expired = false) {
    sessionStorage.removeItem("tasklutein_token");
    client.clear();
    setToken("");
    setDraftToken("");
    setLoginError(null);
    setExpiredMessage(expired ? "访问令牌已失效，请重新登录。" : "");
  }

  if (!token) {
    return <main className="flex min-h-screen items-center justify-center bg-[#f5f7f0] p-5">
      <section className="w-full max-w-md rounded-3xl border border-[#e3e9df] bg-white p-8 shadow-sm">
        <img src="/mark.svg" width="60" height="60" alt="Tasklutein" />
        <p className="mt-5 text-xs uppercase tracking-[0.25em] text-emerald-700">Human × Agent Workflow</p>
        <h1 className="mt-2 text-3xl font-bold text-[#18382a]">Tasklutein</h1>
        <p className="mb-7 mt-3 leading-relaxed text-[#66736a]">让你的任务、AI Agent 的进度与工作汇报同步在一个地方。</p>
        {expiredMessage && <p role="status" className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{expiredMessage}</p>}
        <form onSubmit={(event) => void signIn(event)} className="space-y-4">
          <label className="block text-sm font-semibold text-[#284437]">工作空间访问令牌
            <input type="password" value={draftToken} onChange={(event) => setDraftToken(event.target.value)}
              placeholder="输入 Web 访问令牌" autoComplete="off" required className="input mt-2" />
          </label>
          {loginError !== null && <ApiFeedback error={loginError} />}
          <button className="primary-btn w-full" disabled={signingIn || !draftToken.trim()}>
            {signingIn ? "正在验证…" : "进入工作空间"} <ArrowRight size={16} />
          </button>
        </form>
        <p className="mt-6 text-xs leading-5 text-[#56655a]">令牌只保存在当前浏览器会话中。Web 与 Agent 访问同一个工作区。</p>
      </section>
    </main>;
  }

  return <WorkspaceRoutes token={token} signOut={signOut} />;
}

function WorkspaceRoutes({ token, signOut }: { token: string; signOut: (expired?: boolean) => void }) {
  return <Routes>
    <Route element={<WorkspaceLayout token={token} signOut={signOut} />}>
      <Route index element={<OverviewPage token={token} />} />
      <Route path="tasks" element={<TasksPage token={token} />} />
      <Route path="tasks/:taskId" element={<TaskDetailPage token={token} />} />
      <Route path="*" element={<NotFound />} />
    </Route>
  </Routes>;
}

function WorkspaceLayout({ token, signOut }: { token: string; signOut: (expired?: boolean) => void }) {
  const client = useQueryClient();
  const fetching = useIsFetching() > 0;
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>(token, "/overview"),
  });

  useEffect(() => {
    if (overview.error instanceof ApiError && overview.error.status === 401) signOut(true);
  }, [overview.error, signOut]);

  const status = overview.isError
    ? "服务暂不可用"
    : fetching || overview.isPending
      ? "正在同步"
      : "工作区已连接";

  return <div className="min-h-screen bg-[#f5f7f0] text-[#18382a]">
    <header className="sticky top-0 z-10 border-b border-[#e2e8dd] bg-white">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <img src="/mark.svg" width="38" height="38" alt="" />
          <div><p className="font-bold tracking-tight">Tasklutein</p><p className="text-xs text-[#657369]">任务与工作汇报</p></div>
        </div>
        <div className="flex items-center gap-3">
          <span role="status" aria-live="polite" className={`hidden items-center gap-2 text-xs sm:inline-flex ${overview.isError ? "text-red-700" : "text-[#5b7360]"}`}>
            {overview.isError ? <Circle size={13} /> : fetching ? <RefreshCw size={13} /> : <CheckCircle2 size={13} />}{status}
          </span>
          <button type="button" className="secondary-btn" aria-label="刷新数据"
            onClick={() => void client.invalidateQueries()} disabled={fetching}>
            <RefreshCw size={15} /><span className="hidden sm:inline">刷新</span>
          </button>
          <button type="button" className="secondary-btn" onClick={() => signOut()}>
            <LogOut size={15} /><span>退出</span>
          </button>
        </div>
        <nav aria-label="主导航" className="flex w-full gap-2 overflow-x-auto pb-0.5 lg:hidden">
          <NavItem to="/" end><LayoutDashboard size={15} />Overview</NavItem>
          <NavItem to="/tasks"><ListTodo size={15} />任务</NavItem>
        </nav>
      </div>
    </header>

    <div className="mx-auto grid max-w-[1440px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:px-8 lg:py-8">
      <aside className="hidden lg:block">
        <div className="sticky top-28 rounded-2xl border border-[#e2e8dd] bg-white p-3">
          <p className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#768279]">工作区</p>
          <nav aria-label="侧边导航" className="space-y-1">
            <NavItem to="/" end><LayoutDashboard size={17} />Overview</NavItem>
            <NavItem to="/tasks"><ListTodo size={17} />任务</NavItem>
          </nav>
          <div className="mt-5 border-t border-[#edf1ea] px-3 pt-4 text-xs leading-5 text-[#718076]">
            <span className="block font-medium text-[#53675a]">单工作区</span>
            Web 与 Agent 共享任务和汇报。
          </div>
        </div>
      </aside>
      <main className="min-w-0">
        <Outlet />
        <footer className="py-8 text-center text-xs text-[#718076]">Tasklutein · People and agents working together</footer>
      </main>
    </div>
  </div>;
}

function NavItem({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  return <NavLink to={to} end={end} className={({ isActive }) =>
    `flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-medium transition ${
      isActive ? "bg-[#e9f3e6] text-[#24523a]" : "text-[#5c6e61] hover:bg-[#f3f7f0] hover:text-[#274a36]"
    }`}>
    {children}
  </NavLink>;
}

function NotFound() {
  return <section className="card text-center">
    <p className="eyebrow">404</p>
    <h2 className="mt-2 text-xl font-semibold">页面不存在</h2>
    <NavLink to="/" className="primary-btn mt-5 inline-flex">返回工作台</NavLink>
  </section>;
}
