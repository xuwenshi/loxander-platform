# electron-cms

`my-blog` Next.js 博客的本地 Electron 桌面 CMS。**独立于博客仓库**，对 `my-blog/` 的代码改动数为 0；只读写 `content/**/*.md`，且仅在人工确认后才 commit。

> 当前进度：**P5（打包）**。全链路已闭环：列出四分区内容 → 打开/新建/重命名/删除条目 → schema 驱动的 frontmatter 表单 + Markdown 编辑/消毒预览/差异预览 → 字段级保存（备份 + 乐观锁）→ 发布预检 → 人工确认卡（显式勾选文件 + commit message）→ 部分提交 → push → 发布状态机 → **按 SHA 回读部署状态（GitHub commit status / Vercel API）** → **一键回滚（git revert，可选）** → **NSIS 安装包**。

## 环境前提（本机特有）

本机直连 GitHub / Vercel 不通，必须走本地 socks5 代理 `socks5://127.0.0.1:10808`。

- Electron 二进制**必须走镜像**（否则 postinstall 从 GitHub 下载会失败）：项目内 `.npmrc` 已写入 `electron_mirror=https://npmmirror.com/mirrors/electron/`；如果仍失败，安装前显式设置环境变量：

  ```powershell
  $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
  npm install
  ```

- npm registry / 代理沿用用户级 `~/.npmrc`（`registry=https://registry.npmmirror.com`，`proxy=socks5://127.0.0.1:10808`）。

- **npm 12 会默认拦截 postinstall 脚本**（新安全机制），表现为 `npm warn install-scripts 3 packages had install scripts blocked`，此时 `electron` 二进制**不会被下载**（`node_modules/electron/dist` 为空）。处理方式：

  ```powershell
  npm install-scripts ls                 # 查看被拦截的包
  npm install-scripts approve electron esbuild
  npm rebuild electron esbuild          # 重新执行 postinstall（electron 走 ELECTRON_MIRROR 下载）
  ```

  批准结果会写入 `package.json` 的 `allowScripts` 字段，之后新环境安装即自动放行。

- `npm install` / `npm rebuild` **不要**用 `| Select-Object -First N` 截断输出：PowerShell 提前关闭管道会让 node 中途 EPIPE 退出，Postinstall 看似成功实则未完成（本次踩坑点）。日志请用 `Out-File` 重定向到文件后再查看。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式启动（electron-vite 三段构建 + HMR） |
| `npm run build` | 构建到 `out/` |
| `npm run build:win` | 构建 + 打包 Windows NSIS 安装包到 `release/` |
| `npm run typecheck` | 主进程/preload 与 renderer 分别类型检查 |
| `npm test` | 契约/往返/保存/发布/回滚/部署回读测试（vitest） |

## 自检模式

无人值守验证「Electron 启动 → sandbox 渲染进程加载 preload → 白名单 IPC 打通」：

```powershell
$env:CMS_SELFCHECK='1'; npm run dev
```

成功时输出 `[cms] SELFCHECK_OK {...}` 并退出码 0；失败输出 `[cms] SELFCHECK_FAIL ...` 且退出码为 1/2。

## 工作区解析顺序

`CMS_WORKSPACE` 环境变量 → `settings.json`（`userData` 目录下）→ 与 `electron-cms` 同级的 `my-blog` → 上一级的 `my-blog`。侧栏底部「选择工作区…」可手动指定（要求所选目录下存在 `content/`），结果写入 `settings.json` 长期生效。

> 用安装包安装后，程序目录下没有同级 `my-blog`，首次启动需点一次「选择工作区…」指向博客仓库根目录（如 `C:\...\bolg\my-blog`）；之后再从桌面快捷方式启动会自动读取该记录。

## 安全基线

`contextIsolation: true` · `nodeIntegration: false` · `sandbox: true` · `webSecurity: true`；
renderer 无任何 Node 能力，全部经 preload 白名单 IPC；主进程对路径做根目录前缀校验（`security/pathGuard.ts`）；CSP 区分 dev（放行 Vite HMR）与 prod（仅 `file://`）。

## 数据层（P1）关键约定

