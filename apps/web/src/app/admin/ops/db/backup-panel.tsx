"use client";

import { useState, useTransition } from "react";

import { createBackupAction, verifyBackupAction } from "@/lib/ops/actions";
import type { BackupFileInfo, BackupResult, BackupVerifyResult } from "@/lib/ops/backup";

import { Chip, Notice } from "../ops-ui";

/**
 * 备份面板（客户端）。
 *
 * ── 为什么备份按钮要二次确认 ─────────────────────────────────────────
 * 它是运维台里**唯一会写磁盘**的动作（在仓库根 `backups/` 下生成一个
 * 几十到几百 KB 的 JSON）。写磁盘本身无害，但在 Vercel 上文件系统是只读的，
 * 这个动作会失败 —— 先确认一次，避免运维者以为「点了没反应」。
 *
 * ── 为什么「恢复」按钮不存在 ─────────────────────────────────────────
 * 用户明确选择「数据库只读」。恢复是写操作，只能在终端
 * `npm run db:restore`。这里如实说明，而不是给一个点了会失败的按钮。
 */
export function BackupPanel({
  files,
  enabled,
}: {
  files: BackupFileInfo[];
  enabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [created, setCreated] = useState<BackupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifyFile, setVerifyFile] = useState<string | null>(null);
  const [verified, setVerified] = useState<BackupVerifyResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  function create() {
    setError(null);
    setConfirming(false);
    startTransition(async () => {
      const response = await createBackupAction();
      if (!response.ok) {
        setCreated(null);
        setError(response.error ?? "备份失败，但没有返回原因。");
        return;
      }
      setCreated(response.data ?? null);
    });
  }

  function verify(file: string) {
    setError(null);
    setVerified(null);
    setVerifyFile(file);
    startTransition(async () => {
      const response = await verifyBackupAction(file);
      if (!response.ok) {
        setError(response.error ?? "校验失败，但没有返回原因。");
        return;
      }
      setVerified(response.data ?? null);
    });
  }

  if (!enabled) {
    return <Notice tone="info">未配置 DATABASE_URL，备份不可用。</Notice>;
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-3">
        {confirming ? (
          <>
            <button
              type="button"
              onClick={create}
              disabled={pending}
              className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-on-accent disabled:opacity-50"
            >
              {pending ? "导出中…" : "确认导出"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-xs text-muted hover:text-foreground"
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={pending}
            className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-foreground transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            导出一份备份
          </button>
        )}

        <span className="text-[11px] text-muted">
          写到仓库根 backups/ · 11 张表 · 只读连接导出
        </span>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {created ? (
        created.ok ? (
          <Notice tone="info">
            已生成 <code className="font-mono">{created.file}</code>
            ：{created.totalRows} 行 / {created.bytes} 字节 / {created.elapsedMs}ms。
            这次导出已写入审计日志。
          </Notice>
        ) : (
          <Notice tone="error">备份失败：{created.error ?? "未知原因"}</Notice>
        )
      ) : null}

      {verified ? (
        <Notice tone={verified.ok ? "info" : "warn"}>
          校验 <code className="font-mono">{verifyFile ?? "备份"}</code>：
          {verified.error
            ? ` ${verified.error}`
            : verified.ok
              ? ` 全部 ${verified.tables.length} 张表行数与当前库一致（${verified.elapsedMs}ms）。`
              : ` ${verified.tables.filter((t) => !t.same).length} 张表行数不一致。`}
          {!verified.ok && !verified.error ? (
            <>
              <br />
              不一致的表：
              {verified.tables
                .filter((t) => !t.same)
                .map((t) => `${t.table}（备份 ${t.backupRows} / 当前 ${t.currentRows ?? "查询失败"}）`)
                .join("、")}
            </>
          ) : null}
        </Notice>
      ) : null}

      {files.length === 0 ? (
        <Notice tone="info">backups/ 里还没有备份文件。</Notice>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[680px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border bg-surface text-left text-muted">
                <th scope="col" className="px-2.5 py-2 font-medium">
                  文件
                </th>
                <th scope="col" className="px-2.5 py-2 font-medium">
                  行数
                </th>
                <th scope="col" className="px-2.5 py-2 font-medium">
                  大小
                </th>
                <th scope="col" className="px-2.5 py-2 font-medium">
                  创建时间
                </th>
                <th scope="col" className="px-2.5 py-2 font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.file} className="border-b border-border last:border-0 hover:bg-surface">
                  <td className="max-w-[240px] truncate px-2.5 py-1.5 font-mono text-foreground">
                    {file.file}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-muted">
                    {file.error ? <Chip tone="error" label="解析失败" /> : file.totalRows}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-muted">
                    {(file.bytes / 1024).toFixed(1)} KB
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-muted">
                    {file.createdAt ?? file.modifiedAt.slice(0, 19).replace("T", " ")}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1.5">
                    <button
                      type="button"
                      onClick={() => verify(file.file)}
                      disabled={pending}
                      className="text-accent underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {pending && verifyFile === file.file ? "校验中…" : "校验"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Notice tone="warn">
        恢复不在运维台里：按方案「数据库只读」的选择，写回数据只能在终端跑{" "}
        <code className="font-mono">npm run db:restore</code>。
      </Notice>
    </div>
  );
}
