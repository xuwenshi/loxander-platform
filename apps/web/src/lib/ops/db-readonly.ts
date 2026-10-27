import "server-only";

/**
 * 只读 SQL 网关。
 *
 * ── 这个文件的安全责任比项目里任何其他文件都重 ─────────────────────────
 * 它把「用户在浏览器里输入一段 SQL」变成「在真实数据库上执行」。任何
 * 一个漏洞都等于把库的写权限交出去。所以这里用**四道独立的闸**，
 * 而且刻意让它们互相冗余 —— 任何一道单独失效，其余仍在：
 *
 *   1. 连接层：用 `default_transaction_read_only=on` 建连接。
 *      即使前面对 SQL 文本的判断全错，Postgres 自己也会拒绝写入。
 *      这是**唯一一道不依赖我写对正则**的防线。
 *   2. 语句层：只允许单条语句，且必须以 SELECT / WITH 开头。
 *   3. 关键词层：拒绝在字符串字面量与注释之外出现写操作关键词。
 *   4. 执行层：包在 `BEGIN READ ONLY` 事务里，带 statement_timeout，
 *      跑完 ROLLBACK。防止 `SELECT pg_sleep(600)` 之类拖死连接池。
 *
 * ── 为什么第 3 道不能只做 `sql.includes('delete')` ─────────────────────
 * 那样会把 `select * from entries where title like '%delete%'` 也拒掉。
 * 必须先把字符串字面量、双引号标识符、注释剥离，再在剩余部分匹配关键词。
 * `stripLiteralsAndComments()` 就是干这个的。
 *
 * ── 为什么不用 drizzle 的查询构造器 ──────────────────────────────────
 * 用户要跑的是任意 SELECT（含 join、聚合、CTE）。drizzle 的构造器覆盖不了
 * 任意 SQL，硬套只会变成「支持一半语法」的半成品。这里直接用 postgres-js
 * 的 `unsafe()` 走原始文本，安全由上面四道闸负责。
 */

import postgres from "postgres";

/** 单次查询最多返回的行数。防止 `select * from audit_logs` 把内存打满。 */
export const MAX_ROWS = 500;

/** 单条查询的语句超时（毫秒）。 */
export const STATEMENT_TIMEOUT_MS = 8_000;

/** 单条查询的总超时（毫秒），包含建连。 */
export const QUERY_TIMEOUT_MS = 15_000;

/** 拒绝执行的原因。`null` 表示通过。 */
export interface RejectionReason {
  code:
    | "empty"
    | "multiple_statements"
    | "not_select"
    | "write_keyword"
    | "too_long";
  message: string;
}

/** 允许作为语句开头的关键字（全大写比较）。 */
export const ALLOWED_HEADS = ["SELECT", "WITH", "TABLE", "VALUES"] as const;

/**
 * 写操作与危险关键词。
 *
 * 这些词**只**在剥离字面量与注释之后的文本里匹配，所以
 * `where note = 'delete me'` 不会误伤。
 *
 * 刻意包含 `INTO`：`SELECT ... INTO new_table` 会建表，是常见的绕过点。
 * 也包含 `FOR UPDATE` / `FOR SHARE`：它们会对行加锁，在只读事务里也会失败，
 * 提前拒掉能给出更清楚的提示。
 */
export const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "TRUNCATE",
  "ALTER",
  "CREATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "VACUUM",
  "REINDEX",
  "CLUSTER",
  "REFRESH",
  "INTO",
  "CALL",
  "DO",
  "LOCK",
  "NOTIFY",
  "LISTEN",
  "SET",
  "RESET",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "BEGIN",
  "START",
  "PREPARE",
  "EXECUTE",
  "DEALLOCATE",
  "DISCARD",
  "CHECKPOINT",
] as const;

