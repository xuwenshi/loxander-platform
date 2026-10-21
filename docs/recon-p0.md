# P0 只读侦察报告

本文是 P0 阶段的只读侦察结论，用于给 B 段（Next 16 配置迁移）与 P1（共享内容核心）提供事实依据。

- 侦察日期：2026-10-21
- 侦察对象：`my-blog`（HEAD `3ab15d3`）、`electron-cms`（HEAD `8f8ed5a`）
- 侦察方式：只读。未修改任何被侦察文件。
- **重要**：本文所有 Next.js API 结论均来自 `my-blog/node_modules/next/dist/docs/` 下的 16.4.0 随包文档，不是凭记忆推测。`my-blog/AGENTS.md` 也明确要求「Read the relevant guide in `node_modules/next/dist/docs/` before writing any code」。

---

## 1. Next.js 16.4.0 配置契约

`my-blog/next.config.ts` 当前启用了三个顶层配置：

| 配置项 | 值 | 是否 experimental | 正式化版本 |
| --- | --- | --- | --- |
| `cacheComponents` | `true` | **否**，已是顶层正式选项 | 16.0.0 从 `experimental.cacheComponents` 提升为顶层 |
| `partialPrefetching` | `true` | **否**，已是顶层正式选项 | 16.3.0 引入 |
| `turbopack.root` / `turbopack.rules` | `process.cwd()` / `*.css` → `@tailwindcss/turbopack` | **否**，`turbopack` 是顶层正式选项 | 15.3.0 由 `experimental.turbo` 改名为 `turbopack` |

### 1.1 `cacheComponents`

- **来源文档**：`my-blog/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.md`
- **正式语义（原文关键段落）**：

  > Cache Components enables component and function-level caching using the `use cache` directive. Data fetching is dynamic by default, and you choose what to cache at the page, component, or function level. Next.js prerenders a static HTML shell that is served immediately while dynamic content streams in when ready, letting you mix static and dynamic content within a single route.

- **必须与 `partialPrefetching` 一起显式声明**（同文档第 16、29 行）：

  > To enable the `cacheComponents` flag, set it to `true` in your `next.config.ts` file, together with `partialPrefetching`
  >
  > Set `partialPrefetching` explicitly. Leaving it unset logs a warning, because the first release of Cache Components did not include Partial Prefetching.

- **副作用一：PPR 变成默认行为**（第 41 行）：

  > Additionally, `cacheComponents` implements **Partial Prerendering (PPR)** as the default behavior in the App Router. This means the `experimental.ppr` configuration flag and the `experimental_ppr` route segment configuration are no longer necessary and have been removed.

- **副作用二：需要 Node.js runtime**（第 31 行）：

  > Cache Components requires the Node.js runtime. Migrate any routes that set the deprecated `runtime = 'edge'` export, and note that other server-side JavaScript runtimes are not guaranteed to work.

  > ⚠️ **对 Loxander 的影响**：方案 §5 选 Vercel 部署。这条限制意味着**不能把任何路由改成 edge runtime**，包括后续的 API 路由与后台。若将来考虑 Cloudflare Workers 等非 Node 运行时，`cacheComponents` 会成为阻塞项，需要在架构上提前确认。

- **副作用三：导航改用 React `<Activity>`**（第 49–59 行）：路由切换时旧路由不再 unmount，而是设为 `"hidden"`，组件状态被保留。这会改变下拉菜单、对话框等 UI 的行为，B 段迁移组件时需注意。

- **可用 API 清单**（第 33–37 行）：`use cache` 指令、`cacheLife()`、`cacheTag()`。

### 1.2 `partialPrefetching`

- **来源文档**：`my-blog/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/partialPrefetching.md`
- **正式语义（原文第 14 行）**：

  > `partialPrefetching` enables Partial Prefetching at the app level. The framework prefetches the static parts of each route by default; set `prefetch={true}` on individual links to use per-link prefetching and fetch more.

- **强依赖关系**（第 36 行）：

  > `partialPrefetching` requires `cacheComponents`. Without it, `next dev` and `next build` throw at config validation.

  → 两者是**硬绑定**，不能只开一个。

