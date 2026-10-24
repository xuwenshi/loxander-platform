/**
 * 安全响应头的离线断言（P6）。
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────────
 * 安全头是「配了但没生效」最容易发生的一类改动：
 * - 写错 key（`X-Frame-Options` 少个 s）；
 * - 写进 `proxy.ts` 而不是 `headers()`，结果 `api/` 与静态资源全裸奔；
 * - CSP 里多加一个 `'unsafe-eval'` 或者一个裸 `*`，看起来只是一行字符串。
 * 这些都不会让任何页面报错，只会让防护静默消失。
 *
 * 所以这里把 `next.config.ts` 当成**数据**来断言：直接 import 它的
 * default export，调用 `headers()`，逐字段比对。这样任何一次「顺手改一下
 * 配置」都会立刻变红。
 *
 * ── 为什么不发真实 HTTP 请求 ──────────────────────────────────────────────
 * 本机沙箱禁止 fork 子进程，`next build` / `next dev`（默认方式）全部
 * `spawn EPERM`。真正发请求验证需要先起 dev server，而 dev server 只能靠
 * 执行记录 §7.8.1 的四层绕过启动器跑起来 —— 那属于人工验收步骤，
 * 不适合放进自动化测试。本文件负责「配置层正确」，真实响应头由
 * 执行记录里的 HTTP 验收步骤覆盖。
 *
 * ── 一个必须知道的限制 ───────────────────────────────────────────────────
 * 这里断言的是 `headers()` 的**返回值**，不是 Next 内部如何把它挂到响应上。
 * 如果 Next 改了 `headers()` 的匹配语义（例如 `/(.*)` 不再覆盖 api 路由），
 * 本测试不会发现。这条限制写在执行记录的「诚实清单」里。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/* -------------------------------------------------------------------------- */
/* 1. 定位仓库与 apps/web                                                      */
/* -------------------------------------------------------------------------- */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * `apps/web/src/lib/__tests__` → 上溯三层到 `apps/web`。
 * （`__tests__` → `lib` → `src` → `web`，所以是 `../../..`，不是四层。
 *   写成四层会落到 `apps/`，报 `Cannot find module '.../apps/next.config.ts'`。）
 */
const APP_WEB_ROOT = path.resolve(HERE, "../../..");
const NEXT_CONFIG_PATH = path.join(APP_WEB_ROOT, "next.config.ts");

/* -------------------------------------------------------------------------- */
/* 2. 加载被测配置                                                             */
/* -------------------------------------------------------------------------- */

interface HeaderPair {
  key: string;
  value: string;
}

interface HeaderRule {
  source: string;
  headers: HeaderPair[];
}

interface LoadedConfig {
  headers?: () => Promise<HeaderRule[]> | HeaderRule[];
  experimental?: { serverActions?: { bodySizeLimit?: string } };
  cacheComponents?: boolean;
}

const NEXT_CONFIG_SOURCE = readFileSync(NEXT_CONFIG_PATH, "utf8");

/**
 * 为什么不用 `await import(next.config.ts)` ——
 *
 * `next.config.ts` 里有一句 `root: path.resolve(__dirname, "../..")`。
 * `__dirname` 是 Next 在编译配置时**注入**的（它按 CJS 语义打包 config），
 * 而纯 node 的 ESM 作用域里没有这个变量，直接 import 会抛
 * `ReferenceError: __dirname is not defined in ES module scope`。
 *
 * 所以这里做三件最小化的事，然后求值：
 * 1. 去掉 `import type { NextConfig } from "next";`（运行时本来就被擦除）；
 * 2. 去掉 `import path from "node:path";`，改为由外层注入 `path`；
 * 3. 把 `export default nextConfig;` 换成 `return nextConfig;`。
 *
 * 每一步都用 assert 守住「改写确实发生了」。这样如果将来有人改了 config 的
 * 写法（例如把 default export 改成具名导出），这里会**明确报错**，
 * 而不是悄悄拿到一个空对象、让后面的断言变成假绿。
 */
