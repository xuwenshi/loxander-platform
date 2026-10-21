# loxander-platform

Loxander 动态内容平台 monorepo：一个仓库承载公开站点、后台、可选桌面端与共享内容包（`apps/*` + `packages/*`，npm workspaces 管理）。

## 目录

| 目录 | 职责 |
| --- | --- |
| `apps/web` | 公开站点、后台、认证、API、数据库访问 |
| `apps/desktop` | 可选 Electron 客户端，第一阶段冻结或仅做兼容维护 |
| `packages/content-core` | Zod schema、内容类型、slug 规则、发布状态（P1 建立） |
| `packages/markdown` | Markdown 转 HTML、TOC、Shiki、sanitize（P1 建立） |
| `packages/editor` | CodeMirror 编辑器、预览组件、编辑状态（P1 建立） |
| `packages/config` | TypeScript、ESLint、Tailwind、测试共享配置（P1 建立） |
| `db` | Drizzle schema 与迁移（P2 建立） |
| `scripts` | Markdown 导入、数据核对、备份、迁移检查 |
| `docs` | 架构决策、迁移记录、运维手册 |

## 当前阶段

P0 基线整理：仓库骨架与 npm workspaces 已建立，两个旧仓库的历史分别导入 `apps/web` 与 `apps/desktop`。
根 `package.json` 的 `lint` / `typecheck` / `test` / `build` 目前是 `--workspaces --if-present` 形式的聚合占位入口，统一配置在后续阶段收口。

旧仓库 `my-blog` 与 `electron-cms` 保持只读，作为历史来源保留，直到新平台通过完整观察期。