- **取值语义**（第 40–45 行）：

  | 值 | 语义 |
  | --- | --- |
  | `true` | 全站启用 Partial Prefetching |
  | `false` | 保留旧 prefetch 行为，仅供「在 Partial Prefetching 出现之前就已采用 Cache Components」的应用 |
  | 未设置 | 等同 `false`，并在 `cacheComponents` 启用时打 warning |

- **行为变化**（第 47–53 行）：旧行为是「N 个链接 → N 次路由 prefetch」；新行为是**每个路由只 prefetch 一个可复用的 App Shell**，含 `params` / `searchParams` 的 URL 相关内容在导航后才解析。

- **App Shell 定义**（`my-blog/node_modules/next/dist/docs/01-app/04-glossary.md` 第 15–17 行）：

  > A per-route prerender containing the parts of a page that don't depend on URL data. Cached content is included when its `stale` time is at least 5 minutes... Used as the default prefetch payload during client navigations.

  > ⚠️ **对 Loxander 的影响**：`stale` 时间 ≥ 5 分钟的缓存内容才会进 App Shell。后续做后台内容缓存失效时，`cacheLife` 的 `stale` 取值会直接影响首屏预取效果，不能随意设小。

- **版本历史**（第 65–69 行）：`16.3.0` 引入，要求 `cacheComponents` 开启。

### 1.3 `turbopack`

- **来源文档**：`my-blog/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopack.md`
- **正式语义**：顶层 `turbopack` 选项（第 10 行注明 13.0.0–15.2.x 时叫 `experimental.turbo`，15.3.0 改名）。

- **`root` 的语义**（第 49 行、92–117 行）：

  > | `root` | Sets the application root directory. Should be an absolute path. |
  >
  > Turbopack uses the root directory to resolve modules. Files outside of the project root are not resolved.
  >
  > Next.js automatically detects the root directory of your project. It does so by looking for one of these files: `pnpm-lock.yaml`、`package-lock.json`、`yarn.lock`、`bun.lock`、`bun.lockb`
  >
  > Use this option to configure the root when working in a monorepo. Do not extend the root directory too broadly (e.g. to your home directory). Turbopack may watch all files inside of roots, and configuring too broad of a root directory can cause significant performance problems.

  > 🔴 **monorepo 迁移关键风险**：`my-blog/next.config.ts` 现在写的是 `root: process.cwd()`，注释说明原因是「否则 Turbopack 会向上查找到 `C:\Users\luoxu` 下的 lockfile」。
  >
  > 迁移到 `apps/web` 后：
  > 1. `process.cwd()` 在 `next dev` / `next build` 时仍是 `apps/web`，**语义不变，不会立刻出错**；
  > 2. 但方案 §4 的 monorepo 根会有 `package-lock.json`。文档说 Next 靠 lockfile 自动探测 root——一旦根 lockfile 存在，**Turbopack 可能把 root 探测成 monorepo 根**，此时 `process.cwd()` 这个显式值反而会把 root 钉死在 `apps/web`，导致 `packages/*` 下的共享包「在 root 之外」而**无法解析**。
  > 3. 按文档第 115、117 行，monorepo 的正确做法是把 `turbopack.root` 设为**包含 apps 与 packages 的父目录**（即 monorepo 根），而不是 `process.cwd()`。
  >
  > → **B 段必须把 `turbopack.root` 改成 monorepo 根路径**（如 `path.join(__dirname, '../..')`），否则 P1 建立 `packages/content-core` 后 `apps/web` 将无法 import 它。这是本次侦察最重要的发现。

- **`rules` 的语义**（第 50 行、164–191 行）：

  > | `rules` | List of supported webpack loaders to apply when running with Turbopack. |
  >
  > Only loaders that return JavaScript code are supported. Loaders that transform files like stylesheets or images are not currently supported.

  现有配置 `"*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" }` 用的是 `as` 字段改写输出类型，属于支持范围。文档第 189 行补充：`rules` 的 glob 若不含 `/` 则按**文件名**匹配，含 `/` 才按项目相对路径匹配；Windows 路径会归一成 `/`。