**字段级 patch（默认保存策略）**：保存只重写被编辑字段所在的 YAML 行，其余字段与 Markdown 正文**逐字节不变**；因此不会因重新序列化而丢失引号风格、日期书写形态或引入 Git 噪声。语义未变的字段会被自动跳过（`skipped`）。仅当字段级 patch 不可用时才考虑整份重排（`serializeFullDocument`），该路径当前只用于差异预览，且必须人工确认后才允许写入。

- `date` 一律以 `YYYY-MM-DD` **字符串**处理，绝不构造 `Date`（避免 Asia/Shanghai 下的差一天）。
- 可选字段被清空 → patch 值为 `null` → 从 frontmatter 中**删除该字段**（而非写成空串）。
- **乐观锁**：读取时记录 `{mtimeMs, size, sha256}`；保存前比对，不一致返回 `CONFLICT` 并附磁盘版本，由用户选择「重新加载」或「确认强制覆盖」。否决路径不会覆盖磁盘。
- **原子写**：同目录 temp 文件 → `write + fsync` → `rename` 覆盖（Windows 下对 `EPERM/EBUSY` 做有限退避重试）。
- **备份**：每次真正写盘前，把原文件复制到 `<userData>/.cms-backups/<section>/<slug>/<时间戳>.md`（位于 CMS 自己的 userData，**不进博客仓库**）。
- **删除保护**：`blog` / `diary` / `projects` 使用 Next 16 的 `generateStaticParams`（不接受空数组），三者不允许删空；`goals` 无 `[slug]` 路由，允许删空。

新增 IPC 通道：`content:schema` / `content:read` / `content:patchFrontmatter` / `content:saveBody` / `content:dirtyDiff` / `content:validate`。

测试覆盖（`npm test`）：字段级 patch 字节不变（含 CRLF、块状 milestones）、真实 11 篇内容的**往返幂等**、四分区**契约测试**、以及临时仓库上的**保存链路与冲突拦截**。

## Git 闸门（P2）关键约定

**只提交人工勾选的文件**：`git add -- <paths>` + `git commit -- <paths>` 均使用**显式文件清单**，禁止 `-A` / `.` / `--all` / 通配符。`gitService.assertSafeFileList` 会拒绝空清单、`-` 开头、绝对路径、含 `*?[]{}` 的路径，并对每个路径做根目录前缀校验（越界 → `PATH_ESCAPE`）。

**部分提交复核**：提交后回读 `git show --name-only --pretty=format: HEAD`，若提交集合 ⊄ 清单则视为异常。仓库中其他已暂存/未暂存的内容不会被带上。

**发布预检（`publish:run` 的闸门）**：`git:preflight` 产出 `PreflightReport`——
- 非 Git 仓库 → `GIT_NOT_REPO`；当前分支 ≠ 期望分支 → `GIT_BRANCH`；
- `behind > 0` → **阻断**（`GIT_BEHIND`），提示先用「拉取（--ff-only）」恢复，不允许在落后时提交；
- 变更文件按 `content/` 前缀拆成 `contentFiles` / `otherFiles`，非内容改动仅告警；
- 复用 P1 的 `validateWorkspace` 做契约/引用校验（blocking 会阻断发布）；
- 逐分区计数，低于 `minCount`（blog/diary/projects = 1，goals = 0）→ `SECTION_EMPTY` 阻断。

**发布状态机与状态文件**：`idle` →（提交成功）`committed-not-pushed` →（push 成功）`pushed`。状态持久化在 `<userData>/publish-state.json`（**不进博客仓库**）。预检未过或 `confirmed !== true` 时**零副作用**（不提交、不改状态）；推送失败**不抛错**，而是把错误写入状态并停留在 `committed-not-pushed`，可由「重试推送」继续。

**环境变量白名单**：simple-git v4 会校验 `.env()` 注入的键，故只放行 `ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` / `GIT_TERMINAL_PROMPT`（配合构造器 `allowEnvironment`），既注入 socks5 代理又避免 `EDITOR`/`GIT_ASKPASS` 等被判为不安全而直接抛错。

