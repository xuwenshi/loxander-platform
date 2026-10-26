/**
 * 图片嗅探：从**字节**判断 MIME 与尺寸，不信任何客户端声明。
 *
 * ── 为什么不用 `file-type` 之类的库 ───────────────────────────────────
 * 方案 §13 要求「上传只接受白名单类型」。白名单只有五种
 * （png / jpeg / gif / webp / svg），每种的头几个字节都是公开规范里的定值，
 * 自己写 80 行就能判完；引入一个依赖反而多一层「版本升级后行为变了」的风险，
 * 而这里的判断结果直接决定文件被写到哪个目录、以什么 content-type 对外，
 * 值得把规则摆在明面上。
 *
 * ── 为什么不信 `File.type` ───────────────────────────────────────────
 * 浏览器给的 `Content-Type` 完全由客户端控制。把一个 `.exe` 重命名成 `.png`
 * 上传，`File.type` 会是 `image/png`，但它不是。用魔数（magic bytes）判断
 * 才能保证「落盘的字节确实是它声称的图片」。
 *
 * ── 尺寸为什么要自己解析 ────────────────────────────────────────────
 * 封面图要写 `width` / `height` 到 `media` 表与文章 `data`，为的是给
 * `<img>` 输出宽高比、避免 CLS。浏览器端拿尺寸要在 `Image` 里 decode 一次
 * （上传后额外的异步等待 + 内存峰值），服务端直接读文件头更快也更可靠。
 *
 * ── 为什么不支持 AVIF / HEIC ────────────────────────────────────────
 * 两者都是容器格式（ISOBMFF），要读完 `meta`/`iprp` 才能取尺寸，
 * 代码量是其余五种之和。站点里现有图片全是 SVG 与 PNG（见
 * `packages/content-core` 的 `cover` 校验只认 `.svg`），先不做。
 */

import { checkSvgSafety } from "./svg-safety";

/** 支持的图片类型（MIME）。 */
export type ImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";

/** 上传白名单：只有这五种能进媒体库。 */
export const IMAGE_MIME_TYPES: readonly ImageMimeType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const;

/** 每种 MIME 对应的推荐扩展名（落盘用）。 */
export const IMAGE_EXTENSIONS: Record<ImageMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

/** 单个文件最大字节数（10 MB）。方案未规定，取一个「个人博客够用且不至于拖垮内存」的值。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 嗅探失败时抛的错（当作 400 处理，不是 500）。 */
export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedImageError";
  }
}

/** 嗅探结果。`width` / `height` 在无法解析时为 `undefined`（图仍可用，只是没有宽高比）。 */
export interface ImageInfo {
  mimeType: ImageMimeType;
  width?: number;
  height?: number;
}

/* -------------------------------------------------------------------------- */
/* 魔数匹配                                                                    */
/* -------------------------------------------------------------------------- */

/** 比较 `bytes[offset..]` 是否以 `signature` 开头。 */
function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** 大端 16 位。 */
function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/** 大端 32 位。用 `*` 而不是 `<<24`：后者在 JS 里会变成负数。 */
function u32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
  );
}

/** 小端 16 位。 */
function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** 小端 24 位（WebP VP8L 的尺寸是 14 位 + 14 位）。 */
function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

/* -------------------------------------------------------------------------- */
/* 各格式尺寸解析                                                              */
/* -------------------------------------------------------------------------- */

