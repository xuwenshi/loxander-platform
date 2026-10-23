import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import {
  buildSettingsReport,
  type CapabilityItem,
  type ConfigItem,
  type ConfigState,
  type SettingsReport,
} from "@/lib/admin/settings";

export const metadata: Metadata = { title: "设置" };

/**
 * 后台设置页（`/admin/settings`）：运维自检面板。
 *
 * ── 这一页为什么不提供「修改」按钮 ───────────────────────────────────
 * 方案 §13.5（`动态网站平台化执行方案.md:1084`）定的是「生产环境变量只在
 * Vercel 配置」。让后台能改 `DATABASE_URL` / `AUTH_SECRET` 意味着一个普通
 * 后台账号就能把全站数据库指针改到别处，而且新密钥会先落到我们自己的库里
 * —— 那就不叫「只在 Vercel」了。所以这里**只读**：告诉你现在是什么状态、
 * 缺什么、去哪里补；真正的修改动作在 Vercel 控制台的
 * Project Settings → Environment Variables。
 *
 * ── 为什么守卫不写在这里 ─────────────────────────────────────────────
 * `app/admin/layout.tsx:71-96` 的 `AdminGuard` 已经拦过一道（`getAdminSession()`
 * 取不到就跳 `/login`），并且它是**放在布局里**的，注释（`layout.tsx:48-51`）
 * 写明这样新加的页面不会忘。这一页同样不重复写。
 *
 * ── 为什么还是要 `connection()` ──────────────────────────────────────
 * 这一页读的全是 `process.env`，静态预渲染也不会报错。但「自检面板」的语义是
 * 「**当前正在跑的进程**看到的是什么」：构建机与运行实例的环境变量未必一致
 * （本地 `next build` 后换 `.env` 再 `next start` 就是典型反例），
 * 静态烘焙出来的值会安静地骗人。`connection()` 把这段子树钉到请求时刻，
 * 与 `/admin`（`app/admin/page.tsx:44-48`）同一形态。
 * 文档：`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/connection.md`。
 *
 * ── 为什么窄屏用 overflow-x-auto 而不是网格 ──────────────────────────
 * 配置表有四列且「用途」「提示」是长中文，换成网格就得为每种状态重新排版、
 * 而且列对不齐时人眼没法竖着扫。横向滚动保住了「一行一个变量」的对齐关系，
 * 配合 `min-w-[760px]` 让桌面端铺满、手机端可滑。这与 `/admin/content`、
 * `/admin/audit` 的做法一致。
 */
export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsBody />
    </Suspense>
  );
}

async function SettingsBody() {
  await connection();

  const report = buildSettingsReport();

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">设置</h1>
        <p className="mt-1 text-sm text-muted">
          环境变量与能力开关的自检。本页只读 —— 按照方案 §13.5，生产环境变量只在
          Vercel 配置，改动请去 Vercel 控制台的 Project Settings → Environment
          Variables，改完需要重新部署才生效。
        </p>
      </header>

      <p className="mt-6 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        所有密钥在这里都经过脱敏：连接串只保留用户名与主机，令牌只显示字符数。
        §13.5（`:1087`）还要求定期轮换 OAuth Secret 与 Blob Token ——
        本页可以帮助你确认「换没换到」，但不能代替轮换操作本身。
      </p>

      <EnvironmentSection environment={report.environment} />
      <ConfigSection items={report.configs} />
      <CapabilitySection items={report.capabilities} />
    </div>
  );
}