- **`@tailwindcss/turbopack` 未出现在官方文档的「已测试 loader」清单里**。该清单（第 59–66 行）只有 `babel-loader`、`@svgr/webpack`、`svg-inline-loader`、`yaml-loader`、`string-replace-loader`、`raw-loader`、`sass-loader`、`graphql-tag/loader`。全库搜索 `@tailwindcss/turbopack` 在 `next/dist/docs/` 下**零命中**。→ 该用法属于社区/实验性路径，B 段迁移时若 Turbopack 报错，应优先怀疑这里，备选是退回 PostCSS 官方 Tailwind 插件。

### 1.4 配置小结（给 B 段的行动项）

| # | 事项 | 优先级 | 依据 |
| --- | --- | --- | --- |
| 1 | 把 `turbopack.root` 从 `process.cwd()` 改为 monorepo 根 | **高**（阻塞 P1） | turbopack.md 第 115–117 行 |
| 2 | `cacheComponents` 与 `partialPrefetching` 必须成对保留 | 中 | partialPrefetching.md 第 36 行 |
| 3 | 不得新增 `runtime = 'edge'` 路由 | 中 | cacheComponents.md 第 31 行 |
| 4 | `@tailwindcss/turbopack` 非官方推荐 loader，准备回退方案 | 中 | 全库零文档命中 |
| 5 | `cacheLife` 的 `stale` 影响 App Shell，取值需 ≥ 5 分钟才进预取 | 低（P3 缓存阶段） | glossary.md 第 17 行 |

---

## 2. 四类内容 frontmatter 契约

### 2.1 字段表：blog（`content/blog/*.md`）

来源：`my-blog/src/lib/posts.ts`（第 13–21 行 Frontmatter 类型、第 111–142 行解析逻辑）、`my-blog/src/types/index.ts`（第 13–29 行 `PostMeta`）。

| 字段 | 类型 | 必填 | 默认值 | 参与排序 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `title` | string | **是** | 无（缺失抛错） | 否 | 空白字符串视为缺失 |
| `description` | string | **是** | 无（缺失抛错） | 否 | 列表与 SEO 描述 |
| `date` | string \| Date | **是** | 无（缺失抛错） | **是**（倒序） | 支持 YAML 解析成 Date，统一归一为 `YYYY-MM-DD` |
| `tags` | string[] | 否 | `[]` | 否 | 非数组或非字符串元素被过滤 |
| `category` | string | 否 | `"未分类"` | 否 | 参与「相关文章」评分 |
| `cover` | string | 否 | `undefined` | 否 | 仅当 `/` 开头且 `.svg` 结尾时才尝试读取宽高 |
| `draft` | boolean | 否 | `false` | 否 | `=== true` 才生效；生产构建过滤掉 |

计算字段（非 frontmatter，由代码派生）：`slug`（文件名去 `.md`）、`coverWidth`/`coverHeight`（从本地 SVG 解析）、`readingTime`（中文 350 字/分 + 英文 200 词/分，最小 1）。

### 2.2 字段表：projects（`content/projects/*.md`）

来源：`my-blog/src/lib/projects.ts`（第 10–22 行、第 61–83 行）、`my-blog/src/types/index.ts`（第 38–64 行）。

| 字段 | 类型 | 必填 | 默认值 | 参与排序 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | string | **是** | 无（缺失抛错） | 次级排序 | 注意字段名是 `name` 不是 `title` |
| `description` | string | **是** | 无（缺失抛错） | 否 | |
| `techStack` | string[] | 否 | `[]` | 否 | |
| `status` | enum | **是** | 无（缺失抛错） | 否 | `active` / `in-progress` / `completed` / `archived` |
| `period` | string | 否 | `undefined` | 否 | 如 `2026.03 - 2026.08` |
| `role` | string | 否 | `undefined` | 否 | |
| `github` | string | 否 | `undefined` | 否 | |
| `demo` | string | 否 | `undefined` | 否 | |
| `article` | string | 否 | `undefined` | 否 | 关联的 blog slug |
| `featured` | boolean | 否 | `false` | 否 | `=== true` 才生效；首页精选 |
| `order` | number | 否 | `999` | **主排序**（升序） | 非 number 类型回退 999 |

