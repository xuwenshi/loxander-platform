# ADR 0001：采用 monorepo + npm workspaces

- **状态**：Accepted
- **日期**：2026-10-21
- **决策者**：Loxander 平台 P0 阶段

---

## Context

当前有两个独立仓库：

| 仓库 | 内容 | commit 数 | 现状 |
| --- | --- | --- | --- |
| `my-blog` | Next.js 16.4.0 公开博客与作品集 | 11 | main 分支，工作区干净 |
| `electron-cms` | Electron 桌面内容编辑器 | 6 | main 分支，工作区干净 |

两者在内容模型上**已经存在事实耦合**，但没有任何共享代码：

- `my-blog/src/types/index.ts` 定义了四类内容的 `PostMeta` / `ProjectMeta` / `DiaryMeta` / `Goal` 类型。
- `electron-cms/src/main/services/schemaService.ts` 又独立定义了一份对齐的 frontmatter 契约（`CONTENT_SECTIONS`、`FieldSpec`、`SectionSchema`）。
- 两边各自实现 Markdown 渲染管线，都依赖 `unified` / `remark-parse` / `remark-gfm` / `rehype-stringify` / `rehype-slug` / `shiki`。
- `electron-cms/src/main/services/__tests__/schema.contract.test.ts` 用真实内容做契约测试，就是为了「锁死与博客仓库的漂移」——**这是对双份契约的补偿措施，不是解决方案**。

平台化后还要新增：Web 后台、认证、API、数据库访问、Markdown 导入器。这些能力必须与公开站点共享同一套内容 schema，否则方案 §19 风险表的「静态读取与动态读取混用 → 数据不一致」会直接命中。

方案 §5 技术选型已确定「Monorepo → npm workspaces，沿用 npm 降低迁移风险」，§21 确认项第 2 条也确认「使用 npm workspaces」。

## Decision

**采用单仓库 monorepo，用 npm workspaces 管理 `apps/*` 与 `packages/*`。**

具体形态：

```text
loxander-platform/
├─ apps/
│  ├─ web/        # my-blog 全量历史导入
│  └─ desktop/    # electron-cms 全量历史导入
├─ packages/
│  ├─ content-core/   # Zod schema、内容类型、slug 规则、发布状态
│  ├─ markdown/       # Markdown → HTML、TOC、Shiki、sanitize
│  ├─ editor/         # CodeMirror、预览组件、编辑状态
│  └─ config/         # TS / ESLint / Tailwind / 测试共享配置
├─ db/            # Drizzle schema 与迁移
├─ scripts/       # 导入、核对、备份、迁移检查
├─ docs/          # ADR、迁移记录、运维手册
├─ package.json   # workspaces: ["apps/*", "packages/*"]
└─ tsconfig.base.json
```

**不使用 pnpm / Turborepo**，理由：

| 备选 | 为什么不选 |
| --- | --- |
| pnpm | 需要额外的 `pnpm-lock.yaml` 与符号链接式 `node_modules`，本机已有 `core.autocrlf=true`、`turbopack.root` 等 Windows 环境敏感项，再引入 pnpm 的符号链接机制会放大排查面。方案 §5 已定 npm |
| Turborepo | 当前仓库规模（2 个 app、4 个 package）远未到需要远程缓存与任务编排的复杂度。引入后每个任务都要维护 `turbo.json` 的 `inputs`/`outputs`，收益为负 |
| Yarn / Bun workspaces | 同上，且与现有 `package-lock.json` 不兼容，需要全量重装 |

**历史保真导入方式**：不用 `git subtree`（本机不可用，见 `docs/migration-p0.md` §1.1），改用 `git bundle` + `git merge -s ours --allow-unrelated-histories --no-commit` + `git read-tree --prefix=`。导入结果已用 **blob 哈希逐条比对**验证：`apps/web` 89 个 blob、`apps/desktop` 69 个 blob 与旧仓库 HEAD **完全一致**，零内容改动。

## Consequences

### 负面后果（具体代价）

