# -*- coding: utf-8 -*-
"""可复现地拼装「材质 + 布局」两份 CSS，并检查能否被浏览器/CSS 解析器正确吃下。

用法：
  python scripts/build-css.py            # 只拼接与检查，不写文件（dry run）
  python scripts/build-css.py --write    # 写出 assets/widget.css / assets/settings.css 的拼接产物

现状说明：
  运行时由 index.js 在 serveAsset 里把 liquid-glass.css 拼进 widget.css / settings.css，
  开发期不需要产物文件。这个脚本用于：
    1) 快速确认拼接顺序（材质在前、布局在后）
    2) 用和浏览器一致的规则扫描「注释里嵌套 /*」「空选择器裸 {}」「花括号不配对」
       这类会静默丢规则的写法（本轮真实踩过：一条注释里嵌了 /*，后半段规则全丢）

退出码非 0 表示有问题，可直接放进提交前检查。
注意：注释里不要出现成对的闭注释符号，否则本文件的扫描器自己会被截断。
"""
import io
import re
import sys

PAIRS = [
    ("assets/widget.css", ["assets/liquid-glass.css", "assets/widget.css"]),
    (
        "assets/settings.css",
        ["assets/liquid-glass.css", "assets/settings.css", "assets/liquid-glass-settings.css"],
    ),
]

OPEN_C = "/" + "*"
CLOSE_C = "*" + "/"


def strip_comments(text):
    out = []
    i = 0
    n = len(text)
    problems = []
    while i < n:
        j = text.find(OPEN_C, i)
        if j < 0:
            out.append(text[i:])
            break
        out.append(text[i:j])
        k = text.find(CLOSE_C, j + 2)
        if k < 0:
            problems.append("未闭合的注释，起始位置 %d" % j)
            break
        seg = text[j + 2 : k]
        if OPEN_C in seg:
            line = text.count("\n", 0, j) + 1
            problems.append("第 %d 行的注释体里又出现开注释符，后面的规则会被整段丢弃" % line)
        i = k + 2
    return "".join(out), problems


def check(text):
    body, problems = strip_comments(text)
    depth = 0
    for ch in body:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                problems.append("出现多余的 }")
                depth = 0
    if depth != 0:
        problems.append("花括号不配对，缺少 %d 个 }" % depth)
    for _m in re.finditer(r"(^|})\s*\{", body):
        problems.append("出现空选择器的裸 {} 块，整块会被丢弃")
        break
    if not re.search(r"--lg-fill\s*:", text):
        problems.append("没有找到材质变量 --lg-fill，liquid-glass.css 可能没被拼进来")
    return problems


def main(argv):
    write = "--write" in argv
    failed = False
    for out, parts in PAIRS:
        text = ""
        for p in parts:
            text += io.open(p, encoding="utf-8").read() + "\n"
        problems = check(text)
        if write:
            io.open(out, "w", encoding="utf-8", newline="\n").write(text)
        if problems:
            print("[x] %s: %s" % (out, " / ".join(problems)))
            failed = True
        else:
            print("[ok] %s (%d bytes, %s)" % (out, len(text.encode("utf-8")), "written" if write else "dry-run"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
