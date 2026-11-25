/* 学业工作台 · 小组件渲染（桌面小窗与 DSH 侧栏面板共用）
 *
 * 两个入口：
 *   mode="widget" —— 独立 Electron 小窗。带 ?t=<token>，用权限令牌换数据；
 *                    顶栏可拖动窗口，占满整个页面。
 *   mode="panel"  —— DSH 侧栏标签页。宿主已鉴权，直接 /api/summary。
 *
 * 数据接口（host 侧）：
 *   GET /dsh-study-widget/api/summary?token=...   整份统计快照
 *   GET /dsh-study-widget/api/status              数据源/凭据状态
 */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var MODE = params.get("mode") === "panel" ? "panel" : "widget";
  var TOKEN = params.get("t") || "";
  var BASE = "/dsh-study-widget";
  var REFRESH_MS = 5 * 60 * 1000;

  var body = document.body;
  var root = document.getElementById("root");
  var bodyEl = document.getElementById("body");
  var footText = document.getElementById("footText");
  var dot = document.getElementById("sourceDot");
  var btnRefresh = document.getElementById("btnRefresh");
  var btnPin = document.getElementById("btnPin");
  var btnMin = document.getElementById("btnMin");
  var btnClose = document.getElementById("btnClose");
  var btnOpen = document.getElementById("btnOpen");

  var desktop = window.studyWidget || null;
  var timer = null;
  var lastSummary = null;
  var lastStatus = null; /* 最近一次读到的 source.status，写入后重绘时原样带回去 */
  var themeMedia = null;

  body.dataset.mode = MODE;
  applyTheme();
  document.documentElement.style.setProperty("--sw-radius", MODE === "widget" ? "16px" : "0px");

  /* ---------- 主题 ----------
   * 小窗：跟随系统深浅（Electron 的 nativeTheme 通过 preload 注入 window.studyWidget.getTheme()，
   *       拿不到就退回 matchMedia，再退 dark）。
   * 面板/侧栏：跟随 DSH 宿主 —— 宿主在 iframe 外层写 body[data-ds-dark-theme]，
   *       同一棵 DOM 上 classList 变了我们就跟着换，不留「宿主浅色、面板深色」的错位。
   */
  function systemPrefersLight() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    } catch (e) {
      return false;
    }
  }

  function hostPrefersLight() {
    var html = document.documentElement;
    var b = document.body;
    if (html.hasAttribute("data-ds-dark-theme") || b.hasAttribute("data-ds-dark-theme")) return false;
    // 宿主显式声明浅色时优先（DSH 会在宿主 body 上打这个标记）。
    // 注意：这里绝不能读 data-theme —— 那是 applyTheme 自己写进本页面的，
    // 读它等于把自己的输出当输入，第一次算完就固定死，宿主再切也不跟。
    if (html.getAttribute("data-theme") === "light" || b.getAttribute("data-theme") === "light") return true;
    // 宿主没打标记：看宿主的底色亮度，亮底就用浅色玻璃
    var bg = getComputedStyle(b).backgroundColor || "";
    var m = bg.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var p = m[1].split(",").map(function (x) {
        return parseFloat(x);
      });
      var lum = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
      if (p.length < 4 || p[3] > 0.5) return lum > 0.55;
    }
    return systemPrefersLight();
  }

  /**
   * applyTheme 自己写 html/body 的 data-theme，而下面两个 MutationObserver 监听的正是它。
   * 没有闸门时：写入 → observer → applyTheme → 再写入 → 无限同步递归，
   * 面板/设置页一点主题就把渲染主线程锁死。写入期间置位，回调看到就跳过。
   */
  var APPLYING_THEME = false;

  function applyTheme(themeOverride) {
    if (APPLYING_THEME) return;
    APPLYING_THEME = true;
    try {
      var light;
      if (MODE === "panel") light = hostPrefersLight();
      else if (themeOverride && typeof themeOverride.light === "boolean") {
        // 主进程 nativeTheme 变化时推来的实时值。
        // 必须优先于 getTheme()：那是 preload 加载时的静态快照，系统切主题后不会更新，
        // 用它会把刚收到的正确值覆盖回旧状态（小窗"不跟随系统"就是这么来的）。
        light = themeOverride.light;
      } else if (window.studyWidget && typeof window.studyWidget.getTheme === "function") {
        // preload 里是同步快照（contextBridge 也允许传值），拿不到就落到下面的 matchMedia
        var t = window.studyWidget.getTheme();
        light = t && typeof t.light === "boolean" ? t.light : systemPrefersLight();
      } else light = systemPrefersLight();
      document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
      body.dataset.theme = light ? "light" : "dark";
    } finally {
      APPLYING_THEME = false;
    }
  }

  if (MODE !== "panel") {
    // 系统主题变化时实时跟随（小窗常驻，不能要求重启）
    try {
      themeMedia = window.matchMedia("(prefers-color-scheme: light)");
      var onScheme = function () {
        applyTheme();
      };
      if (themeMedia.addEventListener) themeMedia.addEventListener("change", onScheme);
      else if (themeMedia.addListener) themeMedia.addListener(onScheme);
    } catch (e) {
      themeMedia = null;
    }
    // 主进程的 nativeTheme 事件也接一条：Electron 里的 prefers-color-scheme 由它驱动，双保险。
    // 回调把主进程推来的实时主题直接交给 applyTheme —— 不能只调 applyTheme()，
    // 那样它会回头读 preload 的旧快照，等于把正确值丢掉。
    if (desktop && typeof desktop.onThemeChanged === "function") {
      desktop.onThemeChanged(function (theme) {
        applyTheme(theme);
      });
    }
  } else {
    // 宿主切深浅色时会改 body 的 attribute/class，监听它。
    // 关键：回调不能再同步调 applyTheme（那会写回同两个属性，形成自激递归）。
    // 统一丢进微任务，并在 applyTheme 内部用 APPLYING_THEME 挡住自己写出的变化。
    try {
      var onHostThemeChange = function () {
        Promise.resolve().then(applyTheme);
      };
      new MutationObserver(onHostThemeChange).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-ds-dark-theme"],
      });
      new MutationObserver(onHostThemeChange).observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "data-ds-dark-theme"],
      });
    } catch (e) {
      /* 老浏览器没有 MutationObserver：保持首帧主题 */
    }
  }

  // ---------- 小工具 ----------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "text") node.textContent = String(v);
        else if (k === "class") node.className = v;
        else if (k.indexOf("on") === 0 && typeof v === "function") node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? "" : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /**
   * 内联 SVG 图标。统一用 stroke=currentColor，直接跟随所在按钮/文字的颜色与主题，
   * 不用 emoji（跨系统字形不一致、Electron 里会走彩色字体）也不用 Unicode 符号（可能缺字成方块）。
   */
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ICON_PATHS = {
    check: "M5 12.5l4.2 4.2L19 7",
    close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  };

  function svgIcon(name, size) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var px = size || 12;
    svg.setAttribute("width", String(px));
    svg.setAttribute("height", String(px));
    svg.classList.add("icon");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICON_PATHS[name] || "");
    svg.appendChild(path);
    return svg;
  }

  function fmtAgo(ms) {
    if (!ms) return "";
    var diff = Date.now() - ms;
    if (diff < 60000) return "刚刚同步";
    if (diff < 3600000) return Math.round(diff / 60000) + " 分钟前同步";
    if (diff < 86400000) return Math.round(diff / 3600000) + " 小时前同步";
    return Math.round(diff / 86400000) + " 天前同步";
  }

  function clampPct(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.min(100, Math.max(0, Math.round(n)));
  }

  // ---------- 渲染 ----------

  function renderTiles(s) {
    var tiles = el("div", { class: "tiles" });
    function tile(label, value, unit) {
      return el("div", { class: "tile" }, [
        el("div", { class: "tile-label", text: label }),
        el("div", { class: "tile-value" }, [
          document.createTextNode(String(value)),
          unit ? el("small", { text: unit }) : null,
        ]),
      ]);
    }
    tiles.appendChild(tile("今日学习", s.today.minText, "时:分"));
    tiles.appendChild(tile("连续天数", s.today.streak, "天"));
    tiles.appendChild(tile("今日完成待办", s.today.todosDone, "/ " + s.today.todosOpen + " 待办"));
    tiles.appendChild(tile("今日打卡", s.today.checkins, s.today.checkinsTotal ? "/ " + s.today.checkinsTotal : "次"));
    return tiles;
  }

  function renderOverall(s) {
    var pct = clampPct(s.overall.pct);
    var card = el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("span", { class: "card-title", text: "总进度" }),
        el("span", { class: "card-extra", text: s.overall.doneLessons + " / " + s.overall.count + " 节完成" }),
      ]),
      el("div", { class: "progress-row" }, [
        el("div", { class: "progress-num" }, [document.createTextNode(String(pct)), el("span", { text: "%" })]),
        el("div", { class: "progress-meta" }, [
          el("div", { class: "progress-bar" }, [el("i", { style: "width:" + pct + "%" })]),
          el("div", { class: "progress-sub" }, [
            el("span", { text: "已看 " + s.overall.watchedText }),
            el("span", { text: "剩 " + s.overall.remainingText + " / 共 " + s.overall.totalText }),
          ]),
        ]),
      ]),
    ]);
    return card;
  }

  function renderCourses(s) {
    var card = el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("span", { class: "card-title", text: "课程进度" }),
        el("span", { class: "card-extra", text: s.overall.totalText + " 总时长" }),
      ]),
    ]);
    if (!s.courses.length) {
      card.appendChild(el("p", { class: "empty-hint", text: "还没有登记课程" }));
      return card;
    }
    s.courses.forEach(function (c) {
      var pct = clampPct(c.stats.pct);
      card.appendChild(
        el("div", { class: "course" }, [
          el("div", { class: "course-top" }, [
            el("span", { class: "course-name", text: c.name, title: c.name }),
            el("span", { class: "course-pct", text: pct + "%" }),
          ]),
          el("div", { class: "course-bar" }, [el("i", { style: "width:" + pct + "%" })]),
          el("div", {
            class: "course-sub",
            text:
              c.stats.doneLessons +
              "/" +
              c.stats.count +
              " 节 · " +
              c.stats.watchedText +
              " / " +
              c.stats.totalText +
              " · 剩 " +
              c.stats.remainingText,
          }),
        ])
      );
    });
    return card;
  }

  function todoRow(t) {
    var check = el("button", {
      type: "button",
      class: "todo-check",
      "data-todo-toggle": t.id,
      "data-done": String(!!t.done),
      "aria-pressed": t.done ? "true" : "false",
      title: t.done ? "取消完成" : "标记完成",
    });
    if (t.done) check.appendChild(svgIcon("check", 10));
    return el("div", { class: "todo", "data-done": String(!!t.done) }, [
      check,
      el("span", { class: "todo-pri", "data-pri": t.pri, text: t.pri }),
      el("div", { class: "todo-main" }, [
        el("div", { class: "todo-title", text: t.title, title: t.title }),
        el("div", { class: "todo-sub" }, [
          el("span", { class: "u-" + (t.urgency || "none"), text: t.left }),
          el("span", { text: t.due ? t.dueLabel : "无截止" }),
          el("span", { class: "todo-cat", text: t.catLabel }),
        ]),
      ]),
    ]);
  }

  function renderTodos(s) {
    var t = s.todos;
    var card = el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("span", { class: "card-title", text: "待办" }),
        el("span", {
          class: "card-extra",
          text: "逾期 " + s.counts.overdue + " · 今天 " + s.counts.today + " · 本周 " + s.counts.week,
        }),
      ]),
    ]);
    var list = t.overdue.concat(t.soon, t.week, t.later);
    // 逾期/即将到期的排前面，去重（同一待办可能既逾期又出现在今日列表里）
    var seen = {};
    var rows = [];
    list.forEach(function (x) {
      if (seen[x.id]) return;
      seen[x.id] = 1;
      rows.push(x);
    });
    if (!rows.length) {
      card.appendChild(el("p", { class: "empty-hint", text: "没有未完成的待办 🎉" }));
      return card;
    }
    rows.slice(0, 6).forEach(function (x) {
      card.appendChild(todoRow(x));
    });
    if (rows.length > 6) {
      card.appendChild(el("div", { class: "course-sub", text: "还有 " + (rows.length - 6) + " 条未显示" }));
    }
    return card;
  }

  function renderCheckins(s) {
    if (!s.checkins.length) return null;
    var card = el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("span", { class: "card-title", text: "循环打卡" }),
        el("span", { class: "card-extra", text: s.today.checkins + " 次今日记录" }),
      ]),
    ]);
    s.checkins.forEach(function (c) {
      var state = el("span", { class: "checkin-state", "data-done": String(c.done) });
      if (c.done) state.appendChild(svgIcon("check", 10));
      var row = el("div", {
        class: "checkin",
        "data-checkin-toggle": c.id,
        "data-kind": c.kind,
        "data-done": String(!!c.done),
        role: "button",
        tabindex: "0",
        title: "打开打卡",
      }, [
        state,
        el("span", { class: "checkin-name", text: c.name, title: c.courseName || c.name }),
        el("span", { class: "checkin-status", "data-due": String(c.due), text: checkinStatusText(c) }),
      ]);
      card.appendChild(row);
    });
    return card;
  }

  function renderHeat(s) {
    var card = el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("span", { class: "card-title", text: "学习热力图" }),
        el("span", { class: "card-extra", text: "共 " + s.totals.activityText + " · 近 7 天日均 " + s.today.minutes7 + " 分" }),
      ]),
    ]);
    var grid = el("div", { class: "heat" });
    s.heat.cells.forEach(function (cell) {
      grid.appendChild(
        el("i", {
          "data-level": cell.min == null ? 0 : cell.level,
          "data-future": cell.min == null ? "true" : null,
          title: cell.key + (cell.min == null ? "" : " · " + cell.min + " 分钟"),
        })
      );
    });
    card.appendChild(grid);

    var week = el("div", { class: "week" });
    var max = 1;
    s.week.forEach(function (d) {
      if (d.min > max) max = d.min;
    });
    s.week.forEach(function (d) {
      var h = d.min > 0 ? Math.max(3, Math.round((d.min / max) * 34)) : 2;
      week.appendChild(
        el("div", { class: "week-day", title: d.key + " · " + d.min + " 分钟" }, [
          el("div", { class: "week-col" }, [el("i", { "data-zero": d.min ? null : "true", style: "height:" + h + "px" })]),
          document.createTextNode(d.label),
        ])
      );
    });
    card.appendChild(week);
    return card;
  }

  function nextLine(s) {
    var n = s.today.next;
    if (!n) return "暂无带截止日期的待办";
    return "最近截止：" + n.title + " · " + n.left;
  }

  function renderError(info) {
    clear(bodyEl);
    var box = el("div", { class: "error-box" }, [
      el("div", { class: "error-title", text: "读不到学习数据" }),
      el("div", { text: (info && info.message) || "未知错误" }),
    ]);
    if (info && info.path) box.appendChild(el("code", { text: info.path }));
    if (info && info.code === "NO_CREDENTIALS") {
      box.appendChild(
        el("div", {
          class: "course-sub",
          style: "margin-top:8px",
          text: "新建上面这个文件，填入 {\"url\", \"anonKey\", \"email\", \"password\"}（与网页端设置页里的 Supabase 配置一致），保存后点右上角刷新按钮。",
        })
      );
      box.appendChild(
        el("button", {
          class: "link-btn",
          style: "margin-top:6px",
          text: "复制配置模板",
          onclick: function () {
            var tpl = JSON.stringify(
              { url: "https://xxxx.supabase.co", anonKey: "你的 anon key", email: "you@example.com", password: "你的密码" },
              null,
              2
            );
            try {
              navigator.clipboard.writeText(tpl);
              footText.textContent = "模板已复制到剪贴板";
            } catch (e) {
              footText.textContent = "复制失败，请手动填写";
            }
          },
        })
      );
    }
    box.appendChild(
      el("div", {
        class: "course-sub",
        style: "margin-top:8px",
        text: "填好凭据后点右上角刷新按钮。桌面小窗不共享浏览器的 localStorage，所以桌面端按 Supabase 登录读写（与网页端同一套协议）。",
      })
    );
    bodyEl.appendChild(box);
    dot.dataset.kind = "error";
    footText.textContent = (info && info.code) || "未配置";
  }

  function render(s, status) {
    lastSummary = s;
    lastStatus = status || null;
    clear(bodyEl);
    bodyEl.appendChild(renderTiles(s));
    bodyEl.appendChild(renderOverall(s));
    var ci = renderCheckins(s);
    if (ci) bodyEl.appendChild(ci);
    bodyEl.appendChild(renderTodos(s));
    bodyEl.appendChild(renderCourses(s));
    bodyEl.appendChild(renderHeat(s));

    var stale = !!(status && status.error);
    dot.dataset.kind = stale ? "stale" : s.source === "file" ? "file" : "supabase";
    dot.title = stale
      ? "上次同步失败：" + status.error.message
      : (s.email ? s.email + " · " : "") + (s.source === "file" ? "本地文件" : "Supabase 云端");
    footText.textContent = (s.rev ? "rev " + s.rev + " · " : "") + (fmtAgo(s.syncedAt) || "已读取") + (stale ? " · 显示缓存" : "");
    root.dataset.state = "ready";
  }

  // ---------- 数据 ----------

  function apiUrl(path) {
    var q = TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "";
    return BASE + path + q;
  }

  /**
   * 写入请求（勾选 / 打卡）。
   * 成功后服务端会回传最新 summary，直接用 drawNow 重绘，
   * 不再额外发一次 GET——少一次往返，也避免刚写完就读到旧值的窗口。
   * 失败一律把 message 抛给调用方去提示，这里不吞。
   */
  function apiPost(path, body) {
    var url = BASE + path + (TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "");
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
      cache: "no-store",
    })
      .then(function (res) {
        return res.json().then(
          function (payload) {
            return { ok: res.ok, payload: payload };
          },
          function () {
            return { ok: false, payload: { ok: false, error: { message: "服务端返回的不是 JSON（HTTP " + res.status + ")" } } };
          }
        );
      })
      .then(function (r) {
        if (!r.ok || !r.payload || r.payload.ok === false) {
          var err = (r.payload && r.payload.error) || {};
          var e = new Error(err.message || "操作失败");
          e.code = err.code || "WRITE_FAILED";
          throw e;
        }
        if (r.payload.summary) render(r.payload.summary, lastStatus);
        return r.payload;
      });
  }

  function load(manual) {
    if (manual) btnRefresh.dataset.busy = "true";
    return fetch(apiUrl("/api/summary"), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (res) {
        return res.json().then(function (payload) {
          return { ok: res.ok, payload: payload };
        });
      })
      .then(function (r) {
        if (!r.ok || !r.payload || r.payload.ok === false) {
          var err = (r.payload && r.payload.error) || { message: "HTTP 请求失败" };
          renderError(err);
          return;
        }
        render(r.payload.summary, r.payload.status);
      })
      .catch(function (err) {
        renderError({ code: "NETWORK", message: "连不上宿主：" + ((err && err.message) || err) });
      })
      .then(function () {
        btnRefresh.dataset.busy = "";
      });
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (!document.hidden) load(false);
    }, REFRESH_MS);
  }

  // ---------- 交互 ----------

  /**
   * 底部那行字临时用来报告一次操作结果，2.4 秒后恢复成同步状态。
   * 小窗没地方放 toast，脚注是最不打断的位置。
   */
  var flashTimer = null;
  function flash(text, tone) {
    if (flashTimer) clearTimeout(flashTimer);
    footText.textContent = text;
    footText.dataset.tone = tone || "";
    flashTimer = setTimeout(function () {
      flashTimer = null;
      footText.dataset.tone = "";
      if (lastSummary) {
        var s = lastSummary;
        footText.textContent = (s.rev ? "rev " + s.rev + " · " : "") + (fmtAgo(s.syncedAt) || "已读取");
      }
    }, 2400);
  }


  /* ---------- 打卡弹层（参考小程序版：弹层 + 默认当前节次 + 一天可多次） ---------- */

  /** 分钟数 → "1:05"，前端只做即时回显，统计口径仍在宿主 fmtDur */
  function fmtMinText(min) {
    var m = Math.max(0, Math.round(Number(min) || 0));
    return Math.floor(m / 60) + ":" + (m % 60 < 10 ? "0" : "") + (m % 60);
  }

  /** "1:05" / "65" / "1小时5分" → 分钟数；看不懂返回 null */
  function parseMinText(raw) {
    var text = String(raw == null ? "" : raw).trim();
    if (!text) return null;
    var hm = text.match(/^(\d+)\s*[:：]\s*(\d{1,2})$/);
    if (hm) {
      var h = Number(hm[1]);
      var mm = Number(hm[2]);
      if (!Number.isFinite(h) || !Number.isFinite(mm) || mm >= 60) return null;
      return h * 60 + mm;
    }
    var cn = text.match(/^(?:(\d+)\s*(?:小时|h|H))?\s*(?:(\d+)\s*(?:分钟|分|m|M))?$/);
    if (cn && (cn[1] || cn[2])) {
      var hh = Number(cn[1] || 0);
      var mi = Number(cn[2] || 0);
      if (!Number.isFinite(hh) || !Number.isFinite(mi)) return null;
      return hh * 60 + mi;
    }
    var num = Number(text);
    if (Number.isFinite(num) && num > 0) return Math.round(num);
    return null;
  }

  /** 已记录打卡的时间：只显示时分，小窗够用 */
  function fmtClock(at) {
    var v = Number(at);
    if (!v) return "刚刚";
    var d = new Date(v);
    var h = d.getHours();
    var mi = d.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (mi < 10 ? "0" : "") + mi;
  }

  var sheetEl = null;

  /**
   * 打开打卡弹层。
   *
   * 一次打卡要同时表达「哪一节 + 这次看了多久」，行内输入塞不下，所以走弹层；
   * 小程序版也是 Sheet 弹层，保持一致。
   * 默认选中「当前节次」= 第一个还没看完的课时；这一节看完后，下次自然落到下一节。
   */
  function openCheckinSheet(c) {
    closeCheckinSheet();
    var isVideo = c.kind === "video";
    var options = Array.isArray(c.lessonOptions) ? c.lessonOptions.slice() : [];

    function firstOpenOption() {
      for (var i = 0; i < options.length; i++) {
        if (!options[i].done) return options[i];
      }
      return null;
    }

    var pickedId = c.current ? c.current.id : firstOpenOption() ? firstOpenOption().id : options[0] ? options[0].id : "";

    var mask = el("div", { class: "sheet-mask" });
    var card = el("div", { class: "sheet-card", role: "dialog", "aria-modal": "true", "aria-label": "打卡" });
    mask.appendChild(card);

    function close() {
      closeCheckinSheet();
    }
    mask.addEventListener("click", function (e) {
      if (e.target === mask) close();
    });
    card.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });

    /* ---- 头部 ---- */
    var head = el("div", { class: "sheet-head" }, [
      el("div", { class: "sheet-head-main" }, [
        el("div", { class: "sheet-kicker", text: "打卡 · CHECK IN" }),
        el("div", { class: "sheet-title", text: c.name }),
      ]),
      el("button", { type: "button", class: "sheet-close", "aria-label": "关闭", onclick: close }, [svgIcon("close", 12)]),
    ]);

    var body = el("div", { class: "sheet-body" });

    /* ---- 今天已记录（一天多次时逐条列出） ---- */
    var todayLogs = Array.isArray(c.todayLogs) ? c.todayLogs : [];
    if (todayLogs.length) {
      var list = el("div", { class: "sheet-logs" });
      list.appendChild(
        el("div", {
          class: "sheet-logs-head",
          text: "今天已记 " + todayLogs.length + " 次" + (c.todayMin ? " · 共 " + fmtMinText(c.todayMin) : ""),
        })
      );
      todayLogs.forEach(function (log) {
        list.appendChild(
          el("div", { class: "sheet-log" }, [
            el("span", { class: "sheet-log-time", text: fmtClock(log.at) }),
            el("span", { class: "sheet-log-main", text: log.idx ? "第 " + log.idx + " 节" : "打卡" }),
            log.min ? el("span", { class: "sheet-log-min", text: "+" + fmtMinText(log.min) }) : null,
          ])
        );
      });
      body.appendChild(list);
    }

    /* ---- 节次 + 时长 ---- */
    var selectEl = null;
    var progressEl = null;
    var minInput = null;

    if (isVideo) {
      if (!options.length) {
        body.appendChild(el("p", { class: "sheet-empty", text: "这门课还没有课时，先去网页版添加一节。" }));
      } else {
        var field = el("div", { class: "sheet-field" });
        field.appendChild(el("label", { class: "sheet-label", for: "checkinLesson", text: "节次" }));
        selectEl = el("select", { id: "checkinLesson", class: "sheet-select" });
        options.forEach(function (o) {
          selectEl.appendChild(
            el("option", {
              value: o.id,
              text: "第 " + o.index + " 节 · " + o.title + (o.done ? "（已看完）" : ""),
            })
          );
        });
        if (pickedId) selectEl.value = pickedId;
        field.appendChild(selectEl);
        body.appendChild(field);

        progressEl = el("div", { class: "sheet-progress" });
        body.appendChild(progressEl);

        var minField = el("div", { class: "sheet-field" });
        minField.appendChild(el("label", { class: "sheet-label", for: "checkinMin", text: "本次新增时长" }));
        minInput = el("input", {
          id: "checkinMin",
          class: "sheet-input",
          type: "text",
          inputmode: "numeric",
          placeholder: "例如 25 或 0:25",
          autocomplete: "off",
        });
        minField.appendChild(minInput);
        minField.appendChild(
          el("p", { class: "sheet-hint", text: "填这一次看了多久；多次打卡逐条累加，不覆盖已有记录。" })
        );
        body.appendChild(minField);
      }
    } else {
      body.appendChild(el("p", { class: "sheet-hint", text: "自定义打卡只记录次数与时间，不计入课程进度。" }));
    }

    var noteInput = el("input", {
      class: "sheet-input",
      type: "text",
      maxlength: "80",
      placeholder: "备注（可选）",
      autocomplete: "off",
    });
    var noteField = el("div", { class: "sheet-field" });
    noteField.appendChild(noteInput);
    body.appendChild(noteField);

    /* ---- 节次切换：刷新进度提示 ---- */
    function currentOption() {
      if (!selectEl) return null;
      for (var i = 0; i < options.length; i++) {
        if (options[i].id === selectEl.value) return options[i];
      }
      return null;
    }

    function paintProgress() {
      var o = currentOption();
      if (!progressEl) return;
      clear(progressEl);
      if (!o) {
        progressEl.appendChild(el("span", { class: "sheet-progress-text", text: "先选修一节" }));
        return;
      }
      if (o.done) {
        progressEl.appendChild(
          el("span", { class: "sheet-progress-text", "data-tone": "done", text: "这一节已看完，可以换下一节" })
        );
        return;
      }
      var rest = o.totalMin > 0 ? Math.max(0, o.totalMin - o.watchedMin) : 0;
      progressEl.appendChild(
        el("span", {
          class: "sheet-progress-text",
          text:
            "已看 " +
            o.watchedText +
            (o.totalMin > 0 ? " / " + o.totalText : "（未填总时长）") +
            (rest > 0 ? " · 还剩 " + fmtMinText(rest) : ""),
        })
      );
      if (minInput) {
        var suggest = o.totalMin > 0 ? Math.min(Math.max(0, o.totalMin - o.watchedMin), 15) : 15;
        minInput.placeholder = suggest > 0 ? "默认 " + suggest + " 分钟，可填 0:25" : "例如 25";
      }
    }

    if (selectEl) {
      selectEl.addEventListener("change", function () {
        if (minInput) minInput.value = "";
        paintProgress();
      });
      paintProgress();
    }

    /* ---- 底部 ---- */
    var okBtn = el("button", { type: "button", class: "sheet-btn sheet-btn-ok", text: "打卡" });
    var cancelBtn = el("button", { type: "button", class: "sheet-btn sheet-btn-cancel", text: "取消", onclick: close });
    var foot = el("div", { class: "sheet-foot" }, [cancelBtn, okBtn]);
    if (isVideo && !options.length) okBtn.disabled = true;

    function submit() {
      if (okBtn.disabled) return;
      var payload = { id: c.id };
      if (isVideo) {
        var o = currentOption();
        if (!o) return;
        var min = parseMinText(minInput ? minInput.value : "");
        // 留空按占位提示的默认值（15 分钟，或这一节剩余时长）算
        if (min == null && minInput) {
          var ph = String(minInput.placeholder || "").match(/(\d+)/);
          if (ph) min = Number(ph[1]);
        }
        if (min == null || min <= 0) {
          flash("时长填一下，例如 25 或 0:25", "err");
          if (minInput) minInput.focus();
          return;
        }
        payload.min = min;
        // 课程 id 优先取所选节次自己带的，避免打卡项本身没绑课程时取空
        payload.cid = o.courseId || c.courseId;
        payload.lid = o.id;
      }
      if (noteInput.value.trim()) payload.note = noteInput.value.trim();

      okBtn.disabled = true;
      okBtn.textContent = "记录中…";
      beginWrite();
      apiPost("/api/checkin/log", payload)
        .then(function (r) {
          var ck = (r && r.checkin) || {};
          var msg = isVideo ? "已打卡 +" + fmtMinText(ck.min || 0) + (ck.idx ? " · 第 " + ck.idx + " 节" : "") : "已打卡";
          if (ck.lessonDone) msg += " · 这节看完了";
          close();
          flash(msg, "ok");
        })
        .catch(function (err) {
          okBtn.disabled = false;
          okBtn.textContent = "打卡";
          flash("打卡失败：" + ((err && err.message) || "未知错误"), "err");
        })
        .then(function () {
          endWrite();
        });
    }

    okBtn.addEventListener("click", submit);
    body.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") {
        e.preventDefault();
        submit();
      }
    });

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);
    document.body.appendChild(mask);
    sheetEl = mask;
    requestAnimationFrame(function () {
      mask.dataset.open = "true";
    });
    setTimeout(function () {
      if (minInput) {
        minInput.focus();
        minInput.select();
      } else {
        okBtn.focus();
      }
    }, 30);
  }

  function closeCheckinSheet() {
    if (!sheetEl) return;
    var node = sheetEl;
    sheetEl = null;
    node.dataset.open = "false";
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 160);
  }

  /** 打卡行右侧的状态文案：视频打卡优先显示「下一次点是第几节」 */
  function checkinStatusText(c) {
    var parts = [];
    if (c.kind === "video") {
      if (c.current) parts.push("第 " + c.current.idx + " 节");
      else if (c.lessonOptions && c.lessonOptions.length) parts.push("全部看完");
      else parts.push("没有课时");
    }
    if (c.todayLogs && c.todayLogs.length) parts.push("今日 " + c.todayLogs.length + " 次");
    else parts.push(c.status || "待打卡");
    return parts.join(" · ");
  }

  /* ---------- 写入：待办勾选 / 打卡 ---------- */

  var pendingWrites = 0;

  function beginWrite() {
    pendingWrites += 1;
    if (pendingWrites === 1) bodyEl.dataset.busy = "true";
  }

  function endWrite() {
    pendingWrites = Math.max(0, pendingWrites - 1);
    if (pendingWrites === 0) bodyEl.dataset.busy = "";
  }

  /**
   * 点一下待办前的圆圈：切换完成状态。
   *
   * 乐观更新：先把界面改掉再发请求，请求往返（Supabase 常常 1~3 秒）不再表现为"点了没反应"。
   * 失败时把这一行恢复原状并提示，成功时用服务端回传的 summary 校准整页。
   */
  function toggleTodo(id, btnEl) {
    var rowEl = btnEl && btnEl.closest ? btnEl.closest(".todo") : null;
    var wasDone = btnEl ? btnEl.getAttribute("data-done") === "true" : false;
    var nowDone = !wasDone;

    function paint(done) {
      if (!btnEl) return;
      btnEl.setAttribute("data-done", String(done));
      btnEl.setAttribute("aria-pressed", done ? "true" : "false");
      btnEl.title = done ? "取消完成" : "标记完成";
      clear(btnEl);
      if (done) btnEl.appendChild(svgIcon("check", 10));
      if (rowEl) rowEl.setAttribute("data-done", String(done));
    }

    paint(nowDone);
    if (rowEl) rowEl.setAttribute("data-pending", "true");
    beginWrite();
    return apiPost("/api/todo/toggle", { id: id, checked: nowDone })
      .then(function (r) {
        flash(r.action === "done" ? "已勾掉一条" : "已放回未完成", "ok");
      })
      .catch(function (err) {
        // 回滚到点击前的样子
        paint(wasDone);
        flash("操作失败已还原：" + ((err && err.message) || "未知错误"), "err");
      })
      .then(function () {
        if (rowEl) rowEl.removeAttribute("data-pending");
        endWrite();
      });
  }


  // 委托：待办圆圈
  bodyEl.addEventListener("click", function (e) {
    var check = e.target.closest && e.target.closest("[data-todo-toggle]");
    if (check) {
      e.preventDefault();
      toggleTodo(check.getAttribute("data-todo-toggle"), check);
      return;
    }
    var row = e.target.closest && e.target.closest("[data-checkin-toggle]");
    if (row) {
      e.preventDefault();
      var ci = ((lastSummary && lastSummary.checkins) || []).filter(function (x) {
        return x.id === row.getAttribute("data-checkin-toggle");
      })[0];
      if (ci) openCheckinSheet(ci);
    }
  });

  // 键盘可达：打卡项支持回车 / 空格
  bodyEl.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var row = e.target.closest && e.target.closest("[data-checkin-toggle]");
    if (!row || e.target !== row) return;
    e.preventDefault();
    var ci = ((lastSummary && lastSummary.checkins) || []).filter(function (x) {
      return x.id === row.getAttribute("data-checkin-toggle");
    })[0];
    if (ci) openCheckinSheet(ci);
  });

  btnRefresh.addEventListener("click", function () {
    load(true);
  });
  btnRefresh.addEventListener("animationend", function () {
    btnRefresh.dataset.busy = "";
  });

  btnOpen.addEventListener("click", function () {
    var url = "https://glebah23.github.io/study-dashboard/";
    if (desktop) desktop.openExternal(url);
    else window.open(url, "_blank", "noopener");
  });

  if (MODE === "widget") {
    if (desktop) {
      desktop.isPinned().then(function (pinned) {
        btnPin.dataset.active = String(!!pinned);
      });
      desktop.onPinnedChanged(function (pinned) {
        btnPin.dataset.active = String(!!pinned);
      });
      desktop.onRefresh(function () {
        load(true);
      });
    }
    btnPin.addEventListener("click", function () {
      if (!desktop) return;
      desktop.togglePin().then(function (pinned) {
        btnPin.dataset.active = String(!!pinned);
      });
    });
    btnMin.addEventListener("click", function () {
      if (desktop) desktop.minimize();
    });
    btnClose.addEventListener("click", function () {
      if (desktop) desktop.close();
      else window.close();
    });
    document.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      if (desktop) desktop.contextMenu();
    });
    // 无边框拖动：按住顶栏空白处移动窗口（按钮区域排除）
    var bar = document.getElementById("bar");
    var drag = null;
    bar.addEventListener("pointerdown", function (e) {
      if (!desktop || e.button !== 0) return;
      if (e.target.closest(".icon-btn")) return;
      drag = { x: e.screenX, y: e.screenY };
      desktop.moveState(true);
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener("pointermove", function (e) {
      if (!drag) return;
      desktop.moveBy(e.screenX - drag.x, e.screenY - drag.y);
    });
    bar.addEventListener("pointerup", function (e) {
      if (!drag) return;
      drag = null;
      desktop.moveState(false);
      try {
        bar.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
    });
  } else {
    // 面板模式没有窗口按钮；置顶按钮改作「在桌面上打开小组件小窗」
    btnMin.dataset.hidden = "true";
    btnPin.addEventListener("click", function () {
      postHost("/api/open-desktop").then(function (r) {
        if (r && r.ok === false) footText.textContent = "打开桌面小窗失败：" + ((r.error && r.error.message) || "未知错误");
      });
    });
    window.addEventListener("message", function (e) {
      if (!e || !e.data || e.data.type !== "study-widget:open-desktop") return;
      postHost("/api/open-desktop").then(function (r) {
        if (r && r.ok === false) footText.textContent = "打开桌面小窗失败：" + ((r.error && r.error.message) || "未知错误");
      });
    });
  }

  function postHost(path) {
    return fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
    })
      .then(function (res) {
        return res.json().catch(function () {
          return { ok: res.ok };
        });
      })
      .catch(function (err) {
        return { ok: false, error: { message: String((err && err.message) || err) } };
      });
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) load(false);
  });

  // 面板模式：面板被销毁时清理定时器
  window.__studyWidgetDispose = function () {
    if (timer) clearInterval(timer);
    timer = null;
  };

  load(false);
  schedule();
})();