/** 环境摘要：三个数字，用芯片并排。 */
function EnvironmentSection({ environment }: { environment: SettingsReport["environment"] }) {
  const entries: { label: string; value: string }[] = [
    { label: "运行环境", value: environment.nodeEnv },
    { label: "内容源", value: environment.contentSource },
    { label: "版本", value: environment.version },
  ];

  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-foreground">环境摘要</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {entries.map((entry) => (
          <span
            key={entry.label}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-1.5 text-xs"
          >
            <span className="text-muted">{entry.label}</span>
            <span className="font-mono text-foreground">{entry.value}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

/** 配置项表：一行一个环境变量，`hint` 存在时追加一条整宽说明行。 */
function ConfigSection({ items }: { items: ConfigItem[] }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-foreground">配置项</h2>
      <p className="mt-1 text-xs text-muted">
        共 {items.length} 项。状态取值：<span className="text-success">ok</span> 可用、
        <span className="text-error"> missing </span>缺失（该能力不可用）、
        <span className="text-warning"> weak </span>能跑但有问题、
        <span className="text-muted"> unused </span>设置了但没人读。
      </p>

      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-elevated">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th scope="col" className="px-3 py-2.5 font-medium">
                变量
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                状态
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                当前值
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                用途
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <ConfigRow key={item.key} item={item} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ConfigRow({ item }: { item: ConfigItem }) {
  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-surface">
        <td className="whitespace-nowrap px-3 py-2.5 align-top font-mono text-xs text-foreground">
          {item.key}
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 align-top">
          <ConfigStateBadge state={item.state} />
        </td>
        <td className="px-3 py-2.5 align-top text-xs text-muted">{item.summary}</td>
        <td className="px-3 py-2.5 align-top text-xs text-muted">{item.purpose}</td>
      </tr>
      {item.hint ? (
        <tr className="border-b border-border last:border-0">
          <td colSpan={4} className="bg-surface px-3 pb-2.5 pt-0">
            <p className={`text-xs ${HINT_TONE[item.state]}`}>
              <span className="mr-1 text-muted">提示</span>
              {item.hint}
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * 四态徽标。
 *
 * ── 为什么不复用 `AdminStatusPill` ─────────────────────────────────────
 * 那个组件（`components/admin/status-pill.tsx:20-38`）吃的是内容发布状态
 * （draft / scheduled / published / archived），并通过 `STATUS_LABELS` 查中文。
 * 这里的四个状态是**配置健康度**，两套枚举没有交集，硬塞进去只会让
 * `status` 参数变成两种含义。所以本地实现一个小的，色取同一组语义令牌
 * （`success` / `warning` / `error` / `muted`），暗色模式自动跟随。
 *
 * ── 为什么 `unused` 用 `text-muted` 而不是 `text-muted-deep` ──────────
 * 实测：本仓库的 `app/globals.css` 只在 `:root` 里声明了短名 `--muted-deep`
 * （`:30`、暗色 `:89`），并把它映射成**规范名** `--color-text-muted`（`:44`），
 * 但 `@theme inline`（`:106-137`）里没有 `--color-muted-deep` 这一项。
 * 用 Tailwind 4.3.3 的 `compile()` 实际编译 `globals.css` 并请求
 * `text-muted-deep` / `text-error` / `text-success` 等 62 个类名，结果
 * 只有 `text-muted-deep` 一个类**没有产出任何 CSS 规则**（生成的样式表里
 * 只有变量声明 `--muted-deep: #7c879b`，没有 `.text-muted-deep{}`）。
 * 也就是说 `text-muted-deep` 是个静默失效的类名：不报错、不上色。
 * 既有代码里确实有多处这么写（`admin/audit/page.tsx:142` 等），那是既有欠账，
 * 不在本任务的写入范围内 —— 但新代码不该再增加同类问题。
 */
const STATE_TONE: Record<ConfigState, string> = {
  ok: "border-success/35 text-success",
  missing: "border-error/35 text-error",
  weak: "border-warning/40 text-warning",
  unused: "border-border text-muted",
};

const STATE_LABEL: Record<ConfigState, string> = {
  ok: "ok",
  missing: "missing",
  weak: "weak",
  unused: "unused",
};

const HINT_TONE: Record<ConfigState, string> = {
  ok: "text-muted",
  missing: "text-error",
  weak: "text-warning",
  unused: "text-muted",
};

function ConfigStateBadge({ state }: { state: ConfigState }) {
  const tone = STATE_TONE[state];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

/** 能力开关表：回答「现在这台机器上哪些功能是通的」。 */
function CapabilitySection({ items }: { items: CapabilityItem[] }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-foreground">能力开关</h2>
      <p className="mt-1 text-xs text-muted">
        由上面的环境变量组合推导，不是独立配置 —— 改变量即可，无需额外开关。
      </p>

      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-elevated">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th scope="col" className="px-3 py-2.5 font-medium">
                能力
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                状态
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                判定依据
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.name}
                className="border-b border-border last:border-0 hover:bg-surface"
              >
                <td className="whitespace-nowrap px-3 py-2.5 align-top text-xs font-medium text-foreground">
                  {item.name}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 align-top">
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                      item.enabled
                        ? "border-success/35 text-success"
                        : "border-border text-muted"
                    }`}
                  >
                    {item.enabled ? "已启用" : "未启用"}
                  </span>
                </td>
                <td className="px-3 py-2.5 align-top text-xs text-muted">{item.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SettingsSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="h-6 w-24 animate-pulse rounded bg-surface" />
      <div className="mt-3 h-4 w-full max-w-xl animate-pulse rounded bg-surface" />
      <div className="mt-6 h-12 animate-pulse rounded-xl border border-border bg-elevated" />
      <div className="mt-8 h-64 animate-pulse rounded-xl border border-border bg-elevated" aria-busy="true" />
    </div>
  );
}