1. **`@types/node` 已经真实冲突，这是本决策唯一立刻咬人的代价。**
   实测（`apps/web/package.json` vs `apps/desktop/package.json`）：
   - `apps/web` 声明 `@types/node: ^20`，实际安装 **20.19.43**
   - `apps/desktop` 声明 `@types/node: ^24.0.0`，实际安装 **24.19.2**
   - `^20` 与 `^24.0.0` **semver 范围无交集**，npm workspaces 无法提升成一份，会在 `apps/web/node_modules` 与 `apps/desktop/node_modules` 各装一份。
   - 后果：TypeScript 在两个 workspace 中看到的 Node 全局类型不一致。`apps/desktop` 能用 `@types/node@24` 的 API（如较新的 `fs` 重载、`AbortSignal` 相关类型），搬到 `apps/web` 会报类型错误；反之 `apps/web` 若按 `@types/node@20` 写的代码在 desktop 里可能被更严格的类型拒绝。
   - **必须处理**：P1 建立 `packages/content-core` 时，如果该包同时被两个 app 引用，`@types/node` 版本分歧会让 `packages/*` 的 typecheck 结果取决于从哪个 workspace 解析。建议在 P0 后续步骤统一到 `^24`（desktop 已用 24，web 的 Next 16 也要求 Node 20+，升到 24 兼容），并在根 `package.json` 用 `overrides` 固定。**这条不做，P1 会踩坑。**

   > **补充（2026-10-21 复核）**：当前 `typecheck:desktop` exit 0 **只证明类型层面无冲突，不证明运行时安全**。electron 38.8.6 自身依赖 `@types/node: ^22.7.7`，被根 `overrides` 强制升到 24.19.2 后，`@types/node@24` 暴露了 Node 23/24 才有的 API 面——若 `apps/desktop` 将来用到这些 API，typecheck 会通过但运行时会炸。**若 desktop 出现 electron 相关的运行时异常（而非类型错误），第一怀疑对象是这条 overrides。** 稳妥做法是在解除 ADR 0003 冻结时，一并复核 electron 的 Node 版本与 `@types/node` 是否重新对齐。

2. **其余 14 个共同依赖虽有交集，但声明范围不一致，仍会带来解析不确定性。**
   实测 15 个两边都声明的包中，14 个范围有交集（可提升共用），但**只有 3 个范围写法完全相同**（`gray-matter`、`rehype-slug`、`remark-parse`）。另外 11 个写法不同，例如：
   - `react`：web 是精确版本 `19.3.0`，desktop 是 `^19.0.0`
   - `shiki`：web `^4.5.0`，desktop `^4.0.0`
   - `typescript`：web `^5`，desktop `^5.6.0`
   - `tailwindcss`：web `^4`，desktop `^4.3.3`

   当前实际安装版本一致（react 19.3.0 / typescript 5.9.3 / tailwindcss 4.3.3 / shiki 4.5.0 两边相同），但**这是 lockfile 恰好收敛的结果，不是声明保证的**。npm 提升时按「满足范围的最优版本」解析，一旦某个包发新版，可能只有一边升级，出现同一 workspace 树里两份副本。代价是「装出来的东西和声明的不完全对应」，排查构建问题时多一层不确定性。

3. **`next` 只存在于 `apps/web`，`electron` 只存在于 `apps/desktop`，这是好事，但也意味着提升后的根 `node_modules` 会同时含两套重型工具链。**
   实测两边独占依赖：`apps/web` 独有 10 个（`next`、`eslint-config-next`、`@tailwindcss/turbopack`、`@shikijs/rehype` 等），`apps/desktop` 独有 15 个（`electron`、`electron-builder`、`electron-vite`、`vite`、`vitest`、`@codemirror/*`、`zustand` 等）。Electron 二进制本身体积数百 MB，Next 的 `.next` 缓存也会落在 `apps/web`。**代价：单次 `npm install` 时间与磁盘占用显著高于两个独立仓库之和**（因为无法共享 lockfile 之外的缓存），CI 上尤其明显。

4. **`turbopack.root` 必须从 `process.cwd()` 改成 monorepo 根，否则 `packages/*` 无法解析。**
   这是 monorepo 化的直接副作用。`my-blog/next.config.ts` 原本写 `root: process.cwd()`，注释说明是为了避免 Turbopack 向上找到 `C:\Users\luoxu` 的 lockfile。迁移后 Next 会靠 lockfile 自动探测 root，而 monorepo 根有 `package-lock.json`，探测结果可能变成 monorepo 根；此时显式 `process.cwd()` 会把 root 钉死在 `apps/web`，导致 `packages/*` 在 root 之外**不可解析**。依据 `my-blog/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopack.md` 第 115–117 行。**代价：B 段必须改这个配置并重新验证构建，不能直接沿用旧配置。**

