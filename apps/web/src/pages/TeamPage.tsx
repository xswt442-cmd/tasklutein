import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api";
import type { WorkspaceInvitation, WorkspaceMember } from "../api";
import { ApiFeedback } from "../components/ApiFeedback";
import { useWorkspace } from "../workspace";

export function TeamPage() {
  const { workspace, workspaces, selectWorkspace } = useWorkspace();
  const client = useQueryClient();
  const [teamName, setTeamName] = useState("");
  const [email, setEmail] = useState("");
  const isOwner = workspace.role === "owner";
  const members = useQuery({ queryKey: ["members", workspace.id], queryFn: () => api<{ members: WorkspaceMember[] }>(`/workspaces/${workspace.id}/members`), enabled: workspace.kind === "team" });
  const invitations = useQuery({ queryKey: ["invitations"], queryFn: () => api<{ invitations: WorkspaceInvitation[] }>("/invitations") });
  const createTeam = useMutation({ mutationFn: () => api<{ workspace: { id: string } }>("/workspaces", { method: "POST", body: JSON.stringify({ name: teamName.trim() }) }), onSuccess: async ({ workspace: created }) => { setTeamName(""); await client.invalidateQueries({ queryKey: ["workspaces"] }); selectWorkspace(created.id); } });
  const invite = useMutation({ mutationFn: () => api(`/workspaces/${workspace.id}/invitations`, { method: "POST", body: JSON.stringify({ email: email.trim() }) }), onSuccess: async () => { setEmail(""); await Promise.all([client.invalidateQueries({ queryKey: ["invitations"] }), client.invalidateQueries({ queryKey: ["members", workspace.id] })]); } });
  const removeMember = useMutation({ mutationFn: (userId: string) => api<void>(`/workspaces/${workspace.id}/members/${userId}`, { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: ["members", workspace.id] }) });
  const respond = useMutation({ mutationFn: ({ id, action }: { id: string; action: "accept" | "decline" }) => api(`/invitations/${id}/${action}`, { method: "POST" }), onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ["invitations"] }), client.invalidateQueries({ queryKey: ["workspaces"] })]); } });
  function submitTeam(event: FormEvent) { event.preventDefault(); if (teamName.trim() && !createTeam.isPending) createTeam.mutate(); }
  function submitInvite(event: FormEvent) { event.preventDefault(); if (email.trim() && !invite.isPending) invite.mutate(); }
  const pending = invitations.data?.invitations.filter((item) => item.status === "pending") ?? [];
  return <div className="space-y-5">
    <header><p className="eyebrow">协作</p><h2 className="page-title">工作区与团队</h2><p className="mt-2 text-sm text-[#56655a]">切换工作区、管理成员并处理团队邀请。</p></header>
    <section className="card"><h3 className="text-lg font-semibold">你的工作区</h3><div className="mt-3 divide-y divide-[#edf1ea]">{workspaces.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 py-3"><div><p className="font-medium">{item.name}</p><p className="text-xs text-[#68766c]">{item.kind === "team" ? "团队" : "个人"} · {item.role === "owner" ? "所有者" : "成员"}</p></div><button className={workspace.id === item.id ? "secondary-btn" : "quiet-link"} disabled={workspace.id === item.id} onClick={() => selectWorkspace(item.id)}>{workspace.id === item.id ? "当前工作区" : "切换"}</button></div>)}</div></section>
    <section className="card"><h3 className="text-lg font-semibold">创建团队</h3><form onSubmit={submitTeam} className="mt-3 flex flex-col gap-2 sm:flex-row"><label className="sr-only" htmlFor="team-name">团队名称</label><input id="team-name" className="input" maxLength={120} placeholder="团队名称" value={teamName} onChange={(event) => setTeamName(event.target.value)} /><button className="primary-btn" disabled={!teamName.trim() || createTeam.isPending} type="submit">创建团队</button></form>{createTeam.isError && <ApiFeedback error={createTeam.error} />}</section>
    <section className="card"><h3 className="text-lg font-semibold">{workspace.name} 成员</h3><p className="text-xs text-[#68766c]">{workspace.kind === "team" ? (isOwner ? "团队 Owner 可邀请已注册用户并移除成员。" : "你可以查看团队成员。") : "私人工作区没有其他成员。创建团队后即可邀请协作者。"}</p>
      {workspace.kind === "team" && <>{members.isError && <ApiFeedback error={members.error} onRetry={() => void members.refetch()} />}{members.isPending && <p className="py-4 text-sm">正在加载成员…</p>}{members.data && <div className="mt-3 divide-y divide-[#edf1ea]">{members.data.members.map((member) => <div key={member.user_id} className="flex items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium">{member.email}</p><p className="text-xs text-[#68766c]">{member.role === "owner" ? "所有者" : "成员"}</p></div>{isOwner && member.role !== "owner" && <button className="danger-btn" disabled={removeMember.isPending} onClick={() => { if (window.confirm(`从此团队移除 ${member.email}？`)) removeMember.mutate(member.user_id); }}>移除</button>}</div>)}</div>}</>}
      {workspace.kind === "team" && isOwner && <form onSubmit={submitInvite} className="mt-4 flex flex-col gap-2 border-t border-[#edf1ea] pt-4 sm:flex-row"><label className="sr-only" htmlFor="invite-email">受邀用户邮箱</label><input id="invite-email" className="input" type="email" maxLength={320} placeholder="已注册用户的邮箱" value={email} onChange={(event) => setEmail(event.target.value)} /><button className="primary-btn" type="submit" disabled={!email.trim() || invite.isPending}>发送邀请</button></form>}{invite.isError && <ApiFeedback error={invite.error} />}{removeMember.isError && <ApiFeedback error={removeMember.error} />}
    </section>
    <section className="card"><h3 className="text-lg font-semibold">待处理邀请</h3>{invitations.isError && <ApiFeedback error={invitations.error} onRetry={() => void invitations.refetch()} />}{invitations.isPending && <p className="py-4 text-sm">正在加载邀请…</p>}{pending.length === 0 && !invitations.isPending && <p className="py-4 text-sm text-[#68766c]">没有待处理邀请。</p>}{pending.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-[#edf1ea] py-3"><div><p className="font-medium">{item.workspace_name}</p><p className="text-xs text-[#68766c]">邀请发给 {item.invitee_email}</p></div><div className="flex gap-2"><button className="primary-btn" disabled={respond.isPending} onClick={() => respond.mutate({ id: item.id, action: "accept" })}>接受</button><button className="secondary-btn" disabled={respond.isPending} onClick={() => respond.mutate({ id: item.id, action: "decline" })}>拒绝</button></div></div>)}{respond.isError && <ApiFeedback error={respond.error} />}</section>
  </div>;
}
