/**
 * P7 软 404 修复的离线验证。
 *
 * ── 被验的缺陷 ────────────────────────────────────────────────────────
 * 生产构建（`next build` + `next start`，端口 3310）实测：
 * ```
 * 首次请求（冷）  200  /blog/nope-xxx-a   noindex=Y  x-nextjs-cache=-
 * 二次请求（热）  404  /blog/nope-xxx-a   noindex=Y  x-nextjs-cache=HIT
 * ```
 * 四个详情页前缀全部复现；旧站（`https://loxander.is-a.dev`）对同样路径全部 404。
 *
 * 根因见 `lib/proxy-rules.ts` 文件头（Next 官方 `not-found.md:193`
 * 「The response starts streaming from the `<Suspense>` boundary before
 * `notFound()` runs, so it keeps its `200` status.」）。
 *
 * ── 这个文件验什么 ────────────────────────────────────────────────────
 * 1. **规则层**（`lib/proxy-rules.ts`，纯函数）：哪些路径需要做存在性检查、
 *    返回的检查目标对不对。这部分能直接跑，穷举所有形态。
 * 2. **接线层**（`proxy.ts`，靠源码断言）：rewrite 到 `/_not-found` 这一步
 *    真的接上了、且顺序正确（旧链接 301 优先于 404 判空）。
 *
 * 为什么接线层不做成真调用：`proxy.ts` 依赖 `next/server` 的 `NextResponse` /
 * `NextRequest`，而 `next/package.json` 没有 `exports` 字段，纯 node 里
 * `import("next/server")` 直接 `ERR_MODULE_NOT_FOUND`。伪造一个 NextResponse
 * 去测，测的是桩而不是代码。真实行为由 P7 的生产构建 HTTP 验收
 * （`.tmp-p7-http.mjs`，54 条）覆盖 —— 那是本缺陷被发现的地方。
 *
 * 跑法：`node --test-isolation=none apps/web/src/lib/__tests__/p7-proxy-rules.test.ts`
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_DIR = resolvePath(SRC_DIR, "..");
const REPO_DIR = resolvePath(WEB_DIR, "..", "..");

const SERVER_ONLY_EMPTY = resolvePath(REPO_DIR, "node_modules/server-only/empty.js");
const NEXT_CACHE_STUB = resolvePath(SRC_DIR, "lib/sources/__tests__/next-cache-stub.ts");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: pathToFileURL(SERVER_ONLY_EMPTY).href, shortCircuit: true };
    }
    if (specifier === "next/cache") {
      return { url: pathToFileURL(NEXT_CACHE_STUB).href, shortCircuit: true };
    }

    if (specifier.startsWith("@/")) {
      const base = resolvePath(SRC_DIR, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(base + ext)) {
          return { url: pathToFileURL(base + ext).href, shortCircuit: true };
        }
      }
      if (existsSync(base)) return { url: pathToFileURL(base).href, shortCircuit: true };
    }

    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const isRelative =
        specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:");
      if (!isRelative) throw error;
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
      const bare = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
      const target = resolvePath(dirname(parent), bare);
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(target + ext)) {
          return { url: pathToFileURL(target + ext).href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
});

const rules = await import("../proxy-rules");

/**
 * 剥注释，**等长空白替换**（保留换行，行号不漂）。
 *
 * 为什么必须剥：`proxy.ts` 的注释里大段写着 `/_not-found`、`notFound()`、
 * `NextResponse.rewrite` 这些词。不剥注释，下面每一条 `assert.match` 都会被
 * 注释本身喂饱 —— 这正是 P6 闸门矩阵报告里 `P6-A3` 空转的同一类问题
 * （「词在任何地方出现一次就绿」）。
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let k = i; k < stop; k += 1) out += source[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }

    // 行注释：只有 `//` 前面不是 `:` 时才算（挡 `https://`）。
    if (ch === "/" && next === "/" && source[i - 1] !== ":") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      for (let k = i; k < stop; k += 1) out += " ";
      i = stop;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

const PROXY_SOURCE = stripComments(
  await import("node:fs").then((fs) =>
    fs.readFileSync(resolvePath(SRC_DIR, "proxy.ts"), "utf8"),
  ),
);

/**
 * `sources/db.ts` 的源码（同样剥注释）。
 *
 * 只给 P7-W9 用：那条守的是「`loadRows` 不许无参 `db.select()`」，
 * 属于读路径的性能约束，与 proxy 无关，但同属 P7 收口时发现的问题，
 * 放在这个文件里比新开一个只含一条断言的测试文件更好维护
 * （新文件要再复制一遍 60 行的 `registerHooks` 与路径常量）。
 */