排序规则：`order` 升序 → `name` 字典序。

### 2.3 字段表：diary（`content/diary/*.md`）

来源：`my-blog/src/lib/diary.ts`（第 21–28 行、第 75–93 行）、`my-blog/src/types/index.ts`（第 78–90 行）。

| 字段 | 类型 | 必填 | 默认值 | 参与排序 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `title` | string | **是** | 无（缺失抛错） | 否 | |
| `summary` | string | **是** | 无（缺失抛错） | 否 | 时间轴与列表展示 |
| `date` | string \| Date | **是** | 无（缺失抛错） | **是**（倒序） | 额外校验必须匹配 `^\d{4}-\d{2}-\d{2}`，比 blog 严格 |
| `mood` | string | 否 | `undefined` | 否 | 心情标签 |
| `tags` | string[] | 否 | `[]` | 否 | 代码支持但**当前 10 个文件里无一使用** |
| `draft` | boolean | 否 | `false` | 否 | 生产构建过滤 |

排序规则：`date` 倒序 → `slug` 字典序。

> ⚠️ **`generateStaticParams` 空数组限制**：`my-blog/src/lib/diary.ts` 第 112–113 行注释明确写「Next 16 在 Cache Components 模式下**不允许返回空数组**，所以 `content/diary/` 至少需要保留 1 篇内容」。`electron-cms` 的 `schemaService.ts` 第 36 行也把这条写进了 schema：`/** 该分区是否禁止删空（Next 16 generateStaticParams 不接受空数组） */ minCount`，其中 blog/diary/projects 的 `minCount = 1`，goals 为 `0`。→ **数据库化后这条约束必须保留**（P2 设计 schema 与 P4 后台删除逻辑都要考虑），否则删空某个分区会导致构建失败。

### 2.4 字段表：goals（`content/goals/*.md`）

来源：`my-blog/src/lib/goals.ts`（第 24–32 行、第 91–109 行）、`my-blog/src/types/index.ts`（第 98–128 行）。

| 字段 | 类型 | 必填 | 默认值 | 参与排序 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `title` | string | **是** | 无（缺失抛错） | 次级排序 | |
| `horizon` | enum | **是** | 无（缺失抛错） | 否 | `short` / `mid` / `long` |
| `status` | enum | **是** | 无（缺失抛错） | 否 | `planned` / `active` / `done` / `paused` |
| `progress` | number | 否 | `0` | 否 | 自动夹取到 0–100 并 `Math.round`；非有限数回退 0 |
| `period` | string | 否 | `undefined` | 否 | 如 `2026 Q4` |
| `order` | number | 否 | `999` | **主排序**（升序） | |
| `milestones` | `{title, done}[]` | 否 | `[]` | 否 | 每项 `title` 非空才保留，`done` 需 `=== true` |

排序规则：`order` 升序 → `title` 字典序。

### 2.5 四类契约的一致性差异（P1 做 Zod schema 时必须处理）

| 差异点 | blog | diary | projects | goals |
| --- | --- | --- | --- | --- |
| 标题字段名 | `title` | `title` | **`name`** | `title` |
| 摘要字段名 | `description` | **`summary`** | `description` | 无 |
| 日期字段 | `date`（必填） | `date`（必填，正则更严） | 无 | 无 |
| 排序主键 | `date` 倒序 | `date` 倒序 | `order` 升序 | `order` 升序 |
| 草稿机制 | 有 `draft` | 有 `draft` | **无** | **无** |
| 分区可否为空 | 否（minCount 1） | 否（minCount 1） | 否（minCount 1） | **是**（minCount 0） |

