import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";

import { hasDatabaseUrl } from "@/lib/admin/db";
import { listBackups } from "@/lib/ops/backup";
import { MAX_ROWS, STATEMENT_TIMEOUT_MS, QUERY_TIMEOUT_MS } from "@/lib/ops/db-readonly";
import { listTables, type TableSummary } from "@/lib/ops/db-schema";
import { getMigrationStatus, type MigrationStatus } from "@/lib/ops/migrations";

import { Chip, KeyValue, Notice, SectionSkeleton } from "../ops-ui";
import { BackupPanel } from "./backup-panel";
import { QueryPanel } from "./query-panel";

export const metadata: Metadata = { title: "数据库" };

/**
 * 数据库页（`/admin/ops/db`）。
 *
 * ── 这一页为什么是「只读」的 ─────────────────────────────────────────
 * 用户在需求确认时明确选择「只读：浏览表结构、看数据、执行只读查询」。
 * 这不是技术上做不到写，而是**刻意不给**：一个能跑任意 SQL 的后台面板
 * 等于把整库的写权限暴露在浏览器里，一次误粘贴就能毁掉生产数据。
 * 恢复与迁移只能在终端跑（`npm run db:restore` / `npm run db:migrate`）。
 *
 * ── 四道闸在哪 ───────────────────────────────────────────────────────
 * 全部在 `lib/ops/db-readonly.ts`，不在这一页：
 * 1. 连接级 `default_transaction_read_only=on` —— Postgres 自己拒绝写。
 *    这是唯一一道**不依赖我写对正则**的防线。
 * 2. 单条语句限制（分号分段后必须只有一段）。
 * 3. 36 个写/危险关键词黑名单（含 `INTO` —— `SELECT ... INTO new_table` 会建表）。
 * 4. `statement_timeout` + 总超时。
 * 页面上写的「上限 500 行 / 8s / 15s」是这三个常量的**展示**，不是实现。
 *
 * ── 为什么表结构浏览要单独一页 ───────────────────────────────────────
 * 11 张表 × 每张平均 10 列的明细全展开会有几百行。放在同一页会把
 * 「查询框」挤到看不见的地方。所以这里只列表清单，点进去看单表结构。
 */
export default function OpsDatabasePage() {
  return (
    <Suspense fallback={<SectionSkeleton rows={5} />}>
      <OpsDatabaseBody />
    </Suspense>
  );
}

async function OpsDatabaseBody() {
  await connection();

  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const enabled = databaseUrl.length > 0 && hasDatabaseUrl();

  const [tables, migrations, backups] = await Promise.all([
    enabled ? listTables(databaseUrl).catch(() => null) : Promise.resolve(null),
    enabled ? getMigrationStatus(databaseUrl).catch(() => null) : Promise.resolve(null),
    Promise.resolve(listBackups()),
  ]);

  return (
    <div>
      <SectionTitle
        title="表结构"
        hint={
          enabled
            ? "public schema 下的全部表。行数是 pg_class.reltuples 的估算值，不是精确计数。"
            : undefined
        }
      />
      {enabled ? (
        tables === null ? (
          <Notice tone="error">读取表清单失败（连接或权限问题）。</Notice>
        ) : (
          <TableList tables={tables} />
        )
      ) : (
        <Notice tone="info">未配置 DATABASE_URL，无法读取表结构。</Notice>
      )}

      <SectionTitle
        title="只读查询"
        hint="单条 SELECT。写操作在连接层就被 Postgres 拒绝，不靠前端拦截。"
      />
      <QueryPanel enabled={enabled} />

      <SectionTitle
        title="迁移"
        hint="磁盘上的迁移文件与库里 drizzle.__drizzle_migrations 的记录逐份比对。"
      />
      {enabled ? (
        migrations === null ? (
          <Notice tone="error">查询迁移状态失败。</Notice>
        ) : (
          <MigrationDetail migrations={migrations} />
        )
      ) : (
        <Notice tone="info">未配置 DATABASE_URL，无法查询迁移状态。</Notice>
      )}

      <SectionTitle
        title="备份"
        hint={`导出全部 11 张业务表到仓库根 backups/。只读连接导出，不写数据库。上限 ${MAX_ROWS} 行 / 语句 ${STATEMENT_TIMEOUT_MS / 1000}s / 总 ${QUERY_TIMEOUT_MS / 1000}s。`}
      />
      <BackupPanel files={backups} enabled={enabled} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 小件                                                                        */
/* -------------------------------------------------------------------------- */

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <section className="mt-8 first:mt-6">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p> : null}
    </section>
  );
}