const DB_SOURCE = stripComments(
  await import("node:fs").then((fs) =>
    fs.readFileSync(resolvePath(SRC_DIR, "lib/sources/db.ts"), "utf8"),
  ),
);

/* ========================================================================== */
/* 1. 规则层：parseProbeablePath                                              */
/* ========================================================================== */

/**
 * 探针结果的非空类型。
 *
 * `rules` 是 `await import()` 出来的**值**，不是类型命名空间，所以不能写
 * `rules.PageProbe`（TS2503）。从函数签名反推是这里最省事的写法。
 */
type PageProbeShape = NonNullable<ReturnType<typeof rules.parseProbeablePath>>;

/**
 * 取出非空的探针结果。
 *
 * `node:assert` 的 `assert.notEqual(x, null)` **不会**把 `x` 从 `T | null` 收窄成 `T`
 * （它不是 TS 断言函数），直接往下写 `probe.kind` 会报 TS18047。
 * 与其在每处加 `!`，不如集中一个守卫：失败时给出可读消息，成功时返回非空类型。
 */
function expectProbe(value: PageProbeShape | null, pathname: string): PageProbeShape {
  assert.notEqual(value, null, `${pathname} 应当被识别为需要检查的详情页`);
  if (value === null) throw new Error("unreachable");
  return value;
}

test("P7-R1：三个内容详情前缀都识别为 content，且带对正确的 kind", () => {
  for (const kind of ["blog", "diary", "projects"]) {
    const probe = expectProbe(rules.parseProbeablePath(`/${kind}/some-slug`), `/${kind}/some-slug`);
    assert.equal(probe.kind, "content");
    assert.equal(probe.contentType, kind);
    assert.equal(probe.value, "some-slug");
  }
});

test("P7-R2：/tags/<tag> 识别为 tag，value 是未解码的路由段", () => {
  const probe = expectProbe(rules.parseProbeablePath("/tags/llm"), "/tags/llm");
  assert.equal(probe.kind, "tag");
  assert.equal(probe.contentType, undefined, "tag 探针不该带 contentType");
  assert.equal(probe.value, "llm");
});

test("P7-R3：列表页与根路径不检查（它们永远存在，没有 404 概念）", () => {
  for (const pathname of ["/", "/blog", "/diary", "/projects", "/tags", "/search", "/about", "/resume", "/universe"]) {
    assert.equal(
      rules.parseProbeablePath(pathname),
      null,
      `${pathname} 是列表页/静态页，不该进存在性检查（多查一次库纯属浪费）`,
    );
  }
});

test("P7-R4：三段及以上不检查（Next 自己就回真 404，不是软 404）", () => {
  for (const pathname of ["/blog/a/b", "/tags/a/b", "/admin/content/blog/x", "/a/b/c/d"]) {
    assert.equal(
      rules.parseProbeablePath(pathname),
      null,
      `${pathname} 三段以上，没有任何 page 匹配，Next 会直接回真 404 —— proxy 不该插手`,
    );
  }
});

test("P7-R5：尾斜杠、空段、未知名前缀都不检查（正则锁死「恰好两段无尾斜杠」）", () => {
  const cases = [
    "/blog/", // 尾斜杠 + 空段
    "/tags/", // 同上
    "/blog//x", // 中间空段
    "//blog/x", // 前导双斜杠
    "/unknown/x", // 未知前缀（/admin 之类由 guardAdminArea 管）
    "/login/callback", // 不是内容详情
    "/blog", // 一段
    "", // 空路径
  ];
  for (const pathname of cases) {
    assert.equal(rules.parseProbeablePath(pathname), null, `${pathname} 不该被当成详情页`);
  }
});

