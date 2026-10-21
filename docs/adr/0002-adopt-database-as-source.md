# ADR 0002：数据库成为唯一内容事实来源

- **状态**：Accepted
- **日期**：2026-10-21
- **决策者**：Loxander 平台 P0 阶段

---

## Context

当前内容的事实来源是**文件系统里的 Markdown**：

- `my-blog/content/blog/*.md`（4 篇）、`content/projects/*.md`（3 篇）、`content/diary/*.md`（1 篇）、`content/goals/*.md`（2 篇），共 **10 个文件**。
- 读取方式：`my-blog/src/lib/posts.ts`、`projects.ts`、`diary.ts`、`goals.ts` 用 `gray-matter` 解析 frontmatter，用 `fs.readdirSync` 列目录，路径写死为 `path.join(process.cwd(), "content", ...)`。
- 更新方式：改文件 → 提交 → 触发构建 → 部署。`my-blog/package.json` 的 `build` 就是 `next build`，内容更新必须重新构建。

这个模型有四个已经暴露的问题：

1. **内容更新必须走完整构建部署链路**。`electron-cms` 的存在本身就是为了缓解这一点——它做本地编辑 + Git 提交 + 触发部署，但本质仍是「改文件 → 重建」。
2. **读取层与页面耦合**。四个 lib 文件直接调 `fs`，没有 repository 抽象。方案 §2.3 已把「静态内容读取层与页面耦合，需要替换为 repository 接口」列为阻塞项。
3. **无法支撑后台写操作**。方案 §8.4 要求后台能做新建、编辑、发布、归档、版本恢复。文件系统 + Git 提交能勉强做，但乐观锁、版本历史、并发冲突、审计都需要额外造轮子（`electron-cms` 里确实造了：`entryService` 的乐观锁、`conflictService`、`versionService` 的思路）。
4. **构建期约束反向污染内容模型**。`my-blog/src/lib/diary.ts` 第 112–113 行注释：「Next 16 在 Cache Components 模式下**不允许返回空数组**，所以 `content/diary/` 至少需要保留 1 篇内容」。这是**框架限制倒逼内容约束**——内容是否为空本应是业务问题，现在被构建工具决定了。

方案 §5 已确定「数据库 → Neon Postgres」「ORM → Drizzle ORM + drizzle-kit」，§8.2 已给出统一 repository 接口，§16.2 已规定 `CONTENT_SOURCE` 回滚开关，§21 确认项第 3 条确认「使用 Neon Postgres + Drizzle」。

## Decision

**数据库（Neon Postgres）成为内容的唯一事实来源。Markdown 降级为导入 / 导出 / 备份格式。**

具体约定：

1. **`EntryRepository` 是唯一读取入口。** 按方案 §8.2 的接口实现，页面与后台都通过它访问内容，不允许任何代码直接读 `content/*.md` 或直接拼 SQL。

2. **两个实现并存，由 `CONTENT_SOURCE` 显式切换：**

   | 实现 | 何时使用 | 能力 |
   | --- | --- | --- |
   | `DatabaseEntryRepository` | 正常生产、Preview、开发 | 读写全能力 |
   | `MarkdownEntryRepository` | 迁移期比对、生产事故应急 | **只读**，不恢复写操作 |

   `CONTENT_SOURCE=db`（默认） / `CONTENT_SOURCE=markdown`（应急）。依据方案 §8.2 第 588 行「通过 `CONTENT_SOURCE` 切换，用于迁移期比对和快速回滚。正式稳定后移除 Markdown 实现」，以及 §16.2 第 1188 行「回滚到 Markdown 只作为只读应急方案，不恢复写操作」。

3. **Markdown 的新角色：**

   | 用途 | 方向 | 说明 |
   | --- | --- | --- |
   | 首次迁移导入 | Markdown → DB | P2 的导入器，10 个真实文件全量导入 |
   | 数据核对 | 双向比对 | 导入后逐字段比对，方案 §19「内容迁移遗漏」的应对 |
   | 全量备份 / 导出 | DB → Markdown | 数据库之外的第二份可读副本 |
   | 应急只读回退 | Markdown 读取 | 仅读，不写 |
   | **日常编辑** | **不再使用** | 后台与 Electron 都不再以 Markdown 为写入目标 |

4. **Markdown 不再承载「唯一真相」。** 任何以「直接改 md 文件」为手段的内容更新，在 P2 之后都不再被接受为正式流程。`electron-cms` 的写生产路径同步冻结（见 ADR 0003）。

