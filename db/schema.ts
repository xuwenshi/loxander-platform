/**
 * Loxander 平台数据库 schema（Drizzle / PostgreSQL）。
 *
 * 来源与裁决记录：
 * - 表结构基线：`动态网站平台化执行方案.md` §6.1 ~ §6.6（7 张业务表）
 * - 字段改名：`动态网站平台化执行方案_审查意见.md` 第 2 条 —— 发布状态列必须叫
 *   `publish_status`，**不能**叫 `status`。原因：`data` jsonb 里 projects/goals
 *   的业务状态键名就叫 `status`（见 content-core 的 projects.ts:19 / goals.ts:17），
 *   列与 jsonb 键同名会让人把「项目已归档」误读成「内容下架」。
 * - kind 取值：沿用已冻结的 `ENTRY_KINDS`（复数：blog / projects / diary / goals），
 *   见审查意见第 1 条与 `packages/content-core/src/kinds.ts:12`。
 * - 日期：blog / diary 的 `date`（YYYY-MM-DD）按**东八区**零点落 `published_at`，
 *   即 `date + 'T00:00:00+08:00'`；同时冗余一列 `display_date`（纯 date），
 *   展示值一律取它，禁止用 `published_at` 反推（否则在非东八区渲染会退一天）。
 *   见审查意见第 34 条。
 * - 读时计算字段：`readingTime` **不入库**，运行时按 `body_md` 重算；
 *   封面尺寸 `coverWidth/coverHeight` 属于「封面写入时确定」的稳定量，存 `data`。
 *   见审查意见第 31 条。
 * - 认证四张表（users / accounts / sessions / verification_tokens）P2 不建，
 *   P4 接入 Auth.js 时再补迁移（决策 4 = C）。**P4 已补**，见下方 §6.0，
 *   迁移 `0002_auth_tables.sql`。表名用复数（方案 §6.7 要求），而
 *   `@auth/drizzle-adapter` 默认是单数 `user/account/session/verificationToken`——
 *   靠 `PostgresDrizzleAdapter(db, { usersTable: users, ... })` 显式覆盖，
 *   不是靠改 adapter。
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** 发布状态枚举（列 `publish_status` 的取值，见审查意见第 2 条）。 */
export const PUBLISH_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;

/** 内容分区枚举（与 content-core `ENTRY_KINDS` 完全一致，由测试断言）。 */
export const ENTRY_KINDS_DB = ['blog', 'diary', 'projects', 'goals'] as const;

/* -------------------------------------------------------------------------- */
/* 6.0 认证表（P4 新增，Auth.js v5 + @auth/drizzle-adapter）                    */
/* -------------------------------------------------------------------------- */

/**
 * Auth.js 的账号类型。与 `next-auth/adapters` 的 `AdapterAccountType` 逐字相同，
 * 这里**故意本地定义而不是 import**：`db/schema.ts` 被 `db/*.ts` 脚本直接消费
 * （`node db/import.ts` 等走类型擦除，不经 tsc），把 next-auth 拉进这条链路
 * 会让「只想跑导入脚本」也要能解析 next-auth 的类型。DB 层不该依赖 Web 层。
 */
export const ADAPTER_ACCOUNT_TYPES = ['oauth', 'oidc', 'email', 'webauthn'] as const;

/**
 * 用户表。
 *
 * 表名用复数 `users`（方案 §6.7 原文「users、accounts、sessions、
 * verification_tokens」），而 `@auth/drizzle-adapter` 默认是单数 `user`。
 * 覆盖方式在 `apps/web/src/lib/auth.ts`：把本文件导出的表对象按
 * `{ usersTable, accountsTable, sessionsTable, verificationTokensTable }`
 * 传给 `PostgresDrizzleAdapter`，**不改 adapter 源码，也不建两套表**。
 *
 * `id` 用 uuid 而非 Auth.js 默认的 text：`entries.created_by` /
 * `entry_revisions.created_by` / `audit_logs.actor_id` 已经是 uuid 列，
 * 认证表若用 text 就永远加不上外键，P4 的审计链会断在类型上。
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name'),
    /** 唯一：白名单按 email / login 二选一匹配时不会撞出两个账号。 */
    email: text('email').unique(),
    emailVerified: timestamp('email_verified', { withTimezone: true, mode: 'date' }),
    image: text('image'),
    /** GitHub 的 login（不是显示名）。白名单 `ADMIN_GITHUB_LOGIN` 比的是它。 */
    github_login: text('github_login'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_github_login_idx').on(t.github_login)],
);

