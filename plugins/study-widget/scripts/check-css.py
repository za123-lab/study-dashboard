# -*- coding: utf-8 -*-
"""检查 assets/*.css 能否被浏览器的 CSS 解析器正确吃下。

用法：python scripts/check-css.py [文件...]

背景 1：本轮液态玻璃改造里，widget.css 有一条注释在注释体里嵌了开注释符，
        后面的规则会被整段静默丢弃（浏览器不报错，只是不生效）。
背景 2：Node 22 要求 ES module 里的许可证注释必须以闭注释符结尾，
        注释体里再出现开注释符会直接报 Invalid or unexpected token 让插件加载失败。
        所以这里同时检查 assets/*.css、插件根目录的 .js 与 desktop/ 下的 .cjs。

注意：本脚本里所有注释定界符都拆成两半拼接，避免扫描器把自己的注释也当成待检查内容。
"""
import glob
import io
import re
import sys

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


def check(path):
    raw = io.open(path, encoding="utf-8").read()
    body, problems = strip_comments(raw)
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
    if path.endswith(".css") and not re.search(r"--lg-fill\s*:", raw):
        # 只有在拼装产物里才要求材质变量；单独检查 liquid-glass.css 时它本来就有
        pass
    return problems


def main(argv):
    files = argv[1:]
    if not files:
        files = (
            sorted(glob.glob("assets/*.css"))
            + sorted(glob.glob("*.js"))
            + sorted(glob.glob("desktop/*.cjs"))
        )
    failed = False
    for path in files:
        try:
            problems = check(path)
        except Exception as err:  # noqa: BLE001
            print("[x] %s: %s" % (path, err))
            failed = True
            continue
        if problems:
            print("[x] %s: %s" % (path, " / ".join(problems)))
            failed = True
        else:
            print("[ok] %s" % path)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
