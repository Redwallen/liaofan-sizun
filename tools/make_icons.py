#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成网站图标（PWA / apple-touch-icon / favicon）。

用法：
    python3 tools/make_icons.py

输出（写入 icons/）：
    icon-192.png            Android / PWA 常规图标
    icon-512.png            PWA 大图标（可作 maskable，图形留了安全边距）
    icon-maskable-512.png   显式 maskable 版本
    apple-touch-icon.png    iOS 添加到主屏幕（180×180）
    favicon-32.png          浏览器标签页
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")

# 品牌色（与网站 css 变量一致）
RED_TOP = (196, 74, 60)
RED_BOTTOM = (142, 43, 34)
CREAM = (247, 242, 231)

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]


def find_font():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit("找不到可用的中文字体，请修改 FONT_CANDIDATES")


def vertical_gradient(size, top, bottom):
    grad = Image.new("RGB", (1, size), top)
    d = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return grad.resize((size, size), Image.BILINEAR)


def draw_glyph(img, glyph, ratio, font_path):
    """在图片正中央画一个字，字高约为图片边长的 ratio。"""
    size = img.width
    target = int(size * ratio)
    # 逐步放大字号直到实测字高接近目标
    font = None
    for px in range(int(target * 0.7), int(target * 1.6)):
        f = ImageFont.truetype(font_path, px)
        box = f.getbbox(glyph)
        h = box[3] - box[1]
        font = f
        if h >= target:
            break
    box = font.getbbox(glyph)
    w, h = box[2] - box[0], box[3] - box[1]
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), glyph, font=font, fill=CREAM)
    return Image.alpha_composite(img.convert("RGBA"), layer)


def rounded(img, radius_ratio=0.22):
    """把方图裁成圆角方形（用于常规图标，maskable 不需要）。"""
    size = img.width
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * radius_ratio), fill=255
    )
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img.convert("RGBA"), (0, 0), mask)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    font = find_font()
    glyph = "凡"

    # PWA 大图标：满幅出血 + 居中字，字控制在中心 56%，符合 maskable 安全区
    base512 = vertical_gradient(512, RED_TOP, RED_BOTTOM)
    maskable = draw_glyph(base512, glyph, 0.54, font)

    maskable.save(os.path.join(OUT, "icon-maskable-512.png"))
    maskable.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"))
    maskable.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-512.png"))
    maskable.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, "apple-touch-icon.png"))

    # 标签页 favicon：小尺寸下字要更大更清楚
    fav_base = vertical_gradient(64, RED_TOP, RED_BOTTOM)
    fav = draw_glyph(fav_base, glyph, 0.66, font)
    rounded(fav, 0.24).resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, "favicon-32.png"))

    for name in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, name)
        print("  %-26s %d×%d" % (name, Image.open(p).width, Image.open(p).height))
    print("字体：%s" % font)


if __name__ == "__main__":
    main()
