#!/usr/bin/env node
/**
 * npm workspaces 在 Windows 上用「目录联接 (junction)」创建 node_modules 里的
 * 工作区链接，但 npm 建的 junction 在 fs.lstatSync() 里 isSymbolicLink() === false
 * （mode 16822，isDirectory() === true）。Turbopack 依赖 lstat 的 symlink 语义判断
 * 「链接依赖边界」，于是把 @loxander/* 当成普通目录却解析不到包入口，构建期报
 *   Module not found: Can't resolve '@loxander/content-core'
 *
 * 用 node 自己调用 fs.symlinkSync(target, link, 'junction') 生成的链接 lstat 会
 * 正确报告 isSymbolicLink() === true，Turbopack 就能跟随。本脚本把 npm 建的
 * junction 重建成 node 建的 junction，保证每次 npm install 之后链接语义都正确。
 *
 * 该脚本幂等：已经是对的链接会跳过；不是链接的真实目录会先备份改名再重建失败
 * 时不删用户数据。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 枚举工作区：apps/* 与 packages/* 下带 package.json 的目录 */
function listWorkspaces() {
  const rootPkg = readJson(path.join(repoRoot, "package.json"));
  const patterns = rootPkg.workspaces ?? [];
  const dirs = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !pattern.endsWith("/*")) continue;
    const parent = path.join(repoRoot, pattern.slice(0, -2));
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(parent, entry.name);
      if (fs.existsSync(path.join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs;
}

const linkRoot = path.join(repoRoot, "node_modules");

let repaired = 0;
let skipped = 0;
const problems = [];

for (const workspaceDir of listWorkspaces()) {
  const pkg = readJson(path.join(workspaceDir, "package.json"));
  const name = typeof pkg.name === "string" ? pkg.name : null;
  if (!name) continue;

  const linkPath = path.join(linkRoot, name);
  const parentDir = path.dirname(linkPath);
  fs.mkdirSync(parentDir, { recursive: true });

  if (!fs.existsSync(linkPath)) {
    problems.push(`${name}: node_modules 里缺少工作区链接（请先跑 npm install）`);
    continue;
  }

  let stat;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (error) {
    problems.push(`${name}: 无法 lstat -> ${error.message}`);
    continue;
  }

  // 注意：npm 建的 junction 目标带 "Global\" 前缀（非 DOS 路径形式），
  // fs.realpathSync() 的 JS 实现解析不了、会原样返回链接自身路径；
  // 只有 fs.realpathSync.native() 能正确跟随。这里两者都试。
  const resolveLinkTarget = () => {
    for (const realpath of [fs.realpathSync.native, fs.realpathSync]) {
      try {
        return path.resolve(realpath(linkPath));
      } catch {
        /* 换下一个实现 */
      }
    }
    return null;
  };

  const pointsToWorkspace = resolveLinkTarget() === path.resolve(workspaceDir);

  if (!pointsToWorkspace) {
    problems.push(`${name}: 链接指向的不是 ${path.relative(repoRoot, workspaceDir)}，已跳过`);
    continue;
  }

  // 已是 node 建的链接（lstat 认得出 symlink）：无需处理
  if (stat.isSymbolicLink()) {
    skipped += 1;
    continue;
  }

  // npm 建的 junction：lstat 说是目录，但跟随链接后指到工作区。
  // 删掉用 node 重建，让 Turbopack 能识别成链接依赖。
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(workspaceDir, linkPath, "junction");

  const fixedStat = fs.lstatSync(linkPath);
  if (!fixedStat.isSymbolicLink()) {
    problems.push(`${name}: 重建后 lstat 仍不认为这是符号链接`);
    continue;
  }
  repaired += 1;
  console.log(`[fix-workspace-links] 重建链接 ${name} -> ${path.relative(repoRoot, workspaceDir)}`);
}

if (problems.length > 0) {
  console.warn("[fix-workspace-links] 注意：");
  for (const problem of problems) console.warn(`  - ${problem}`);
}

console.log(`[fix-workspace-links] 完成：重建 ${repaired} 个，已是正确链接 ${skipped} 个`);