5. **根 `package.json` 与两个子项目 `package.json` 并存，`scripts` 语义需要重新定义。**
   导入后 `apps/web` 有 `dev`/`build`/`lint`，`apps/desktop` 有 `dev`/`build`/`typecheck`/`test`/`build:win`。根 `scripts` 目前用 `npm run <x> --workspaces --if-present` 聚合，但两边的同名脚本语义不同（web 的 `build` 是 `next build`，desktop 的 `build` 是 `electron-vite build`）。**代价：在根目录跑 `npm run build` 会同时触发两套构建，桌面端构建需要 Electron 环境，可能在 CI 上失败。** 后续需要按 app 拆分入口（如 `build:web`、`build:desktop`）。

6. **仓库体积与 clone 成本上升。** 两个旧仓库的历史（11 + 6 commit，89 + 69 文件）全部进入一个仓库，`apps/web` 还带入了 `.agents/` 12 个 skill 文件与 `skills-lock.json`。当前体量很小（bundle 分别 275 KB / 251 KB），但历史会持续累积，未来无法只 clone 一个 app。

7. **权限与所有权粒度变粗。** 单仓库意味着任何人拿到仓库访问权就能看到全部内容（含 `apps/desktop` 的部署配置、`docs/` 的运维手册）。多仓库方案可以只给 `my-blog` 协作者公开站点权限。当前是单管理员项目，影响有限，但这是 monorepo 的固有代价。

### 正面后果

- 四类内容的 schema 可以收敛到 `packages/content-core` 一份，消除 `my-blog/src/types/index.ts` 与 `electron-cms/.../schemaService.ts` 的双份契约。
- Markdown 渲染管线收敛到 `packages/markdown`，保证方案 §11 P1 验收项「同一 Markdown 在 Web 与 Electron 中得到一致 HTML」可测。
- 一次 commit 可以同时改动 schema 与两个消费方，避免跨仓库版本对齐。
- 两个旧仓库的完整历史保留（21 个 commit 全部可达），可追溯性不降级。

### 后续必须跟进

| # | 事项 | 阶段 |
| --- | --- | --- |
| 1 | 统一 `@types/node` 到同一版本，根 `package.json` 加 `overrides` | P0 后续 |
| 2 | `turbopack.root` 改为 monorepo 根 | P0 后续 / B 段 |
| 3 | 根 `scripts` 按 app 拆分，避免误触发 Electron 构建 | P1 |
| 4 | 收敛 11 个「写法不同但有交集」的依赖范围 | P1 |
| 5 | 决定 `.agents/` 与 `skills-lock.json` 的归属 | P1 / P8 |

---

## 与方案的一致性核对

| 方案章节 | 原文要点 | 本 ADR 是否冲突 | 说明 |
| --- | --- | --- | --- |
| §1.4 非目标 | 「不删除旧仓库和旧部署，直到新平台通过完整观察期」 | **不冲突** | 本 ADR 用 bundle 导入而非移动/删除，`my-blog` 与 `electron-cms` 原目录与 HEAD（`3ab15d3` / `8f8ed5a`）全程未变 |
| §1.4 非目标 | 「不把 Electron 改造成服务器」「不在 Vercel 上运行 Electron 主进程」 | **不冲突** | `apps/desktop` 只是目录归属，不参与 Vercel 构建；根 `scripts` 目前用 `--if-present` 聚合，后续需按 app 拆分以免误触发（见负面后果 5） |
| §5 技术选型 | 「Monorepo → npm workspaces，沿用 npm，降低迁移风险」 | **完全一致** | 本 ADR 明确不引入 pnpm / Turborepo |
| §5 技术选型 | 「TypeScript 5，strict」 | **不冲突** | 根 `tsconfig.base.json` 已设 `strict: true`，供 apps/packages 继承 |
| §19 风险表 | 「静态读取与动态读取混用 → 数据不一致 → 单一 repository，迁移期显式开关」 | **本 ADR 为必要条件** | monorepo 让 repository 接口能收敛到 `packages/content-core`，是「单一 repository」的结构前提 |
| §21 确认项 | 第 1 条「新仓库命名为 `loxander-platform`」、第 2 条「使用 npm workspaces」 | **完全一致** | 均已落地 |

---

## 相关文档

- `docs/migration-p0.md`：实际导入命令、subtree 失败原因、blob 哈希验证结果
- `docs/recon-p0.md` §1.3：`turbopack.root` 在 monorepo 下的语义与风险
- `动态网站平台化执行方案.md` §4（目标仓库结构）、§5（技术选型）、§19（风险表）、§21（确认项）
