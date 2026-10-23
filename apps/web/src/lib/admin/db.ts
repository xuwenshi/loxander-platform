import "server-only";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../../../../../db/schema";

/**
 * 后台写路径的数据库连接。
 *
 * ── 为什么不复用 `lib/sources/db.ts` 的 `getDb()` ─────────────────────
 * 那个连接是**只读路径**的私有单例，且**不绑定 schema**（`Record<string, never>`）。
 * 后台需要两件它给不了的东西：
 *
 * 1. **绑定的 schema**：`db.transaction()` 里要按表对象写（`tx.insert(entries)`），
 *    还要 `tx.select().from(entryRevisions)`。无 schema 的实例每处都得 `import` 表，
 *    且 `tx` 的类型会退化成 `any`，七道关里的「事务内写入」就失去了类型保护。
 * 2. **写权限语义**：读路径连接用 `max: 5` 并长期存活；后台是低频率、长事务，
 *    要独立的池，否则一次后台大事务会把前台读的 5 条连接全占满。
 *
 * 代价是同一进程里有两条池。对单人博客这个量级无所谓，换来的是读写两条路
 * 的故障域彻底分开 —— 后台出事不会让站点打不开。
 */

/** 带 schema 的 drizzle 实例类型（事务里 `tx` 也是这个形状的 PgTransaction）。 */
export type AdminDb = PostgresJsDatabase<typeof schema>;

interface AdminConnection {
  db: AdminDb;
  close: () => Promise<void>;
}

/** 进程内单例。后台并发极低，不需要更复杂的池管理。 */
let cachedConnection: Promise<AdminConnection> | undefined;

/**
 * 测试 / 离线比对注入点（PGlite）。
 *
 * 与 `lib/sources/db.ts` 的 `setDbContentSourceDatabase` 同构：生产永远走自建连接，
 * 这个钩子只让「没有 Postgres 的机器」能跑真迁移后的完整写路径。
 */
let injectedDb: AdminDb | undefined;

export function setAdminDatabase(db: AdminDb | undefined): void {
  injectedDb = db;
}

function makeConnection(url: string): Promise<AdminConnection> {
  return (async () => {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");

    // max 1：后台是单人操作，且写操作都是短事务。开大没有收益，只会占用
    // Neon 免费档的连接配额（其 direct 连接上限只有个位数）。
    const client = postgres(url, { max: 1, onnotice: () => {} });

    return {
      db: drizzle(client, { schema }) as AdminDb,
      close: () => client.end({ timeout: 5 }),
    };
  })();
}

/**
 * 取后台数据库连接（惰性、单例）。
 *
 * 与读路径一样用动态 `import()`：`CONTENT_SOURCE=markdown` 且没人登录后台时，
 * `postgres` / `drizzle-orm` 不必进入模块图。
 */
export async function getAdminDb(): Promise<AdminDb> {
  if (injectedDb) return injectedDb;

  cachedConnection ??= (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "[admin/db] 缺少 DATABASE_URL。后台必须连真库；" +
          "本地想验证请用 PGlite 注入（setAdminDatabase）。",
      );
    }
    return makeConnection(url);
  })();

  return (await cachedConnection).db;
}

/** 清空连接缓存（测试 / 热重载用）。 */
export async function closeAdminConnection(): Promise<void> {
  if (!cachedConnection) return;
  const pending = cachedConnection;
  cachedConnection = undefined;
  const connection = await pending.catch(() => undefined);
  await connection?.close().catch(() => undefined);
}

/** 供后台页面判断「是否配置了真库」，避免没配库时整页 500。 */
export function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
