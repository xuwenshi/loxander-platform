/**
 * 生产切换：把 loxander.is-a.dev 从旧项目 blog 移到新项目 loxander-platform。
 *
 * ## 为什么是「切换 + 立即验证 + 失败自动回滚」
 * 本机网络对 `*.vercel.app` 完全不通（DNS 污染；cloudflare/google 的 DoH 全超时，
 * 阿里 DoH 返回的 74.86.17.48 是污染 IP，直连 ECONNRESET；r.jina.ai / allorigins
 * 等外部抓取服务也不可达）。唯一能从这台机器访问的域名就是 loxander.is-a.dev 本身，
 * 而它只能指向一个项目。所以无法「先验证新部署再切换」，只能切完立刻验、不对就回滚。
 *
 * ## 为什么必须先做「账号级域名验证」（2026-10-26 事故的直接教训）
 * 第一次尝试直接 `DELETE 旧项目域名 → POST 新项目域名`，结果：
 *   - 删除后重新添加，Vercel **丢掉了原来的验证状态**（verified=false）
 *   - 线上立刻从旧站变成 `DEPLOYMENT_NOT_FOUND`（107B 的 404），持续约 12 分钟
 *   - 恢复方式：`POST /v5/domains` 把它建成**账号级域名**，A 记录已指向 Vercel
 *     就能通过 http-01 自动验证，verified 立刻变 true，旧站恢复
 * 所以现在的流程强制要求：切换前域名必须是**账号级已验证域名**（`GET /v5/domains`
 * 里能看到且 verified=true）。账号级验证与项目绑定无关，删了再加不会丢。
 *
 * ## 回滚锚点（切换前实测记录）
 *   旧项目 blog   id = prj_Aqm2Pq5Bv8qNElgdvyjnTT5UBeKM
 *   旧生产部署    id = dpl_HtviPiobkMyt1XgdCxjPqjae7Qib
 *   旧部署 URL    https://blog-892m3gs3l-xuwenshi.vercel.app
 *   旧部署 commit 3ab15d3d98f323dcd3877a2f648b0a63a40e61f9
 *
 * 用法：node scripts/switch-production.mjs [--dry-run] [--to-new|--to-old]
 *   --to-new  切到新项目（默认）
 *   --to-old  切回旧项目（回滚）
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const TO_OLD = argv.includes("--to-old");

const DOMAIN = "loxander.is-a.dev";
const TEAM = "team_GKAxcCY8aSK9eaIToYq2ivOJ";
const NEW_PROJECT = "prj_KWTawHY3hEuOuBEEFbp8NjAAtayf";
const NEW_PROJECT_NAME = "loxander-platform";
const OLD_PROJECT = "prj_Aqm2Pq5Bv8qNElgdvyjnTT5UBeKM";
const OLD_PROJECT_NAME = "blog";
const OLD_DEPLOYMENT = "dpl_HtviPiobkMyt1XgdCxjPqjae7Qib";

/** 目标 / 来源项目按方向对调。 */
const TARGET = TO_OLD ? OLD_PROJECT : NEW_PROJECT;
const TARGET_NAME = TO_OLD ? OLD_PROJECT_NAME : NEW_PROJECT_NAME;
const SOURCE = TO_OLD ? NEW_PROJECT : OLD_PROJECT;
const SOURCE_NAME = TO_OLD ? NEW_PROJECT_NAME : OLD_PROJECT_NAME;

/**
 * 冒烟清单。两个方向期望值不同：
 *   切到新站 → 新站独有的路由必须存在（旧站全是 404）
 *   切回旧站 → 只需核心页面活着，新站独有路由必须 404（这才是「旧站」的样子）
 */
