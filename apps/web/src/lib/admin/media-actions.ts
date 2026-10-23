"use server";

import { randomBytes } from "node:crypto";

import { revalidatePath } from "next/cache";

import { auditLogs } from "../../../../../db/schema";
import { requireAdmin } from "../auth";
import { getAdminDb } from "./db";
import {
  deleteMediaRow,
  getMediaById,
  insertMedia,
  type MediaRow,
} from "./media";
import { findMediaReferences } from "../media/references";
import {
  MAX_IMAGE_BYTES,
  IMAGE_EXTENSIONS,
  UnsupportedImageError,
  sniffImage,
  type ImageInfo,
} from "../media/image-info";
import { deleteImage, isBlobConfigured, putImage, type StoredImage } from "../media/storage";

/**
 * 媒体库的写路径（Server Actions）。
 *
 * ── 七道关在这里怎么落地 ──────────────────────────────────────────────
 * P4 给内容写路径定的「后台写操作七道关」（见 `admin/actions.ts:32-48`）在媒体
 * 上传上不完全同构 —— 媒体没有 slug、没有 publish_status、也没有乐观锁。逐条对
 * 应如下：
 * 1. 登录态校验      → `requireAdmin()`，无会话直接抛，不会进入下面任何一步。
 * 2. 管理员白名单    → `requireAdmin()` 每次重查 `ADMIN_GITHUB_LOGIN`（不在
 *                      这里缓存，管理员被移除后旧会话立刻失效）。
 * 3. 参数校验        → 不用 Zod：媒体的输入是**二进制**，Zod 帮不上忙。改为
 *                      嗅探魔数（`sniffImage`）+ 体积上限，这比校验扩展名严格
 *                      得多 —— 扩展名可以随便改，魔数不能。
 * 4. 字段权限        → 媒体没有「某类型才认识的字段」，跳过。
 * 5. 乐观锁          → 不适用：上传永远是新增，删除以 id 为准。
 * 6. 事务与补偿      → 见 `uploadMediaAction` 里的「补偿事务」注释。
 * 7. 审计日志        → `writeAudit()`，**吞异常**，不因审计失败回滚已成功的上传。
 *
 * ── 为什么 `"use server"` 文件里导出的每一个值都必须是 async 函数 ────
 * Next 会把该文件里所有导出编译成 Server Function 端点。导出非函数（常量、
 * 类型以外的对象）会导致构建期报错；导出同步函数则会被当成 RPC 端点直接暴露。
 * 所以 `MediaActionResult` 是 `interface`（纯类型，编译后消失），
 * `INITIAL_STATE` 之类的值一概不放这里，放客户端组件的常量区。
 */

/** 一次媒体操作的返回值。与 `admin/actions.ts` 的 `ActionResult` 同构，便于前端复用提示样式。 */
export interface MediaActionResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  formError?: string;
  message?: string;
  media?: { id: string; url: string; path: string };
}

/**
 * 写一条审计日志。
 *
 * ── 为什么从 `auth.ts` 抄一份而不是 export 它 ────────────────────────
 * `writeAudit` 在 `auth.ts` 里是**私有**的（刻意不导出：审计是安全边界上的
 * 内部机制，不该成为公开 API）。而 `"use server"` 文件不能 import 一个
 * 未导出的符号。两个选择：把 `auth.ts` 的私有函数改成导出（要改既有文件，
 * 且会把内部机制暴露成公共接口），或在这里按同样契约写一份。选后者。
 *
 * ── 为什么吞掉所有异常 ───────────────────────────────────────────────
 * 与 `auth.ts:64-69` 的理由一致：审计写失败不该让一次**已经成功**的上传回滚。
 * 图片已经进了对象存储、媒体行已经落库，此时让用户看到 500 只会造成
 * 「以为没传成功，其实传了」的重复上传。失败时 `console.error` 留痕。
 */
async function writeAudit(entry: {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const db = await getAdminDb();
    await db.insert(auditLogs).values({
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      detail: entry.detail ?? {},
    });
  } catch (error) {
    console.error("[admin/media] 审计日志写入失败：", error);
  }
}