/** PNG：8 字节签名 + 4 字节长度 + `IHDR` + 宽(4) + 高(4) → 偏移 16 / 20。 */
function pngSize(bytes: Uint8Array): { width?: number; height?: number } {
  if (!startsWith(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return {};
  if (bytes.length < 24) return {};
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** GIF：签名后 4 字节是小端宽高（逻辑屏幕描述符）。 */
function gifSize(bytes: Uint8Array): { width?: number; height?: number } {
  if (bytes.length < 10) return {};
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

/**
 * JPEG：从偏移 2 开始遍历段，找 `SOFn`（0xC0–0xCF，排除 0xC4/0xC8/0xCC）。
 *
 * 段结构：`0xFF <marker> <length:2 BE>`，`length` 含自身 2 字节。
 * 尺寸在 SOF 段里是「精度(1) + 高(2) + 宽(2)」，所以相对段数据起点 `+1` 是高度。
 */
function jpegSize(bytes: Uint8Array): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // 段之间可能有填充字节；不是 0xFF 就往前挪一格重试，而不是直接放弃。
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // 独立 marker（无长度字段）：TEM(0x01)、RST0-7(0xD0-0xD7)、SOI/EOI。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0xff) {
      offset += 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return {};
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 >= bytes.length) return {};
      return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    offset += 2 + length;
  }
  return {};
}

/**
 * WebP：`RIFF <size:4> WEBP` 之后是第一个 chunk。
 * - `VP8 `（有损）：chunk 数据里 `+6` 是宽高（各 2 字节小端，取低 14 位）
 * - `VP8L`（无损）：`+1` 起是 14 位宽、14 位高（此处再 -1 得实际值）
 * - `VP8X`（扩展）：`+4` 起各 3 字节小端，值是 `实际值 - 1`
 */
function webpSize(bytes: Uint8Array): { width?: number; height?: number } {
  if (bytes.length < 30) return {};
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);

  if (chunk === "VP8 ") {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = u24le(bytes, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  return {};
}

/**
 * SVG：文本解析 `width` / `height` 属性，缺省时退回 `viewBox` 的后两段。
 *
 * 只扫根元素的开标签（`<svg ...>`），不引 XML 解析器：SVG 的尺寸就在根上，
 * 而引一个完整 XML 解析器只为取两个数字不划算。
 * 单位（`px` / `%` / `em`）一律剥掉取数值 —— `%` 其实无法确定真实像素，
 * 这种情况退回 `viewBox` 才是正确做法；两者都拿不到就返回 `undefined`。
 */
function svgSize(text: string): { width?: number; height?: number } {
  const rootMatch = /<svg\b[^>]*>/i.exec(text);
  if (!rootMatch) return {};
  const root = rootMatch[0];

  const readNumber = (attribute: string): number | undefined => {
    const match = new RegExp(`${attribute}\\s*=\\s*["']([^"']+)["']`, "i").exec(root);
    if (!match) return undefined;
    const raw = match[1]!.trim();
    // 纯百分比无法换算成像素，当作没有。
    if (raw.endsWith("%")) return undefined;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  };

  const width = readNumber("width");
  const height = readNumber("height");
  if (width !== undefined && height !== undefined) return { width, height };

  const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(root);
  if (viewBox) {
    const parts = viewBox[1]!.split(/[\s,]+/).map((value) => Number.parseFloat(value));
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
      return {
        width: width ?? Math.round(parts[2]!),
        height: height ?? Math.round(parts[3]!),
      };
    }
  }

  return { width, height };
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 嗅探图片类型与尺寸。
 *
 * 失败时抛 `UnsupportedImageError`（调用方应当转成 400），
 * 而不是返回 `null` —— 后者容易被写成 `if (!info) return;` 静默吞掉，
 * 上传按钮就变成「点了没反应」。
 */
export function sniffImage(bytes: Uint8Array): ImageInfo {
  if (bytes.length === 0) {
    throw new UnsupportedImageError("文件是空的。");
  }

  // PNG：89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", ...pngSize(bytes) };
  }

  // JPEG：FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", ...jpegSize(bytes) };
  }

  // GIF：GIF87a / GIF89a
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { mimeType: "image/gif", ...gifSize(bytes) };
  }

  // WebP：RIFF .... WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { mimeType: "image/webp", ...webpSize(bytes) };
  }

  // SVG：文本，可能有 BOM、XML 声明、注释、DOCTYPE 在 `<svg>` 之前。
  // 只在前 4 KB 里找 `<svg`（根元素不可能离那么远），避免为上大文件解码全文。
  if (bytes.length <= MAX_IMAGE_BYTES) {
    const head = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.subarray(0, Math.min(bytes.length, 4096)),
    );
    const looksLikeSvg =
      /<svg[\s>]/i.test(head) ||
      (/^\uFEFF?\s*<\?xml/i.test(head) && /svg/i.test(head));
    if (looksLikeSvg) {
      /*
        安全检查放在尺寸解析**之前**，且检查的是**全部字节**。

        这是方案 §13.3「拒绝 SVG 中的脚本」的落地点。位置很关键：
        放在 `sniffImage` 里而不是 `uploadMediaAction` 里，意味着任何走
        「嗅探 → 存储」的上传路径都自动被覆盖，未来新增的调用方不会漏。
        检查全部字节而不是复用上面的 4 KB `head`，因为把 `<script>` 放在
        第 5001 字节就能绕过只查头部的实现。

        抛 `UnsupportedImageError` 而不是返回标志位：调用方已经有一个
        「文件不支持」的错误分支，复用它比新增一个分支更不容易被漏处理。
      */
      const safety = checkSvgSafety(bytes);
      if (!safety.safe) {
        throw new UnsupportedImageError(safety.reason);
      }
      // 尺寸在根元素上，需要完整的开标签；4 KB 足够容纳任何正常 SVG 的根标签。
      const full = bytes.length <= 4096 ? head : new TextDecoder("utf-8").decode(bytes.subarray(0, 4096));
      return { mimeType: "image/svg+xml", ...svgSize(full) };
    }
  }

  throw new UnsupportedImageError(
    "只支持 PNG、JPEG、GIF、WebP、SVG 五种图片。请确认文件不是改了扩展名的其它格式。",
  );
}

/**
 * 按文件名推 MIME（仅在「已知是图片但要判具体类型」时用，**不能替代嗅探**）。
 *
 * 用途：媒体库列表里旧文件没有存 mime_type 时，按扩展名给一个显示用的类型。
 */
export function mimeFromFilename(filename: string): ImageMimeType | undefined {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return undefined;
}