const SMOKE_TO_NEW = [
  { path: "/api/health", expect: (s) => s === 200, why: "健康检查接口只有新站才有" },
  { path: "/search", expect: (s) => s === 200, why: "P5 搜索页只有新站才有" },
  { path: "/tags", expect: (s) => s === 200, why: "P5 标签页只有新站才有" },
  { path: "/login", expect: (s) => s === 200, why: "P4 登录页只有新站才有" },
  { path: "/admin", expect: (s) => s === 307 || s === 302, why: "后台守卫必须重定向到登录页" },
  { path: "/rss.xml", expect: (s) => s === 200, why: "P3 动态 RSS 只有新站才有" },
  { path: "/blog", expect: (s) => s === 200, why: "核心页面不能挂" },
  { path: "/blog/rag-chunking-strategies", expect: (s) => s === 200, why: "详情页不能挂" },
  { path: "/blog/this-slug-does-not-exist", expect: (s) => s === 404, why: "不存在的 slug 必须真 404" },
];
const SMOKE_TO_OLD = [
  { path: "/", expect: (s) => s === 200, why: "首页不能挂" },
  { path: "/blog", expect: (s) => s === 200, why: "核心页面不能挂" },
  { path: "/projects", expect: (s) => s === 200, why: "核心页面不能挂" },
  { path: "/diary", expect: (s) => s === 200, why: "核心页面不能挂" },
  { path: "/goals", expect: (s) => s === 200, why: "核心页面不能挂" },
  { path: "/universe", expect: (s) => s === 200, why: "核心页面不能挂" },
  { path: "/api/health", expect: (s) => s === 404, why: "旧站没有健康检查接口" },
  { path: "/search", expect: (s) => s === 404, why: "旧站没有搜索页" },
];
const SMOKE = TO_OLD ? SMOKE_TO_OLD : SMOKE_TO_NEW;

const authPath = path.join(homedir(), "AppData", "Roaming", "com.vercel.cli", "Data", "auth.json");
const { token } = JSON.parse(readFileSync(authPath, "utf8"));

