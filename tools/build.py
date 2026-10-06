#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 content/*.json 合并成 data/book.js（供 index.html 直接 <script> 引入，
避免 file:// 下 fetch 被 CORS 拦截），同时做原文覆盖校验。

用法：
    python3 tools/build.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "content")
SOURCE = os.path.join(ROOT, "source")
DATA = os.path.join(ROOT, "data")

# (文件名, 章号) —— 顺序即阅读顺序
FILES = [
    ("ch1.json", 1),
    ("ch2.json", 2),
    ("ch3a.json", 3),
    ("ch3b.json", 3),
    ("ch4.json", 4),
]

SOURCE_BY_CHAPTER = {
    1: "01-立命之学.txt",
    2: "02-改过之法.txt",
    3: "03-积善之方.txt",
    4: "04-谦德之效.txt",
}

KEEP = re.compile(r"[\u4e00-\u9fff0-9A-Za-z]")


def read_json(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    i, j = raw.find("{"), raw.rfind("}")
    if i == -1 or j == -1:
        raise ValueError("找不到 JSON 对象：%s" % path)
    return json.loads(raw[i:j + 1])


def norm(text):
    return "".join(KEEP.findall(text or ""))


def first_diff(a, b):
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i, a[max(0, i - 20):i + 20], b[max(0, i - 20):i + 20]
    if len(a) != len(b):
        return n, a[n:n + 25], b[n:n + 25]
    return None, "", ""


def main():
    chapters = {}
    order = []
    problems = []

    for fname, chno in FILES:
        path = os.path.join(CONTENT, fname)
        if not os.path.exists(path):
            problems.append("缺少内容文件：content/%s" % fname)
            continue
        try:
            obj = read_json(path)
        except Exception as e:  # noqa: BLE001
            problems.append("解析失败 content/%s：%s" % (fname, e))
            continue

        secs = obj.get("sections") or []
        if not secs:
            problems.append("content/%s 里没有 sections" % fname)
            continue

        if chno not in chapters:
            chapters[chno] = {
                "chapter": chno,
                "title": obj.get("title", ""),
                "subtitle": obj.get("subtitle", ""),
                "intro": obj.get("intro", ""),
                "sections": [],
            }
            order.append(chno)
        chapters[chno]["sections"].extend(secs)

    # 去掉误把「章标题」当作原文的条目，并按篇重新编号
    for chno in order:
        ch = chapters[chno]
        title_n = norm(ch["title"])
        secs_in = ch["sections"]
        if secs_in:
            first = secs_in[0]
            ps = first.get("pairs") or []
            if ps:
                first_orig_n = norm(ps[0].get("orig", ""))
                if first_orig_n and first_orig_n == title_n and len(first_orig_n) <= 8:
                    first["pairs"] = ps[1:]
        secs_in = [s for s in secs_in if (s.get("pairs") or [])]

        clean = []
        for i, s in enumerate(secs_in, 1):
            pairs = []
            for p in s.get("pairs") or []:
                o = (p.get("orig") or "").strip()
                t = (p.get("trans") or "").strip()
                if not o:
                    continue
                pairs.append({"orig": o, "trans": t})
            notes = []
            for n in s.get("notes") or []:
                term = (n.get("term") or "").strip()
                ex = (n.get("explain") or "").strip()
                if term and ex:
                    notes.append({"term": term, "explain": ex})
            clean.append({
                "id": "ch%d-s%02d" % (chno, i),
                "title": (s.get("title") or "第 %d 节" % i).strip(),
                "pairs": pairs,
                "notes": notes,
                "insight": (s.get("insight") or "").strip(),
            })
        ch["sections"] = clean

    # 原文覆盖校验
    report = []
    for chno in order:
        ch = chapters[chno]
        src_path = os.path.join(SOURCE, SOURCE_BY_CHAPTER[chno])
        if not os.path.exists(src_path):
            report.append("第%d篇：找不到源文 %s，跳过校验" % (chno, SOURCE_BY_CHAPTER[chno]))
            continue
        src_raw = open(src_path, encoding="utf-8").read()
        src_lines = [l.strip() for l in src_raw.splitlines() if l.strip()]
        src_body = "\n".join(src_lines[1:]) if src_lines and len(src_lines[0]) <= 8 else src_raw
        src_n = norm(src_body)

        got_n = norm("".join("".join(p["orig"] for p in s["pairs"]) for s in ch["sections"]))
        if src_n == got_n:
            report.append("第%d篇 %s：原文完整 ✓（%d 节 / %d 句）" % (
                chno, ch["title"], len(ch["sections"]), sum(len(s["pairs"]) for s in ch["sections"])))
        else:
            k, A, B = first_diff(src_n, got_n) or (None, "", "")
            report.append("第%d篇 %s：原文与源文不一致 ✗ 源文 %d 字 / 内容 %d 字" % (
                chno, ch["title"], len(src_n), len(got_n)))
            report.append("      首个差异在第 %s 字附近：源文「%s」 内容「%s」" % (k, A, B))

    # 组装
    book = {
        "title": "了凡四训",
        "author": "袁了凡",
        "chapters": [chapters[c] for c in order],
    }

    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "book.json"), "w", encoding="utf-8") as f:
        json.dump(book, f, ensure_ascii=False, indent=2)
    with open(os.path.join(DATA, "book.js"), "w", encoding="utf-8") as f:
        f.write("/* 由 tools/build.py 自动生成，请勿手改；改内容请改 content/*.json 后重新构建 */\n")
        f.write("window.BOOK = ")
        json.dump(book, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    total_secs = sum(len(ch["sections"]) for ch in book["chapters"])
    total_pairs = sum(len(s["pairs"]) for ch in book["chapters"] for s in ch["sections"])
    total_notes = sum(len(s["notes"]) for ch in book["chapters"] for s in ch["sections"])

    print("=" * 62)
    print("构建完成：%d 篇 / %d 节 / %d 句 / %d 条注释" % (
        len(book["chapters"]), total_secs, total_pairs, total_notes))
    print("输出：data/book.js, data/book.json")
    print("-" * 62)
    for line in report:
        print(line)
    if problems:
        print("-" * 62)
        print("需要注意：")
        for p in problems:
            print("  ! " + p)
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