/** 把未知异常收敛成一句人话，语义与 `admin/actions.ts:122-131` 的 `describeError` 一致。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect/i.test(error.message)) {
      return "数据库连接失败，请检查 DATABASE_URL 或网络后重试。";
    }
    return error.message;
  }
  return String(error);
}

/**
 * 生成落盘文件名与 pathname。
 *
 * ── 为什么完全丢弃用户给的文件名 ────────────────────────────────────
 * 原始文件名是**不可信输入**：可能含中文（URL 编码后长度翻三倍）、空格、
 * `../`、Windows 保留字（`CON`、`NUL`）、以 `.` 开头（隐藏文件）、以及
 * 与已存在文件重名。逐个清洗这些情况是无穷的防御工事，而文件名对我们的
 * 唯一价值是「人能看出是什么图」—— 那应该记在 `alt` 里，不是文件名里。
 * 所以这里只保留**扩展名**，且扩展名由嗅探结果决定，不是用户给的。
 *
 * ── 为什么是 `时间戳 + 8 位 hex` 而不是 UUID ─────────────────────────
 * 时间戳让同一天上传的图按名字排序就是按时间排序（排查时有用）；hex 只用于
 * 抵消同一毫秒内并发上传的碰撞。8 位 hex = 32 bit，同一毫秒撞一次概率约
 * 2^-32，且真正负责唯一性的是 pathname 里的年月目录 + 数据库唯一索引 —— hex
 * 只是让人不撞在同一毫秒上。
 *
 * ── 为什么按月分目录 ────────────────────────────────────────────────
 * 单目录几千个文件在本地 `ls`、在 Blob 的 list 都难受。`media/<yyyy>/<mm>/`
 * 让每个目录的量级自然受限，且 pathname 自带时间信息，备份/清理时可按前缀操作。
 */
function buildPathname(mime: string, extension: string, now: Date): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const stamp = now.getTime();
  const suffix = randomBytes(4).toString("hex");
  return `media/${year}/${month}/${stamp}-${suffix}${extension}`;
}

/**
 * 上传一张图片。
 *
 * ── 校验顺序为什么是「体积 → 魔数 → 文件名」─────────────────────────
 * 体积校验必须在读 `arrayBuffer()` **之前**：`file.size` 是元数据，读完整
 * 字节流才有内存成本，先挡住大文件就不会为一个 500 MB 的请求分配内存。
 * 魔数校验必须在写存储**之前**：宁可拒掉一个伪装成 PNG 的可执行文件，
 * 也不让它进对象存储（进就进了，还带一个公网 URL）。
 */
export async function uploadMediaAction(formData: FormData): Promise<MediaActionResult> {
  let admin: { id: string };
  try {
    admin = await requireAdmin();
  } catch (error) {
    // 未登录 / 不在白名单：直接把原因返回给表单，不 throw —— throw 到页面会变成
    // 500，而这里其实是「你得先登录」，属于用户可修复的状态。
    return { ok: false, formError: describeError(error) };
  }

  const raw = formData.get("file");
  if (!(raw instanceof File)) {
    return { ok: false, fieldErrors: { file: "请选择一个图片文件。" } };
  }

  const file = raw;
  if (file.size === 0) {
    return { ok: false, fieldErrors: { file: "文件是空的，请重新选择。" } };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0);
    return { ok: false, fieldErrors: { file: `图片不能大于 ${mb} MB。` } };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // 不信 `file.type`：它由浏览器按扩展名猜测，且客户端可以随意伪造。
  // 只看字节头，也就是文件真正的格式。
  let info: ImageInfo;
  try {
    info = sniffImage(bytes);
  } catch (error) {
    if (error instanceof UnsupportedImageError) {
      return { ok: false, fieldErrors: { file: error.message } };
    }
    return { ok: false, formError: describeError(error) };
  }

  const extension = IMAGE_EXTENSIONS[info.mimeType];
  const pathname = buildPathname(info.mimeType, extension, new Date());

  let stored: StoredImage;
  try {
    stored = await putImage(pathname, bytes, info.mimeType);
  } catch (error) {
    return { ok: false, formError: `图片存储失败：${describeError(error)}` };
  }

  const altRaw = formData.get("alt");
  const alt = typeof altRaw === "string" ? altRaw.trim().slice(0, 300) : "";

  let row: MediaRow;
  try {
    row = await insertMedia({
      path: stored.path,
      url: stored.url,
      mimeType: stored.contentType,
      sizeBytes: stored.sizeBytes,
      width: info.width ?? null,
      height: info.height ?? null,
      alt,
    });
  } catch (error) {
    /*
      补偿事务，**不是真事务**：Postgres 的事务管不到对象存储。
      图片已经写进 Blob / public/media 了，此时数据库插入失败（唯一键冲突、
      连接断开……），必须尽力把文件删掉，否则存储里会积累一批没有任何行指向
      的孤儿文件 —— 它们永远不会被 `/admin/media` 列出来，只能靠人工按
      pathname 前缀清理。

      「尽力」的含义：`deleteImage` 自身也可能失败，那时只能记日志。
      不把删除失败抛给用户，因为用户真正需要知道的是「上传失败」。
    */
    try {
      await deleteImage(stored.path);
    } catch (cleanupError) {
      console.error("[admin/media] 上传回滚失败，存储中可能残留孤儿文件：", cleanupError);
    }
    return { ok: false, formError: `图片已存但登记失败：${describeError(error)}` };
  }

  await writeAudit({
    actorId: admin.id,
    action: "media.upload",
    entityType: "media",
    entityId: row.path,
    detail: { mimeType: row.mimeType, sizeBytes: row.sizeBytes, storage: isBlobConfigured() ? "blob" : "local" },
  });

  /*
    只刷后台路径，**不**用 `updateTag`。

    媒体不参与内容缓存标签体系（`ALL_ENTRIES_TAG` / `entriesTag` 那套描述的是
    「文章内容变了」）。一张新图上传不会改变任何一篇文章的 HTML —— 它还没被
    引用。用 `updateTag` 会把整站内容缓存无谓地打掉，代价是全站重新渲染，
    收益为零。

    `revalidatePath("/admin", "layout")` 的范围是后台整棵树，因为媒体库页面
    本身就在 /admin 下；用 "layout" 而不是 "page" 是为了让后台布局里可能存在的
    统计数字（媒体数）一起刷新。
  */
  revalidatePath("/admin", "layout");

  return {
    ok: true,
    message: `已上传 ${row.path}`,
    media: { id: row.id, url: row.url, path: row.path },
  };
}

