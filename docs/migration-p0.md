# P0 仓库合并迁移记录

本文记录 `loxander-platform` 建立时，把 `my-blog` 与 `electron-cms` 两个旧仓库的历史导入新 monorepo 的实际过程。

- 执行日期：2026-10-21
- 目标仓库：`C:\Users\luoxu\Desktop\learn\bolg\loxander-platform`
- 源仓库（只读，迁移全程未修改）：
  - `my-blog`，HEAD = `3ab15d3`，分支 `main`，11 个 commit
  - `electron-cms`，HEAD = `8f8ed5a`，分支 `main`，6 个 commit

---

## 1. 与原方案 §4.2 的差异

方案 §4.2 推荐用 `git subtree add --prefix=apps/web blog main --squash` 导入历史。**本次未采用 `git subtree`，原因是它在当前机器上不可用。**

| 项目 | 原方案 §4.2 | 本次实际做法 | 原因 |
| --- | --- | --- | --- |
| 导入工具 | `git subtree add` | `git bundle` + `git fetch` + `git merge -s ours` + `git read-tree` | `git subtree` 在本机必然失败（见下节） |
| 历史粒度 | `--squash`，压成 1 个提交 | 保留完整细粒度历史（11 + 6 个 commit 全部可达） | bundle 方式天然保留全部历史，无需额外成本，优于原方案的 squash |
| 远端依赖 | 需要先 `git clone` 再 `git remote add` + `git fetch` | 全程本地操作，不访问任何远端 | 两个旧仓库本就在本地；且访问 GitHub 远端需要额外加 `-c http.sslBackend=openssl`（否则 schannel 报 `SEC_E_NO_CREDENTIALS`），本地 bundle 绕开该问题 |
| `git clone` | 作为建仓起点 | 未使用 | 本机 `git clone <本地路径>` 同样因 sh 无法创建 signal pipe 而不可用 |
| 根仓库来源 | 以 `electron-cms` 仓库为根 | 新建空仓库，两个旧仓库分别进 `apps/` | 方案 §4 目标结构要求 `apps/web` 与 `apps/desktop` 平级，不采用「一个旧仓库当根」的形态 |

### 1.1 `git subtree` 为什么不可用

Git for Windows 的 `sh` 在 `git subtree` 内部创建 signal pipe 时失败，`git subtree add` 退出码 66。该问题与仓库内容无关，换目录、换参数均复现。因此**本项目禁止使用 `git subtree`**，后续阶段如需再合并仓库，沿用本文的 bundle 路径。

### 1.2 为什么不用 `git filter-repo`

方案 §4.2 提到「如果必须保留完整的细粒度提交历史，使用 `git filter-repo` 重写路径再合并」。本次没有走这条路，因为 `git read-tree --prefix=` 已经能在一个提交内把历史整体落到指定前缀下，且**完整历史仍然可达**——不需要重写历史就能同时拿到「细粒度历史」和「正确目录结构」这两个目标。`filter-repo` 会改写 commit hash，反而破坏与旧仓库的可比对性。

---

## 2. 实际使用的命令序列

两个仓库的导入步骤完全对称。以下 `<TMP>` 为 `%TEMP%\loxander-p0`，`<PLATFORM>` 为 `loxander-platform` 根目录。

### 2.1 导入 my-blog → `apps/web`

```powershell
# 1) 为旧仓库生成 bundle（只读操作，不改动旧仓库）
git -C <my-blog> bundle create <TMP>\blog.bundle main

# 2) 可选但已执行：校验 bundle 完整性，输出 "is okay"
git -C <my-blog> bundle verify <TMP>\blog.bundle

# 3) 把 bundle 里的 main 取到新仓库的临时分支
git -C <PLATFORM> fetch <TMP>\blog.bundle main:refs/heads/import/web

# 4) 用 ours 策略合并：只记录「合并」这一事实，不引入任何文件
git -C <PLATFORM> merge -s ours --allow-unrelated-histories --no-commit refs/heads/import/web

# 5) 把 import/web 的整棵树按前缀落到工作区与索引
git -C <PLATFORM> read-tree --prefix=apps/web/ -u refs/heads/import/web

# 6) 提交（这一步同时成为 merge commit，父提交为 init 与 3ab15d3）
git -C <PLATFORM> commit -m "chore: 导入 my-blog 历史到 apps/web"
```

### 2.2 导入 electron-cms → `apps/desktop`

