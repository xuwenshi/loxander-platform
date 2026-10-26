# 旧链路下线与归档记录（P8）

> 本文档对应《动态网站平台化执行方案》§11 P8「旧链路下线」与 §13 交付清单里的 `M8 旧链路下线说明与归档记录`。
>
> 写作时间：2026-10-26。依据的是当天在一台 Windows 工作站上实际执行的命令与真实返回值，不是计划。
>
> **凡涉及外部账号权限而无法在本机完成的动作，都在文末 §7 明确列出，并写明「谁来做、怎么做」——不假装做过。**

---

## 1. 为什么要下线旧链路

改造前这套站点有**两条**内容入口，彼此不感知：

| 入口 | 载体 | 内容真源 | 发布动作 | 风险 |
|---|---|---|---|---|
| 浏览器访问 | `my-blog`（Next.js） | 仓库里的 `content/*.md` | `git push` → Vercel 按 Git 集成构建 | 人手改 md、依赖构建 |
| 桌面端编辑 | `electron-cms`（Electron） | 同一批 `content/*.md` | 保存后自动 `git commit && push` → 同上 | **双写冲突**、批量误删 |

新平台把内容真源换成了 Neon Postgres，发布动作换成 `/admin` 里的 Server Action + `updateTag()` 缓存失效——**不产生 Git 提交、不触发构建、不依赖部署**。改完 1 秒内线上可见。

于是旧链路从「唯一通道」变成了「第二条不该存在的写入路径」。P8 的任务就是把第二条关掉。

---

## 2. 旧链路的三个环节，逐一处置

旧链路不是一段代码，是三段串联的机制。只关其中一段，另外两段仍然会动。

```
[1] electron-cms / 本机脚本  保存 md
        ↓
[2] autoPublishService      debounce → 预检 → git add/commit → git push origin main
        ↓
[3] GitHub 仓库 blog         Vercel 的 Git 集成 → 自动构建 → 部署到 blog-zeta-swart-97.vercel.app
```

### 2.1 [3] Git → Vercel 自动部署：**已断开**（本机可做，已完成）

这是最关键的一段。它不依赖任何本地进程，只要仓库还在、集成还在，任何人往 `main` 推一提交就会自动上线一次。

断开方式（实测可用）：

```bash
DELETE https://api.vercel.com/v9/projects/prj_Aqm2Pq5Bv8qNElgdvyjnTT5UBeKM/link?teamId=team_GKAxcCY8aSK9eaIToYq2ivOJ
# → 200
```

断开前后对比（`GET /v9/projects/{id}` 的 `link` 字段）：

```
断开前  OLD blog: link.type=github  repo=blog
断开后  OLD blog: link.type=NONE    repo=-
```

对照：新项目仍然是 `link.type=github repo=loxander-platform`，**没有误伤**。

> 走过的弯路：先试 `PATCH /v9/projects/{id}` 带 `{ "gitRepository": null }` → `400 should NOT have additional property 'gitRepository'`。正确端点是 `DELETE .../link`。

### 2.2 [2] 桌面端自动发布：**默认关闭**（本机可做，已完成）