**错误分类**：git 原始错误经 `classifyGitError` 归类为 `GIT_AUTH` / `GIT_REJECTED` / `GIT_NETWORK` / `GIT_FAILED`，`detail` 保留原始 stderr/stdout 便于排查。

新增 IPC 通道：`git:status` / `git:diff` / `git:preflight` / `git:pull` / `publish:state` / `publish:run` / `publish:retryPush` / `publish:clear`。

测试覆盖（`git.publish.test.ts`，12 例）：安全清单拒绝（`.`/`-A`/`--all`/通配/空/越界绝对路径）、归一去重、部分提交只提交清单内文件、空 message 拒绝、干净仓库预检通过、内容/非内容分离、分区删空阻断、未确认 → 零副作用、`behind > 0` 阻断 + `--ff-only` 恢复、无远端 → `committed-not-pushed`（可重试）、有远端 → `pushed`（远端 HEAD === commitSha）、空清单 → `GIT_UNSAFE_PATH`。

## 内容管理闭环（P3）关键约定

**新建**（`content:create`）：按分区 schema 生成最小合法 frontmatter（必填字段给默认值：`date` → 本地日历日 `YYYY-MM-DD`、`enum` → 首项、其余 → 标题或 slug；`projects` / `goals` 补 `order: 999`），写入 `---\n<yaml>---\n\n`。重名 → `ENTRY_EXISTS`。slug 经 `assertSafeSlug` 校验（只允许 `[A-Za-z0-9-_]`，拒绝 `../` 与 `/`）。

**输入弹窗**：Electron **未实现 `window.prompt`**（实测调用即抛错 `prompt() is not supported.`，会让点击「新建 / 重命名」的处理器在第一行就中断、界面上毫无反应）。因此这两处改用应用内弹窗 [PromptDialog.tsx](src/renderer/src/components/PromptDialog.tsx)（`window.confirm` 在 Electron 中可用，故删除确认仍用它）。

**删除**（`content:delete`）：**先备份**到 `<userData>/.cms-backups/<section>/<slug>/<时间戳>.md`，再 `unlink`。删除前执行 `assertDeletable(section, count - 1)`：`blog` / `diary` / `projects` 不允许删空（→ `LAST_ITEM_PROTECTED`），`goals` 允许。

**重命名**（`content:rename`）：`rename` 保持文件字节不变；若是 `blog` 分区，会扫描 `projects` 中 `article === 旧 slug` 的引用**只报告不改写**（`references`），并给出 `staleUrl = /blog/<旧 slug>`（站点无重定向 → 旧地址 404）。

**封面枚举**（`content:covers`）：递归 `public/` 下的 `.svg`，`cover` 字段用 `datalist` 做候选联想，**仍允许自由输入**。

新增 IPC 通道：`content:covers` / `content:create` / `content:delete` / `content:rename`。
测试覆盖（`content.manage.test.ts`，14 例）：新建合法并可通过契约校验、title/date 覆盖、重名拒绝、非法 slug、删除备份与剩余计数、删空保护、`goals` 允许删空、`ENTRY_NOT_FOUND`、rename 保字节 + `staleUrl`、blog rename 报 `projects.article` 引用且不改写、非 blog 不扫描、rename 目标已存在/同名、`listCovers` 递归排序、`public/` 不存在返回空。

## 部署回读（P4）关键约定

**默认通道 = GitHub commit status（零配置）**：`GET api.github.com/repos/{owner}/{repo}/commits/{sha}/status`，公开仓库匿名可读（60 次/小时）。只能拿到合成状态与 `target_url`（一般指向 Vercel 部署详情页）。

**增强通道 = Vercel API**：`GET api.vercel.com/v6/deployments`（`Authorization: Bearer <只读 Token>`），按 `meta.githubCommitSha === sha` **精确匹配**——绝不退化成「取最新一条」，无匹配时返回 `pending / NOT_FOUND` 并明确提示。可拿到部署直链与 `inspectorUrl`，状态更细（`QUEUED`/`BUILDING`/`READY`/`ERROR`）。

**状态归一**：`pending`（排队）/ `building`（构建中）/ `ready` / `error` / `unknown`，同时保留提供方原始状态串 `rawState` 便于排查。

