# ADR 0003：保留 Electron 但降级为可选离线端

- **状态**：Accepted
- **日期**：2026-10-21
- **决策者**：Loxander 平台 P0 阶段

---

## Context

`electron-cms` 是一个已经能用的桌面内容编辑器（6 个 commit，69 个 tracked 文件），具备：

| 能力 | 实现位置 |
| --- | --- |
| 四类内容 schema 与校验 | `src/main/services/schemaService.ts`、`validateService.ts` |
| 字段级 frontmatter 编辑与 roundtrip | `frontmatterService.ts`、`contentPatchService.ts` |
| CodeMirror 6 编辑体验 | 渲染进程 |
| Markdown 预览 + DOMPurify 防 XSS | 渲染进程 |
| 乐观锁与冲突处理 | `entryService.ts`、`conflictService.ts` |
| 版本、备份思路 | `diffService.ts` |
| Git 提交 / 推送 / 部署回读 | `gitService.ts`、`publishService.ts`、`deployService.ts` |
| 自动发布（文件变更触发） | `autoPublishService.ts` |
| 本地 dev server 预览 | `devServerService.ts` |
| 12 个 Vitest 测试文件 | `src/main/services/__tests__/` |

平台化后，Web 后台将承担主 CMS 角色：新建、编辑、发布、归档、版本恢复、审计（方案 §8.4）。这意味着 **`electron-cms` 与 Web 后台在功能上直接重叠**。

同时，`electron-cms` 的写链路是真实可用的：它会对目标仓库执行 `git commit` + `git push`（`publishService.ts` 的 `publish()` → `commitFiles()` → `pushBranch()`），并且有自动发布能力（`autoPublishService.ts` 监听 `content/` 变更后自动提交）。

**这就是冲突的根源**：一旦内容主来源切到数据库（ADR 0002），而 Electron 仍在往 Markdown 仓库推送，就会出现两个写入方：

- Web 后台 → 数据库
- Electron → Git 仓库里的 Markdown

两边互不知情。结果是方案 §19 明确列出的风险：**「Electron 与 Web 双写冲突 → 内容覆盖」**。

方案的相关约定：

- §1.4 非目标：「不把 Electron 改造成服务器」「不在 Vercel 上运行 Electron 主进程」
- §4.1：`apps/desktop` = 「可选 Electron 客户端，**第一阶段冻结或仅做兼容维护**」
- §19：`Electron 与 Web 双写冲突 | 内容覆盖 | 第一阶段冻结 Electron 写生产`
- §21 确认项第 6 条：「Web 后台成为主 CMS，Electron 冻结为可选离线端」

## Decision

**保留 `electron-cms` 作为可选离线端，进入 `apps/desktop`，但冻结其「写生产」能力。**

### 1. 「冻结」的准确定义

「冻结」在本决策中**不是**口头约定，也**不是**「代码一行不改」，而是分三层，且**必须落地到运行时闸门**：

| 层级 | 内容 | 是否本决策采用 |
| --- | --- | --- |
| **L1 代码冻结** | 不修改 `apps/desktop` 任何代码 | **否**。允许做兼容性维护（见下） |
| **L2 运行时禁止写生产** | 在代码里**物理阻断**推送到生产仓库的路径，使其无法被 UI 或配置意外触发 | **是，这是核心机制** |
| **L3 口头约定** | 只是「大家说好不要用」 | **否**。不可验证，等于没有 |

**L2 的具体落点**（基于现有代码结构，都是已存在的闸门，只需收紧默认值）：

| 现有闸门 | 位置 | 冻结后的行为 |
| --- | --- | --- |
| `publish(params)` 的 `confirmed === true` | `publishService.ts` 第 56 行注释「人工确认闸门：必须为 true 才允许 commit」 | 冻结期间**强制 `false`**，且不接受 UI 覆盖 |
| `autoPublish` 设置项 | `settingsService.ts` 第 60 行 `autoPublish: boolean` | **强制 `false`**，`createAutoPublisher` 的 `isEnabled()` 恒返回 `false`，`decideAutoPublish` 走 `if (!input.enabled) return { action: 'skip', reason: '自动发布已关闭' }` |
| `preflight` | `publishService.ts` 第 127 行 | 保留可运行（只读检查），但结果不能转化为 commit |
| `pushBranch` / `retryPush` | `publishService.ts` | 冻结期间**不调用**；若被调用应直接返回失败状态而非抛错（与现有「push 失败不抛异常，把错误写进状态」的约定一致） |
| `rollbackLast` / `revertCommit` | `publishService.ts`、`gitService.ts` | **禁止**。冻结期不允许从桌面端改写生产 Git 历史 |

**允许保留的能力（离线端定位）**：

- 读取与浏览内容
- 本地编辑、预览、校验（不落生产）
- 本地 dev server 预览
- 导出 / 备份到本地文件
- 全部 12 个 Vitest 测试仍应可运行（它们是 P1 的资产）

**禁止的能力**：