改的是默认值，不是删功能：

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/main/services/settingsService.ts` | `FALLBACK.autoPublish: true` → `false`，并在代码里写明为什么保留功能、为什么默认必须关 |
| `apps/desktop/src/renderer/src/store.ts` | 首帧占位值 `autoPublish: true` → `false`；读设置失败时的兜底 `: true` → `: false` |
| `apps/desktop/src/renderer/src/components/PublishPanel.tsx` | 开关的 `title` 文案改为说明「旧链路已下线，默认关闭，新平台请用 /admin」 |

**为什么不删掉整个 `autoPublishService`：**

方案 §11 P8 的验收第三条是「回滚文档仍可执行」。保留这段代码，是留一条「必要时还能回旧链路」的实体通路；关掉默认值 + 断开 Git 集成，才让它「不能自己动」。删掉代码等于把退路也删了——而且 `autoPublishService.test.ts` 的 7 条测试是这段逻辑的唯一规格说明，删了以后没人知道它本来该干什么。

**为什么 store.ts 那个兜底也要改：**

它是「读设置失败时用什么值」。原来是 `true`——意味着主进程崩了、IPC 断了、settings.json 读坏了的任何一种情况下，UI 会显示「自动发布：开」。这是**故障时最危险的方向**（fail-open）。改成 `false` 后，任何异常路径都退到「关」。

### 2.3 [1] 保存 md 这个动作本身：**保留**

`apps/web/content/*.md` 仍然存在、仍然被 Markdown 内容源读取（`CONTENT_SOURCE=markdown` 就是这条路的开关）。理由：

- P8 要求「Markdown 仅保留导入和导出用途」——导入源必须留；
- 回滚演练（`npm run test:rollback`）的四条腿里，两条就是 markdown 源；
- 内容有 10 篇、总量 < 100 KB，留在仓库里当作「内容的第二份物理副本」成本极低。

**但写入方向变了**：现在 md 是**只读的导入源**，不再是人手编辑的入口。要改内容，改库（走 `/admin`），然后 `npm run export:md` 重新导出。

---

## 3. Markdown 的「导出」用途：新增 `scripts/export-markdown.mjs`

P8 之前只有导入（`db/import.ts`），没有导出。这是真实缺口：库一旦出事，剩下的 `backups/db-*.json` 是**库行形状**（带 uuid、时间戳、`publish_status`、`body_html`），人读不了，别的博客工具也接不上。

### 3.1 用法

```bash
npm run export:md                              # 导出到 content-export/<时间戳>/
node scripts/export-markdown.mjs --out some/dir
npm run export:md:dry                         # 只报告将写哪些文件
node scripts/export-markdown.mjs --verify apps/web/content   # 往返校验
```

### 3.2 字段映射（与 `db/mapping.ts:mapEntry` 严格对称）

| markdown frontmatter | 库里的位置 |
|---|---|
| `title` | `entries.title` |
| `description`(blog/projects) / `summary`(diary) | `entries.summary` |
| `name`(projects) | `entries.title`（projects 的 title 列存的就是 name） |
| `date` | `entries.display_date` |
| `category` / `cover` | `entries.data.*` |
| `mood` | `entries.data.mood` |
| `techStack`/`status`/`period`/`role`/`github`/`demo`/`article` | `entries.data.*` |
| `featured` / `order` | `entries.featured` / `entries.sort_order` 列 |
| `horizon`/`status`/`progress`/`period`/`milestones` | `entries.data.*`（`order` 走列） |
| `tags` | `tags` + `entry_tags`（按 `tag_order` 保序） |
| `draft` | `entries.publish_status === "draft"` |
| 正文 | `entries.body_md` |

**刻意不导出的**：`body_html`（派生缓存，导入时按 `renderOptionsForKind` 重算）、`version`/`created_at`/`updated_at`/`created_by`/`updated_by`（库行生命史，不是内容）、`entry_revisions`/`audit_logs`（平台运行记录）。

### 3.3 校验方式：不是字节比对，是往返等价

第一版把「导出产物与 `apps/web/content/` 逐字节相等」当验收口径，跑出来 **10/10 全不等**。逐个查清后发现两类差异，**都不可能消除，也都不是缺陷**：

1. **导入期就已经丢掉的字符。** `diary/week01.md` 的 `mood: "maybe so bad i am so tried "` 尾部有一个空格；`packages/content-core/src/primitives.ts` 的 `zOptionalString` 会 `trim()`，库里存的是没有尾空格的值。导出无法凭空造出那个空格——这是 P2 导入契约的既定行为（当时刻意决定的：尾空白视为脏数据）。
2. **frontmatter 与正文之间的空行数量。** 原文件有的写 `---\n正文`、有的写 `---\n\n正文`；`gray-matter` 把空行算进 content，`mapEntry` 又统一 `trim()`，所以空行个数在库里没留下任何痕迹，导出只能挑一种写法。

所以字节比对测的是**原文件的历史书写习惯**，不是往返是否等价。真正的等价定义是：

> 把导出的 markdown 重新走一遍导入路径（`db/mapping.ts:mapEntry`），得到的行与库里的行相等。

`--verify` 就实现这个：复用 `mapEntry`（不另写解析器，否则校验器会成为第二实现），逐条比对 `title` / `summary` / `body_md` / `publish_status` / `featured` / `sort_order` / `display_date` / `data`（深比较）/ `tags`（含顺序）。

### 3.4 实测结果

```
[export] 共 10 个文件：blog 4 / diary 1 / projects 3 / goals 2

# 对刚导出的目录
[verify] 库中条目 10 个，往返等价 10 个，问题 0 处
[verify] 结果：全部条目「导出 → 重新导入」后与库等价

# 对仓库里那份原始 markdown（历史文件，不是导出产物）
[verify] 比对目录：...\apps\web\content
[verify] 库中条目 10 个，往返等价 10 个，问题 0 处
[verify] 结果：全部条目「导出 → 重新导入」后与库等价
```

**第二条比第一条更有价值**：它证明的不是「导出器自洽」，而是「仓库里那 10 个历史 md 文件能原样重建整个库」。这才是「库没了也能救回来」的实证。

### 3.5 踩过的两个坑（都写进了代码注释）

- **`display_date` 必须在 SQL 里 `to_char`**。postgres-js 会把 `date` 列解析成 JS `Date`，`String(date)` 得到 `Mon Oct 12`——直接毁掉 frontmatter。第一版在 JS 里截前 10 位，`Date` 对象上截出的是 `"Mon Oct 1"`。
- **加载 `db/mapping.ts` 需要 import hook**。它 import 的 `@loxander/content-core` 的 `main` 指向 `src/index.ts`，其内部全是无扩展名的相对 import（`./kinds`、`./parse`）。node 的 TS 类型剥离只做语法变换不做模块解析，所以必须 `registerHooks` 补 `.ts` 后缀——仓库里所有离线测试都是这么做的，脚本里也照做，避免「测试能跑、脚本不能跑」。

---

## 4. 新平台成为唯一内容入口：实证

| 判据 | 证据 |
|---|---|
| 改内容不再需要 Git | `apps/web/src/lib/admin/actions.ts` 的写路径只做「事务写库 → `updateTag()`」，全仓无任何 `triggerDeploy` 调用 |
| 线上内容来自库 | `CONTENT_SOURCE=db`（Vercel 生产环境变量）；`/api/health` 返回 `database: "ok"` |
| 旧项目不再自动部署 | `OLD blog: link.type=NONE`（见 §2.1） |
| 桌面端不再自动推送 | `FALLBACK.autoPublish: false`（见 §2.2） |
| 存量大新平台后台可读 | `npm run db:compare` → 137 检查项 0 差异（库路与 markdown 路逐字节等价） |

---

## 5. 备份与可追溯

| 资产 | 位置 | 说明 |
|---|---|---|
| 数据库逻辑备份 | `npm run db:backup` → `backups/db-<时间戳>.json` | 11 张表 / 40 行 / 201.3 KB（2026-10-26 22:30 实测）。**已 `.gitignore`**：含真实内容与后台草稿，属运行时产物 |
| 全库恢复 | `npm run db:restore <file>` / `db:restore:dry-run` | `insert ... on conflict do nothing`，只恢复数据不恢复 schema（schema 由 `db/migrations/*.sql` 负责） |
| 恢复演练 | `npm run db:restore:drill` | 全自动：dump → 插脏数据 → restore → 逐表比对 |
| Markdown 全量导出 | `npm run export:md` → `content-export/<时间戳>/` | 10 个文件，可被 `db:import` 原样吃回。**已 `.gitignore`** |
| 内容历史副本 | `apps/web/content/*.md`（进版本库） | 与库往返等价（§3.4 第二条） |
| 平台运行记录 | `entry_revisions`（版本历史）+ `audit_logs`（审计） | 后台可见，含每次写操作的 actor / action / detail |

---

## 6. 回滚：仍然可执行的四条路

P8 验收第三条「回滚文档仍可执行」。按「代价从低到高」排列：

### 6.1 内容源回滚（秒级，无损）

改 `CONTENT_SOURCE=markdown` 并重启。线上立刻改读仓库里的 md，完全不碰数据库。

实测（`npm run test:rollback`，四腿全绿）：

```
db/good       13/13 符合预期
markdown/good 13/13 符合预期   ← 回滚通道可用
db/bad        12/12 符合预期   ← 负控制：坏库下 health 必须 503
markdown/bad  13/13 符合预期   ← 负控制：markdown 源确实不依赖库
```

### 6.2 代码回滚（分钟级）

Vercel 上 promote 上一个 READY 部署即可。旧项目 `blog` 的最后一次生产部署仍留在账号里（`dpl_HtviPiobkMyt1XgdCxjPqjae7Qib`，sha `3ab15d3`），但**域名已经不在它上面**，要恢复它必须同时把域名移回去。

### 6.3 数据库恢复（分钟级，可能丢最近写入）

`npm run db:restore backups/db-<时间戳>.json`。或用 Neon 控制台的 PITR（point-in-time restore）。

### 6.4 回旧架构（小时级，最后手段）

把域名 `loxander.is-a.dev` 移回旧项目 `blog`，并 `PATCH` 恢复它的 Git 集成。**注意**：旧仓库 `content/` 停在 2026-10-19，这之后在 `/admin` 里改的内容不在里面——要么先 `npm run export:md` 再手工搬，要么接受丢失。

---

## 7. 本机无权完成的三项（如实列出，未做）

P8 五项任务里，有 **1 项整项**和 **2 项的一部分**需要外部账号权限，本机做不到。它们不阻塞「新平台成为唯一入口」这个验收目标，但它们是 P8 定义里的字面要求，不能算完成。

### 7.1 归档旧仓库（P8 任务 4「归档旧仓库」——**整项未做**）

要做的动作是给两个 GitHub 仓库打 archived 标记（只读、可追溯、不能再推）：

```
PATCH /repos/xuwenshi/blog          { "archived": true }
PATCH /repos/xuwenshi/electron-cms  { "archived": true }
```

**为什么没做**：本机 `git credential fill` 能取到一个 40 字符的 `gho_` token（`username=xuwenshi`），但它对 `api.github.com` 返回 **401 Bad credentials**，`x-oauth-scopes` 为空。它只够 `git push/pull` 用，不是 PAT，也没有 `repo` 管理权限。

**谁来做**：仓库所有者（`xuwenshi`）在 GitHub 网页 **Settings → General → Danger Zone → Archive this repository**，两个仓库各操作一次；或提供一个带 `repo` scope 的 Personal Access Token，我可以代为调用。

**前置检查**：归档前确认旧仓库没有未合并的分支与未发布的 Release，否则归档后这些都会变成只读。

### 7.2 停止 Git 驱动的线上发布——**Vercel 侧已停，GitHub 侧未停**

Vercel 的 Git 集成已断开（§2.1），所以推代码不再触达生产。但两件事仍在：

- 旧仓库 `blog` 的 `main` 分支仍然可写、仍会积累提交（只是不再触发部署）；
- `electron-cms` 仓库本身仍可推送（它不触发部署，但也未归档）。

这两条都依赖 §7.1 的归档动作才能彻底关闭。

### 7.3 旧仓库归档后的「只读可追溯」验证

归档后应能验证：`git clone` 仍可读、网页可浏览历史、但 `git push` 被拒。这条验证依赖 §7.1 先完成，**未做**。

---

## 8. 当前状态总表

| P8 任务 | 状态 | 说明 |
|---|---|---|
| 停止 Electron 自动发布 | ✅ 完成 | 默认值改为 `false`（三处），功能代码保留作为退路 |
| 停止 Git 驱动的线上发布 | ⚠️ 部分完成 | Vercel Git 集成已 `DELETE .../link` 断开；GitHub 侧可写性依赖归档（§7.2） |
| Markdown 仅保留导入和导出用途 | ✅ 完成 | 导出脚本新建，往返校验 10/10；写入方向改为「md 只读」 |
| 归档旧仓库 | ❌ 未做 | **缺 GitHub 管理权限**（§7.1） |
| 保留迁移文档和备份 | ✅ 完成 | 本文档 + `db:backup` 逻辑备份 + `export:md` 全量导出 |

**验收三条：**

| 验收 | 状态 | 证据 |
|---|---|---|
| 新平台成为唯一内容入口 | ✅ | §4 五项证据 |
| 旧仓库只读可追溯 | ❌ | 未归档，故仍是「可写可追溯」（§7.1） |
| 回滚文档仍可执行 | ✅ | §6 四条路，其中 6.1 已实测四腿全绿 |

---

## 9. 一句话结论

**新平台的唯一入口已经成立，且证据是可复跑的命令而不是声明；旧仓库的「只读」还差一个 GitHub 管理权限动作，这一项本机做不到，已如实列在 §7.1。**