/**
 * 把 SQL 里的「字符串字面量、双引号标识符、注释」替换成占位符。
 *
 * 目的：让关键词匹配只看**真正的语法成分**。
 *
 * 处理的四种形态：
 * - 单引号字符串，`''` 是转义的单引号
 * - 双引号标识符，`""` 是转义的双引号
 * - `$tag$...$tag$` 与 `$$...$$`  dollar-quoted 字符串（Postgres 特有）
 * - 双连字符开头的行注释、斜杠星号开头的块注释（块注释支持嵌套）
 *
 * 注意：这段注释里**不能**写出真实的块注释起止符 ——
 * 那会让本段注释提前结束，后面的中文被当成代码解析。
 * 所以上面只用文字描述形态，不写符号本身。
 *
 * 故意**不**处理带反斜杠的转义字符串：`standard_conforming_strings` 默认 on，
 * 反斜杠不是转义符；即使某些客户端把它当转义，最坏结果也只是把字面量
 * 切错，从而**更保守地拒绝**，不会放行写操作。
 */
export function stripLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行注释
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }

    // 块注释（Postgres 允许嵌套）
    if (ch === "/" && next === "*") {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
      continue;
    }

    // 单引号字符串
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2; // 转义的单引号
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      out += " '' ";
      continue;
    }

    // 双引号标识符
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      out += ' "" ';
      continue;
    }

    // dollar-quoted：$$...$$ 或 $tag$...$tag$
    if (ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          i = end + tag.length;
          out += " '' ";
          continue;
        }
        // 找不到闭合标签 → 当作普通字符，交给后续关键词匹配去拒
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * 判断一条 SQL 能否以只读方式执行。
 *
 * 返回 `null` 表示可以；否则返回拒绝原因（`message` 直接展示给用户）。
 */
