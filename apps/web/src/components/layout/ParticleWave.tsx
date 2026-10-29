"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { useReducedMotion } from "@/lib/useReducedMotion";

/**
 * 粒子浪潮（鼠标推斥的呼吸网格）。
 *
 * 原型 `_prototype/redesign.html:342-348` 的 `#wave` 画布 + `:2150-2188` 的
 * `drawWave()`。它是「观测站」最显眼的一层底色：13 行 × 66 列的 1–3px 方点
 * 随时间起伏，越靠左越亮（回应「左边太空洞」），指针靠近时向外推开并转成铜金。
 *
 * 三条约束，与原型一致：
 * - `pointer-events: none` + `aria-hidden`：纯装饰，绝不参与交互与无障碍树；
 * - 减动效偏好下完全不挂载：这是一个持续动画，不是静态质感；
 * - 触屏上不做鼠标推斥（没有指针），并且隔帧绘制 —— 手机上持续 60fps 的
 *   背景动画是实打实的耗电，改成一秒 30 次肉眼无差。
 *
 * 配色从 CSS 变量读（`--ink-rgb` / `--warm-rgb`）：canvas 拿不到 CSS 变量，
 * 只能在挂载时和主题切换时各读一次 `getComputedStyle`。切主题时 ThemeToggle
 * 会派发 `themechange`，这里监听它重新取色，避免点还是上一个主题的颜色。
 *
 * 后台与登录页不挂：那里是密集表单与表格，飘动的点没有收益只会干扰读数。
 */

/** 列数 / 行数：与原型一致，横向密、纵向疏，读起来像一层薄纱 */
const COLS = 66;
const ROWS = 13;
/** 设备像素比上限。超过 1.6 收益极小，但填充率翻倍 */
const MAX_DPR = 1.6;
/** 指针推斥的作用半径（px）与最大位移 */
const REPEL_RADIUS = 228;
const REPEL_STRENGTH = 30;
/** ThemeToggle 切主题时派发的事件名（与 components/layout/ThemeToggle.tsx 保持一致） */
const THEME_EVENT = "themechange";

/** 只在这些路径前缀下渲染。`/` 是宇宙层首页，必须画 */
const EXCLUDED_PREFIXES = ["/admin", "/login"];

export default function ParticleWave() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = useReducedMotion();
  const pathname = usePathname();

  const excluded = EXCLUDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  useEffect(() => {
    if (reduced || excluded) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const coarse = window.matchMedia("(hover: none), (pointer: coarse)").matches;

    let width = 0;
    let height = 0;
    let dpr = 1;
    /** 指针位置；-9999 表示指针不在视口里 */
    let mx = -9999;
    let my = -9999;
    /** 调色板：["185,138,90", "233,229,219"] 这样的裸三元组，拼进 rgba() */
    let inkRGB = "233,229,219";
    let warmRGB = "233,201,162";

    const readPalette = () => {
      const style = getComputedStyle(document.documentElement);
      const ink = style.getPropertyValue("--ink-rgb").trim();
      const warm = style.getPropertyValue("--warm-rgb").trim();
      if (ink) inkRGB = ink;
      if (warm) warmRGB = warm;
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);

      for (let r = 0; r < ROWS; r += 1) {
        const amp = 14 + r * 7;
        const baseY =
          height * 0.3 + r * (height * 0.052) + Math.sin(t * 0.00016 + r * 0.5) * 8;

        for (let c = 0; c < COLS; c += 1) {
          const cx = (c / (COLS - 1)) * (width + 120) - 60;
          const ph = t * 0.00052 + c * 0.19 + r * 0.44;
          let x = cx + Math.sin(ph * 0.4) * 9;
          let y = baseY + Math.sin(ph) * amp + Math.cos(ph * 0.62) * amp * 0.34;

          // 鼠标推斥：近距离向外推，同时把点提亮
          let near = 0;
          const dx = x - mx;
          const dy = y - my;
          const d2 = dx * dx + dy * dy;
          if (d2 < 52000 && d2 > 0.5) {
            const d = Math.sqrt(d2);
            const f = (1 - d / REPEL_RADIUS) * REPEL_STRENGTH;
            x += (dx / d) * f;
            y += (dy / d) * f;
            near = (1 - d / REPEL_RADIUS) * 0.7;
          }

          // 左侧更亮更密：最左 1.0 → 最右 0.14
          const leftBias = 1 - (c / (COLS - 1)) * 0.86;
          const alpha = (0.03 + leftBias * 0.24) * (0.55 + near);
          if (alpha < 0.012) continue;

          const size = 1.1 + (r / ROWS) * 0.85 + near * 1.6;
          ctx.fillStyle =
            near > 0.25
              ? `rgba(${warmRGB},${(alpha * 1.5).toFixed(3)})`
              : `rgba(${inkRGB},${alpha.toFixed(3)})`;
          ctx.fillRect(x, y, size, size);
        }
      }
    };

    let frame = 0;
    let last = 0;
    // 触屏隔帧绘制：一秒 30 次，肉眼与 60 次无差，耗电减半
    const minDelta = coarse ? 33 : 0;

    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      if (t - last < minDelta) return;
      last = t;
      draw(t);
    };

    const onMove = (event: PointerEvent) => {
      mx = event.clientX;
      my = event.clientY;
    };

    const onLeave = () => {
      mx = -9999;
      my = -9999;
    };

    readPalette();
    resize();

    // passive：指针移动是高频事件，绝不能阻塞滚动
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    window.addEventListener("resize", resize);
    window.addEventListener(THEME_EVENT, readPalette);

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("resize", resize);
      window.removeEventListener(THEME_EVENT, readPalette);
    };
  }, [reduced, excluded]);

  if (reduced || excluded) return null;

  return <canvas ref={canvasRef} aria-hidden className="cosmic-wave" />;
}