**轮询与复核**：默认退避 `interval * 2^(n-1)`（上限 15s）、最多 24 次、总超时 180s；`ready` 后若配置了 `productionUrl` 会再做一次真实 HTTP 复核（2xx/3xx 才算通过），避免「API 说 ready 但站点 5xx」。

**网络实现**：用 Electron 原生 `net` + 独立 session（`session.fromPartition('cms-deploy')`）设置 `proxyRules`，原生支持 socks5 代理并**不是用** `socks-proxy-agent`（它 v10 起为 ESM-only，与主进程 CJS 产物不兼容）。`deployService` 只依赖注入的 `HttpClient` 接口，因此可用假 HTTP 完整单测。

**配置**（`settings.json`，均在 CMS 自己的 `userData`）：

| 键 | 说明 |
| --- | --- |
| `deployProvider` | `github`（默认）或 `vercel` |
| `repository` | `owner/repo`；**留空则自动从 `git remote get-url origin` 推导** |
| `vercelToken` | Vercel 只读 Token（`vercel` 通道必需） |
| `vercelProjectId` | 可选，缩小查询范围 |
| `productionUrl` | 可选，配置后对部署结果做 HTTP 复核 |

新增 IPC 通道：`deploy:status`（`wait: true` 轮询到就绪/失败/超时；`wait: false` 只查一次）。
测试覆盖（`deploy.publish.test.ts`，15 例）：remote URL 解析（https/ssh/非法）、缺 SHA / 仓库标识非法 / Vercel 缺 Token → `DEPLOY_CONFIG`、GitHub 404 → `DEPLOY_NOT_FOUND`、403 → `DEPLOY_HTTP`、`pending → success` 轮询、退避序列受 `maxInterval` 约束、超时兜底、Vercel **SHA 不匹配拒绝**、命中 SHA 给直链、`BUILDING` 归一、生产地址复核成功/失败两条路径。

## 打包（P5）

```powershell
npm run build:win   # electron-vite build && electron-builder --win nsis
```

产物：`release/my-blog CMS-<version>-setup.exe`（NSIS，可选安装目录；安装时自动创建**桌面快捷方式**与开始菜单项）。静默安装可加 `/S`。配置见 [electron-builder.yml](electron-builder.yml)：只收编 `out/**` 与生产依赖，源码/测试不进包；`content/` 与博客仓库的任何代码都不进安装包——CMS 只读写外部工作区。

**安装包内的凭据/网络**：`proxy` / `remote` / `branch` / `deployProvider` / `repository` / `vercelToken` / `vercelProjectId` / `productionUrl` 全部存在 `<userData>/settings.json`（Windows：`%APPDATA%/my-blog CMS/settings.json`），**不打包、不入库**。换机后需重新填写代理地址与 Vercel Token。

## 一键回滚（P5 可选）

对**上一次发布**的提交生成**反向提交**（`git revert --no-edit <sha>`），**绝不改写历史**：不使用 `reset` / `--force`，因此远端无需强推，回滚之后仍可再次 revert 回来。入口在发布面板的状态条「回滚本次发布」（需二次确认）。

- **人工确认闸门**：`publish:revert` 必须 `confirmed: true`；未确认或无发布记录 → 抛错且**零副作用**。
- **SHA 白名单**：只接受 7-40 位十六进制提交号，拒绝 `--hard` / `HEAD` 之类的参数注入。
- **冲突安全**：revert 冲突时立即 `git revert --abort` 复原工作区，并提示「被回滚的文件在发布后被再次修改」。
- **推送策略**：仅在原发布已推送（`pushed`）时推送反向提交；推送失败不抛错，写入状态后可由「重试推送」补推。回滚后 `commitSha` 更新为反向提交，`deploy:status` 也随之回读该提交的部署。

新增 IPC 通道：`publish:revert`（`{ confirmed, push? }`）。
测试覆盖（`git.publish.test.ts`，新增 5 例）：反向提交产生且**原提交仍是新 HEAD 的祖先**（等价于未 reset/强推）、内容还原、远端 HEAD = 反向提交且原提交仍在远端历史、未确认零副作用、无记录时报错、SHA 注入拒绝、`push=false` 后可补推。