test("P7-R6：含百分号编码、中文、加号的段原样带出（解码由调用方负责）", () => {
  const encoded = expectProbe(
    rules.parseProbeablePath("/tags/%E5%B7%A5%E7%A8%8B%E5%8C%96"),
    "/tags/%E5%B7%A5%E7%A8%8B%E5%8C%96",
  );
  assert.equal(encoded.kind, "tag");
  assert.equal(
    encoded.value,
    "%E5%B7%A5%E7%A8%8B%E5%8C%96",
    "规则层不做解码 —— 解码必须走 tag-url.ts 的 decodeTagParam（那里有 `+` 顺序问题）",
  );

  const plus = expectProbe(rules.parseProbeablePath("/tags/c%2B%2B"), "/tags/c%2B%2B");
  assert.equal(plus.value, "c%2B%2B");
});

test("P7-R7：常量与页面路由一一对应（防止页面改名后规则悄悄失效）", () => {
  assert.deepEqual(
    [...rules.PROBEABLE_KINDS].sort(),
    ["blog", "diary", "projects"],
    "PROBEABLE_KINDS 必须与 app/(site) 下真实存在的 [slug] 目录一致",
  );
  assert.equal(rules.TAG_SEGMENT, "tags");
  assert.equal(rules.NOT_FOUND_PATH, "/_not-found");
});

test("P7-R8：PROBEABLE_KINDS 每一项在磁盘上真的有对应的 [slug] 页面", () => {
  for (const kind of rules.PROBEABLE_KINDS) {
    const page = resolvePath(SRC_DIR, "app", "(site)", kind, "[slug]", "page.tsx");
    assert.ok(
      existsSync(page),
      `规则说 /${kind}/<slug> 需要做存在性检查，但 ${page} 不存在 —— 规则与页面结构已脱节`,
    );
  }
  const tagPage = resolvePath(SRC_DIR, "app", "(site)", "tags", "[tag]", "page.tsx");
  assert.ok(existsSync(tagPage), `规则说 /tags/<tag> 需要检查，但 ${tagPage} 不存在`);
});

/* ========================================================================== */
/* 2. 接线层：proxy.ts 真的用了它                                             */
/* ========================================================================== */