→ `electron-cms/src/main/services/schemaService.ts` 已有一份**与站点对齐的独立 schema 声明**（第 40–127 行），P1 可以直接作为 `packages/content-core` 的起点。它已经把这些差异编码进 `FieldSpec.kind`（`string`/`date`/`enum`/`boolean`/`number`/`stringArray`/`milestones`）与 `minCount`。

### 2.6 真实内容核对（10 个 md 文件）

| 文件 | 分区 | 实际出现的字段 |
| --- | --- | --- |
| `content/blog/agriculture-feature-engineering.md` | blog | title, description, date, category, tags |
| `content/blog/build-personal-blog-with-nextjs.md` | blog | title, description, date, category, tags |
| `content/blog/langgraph-rag-workflow.md` | blog | title, description, date, category, tags, **cover** |
| `content/blog/rag-chunking-strategies.md` | blog | title, description, date, category, tags, **cover** |
| `content/diary/week01.md` | diary | date, title, summary, **mood** |
| `content/goals/01-example-short.md` | goals | title, horizon, status, progress, period, order, milestones |
| `content/goals/02-example-long.md` | goals | title, horizon, status, progress, period, order, milestones |
| `content/projects/crop-yield-prediction.md` | projects | name, description, techStack, status, period, role, article, featured, order |
| `content/projects/personal-blog-platform.md` | projects | name, description, techStack, status, period, role, **github**, article, featured, order |
| `content/projects/rag-knowledge-assistant.md` | projects | name, description, techStack, status, period, role, article, featured, order |

未被任何真实内容使用的字段：blog 的 `draft`；diary 的 `tags`、`draft`；projects 的 `demo`。→ P2 导入器必须能正确处理「字段缺失」而非假设字段存在。

---

## 3. 现有公开路由清单

来源：`my-blog/src/app/` 目录结构、`my-blog/src/app/sitemap.ts`、`my-blog/src/app/robots.ts`、`my-blog/src/lib/site.ts`（`navLinks`）。

### 3.1 路由表

| URL | 文件 | 路由组 | 是否进 sitemap | sitemap priority |
| --- | --- | --- | --- | --- |
| `/` | `src/app/(cosmic)/page.tsx` | `(cosmic)` | 是 | 1 |
| `/universe` | `src/app/(cosmic)/universe/page.tsx` | `(cosmic)` | 是 | 0.9 |
| `/blog` | `src/app/(site)/blog/page.tsx` | `(site)` | 是 | 0.9 |
| `/blog/[slug]` | `src/app/(site)/blog/[slug]/page.tsx` | `(site)` | 是 | 0.7 |
| `/projects` | `src/app/(site)/projects/page.tsx` | `(site)` | 是 | 0.8 |
| `/projects/[slug]` | `src/app/(site)/projects/[slug]/page.tsx` | `(site)` | 是 | 0.6 |
| `/diary` | `src/app/(site)/diary/page.tsx` | `(site)` | 是 | 0.6 |
| `/diary/[slug]` | `src/app/(site)/diary/[slug]/page.tsx` | `(site)` | 是 | 0.4 |
| `/goals` | `src/app/(site)/goals/page.tsx` | `(site)` | 是 | 0.5 |
| `/about` | `src/app/(site)/about/page.tsx` | `(site)` | 是 | 0.6 |
| `/resume` | `src/app/(site)/resume/page.tsx` | `(site)` | 是 | 0.5 |
| `/sitemap.xml` | `src/app/sitemap.ts` | — | — | — |
| `/robots.txt` | `src/app/robots.ts` | — | — | — |

### 3.2 非路由文件

| 文件 | 作用 |
| --- | --- |
| `src/app/layout.tsx` | 根外壳：html/body、`next/font/google` 的 Geist/Geist_Mono、主题初始化脚本、JSON-LD 结构化数据 |
| `src/app/(cosmic)/layout.tsx` | 宇宙层外壳（深空底色 `.cosmic-scope`） |
| `src/app/(site)/layout.tsx` | 行星内部外壳（Navbar + main + Footer） |
| `src/app/globals.css` | 全局样式与设计令牌 |
| `src/app/error.tsx` | 错误边界 |
| `src/app/not-found.tsx` | 404 |
| `src/app/icon.svg` | favicon |