/**
 * 删除一张图片。
 *
 * ── 顺序：引用检查 → 删数据库行 → 删存储文件 ────────────────────────
 * 反过来（先删文件）会在「删行失败」时留下**有记录、没文件**的破图，而这正是
 * 用户能看见的坏结果。当前顺序最坏只会留下没人引用的孤儿文件，属于可清理的
 * 垃圾。
 *
 * ── 为什么用 path 而不是 url 去删存储 ───────────────────────────────
 * `path` 是存储层主键（Blob pathname / 本地相对路径），`url` 是渲染地址。
 * 两者在 Blob 模式下形状不同（一个是 pathname、一个是绝对 URL）。用 `path`
 * 是唯一在两种模式下都正确的选择；`deleteImage` 也接受 URL，但那是为了兼容
 * 旧数据，不是这里的首选。
 */
export async function deleteMediaAction(formData: FormData): Promise<MediaActionResult> {
  let admin: { id: string };
  try {
    admin = await requireAdmin();
  } catch (error) {
    return { ok: false, formError: describeError(error) };
  }

  const idRaw = formData.get("id");
  const id = typeof idRaw === "string" ? idRaw.trim() : "";
  if (id.length === 0) {
    return { ok: false, formError: "缺少要删除的媒体 id。" };
  }

  let row: MediaRow | null;
  try {
    row = await getMediaById(id);
  } catch (error) {
    return { ok: false, formError: `读取媒体记录失败：${describeError(error)}` };
  }

  if (!row) {
    // 已经被别人删掉了。对用户是同样的结果（图不在了），按成功处理能让
    // 双击删除、两个标签页同时删这类常见操作不出现红色报错。
    return { ok: true, message: "这张图已经不在媒体库里了。" };
  }

  let references;
  try {
    references = await findMediaReferences(row.path);
  } catch (error) {
    // 引用检查失败时**必须中止**：宁可删不掉，也不能在不知道有没有引用的情况下删。
    return { ok: false, formError: `引用检查失败，已中止删除：${describeError(error)}` };
  }

  if (references.length > 0) {
    const preview = references
      .slice(0, 5)
      .map((reference) => `${reference.kind}/${reference.slug}`)
      .join("、");
    const more = references.length > 5 ? ` 等 ${references.length} 处` : "";
    return {
      ok: false,
      formError: `该图被 ${references.length} 处引用，先解除引用再删：${preview}${more}`,
    };
  }

  try {
    await deleteMediaRow(row.id);
  } catch (error) {
    return { ok: false, formError: `删除媒体记录失败：${describeError(error)}` };
  }

  /*
    文件删除失败**不回滚数据库**，也不向用户报错。

    理由：此时媒体行已经删掉，从系统视角看「这张图不存在了」——没有任何页面
    会引用它（引用检查刚通过）。存储里残留一个文件是可清理的垃圾，而把它报成
    「删除失败」会让用户重试，重试时 `getMediaById` 返回 null、直接回「已经不在
    媒体库里了」，形成一段自相矛盾的体验。所以只留日志。
  */
  try {
    await deleteImage(row.path);
  } catch (error) {
    console.error(`[admin/media] 媒体行已删除但文件删除失败：${row.path}`, error);
  }

  await writeAudit({
    actorId: admin.id,
    action: "media.delete",
    entityType: "media",
    entityId: row.path,
    detail: { mimeType: row.mimeType, sizeBytes: row.sizeBytes },
  });

  revalidatePath("/admin", "layout");

  return { ok: true, message: `已删除 ${row.path}` };
}