function loadNextConfig(): LoadedConfig {
  let body = NEXT_CONFIG_SOURCE;

  const typeImport = 'import type { NextConfig } from "next";';
  assert.ok(
    body.includes(typeImport),
    `next.config.ts 的改写前提失效：没找到 ${typeImport}。` +
      "若这是有意的写法变更，请同步更新本测试的 loadNextConfig()",
  );
  body = body.replace(typeImport, "");

  const pathImport = 'import path from "node:path";';
  assert.ok(
    body.includes(pathImport),
    `next.config.ts 的改写前提失效：没找到 ${pathImport}。` +
      "若已不再依赖 node:path，请同步更新本测试的 loadNextConfig()",
  );
  body = body.replace(pathImport, "");

  const defaultExport = "export default nextConfig;";
  assert.ok(
    body.includes(defaultExport),
    `next.config.ts 必须用 ${defaultExport} 导出配置（Next 的约定）。` +
      "若改成具名导出，请同步更新本测试的 loadNextConfig()",
  );
  body = body.replace(defaultExport, "return nextConfig;");

  // `nextConfig` 在源码里是 `const nextConfig: NextConfig = {...}`，
  // 类型注解在 `new Function` 里是语法错误，去掉。
  body = body.replace(/const nextConfig:\s*NextConfig\s*=/, "const nextConfig =");

  const factory = new Function("path", "__dirname", "__filename", body) as (
    pathModule: typeof path,
    dirname: string,
    filename: string,
  ) => LoadedConfig;

  const loaded = factory(path, APP_WEB_ROOT, NEXT_CONFIG_PATH);
  assert.ok(
    loaded && typeof loaded === "object",
    "next.config.ts 求值后必须得到一个配置对象",
  );

  return loaded;
}

const nextConfig = loadNextConfig();

/** 取 `headers()` 的返回值里 `source` 为 `/(.*)` 的那一条。 */
async function loadGlobalRule(): Promise<HeaderRule> {
  /*
    `assert.equal` 不是 TS 的断言函数（签名里没有 `asserts`），所以它**不会**
    把 `nextConfig.headers` 从 `(() => ...) | undefined` 收窄成函数类型。
    直接写 `await nextConfig.headers()` 会报 TS2722 / TS18048。

    先取出到局部变量、再做一次显式类型断言，比 `!` 更诚实：`!` 会连
    「它根本不是函数」也一起糊弄过去，而这里先把 typeof 检查跑完
    （那条 assert 仍然会在运行时报错并给出可读文案），然后才断言类型。
  */
  const headersFactory = nextConfig.headers;

  assert.equal(
    typeof headersFactory,
    "function",
    "next.config.ts 必须导出 headers() —— P6 的全站安全头挂在它上面",
  );

  const rules = await (headersFactory as () => Promise<HeaderRule[]> | HeaderRule[])();
  assert.ok(Array.isArray(rules), "headers() 必须返回数组");

  const global = rules.find((rule) => rule.source === "/(.*)");
  assert.ok(
    global,
    "headers() 必须有一条 source 为 \"/(.*)\" 的全站规则；" +
      `实际 source 列表：${JSON.stringify(rules.map((rule) => rule.source))}`,
  );

  return global;
}

/** 把 HeaderPair[] 转成 Map，并顺手断言没有重复 key。 */
function toHeaderMap(rule: HeaderRule): Map<string, string> {
  const map = new Map<string, string>();

  for (const pair of rule.headers) {
    assert.ok(
      !map.has(pair.key),
      `安全头 ${pair.key} 被写了两遍。Next 的 headers 是追加语义，` +
        "同名头在响应里会被逗号拼接，CSP 会变成多份策略求交集 —— 越写越严且极难排查",
    );
    map.set(pair.key, pair.value);
  }

  return map;
}

/* -------------------------------------------------------------------------- */
/* 4. 断言                                                                     */
/* -------------------------------------------------------------------------- */

test("P6 安全头：headers() 只对全站设一条规则，不逐路由重复", async () => {
  const rules = await nextConfig.headers!();

  assert.equal(
    rules.length,
    1,
    "只应该有 /(.*) 这一条规则。逐路由写会漏掉 api/ 与静态资源，" +
      "而静态资源恰恰是 nosniff 最该保护的对象",
  );
  assert.equal(rules[0].source, "/(.*)");
});

test("P6 安全头：六个头必须齐全，且不多不少", async () => {
  const map = toHeaderMap(await loadGlobalRule());

  const expectedKeys = [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Content-Security-Policy",
  ].sort();

  assert.deepEqual(
    [...map.keys()].sort(),
    expectedKeys,
    "安全头集合与约定不一致（多一个或少一个都算失败）",
  );
});

test("P6 安全头：HSTS 的 max-age 不短于一年，且覆盖子域", async () => {
  const map = toHeaderMap(await loadGlobalRule());
  const hsts = map.get("Strict-Transport-Security")!;

  const maxAgeMatch = /max-age=(\d+)/.exec(hsts);
  assert.ok(maxAgeMatch, `HSTS 必须含 max-age，实际：${hsts}`);

  const maxAge = Number.parseInt(maxAgeMatch[1], 10);
  assert.ok(
    maxAge >= 31_536_000,
    `HSTS max-age 不得短于一年（31536000 秒），实际 ${maxAge}。` +
      "过短等于没开：攻击者只要等到过期就能降级",
  );

  assert.match(hsts, /includeSubDomains/i, "HSTS 必须含 includeSubDomains");
});

