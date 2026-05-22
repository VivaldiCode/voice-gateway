#!/usr/bin/env python3
"""Render the Voice Gateway icon at every size we ship.

Pixel-for-pixel port of `resources/icon.svg`. Kept self-contained (no other
imports beyond Pillow + numpy) so it can be re-run from a venv on any
machine.

Outputs:
    resources/icon.png           1024x1024 master used by electron-builder
    resources/icons/icon-*.png   16, 32, 48, 64, 128, 256, 512, 1024
    resources/icons/icon.iconset/icon_{16,32,128,256,512}x*.png (+@2x)
    resources/icon.icns          macOS bundle icon (built by iconutil)
    resources/icon.ico           Windows multi-resolution icon

Usage:
    /tmp/vg-logo-venv/bin/python resources/_render-icon.py
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "resources"
ICONS_DIR = RES / "icons"
ICONSET_DIR = ICONS_DIR / "icon.iconset"

# Colours match resources/icon.svg.
BG_TL = (164, 139, 255)   # #a48bff
BG_BR = (90, 62, 199)     # #5a3ec7
ORB_CENTER = (255, 255, 255)
ORB_MID = (238, 231, 255)
ORB_EDGE = (218, 208, 255)
BAR = (90, 62, 199, 255)  # #5a3ec7


def diagonal_gradient(size: int) -> Image.Image:
    """Top-left → bottom-right linear gradient."""
    xv, yv = np.meshgrid(np.linspace(0, 1, size), np.linspace(0, 1, size))
    t = (xv + yv) / 2.0
    rgb = np.empty((size, size, 4), dtype=np.uint8)
    for ch in range(3):
        rgb[..., ch] = (BG_TL[ch] * (1 - t) + BG_BR[ch] * t).round().astype(np.uint8)
    rgb[..., 3] = 255
    return Image.fromarray(rgb, "RGBA")


def radial_orb(size: int, cx: float, cy: float, r: float) -> Image.Image:
    """Soft white orb on transparent. Centre → mid → edge, with edge feather."""
    yy, xx = np.indices((size, size))
    d = np.hypot(xx - cx, yy - cy) / r
    inside = d < 1.0

    rgb = np.zeros((size, size, 4), dtype=np.uint8)
    # Piecewise: 0..0.8 = centre→mid, 0.8..1 = mid→edge.
    t1 = np.clip(d / 0.8, 0, 1)
    t2 = np.clip((d - 0.8) / 0.2, 0, 1)
    seg2 = d > 0.8
    for ch in range(3):
        v1 = ORB_CENTER[ch] * (1 - t1) + ORB_MID[ch] * t1
        v2 = ORB_MID[ch] * (1 - t2) + ORB_EDGE[ch] * t2
        v = np.where(seg2, v2, v1)
        rgb[..., ch] = v.round().astype(np.uint8)
    # Feather alpha across the last 4 % of the radius.
    feather_start = 0.96
    alpha = np.where(
        d < feather_start,
        255,
        np.clip(255 * (1 - (d - feather_start) / (1 - feather_start)), 0, 255),
    )
    rgb[..., 3] = np.where(inside, alpha, 0).astype(np.uint8)
    return Image.fromarray(rgb, "RGBA")


def make_icon(target: int) -> Image.Image:
    # Render at 2× then downsample for crisp edges.
    work = target * 2 if target <= 512 else target
    radius = round(work * 0.22)
    center = work / 2

    # Background gradient masked into a rounded square.
    bg = diagonal_gradient(work)
    mask = Image.new("L", (work, work), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, work - 1, work - 1], radius=radius, fill=255)
    bg.putalpha(mask)

    draw = ImageDraw.Draw(bg)
    # Faint halos behind the orb.
    for r_frac, alpha in ((0.381, 18), (0.313, 28)):
        r = round(work * r_frac)
        draw.ellipse(
            [center - r, center - r, center + r, center + r],
            fill=(255, 255, 255, alpha),
        )

    # Main orb (white radial).
    orb_r = work * 0.275
    bg = Image.alpha_composite(bg, radial_orb(work, center, center, orb_r))

    # Soundwave bars (low, high, low — mirrors the SVG geometry).
    draw = ImageDraw.Draw(bg)
    bar_w = round(work * 0.0488)        # 50/1024
    bar_r = bar_w // 2
    gap = round(work * 0.0146)          # 15/1024 spacing
    high_h = round(work * 0.293)        # 300/1024
    low_h = round(work * 0.137)         # 140/1024
    xs = (
        center - bar_w / 2 - gap - bar_w,
        center - bar_w / 2,
        center + bar_w / 2 + gap,
    )
    heights = (low_h, high_h, low_h)
    for x, h in zip(xs, heights):
        x0 = round(x)
        y0 = round(center - h / 2)
        draw.rounded_rectangle(
            [x0, y0, x0 + bar_w, y0 + h],
            radius=bar_r,
            fill=BAR,
        )

    if work != target:
        bg = bg.resize((target, target), Image.LANCZOS)
    return bg


def build_icns_from_iconset(iconset_dir: Path, output: Path) -> None:
    subprocess.run(["iconutil", "-c", "icns", str(iconset_dir), "-o", str(output)], check=True)


def build_ico(images: list[Image.Image], output: Path) -> None:
    base = images[-1]
    base.save(output, format="ICO", sizes=[(im.width, im.height) for im in images])


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    if ICONSET_DIR.exists():
        shutil.rmtree(ICONSET_DIR)
    ICONSET_DIR.mkdir()

    # Sizes shipped as standalone PNGs (used by Linux + favicon).
    png_sizes = [16, 32, 48, 64, 128, 256, 512, 1024]
    rendered: dict[int, Image.Image] = {s: make_icon(s) for s in png_sizes}

    # Master 1024×1024 used by electron-builder as a fallback.
    rendered[1024].save(RES / "icon.png", format="PNG", optimize=True)
    for size, img in rendered.items():
        img.save(ICONS_DIR / f"icon-{size}.png", format="PNG", optimize=True)

    # macOS iconset layout (used by iconutil to assemble icon.icns).
    # https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Optimizing/Optimizing.html
    iconset_map = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for size, name in iconset_map:
        rendered[size].save(ICONSET_DIR / name, format="PNG", optimize=True)
    build_icns_from_iconset(ICONSET_DIR, RES / "icon.icns")
    shutil.rmtree(ICONSET_DIR)  # iconset is a build artefact, no need to ship

    # Windows .ico (multi-resolution).
    ico_sizes = [16, 32, 48, 64, 128, 256]
    build_ico([rendered[s] for s in ico_sizes], RES / "icon.ico")

    print("rendered:")
    for size in png_sizes:
        path = ICONS_DIR / f"icon-{size}.png"
        print(f"  {path.relative_to(ROOT)}  {path.stat().st_size:>7} B")
    for extra in (RES / "icon.png", RES / "icon.icns", RES / "icon.ico"):
        print(f"  {extra.relative_to(ROOT)}  {extra.stat().st_size:>7} B")


if __name__ == "__main__":
    main()
