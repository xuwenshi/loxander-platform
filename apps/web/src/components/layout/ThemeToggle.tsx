"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

import { MonitorIcon, MoonIcon, SunIcon } from "@/components/ui/Icons";

type Theme = "system" | "light" | "dark";
type Accent = "copper" | "ice" | "terra" | "moss" | "silver";

const STORAGE_KEY = "theme";
/** 强调色用独立 key：不能复用 `theme`，否则 layout 的首帧脚本会读到非法值 */
const ACCENT_KEY = "accent";
/** 自定义事件：localStorage 的 storage 事件不会在本标签页触发，需要自己通知订阅者 */
const CHANGE_EVENT = "themechange";

const LABELS: Record<Theme, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

/* 三态的顺序决定按钮排列：浅 → 深 → 跟随 */
const MODES: Theme[] = ["light", "dark", "system"];
const MODE_ICONS: Record<Theme, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

/**
 * 五个色板点的身份色（浅色模式下的取值，与 globals.css 的
 * `html[data-accent="…"]` 一一对应）。
 *
 * 这里的字面量是**色板的身份**，不是页面配色 —— 和 lib/cosmic.ts 的
 * 宇宙层恒定额色同一性质，因此列在 a11y 审计的 ALLOWED_LITERAL_FILES 里。
 */
const ACCENTS: { key: Accent; label: string; swatch: string }[] = [
  { key: "copper", label: "铜金", swatch: "#96693a" },
  { key: "ice", label: "冰蓝", swatch: "#2a6e86" },
  { key: "terra", label: "赤陶", swatch: "#a44a30" },
  { key: "moss", label: "苔绿", swatch: "#5c743a" },
  { key: "silver", label: "银灰", swatch: "#5c6470" },
];

const THEME_COLORS = { dark: "#05070a", light: "#f6f2e9" } as const;

/* --------------------------------------------------------------------------
   主题是一个「外部状态」：它存在 localStorage、<html> 的 class 与 data-accent 上。
   因此用 useSyncExternalStore 读取，而不是在 useEffect 里 setState。
-------------------------------------------------------------------------- */

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function isAccent(value: unknown): value is Accent {
  return ACCENTS.some((accent) => accent.key === value);
}

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // 隐私模式下访问 localStorage 可能抛错，退回到默认主题
  }
  // 与 layout 的 themeInitScript 保持一致：首次访问默认深色（宇宙）
  return "dark";
}

function readAccent(): Accent {
  try {
    const stored = window.localStorage.getItem(ACCENT_KEY);
    if (isAccent(stored)) return stored;
  } catch {
    /* 同上 */
  }
  return "copper";
}

/** 服务端与 hydration 阶段返回默认值，让首屏与最常见的实际状态吻合 */
function readServerTheme(): Theme {
  return "dark";
}

function readServerAccent(): Accent {
  return "copper";
}

function subscribeTheme(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * 主题切换：浅色 / 深色 / 跟随系统 三态，外加五套强调色。
 *
 * 页面首次渲染前由 layout 中的内联脚本应用真实主题与强调色，
 * 这里只负责「用户点击切换」与「跟随系统时的实时同步」。
 */
export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, readServerTheme);
  const accent = useSyncExternalStore(subscribeTheme, readAccent, readServerAccent);

  /** 520ms 过渡窗口的定时器：连续点时只保留最后一个，避免提前摘掉 .theming */
  const themingTimer = useRef<number | null>(null);

  // 卸载时清掉未到期的定时器，否则会对已卸载的 DOM 做 classList 操作
  useEffect(() => {
    return () => {
      if (themingTimer.current !== null) window.clearTimeout(themingTimer.current);
    };
  }, []);

  // 把状态同步到 <html> —— 这是对外部系统（DOM）的写入，属于 effect 的正当用途
  useEffect(() => {
    const root = document.documentElement;

    const sync = () => {
      const isDark =
        theme === "dark" ||
        (theme === "system" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", isDark);
      root.style.colorScheme = isDark ? "dark" : "light";
      // 同步浏览器界面配色：主题由 class 决定，媒体查询的 meta 猜不准
      for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
        meta.setAttribute(
          "content",
          isDark ? THEME_COLORS.dark : THEME_COLORS.light,
        );
      }
    };

    sync();

    // 只有「跟随系统」时才需要监听系统主题变化
    if (theme !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [theme]);

  // 强调色：写在 <html data-accent> 上，copper 是默认值（移除属性即回到默认）
  useEffect(() => {
    const root = document.documentElement;
    if (accent === "copper") {
      root.removeAttribute("data-accent");
    } else {
      root.setAttribute("data-accent", accent);
    }
  }, [accent]);

  /**
   * 切色时的 520ms 过渡窗口（对应 `_prototype/redesign.html:1939-1948`）。
   *
   * 为什么需要它：换色是把 `--accent` / `--background` 这批 CSS 变量整块换掉，
   * 而变量替换本身是瞬时的 —— 浏览器不会给「变量变了」加过渡。
   * 于是在 <html> 上临时挂一个 `.theming`，用 globals.css 里那条
   * `.theming …{ transition: background-color 520ms … }` 规则
   * 给这批会变色的属性补一条过渡，520ms 后摘掉，避免长期拖慢别处的动画。
   */
  const openThemingWindow = useCallback(() => {
    const root = document.documentElement;
    root.classList.add("theming");
    if (themingTimer.current !== null) window.clearTimeout(themingTimer.current);
    themingTimer.current = window.setTimeout(() => {
      root.classList.remove("theming");
      themingTimer.current = null;
    }, 520);
  }, []);

  const pickTheme = useCallback(
    (next: Theme) => {
      openThemingWindow();
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* 隐私模式下写不进去：本次切换仍然生效，只是不记忆 */
      }
      // 通知订阅者重新读取，state 会随之更新
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [openThemingWindow],
  );

  const pickAccent = useCallback(
    (next: Accent) => {
      openThemingWindow();
      try {
        window.localStorage.setItem(ACCENT_KEY, next);
      } catch {
        /* 同上 */
      }
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [openThemingWindow],
  );

  return (
    <>
      <span className="accent-dots" role="group" aria-label="强调色">
        {ACCENTS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => pickAccent(item.key)}
            aria-pressed={accent === item.key}
            aria-label={`强调色：${item.label}`}
            title={item.label}
            className="accent-dot"
            style={{ "--sw": item.swatch } as CSSProperties}
          />
        ))}
      </span>

      <span className="mode-group" role="group" aria-label="主题模式">
        {MODES.map((mode) => {
          const Icon = MODE_ICONS[mode];
          return (
            <button
              key={mode}
              type="button"
              onClick={() => pickTheme(mode)}
              aria-pressed={theme === mode}
              aria-label={`主题：${LABELS[mode]}`}
              title={LABELS[mode]}
              className="mode-btn"
            >
              <Icon width={15} height={15} />
            </button>
          );
        })}
      </span>
    </>
  );
}
