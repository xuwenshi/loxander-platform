"use client";

import { useEffect, useRef } from "react";

import { useReducedMotion } from "@/lib/useReducedMotion";

/**
 * 全站的氛围叠层（暗角 / 颗粒 / 指针跟随）。
 *
 * 对应原型 `_prototype/redesign.html:324-369` 的 `.vignette` / `.grain` /
 * `.aura` + `.reticle` + `.pointer-dot`。样式全部在 globals.css 里，
 * 这个组件只负责两件 CSS 做不到的事：
 *
 * 1. 指针跟随 —— 位移写进 CSS 变量 `--px` / `--py`，由 `transform` 消费。
 *    每帧只在 requestAnimationFrame 里写一次，绝不在 pointermove 里读布局
 *    （否则每次移动都会触发一次 forced reflow）。
 * 2. 准星放大 —— 指针压在可交互元素（a / button / input / [role=button] /
 *    [data-cursor="hot"]）上时给容器加 `data-hot`，其余时候摘掉。
 *
 * 三条限制，都很关键：
 * - **绝不拦截交互**：三层都是 `pointer-events: none`，且容器 0×0；
 * - **触屏不渲染**：`(hover: none)` 下 CSS 直接 `display: none`，JS 也提前退出；
 * - **减动效偏好下完全不出现**：文件末尾的 reduced-motion 兜底把它们
 *   一起 `display: none`；组件这边相应地不挂载指针层、也不装任何监听器。
 *
 * 层级上，暗角(1)/颗粒(2) 会盖住未定位的内容，所以各分区外壳都补了
 * `relative z-10`（详见 (site)/layout.tsx 的注释）；指针层取 24 留在内容之上。
 *
 * 另外，指针层只在第一次真实 pointermove 之后才显示（`data-on`），
 * 否则鼠标停在工作区外时页面正中央会凭空出现一个光斑。
 */
export default function Ambience() {
  const pointerRef = useRef<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;

    const el = pointerRef.current;
    if (!el) return;

    // 触屏 / 无精指针设备：直接不启用，省掉所有监听器
    if (window.matchMedia("(hover: none), (pointer: coarse)").matches) return;

    // 只关心能改变准星形态的元素；用 closest 而不是 elementFromPoint，
    // 因为前者对 SVG / 伪元素内部结构更宽容，也不会被 pointer-events:none 迷惑。
    const HOT_SELECTOR = 'a, button, input, textarea, select, summary, [role="button"], [data-cursor="hot"]';

    let frame = 0;
    let nextX = 0;
    let nextY = 0;
    let hot = false;
    let visible = false;

    const apply = () => {
      frame = 0;
      el.style.setProperty("--px", `${nextX}px`);
      el.style.setProperty("--py", `${nextY}px`);
      if (!visible) {
        visible = true;
        el.dataset.on = "true";
      }
    };

    const onMove = (event: PointerEvent) => {
      nextX = event.clientX;
      nextY = event.clientY;

      const target = event.target;
      const nextHot =
        target instanceof Element ? target.closest(HOT_SELECTOR) !== null : false;
      if (nextHot !== hot) {
        hot = nextHot;
        el.dataset.hot = nextHot ? "true" : "false";
      }

      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    const onLeave = () => {
      visible = false;
      delete el.dataset.on;
    };

    // passive：指针移动是高频事件，绝不能阻塞滚动
    window.addEventListener("pointermove", onMove, { passive: true });
    // 指针离开文档（移到浏览器 UI / 另一个窗口）时收起光斑
    document.addEventListener("pointerleave", onLeave);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, [reduced]);

  return (
    <>
      <span aria-hidden className="cosmic-vignette" />
      <span aria-hidden className="cosmic-grain" />

      {/* 减动效偏好下不挂载指针层：它是一个持续跟随的动效，不是静态质感 */}
      {reduced ? null : (
        <div
          ref={pointerRef}
          aria-hidden
          className="cosmic-pointer"
          data-hot="false"
        >
          <span className="cosmic-pointer__aura" />
          <span className="cosmic-pointer__reticle" />
          <span className="cosmic-pointer__dot" />
        </div>
      )}
    </>
  );
}
