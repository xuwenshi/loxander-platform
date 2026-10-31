"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { cosmicSections } from "@/lib/cosmic";
import { useReducedMotion } from "@/lib/useReducedMotion";

/* 星图 · 立体轨道盘
 *
 * 设计稿 `_prototype/universe-draft-b.html` 的落地版：
 * 盘面是固定 700×680 的设计像素，五个分区各占一条轨道，绕盘心公转；
 * 悬停行星或右侧星表任意一行，读数条浮出该分区的条目与元信息。
 *
 * 三条性能约束（和 `docs`/换皮说明里的一致）：
 *   1. 逐帧只写 transform / opacity / zIndex，绝不在帧内读布局；
 *   2. 静止 30fps、悬停 60fps，页面不可见时整个 rAF 停掉；
 *   3. `prefers-reduced-motion` 时不公转，但仍可拖拽与悬停。
 */

const W = 700;
const H = 680;
const CX = 350;
const CY = 340;
const SQUASH = 0.58;
const TILT_DEG = -12;
const TILT_RAD = (TILT_DEG * Math.PI) / 180;
const COS_T = Math.cos(TILT_RAD);
const SIN_T = Math.sin(TILT_RAD);

const ORBITS = [142, 190, 234, 272, 296];
const DIAMETERS = [68, 52, 60, 44, 38];
const PERIODS = [190, 155, 132, 112, 96];
const BASE_DEG = [0, 72, 144, 216, 288];
const NUMERALS = ["I", "II", "III", "IV", "V"];
const RING_SCALES = [0.46, 0.67, 0.87];
const OUTER_R = 300;
const TICK_COUNT = 120;
const TRAIL_DEG = 30;

/** 轨道平面 → 盘面坐标（先按 SQUASH 压扁，再整体倾斜 -12°） */
function project(r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  const x0 = Math.cos(rad) * r;
  const y0 = Math.sin(rad) * r * SQUASH;
  return { x: CX + x0 * COS_T - y0 * SIN_T, y: CY + x0 * SIN_T + y0 * COS_T };
}

