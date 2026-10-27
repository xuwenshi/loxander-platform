# 在桌面创建「运维台」快捷方式。
#
# 为什么要这个脚本而不是手工右键新建：
#   快捷方式的 Target 必须是 node.exe 的绝对路径 + open-ops.mjs 的绝对路径，
#   WorkingDirectory 必须是仓库根（脚本按 cwd 推 REPO_ROOT 的地方虽然用的是 import.meta.url，
#   但 next-local-build / next-local-start 子进程都用 cwd），
#   图标要指到 scripts/ops.ico。这些路径一旦手抄错就静默失败。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/create-ops-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/create-ops-shortcut.ps1 -Name '运维台' -Port 3210
#
# 需要写桌面（workspace 之外）→ 沙箱下需要更宽权限。

[CmdletBinding()]
param(
    [string]$Name = '运维台',
    [int]$Port = 3210,
    [string]$IconPath,
    [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$NodeExe = (Get-Command node -ErrorAction Stop).Source
$Entry = Join-Path $PSScriptRoot 'open-ops.mjs'
if (-not (Test-Path $Entry)) { throw "找不到入口脚本：$Entry" }

if (-not $IconPath) {
    $IconPath = Join-Path $PSScriptRoot 'ops.ico'
}
if (-not (Test-Path $IconPath)) { throw "找不到图标：$IconPath（先跑 python scripts/make-ops-icon.py scripts/ops.ico）" }

$Desktop = [Environment]::GetFolderPath('Desktop')
$LinkPath = Join-Path $Desktop "$Name.lnk"

# 目标 node.exe，参数是入口脚本 + 端口。路径含空格时必须自带引号。
$Arguments = '"{0}" --port {1}' -f $Entry, $Port

Write-Host "仓库根     : $RepoRoot"
Write-Host "node       : $NodeExe"
Write-Host "入口       : $Entry"
Write-Host "图标       : $IconPath"
Write-Host "快捷方式   : $LinkPath"
Write-Host "参数       : $Arguments"

if ($WhatIfOnly) {
    Write-Host '(WhatIfOnly，不实际写入)'
    return
}

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($LinkPath)
$Shortcut.TargetPath = $NodeExe
$Shortcut.Arguments = $Arguments
$Shortcut.WorkingDirectory = $RepoRoot
$Shortcut.IconLocation = "$IconPath,0"
$Shortcut.Description = "打开本地运维台（http://localhost:$Port/admin/ops）"
# 1 = 常规窗口。选常规而不是最小化：整个过程 2~4 秒，窗口里能看到
# 「服务就绪 → 已在默认浏览器打开」，失败时也能看到报错；窗口关掉服务仍在后台跑。
$Shortcut.WindowStyle = 1
$Shortcut.Save()

if (-not (Test-Path $LinkPath)) { throw "创建后仍找不到 $LinkPath" }

$Check = $Shell.CreateShortcut($LinkPath)
Write-Host ''
Write-Host '已创建。回读校验：'
Write-Host "  TargetPath       = $($Check.TargetPath)"
Write-Host "  Arguments        = $($Check.Arguments)"
Write-Host "  WorkingDirectory = $($Check.WorkingDirectory)"
Write-Host "  IconLocation     = $($Check.IconLocation)"
Write-Host "  WindowStyle      = $($Check.WindowStyle)"
Write-Host "  文件大小         = $((Get-Item $LinkPath).Length) B"
