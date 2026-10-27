import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { hasDatabaseUrl } from "@/lib/admin/db";
import { getTableStructure, type TableStructure } from "@/lib/ops/db-schema";

import { Chip, KeyValue, Notice } from "../../ops-ui";

export const metadata: Metadata = { title: "表结构" };

/**
 * 单表结构页（`/admin/ops/db/[table]`）。
 *
 * ── 为什么表名从 URL 拿而不是查询参数 ─────────────────────────────────
 * 这是一个**可收藏、可分享给同事**的地址（「你看 entries 这张表」）。
 * 用 `?table=entries` 在分享时容易丢参数，而且不利于 `<Link prefetch>`。
 *
 * ── 为什么表名要做白名单校验 ─────────────────────────────────────────
 * `getTableStructure()` 内部用参数化查询（`information_schema` + `$1`），
 * 所以不存在注入风险。但表不存在时它返回的是一张「所有数组都为空」的结构，
 * 那和「表存在但真的没有列」在页面上长得一模一样。所以这里先用
 * `notFound()` 明确区分 —— 与 `getTableStructure()` 内部「先确认表存在」
 * 是同一个理由的两道实现。
 *
 * ── 为什么 `params` 要 await ─────────────────────────────────────────
 * Next 15+ 起 `params` 是 Promise（Next 16 的 `LayoutProps`/`PageProps` 类型
 * 也这么声明）。不 await 直接读 `.table` 会拿到 undefined。
 *
 * ── 为什么 `notFound()` 不能放在 `<Suspense>` 里面（真踩过） ──────────
 * 最初这一页的结构是「页面返回 `<Suspense>` 包一个 async 子组件，子组件里
 * 查表、查不到就 `notFound()`」。实测（生产模式、随机表名保证缓存 MISS）：
 *
 *     GET /admin/ops/db/this_table_does_not_exist_xxxx  →  200
 *     正文确实是「404 · 偏离航线 / 这颗星球不存在」
 *
 * 也就是说**页面内容对了，但 HTTP 状态码是 200**。原因是 `cacheComponents`
 * 下这一页的壳会先被流式发出，`notFound()` 在 Suspense 边界内才抛出时，
 * 响应头早就发出去了，改不了状态码 —— 这跟 P8 在 Vercel 边缘遇到的软 404
 * （`NextResponse.rewrite` 不带 status）是同一类问题的两个形态。
 * 对照组：`/blog/<随机 slug>` 的 `notFound()` 写在页面组件顶层（不在
 * Suspense 里），实测回的是真 404。
 *
 * 所以这里把「表存在吗」这一步提到页面组件顶层：先 `await connection()`
 * 标记动态，再查一次结构，不存在就当场 `notFound()`，此时响应头还没发。
 * 代价是这一页不再有骨架屏（数据就绪后才开始流），对后台可接受。
 */
export default async function TableStructurePage({ params }: PageProps<"/admin/ops/db/[table]">) {
  const { table } = await params;
  const tableName = decodeURIComponent(table);

  await connection();

  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl.length === 0 || !hasDatabaseUrl()) {
    return <Notice tone="info">未配置 DATABASE_URL，无法读取表结构。</Notice>;
  }

  const structure = await getTableStructure(databaseUrl, tableName).catch((error: unknown) => {
    return { error: error instanceof Error ? error.message : String(error) } as const;
  });

  if (structure === null) {
    // `getTableStructure()` 内部先查 `pg_class` 确认表存在，不存在就返回 null。
    // 这里直接 404 —— 与「表存在但真的没有列」区分开（后者是异常，不该静默）。
    notFound();
  }

  if ("error" in structure) {
    return <Notice tone="error">读取失败：{structure.error}</Notice>;
  }

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-lg font-semibold text-foreground">{structure.table.name}</h2>
        <Chip tone="ok" label={`${structure.columns.length} 列`} />
        <Chip tone="muted" label={`${structure.indexes.length} 索引`} />
        <Chip tone="muted" label={`${structure.constraints.length} 约束`} />
        {structure.foreignKeys.length > 0 ? (
          <Chip tone="warn" label={`${structure.foreignKeys.length} 外键`} />
        ) : null}
      </div>

      <div className="mt-2 space-y-1">
        <KeyValue label="估算行数" value={String(structure.table.estimatedRows)} />
        <KeyValue label="磁盘占用" value={structure.table.totalSize} />
        {structure.table.comment ? <KeyValue label="注释" value={structure.table.comment} /> : null}
      </div>

      <ColumnsSection structure={structure} />
      {structure.foreignKeys.length > 0 ? <ForeignKeysSection structure={structure} /> : null}
      <IndexesSection structure={structure} />
      <ConstraintsSection structure={structure} />

      <p className="mt-6 text-xs text-muted">
        <Link href="/admin/ops/db" className="text-accent underline-offset-2 hover:underline">
          ← 返回表清单
        </Link>
        {" · "}
        想直接看这张表的数据？去「只读查询」跑{" "}
        <code className="font-mono">{`select * from "${structure.table.name}" limit 20`}</code>。
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 四个区块                                                                    */
/* -------------------------------------------------------------------------- */