/** 扇区用折线近似椭圆弧，避免手写 A 命令的轴向参数 */
function sectorPath(from: number, to: number) {
  const steps = 48;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const p = project(OUTER_R, from + ((to - from) * i) / steps);
    pts.push(`${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  }
  return `M ${CX} ${CY} L ${pts.join(" L ")} Z`;
}

/** 行星身后的拖尾：未压扁的圆弧，由一个带 scale(1,SQUASH) 的 group 负责压扁 */
function trailPath(r: number) {
  const a = (-TRAIL_DEG * Math.PI) / 180;
  return `M ${(Math.cos(a) * r).toFixed(1)} ${(Math.sin(a) * r).toFixed(1)} A ${r} ${r} 0 0 1 ${r} 0`;
}

export default function StarMap() {
  const sections = useMemo(() => cosmicSections.slice(0, 5), []);
  const reduced = useReducedMotion();

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const orreryRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);

  const active = sections.find((section) => section.id === activeId) ?? null;
  const activeIndex = active ? sections.findIndex((section) => section.id === active.id) : -1;
  const activeItems = active
    ? active.description
        .split(/[。；]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];

  /* 盘面按容器宽度整体缩放（设计稿是 700 设计像素） */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const sync = () => {
      const width = wrap.clientWidth;
      if (width > 0) setScale(Math.min(1, width / W));
    };
    sync();

    const observer = new ResizeObserver(sync);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = orreryRef.current;
    if (!root) return;

    const orbs = Array.from(root.querySelectorAll<HTMLElement>("[data-orb]"));
    const trails = Array.from(root.querySelectorAll<SVGGElement>("[data-trail]"));
    const lock = root.querySelector<HTMLElement>("[data-lock]");
    const azEl = root.querySelector<HTMLElement>("[data-az]");
    const utcEl = root.querySelector<HTMLElement>("[data-utc]");

    const positions: Record<string, { x: number; y: number; d: number }> = {};
    let spin = 0;
    let clock = 0;
    let raf = 0;
    let last = 0;
    let hot = false;
    let dragging = false;
    let dragStartX = 0;
    let dragStartSpin = 0;
    let moved = 0;

    const place = () => {
      orbs.forEach((el, index) => {
        const id = el.dataset.orb ?? "";
        const period = PERIODS[index] ?? 190;
        const diameter = DIAMETERS[index] ?? 52;
        const angle =
          ((BASE_DEG[index] ?? 0) * Math.PI) / 180 +
          spin +
          (reduced ? 0 : (clock / (period * 1000)) * Math.PI * 2);

        const x0 = Math.cos(angle) * (ORBITS[index] ?? 200);
        const y0 = Math.sin(angle) * (ORBITS[index] ?? 200) * SQUASH;
        const x = x0 * COS_T - y0 * SIN_T;
        const y = x0 * SIN_T + y0 * COS_T;
        const depth = Math.sin(angle);

        const size = 0.82 + ((depth + 1) / 2) * 0.36;
        const opacity = 0.66 + ((depth + 1) / 2) * 0.34;

        positions[id] = { x, y, d: diameter };

        el.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${size.toFixed(3)})`;
        el.style.opacity = opacity.toFixed(3);
        el.style.zIndex = depth >= 0 ? "4" : "2";

        const tag = el.querySelector<HTMLElement>("[data-tag]");
        if (tag) {
          const gap = diameter * size + 13;
          const right = x >= 0;
          tag.style.transform = right
            ? `translate(${gap.toFixed(1)}px,${(diameter * size * -0.5).toFixed(1)}px)`
            : `translate(${(-gap).toFixed(1)}px,${(diameter * size * -0.5).toFixed(1)}px) translateX(-100%)`;
          tag.style.textAlign = right ? "left" : "right";
          tag.style.opacity = (0.68 + ((depth + 1) / 2) * 0.32).toFixed(3);
        }

        const trail = trails[index];
        if (trail) {
          const deg = (angle * 180) / Math.PI;
          trail.setAttribute(
            "transform",
            `translate(${CX} ${CY}) rotate(${TILT_DEG}) scale(1 ${SQUASH}) rotate(${deg.toFixed(2)})`,
          );
        }
      });

      const current = activeRef.current;
      if (lock && current && positions[current]) {
        const p = positions[current];
        lock.style.setProperty("--ls", `${(p.d * 2.2 + 16).toFixed(0)}px`);
        lock.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0)`;
        lock.classList.add("is-on");
      } else if (lock) {
        lock.classList.remove("is-on");
      }
    };

    const tick = (time: number) => {
      raf = requestAnimationFrame(tick);
      if (!last) {
        last = time;
        return;
      }
      const delta = time - last;
      if (delta < (hot ? 1000 / 60 : 1000 / 30)) return;
      last = time;
      clock += delta;
      place();
    };

    const start = () => {
      if (reduced) {
        place();
        return;
      }
      last = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };

    /* 指针：十字线 + 极坐标读数（只写 transform，不读布局） */
    const onMove = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      const dx = event.clientX - (rect.left + CX * scale);
      const dy = event.clientY - (rect.top + CY * scale);
      const ux = dx * COS_T + dy * SIN_T;
      const uy = -dx * SIN_T + dy * COS_T;
      const az = ((Math.atan2(uy / SQUASH, ux) * 180) / Math.PI + 360) % 360;
      const radius = Math.sqrt(ux * ux + (uy / SQUASH) * (uy / SQUASH));

      if (azEl) {
        azEl.textContent = `AZ ${String(Math.round(az)).padStart(3, "0")}° · R ${String(
          Math.round(radius),
        ).padStart(3, "0")}`;
      }

      const h = root.querySelector<HTMLElement>("[data-xh-h]");
      const v = root.querySelector<HTMLElement>("[data-xh-v]");
      if (h && v) {
        h.style.transform = `translate3d(0,${((event.clientY - rect.top) / scale).toFixed(1)}px,0)`;
        v.style.transform = `translate3d(${((event.clientX - rect.left) / scale).toFixed(1)}px,0,0)`;
        root.classList.add("has-cursor");
      }

      if (!dragging) return;
      moved = Math.max(moved, Math.abs(event.clientX - dragStartX));
      spin = dragStartSpin + (event.clientX - dragStartX) * 0.006;
      place();
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragging = true;
      moved = 0;
      dragStartX = event.clientX;
      dragStartSpin = spin;
      root.classList.add("is-drag");
      root.setPointerCapture(event.pointerId);
    };

    const onUp = (event: PointerEvent) => {
      dragging = false;
      root.classList.remove("is-drag");
      try {
        root.releasePointerCapture(event.pointerId);
      } catch {
        /* 指针已经释放，忽略 */
      }
    };

    /* 拖过盘面之后的那一下 click 不应该触发跳转 */
    const onClickCapture = (event: MouseEvent) => {
      if (moved > 6) {
        event.preventDefault();
        event.stopPropagation();
        moved = 0;
      }
    };

    const onEnter = () => {
      hot = true;
    };
    const onLeave = () => {
      hot = false;
      root.classList.remove("has-cursor");
    };

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        start();
      }
    };

    root.addEventListener("pointerenter", onEnter);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("pointermove", onMove, { passive: true });
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    root.addEventListener("click", onClickCapture, true);
    document.addEventListener("visibilitychange", onVisibility);

    const clockTimer = window.setInterval(() => {
      if (!utcEl) return;
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, "0");
      utcEl.textContent = `UTC ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(
        now.getUTCSeconds(),
      )}`;
    }, 1000);

    /* 先同步铺一次：headless 截图与后台标签页里 rAF 不一定会跑，
       这一下也顺带消掉了首帧从盘心弹出去的跳变 */
    place();
    start();

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(clockTimer);
      root.removeEventListener("pointerenter", onEnter);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
      root.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced, scale]);

  /* 悬停行星 / 悬停星表行，都会点亮同一个分区 */
  const setActive = (id: string | null) => {
    activeRef.current = id;
    setActiveId(id);
    const root = orreryRef.current;
    if (!root) return;
    root.classList.toggle("is-hot", id !== null);
    root.querySelectorAll<HTMLElement>("[data-orb]").forEach((el) => {
      el.classList.toggle("is-hot", el.dataset.orb === id);
    });
  };

  return (
    <div className="starmap">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,700px)_minmax(0,1fr)] lg:items-start lg:gap-12">
      {/* 盘面：小于 md 时按比例缩小会小到看不清标签，直接隐藏，让下面的星表承担导航 */}
      <div
        ref={wrapRef}
        className="hidden md:block"
        style={{ height: H * scale, width: "100%" }}
      >
        <div
          ref={orreryRef}
          className="orrery"
          style={{ "--k": scale } as CSSProperties}
          onPointerLeave={() => setActive(null)}
        >
          <svg
            className="orrery__plate"
            viewBox={`0 0 ${W} ${H}`}
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <pattern id="orrery-grid" width="35" height="35" patternUnits="userSpaceOnUse">
                <path className="orrery__grid-line" d="M35 0H0v35" />
              </pattern>
              <pattern
                id="orrery-hatch"
                width="9"
                height="9"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line className="orrery__hatch-line" x1="0" y1="0" x2="0" y2="9" />
              </pattern>
              <clipPath id="orrery-sector">
                <path d={sectorPath(-104, -16)} />
              </clipPath>
            </defs>

            <rect x="7" y="7" width={W - 14} height={H - 14} fill="url(#orrery-grid)" />

            <g clipPath="url(#orrery-sector)">
              <rect x="0" y="0" width={W} height={H} fill="url(#orrery-hatch)" />
            </g>
            <path className="orrery__sec-edge" d={sectorPath(-104, -16)} />

            {RING_SCALES.map((factor) => (
              <ellipse
                key={factor}
                className="orrery__ring"
                cx={CX}
                cy={CY}
                rx={OUTER_R * factor}
                ry={OUTER_R * factor * SQUASH}
                transform={`rotate(${TILT_DEG} ${CX} ${CY})`}
              />
            ))}

            {Array.from({ length: TICK_COUNT }, (_, index) => {
              const deg = (360 / TICK_COUNT) * index;
              const major = index % 10 === 0;
              const inner = project(OUTER_R, deg);
              const outer = project(OUTER_R + (major ? 12 : 6), deg);
              return (
                <line
                  key={deg}
                  className={major ? "orrery__tick orrery__tick--major" : "orrery__tick"}
                  x1={inner.x.toFixed(1)}
                  y1={inner.y.toFixed(1)}
                  x2={outer.x.toFixed(1)}
                  y2={outer.y.toFixed(1)}
                />
              );
            })}

            {[0, 90, 180, 270].map((deg) => {
              const p = project(OUTER_R + 26, deg);
              return (
                <text
                  key={deg}
                  className="orrery__az"
                  x={p.x.toFixed(1)}
                  y={p.y.toFixed(1)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {String(deg).padStart(3, "0")}
                </text>
              );
            })}

            {ORBITS.map((radius) => (
              <ellipse
                key={radius}
                className="orrery__orbit"
                cx={CX}
                cy={CY}
                rx={radius}
                ry={radius * SQUASH}
                transform={`rotate(${TILT_DEG} ${CX} ${CY})`}
              />
            ))}

            {ORBITS.map((radius) => (
              <g
                key={radius}
                data-trail
                transform={`translate(${CX} ${CY}) rotate(${TILT_DEG}) scale(1 ${SQUASH}) rotate(0)`}
              >
                <path className="orrery__trail" d={trailPath(radius)} />
              </g>
            ))}
          </svg>

          <span className="orrery__sweep" aria-hidden="true">
            <i />
          </span>

          <span className="orrery__axis" aria-hidden="true" />
          <span className="orrery__axis--v" aria-hidden="true" />

          <div className="orrery__core" aria-hidden="true">
            <span className="orrery__core-h" />
            <span className="orrery__core-p" />
            <span className="orrery__core-p orrery__core-p--b" />
            <span className="orrery__core-x" />
            <span className="orrery__core-d" />
          </div>

          {sections.map((section, index) => (
            <Link
              key={section.id}
              href={section.href}
              data-orb={section.id}
              className="orb"
              aria-label={`${section.name} · ${section.latin}`}
              onPointerEnter={() => setActive(section.id)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(section.id)}
              onBlur={() => setActive(null)}
              style={
                {
                  "--d": `${DIAMETERS[index] ?? 52}px`,
                  "--light": section.planet.light,
                  "--base": section.planet.base,
                  "--mid": section.planet.mid,
                  "--dark": section.planet.dark,
                } as CSSProperties
              }
            >
              <span className="orb__glow" aria-hidden="true" />
              <span className="orb__ball" aria-hidden="true" />
              <span className="orb__cross" aria-hidden="true" />
              <span className="orb__tag" data-tag aria-hidden="true">
                <b>{section.name}</b>
                <i>{section.latin}</i>
              </span>
            </Link>
          ))}

          <div className="orrery__lock" data-lock aria-hidden="true">
            <span className="orrery__lock-ring" />
            <i />
            <i />
            <i />
            <i />
          </div>

          <span className="orrery__frame" aria-hidden="true" />
          <span className="orrery__rule-x" aria-hidden="true" />
          <span className="orrery__rule-y" aria-hidden="true" />
          <span className="orrery__scan" aria-hidden="true" />
          <span className="orrery__scanbar" aria-hidden="true" />
          <span className="orrery__xh" data-xh-h aria-hidden="true" />
          <span className="orrery__xh--v" data-xh-v aria-hidden="true" />

          <span className="orrery__cnr orrery__cnr--tl" aria-hidden="true">
            Plate I
          </span>
          <span className="orrery__cnr orrery__cnr--tr" aria-hidden="true">
            Scale 1:1
          </span>
          <span className="orrery__zone" aria-hidden="true">
            Scan zone · A
          </span>

          <div className="orrery__coord" aria-hidden="true">
            <span data-az>AZ 000° · R 000</span>
            <br />
            <b data-utc>UTC 00:00:00</b>
          </div>

          {/* 读数是装饰性的冗余信息，真正的可读内容在下面的星表里 */}
          <div className="hud" aria-hidden="true">
            <p className="hud__eye">分区读数</p>
            <p className="hud__name">{active?.name ?? ""}</p>
            <p className="hud__latin">
              {active ? `${NUMERALS[activeIndex] ?? ""} · ${active.latin}` : ""}
            </p>
            <span className="hud__meta">{active?.tagline ?? ""}</span>
            <ul>
              {activeItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* 星表：五条真实路由，键盘与移动端的主路径 */}
      <ol className="mt-8 border-t border-cosmic-line lg:mt-0">
        {sections.map((section, index) => {
          const isActive = section.id === activeId;
          return (
            <li key={section.id} className="border-b border-cosmic-line/60">
              <Link
                href={section.href}
                onPointerEnter={() => setActive(section.id)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(section.id)}
                onBlur={() => setActive(null)}
                className={`grid min-h-11 grid-cols-[28px_1fr_auto] items-center gap-3 py-3 transition-colors ${
                  isActive ? "bg-copper/[0.055]" : ""
                }`}
              >
                <span className="font-mono text-[0.5625rem] tracking-[0.14em] text-accent">
                  {NUMERALS[index]}
                </span>
                <span>
                  <span className="block font-serif text-[0.9375rem] leading-tight text-foreground">
                    {section.name}
                  </span>
                  <span className="mt-1 block font-mono text-[0.5rem] uppercase tracking-[0.2em] text-muted">
                    {section.latin}
                  </span>
                </span>
                <span className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-muted">
                  {section.tagline}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      </div>
    </div>
  );
}
