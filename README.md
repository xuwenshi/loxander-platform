# loxander-platform

Loxander 动态内容平台 monorepo：一个仓库承载公开站点、后台、可选桌面端与共享内容包（`apps/*` + `packages/*`，npm workspaces 管理）。

线上地址：<https://loxander.is-a.dev>

## 目录

| 目录 | 职责 |
| --- | --- |
| `apps/web` | 公开站点、后台（`/admin`）、认证、API、数据库访问 |
| `apps/desktop` | 可选 Electron 离线客户端。**自动发布默认关闭**（P8 旧链路下线），见 `docs/p8-legacy-retirement.md` |
| `packages/content-core` | Zod schema、内容类型、slug 规则、发布状态 |
| `packages/markdown` | Markdown 转 HTML、TOC、Shiki 高亮、外链安全处理 |
| `db` | Drizzle schema、迁移、导入器、双路比对、迁移执行 |
| `scripts` | 备份/恢复、Markdown 导出、上线前检查、浏览器验收、回滚演练 |
| `docs` | 架构决策、迁移记录、旧链路下线说明 |

> 目录表只列**真实存在**的目录。`packages/editor`、`packages/config` 是早期规划里提到过但最终没有落地的位置——编辑器组件放在 `apps/web/src/components/admin/`，共享配置直接写在各包的 `tsconfig` / `next.config` 里，没有单独抽包。

## 内容源

内容存在 Postgres（Neon），由 `db/schema.ts` 定义，共 7 张业务表 + 4 张认证表。

代码读取内容只有**一个入口**：`apps/web/src/lib/content.ts`（15 个 async 函数，纯转发）。它背后有两个可切换的实现（`apps/web/src/lib/content-source.ts`）：

| `CONTENT_SOURCE` | 实现 | 用途 |
| --- | --- | --- |
| `db` | `lib/sources/db.ts` | 生产环境。读 Neon |
| `markdown` | `lib/sources/markdown.ts` | 回滚通道 / 离线开发。读 `apps/web/content/*.md` |

两条路必须**逐字节等价**，由 `npm run db:compare` 守护（当前 137 个检查项、0 差异）。

## 常用命令

```bash
# 日常
npm install
npm test                    # 全部离线测试（db + web + markdown，共 275 条）
npm run typecheck
npm run build:web:local     # 本机构建（沙箱环境下 next build 需走这个）

# 数据库
npm run db:migrate          # 对真库执行迁移
npm run db:import           # Markdown → 数据库
npm run db:compare          # 双路比对（markdown vs db）
npm run db:backup           # 逻辑备份到 backups/
npm run db:restore <file>
npm run export:md           # 数据库 → Markdown（反向导出）
npm run export:md:verify apps/web/content   # 往返等价校验

# 上线前
npm run preflight           # 一条命令回答「现在能不能上」
npm run test:browser        # Playwright 浏览器验收
npm run test:rollback       # 内容源回滚四腿演练
```

## 环境变量

见 `.env.example`。关键几项：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | Neon 连接串，**必须带 `sslmode=require`** |
| `CONTENT_SOURCE` | 是 | `db` 或 `markdown`，非法值直接报错不静默回退 |
| `NEXT_PUBLIC_SITE_URL` | 是 | 站点地址。**注意不叫 `SITE_URL`**，没有任何代码读那个名字 |
| `AUTH_SECRET` | 是 | Auth.js 密钥。生产缺失会抛 `MissingSecretError` 而不是降级 |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | 是 | GitHub OAuth App 凭据 |
| `ADMIN_GITHUB_LOGIN` | 是 | 管理员白名单（逗号分隔）。**留空 = 拒绝所有登录**（fail-closed） |
| `BLOB_READ_WRITE_TOKEN` | 媒体功能需要 | Vercel Blob 写入令牌 |

## 后台

`/admin` 仅限 `ADMIN_GITHUB_LOGIN` 白名单内的 GitHub 账号。写操作在 Server Action 内部独立完成七道校验（会话 → 白名单 → Zod → 乐观锁 → 事务写 → 缓存失效 → 审计），**不依赖 proxy 拦截**——Next 的 Server Function 是 POST 到所在路由，proxy matcher 排除 `api/` 后根本不会经过它。

## 文档

- `docs/p8-legacy-retirement.md` — 旧链路下线与归档记录（含三项本机无权限完成的事项）
- `docs/migration-p0.md` — 旧仓库到 monorepo 的迁移记录
- `docs/recon-p0.md` — P0 侦察结论
