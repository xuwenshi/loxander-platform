/**
 * 媒体存储抽象：生产走 Vercel Blob，本地无 Token 时降级到 `public/media/`。
 *
 * ── 为什么要一层抽象，而不是在 Server Action 里直接调 `put()` ──────────
 * 上传有两个执行环境：①Vercel（有 `BLOB_READ_WRITE_TOKEN`，文件必须进对象存储，
 * 因为部署产物是只读镜像）；②本机开发（没有 Token，也不该为了试一张图就去开
 * 一个 Blob Store）。调用方（`media-actions.ts`）只关心「传了字节、拿回 URL」，
 * 不该同时知道这两种模式的存在。
 *
 * ── 为什么不选「统一都写 public/」 ────────────────────────────────────
 * Vercel 的运行时文件系统是只读的。本地写入在 `next build` 之后、
 * Serverless 函数里会直接 `EROFS`。所以 `public/media/` **只能**当开发兜底，
 * 生产必须配 `BLOB_READ_WRITE_TOKEN`——这一条写在下面的 `putImage` 注释里，
 * 也在 `/admin/media` 页面上显式提示给操作者。
 *
 * ── 为什么 `path` 与 `url` 分开存 ────────────────────────────────────
 * `path` 是**存储层的主键**（Blob 的 pathname / 本地的相对路径），删除时用它；
 * `url` 是**渲染层用的地址**（Blob 是绝对 URL，本地是 `/media/...`），
 * 写进正文时用它。两者在 Blob 模式下形状不同，混用会出现「存进去能显示、
 * 删不掉」或者「删得掉、显示 404」。
 *
 * ── 为什么本地兜底也用 `media/<yyyy>/<mm>/` 分层 ─────────────────────
 * 早先的接口说明写的是「本地落到 `public/media/<filename>`、URL 为
 * `/media/<filename>`」。那样会引入一个真实缺陷：`path`（`media/2026/10/x.png`）
 * 与 `url`（`/media/x.png`）对不上，且不同月份的同名文件在 URL 空间里**撞车**
 * （后者覆盖前者）。所以这里让本地与 Blob 采用**同一套 pathname 规则**，
 * 本地 URL 就是 `/` + pathname。`references.ts` 的引用匹配因此对两种模式
 * 只需要一套「按路径后缀比对」的逻辑。
 */

import "server-only";

import { Buffer } from "node:buffer";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { publicPath } from "../app-root";
import type { ImageMimeType } from "./image-info";

/** `putImage` 的返回值。字段与 `media` 表的列一一对应（顺序也一致）。 */
export interface StoredImage {
  /** 存储层路径（Blob pathname / 本地相对路径），如 `media/2026/10/abc.png`。 */
  path: string;
  /** 对外地址：Blob 是绝对 URL，本地是 `/media/...`。 */
  url: string;
  sizeBytes: number;
  contentType: ImageMimeType;
}

/** 方案 §14.2「图片：CDN 长缓存」。一年。Blob 的 `cacheControlMaxAge` 单位是秒。 */
const BLOB_CACHE_MAX_AGE_SECONDS = 31_536_000;

const BLOB_TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";

/**
 * 本地兜底的根目录与允许写入的前缀。
 *
 * **不能用 `path.join(process.cwd(), "public")`**：实测 `next start` 下
 * `process.cwd()` 是仓库根（`loxander-platform`）而不是 `apps/web`，
 * 那样本地兜底会把图片写到 `loxander-platform/public/media/...`，
 * 站点的静态文件服务根本不会去那里找。改用 `lib/app-root.ts` 解析出的
 * 应用根，它在「cwd 是应用根」与「cwd 是仓库根」两种部署下都正确。
 *
 * pathname 一律以 `media/` 开头（`media/<yyyy>/<mm>/<filename>`），于是
 * 本地绝对路径 = `public/` + pathname，本地 URL = `/` + pathname，
 * **path 与 url 只差一个前导斜杠**。这让引用匹配只需要一套逻辑。
 */
const LOCAL_PUBLIC_ROOT = publicPath("");

/** 媒体允许落盘的目录（`public/media`）。`deleteImage` 的前缀校验以它为界。 */
const LOCAL_MEDIA_ROOT = path.join(LOCAL_PUBLIC_ROOT, "media");

/** 是否配置了 Blob。页面用它决定要不要显示「当前是本地兜底」的提示。 */
export function isBlobConfigured(): boolean {
  const token = process.env[BLOB_TOKEN_ENV];
  return typeof token === "string" && token.trim().length > 0;
}