```powershell
git -C <electron-cms> bundle create <TMP>\cms.bundle main
git -C <PLATFORM> fetch <TMP>\cms.bundle main:refs/heads/import/desktop
git -C <PLATFORM> merge -s ours --allow-unrelated-histories --no-commit refs/heads/import/desktop
git -C <PLATFORM> read-tree --prefix=apps/desktop/ -u refs/heads/import/desktop
git -C <PLATFORM> commit -m "chore: 导入 electron-cms 历史到 apps/desktop"
```

### 2.3 收尾清理

```powershell
# 删除临时 bundle 与临时目录（bundle 不进仓库）
Remove-Item <TMP>\blog.bundle, <TMP>\cms.bundle -Force
Remove-Item <TMP> -Recurse -Force

# 删除辅助分支：其 commit 已由 merge 父提交永久保留，分支本身不再需要
git -C <PLATFORM> branch -D import/web import/desktop
```

> 注意：删除 `import/web`、`import/desktop` 分支**不影响**旧历史可达性——两个导入提交都是 merge commit，`3ab15d3` 与 `8f8ed5a` 作为第二父提交被 main 直接引用。删除后已复验 `git cat-file -t 3ab15d3` / `8f8ed5a` 仍返回 `commit`。

---

## 3. 关键机制说明

`merge -s ours --no-commit` + `read-tree --prefix=` 的组合是这个方案能成立的核心：

1. `merge -s ours` 生成一个 merge commit，**只把两个历史树「接上」**，工作区一个文件都不变。这解决了「两个仓库没有共同祖先」的问题——`--allow-unrelated-histories` 是必需的。
2. `read-tree --prefix=apps/web/ -u` 才真正把文件按前缀铺到工作区和索引。
3. 因为没有立即 commit，第 2 步铺的文件被并入第 1 步那个待提交的 merge commit。结果就是**一个 commit 同时做到「接上历史」和「文件落位」**。

如果先 commit 再 read-tree，会多出一个「纯文件搬运」的提交，历史不如现在干净。

---

## 4. 导入结果

### 4.1 文件数对比

| 目录 | 导入后 tracked 文件数 | 旧仓库 tracked 文件数 | 是否一致 |
| --- | --- | --- | --- |
| `apps/web` | 89 | 89（`my-blog`） | 一致 |
| `apps/desktop` | 69 | 69（`electron-cms`） | 一致 |
| 根目录（`.gitignore`、`README.md`、`package.json`、`tsconfig.base.json`） | 4 | — | — |
| **合计** | **162** | — | — |

### 4.2 commit 数对比

| 项目 | 新仓库可达 commit 数 | 旧仓库 commit 数 |
| --- | --- | --- |
| my-blog 历史 | 11 | 11 |
| electron-cms 历史 | 6 | 6 |
| 新仓库自有 | 3（init + 两个导入） | — |

### 4.3 最终提交历史（`git log --oneline`）

```text
f6ed06d chore: 导入 electron-cms 历史到 apps/desktop
36d4976 chore: 导入 my-blog 历史到 apps/web
83e7f6b chore: 初始化 loxander-platform 工作区
3ab15d3 chore: 站点身份统一为 Loxander，GitHub/邮箱指向真实账号
e3325e3 chore: 生产域名切换为 https://loxander.is-a.dev
4949879 content: 更新 diary/2026-10-09-example、diary/2026-10-10-example
8f8ed5a feat: 预览端口可配置 + 启动即健康探测，并自动展开预览面板
40a75ae feat: 打通桌面 CMS 与博客——本地实时预览 + 线上自动发布
...（其余旧仓库 commit 全部保留）
c446e48 Initial commit from Create Next App
```

### 4.4 两个导入提交的父提交

| 导入提交 | 父提交 |
| --- | --- |
| `36d4976` | `83e7f6b`（init）、`3ab15d3`（my-blog HEAD） |
| `f6ed06d` | `36d4976`（前一个导入）、`8f8ed5a`（electron-cms HEAD） |

---

## 5. 保真性验证

### 5.1 逐 blob 哈希比对（最强验证）

不只比文件数，而是把每个文件的 git blob 哈希逐一对比。因为 git blob 哈希由文件内容唯一决定，哈希全等即证明**内容零改动**。

| 对比 | 结果 |
| --- | --- |
| `my-blog` HEAD 的 89 个 blob ↔ `apps/web` 的 89 个 blob | **全部相同，无差异** |
| `electron-cms` HEAD 的 69 个 blob ↔ `apps/desktop` 的 69 个 blob | **全部相同，无差异** |

结论：导入过程对源码内容**零修改**（字体、`next.config.ts`、`package.json` 等一律原样保留）。

