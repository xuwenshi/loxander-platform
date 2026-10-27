"""从 apps/web/src/app/icon.svg 的同一套几何参数生成多尺寸 .ico。

不直接转换 SVG 是因为 Pillow 不解 SVG；这里按 SVG 里的坐标手绘等价图形：
  64x64 视口，圆角矩形 rx=14 填 #1d4ed8，
  白色折线 (21,15)->(21,42)->(38,42) 线宽 7 圆头圆角，
  右下角圆 (45,45) r=5.5 填 #93b4ff。
先按 1024 画再逐级缩小，避免小尺寸下笔画发虚。
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("ops.ico")

SUPERSAMPLE = 16  # 64 * 16 = 1024
BASE = 64
SCALE = BASE * SUPERSAMPLE

BG = (0x1D, 0x4E, 0xD8, 255)
FG = (0xFF, 0xFF, 0xFF, 255)
DOT = (0x93, 0xB4, 0xFF, 255)


def s(v: float) -> float:
    """把 SVG 视口坐标换算到超采样画布。"""
    return v * SUPERSAMPLE


def draw_master() -> Image.Image:
    img = Image.new("RGBA", (SCALE, SCALE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角矩形背景：先画大圆角矩形，用 4 个圆 + 2 个矩形拼，避免 rounded_rectangle 的抗锯齿差异
    r = s(14)
    d.rounded_rectangle([0, 0, SCALE - 1, SCALE - 1], radius=r, fill=BG)

    # 折线 (21,15) -> (21,42) -> (38,42)，线宽 7，圆头圆角
    w = s(7)
    half = w / 2
    x1, y1 = s(21), s(15)
    x2, y2 = s(21), s(42)
    x3, y3 = s(38), s(42)

    # 竖笔（两端圆头）
    d.rounded_rectangle([x1 - half, y1 - half, x1 + half, y2 + half], radius=half, fill=FG)
    # 横笔（左端与竖笔重合，右端圆头）
    d.rounded_rectangle([x1 - half, y2 - half, x3 + half, y2 + half], radius=half, fill=FG)

    # 右下角圆点
    cx, cy, cr = s(45), s(45), s(5.5)
    d.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=DOT)

    return img


def main() -> int:
    master = draw_master()
    sizes = [256, 128, 64, 48, 32, 24, 16]
    frames = [master.resize((n, n), Image.LANCZOS) for n in sizes]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(OUT, format="ICO", sizes=[(n, n) for n in sizes], append_images=frames[1:])

    print(f"written {OUT} ({OUT.stat().st_size} B)")
    for n, f in zip(sizes, frames):
        print(f"  {n}x{n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