function ColumnsSection({ structure }: { structure: TableStructure }) {
  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium text-foreground">列</h3>
      <div className="mt-2 overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[720px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-surface text-left text-muted">
              <th scope="col" className="px-2.5 py-2 font-medium">列名</th>
              <th scope="col" className="px-2.5 py-2 font-medium">类型</th>
              <th scope="col" className="px-2.5 py-2 font-medium">可空</th>
              <th scope="col" className="px-2.5 py-2 font-medium">默认值</th>
              <th scope="col" className="px-2.5 py-2 font-medium">键</th>
            </tr>
          </thead>
          <tbody>
            {structure.columns.map((column) => (
              <tr key={column.name} className="border-b border-border last:border-0 hover:bg-surface">
                <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-foreground">
                  {column.name}
                  {column.comment ? (
                    <span className="ml-1 text-[10px] text-muted">（{column.comment}）</span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-muted">
                  {column.dataType}
                  {column.maxLength !== null ? `(${column.maxLength})` : ""}
                </td>
                <td className="whitespace-nowrap px-2.5 py-1.5">
                  {column.nullable ? (
                    <span className="text-muted">NULL</span>
                  ) : (
                    <span className="text-foreground">NOT NULL</span>
                  )}
                </td>
                <td className="max-w-[260px] truncate px-2.5 py-1.5 font-mono text-muted">
                  {column.defaultValue ?? "—"}
                </td>
                <td className="whitespace-nowrap px-2.5 py-1.5">
                  {column.isPrimaryKey ? <Chip tone="ok" label="PK" /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ForeignKeysSection({ structure }: { structure: TableStructure }) {
  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium text-foreground">外键</h3>
      <p className="mt-1 text-xs text-muted">
        这里把 `pg_get_constraintdef` 的原始文本解析成人话 —— 原始文本是
        `FOREIGN KEY (a, b) REFERENCES t(x, y) ON DELETE ...`，一眼看不出哪列指向哪列。
      </p>
      <div className="mt-2 space-y-2">
        {structure.foreignKeys.map((fk) => (
          <div key={fk.name} className="rounded-lg border border-border bg-elevated p-2.5">
            <p className="font-mono text-xs text-foreground">{fk.name}</p>
            <div className="mt-1 space-y-0.5">
              <KeyValue label="本表列" value={fk.columns.join(", ")} />
              <KeyValue label="指向" value={`${fk.referencedTable}(${fk.referencedColumns.join(", ")})`} />
              <KeyValue label="ON DELETE" value={fk.onDelete} />
              <KeyValue label="ON UPDATE" value={fk.onUpdate} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function IndexesSection({ structure }: { structure: TableStructure }) {
  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium text-foreground">索引</h3>
      <div className="mt-2 space-y-2">
        {structure.indexes.map((index) => (
          <div key={index.name} className="rounded-lg border border-border bg-elevated p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-foreground">{index.name}</span>
              {index.isPrimary ? <Chip tone="ok" label="PRIMARY" /> : null}
              {index.isUnique && !index.isPrimary ? <Chip tone="warn" label="UNIQUE" /> : null}
            </div>
            <p className="mt-1 break-all font-mono text-[11px] text-muted">{index.definition}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ConstraintsSection({ structure }: { structure: TableStructure }) {
  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium text-foreground">约束</h3>
      <div className="mt-2 space-y-2">
        {structure.constraints.map((constraint) => (
          <div key={constraint.name} className="rounded-lg border border-border bg-elevated p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-foreground">{constraint.name}</span>
              <Chip tone="muted" label={constraint.type} />
            </div>
            <p className="mt-1 break-all font-mono text-[11px] text-muted">{constraint.definition}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