5. **迁移期的双实现必须有自动化比对。** 方案 §19「静态读取与动态读取混用 → 数据不一致」的应对是「单一 repository，迁移期显式开关」。因此：
   - `CONTENT_SOURCE` 只能有一个值生效，不允许同一请求内混用两种来源；
   - 迁移期提供比对脚本（`scripts/`），对 10 篇内容做数量、slug、渲染快照三重比对；
   - 比对通过前不切换默认值。

## Consequences

### 负面后果（具体代价）

1. **构建期约束消失，但必须在数据库层重新补上，否则会引入新的构建失败。**
   现在 `content/diary/` 空目录会让 `generateStaticParams` 返回空数组、Next 16 Cache Components 直接构建失败。数据库化后这个「物理约束」没有了——**数据库可以合法地一条 diary 都没有，然后构建照样失败**。
   `electron-cms` 的 `schemaService.ts` 第 36 行已经把这个约束写进 schema（`minCount`：blog/diary/projects = 1，goals = 0），但那是**桌面端的前端校验，不是数据库约束**。
   **代价：P2 必须在数据库层或 repository 层显式实现「blog/diary/projects 至少保留 1 条已发布内容」的约束，并在 P4 后台删除逻辑里拦截。否则「删掉最后一篇日记」会变成一个能通过后台操作、但会让生产构建失败的定时炸弹。** 这是本决策最容易漏掉的一条。

2. **内容与代码的原子性丢失。** 现在「改内容」和「改渲染逻辑」可以是同一个 commit，回滚一个 commit 就同时回滚两者。数据库化后，代码回滚（方案 §16.1 的 Vercel Instant Rollback）**不会回滚数据库内容**——旧代码配上新内容，可能出现字段缺失或格式不符。**代价：回滚演练必须覆盖「代码回滚 + 内容兼容」的组合场景，不能只演练代码回滚。** 方案 §16.1/§16.2/§16.3 把三种回滚分开写，正是因为它们不再原子。

3. **本地开发需要数据库或 mock，开发环境变重。** 现在 clone 仓库、`npm install`、`npm run dev` 就能跑，零外部依赖（`my-blog` 的 `content/` 在仓库里）。数据库化后，本地跑起来至少需要一个 Neon 分支或本地 Postgres。**代价：新机器上手成本上升；离线无法开发公开站点。** 缓解办法是保留 `CONTENT_SOURCE=markdown` 只读模式用于本地开发，但那样又会出现「本地读 md、线上读 db」的行为差异，测试覆盖要更小心。

4. **两个实现的长期维护成本。** `MarkdownEntryRepository` 在「正式稳定后移除」（方案 §8.2 第 588 行），但从 P2 到 P8 之间它会一直存在。这段时间里每次改 `EntryRepository` 接口都要改两个实现，且 `MarkdownEntryRepository` 是只读的，**接口里的写方法它无法实现**——只能抛「不支持」错误。**代价：接口设计会出现「只读实现抛异常」的语义空洞，类型系统无法阻止误用。** 需要靠 `CONTENT_SOURCE` 的启动期校验 + 测试来兜。

5. **Drizzle schema 与现有 frontmatter 契约不是一一映射，迁移必然有信息损耗或变形。**
   实测四类内容的契约差异（见 `docs/recon-p0.md` §2.5）：
   - 标题字段名：blog/diary/goals 是 `title`，projects 是 `name`
   - 摘要字段名：blog/projects 是 `description`，diary 是 `summary`
   - 排序键：blog/diary 按 `date` 倒序，projects/goals 按 `order` 升序（缺省 999）
   - 草稿机制：只有 blog/diary 有 `draft`
   - `goals.milestones` 是嵌套数组 `{title, done}[]`，关系型建模需要单独的表或 JSONB

   **代价：要么在数据库里用统一列名 + 映射层（多一层转换，易出 bug），要么用 JSONB 存字段（放弃类型安全与查询能力）。** 方案 §6.4 提到的媒体表之外，还需要为 milestones 单独决策。这个选择在 P2 做 Drizzle schema 时必须明确，不能含糊。

6. **`CONTENT_SOURCE` 开关本身是风险源。** 方案 §19 已列「静态读取与动态读取混用 → 数据不一致」。**代价：开关值配错（比如 Preview 环境误设 `markdown`）会导致「后台改了看不到」这类极难排查的问题**，而且表现为「内容没更新」而不是报错。必须在启动时打日志、在页面 meta 或健康检查里暴露当前来源。

7. **失去 Git 天然提供的版本历史与审计。** 现在每次内容变更都是 Git commit，有作者、时间、diff、可 `git revert`。数据库化后这些要自己实现（方案 §8.4 的版本表、§19「版本恢复覆盖历史 → 恢复生成新版本」）。**代价：在 P4 版本功能做完之前，内容变更实际上**没有**可用的历史追溯，这是一个能力回退期。**

