import { useState } from "react";
import { ApiError } from "../api";

export function ApiFeedback({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  const message = error instanceof ApiError
    ? error.status === 401
      ? "访问令牌无效或已失效，请重新登录。"
      : error.status === 404
        ? "没有找到这条记录。"
        : error.status >= 500
          ? "服务暂时不可用，请稍后重试。"
          : error.message
    : error instanceof TypeError
      ? "网络连接失败，请检查网络后重试。"
      : error instanceof Error
        ? error.message
        : "请求失败，请稍后重试。";

  async function copyRequestId() {
    if (!requestId) return;
    await navigator.clipboard.writeText(requestId);
    setCopied(true);
  }

  return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
    <p>{message}</p>
    {requestId && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <code className="break-all">请求 ID：{requestId}</code>
      <button type="button" className="text-red-900 underline" onClick={() => void copyRequestId()}>
        {copied ? "已复制" : "复制请求 ID"}
      </button>
    </div>}
    {onRetry && <button type="button" className="mt-3 rounded-lg border border-red-300 px-3 py-2 font-medium" onClick={onRetry}>
      重试
    </button>}
  </div>;
}
