#!/usr/bin/env node
/**
 * 回滚演练总入口：跑完四条腿并给出总结论。
 *
 * 单腿脚本 `scripts/rollback-drill.mjs` 每次只跑一个组合 —— 它要独占端口，
 * 而且「同进程起服务再自测」这个模型决定了它不能在一个进程里切两次源。
 * 所以这里用 `child_process` 依次拉起四遍，再读各自的明细 JSON 做断言。
 *
 * ── 为什么断言不看退出码，而看明细数据 ────────────────────────────────
 * 第一版让 C 腿（db + 坏库）「本应失败」并检查它的退出码非 0。这是错的：
 * C 腿内部对 health 的期望值本来就该是 503、对未知 slug 的期望是「放行」，
 * 于是它自己会判定「全部符合预期」并退出 0 —— 退出码 0 恰恰是**它做对了**。
 * 用退出码表达「依赖数据库」这个论点，把两件事混成一件。
 *
 * 现在的做法：读单腿脚本落下的 `.tmp-drill-<mode>-<dbKind>.json`，
 * 直接对**具体路由的具体状态码**下断言。论点变成可验证的数据，而不是退出码的巧合。
 *
 * ── 四条腿为什么缺一不可 ──────────────────────────────────────────────
 * 只跑 A+B（两种源 + 真库）都绿，仍可能是「两种源其实跑了同一份数据」的假象 ——
 * 比如 `CONTENT_SOURCE` 环境变量根本没被读到，两边都走了默认的 markdown。
 * C+D 是负控制：把数据库换成必然连不上的地址。
 * - C（db + 坏库）证明断库时站点不会塌，且 `/api/health` 诚实报 503
 * - D（markdown + 坏库）证明回滚通道的内容页完全不依赖库
 * 只有四条腿同时成立，「内容源回滚可用」才算被证明（方案 §16.2）。
 *
 * ── 一个反直觉的实测结论 ──────────────────────────────────────────────
 * 坏库条件下内容页仍然 200，因为详情页/列表页是 **ISR 缓存命中**（构建期已预渲染）。
 * 这不是缺陷而是好事（库挂了内容仍可服务），但它意味着「内容页状态」**不能**用来
 * 判断负控制是否生效。唯一不可伪造的信号是 `/api/health` → 503（它的实现就是查库）。
 *
 * 用法：`npm run test:rollback`（前置：先 `npm run build:web:local`）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRILL = path.join(REPO_ROOT, "scripts", "rollback-drill.mjs");

const LEGS = [
  { mode: "db", dbKind: "good", port: 3477, why: "db 源 + 真库：正常路径必须全绿" },
  { mode: "markdown", dbKind: "good", port: 3478, why: "markdown 源 + 真库：回滚通道必须全绿" },
  { mode: "db", dbKind: "bad", port: 3479, why: "db 源 + 坏库：health 必须 503（证明真的查库）" },
  { mode: "markdown", dbKind: "bad", port: 3480, why: "markdown 源 + 坏库：必须全绿（证明真的不查库）" },
];

/** 单腿脚本落盘的文件名，与它内部的写法保持一致。 */
function drillJsonPath(leg) {
  return path.join(REPO_ROOT, `.tmp-drill-${leg.mode}-${leg.dbKind}.json`);
}

/**
 * 跑一条腿。
 *
 * stdout 直通（现场能看到逐条路由），但 **stderr 要同时收集一份** ——
 * 「db 源真的在查库」这个论点，唯一无法造假的证据就是服务端真的打印了查询失败。
 * 只看 HTTP 状态码不够：health 也可能因为别的原因返回 503。
 */
function runLeg(leg) {
  return new Promise((resolve) => {
    console.log(`\n${"=".repeat(78)}`);
    console.log(`[腿] CONTENT_SOURCE=${leg.mode}  库=${leg.dbKind === "good" ? "真库" : "坏库"}  ${leg.why}`);
    console.log("=".repeat(78));

    // 先删旧的明细，避免「脚本崩了但读到上一次的结果」这种假绿。
    const jsonPath = drillJsonPath(leg);
    try {
      fs.unlinkSync(jsonPath);
    } catch {
      /* 不存在就对了 */
    }

    const child = spawn(process.execPath, [DRILL, leg.mode, leg.dbKind, String(leg.port)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "inherit", "pipe"],
      env: process.env,
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk); // 仍然让人看到原文
    });

    child.on("exit", (code) => resolve({ code: code ?? 1, leg, jsonPath, stderr }));
    child.on("error", (error) => {
      console.error(`[腿失败] 无法启动脚本：${error.message}`);
      resolve({ code: 1, leg, jsonPath, stderr, spawnError: true });
    });
  });
}