export const accounts = pgTable(
  'accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<(typeof ADAPTER_ACCOUNT_TYPES)[number]>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index('accounts_user_id_idx').on(t.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    sessionToken: text('session_token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/* -------------------------------------------------------------------------- */
/* 6.1 核心内容表                                                              */
/* -------------------------------------------------------------------------- */

export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    kind: text('kind').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** 摘要：blog/projects 取 description，diary 取 summary，goals 为空串。 */
    summary: text('summary').notNull().default(''),
    body_md: text('body_md').notNull().default(''),
    /** 渲染缓存，必须能由 body_md 重建（方案 §6.9）。 */
    body_html: text('body_html'),
    publish_status: text('publish_status').notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    sort_order: integer('sort_order').notNull().default(999),
    /** 时间线：blog/diary 取 frontmatter date 的东八区零点；projects/goals 取导入时刻。 */
    published_at: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    /** 展示日期。blog/diary 有值，projects/goals 为 null（它们只有 data.period）。 */
    display_date: date('display_date', { mode: 'string' }),
    /** 类型专属字段（形状见本文末尾的 EntryData 类型）。 */
    data: jsonb('data')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** 乐观锁版本号，后台保存必须带读到的版本。 */
    version: integer('version').notNull().default(1),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /**
     * 认证表在本文档中先于 entries 声明，所以这里可以加外键。
     * P2 当时留的两个裸 uuid 列在 P4 补齐（`0002_auth_tables.sql`）。
     * onDelete 用 set null：管理员被删掉时审计字段保留「有过修改」这一事实，
     * 不能 cascade 把内容一起删了。
     */
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('entries_kind_slug_idx').on(t.kind, t.slug),
    index('entries_public_idx').on(t.kind, t.publish_status, t.published_at),
    check(
      'entries_kind_check',
      sql`${t.kind} in ('blog', 'diary', 'projects', 'goals')`,
    ),
    check(
      'entries_publish_status_check',
      sql`${t.publish_status} in ('draft', 'scheduled', 'published', 'archived')`,
    ),
    check('entries_version_positive_check', sql`${t.version} >= 1`),
  ],
);

/* -------------------------------------------------------------------------- */
/* 6.2 版本表                                                                  */
/* -------------------------------------------------------------------------- */

export const entryRevisions = pgTable(
  'entry_revisions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entry_id: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** 结构化快照：entries 行去掉 id/created_at 等，保留可回滚的全部业务字段。 */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    change_note: text('change_note'),
    /** 谁做的这次修改。set null：账号删了但版本历史必须留着。 */
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('entry_revisions_entry_version_idx').on(t.entry_id, t.version)],
);

/* -------------------------------------------------------------------------- */
/* 6.3 标签表                                                                  */
/* -------------------------------------------------------------------------- */

export const tags = pgTable(
  'tags',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tags_slug_idx').on(t.slug)],
);