test("P7-W1：proxy.ts 真的调用了 parseProbeablePath 并 rewrite 到 NOT_FOUND_PATH", () => {
  assert.match(
    PROXY_SOURCE,
    /const\s+probe\s*=\s*parseProbeablePath\(\s*pathname\s*\)/,
    "proxy.ts 没有调用 parseProbeablePath —— 软 404 修复没接上",
  );
  // rewrite 收敛到 notFoundRewrite() 一个函数里（见 P7-W12 的理由），
  // 所以这里断言的是「确认不存在 → 调 notFoundRewrite」，而不是直接内联 rewrite。
  assert.match(
    PROXY_SOURCE,
    /if\s*\(\s*!exists\s*\)\s*\{?\s*return\s+notFoundRewrite\(\s*request\s*\)/,
    "proxy.ts 没有在「确认不存在」时走 notFoundRewrite —— 状态码仍然会是 200",
  );
});

test("P7-W2：404 一律用 rewrite 而不是 redirect（不能变成跳转）", () => {
  const rewriteCalls = PROXY_SOURCE.match(/NextResponse\.rewrite\(/g) ?? [];
  // rewrite 现在只允许出现在 notFoundRewrite() 里（一处），
  // 两个分支都调那个函数。上限 2 是给「以后真需要第二处 rewrite」留的余量，
  // 可怕的是有人把其中一处换成 redirect —— 那由下面的反向断言守。
  assert.ok(
    rewriteCalls.length >= 1 && rewriteCalls.length <= 2,
    `proxy.ts 里 NextResponse.rewrite 应当有 1~2 处，实际 ${rewriteCalls.length}`,
  );

  // 每一处 rewrite 的目标都必须是 NOT_FOUND_PATH —— 不许有人顺手 rewrite 到别处。
  const targets = PROXY_SOURCE.match(/NextResponse\.rewrite\(\s*new\s+URL\(\s*([A-Za-z_$][\w$]*)/g) ?? [];
  assert.equal(targets.length, rewriteCalls.length, "有 rewrite 调用没走 new URL(<常量>, ...) 的形态");
  for (const call of targets) {
    assert.match(call, /NOT_FOUND_PATH$/, `rewrite 目标不是 NOT_FOUND_PATH：${call}`);
  }

  assert.ok(
    !/NextResponse\.redirect\(\s*new\s+URL\(\s*NOT_FOUND_PATH/.test(PROXY_SOURCE),
    "NOT_FOUND_PATH 不能用 redirect —— 那会变成 307/301 跳转，URL 会变，语义全错",
  );
});

test("P7-W12：rewrite 到 404 必须显式带 status: 404（线上软 404 的真根因）", () => {
  /*
   * ── 这条守的是线上真事故 ────────────────────────────────────────────
   * `NextResponse.rewrite(destination)` 不带 init 时底层是
   * `new NextResponse(null, { headers })`，**状态码是默认 200**
   * （`next/dist/server/web/spec-extension/response.js` 的 `static rewrite`）。
   * 而 Next 服务端用 middleware 的 status 当最终状态码
   * （`next/dist/server/lib/router-utils/resolve-routes.js:377`
   * `res.statusCode = middlewareRes.status;`），rewrite 分支不重置它。
   *
   * 本地 `next start` 看不出来 —— `server/base-server.js` 有一条
   * `if (is404Page && ...) res.statusCode = 404;` 会把 200 掰回 404。
   * Vercel 是 minimalMode + PPR，走 `build/templates/app-page-runtime.js`，
   * `/_not-found` 命中预渲染缓存后直接用 200 输出并被 CDN 缓存
   * （实测 `x-nextjs-prerender: 1` + `x-vercel-cache: HIT` + 无 noindex）。
   * 后果：搜索引擎把这些 URL 当正常页面收录。
   *
   * 所以断言「带 status: 404」这件事本身 —— 少了它站点照样能跑、测试照样全绿，
   * 只有上线后拿真实 HTTP 状态码才看得见。这正是最容易在重构中被删掉的那类代码。
   */
  assert.match(
    PROXY_SOURCE,
    /NextResponse\.rewrite\(\s*new\s+URL\(\s*NOT_FOUND_PATH[^)]*\)\s*,\s*\{\s*status\s*:\s*404\s*\}\s*\)/,
    "rewrite 到 NOT_FOUND_PATH 没带 status: 404 —— 线上会变成 200 软 404（Vercel 上 PPR 静态缓存会以 200 服务）",
  );

  // 反向守卫：不许出现「rewrite 到 NOT_FOUND_PATH 但不带 init」的单参数写法。
  const bare = PROXY_SOURCE.match(/NextResponse\.rewrite\(\s*new\s+URL\(\s*NOT_FOUND_PATH[^)]*\)\s*\)/g) ?? [];
  assert.deepEqual(
    bare,
    [],
    `发现不带 status 的 rewrite（线上会 200）：${bare.join(" | ")}`,
  );
});

test("P7-W3：旧链接 301 必须排在 404 判空之前（顺序错了会误杀旧 URL）", () => {
  const redirectIdx = PROXY_SOURCE.indexOf("lookupWithTimeout(");
  const probeIdx = PROXY_SOURCE.indexOf("parseProbeablePath(");
  assert.ok(redirectIdx > 0, "proxy.ts 里找不到 lookupWithTimeout 调用");
  assert.ok(probeIdx > 0, "proxy.ts 里找不到 parseProbeablePath 调用");
  assert.ok(
    redirectIdx < probeIdx,
    "404 判空排在了旧链接跳转之前 —— 一条「旧 URL 指向已归档内容」的重定向会被判成 404，旧链接彻底断掉",
  );
});

test("P7-W4：存在性检查是三态，只有明确的 false 才算不存在（失败/超时一律放行）", () => {
  // probeWithTimeout 的 catch 里必须 return true（＝当作存在）。
  const fnIdx = PROXY_SOURCE.indexOf("async function probeWithTimeout");
  assert.ok(fnIdx > 0, "proxy.ts 里找不到 probeWithTimeout");
  const tail = PROXY_SOURCE.slice(fnIdx, fnIdx + 1600);
  assert.match(
    tail,
    /catch\s*\([^)]*\)\s*\{[\s\S]*?return\s+true;/,
    "probeWithTimeout 的 catch 分支没有 return true —— 查库失败时会把全站详情页判成 404",
  );

  // ⚠️ 这里必须钉住 `result !== false`，不是 `result === true`。
  //
  // 第一版实现写成 `return result === true`，于是「超时」（resolve null）
  // 被当成「不存在」。而 Neon 冷启动实测 4320ms > 探针超时 1000ms，
  // 结果**全部详情页在冷连接窗口内 404**（实测 /blog/rag-chunking-strategies
  // 也 404），比原本的软 404 严重得多 —— 这是 P7 期真实发生过的事故。
  // 三态语义：true=存在 / false=确认不存在 / null=无法判定（超时或没配库）。
  assert.match(
    tail,
    /return\s+result\s*!==\s*false;/,
    "probeWithTimeout 必须是 `result !== false`：把「超时/无法判定」和「确认不存在」混为一谈会让全站详情页在冷连接时 404",
  );
  assert.ok(
    !/return\s+result\s*===\s*true;/.test(tail),
    "probeWithTimeout 不能写成 `result === true` —— 那会把超时当成不存在（P7 期真实事故）",
  );
});

test("P7-W5：存在性检查超时必须盖过 Neon 冷启动（否则冷请求仍会漏判成 200）", () => {
  const probeMatch = /const\s+PROBE_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/.exec(PROXY_SOURCE);
  const lookupMatch = /const\s+LOOKUP_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/.exec(PROXY_SOURCE);
  assert.notEqual(probeMatch, null, "proxy.ts 里没有 PROBE_TIMEOUT_MS 常量");
  assert.notEqual(lookupMatch, null, "proxy.ts 里没有 LOOKUP_TIMEOUT_MS 常量");
  // 同上：assert 不收窄类型，显式守卫（否则 TS18047）。
  if (probeMatch === null || lookupMatch === null) throw new Error("unreachable");

  const probeMs = Number(probeMatch[1].replace(/_/g, ""));
  const lookupMs = Number(lookupMatch[1].replace(/_/g, ""));

  assert.ok(
    probeMs > lookupMs,
    `PROBE_TIMEOUT_MS(${probeMs}) 应比重定向超时(${lookupMs})宽 —— 宁可多等也别误判 404`,
  );

  // ⚠️ 这条上界不能写成 1500。
  //
  // 第一版上界是 `<= 1_500`，配的实现是 1000ms —— 测试全绿，但**软 404 根本没修掉**：
  // Neon 冷启动实测 4320ms，1000ms 探针必然超时 → 放行 → 页面自己 notFound() →
  // 状态码早已定成 200。实测冷请求仍 200、只有热请求才 404。
  // 所以下界必须高于冷启动实测值（4320ms），给到 5000ms。
  assert.ok(
    probeMs >= 4_500,
    `PROBE_TIMEOUT_MS(${probeMs}) 低于 Neon 冷启动实测 4320ms —— 冷请求会探针超时后放行，软 404 复发`,
  );
  assert.ok(
    probeMs <= 8_000,
    `PROBE_TIMEOUT_MS(${probeMs}) 太长，它会直接加在冷连接时每个详情页的首字节时间上`,
  );
});

test("P7-W6：标签存在性检查必须按 tags.name 且限定 kind='blog'（与页面判据一致）", () => {
  const fnIdx = PROXY_SOURCE.indexOf("async function probePageExists");
  assert.ok(fnIdx > 0, "proxy.ts 里找不到 probePageExists");
  const tail = PROXY_SOURCE.slice(fnIdx, fnIdx + 3000);

  assert.match(
    tail,
    /lower\(t\.name\)\s*=\s*\$\{/,
    "标签存在性检查必须用 lower(t.name)：页面侧 getAllTags() 统计的是 tags.name，用 t.slug 会错配",
  );
  assert.ok(
    !/lower\(t\.slug\)/.test(tail),
    "不能用 t.slug —— db/mapping.ts 的 tagSlugOf() 是恒等函数，slug 存的是标签原文，与 URL 归一化规则不同源",
  );
  assert.match(
    tail,
    /e\.kind\s*=\s*'blog'/,
    "标签存在性必须限定 e.kind='blog' —— getAllTags() 只统计 blog 文章上的标签",
  );
});

test("P7-W7：内容存在性检查必须按 (kind, slug) 双条件（不能只按 slug）", () => {
  const fnIdx = PROXY_SOURCE.indexOf("async function probePageExists");
  const tail = PROXY_SOURCE.slice(fnIdx, fnIdx + 3000);
  assert.match(
    tail,
    /from\s+entries\s+where\s+kind\s*=\s*\$\{[^}]*\}\s+and\s+slug\s*=\s*\$\{/,
    "内容存在性必须同时按 kind 与 slug 查 —— 只按 slug 会让 /blog/xxx 在 diary 有同名 slug 时误判为存在",
  );
});

test("P7-W8：生产环境下存在性检查必须只认 published（否则草稿 URL 会 200 泄漏）", () => {
  const fnIdx = PROXY_SOURCE.indexOf("async function probePageExists");
  const tail = PROXY_SOURCE.slice(fnIdx, fnIdx + 3000);
  assert.match(
    tail,
    /const\s+publishedOnly\s*=\s*process\.env\.NODE_ENV\s*===\s*"production"/,
    "缺少 publishedOnly 判据 —— 生产环境会把草稿/归档内容的 URL 判成「存在」",
  );
  const guards = tail.match(/publish_status\s*=\s*'published'/g) ?? [];
  assert.ok(guards.length >= 2, `content 与 tag 两条 SQL 都要有 published 过滤，实际命中 ${guards.length} 处`);
});

/* -------------------------------------------------------------------------- */
/* P7-W9：读路径不得整表取列（性能闸门）                                        */
/* -------------------------------------------------------------------------- */

/**
 * 这条守的是一个**性能**缺陷，不是功能缺陷 —— 所以它单独成组，且写清来龙去脉。
 *
 * ── 缺陷 ──────────────────────────────────────────────────────────────
 * P7 收口时用 Playwright 做真实浏览器验收，发现 `/search` 表单提交后要
 * **8–12 秒**才出结果。逐步测量后定位到 `sources/db.ts` 的 `loadRows()`：
 * 它写的是无参 `db.select().from(entries)`，会把 `entries` 的**全部列**取回来，
 * 而 `body_html` 是这份数据里最宽的一列。
 *
 * Neon 主分支 10 行数据的实测列宽：
 * ```
 * body_md    合计  24 051 B
 * body_html  合计 132 042 B   ← 5.5 倍，单行最大 34 874 B
 * ```
 * 而本文件**从不读 `body_html`**（读路径一律从 `body_md` 重渲染）。
 *
 * 同一查询的实测耗时（kind='blog' 的 4 行）：
 * ```
 * select * from entries where kind='blog'      11 069 ms
 * 显式列（不含 body_html）                       1 316 ms
 * ```
 *
 * 为什么偏偏是 `/search` 受害最重：按方案 §14.2，搜索是「动态查询」，
 * `searchPosts()` 刻意不套 `"use cache"` —— 列表页付一次，搜索**每次请求都付**。
 *
 * ── 为什么这条必须用源码断言而不是行为断言 ────────────────────────────
 * 行为断言只能测「耗时」，而耗时依赖网络与 Neon 冷热状态，天生不稳定
 * （同一查询在本机实测 1.3s–11s 之间浮动）。但**「有没有多取一列」是确定的**，
 * 用源码断言可以零成本、零抖动地钉死。
 *
 * 反向变异（已验证）：把 `loadRows` 里的显式列换回无参 `db.select()` → 本条变红。
 */
test("P7-W9：loadRows 必须显式列名，不得无参 db.select()（body_html 合计 132KB 是白拉的）", () => {
  const dbSourceIdx = DB_SOURCE.indexOf("async function loadRows");
  assert.ok(dbSourceIdx > 0, "sources/db.ts 里找不到 loadRows");
  const tail = DB_SOURCE.slice(dbSourceIdx, dbSourceIdx + 2500);

  assert.ok(
    !/\.select\(\)\s*\.from\(entries\)/.test(tail),
    "loadRows 里出现了无参 db.select().from(entries) —— 它会把 body_html（合计 132KB、单行最大 34KB）一并取回，" +
      "而本文件从不读它。实测同一查询 11 069ms vs 1 316ms，/search 每次请求都付这笔钱",
  );

  // 正向：必须能看到显式列清单，且清单里包含真正需要的几个宽列/关键列。
  assert.match(tail, /\.select\(\{/, "loadRows 必须显式列出要取的列");
  for (const column of ["id", "slug", "body_md", "publish_status", "data"]) {
    assert.match(
      tail,
      new RegExp(`\\b${column}\\s*:\\s*entries\\.${column}\\b`),
      `loadRows 的显式列清单里缺少 ${column}`,
    );
  }

  // 反向：显式清单里**不许**出现 body_html。
  assert.ok(
    !/body_html\s*:\s*entries\.body_html/.test(tail),
    "loadRows 的列清单里出现了 body_html —— 本文件从不读它，加了就等于把 132KB 又拉回来",
  );
});

/* ========================================================================== */
/* 4. 回滚通道：markdown 源软 404（P7 收口发现的第二个真缺陷）                  */
/* ========================================================================== */

/**
 * 背景（实测证据，勿删）：
 *
 * P7 修好 db 源软 404 后，回滚演练 B 腿（`CONTENT_SOURCE=markdown` + 真库）
 * 只有 12/13 —— `/blog/this-slug-does-not-exist` 返回 **200**。
 * 影响面测绘（同一份构建产物，只改运行时 `CONTENT_SOURCE`）：
 * ```
 *                                   mode=markdown      mode=db
 * /blog/nope-blog                    200 ✗ 软 404       404 ✓
 * /diary/nope-diary                  200 ✗ 软 404       404 ✓
 * /projects/nope-project             200 ✗ 软 404       404 ✓
 * /tags/nope-tag                     200 ✗ 软 404       404 ✓
 * /totally-unknown-path              404 ✓              404 ✓
 * ```
 * 根因：`proxy.ts` 里 `if (process.env.CONTENT_SOURCE !== "db") return NextResponse.next();`
 * 把整段存在性检查放在 db 分支**之后**，回滚到 markdown 时全部跳过。
 * 而方案 §16.2 明确把 markdown 定为**回滚通道** —— 一条救火通道不该自带 SEO 脏数据。
 *
 * 修法：新增 `lib/proxy-markdown-probe.ts`（只读文件系统，不连库），
 * `proxy.ts` 在 markdown 分支里也做存在性检查。
 */

/**
 * markdown 探针源码，**剥掉注释**。
 *
 * 必须剥：`lib/proxy-markdown-probe.ts` 的文件头注释里，为了解释「为什么不复用
 * `lib/posts.ts`」而明确写了 `@loxander/markdown` 这个词。不剥注释的话，
 * 下面那条「不许导入 markdown 管线」的反向断言会被注释本身喂饱 —— 这正是
 * P6 闸门矩阵报告里记录过的同类空转（「词在任何地方出现一次就绿」）。
 */
const MARKDOWN_PROBE_SOURCE = stripComments(
  readFileSync(resolvePath(SRC_DIR, "lib/proxy-markdown-probe.ts"), "utf8"),
);

test("P7-R9：markdown 分支必须也做存在性检查（否则回滚通道软 404 全回来）", () => {
  // 定位 proxy.ts 里 markdown 分支的那一行（剥掉注释后再找）。
  const branchIdx = PROXY_SOURCE.indexOf('process.env.CONTENT_SOURCE !== "db"');
  assert.ok(branchIdx > 0, "proxy.ts 里找不到 CONTENT_SOURCE !== \"db\" 的分支");

  const branch = PROXY_SOURCE.slice(branchIdx, branchIdx + 900);

  // 该分支里必须出现 markdownProbeExists 与 notFoundRewrite —— 两个都要，
  // 只调探针不处置等于「查了但不管」，是本缺陷最可能的退化形态。
  // 处置动作收敛在 notFoundRewrite() 里（它内部才带 status: 404，见 P7-W12），
  // 所以这里断言的是调用那个函数，而不是内联的 NOT_FOUND_PATH 字面量。
  assert.match(
    branch,
    /markdownProbeExists\s*\(/,
    "markdown 分支里没有调用 markdownProbeExists —— 存在性检查又被跳过了（回滚软 404 会回来）",
  );
  assert.match(
    branch,
    /notFoundRewrite\s*\(\s*request\s*\)/,
    "markdown 分支里没有走 notFoundRewrite —— 查了却没处置，软 404 依旧是 200",
  );

  // 反向：这个分支里**不许**再出现裸的提前 return。
  // 正确写法是 `if (...) { ...; return NextResponse.next(); }` ——
  // 有花括号块，且 next() 在检查之后。裸写法 `if (...) return NextResponse.next();`
  // 会让后续所有逻辑被整段跳过，正是本缺陷的原形。
  assert.ok(
    !/if\s*\(\s*process\.env\.CONTENT_SOURCE\s*!==\s*"db"\s*\)\s*return\s+NextResponse\.next\(\)/.test(
      PROXY_SOURCE,
    ),
    "又出现了 `if (CONTENT_SOURCE !== \"db\") return NextResponse.next();` 的提前 return —— " +
      "这是 markdown 软 404 的原形，必须保持「先检查再 next()」的块结构",
  );
});

test("P7-R10：markdown 探针的判据必须与页面层一致（draft / 标签口径）", () => {
  // ① 生产环境必须过滤 draft —— 页面层是靠 `readAllParsedPosts()` 里的
  //    `.filter(post => !post.meta.draft)`，探针若不判 draft，
  //    草稿 URL 会被 proxy 判「存在」，然后页面 404 → 又是一次不一致。
  assert.match(
    MARKDOWN_PROBE_SOURCE,
    /data\.draft\s*===\s*true/,
    "markdown 探针没有按 `draft: true` 过滤 —— 生产环境下草稿 URL 会被误判为存在",
  );

  // ② 标签必须走同一个归一化函数，否则「LLM」与「llm」会被当成两个标签。
  assert.match(
    MARKDOWN_PROBE_SOURCE,
    /tagSlugOfName\s*\(/,
    "markdown 探针没有复用 tagSlugOfName —— 标签判据会与页面层分叉",
  );
  assert.match(
    MARKDOWN_PROBE_SOURCE,
    /decodeTagParam\s*\(/,
    "markdown 探针没有复用 decodeTagParam —— 裸 `+` 会被当成字面加号",
  );

  // ③ 只统计 blog（与 `getAllTags()` 一致：它遍历的是 `getAllPostsCached()`）。
  assert.match(
    MARKDOWN_PROBE_SOURCE,
    /slugsByKind\(\)\.get\("blog"\)/,
    "markdown 探针统计标签时没有限定 blog —— 与 getAllTags() 的口径不一致",
  );

  // ④ 不许引入 markdown 渲染管线（proxy 每请求都跑，不该把 Shiki 拖进模块图）。
  assert.ok(
    !/@loxander\/markdown/.test(MARKDOWN_PROBE_SOURCE),
    "markdown 探针导入了 @loxander/markdown —— 会把 Shiki 与 unified 整套管线拖进 proxy 的模块图",
  );
});

test("P7-R11：四个旧 lib 的内容目录必须走 app-root，不许用 process.cwd()", () => {
  /**
   * 背景（实测）：`next start` 下 `process.cwd()` 是**仓库根**而不是 `apps/web`：
   * ```
   * process.cwd()                  = ...\loxander-platform
   * cwd/content/blog 存在           = false
   * cwd/apps/web/content/blog 存在  = true
   * ```
   * 于是 markdown 源的 `/search?q=markdown` 返回 0 篇（正确是 2 篇）。
   * 预渲染页面掩盖了这个问题，只有请求时渲染的路径会塌。
   */
  const libs = ["posts.ts", "diary.ts", "goals.ts", "projects.ts"];

  for (const lib of libs) {
    const source = stripComments(
      readFileSync(resolvePath(SRC_DIR, "lib", lib), "utf8"),
    );

    assert.ok(
      !/path\.join\(\s*process\.cwd\(\)\s*,\s*"content"/.test(source),
      `${lib} 又用 process.cwd() 拼内容目录了 —— 生产启动时 cwd 是仓库根，会读不到任何内容`,
    );
    assert.match(
      source,
      /contentDir\s*\(/,
      `${lib} 没有走 app-root 的 contentDir()`,
    );
  }
});