### 3.3 路由组与 URL 的关系

`(cosmic)` 与 `(site)` 是**路由组，不改变 URL**（`src/app/(site)/layout.tsx` 注释明确说明：「路由组 (site) 不改变 URL —— /blog、/projects、/about、/resume、/diary、/goals 仍然是原来的地址」）。

→ 方案 §4 的目标结构里新增 `(admin)` 与 `api/`，与现有 `(cosmic)`/`(site)` 并列即可，**不会破坏任何现有 URL**。这对 P0 的「零 URL 变更」要求是好消息。

### 3.4 sitemap 的动态部分

`src/app/sitemap.ts` 的 sitemap 条目 = 8 个静态路由 + 动态生成：

- `getAllPosts()` → `/blog/{slug}`，`lastModified` 用 `post.date`
- `getAllProjects()` → `/projects/{slug}`，**无 `lastModified`**
- `getAllDiaryEntries()` → `/diary/{slug}`，`lastModified` 用 `entry.date`

→ **`/goals` 没有详情页**（无 `goals/[slug]`），目标只在列表页展示。数据库化时 goals 不需要 slug 唯一性约束之外的详情路由。

### 3.5 站点基础信息

`src/lib/site.ts`：`siteConfig.url` 读 `process.env.NEXT_PUBLIC_SITE_URL`，兜底 `https://loxander.is-a.dev`。用于 `metadataBase`、canonical、Open Graph、sitemap、robots。→ P0 迁移到 `apps/web` 后这个兜底值仍然有效，不需要改。

---

## 4. electron-cms 的 Vitest 测试清单

来源：`electron-cms/src/main/services/__tests__/`。测试脚本见 `electron-cms/package.json` 的 `"test": "vitest run --passWithNoTests"`。全仓库 `*.test.ts` / `*.spec.ts` 共 **12 个**（全部在此目录），另有 1 个 `fixtures.ts` 辅助文件（非测试）。

| 测试文件 | 覆盖的服务（被 import 的模块） | 测试主题（describe 块） |
| --- | --- | --- |
| `schema.contract.test.ts` | `../frontmatterService`、`../schemaService`、`../validateService`、`./fixtures` | frontmatter 契约（真实内容） |
| `frontmatter.roundtrip.test.ts` | `../frontmatterService`、`../contentPatchService`、`../schemaService`、`./fixtures` | roundtrip 幂等（真实内容） |
| `frontmatter.patch.test.ts` | `../frontmatterService`、`../contentPatchService` | 字段级 patch：只改被编辑字段 |
| `frontmatter.eol.test.ts` | `../entryService`、`../frontmatterService` | `assembleDocument` 保留原文件换行符；CRLF 内容保存时无换行符噪声 |
| `entry.save.test.ts` | `../entryService` | 保存链路与乐观锁 |
| `content.manage.test.ts` | `../entryService`、`../validateService` | 新建 / 删除 / 重命名条目、封面枚举 |
| `contentWatcher.test.ts` | `../contentWatcherService` | 路径归一与过滤；同批事件去重且排序稳定 |
| `groups.test.ts` | `../../errors`（类型） | 分组 CRUD、归类、级联、`sanitizeGroups` 落盘值自愈 |
| `autoPublish.test.ts` | `../contentWatcherService`、`../publishService`（类型） | `filterContentMd`、`decideAutoPublish` 发布前门禁、提交消息格式、注入式行为 |
| `git.publish.test.ts` | `../gitService`、`../preflightService`、`../publishService` | 文件清单安全（禁止全量 add）、部分提交、预检报告、发布状态机与闸门、一键回滚 |
| `deploy.publish.test.ts` | 无（纯函数） | `parseRepoSlug`、配置校验、GitHub commit status 通道、Vercel 按 SHA 精确匹配、生产地址 HTTP 复核 |
| `devServer.test.ts` | 无（纯函数 + `node:net`） | `stripAnsi`、`parseDevServerUrl`、`pickPort`、`probePort`（真实 bind，不依赖 spawn）、`findFreePort`、`createDevServer` 无 spawn 分支 |

