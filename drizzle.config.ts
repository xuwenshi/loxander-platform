import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 配置。
 *
 * 迁移产物落在 `db/migrations/`，与 `db/schema.ts` 同级，随仓库提交。
 * `db:push` 仅用于本地 PGlite 试验，不用于生产（生产一律走迁移文件）。
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/migrations',
  // 生成迁移时不需要真实连接串；只有 push/migrate 才需要。
  ...(process.env.DATABASE_URL
    ? { dbCredentials: { url: process.env.DATABASE_URL } }
    : {}),
  verbose: true,
  strict: true,
});