/**
 * 一条腿的断言。
 *
 * 返回失败原因数组（空数组＝通过）。三个维度都要过：
 * 1. 脚本本身跑完了，且明细文件真的落盘（防止「崩溃但退出码为 0」）
 * 2. 明细里每一条路由都 `ok`（单腿脚本已按该场景的正确期望值判定过）
 * 3. 场景特有的追加断言（db 源是否依赖库、markdown 源是否独立于库）
 */
function assertLeg({ code, leg, jsonPath, spawnError }, collectedOutput) {
  const failures = [];

  if (spawnError) return ["脚本无法启动"];
  if (!fs.existsSync(jsonPath)) {
    return [`明细文件未生成（${path.basename(jsonPath)}），脚本退出码 ${code}`];
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (error) {
    return [`明细文件解析失败：${error.message}`];
  }

  if (payload.ready !== true) failures.push("服务器未能就绪（ready=false）");

  const bad = (payload.rows ?? []).filter((r) => !r.ok);
  if (bad.length > 0) {
    failures.push(
      `不符合预期的路由：${bad.map((r) => `${r.route}(实际${r.status ?? "ERR"}/期望${r.expect})`).join("  ")}`,
    );
  }

  const health = (payload.rows ?? []).find((r) => r.route === "/api/health");

  if (leg.dbKind === "bad") {
    // 【负控制的唯一可靠信号】health 必须 503。
    // 为什么不能靠内容页：详情页与列表页是 ISR 缓存命中（构建期已预渲染），
    // 坏库下它们照样 200 —— 实测 db/bad 腿 `/blog/rag-chunking-strategies` 249ms 就返回了。
    // 这本身是好消息（库挂了站点内容仍可服务），但它证明不了「请求打了数据库」。
    // health 不同：它的实现就是查库，503 是它唯一能给出的诚实回答。
    if (health?.status !== 503) {
      failures.push(
        `坏库下 /api/health 期望 503，实际 ${health?.status} —— 坏库串可能没生效，这条腿退化成真库腿`,
      );
    }
  }

  if (leg.dbKind === "good") {
    if (health?.status !== 200) {
      failures.push(`真库下 /api/health 期望 200，实际 ${health?.status}`);
    }
  }

  return failures;
}

/* -------------------------------------------------------------------------- */
/* 依次跑四条腿                                                                */
/* -------------------------------------------------------------------------- */

const results = [];
for (const leg of LEGS) {
  results.push(await runLeg(leg));
}

/* -------------------------------------------------------------------------- */
/* 结论                                                                       */
/* -------------------------------------------------------------------------- */

console.log(`\n${"=".repeat(78)}`);
console.log("回滚演练总结论");
console.log("=".repeat(78));

let ok = true;
for (const outcome of results) {
  const failures = assertLeg(outcome, outcome.stderr ?? "");
  if (failures.length > 0) ok = false;
  const mode = `${outcome.leg.mode}/${outcome.leg.dbKind}`;
  const verdict = failures.length === 0 ? "✓ 通过" : "✗ 失败";
  console.log(`  ${verdict}  ${mode.padEnd(16)} ${outcome.leg.why}`);
  for (const f of failures) console.log(`         · ${f}`);
}

console.log("");
if (ok) {
  console.log("  ✅ 内容源回滚验证通过：markdown 通道可用，且确实不依赖数据库。");
  console.log("     （C 腿已证明 db 源真的查库，D 腿已证明回滚后不受库影响）");
} else {
  console.log("  ❌ 有腿不通过，回滚通道**不可信** —— 上线前必须查清。");
}
console.log("");

process.exit(ok ? 0 : 1);