### 5.2 行尾（EOL）检查

本机 `core.autocrlf=true`（来自系统级 `C:/Program Files/Git/etc/gitconfig`），因此需确认导入没有把行尾写进索引。

抽查 3 个文件（`git ls-files --eol`）：

```text
i/lf  w/crlf  apps/web/src/app/layout.tsx
i/lf  w/crlf  apps/web/content/blog/build-personal-blog-with-nextjs.md
i/lf  w/crlf  apps/desktop/src/main/index.ts
```

全量统计：

| 目录 | 索引行尾分布 |
| --- | --- |
| `apps/web` + `apps/desktop` | `i/lf` 153 个；`i/none`（二进制）5 个 |

索引行尾**全部是 LF**，与旧仓库一致（旧仓库同样是 `i/lf`）。工作区显示 `w/crlf` 是 `autocrlf=true` 的 checkout 行为，不影响索引内容，也不产生行尾污染。5 个 `i/none` 是 `apps/web/public/*.svg` 下的 SVG 图标，git 判定为二进制，属正常。

### 5.3 污染检查

导入前后均检查，结果全部为「无」：

| 检查项 | 结果 |
| --- | --- |
| 暂存区含 `node_modules` | 无 |
| 暂存区含 `.next/` | 无 |
| 暂存区含 `*.tsbuildinfo` | 无 |
| 暂存区含 `apps/desktop/out/`、`release/`、`dist/` | 无 |
| 磁盘上存在嵌套 `.git` 目录（子模块/嵌套仓库） | 无 |
| 仓库内残留 `*.bundle` 文件 | 无 |
| `apps/web` 磁盘文件数 vs 暂存文件数 | 89 = 89（无未跟踪残留） |
| `apps/desktop` 磁盘文件数 vs 暂存文件数 | 69 = 69（无未跟踪残留） |

`read-tree` 按 git 索引展开，未 tracked 的 `node_modules/`、`.next/`、`out/`、`release/` 天然不会进入新仓库。

导入进来的 `.gitignore` 仍然生效，已用 `git check-ignore -v` 逐条验证：

```text
apps/web/.gitignore:4:/node_modules     → apps/web/node_modules/next/package.json
apps/web/.gitignore:17:/.next/          → apps/web/.next/build-manifest.json
apps/desktop/.gitignore:2:out/          → apps/desktop/out/main/index.js
apps/desktop/.gitignore:4:release/      → apps/desktop/release/win-unpacked/x.exe
```

### 5.4 旧仓库只读性确认

迁移结束后复验，两个旧仓库 HEAD 与工作区状态均未变化：

| 仓库 | HEAD | `git status --porcelain` |
| --- | --- | --- |
| `my-blog` | `3ab15d3`（未变） | 空（干净） |
| `electron-cms` | `8f8ed5a`（未变） | 空（干净） |

迁移全程只对旧仓库执行了 `git bundle create` 与 `git bundle verify` 两个只读命令。

---

## 6. 需要后续注意的事项

以下事项本次**未处理**，因为 P0 只做导入，不改源码（改动属于 B 段）：

1. **`apps/web` 带入了 `.agents/`（12 个文件）与 `skills-lock.json`**。这些文件在旧仓库是 tracked 的，按「保真导入」原则原样保留。它们与运行时无关，是否清理留待后续决定。
2. **`apps/web` 带入了 `AGENTS.md`**。其中含 `next dev` 自动生成的 `nextjs-agent-rules` 段落（`generate-agent-files.js` 写入），保留原样。
3. **`next/font/google` 仍是构建阻塞项**。`apps/web/src/app/layout.tsx` 使用 `Geist` / `Geist_Mono`，构建期需访问 Google Fonts。这是方案 §2.3 已记录的阻塞项，P0 后续步骤（改本地字体）处理。
4. **`next.config.ts` 的 `turbopack.root: process.cwd()` 在 monorepo 下需要复核**。原来 `apps/web` 是仓库根，`process.cwd()` 指向项目根；现在是 `apps/web` 子目录，语义仍成立，但需在首次 `next build` 时确认 Turbopack 能正确解析 `packages/*`。相关文档语义见 `docs/recon-p0.md`。
5. **尚未生成 `package-lock.json`**。根 `package.json` 已声明 workspaces，但依赖安装与 lockfile 收口属于后续步骤。
6. **根 `.gitignore` 与子项目 `.gitignore` 并存**。根级忽略 `node_modules/`、`.next/`、`out/`、`release/` 等，子项目 `.gitignore` 保留旧仓库规则，二者是叠加关系，不冲突。