- 任何形式的 `git push` 到生产仓库
- 自动发布
- 从桌面端改写生产 Git 历史（revert / rollback）

### 2. 为什么不是直接删除或废弃 Electron

| 选项 | 取舍 |
| --- | --- |
| 直接删除 `electron-cms` | 会丢掉已验证的资产：四类 schema 契约、字段级 patch 算法、乐观锁、CRLF 处理、12 个测试。方案 §2.2 明确要求从 electron-cms 复用这些。且方案 §1.4 非目标要求「不删除旧仓库和旧部署，直到新平台通过完整观察期」 |
| 保持双写 | 直接命中方案 §19 的「Electron 与 Web 双写冲突」风险，不可接受 |
| **降级为可选离线端 + L2 运行时冻结** | 保留资产与代码，同时用可验证的机制消除双写风险。**本决策** |

### 3. 与方案 §19 风险表的对应关系

方案 §19 该行：

> | Electron 与 Web 双写冲突 | 内容覆盖 | 第一阶段冻结 Electron 写生产 |

本决策的缓解机制，逐条对应：

| 风险成因 | 本决策的缓解手段 | 可验证性 |
| --- | --- | --- |
| Electron 自动发布覆盖 Web 后台的改动 | `autoPublish` 强制 `false`，`decideAutoPublish` 直接返回 skip | 可用单元测试断言（`autoPublish.test.ts` 已覆盖 `decideAutoPublish`） |
| 用户在 Electron 里手动点发布 | `publish()` 的 `confirmed` 强制 `false` | 可在 `publishService` 加断言测试 |
| push 失败后重试 | `retryPush` 冻结期禁用 | 同上 |
| 桌面端回滚覆盖新内容 | `rollbackLast` / `revertCommit` 禁用 | 同上 |
| 「约定好了但没人遵守」 | L2 是代码级阻断，不是文档级约定 | 代码审查 + 测试 |

**关键点**：方案 §19 的应对写的是「冻结 Electron 写生产」，但没写冻结的**实现方式**。本 ADR 把它定义为 L2 运行时闸门，使其从「约定」变成「可测试的约束」。

### 4. 冻结的解除条件

冻结不是永久的。解除条件（需另行决策）：

1. Web 后台（方案 §8.4）已完成并通过验收；
2. `packages/content-core` 与 `packages/markdown` 已稳定，Electron 与 Web 使用同一套 schema 与渲染管线（方案 §11 P1 验收项「同一 Markdown 在 Web 与 Electron 中得到一致 HTML」通过）；
3. 明确 Electron 的写入目标——是写数据库（通过 API），还是继续写 Markdown 但走与 Web 后台一致的冲突检测；
4. 上述条件满足后，重新评估是否恢复写能力，届时需要新 ADR 替代本决策。

## Consequences

### 负面后果（具体代价）

1. **Electron 的自动发布、Git 推送、一键回滚能力实际作废。**
   `publishService.ts`（含 `publish`、`retryPush`、`rollbackLast`、`pullRecover`）、`autoPublishService.ts`、`deployService.ts`、`gitService.ts` 的写路径，以及 `git.publish.test.ts`（15,465 字节，是最大的测试文件）覆盖的能力，**在冻结期都变成不可达代码**。
   **代价：这些代码会随 Web 端演进逐渐腐化**——`publishService` 依赖的 Git 仓库结构、部署回读协议一旦与 Web 端不一致，解冻时需要重新对齐。测试虽然还能跑，但测的是一个不用的路径。这是一笔明确的沉没成本。

2. **冻结期的内容变更完全依赖 Web 后台，桌面端从「编辑器」退化为「阅读器 + 草稿本」。**
   用户原本的工作流（本地改 md → Electron 自动发布 → 部署）被切断。在 P4 后台完成前，**内容更新能力实际上是回退的**：只能手改 md + 手动 git push，或者等 Web 后台。
   **代价：P2→P4 之间存在一段「两个端都不能正经写」的空窗期。** 这个空窗期必须被接受，或者用「手工 git 流程」临时填补（但这又绕过了冻结，需要在流程上明确：手工 git 是维护者行为，不属于 Electron 能力）。

3. **L2 闸门需要改 `apps/desktop` 的代码，与「P0 只导入不改源码」的边界冲突。**
   P0 的 task-3 明确要求「只导入，不修改任何导入进来的源码内容」。因此 **本 ADR 在 P0 只做决策，不落地实现**。L2 闸门的代码改动必须安排到后续阶段（建议 P3 或 P4 初期）。
   **代价：从 P0 到闸门落地之间，冻结只停留在文档层面（即退化为 L3）。** 这段时间必须靠「不启动 Electron 的发布功能」的人工纪律兜底。这是本决策的已知空窗，必须在任务排期里显式安排落地时间，不能默认「写了 ADR 就等于冻结了」。

4. **`apps/desktop` 仍需维护，但产出价值下降。**
   方案 §11 P0 验收要求「`apps/desktop` 可 typecheck」。它仍需要随 `packages/*` 的变化更新依赖与类型，但功能上不增强。
   **代价：每次 monorepo 根依赖升级（如 ADR 0001 提到的 `@types/node` 统一）都要额外验证 desktop 能 typecheck，纯属维护成本。**

