import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api";
import type { AgentToken, Session } from "../api";
import { ApiFeedback } from "../components/ApiFeedback";

function toDateTimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function SettingsPage({ session }: { session: Session }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editExpiresAt, setEditExpiresAt] = useState("");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const tokens = useQuery({
    queryKey: ["agent-tokens"],
    queryFn: () => api<{ tokens: AgentToken[] }>("/agent-tokens"),
  });
  const createToken = useMutation({
    mutationFn: async () => {
      const result = await api<{ token: AgentToken; secret: string }>("/agent-tokens", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), expires_at: expiresAt ? new Date(expiresAt).toISOString() : null }),
      });
      setCreatedSecret(result.secret);
      setCopied(false);
      return result.token;
    },
    onSuccess: async () => {
      setName("");
      setExpiresAt("");
      await client.invalidateQueries({ queryKey: ["agent-tokens"] });
    },
  });
  const revokeToken = useMutation({
    mutationFn: (id: string) => api<void>(`/agent-tokens/${id}`, { method: "DELETE" }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["agent-tokens"] }); },
  });
  const updateToken = useMutation({
    mutationFn: async (input: { id: string; name: string; expiresAt: string }) => api<{ token: AgentToken }>(`/agent-tokens/${input.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: input.name, expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : null }),
    }),
    onSuccess: async () => {
      setEditingTokenId(null);
      await client.invalidateQueries({ queryKey: ["agent-tokens"] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || createToken.isPending) return;
    createToken.mutate();
  }

  async function copySecret() {
    if (!createdSecret) return;
    await navigator.clipboard.writeText(createdSecret);
    setCopied(true);
  }

  function beginEditingToken(token: AgentToken) {
    setEditingTokenId(token.id);
    setEditName(token.name);
    setEditExpiresAt(toDateTimeLocal(token.expires_at));
    updateToken.reset();
  }

  function submitTokenUpdate(event: FormEvent, tokenId: string) {
    event.preventDefault();
    if (!editName.trim() || updateToken.isPending) return;
    updateToken.mutate({ id: tokenId, name: editName.trim(), expiresAt: editExpiresAt });
  }

  return <div className="space-y-6">
    <header><p className="eyebrow">个人资料</p><h2 className="page-title">设置</h2><p className="mt-2 text-sm text-[#56655a]">查看账户信息并管理连接 Agent 的个人密钥。</p></header>
    <section className="card"><h3 className="text-lg font-semibold">账户</h3><dl className="mt-4 grid gap-4 sm:grid-cols-2">
      <div><dt className="text-xs font-medium text-[#718076]">已验证邮箱</dt><dd className="mt-1 break-all text-sm">{session.user.email}</dd></div>
      <div><dt className="text-xs font-medium text-[#718076]">工作区</dt><dd className="mt-1 text-sm">{session.workspace.name}</dd></div>
    </dl></section>
    <section className="card space-y-5"><div><p className="eyebrow">Agent Keys</p><h3 className="mt-1 text-lg font-semibold">Agent 密钥</h3><p className="mt-1 text-sm text-[#66736a]">可编辑名称和到期时间，或单独撤销密钥。列表只显示 <code>tlu_</code> 和密钥后 3 个字符；撤销会立即停用密钥，但保留记录并标明状态。创建后请立即保存明文；离开此页面后无法再次查看。</p></div>
      {createdSecret && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="font-semibold">密钥仅显示这一次</p><p className="mt-1">将它保存到 Agent 客户端的凭据设置中。</p>
        <code className="mt-3 block overflow-x-auto rounded-lg bg-white p-3 text-xs">{createdSecret}</code>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="secondary-btn" onClick={() => void copySecret()}><Copy size={15} />{copied ? "已复制" : "复制密钥"}</button><button type="button" className="quiet-link" onClick={() => { setCreatedSecret(null); setCopied(false); createToken.reset(); }}>关闭</button></div>
      </div>}
      <form onSubmit={submit} className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]">
        <label className="block text-sm font-medium">名称<input className="input mt-1.5" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="例如：Ligule 工作电脑" required /></label>
        <label className="block text-sm font-medium">过期时间（可选）<input className="input mt-1.5" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
        <button className="primary-btn" type="submit" disabled={!name.trim() || createToken.isPending}><Plus size={15} />{createToken.isPending ? "正在创建…" : "创建密钥"}</button>
      </form>
      {createToken.isError && <ApiFeedback error={createToken.error} />}
      <div className="border-t border-[#edf1ea] pt-4">
        <h4 className="font-semibold">已创建的密钥</h4>
        {tokens.isPending && <p role="status" className="py-5 text-sm text-[#69776d]">正在加载密钥…</p>}
        {tokens.isError && <div className="mt-3"><ApiFeedback error={tokens.error} onRetry={() => void tokens.refetch()} /></div>}
        {tokens.data?.tokens.length === 0 && <p className="py-5 text-sm text-[#69776d]">尚未创建 Agent 密钥。</p>}
        {tokens.data && tokens.data.tokens.length > 0 && <ul className="mt-2 divide-y divide-[#edf1ea]">{tokens.data.tokens.map((token) => <li key={token.id} className="space-y-3 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0"><p className="flex items-center gap-2 text-sm font-semibold"><KeyRound size={15} />{token.name}{token.revoked_at && <span className="rounded-full bg-[#fcefed] px-2 py-0.5 text-[11px] font-medium text-[#9d4238]">已撤销</span>}</p><p className="mt-1 font-mono text-xs text-[#647268]">{token.prefix}</p><p className="mt-1 text-xs text-[#718076]">创建于 {new Date(token.created_at).toLocaleString()} {token.expires_at ? `· 到期于 ${new Date(token.expires_at).toLocaleString()}` : "· 永不过期"}</p></div>
            {!token.revoked_at && <div className="flex flex-wrap gap-2"><button type="button" className="secondary-btn" disabled={updateToken.isPending || revokeToken.isPending} onClick={() => beginEditingToken(token)}>编辑</button><button type="button" className="danger-btn" disabled={revokeToken.isPending || updateToken.isPending} onClick={() => revokeToken.mutate(token.id)}><Trash2 size={15} />{revokeToken.isPending ? "正在撤销…" : "撤销"}</button></div>}
          </div>
          {editingTokenId === token.id && <form onSubmit={(event) => submitTokenUpdate(event, token.id)} className="grid gap-3 rounded-xl border border-[#e6ece3] bg-[#f8faf5] p-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
            <label className="block text-sm font-medium">密钥名称<input aria-label="编辑密钥名称" className="input mt-1.5" value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={80} required /></label>
            <label className="block text-sm font-medium">过期时间（可选）<input aria-label="编辑密钥过期时间" className="input mt-1.5" type="datetime-local" value={editExpiresAt} onChange={(event) => setEditExpiresAt(event.target.value)} /></label>
            <button className="primary-btn" type="submit" disabled={!editName.trim() || updateToken.isPending}>{updateToken.isPending ? "正在保存…" : "保存"}</button>
            <button className="secondary-btn" type="button" disabled={updateToken.isPending} onClick={() => { setEditingTokenId(null); updateToken.reset(); }}>取消</button>
            {updateToken.isError && <div className="sm:col-span-4"><ApiFeedback error={updateToken.error} /></div>}
          </form>}
        </li>)}</ul>}
        {revokeToken.isError && <div className="mt-3"><ApiFeedback error={revokeToken.error} /></div>}
      </div>
    </section>
  </div>;
}
