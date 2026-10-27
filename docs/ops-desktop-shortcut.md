# 运维台的桌面快捷方式

双击桌面上的 **「运维台」** 图标 → 等 2~4 秒 → 默认浏览器打开 `http://localhost:3210/admin/ops`。

窗口里会依次打印：

```
[open-ops] 目标：http://localhost:3210/admin/ops
[open-ops] 服务已在后台启动（PID 37916），日志：.tmp-ops-server.log
[open-ops] 等待服务响应 /api/health …
[open-ops] 服务就绪（第 2 次探测），database=ok
[open-ops] 已在默认浏览器打开。服务会继续在后台跑；本窗口可以关闭。
```

窗口关掉服务**不会**停。第二次双击会打印「服务已经在跑，跳过启动」，不会起第二个。

## 它做了哪四件事

`scripts/open-ops.mjs` 按这个顺序：

1. **先探 `/api/health`** —— 服务已经在跑就跳过启动（否则会占端口失败）
2. **没有 `.next/BUILD_ID` 就先构建** —— `node scripts/next-local-build.mjs`，约 40 秒
3. **后台起服务**（detached，`stdio` 三路都接日志文件，窗口关掉也不停）
4. **等到 `/api/health` 返回 200 再开浏览器** —— 直接开会看到「无法访问此网站」

## 为什么是这些具体值

| 选择 | 理由 |
|---|---|
| 端口 **3210** 而非启动器默认的 3310 | `apps/web/.env.local` 里 `AUTH_URL=http://localhost:3210`，GitHub OAuth App 登记的回调也是 `http://127.0.0.1:3210/api/auth/callback/github`。换端口登录回调对不上 |
| 浏览器开 **`localhost`** 而非 `127.0.0.1` | 会话 cookie 在 `AUTH_URL` 那个 origin 下，换主机名拿不到 cookie，页面会一直停在「正在校验身份…」 |
| 走 `scripts/next-local-start.mjs` 而非 `next start` | 本机沙箱禁 fork 子进程（`spawn EPERM`），`next start` CLI 起不来 |
| `WindowStyle = 1`（常规窗口） | 整个过程 2~4 秒，窗口里能看到「服务就绪 → 已打开」，失败时也能看到报错。选最小化就什么都看不见 |
| 日志追加写到 `.tmp-ops-server.log` | 已被 `.gitignore` 的 `*.log` 兜住；起不来时能翻 |

## 常用命令

```bash
npm run ops              # 起服务 + 开浏览器（= 双击）
npm run ops:url          # 只打印 URL
node scripts/open-ops.mjs --no-open       # 只起服务，不开浏览器
node scripts/open-ops.mjs --port 3400     # 换端口（注意 OAuth 回调也会对不上）
```

## 重建快捷方式

`scripts/create-ops-shortcut.ps1` 会读 `node` 的绝对路径、算好仓库根、指到 `scripts/ops.ico`，然后回读校验五个字段。

```powershell
npm run ops:shortcut
# 或
powershell -ExecutionPolicy Bypass -File scripts/create-ops-shortcut.ps1
powershell -ExecutionPolicy Bypass -File scripts/create-ops-shortcut.ps1 -Name '运维台' -Port 3210
powershell -ExecutionPolicy Bypass -File scripts/create-ops-shortcut.ps1 -WhatIfOnly   # 只看路径不写
```

**这个 .ps1 必须是 UTF-8 with BOM**。没有 BOM 时 Windows PowerShell 5.1 会按 ANSI 解码，中文字符串里的引号被打乱 → `Missing ')' in function parameter list` + `The string is missing the terminator`。脚本里已经用 `[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($true)))` 处理过。

## 图标

`scripts/ops.ico` 由 `scripts/make-ops-icon.py` 生成，几何参数抄自 `apps/web/src/app/icon.svg`（同一套坐标：64 视口、圆角 14、折线 (21,15)→(21,42)→(38,42) 线宽 7、右下圆 (45,45) r=5.5）。Pillow 不解 SVG，所以是按坐标手绘等价图形，先按 1024 超采样再 LANCZOS 降到 7 个尺寸（256/128/64/48/32/24/16）。

```bash
npm run ops:icon
```

## 登录

本地 `apps/web/.env.local` 已配齐 `AUTH_SECRET` / `AUTH_URL` / `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` / `ADMIN_GITHUB_LOGIN`。点「用 GitHub 登录」会跳到真实的 `github.com/login/oauth/authorize`，`redirect_uri = http://localhost:3210/api/auth/callback/github`，PKCE `S256`。

**注意 `ADMIN_GITHUB_LOGIN` 填的是 GitHub 用户名（login），不是邮箱也不是显示名**，留空等于拒绝所有登录（fail-closed）。

## 排错

| 现象 | 原因与处置 |
|---|---|
| 窗口一闪就没 | 右键快捷方式 → 属性，确认「目标」是 `node.exe` 全路径、「起始位置」是仓库根 |
| 90 秒超时报「没等到服务就绪」 | 脚本会打印日志最后 25 行。常见是端口被占（`netstat -ano \| findstr :3210` 后 `Stop-Process -Id <pid> -Force`） |
| 页面一直「正在校验身份…」 | 用 `127.0.0.1:3210` 而不是 `localhost:3210` 打开了，cookie 拿不到 |
| 登录后跳 `/api/auth/error?error=AccessDenied` | `ADMIN_GITHUB_LOGIN` 里没有你的 GitHub 用户名，或留空了 |
| 页面样式全丢（没有 Tailwind 类） | 构建产物是走 Webpack 的旧版，跑一次 `npm run build:web:local` |