async function api(method, url, body) {
  const res = await fetch(`https://api.vercel.com${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 响应（网关错误页），保留原文供报错
  }
  return { status: res.status, json, text: text.slice(0, 800) };
}

const log = (msg) => console.log(msg);

/** 等域名真正绑定到目标项目。 */
async function waitDomainBound(projectId, shouldExist) {
  for (let i = 0; i < 20; i += 1) {
    const res = await api("GET", `/v9/projects/${projectId}/domains?teamId=${TEAM}`);
    const found = (res.json?.domains ?? []).find((d) => d.name === DOMAIN);
    if (shouldExist ? found : !found) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/** 用本机唯一可用的通道（公网域名）做冒烟。 */
async function smoke() {
  const rows = [];
  for (const route of SMOKE) {
    const t0 = Date.now();
    // 网络在本机很抖（实测首页出现过 35s 超时），每条给 35s 并允许一次重试
    let row = null;
    for (let attempt = 1; attempt <= 2 && row === null; attempt += 1) {
      try {
        const res = await fetch(`https://${DOMAIN}${route.path}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(35_000),
        });
        const body = await res.arrayBuffer();
        row = {
          path: route.path,
          status: res.status,
          bytes: body.byteLength,
          ms: Date.now() - t0,
          cache: res.headers.get("x-vercel-cache") ?? "-",
          vercelError: res.headers.get("x-vercel-error") ?? "-",
          ok: route.expect(res.status),
          why: route.why,
        };
      } catch (error) {
        if (attempt === 2) {
          row = {
            path: route.path,
            status: 0,
            bytes: 0,
            ms: Date.now() - t0,
            cache: "-",
            vercelError: "-",
            ok: false,
            why: `${route.why}（请求失败：${error.cause?.code ?? error.name}）`,
          };
        } else {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

function printSmoke(rows, title) {
  log(`\n=== ${title} ===`);
  for (const r of rows) {
    const mark = r.ok ? "✓" : "✗";
    log(`  ${mark} ${r.path.padEnd(34)} ${String(r.status).padStart(4)}  ${String(r.bytes).padStart(8)}B  ${String(r.ms).padStart(6)}ms  cache=${r.cache}  err=${r.vercelError}`);
    if (!r.ok) log(`      期望不满足：${r.why}`);
  }
  const pass = rows.filter((r) => r.ok).length;
  log(`  ---- ${pass}/${rows.length} 通过 ----`);
  return pass === rows.length;
}

/** 把域名移回指定项目（回滚用）。 */
async function moveDomainTo(projectId, projectName) {
  log(`\n  从 ${SOURCE_NAME} 移除 …`);
  const rm = await api("DELETE", `/v9/projects/${SOURCE}/domains/${DOMAIN}?teamId=${TEAM}`);
  log(`     -> HTTP ${rm.status}${rm.status >= 400 ? `  ${rm.text}` : ""}`);
  log(`  添加到 ${projectName} …`);
  const add = await api("POST", `/v9/projects/${projectId}/domains?teamId=${TEAM}`, { name: DOMAIN });
  log(`     -> HTTP ${add.status}${add.status >= 400 ? `  ${add.text}` : ""}`);
  if (add.status >= 400) return false;
  // 账号级已验证域名重新绑定后可能仍显示未验证，主动触发一次
  if (add.json?.verified === false) {
    log(`     verified=false，触发账号级域名验证 …`);
    await api("POST", `/v5/domains/${DOMAIN}/verify?teamId=${TEAM}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  const check = await api("GET", `/v9/projects/${projectId}/domains/${DOMAIN}?teamId=${TEAM}`);
  log(`     最终 verified=${check.json?.verified}`);
  return check.json?.verified === true;
}

// ---------------------------------------------------------------- 主流程

log(`方向：${TO_OLD ? "回滚到旧项目" : "切换到新项目"}`);
log(`域名：${DOMAIN}`);
log(`目标项目：${TARGET_NAME} (${TARGET})`);
log(`来源项目：${SOURCE_NAME} (${SOURCE})`);
if (DRY_RUN) log("\n*** DRY RUN：只读检查，不做任何变更 ***");

// 0a) 前置检查：域名必须是账号级已验证域名（否则删了再加会丢验证状态）
const acct = await api("GET", `/v5/domains?teamId=${TEAM}`);
const acctDomain = (acct.json?.domains ?? []).find((d) => d.name === DOMAIN);
if (!acctDomain) {
  log("\n✗ 前置检查失败：域名不是账号级域名。删了再加会丢失验证状态并导致线上 404。");
  log("   先执行：POST /v5/domains { name } 把它建成账号级域名（A 记录已指向 Vercel 会自动验证）。");
  process.exit(1);
}
if (acctDomain.verified !== true) {
  log(`\n✗ 前置检查失败：账号级域名 verified=${acctDomain.verified}，必须先验证通过。`);
  process.exit(1);
}
log(`\n✓ 前置检查：账号级域名 ${DOMAIN} 已验证`);

// 0b) 前置检查：目标项目必须有 READY 的 production 部署
const deps = await api("GET", `/v6/deployments?projectId=${TARGET}&teamId=${TEAM}&limit=1&target=production`);
const latest = deps.json?.deployments?.[0];
if (!latest || latest.state !== "READY") {
  log(`\n✗ 前置检查失败：${TARGET_NAME} 没有 READY 的生产部署（state=${latest?.state ?? "none"}）。中止。`);
  process.exit(1);
}
log(`✓ 前置检查：${TARGET_NAME} 最新生产部署 ${latest.uid} 状态 READY`);

// 1) 记录切换前状态
const beforeSource = await api("GET", `/v9/projects/${SOURCE}/domains?teamId=${TEAM}`);
const beforeTarget = await api("GET", `/v9/projects/${TARGET}/domains?teamId=${TEAM}`);
log("\n=== 切换前 ===");
log(`  ${SOURCE_NAME}：${(beforeSource.json?.domains ?? []).map((d) => d.name).join(", ") || "(无)"}`);
log(`  ${TARGET_NAME}：${(beforeTarget.json?.domains ?? []).map((d) => d.name).join(", ") || "(无)"}`);

if (DRY_RUN) {
  log("\n*** DRY RUN 结束，未做任何变更 ***");
  process.exit(0);
}

// 2) 先切域名（先删后加，因为 Vercel 不允许同一域名同时在两个项目）
log(`\n[1/4] 从 ${SOURCE_NAME} 移除 ${DOMAIN} …`);
const rm = await api("DELETE", `/v9/projects/${SOURCE}/domains/${DOMAIN}?teamId=${TEAM}`);
log(`   -> HTTP ${rm.status}${rm.status >= 400 ? `  ${rm.text}` : ""}`);
if (rm.status >= 400) {
  log("✗ 移除失败，中止（线上仍是原站，无影响）。");
  process.exit(1);
}

log(`\n[2/4] 添加到 ${TARGET_NAME} …`);
const add = await api("POST", `/v9/projects/${TARGET}/domains?teamId=${TEAM}`, { name: DOMAIN });
log(`   -> HTTP ${add.status}${add.status >= 400 ? `  ${add.text}` : ""}`);
if (add.status >= 400) {
  log("✗ 添加失败，立即把域名移回来源项目 …");
  const back = await moveDomainTo(SOURCE, SOURCE_NAME);
  log(back ? "   回滚成功。" : "   ⚠️ 回滚也失败了，需要人工介入！");
  process.exit(1);
}

// 3) 确保 verified=true（账号级域名重新绑定后可能短暂显示 false）
if (add.json?.verified === false) {
  log(`   verified=false，触发账号级域名验证 …`);
  await api("POST", `/v5/domains/${DOMAIN}/verify?teamId=${TEAM}`);
  await new Promise((r) => setTimeout(r, 4000));
}
const bound = await waitDomainBound(TARGET, true);
const check = await api("GET", `/v9/projects/${TARGET}/domains/${DOMAIN}?teamId=${TEAM}`);
const verified = check.json?.verified === true;
log(`\n[3/4] 域名绑定：${bound ? "已归属目标项目" : "等待超时"}；verified=${verified}`);
if (!verified) {
  log("\n✗ 域名未通过验证（线上会返回 DEPLOYMENT_NOT_FOUND）。立即回滚 …");
  const back = await moveDomainTo(SOURCE, SOURCE_NAME);
  log(back ? "   已回滚，线上恢复原站。" : "   ⚠️ 回滚也失败了，需要人工介入！");
  process.exit(1);
}

// 4) 冒烟验证
log(`\n[4/4] 冒烟验证 https://${DOMAIN} …`);
let rows = await smoke();
let allOk = printSmoke(rows, "第一次冒烟");

if (!allOk) {
  log("\n有项目不通过，等 10 秒后复测一次（排除冷启动与 CDN 传播）。");
  await new Promise((r) => setTimeout(r, 10_000));
  rows = await smoke();
  allOk = printSmoke(rows, "第二次冒烟");
}

if (allOk) {
  log(`\n✅ 切换成功：https://${DOMAIN} 现在是 ${TARGET_NAME}。`);
  log(`   目标部署：${latest.uid}`);
  log(`   回滚方式：node scripts/switch-production.mjs ${TO_OLD ? "" : "--to-old"}`.trim());
  process.exit(0);
}

// 5) 自动回滚
log("\n✗ 冒烟未通过，执行自动回滚 …");
const back = await moveDomainTo(SOURCE, SOURCE_NAME);
if (!back) {
  log("\n⚠️ 回滚失败，需要人工介入！域名当前归属需立即检查。");
  process.exit(1);
}
const afterRows = await smoke();
printSmoke(afterRows, "回滚后复测");
log("\n⚠️ 已回滚，线上已恢复原站。切换未完成，需排查上面的失败项。");
process.exit(1);
