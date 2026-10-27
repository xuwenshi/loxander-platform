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

### 运维台 `/admin/ops`

后台里的运维分区，18 项能力全部在 `apps/web/src/lib/ops/capabilities.ts` 声明，页面上显示的可用性由运行时判据算出（14 可用 / 1 禁用 / 3 如实标注只能去终端跑），不是写死的文案。

| 页面 | 内容 |
| --- | --- |
| `/admin/ops/db` | 表清单与体积、只读 SQL 面板、迁移状态（磁盘 3 份 vs 库里已应用 + sha256 比对）、逻辑备份与只读比对 |
| `/admin/ops/checks` | 环境 / 迁移 / 构建 / CSS / 仓库五项检查进程内执行 |
| `/admin/ops/runtime` | BUILD_ID、git HEAD、数据库只读自证、CSS 产物、版本一致性（本机 HEAD vs 线上 `version`）、16 条路由巡检 |
| `/admin/ops/env` | env 矩阵（复用 `buildSettingsReport()`）+ Vercel（含 `linkType`）+ Neon 端点状态 |

**数据库只读**：连接层 `default_transaction_read_only = on` 是唯一不依赖正则正确性的防线；上层再做单条语句、首词白名单、剥离字面量后匹配 36 个禁用词（含 `INTO`）、8 秒语句超时、500 行上限。恢复备份刻意不做（用户选只读），要恢复去终端跑 `npm run db:restore`。

**为什么脚本不能用按钮跑**：`child_process` 在本机沙箱下 `spawn EPERM`，Vercel Serverless 也不提供。所以「点按钮跑 preflight / Playwright / 回滚演练」这一类被如实标成 `unavailable` 并给出终端命令，而不是假装能跑。

### 本地打开运维台

桌面上有一个 **「运维台」** 快捷方式，双击即起服务并打开 `http://localhost:3210/admin/ops`。命令行等价于 `npm run ops`。

```bash
npm run ops                # 起服务 + 开浏览器（双击快捷方式做的事）
npm run ops:url            # 只打印 URL
npm run ops:shortcut       # 重建桌面快捷方式
npm run ops:icon           # 重新生成 scripts/ops.ico
```

端口固定 **3210**、浏览器开 **`localhost`** 而不是 `127.0.0.1` —— 这两个都不是随意选的：前者要和 `apps/web/.env.local` 的 `AUTH_URL` 与 GitHub OAuth App 登记的回调地址一致，后者决定会话 cookie 能不能被带上。细节与排错见 `docs/ops-desktop-shortcut.md`。

## 文档

- `docs/p8-legacy-retirement.md` — 旧链路下线与归档记录（含三项本机无权限完成的事项）
- `docs/ops-desktop-shortcut.md` — 运维台桌面快捷方式：为什么端口是 3210、为什么开 localhost、排错表
- `docs/migration-p0.md` — 旧仓库到 monorepo 的迁移记录
- `docs/recon-p0.md` — P0 侦察结论
