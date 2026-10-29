import type { CapabilityAvailability } from "@/lib/ops/capabilities";

/**
 * 运维台共用的小展示件。
 *
 * ── 为什么单独抽一个文件 ─────────────────────────────────────────────
 * 五张子页都要画「通过 / 失败」「可用 / 不可用」「耗时」这几种状态徽章。
 * 各页各写一份的结果是颜色阈值与文案不一致 —— 同一个失败在一页是红色、
 * 在另一页是黄色，运维者就得重新学一遍每页的语义。这里统一。
 *
 * ── 为什么不放 `components/` 下 ──────────────────────────────────────
 * 这些件只被 `/admin/ops` 用到，没有第二个消费者。放在页面目录里，
 * 未来删掉运维台时一起删，不留孤儿。
 */

/** 三态徽章的色调。 */
type Tone = "ok" | "warn" | "error" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  ok: "border-success/35 text-success",
  warn: "border-warning/40 text-warning",
  error: "border-error/35 text-error",
  muted: "border-border text-muted",
};

const TONE_LABEL: Record<Tone, string> = {
  ok: "通过",
  warn: "提醒",
  error: "失败",
  muted: "未知",
};

/** 通过 / 失败徽章。`tone` 缺省时由 `ok` 推导。 */
export function ResultBadge({ ok, label }: { ok: boolean; label?: string }) {
  const tone: Tone = ok ? "ok" : "error";
  return <Chip tone={tone} label={label ?? TONE_LABEL[tone]} />;
}

/** 通用小方块（换皮后统一成 1px 直角，与全站铭牌语汇一致）。 */
export function Chip({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-xs border px-2 py-0.5 font-mono text-[11px] tracking-[0.04em] ${TONE_CLASS[tone]}`}
    >
      {label}
    </span>
  );
}

/** 能力可用性徽章。 */
export function AvailabilityBadge({ availability }: { availability: CapabilityAvailability }) {
  switch (availability) {
    case "available":
      return <Chip tone="ok" label="可用" />;
    case "disabled":
      return <Chip tone="warn" label="按设计关闭" />;
    default:
      return <Chip tone="muted" label="不可用" />;
  }
}

/** 「通过 12 / 14」这种分数，颜色跟着是否全绿。 */
export function ScoreBadge({ passed, total }: { passed: number; total: number }) {
  const tone: Tone = total > 0 && passed === total ? "ok" : passed === 0 ? "error" : "warn";
  return <Chip tone={tone} label={`${passed} / ${total}`} />;
}

/** 一行「键 → 值」，等宽显示值。 */
export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="break-all font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}

/** 页面级空态 / 错误提示。 */
export function Notice({
  tone,
  children,
}: {
  tone: "warn" | "error" | "info";
  children: React.ReactNode;
}) {
  const cls =
    tone === "error"
      ? "border-error/40 bg-error/10 text-error"
      : tone === "warn"
        ? "border-warning/40 bg-warning/10 text-warning"
        : "border-border bg-surface text-muted";
  return (
    <p role={tone === "error" ? "alert" : undefined} className={`mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed ${cls}`}>
      {children}
    </p>
  );
}

/** 段落骨架（Suspense fallback 用）。 */
export function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="mt-6 space-y-2" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg border border-border bg-elevated" />
      ))}
    </div>
  );
}
