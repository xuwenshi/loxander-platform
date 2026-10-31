"use client";

import { useEffect, useRef } from "react";

import CosmicLink from "@/components/cosmic/CosmicLink";
import { useReducedMotion } from "@/lib/useReducedMotion";

import styles from "./HomeHeroClasses";

type OrbitBody = {
  key: string;
  rx: number;
  ry: number;
  speed: number;
  phase: number;
  wobble: number;
};

const ORBIT_BODIES: OrbitBody[] = [
  { key: "projects", rx: 35, ry: 27, speed: 0.19, phase: -0.8, wobble: 0.7 },
  { key: "writing", rx: 42, ry: 20, speed: -0.14, phase: 2.1, wobble: 2.8 },
  { key: "diary", rx: 27, ry: 37, speed: 0.23, phase: 4.2, wobble: 4.1 },
  { key: "goals", rx: 44, ry: 31, speed: -0.11, phase: 5.3, wobble: 1.5 },
  { key: "resume", rx: 31, ry: 15, speed: 0.28, phase: 1.3, wobble: 3.4 },
];

export default function HomeHeroOrbit() {
  const fieldRef = useRef<HTMLSpanElement | null>(null);
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const field = fieldRef.current;
    const link = linkRef.current;
    if (!field || !link) return;

    const bodies = ORBIT_BODIES.map((body) => ({
      ...body,
      node: field.querySelector<HTMLElement>(`[data-orbit-body="${body.key}"]`),
    })).filter(
      (body): body is OrbitBody & { node: HTMLElement } => body.node !== null,
    );
    const tethers = Array.from(
      field.querySelectorAll<SVGLineElement>("[data-orbit-tether]"),
    );

    const render = (elapsed: number) => {
      if (!field) return;

      const width = field.clientWidth;
      const height = field.clientHeight;
      const positions: Array<{ x: number; y: number; depth: number }> = [];

      for (const body of bodies) {
        const angle = elapsed * body.speed + body.phase;
        const breathingX = 1 + Math.sin(angle * 0.73 + body.wobble) * 0.17;
        const breathingY =
          1 + Math.cos(angle * 0.91 + body.wobble * 1.4) * 0.22;
        const x =
          Math.cos(angle) * body.rx * breathingX +
          Math.sin(angle * 1.8 + body.wobble) * 1.4;
        const y =
          Math.sin(angle) * body.ry * breathingY +
          Math.cos(angle * 1.6 + body.wobble) * 1.6;
        const depth = (Math.sin(angle * 1.17 + body.phase) + 1) / 2;

        positions.push({ x: 50 + x, y: 50 + y, depth });
        body.node.style.setProperty(
          "--orbit-x",
          `${((x / 100) * width).toFixed(2)}px`,
        );
        body.node.style.setProperty(
          "--orbit-y",
          `${((y / 100) * height).toFixed(2)}px`,
        );
        body.node.style.setProperty(
          "--orbit-scale",
          (0.72 + depth * 0.42).toFixed(3),
        );
        body.node.style.setProperty(
          "--orbit-opacity",
          (0.54 + depth * 0.46).toFixed(3),
        );
        body.node.style.setProperty(
          "--orbit-z",
          String(4 + Math.round(depth * 8)),
        );

        const nextAngle = angle + body.speed * 0.02;
        const nextBreathingX =
          1 + Math.sin(nextAngle * 0.73 + body.wobble) * 0.17;
        const nextBreathingY =
          1 + Math.cos(nextAngle * 0.91 + body.wobble * 1.4) * 0.22;
        const nextX =
          Math.cos(nextAngle) * body.rx * nextBreathingX +
          Math.sin(nextAngle * 1.8 + body.wobble) * 1.4;
        const nextY =
          Math.sin(nextAngle) * body.ry * nextBreathingY +
          Math.cos(nextAngle * 1.6 + body.wobble) * 1.6;
        const trailAngle =
          (Math.atan2(-(nextY - y), -(nextX - x)) * 180) / Math.PI;
        body.node.style.setProperty(
          "--trail-angle",
          `${trailAngle.toFixed(2)}deg`,
        );
      }

      const edges: Array<{ a: number; b: number; distance: number }> = [];
      for (let i = 0; i < positions.length; i += 1) {
        for (let j = i + 1; j < positions.length; j += 1) {
          edges.push({
            a: i,
            b: j,
            distance: Math.hypot(
              positions[i].x - positions[j].x,
              positions[i].y - positions[j].y,
            ),
          });
        }
      }
      edges.sort((a, b) => a.distance - b.distance);

      const degrees = positions.map(() => 0);
      const selected: typeof edges = [];
      for (const edge of edges) {
        if (
          selected.length < tethers.length &&
          degrees[edge.a] < 2 &&
          degrees[edge.b] < 2
        ) {
          selected.push(edge);
          degrees[edge.a] += 1;
          degrees[edge.b] += 1;
        }
      }

      tethers.forEach((line, index) => {
        const edge = selected[index];
        if (!edge) {
          line.setAttribute("opacity", "0");
          return;
        }

        const start = positions[edge.a];
        const end = positions[edge.b];
        line.setAttribute("x1", start.x.toFixed(2));
        line.setAttribute("y1", start.y.toFixed(2));
        line.setAttribute("x2", end.x.toFixed(2));
        line.setAttribute("y2", end.y.toFixed(2));
        line.setAttribute(
          "opacity",
          (0.36 + ((start.depth + end.depth) / 2) * 0.34).toFixed(2),
        );
      });
    };

    render(0);
    if (reducedMotion) return;

    let frame = 0;
    let inView = true;
    const start = performance.now();

    const tick = (now: number) => {
      if (inView && !document.hidden) render((now - start) / 1000);
      frame = requestAnimationFrame(tick);
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry?.isIntersecting ?? true;
      },
      { threshold: 0 },
    );
    observer.observe(link);
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [reducedMotion]);

  const nodeClass = {
    projects: `${styles.node} ${styles.nodeProjects}`,
    writing: `${styles.node} ${styles.nodeWriting}`,
    diary: `${styles.node} ${styles.nodeDiary}`,
    goals: `${styles.node} ${styles.nodeGoals}`,
    resume: `${styles.node} ${styles.nodeResume}`,
  };

  return (
    <CosmicLink
      ref={linkRef}
      href="/universe"
      variant="warp"
      className={styles.orbit}
      aria-label="打开星图"
    >
      <span className={styles.orbitAura} aria-hidden="true" />
      <span className={styles.orbitProjection} aria-hidden="true" />
      <span className={styles.orbitFrame} aria-hidden="true" />
      <span className={styles.orbitTicks} aria-hidden="true" />
      <span className={styles.orbitRingWide} aria-hidden="true" />
      <span className={styles.orbitRing} aria-hidden="true" />
      <span className={styles.orbitRingDash} aria-hidden="true" />
      <span className={styles.orbitAxis} aria-hidden="true" />
      <svg
        className={styles.orbitChart}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <ellipse cx="50" cy="50" rx="35" ry="27" transform="rotate(-18 50 50)" />
        <ellipse cx="50" cy="50" rx="42" ry="20" transform="rotate(26 50 50)" />
        <ellipse cx="50" cy="50" rx="27" ry="37" transform="rotate(74 50 50)" />
        <ellipse cx="50" cy="50" rx="44" ry="31" transform="rotate(12 50 50)" />
        <ellipse cx="50" cy="50" rx="31" ry="15" transform="rotate(-52 50 50)" />
        <path d="M 28 27 C 39 35, 47 43, 50 50 C 55 59, 64 66, 76 57" />
      </svg>
      <span className={styles.orbitScan} aria-hidden="true" />
      <svg
        className={styles.orbitLinks}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <line className={styles.tether} data-orbit-tether />
        <line className={styles.tether} data-orbit-tether />
        <line className={styles.tether} data-orbit-tether />
        <line className={styles.tether} data-orbit-tether />
      </svg>
      <span ref={fieldRef} className={styles.orbitField} aria-hidden="true">
        {ORBIT_BODIES.map((body) => (
          <span
            key={body.key}
            className={nodeClass[body.key as keyof typeof nodeClass]}
            data-orbit-body={body.key}
          />
        ))}
      </span>
      <span className={styles.comet} aria-hidden="true" />
      <span className={styles.orbitEcho} aria-hidden="true" />
      <span className={styles.coreHalo} aria-hidden="true" />
      <span className={styles.core} aria-hidden="true" />
      <span className={styles.orbitData} aria-hidden="true">
        N-body / 05
      </span>
      <span className={styles.orbitLive} aria-hidden="true">
        <i />
        Track / live
      </span>
      <span className={styles.orbitLabel} aria-hidden="true">
        Access / Star map
      </span>
    </CosmicLink>
  );
}