test("P6 安全头：nosniff / DENY / 严格 referrer / 权限全部关闭", async () => {
  const map = toHeaderMap(await loadGlobalRule());

  assert.equal(map.get("X-Content-Type-Options"), "nosniff");
  assert.equal(map.get("X-Frame-Options"), "DENY");
  assert.equal(map.get("Referrer-Policy"), "strict-origin-when-cross-origin");

  const permissions = map.get("Permissions-Policy")!;
  for (const feature of ["camera", "microphone", "geolocation", "interest-cohort"]) {
    assert.match(
      permissions,
      new RegExp(`${feature}=\\(\\)`),
      `Permissions-Policy 必须显式关闭 ${feature}，实际：${permissions}`,
    );
  }
});

test("P6 安全头：CSP 的十条指令逐条到位", async () => {
  const map = toHeaderMap(await loadGlobalRule());
  const csp = map.get("Content-Security-Policy")!;

  const requiredDirectives = [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
  ];

  for (const directive of requiredDirectives) {
    assert.ok(
      csp.includes(directive),
      `CSP 缺少指令 ${directive}。实际 CSP：${csp}`,
    );
  }
});

test("P6 安全头：CSP 放开了内联脚本与内联样式（有明确理由的折衷）", async () => {
  const map = toHeaderMap(await loadGlobalRule());
  const csp = map.get("Content-Security-Policy")!;

  // 这两条不是「忘了收紧」，而是**必须**放开：
  // - layout.tsx 的内联 themeInitScript（防暗色 FOUC）
  // - Shiki 逐 token 输出的内联 style
  // 断言它们存在，是为了防止有人「为了看起来更安全」把它们删掉 ——
  // 删掉会白屏，且不会在任何离线测试里报错，只会在浏览器控制台刷 CSP 违规。
  assert.match(
    csp,
    /script-src [^;]*'unsafe-inline'/,
    "script-src 必须含 'unsafe-inline'：layout.tsx 的内联 themeInitScript 依赖它，" +
      "去掉会让暗色模式首帧闪白（FOUC）",
  );
  assert.match(
    csp,
    /style-src [^;]*'unsafe-inline'/,
    "style-src 必须含 'unsafe-inline'：Shiki 双主题逐 token 输出内联 style，" +
      "去掉会让所有代码高亮失效",
  );
});

test("P6 安全头：CSP 里不许出现 unsafe-eval，也不许出现裸通配来源", async () => {
  const map = toHeaderMap(await loadGlobalRule());
  const csp = map.get("Content-Security-Policy")!;

  assert.ok(
    !csp.includes("'unsafe-eval'"),
    "'unsafe-eval' 是 XSS 放大器，生产策略里绝不能有。" +
      "若本地调试被 CSP 挡住，应该用 dev 专用分支，而不是改生产策略",
  );

  // 裸 `*` 作为来源（`default-src *` / `img-src *`）等于全放开。
  // 注意 `https://*.public.blob.vercel-storage.com` 里的 `*` 是子域通配，合法，
  // 所以这里要求 `*` 两侧不能同时是空白或分号。
  const bareWildcard = /(?:^|[\s;])\*(?=$|[\s;])/.exec(csp);
  assert.equal(
    bareWildcard,
    null,
    `CSP 里出现了裸通配来源 *（全放开），实际 CSP：${csp}`,
  );

  assert.ok(
    csp.includes("https://*.public.blob.vercel-storage.com"),
    "img-src 必须放行 Vercel Blob 域名（媒体上传的图片从这里加载）。" +
      "域名来源见 lib/media/storage.ts",
  );
});

test("P6 安全头：next.config.ts 里没有 export const dynamic", async () => {
  const source = readFileSync(NEXT_CONFIG_PATH, "utf8");

  // P5 踩过的坑：`cacheComponents: true` 下写 `export const dynamic` 会在
  // **编译期**被 next-swc-loader 拦下，报
  // `Route segment config "dynamic" is not compatible with nextConfig.cacheComponents`。
  // 这个错误不会出现在 tsc 里，只会出现在真实构建/dev 里 —— 所以在这里守一道。
  assert.ok(
    !/export\s+const\s+dynamic\s*=/.test(source),
    "next.config.ts 里不能有 export const dynamic：" +
      "cacheComponents: true 下这是编译期硬错",
  );

  assert.equal(
    nextConfig.cacheComponents,
    true,
    "cacheComponents 必须保持 true —— P3/P5 的缓存标签体系依赖它",
  );
});

test("P6 安全头：Server Actions 体积上限仍是 11mb", async () => {
  assert.equal(
    nextConfig.experimental?.serverActions?.bodySizeLimit,
    "11mb",
    "bodySizeLimit 必须是 11mb。Next 16 默认上限是 1MB，" +
      "媒体层允许 10MB 图片 —— 改小会让「上传 2MB 的图」在框架层被拒，" +
      "报一个和图片格式毫无关系的错误",
  );
});