/** 表清单：点表名进单表结构页。 */
function TableList({ tables }: { tables: TableSummary[] }) {
  if (tables.length === 0) {
    return <Notice tone="warn">public schema 下没有任何表 —— 迁移可能还没跑。</Notice>;
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[620px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-surface text-left text-xs text-muted">
            <th scope="col" className="px-3 py-2.5 font-medium">
              表名
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              估算行数
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              磁盘占用
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              注释
            </th>
          </tr>
        </thead>
        <tbody>
          {tables.map((table) => (
            <tr key={table.name} className="border-b border-border last:border-0 hover:bg-surface">
              <td className="whitespace-nowrap px-3 py-2 align-top">
                <Link
                  href={`/admin/ops/db/${encodeURIComponent(table.name)}`}
                  className="font-mono text-xs text-accent underline-offset-2 hover:underline"
                >
                  {table.name}
                </Link>
              </td>
              <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs text-muted">
                {table.estimatedRows < 0 ? "—" : table.estimatedRows}
              </td>
              <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-xs text-muted">
                {table.totalSize}
              </td>
              <td className="px-3 py-2 align-top text-xs text-muted">{table.comment ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 迁移明细：逐份文件 + sha256 是否与库里一致。 */
function MigrationDetail({ migrations }: { migrations: MigrationStatus }) {
  return (
    <div className="mt-3">
      <div className="rounded-xl border border-border bg-elevated p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip
            tone={
              migrations.error
                ? "error"
                : migrations.pending.length === 0
                  ? "ok"
                  : "warn"
            }
            label={
              migrations.error
                ? "查询失败"
                : migrations.pending.length === 0
                  ? "已同步"
                  : `${migrations.pending.length} 份待应用`
            }
          />
          <span className="text-xs text-muted">
            库内 {migrations.appliedCount} 条 / 磁盘 {migrations.files.length} 份
          </span>
        </div>

        <div className="mt-2 space-y-1">
          <KeyValue label="跟踪表" value={migrations.trackingTableExists ? "drizzle.__drizzle_migrations 存在" : "不存在（迁移从未跑过）"} />
          <KeyValue label="最近应用" value={migrations.lastAppliedAt ?? "无记录"} />
          <KeyValue label="目录" value={migrations.directory} />
        </div>
      </div>

      {migrations.error ? <Notice tone="error">{migrations.error}</Notice> : null}

      {migrations.files.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border bg-surface text-left text-muted">
                <th scope="col" className="px-2.5 py-2 font-medium">
                  文件
                </th>
                <th scope="col" className="px-2.5 py-2 font-medium">
                  语句
                </th>
                <th scope="col" className="px-2.5 py-2 font-medium">
                  大小
                </th>
                <th scope="col" className="px-2.5 py-2 font-medium">
                  sha256（前 12）
                </th>
                <th scope="col" className="px-2.5 py-2 font-medium">
                  状态
                </th>
              </tr>
            </thead>
            <tbody>
              {migrations.files.map((file) => (
                <tr key={file.file} className="border-b border-border last:border-0 hover:bg-surface">
                  <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-foreground">
                    {file.file}
                  </td>
                  <td className="px-2.5 py-1.5 font-mono text-muted">{file.statements}</td>
                  <td className="whitespace-nowrap px-2.5 py-1.5 text-muted">
                    {(file.bytes / 1024).toFixed(1)} KB
                  </td>
                  <td className="px-2.5 py-1.5 font-mono text-muted">{file.hash.slice(0, 12)}</td>
                  <td className="whitespace-nowrap px-2.5 py-1.5">
                    {file.applied ? (
                      <Chip tone="ok" label="已应用" />
                    ) : (
                      <Chip tone="warn" label="未应用" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {migrations.orphanHashes.length > 0 ? (
        <Notice tone="warn">
          库里有 {migrations.orphanHashes.length} 条迁移记录在磁盘上找不到对应文件：
          {migrations.orphanHashes.map((h) => h.slice(0, 12)).join("、")}。
          这说明有人删改过迁移目录，或曾经跑过已被回滚的迁移。
        </Notice>
      ) : null}
    </div>
  );
}