### 正面后果

- 内容更新不再需要重新构建部署，后台改完即时生效（配合方案 §14.3 的缓存失效）。
- `generateStaticParams` 的空数组约束、文件路径守卫等文件系统特有逻辑可以从 Web 端移除。
- 版本、审计、乐观锁、冲突检测可以用数据库能力正经实现，不必像 `electron-cms` 那样在文件系统上模拟（`entryService` 的乐观锁、`conflictService`）。
- Markdown 保留为导入/导出/备份格式，内容永不被锁死在数据库里，可读性不丢。

### 后续必须跟进

| # | 事项 | 阶段 |
| --- | --- | --- |
| 1 | 在 DB 或 repository 层实现 `minCount` 约束（blog/diary/projects ≥ 1） | P2 |
| 2 | 决定 `milestones` 用独立表还是 JSONB | P2 |
| 3 | 决定统一列名 vs 保留分区差异（`title`/`name`、`description`/`summary`） | P2 |
| 4 | 编写 10 篇内容的导入器 + 数量/slug/渲染快照三重比对 | P2 |
| 5 | `CONTENT_SOURCE` 启动期日志 + 健康检查暴露 | P3 |
| 6 | 回滚演练必须覆盖「代码回滚 + 内容兼容」组合 | P7 |
| 7 | 本地开发方案（Neon 分支 or 本地 Postgres or markdown 只读） | P3 |

---

## 与方案的一致性核对

| 方案章节 | 原文要点 | 本 ADR 是否冲突 | 说明 |
| --- | --- | --- | --- |
| §1.4 非目标 | 「不为了『动态化』把全站改成 `force-dynamic`」 | **不冲突** | 本 ADR 只改内容来源，不改渲染策略。方案 §8.3 的 ISR / 缓存策略仍然适用，公开站点继续用 Cache Components + `use cache` |
| §1.4 非目标 | 「不在切换当天同时重写视觉、内容和部署平台」 | **不冲突** | 数据库切换在 P2/P3，视觉与部署在 P0/P7 分阶段，不在同一天 |
| §1.4 非目标 | 「不删除旧仓库和旧部署，直到新平台通过完整观察期」 | **不冲突** | Markdown 保留为导入/导出/备份格式与只读回退源，不删除 |
| §5 技术选型 | 「数据库 → Neon Postgres」「ORM → Drizzle ORM + drizzle-kit」「参数校验 → Zod」 | **完全一致** | 本 ADR 未提出替代方案 |
| §5 技术选型 | 「缓存 → `unstable_cache` / `use cache` + `cacheTag`，按内容标签失效」 | **不冲突** | 数据库化后按内容 tag 失效才有意义（文件系统时代只能整站重建） |
| §19 风险表 | 「静态读取与动态读取混用 → 数据不一致 → 单一 repository，迁移期显式开关」 | **本 ADR 的直接依据** | Decision 第 1、2、5 条即此应对的落地 |
| §19 风险表 | 「内容迁移遗漏 → 链接丢失或内容错误 → 自动数量、slug、渲染快照比对」 | **本 ADR 的直接依据** | Decision 第 5 条要求三重比对 |
| §19 风险表 | 「数据库连接耗尽 → 运行时 5xx → Neon 连接池与查询上限」 | **本 ADR 新增暴露面** | 文件系统时代不存在此风险；数据库化后必须在 P2/P3 配置连接池，属本决策的连带成本（未在负面后果中单列，此处补充记录） |
| §19 风险表 | 「版本恢复覆盖历史 → 无法追溯 → 恢复生成新版本」 | **本 ADR 新增暴露面** | 见负面后果 7：Git 版本历史能力回退，P4 前无替代 |
| §16.2 内容源回滚 | 「`CONTENT_SOURCE=markdown` / `CONTENT_SOURCE=db`；回滚到 Markdown 只作为只读应急方案，不恢复写操作」 | **完全一致** | Decision 第 2 条逐字对齐 |
| §21 确认项 | 第 3 条「使用 Neon Postgres + Drizzle」、第 9 条「迁移期保留 `CONTENT_SOURCE=markdown` 只读回退开关」 | **完全一致** | 均已落地 |

---

## 相关文档

- `docs/recon-p0.md` §2：四类 frontmatter 契约的实测字段表与差异
- `docs/adr/0003-keep-electron-as-offline-client.md`：Electron 写生产冻结
- `动态网站平台化执行方案.md` §8.2（repository 接口）、§8.4（后台写操作）、§16.2（内容源回滚）、§19（风险表）、§21（确认项）