/**
 * 校验并规范化 pathname。
 *
 * 三件事必须在这里挡住，且**必须在写盘之前**：
 * ①绝对路径（`/etc/passwd`）——去掉前导斜杠后仍可能被 `path.resolve` 解释成根；
 * ②`..` 段——`media/../../x` 会逃出 `public/media`；
 * ③空段（`a//b`）——会让 `path.resolve` 的语义变得难以推理。
 *
 * 抛错而不是静默修正：调用方的 pathname 由 `media-actions.ts` 自己生成，
 * 走到这里说明有代码 bug，静默修会把 bug 藏起来。
 */
function assertSafePathname(pathname: string): string {
  const trimmed = pathname.trim().replace(/^\/+/, "");
  if (trimmed.length === 0) {
    throw new Error("[media/storage] 存储路径不能为空。");
  }

  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error(`[media/storage] 非法的存储路径：${pathname}`);
    }
  }

  // 统一用 "/" 拼接：Blob 的 pathname 是 URL 风格，本地再用 path.resolve 转成平台分隔符。
  return segments.join("/");
}

/**
 * 把 pathname 解析成本地绝对路径，并**再次**校验它确实落在 `public/media/` 之内。
 *
 * 双层校验（`assertSafePathname` + 这里的前缀判断）是刻意的：前者防住字符串级
 * 穿越，后者防住「字符串看起来合法但解析后越界」的情况（Windows 盘符、UNC 路径）。
 */
function resolveLocalFile(safePathname: string): string {
  const target = path.resolve(LOCAL_MEDIA_ROOT, safePathname);
  if (!target.startsWith(LOCAL_MEDIA_ROOT + path.sep)) {
    throw new Error(`[media/storage] 拒绝写入 public/media 之外的路径：${safePathname}`);
  }
  return target;
}

/**
 * 写入一张图片，返回存储位置与可访问 URL。
 *
 * ⚠️ 本地兜底只是**开发期**能力：`public/media/` 在生产（Vercel Serverless）
 * 是只读的，写入会 `EROFS`。生产部署必须配 `BLOB_READ_WRITE_TOKEN`。
 */
export async function putImage(
  pathname: string,
  bytes: Uint8Array,
  contentType: ImageMimeType,
): Promise<StoredImage> {
  const safePathname = assertSafePathname(pathname);

  if (bytes.byteLength === 0) {
    throw new Error("[media/storage] 拒绝写入空文件。");
  }

  if (isBlobConfigured()) {
    // 动态 import：`CONTENT_SOURCE=markdown` 的纯静态部署完全不碰上传，
    // 让 `@vercel/blob` 及其依赖（undici / async-retry）不进模块图。
    const { put } = await import("@vercel/blob");
    const result = await put(safePathname, Buffer.from(bytes), {
      access: "public",
      // 文件名由我们生成（时间戳 + 随机 hex），已经足够唯一；
      // 再叠一层 Blob 的随机后缀会让「按 path 找引用」变得不可能。
      addRandomSuffix: false,
      // 明确写 false：同名覆盖会静默替换掉已被文章引用的图片，
      // 宁可让调用方收到 409，也不让历史文章里的图悄悄变了。
      allowOverwrite: false,
      contentType,
      cacheControlMaxAge: BLOB_CACHE_MAX_AGE_SECONDS,
    });

    return {
      path: result.pathname,
      url: result.url,
      sizeBytes: bytes.byteLength,
      contentType,
    };
  }

  const target = resolveLocalFile(safePathname);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);

  return {
    path: safePathname,
    url: `/${safePathname}`,
    sizeBytes: bytes.byteLength,
    contentType,
  };
}

/**
 * 删除一张图片。文件不存在时**不报错**。
 *
 * 为什么不报错：删除是幂等操作。Blob 上文件可能已经被别处清掉（比如换了 Store），
 * 本地文件可能被 `git clean` 带走 —— 这两种情况下 media 表里那行仍然是脏数据，
 * 应当允许把它删掉。
 *
 * 路由规则看**当前配置**而不是入参形状：谁写的谁删。配了 Token 走 `del()`
 * （它同时接受 URL 与 pathname），否则按本地路径处理。
 */
export async function deleteImage(pathOrUrl: string): Promise<void> {
  if (isBlobConfigured()) {
    const { del } = await import("@vercel/blob");
    // `del` 接受绝对 URL 或 pathname 两种形态，这里原样传。
    await del(pathOrUrl.startsWith("http") ? pathOrUrl : assertSafePathname(pathOrUrl));
    return;
  }

  // 本地：允许传 `/media/...` 形式的 URL，统一折算成 pathname。
  const pathname = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl).pathname
    : pathOrUrl;
  const target = resolveLocalFile(assertSafePathname(pathname));

  try {
    await unlink(target);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return;
    throw error;
  }
}
