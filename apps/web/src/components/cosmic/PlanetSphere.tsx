import type { CSSProperties } from "react";

import type { PlanetPalette } from "@/lib/cosmic";

/**
 * 纯 CSS 星球（服务端组件，零 JS）。
 *
 * 换皮后一颗星球由四层构成：
 * - `__surface`：地表材质，由 `material` 决定（clay / banded / fractured），
 *   它们不是简单换色，而是三种完全不同的纹理配方；
 * - `__shade`：受光面 + 内阴影，光源方向由 `lightX` / `lightY` 控制，
 *   因此五颗星球的高光位置可以各不相同，不会出现「一张皮换五个色」；
 * - `__rim`：边缘辉光，取行星自己的强调色；
 * - `__ring`：行星环，只在需要时渲染。
 *
 * `--planet-spin` 控制自转一圈的时长（26s–44s 各不相同），
 * `--planet-glow` 控制光晕半径（跟随直径缩放）。
 */

export type PlanetMaterial = "clay" | "banded" | "fractured";

export default function PlanetSphere({
  planet,
  diameter,
  accent,
  spin,
  ring = false,
  material = "clay",
  lightX = "30%",
  lightY = "26%",
  className = "",
}: {
  planet: PlanetPalette;
  diameter: number;
  accent: string;
  spin: string;
  ring?: boolean;
  /** 地表材质：`clay` 细腻漫反射 / `banded` 纬向条带 / `fractured` 裂隙岩层 */
  material?: PlanetMaterial;
  /** 光源位置（球面上的百分比坐标），默认左上 */
  lightX?: string;
  lightY?: string;
  className?: string;
}) {
  const vars = {
    width: `${diameter}px`,
    height: `${diameter}px`,
    backgroundImage: `radial-gradient(circle at ${lightX} ${lightY}, ${planet.light} 0%, ${planet.base} 34%, ${planet.mid} 64%, ${planet.dark} 100%)`,
    "--planet-spin": spin,
    "--planet-accent": accent,
    "--planet-glow": `${Math.round(diameter * 0.28)}px`,
    "--planet-light-x": lightX,
    "--planet-light-y": lightY,
  } as CSSProperties;

  const materialClass =
    material === "banded"
      ? "cosmic-planet--banded"
      : material === "fractured"
        ? "cosmic-planet--fractured"
        : "";

  return (
    <span
      aria-hidden
      className={`cosmic-planet ${materialClass} ${className}`.trim()}
      style={vars}
    >
      <span className="cosmic-planet__surface" />
      <span className="cosmic-planet__shade" />
      <span className="cosmic-planet__rim" />
      {ring ? <span className="cosmic-planet__ring" /> : null}
    </span>
  );
}
