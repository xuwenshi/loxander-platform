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
import { existsSync } from "node:fs";
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
  assert.match(
    PROXY_SOURCE,
    /if\s*\(\s*!exists\s*\)\s*\{?\s*return\s+NextResponse\.rewrite\(\s*new\s+URL\(\s*NOT_FOUND_PATH/,
    "proxy.ts 没有在「确认不存在」时 rewrite 到 NOT_FOUND_PATH —— 状态码仍然会是 200",
  );
});

test("P7-W2：rewrite 用的是 rewrite 而不是 redirect（404 不能变成跳转）", () => {
  const rewriteCalls = PROXY_SOURCE.match(/NextResponse\.rewrite\(/g) ?? [];
  assert.equal(rewriteCalls.length, 1, `proxy.ts 里应当恰好有 1 处 NextResponse.rewrite，实际 ${rewriteCalls.length}`);
  assert.ok(
    !/NextResponse\.redirect\(\s*new\s+URL\(\s*NOT_FOUND_PATH/.test(PROXY_SOURCE),
    "NOT_FOUND_PATH 不能用 redirect —— 那会变成 307/301 跳转，URL 会变，语义全错",
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
