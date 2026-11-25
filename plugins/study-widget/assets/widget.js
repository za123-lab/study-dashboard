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

  body.dataset.mode = MODE;
  if (MODE === "panel") applyHostTheme();

  document.documentElement.style.setProperty("--sw-radius", MODE === "widget" ? "16px" : "0px");

  function applyHostTheme() {
    // 侧栏面板跟随宿主主题 token（宿主的变量就在同一棵 DOM 上）
    [
      "--dsw-alias-bg-layer-1",
      "--dsw-alias-bg-layer-2",
      "--dsw-alias-bg-overlay",
      "--dsw-alias-border-l1",
      "--dsw-alias-border-l2",
      "--dsw-alias-brand-primary",
      "--dsw-alias-label-primary",
      "--dsw-alias-label-secondary",
      "--dsw-alias-state-error-primary",
      "--dsw-alias-state-success-primary",
      "--dsw-alias-state-warn-primary",
    ].forEach(function (name) {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      if (v && v.trim()) {
        var target = {
          "--dsw-alias-bg-layer-1": "--sw-bg",
          "--dsw-alias-bg-layer-2": "--sw-layer",
          "--dsw-alias-bg-overlay": "--sw-layer-2",
          "--dsw-alias-border-l1": "--sw-border",
          "--dsw-alias-border-l2": "--sw-border",
          "--dsw-alias-brand-primary": "--sw-accent",
          "--dsw-alias-label-primary": "--sw-fg",
          "--dsw-alias-label-secondary": "--sw-muted",
          "--dsw-alias-state-error-primary": "--sw-err",
          "--dsw-alias-state-success-primary": "--sw-ok",
          "--dsw-alias-state-warn-primary": "--sw-warn",
        }[name];
        if (target) document.documentElement.style.setProperty(target, v.trim());
      }
    });
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
    return el("div", { class: "todo" }, [
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
      card.appendChild(
        el("div", { class: "checkin" }, [
          el("span", { class: "checkin-state", "data-done": String(c.done), text: c.done ? "✓" : "" }),
          el("span", { class: "checkin-name", text: c.name, title: c.courseName || c.name }),
          el("span", { class: "checkin-status", "data-due": String(c.due), text: c.status }),
        ])
      );
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
          text: "新建上面这个文件，填入 {\"url\", \"anonKey\", \"email\", \"password\"}（与网页端设置页里的 Supabase 配置一致），保存后点 ⟳。",
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
        text: "填好凭据后点右上角 ⟳ 刷新。桌面小窗不共享浏览器的 localStorage，所以桌面端按 Supabase 登录读取（与网页端同一套协议，只读）。",
      })
    );
    bodyEl.appendChild(box);
    dot.dataset.kind = "error";
    footText.textContent = (info && info.code) || "未配置";
  }

  function render(s, status) {
    lastSummary = s;
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
    // 面板模式没有窗口按钮；📌 改作「在桌面上打开小组件小窗」
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
