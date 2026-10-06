#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把静态站点文件组装到 dist/，供 Cloudflare Workers Static Assets 托管
（wrangler.jsonc 里 assets.directory = "./dist"）。

之所以不直接把仓库根目录作为 assets：
仓库里还有 content/ source/ tools/ schema/ 等开发用文件，没必要对外暴露；
仓库根目录同时还要继续给 GitHub Pages 用，所以保持不动、另出一份 dist/。

用法：
    python3 tools/build_site.py
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")

# 站点运行真正需要的文件 / 目录
FILES = ["index.html", "manifest.webmanifest", "sw.js"]
DIRS = ["css", "js", "data", "icons"]


def main():
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST)

    missing = []
    for name in FILES:
        src = os.path.join(ROOT, name)
        if not os.path.isfile(src):
            missing.append(name)
            continue
        shutil.copy2(src, os.path.join(DIST, name))

    for name in DIRS:
        src = os.path.join(ROOT, name)
        if not os.path.isdir(src):
            missing.append(name + "/")
            continue
        shutil.copytree(src, os.path.join(DIST, name))

    total = 0
    for base, _dirs, files in os.walk(DIST):
        total += len(files)
    print("dist/ 组装完成：%d 个文件" % total)
    for name in FILES + [d + "/" for d in DIRS]:
        print("  " + name)

    if missing:
        print("以下文件/目录缺失，请检查：", file=sys.stderr)
        for m in missing:
            print("  ! " + m, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