5. **与 ADR 0002 的耦合风险：Electron 冻结后，Markdown 写入方只剩「手工」。**
   ADR 0002 说 Markdown 降级为导入/导出/备份格式。但 Electron 冻结后，**如果有人仍用 Electron 改本地 md 文件再手工提交，Markdown 与数据库会静默分叉**，而没有任何机制能发现。
   **代价：需要额外的「Markdown 与 DB 一致性检查」脚本**（方案 §8.2 的比对脚本），且必须在 P7 生产切换前跑过，否则分叉内容会在切换时丢失。

6. **桌面端用户（当前就是维护者本人）的体验是净损失。**
   离线编辑能力仍在，但「改完就能上线」的闭环没了。**代价：短期内日常内容更新比现在更麻烦**（要么等 Web 后台，要么手工 git）。这是为换取「单一写入方」而付出的直接体验代价。

### 正面后果

- 方案 §19「Electron 与 Web 双写冲突」风险被消解为「单一写入方（Web 后台 / DB）」，内容覆盖不再可能。
- `electron-cms` 的资产（schema、patch、乐观锁、CRLF、12 个测试）被保留在 `apps/desktop` 与 P1 的 `packages/content-core` 中，没有浪费。
- 符合方案 §1.4 非目标「不删除旧仓库和旧部署」。
- 冻结是可逆的，解除条件明确，不构成不可逆架构决定。

### 后续必须跟进

| # | 事项 | 阶段 |
| --- | --- | --- |
| 1 | **落地 L2 运行时闸门**（`autoPublish` 强制 false、`publish` 的 `confirmed` 强制 false、禁用 `retryPush`/`rollbackLast`），并补测试断言 | P3 / P4 初期 |
| 2 | 在 `apps/desktop` README 与 UI 上显式标注「冻结期：不可写生产」 | P3 |
| 3 | 保证 `apps/desktop` 可 typecheck（方案 §11 P0 验收项） | P0 后续 |
| 4 | 编写 Markdown ↔ DB 一致性检查脚本，防手工 git 造成的静默分叉 | P2 |
| 5 | 解除冻结时需新 ADR | 待定 |

---

## 与方案的一致性核对

| 方案章节 | 原文要点 | 本 ADR 是否冲突 | 说明 |
| --- | --- | --- | --- |
| §1.4 非目标 | 「不把 Electron 改造成服务器」 | **完全一致** | 本 ADR 只保留离线编辑能力，不赋予任何服务端职责 |
| §1.4 非目标 | 「不在 Vercel 上运行 Electron 主进程」 | **完全一致** | `apps/desktop` 不进入 Vercel 构建产物；P0 的根 `scripts` 用 `--if-present` 聚合，需在 P1 按 app 拆分避免误触发（见 ADR 0001 负面后果 5） |
| §1.4 非目标 | 「不删除旧仓库和旧部署，直到新平台通过完整观察期」 | **完全一致** | 本 ADR 选择保留而非删除 `electron-cms` |
| §5 技术选型 | 「编辑器 → CodeMirror 6，复用现有体验」 | **完全一致** | 冻结的是**写生产**能力，不是编辑器本体；CodeMirror 6 编辑体验按方案 §2.2 继续复用 |
| §5 技术选型 | 「HTML 安全 → rehype-sanitize + DOMPurify 预览」 | **完全一致** | Electron 现有的 DOMPurify 预览方案保留 |
| §19 风险表 | 「Electron 与 Web 双写冲突 → 内容覆盖 → **第一阶段冻结 Electron 写生产**」 | **本 ADR 的直接依据** | Decision 第 1 节把「冻结」从文档约定升级为 L2 运行时闸门，并在第 3 节逐条映射缓解机制 |
| §19 风险表 | 「内容迁移遗漏 → 链接丢失或内容错误」 | **本 ADR 的连带责任** | 见负面后果 5：Electron 冻结后手工 git 仍可能造成 Markdown 与 DB 静默分叉，需 P2 一致性检查脚本 |
| §4.1 目录职责 | 「`apps/desktop`：可选 Electron 客户端，第一阶段冻结或仅做兼容维护」 | **完全一致** | 本 ADR 即为该行职责的具体化 |
| §21 确认项 | 第 6 条「Web 后台成为主 CMS，Electron 冻结为可选离线端」 | **完全一致** | 逐字对齐 |

---

## 相关文档

- `docs/adr/0001-adopt-monorepo.md`：`apps/desktop` 在 monorepo 中的位置与依赖冲突
- `docs/adr/0002-adopt-database-as-source.md`：数据库成为唯一事实来源，Markdown 降级
- `docs/recon-p0.md` §4：electron-cms 的 12 个测试清单与迁移价值
- `动态网站平台化执行方案.md` §1.4（非目标）、§4.1（apps/desktop 职责）、§19（风险表）、§21（确认项第 6 条）