### 4.1 对 Loxander 迁移有直接价值的测试

| 测试 | 迁移价值 |
| --- | --- |
| `schema.contract.test.ts` | **最高**。用真实内容做契约测试锁死 frontmatter 漂移。P1 建 `packages/content-core` 时应把这套契约测试一并迁过去 |
| `frontmatter.roundtrip.test.ts` | 高。保证「读→写→读」幂等，数据库化后导入器可复用这个思路做数据比对 |
| `frontmatter.eol.test.ts` | 高。CRLF/LF 处理，直接关系到本机 `core.autocrlf=true` 环境下的内容一致性 |
| `frontmatter.patch.test.ts` | 中。字段级 patch 思路可复用到 P4 后台的局部更新 |
| `git.publish.test.ts` | 中。`assertSafeFileList`（禁止全量 add）的安全思路应保留到新平台的发布流程 |
| `devServer.test.ts` | 低。桌面端专属，Web 端不需要 |

### 4.2 测试设计上的可复用模式

1. **零网络副作用**：`deploy.publish.test.ts` 的「配置校验」与 `devServer.test.ts` 的 `probePort` 都用真实 bind 但不 spawn 子进程，因此**可在受限沙箱内运行**。这个模式对当前环境的 `spawn EPERM` 限制特别有价值，P1 写测试时应沿用。
2. **真实内容做契约测试**：`fixtures.ts` 提供 `CONTENT_ROOT` / `listContentFiles`，测试直接读 `content/` 下的真实 md，而不是手写 fixture。这样内容漂移会立刻被测试发现。
3. **依赖注入**：`autoPublish.test.ts` 的「注入式行为」用 `vi` 注入依赖，避免测试触碰真实 Git / 网络。

---

## 5. 侦察结论汇总（对后续阶段的输入）

| # | 结论 | 影响阶段 |
| --- | --- | --- |
| 1 | `turbopack.root: process.cwd()` 在 monorepo 下必须改为 monorepo 根，否则 `packages/*` 无法解析 | **P0 后续 / B 段**，阻塞 P1 |
| 2 | `cacheComponents` + `partialPrefetching` 是硬绑定，必须成对保留 | B 段 |
| 3 | `cacheComponents` 要求 Node.js runtime，禁止 edge 路由 | B 段 / P4 |
| 4 | `@tailwindcss/turbopack` 不在官方已测试 loader 清单，需备回退方案 | B 段 |
| 5 | 四类 frontmatter 契约在字段名、排序键、草稿机制、空分区限制上均不一致 | P1（Zod schema 必须表达这些差异） |
| 6 | `generateStaticParams` 不接受空数组 → blog/diary/projects 必须 minCount ≥ 1 | P2 schema / P4 后台删除 |
| 7 | 路由组 `(cosmic)`/`(site)` 不改 URL，新增 `(admin)`/`api` 不会破坏现有 URL | P0 / P4 |
| 8 | goals 无详情页路由，只有列表页 | P2 / P3 |
| 9 | electron-cms 已有与站点对齐的 `schemaService.ts`，可直接作为 `packages/content-core` 起点 | P1 |
| 10 | 12 个 vitest 测试中 `schema.contract` / `frontmatter.roundtrip` / `frontmatter.eol` 迁移价值最高 | P1 |

---

## 6. 侦察范围说明

- 本文**未**涉及：数据库表结构设计、认证方案、媒体存储、部署配置——这些属于 P2 及之后。
- 本文**未**运行 `next build` / `vitest run`：当前环境禁止管道 stdio 子进程（`spawn EPERM`），构建与测试由 Lead 在更高权限下执行。因此本文所有结论均来自**静态阅读**，不含运行时实测数字。
- 所有 Next.js API 结论均标注了 `node_modules/next/dist/docs/` 下的具体文件路径与行号，可复核。