export const entryTags = pgTable(
  'entry_tags',
  {
    entry_id: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    tag_id: bigint('tag_id', { mode: 'number' })
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    /**
     * 该标签在本篇内容里的展示顺序（0 起，对应 frontmatter `tags` 数组下标）。
     *
     * 为什么需要这一列（方案 §6.3 的 DDL 里没有）：
     * 原 DDL 只有 (entry_id, tag_id) 复合主键，读回时只能 `order by tag_id`，
     * 而 `tag_id` 是 bigserial，记录的是「该标签全局首次插入」的顺序，不是
     * 单篇 frontmatter 的顺序。实测：`blog/rag-chunking-strategies.md` 的
     * `["RAG","LLM","向量检索","文本分块"]` 会还原成 `["LLM","RAG",...]`——
     * 4 篇有标签的 blog 里已经错 1 篇。
     *
     * 影响面：`getAllTags()`（计数后按 count desc + name asc 重排）与
     * `getRelatedPosts()`（Set 成员判断）都不依赖单篇顺序，但 Chip 渲染
     * （`PostCard.tsx:38` 的 `tags.slice(0, 4)`、`diary/page.tsx:75`）依赖，
     * 所以顺序必须能精确还原，不能靠近似。
     */
    tag_order: integer('tag_order').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.entry_id, t.tag_id] }),
    // 读回单篇的全部标签时按 (entry_id, tag_order) 走索引，避免额外排序。
    index('entry_tags_entry_order_idx').on(t.entry_id, t.tag_order),
  ],
);

/* -------------------------------------------------------------------------- */
/* 6.4 媒体表                                                                  */
/* -------------------------------------------------------------------------- */

export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** 仓库内相对路径（如 `public/images/x.svg`）或对象存储 key。 */
    path: text('path').notNull(),
    /** 对外可访问 URL。 */
    url: text('url').notNull(),
    mime_type: text('mime_type').notNull(),
    size_bytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    alt: text('alt').notNull().default(''),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('media_path_idx').on(t.path)],
);

/* -------------------------------------------------------------------------- */
/* 6.5 重定向表                                                                */
/* -------------------------------------------------------------------------- */

export const redirects = pgTable(
  'redirects',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source_path: text('source_path').notNull(),
    target_path: text('target_path').notNull(),
    status_code: integer('status_code').notNull().default(301),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('redirects_source_path_idx').on(t.source_path),
    check('redirects_status_code_check', sql`${t.status_code} in (301, 302, 307, 308)`),
    check('redirects_no_self_check', sql`${t.source_path} <> ${t.target_path}`),
  ],
);

/* -------------------------------------------------------------------------- */
/* 6.6 审计表                                                                  */
/* -------------------------------------------------------------------------- */

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 操作者。set null：审计记录不因账号删除而消失。 */
    actor_id: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entity_type: text('entity_type').notNull(),
    entity_id: text('entity_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ip_hash: text('ip_hash'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_entity_idx').on(t.entity_type, t.entity_id)],
);

/* -------------------------------------------------------------------------- */
/* data jsonb 的类型形状（仅类型，不参与建表）                                  */
/* -------------------------------------------------------------------------- */

/**
 * 各分区在 `data` 里的键名**保持与 content-core schema 完全一致**（决策 1 = A）。
 *
 * 这样 `data` 就是 `parseEntry()` 输出的直接投影（去掉已提升为列的字段），
 * P4 后台表单可以直接双向绑定，不需要任何重命名映射层。
 * 曾经担心的「`data.status` 与列 `status` 撞名」已由 `publish_status` 改名消除。
 */
export interface BlogData {
  category: string;
  cover?: string;
  /** 封面写入时从 SVG 解析，稳定量。 */
  coverWidth?: number;
  coverHeight?: number;
}

export interface DiaryData {
  /**
   * 注意：**不含 date**。
   *
   * diary 的日期是 `entries.display_date` 列（不是 timestamptz，因为它是「日历日」而非
   * 时刻），已有专列承载，`data` 里不再存第二份。同一事实存两份，P4 后台改日期时
   * jsonb 与列必然漂移。
   *
   * 方案 §6.8 原先要求「data 里留 date 备份」的表述已作废，以本注释为准。
   */
  mood?: string;
}

export interface ProjectsData {
  techStack: string[];
  /** 业务状态：active / in-progress / completed / archived。与 publish_status 无关。 */
  status: string;
  period?: string;
  role?: string;
  github?: string;
  demo?: string;
  /** 关联 blog slug。 */
  article?: string;
}

export interface GoalsData {
  horizon: string;
  /** 业务状态：planned / active / done / paused。与 publish_status 无关。 */
  status: string;
  progress: number;
  period?: string;
  milestones: { title: string; done: boolean }[];
}