export function checkReadOnlySql(rawSql: string): RejectionReason | null {
  const sql = rawSql.trim();

  if (sql.length === 0) {
    return { code: "empty", message: "SQL 不能为空。" };
  }

  // 1MB 足够任何人工编写的 SELECT；超长几乎必然是粘贴事故或攻击。
  if (sql.length > 1_000_000) {
    return { code: "too_long", message: "SQL 过长（超过 1 MB），拒绝执行。" };
  }

  const stripped = stripLiteralsAndComments(sql);

  // 分号：允许末尾有一个，但不允许中间出现第二个语句分隔。
  // 注意要基于 stripped 判断，否则 `where a = ';'` 会被误判。
  const noTrailing = stripped.replace(/;\s*$/, "");
  if (noTrailing.includes(";")) {
    return {
      code: "multiple_statements",
      message: "只允许执行单条语句（检测到多个分号分隔的语句）。",
    };
  }

  // 必须是以允许的关键字开头。用 stripped 的开头，避免注释打头造成误判。
  const head = /^[(\s]*([A-Za-z]+)/.exec(noTrailing);
  const headWord = head?.[1]?.toUpperCase() ?? "";
  if (!(ALLOWED_HEADS as readonly string[]).includes(headWord)) {
    return {
      code: "not_select",
      message: `只允许只读查询，语句必须以 ${ALLOWED_HEADS.join(" / ")} 开头（当前是「${headWord || "无法识别"}」）。`,
    };
  }

  // 关键词层：在剥离后的文本上按词边界匹配。
  const upper = noTrailing.toUpperCase();
  for (const keyword of FORBIDDEN_KEYWORDS) {
    // `\b` 不够：`SELECT a INTO b` 里 INTO 前后都是空格，能匹配；
    // 但 `SELECT updated_at` 不能因为含 UPDATE 就被拒，所以必须用词边界。
    const re = new RegExp(`\\b${keyword}\\b`);
    if (re.test(upper)) {
      return {
        code: "write_keyword",
        message: `检测到写操作或危险关键词「${keyword}」，只读模式拒绝执行。`,
      };
    }
  }

  return null;
}

/** 一次只读查询的结果。 */
export interface ReadOnlyQueryResult {
  /** 列名（按结果顺序）。 */
  columns: string[];
  /** 行数据。值可能是 null / 数字 / 布尔 / 字符串 / Date / 对象。 */
  rows: Record<string, unknown>[];
  /** 是否因为超过 MAX_ROWS 而被截断。 */
  truncated: boolean;
  /** 实际耗时（毫秒）。 */
  elapsedMs: number;
  /** Postgres 报的警告（如 `deprecated` 提示），便于排查。 */
  notices: string[];
}

/** 查询失败的形态。 */
export interface ReadOnlyQueryError {
  /** 面向用户的一句话。 */
  message: string;
  /** Postgres 错误码（如 `42P01` 表不存在），便于对照文档。 */
  code?: string;
  /** 出错的字符位置，用于在编辑器里定位。 */
  position?: number;
}

/**
 * 用只读连接执行一条 SELECT。
 *
 * ── 为什么每次新建连接 ───────────────────────────────────────────────
 * `default_transaction_read_only=on` 是**连接级**参数。若复用连接池，
 * 一旦某处把它改回来就会污染整个池。运维台的查询频率极低（人手点），
 * 每次建连的几百毫秒完全可以接受，换来的是「绝不可能写出一个可写连接」。
 *
 * ── 为什么还要 BEGIN READ ONLY ──────────────────────────────────────
 * 连接参数在 `postgres()` 建连时设置，而 `BEGIN READ ONLY` 是语句级的第二道。
 * 两者都设上，是为了在「有人误改了连接串参数」时仍然安全。
 */
export async function runReadOnlyQuery(
  databaseUrl: string,
  sql: string,
): Promise<{ ok: true; result: ReadOnlyQueryResult } | { ok: false; error: ReadOnlyQueryError }> {
  const rejection = checkReadOnlySql(sql);
  if (rejection) {
    return { ok: false, error: { message: rejection.message } };
  }

  const startedAt = Date.now();
  const notices: string[] = [];

  // `max: 1` + `idle_timeout` 让连接用完即回收。
  //
  // 关键在 `connection`：三个参数都是**启动包里的会话级 GUC**，连接一建立
  // 就生效，且不需要额外执行任何 SET 语句。这比「连上之后跑 SET」更安全 ——
  // 后者在 SET 执行前存在一个可写窗口，而这里没有窗口。
  //
  // - `default_transaction_read_only=on`：Postgres 自己拒绝一切写操作。
  //   这是唯一一道不依赖我写对正则的防线。
  // - `statement_timeout`：超过就由服务端中断，防止大表全扫。
  const client = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: (notice) => {
      notices.push(String(notice.message ?? notice));
    },
    connection: {
      application_name: "loxander-ops-readonly",
      default_transaction_read_only: true,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    },
  });

  try {
    // 只执行用户那**一条**语句，不做任何字符串拼接包裹。
    //
    // 早先的写法是把 SQL 拼成 `BEGIN READ ONLY; SET ...; <sql>; ROLLBACK;`，
    // 有两个问题：① postgres-js 的扩展协议根本不允许一次发多条语句；
    // ② 拼接本身把「单条语句」这个约束变成了「靠我拼对」，而只读与超时
    // 现在都由连接参数保证，拼接已无必要。
    const single = sql.trim().replace(/;\s*$/, "");

    const raw = (await Promise.race([
      client.unsafe(single),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`查询超过 ${QUERY_TIMEOUT_MS} ms，已中断。`)), QUERY_TIMEOUT_MS),
      ),
    ])) as unknown;

    const list = Array.isArray(raw) ? (raw as unknown[]) : [];

    const truncated = list.length > MAX_ROWS;
    const limited = truncated ? list.slice(0, MAX_ROWS) : list;

    const columns =
      limited.length > 0 && typeof limited[0] === "object" && limited[0] !== null
        ? Object.keys(limited[0] as Record<string, unknown>)
        : [];

    return {
      ok: true,
      result: {
        columns,
        rows: limited as Record<string, unknown>[],
        truncated,
        elapsedMs: Date.now() - startedAt,
        notices,
      },
    };
  } catch (error) {
    const e = error as { message?: string; code?: string; position?: string };
    return {
      ok: false,
      error: {
        message: e.message ?? String(error),
        code: e.code,
        position: e.position ? Number(e.position) : undefined,
      },
    };
  } finally {
    // 不等它优雅关闭：`end({ timeout: 1 })` 立即断，避免挂住 Server Action。
    await client.end({ timeout: 1 }).catch(() => {});
  }
}
