/* ==========================================================
   学习进度手账 — 纯前端逻辑
   数据全部保存在 localStorage，不依赖任何后端与第三方库
   ========================================================== */

(function () {
  "use strict";

  const STORE_KEY = "study-log-v1";

  /** 热力图显示的周数：屏幕越窄显示越少，避免格子被压得太碎 */
  function heatWeeks() {
    const w = document.documentElement.clientWidth;
    if (w < 560) return 13;
    if (w < 900) return 20;
    return 26;
  }

  // ---------- 状态 ----------

  let state = loadState();

  /**
   * 数据结构：
   * {
   *   v: 1,
   *   courses: [{ id, name, total, done: [集数...] }],
   *   activity: { "2026-11-07": 3 }   // 每天勾选的集数
   * }
   */
  function emptyState() {
    return { v: 1, courses: [], activity: {} };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return emptyState();
      const parsed = JSON.parse(raw);
      return sanitize(parsed) || emptyState();
    } catch (err) {
      console.warn("读取本地数据失败，已重置", err);
      return emptyState();
    }
  }

  /** 把外部数据（含导入的 JSON）整理成可信结构，非法则返回 null */
  function sanitize(data) {
    if (!data || typeof data !== "object") return null;
    const courses = Array.isArray(data.courses) ? data.courses : [];
    const activity =
      data.activity && typeof data.activity === "object" ? data.activity : {};

    const cleanCourses = courses
      .filter((c) => c && typeof c.name === "string" && c.name.trim())
      .map((c) => {
        const total = clampInt(c.total, 1, 999, 1);
        const done = Array.isArray(c.done)
          ? c.done
              .map((n) => clampInt(n, 1, total, 0))
              .filter((n) => n > 0)
          : [];
        return {
          id: String(c.id || makeId()),
          name: String(c.name).slice(0, 40),
          total,
          done: uniqueSorted(done),
        };
      });

    const cleanActivity = {};
    Object.keys(activity).forEach((k) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
        const n = clampInt(activity[k], 0, 999, 0);
        if (n > 0) cleanActivity[k] = n;
      }
    });

    return { v: 1, courses: cleanCourses, activity: cleanActivity };
  }

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      toast("本地保存失败，可能是浏览器存储空间已满");
      console.warn(err);
    }
  }

  // ---------- 小工具 ----------

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function uniqueSorted(arr) {
    return Array.from(new Set(arr)).sort((a, b) => a - b);
  }

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /** 本地时区的 YYYY-MM-DD */
  function dateKey(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function addDays(d, n) {
    const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    copy.setDate(copy.getDate() + n);
    return copy;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const WEEK_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  // ---------- DOM ----------

  const $ = (sel) => document.querySelector(sel);

  const el = {
    todayLine: $("#todayLine"),
    streakNum: $("#streakNum"),
    ring: $("#overallRing"),
    overallPct: $("#overallPct"),
    statCourses: $("#statCourses"),
    statDone: $("#statDone"),
    statRemain: $("#statRemain"),
    heatmap: $("#heatmap"),
    addForm: $("#addForm"),
    courseName: $("#courseName"),
    courseTotal: $("#courseTotal"),
    courseList: $("#courseList"),
    emptyState: $("#emptyState"),
    seedBtn: $("#seedBtn"),
    exportBtn: $("#exportBtn"),
    importBtn: $("#importBtn"),
    importFile: $("#importFile"),
    clearBtn: $("#clearBtn"),
    toast: $("#toast"),
  };

  // ---------- 渲染 ----------

  function renderAll() {
    renderHeader();
    renderStats();
    renderCourses();
    renderHeatmap();
    renderStreak();
  }

  function renderHeader() {
    const now = new Date();
    el.todayLine.textContent =
      now.getFullYear() +
      " 年 " +
      (now.getMonth() + 1) +
      " 月 " +
      now.getDate() +
      " 日 · " +
      WEEK_CN[now.getDay()] +
      " · 今天也要记一笔";
  }

  function totals() {
    let done = 0;
    let total = 0;
    state.courses.forEach((c) => {
      total += c.total;
      done += c.done.length;
    });
    return { done, total, remain: Math.max(0, total - done) };
  }

  function renderStats() {
    const t = totals();
    const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;

    el.statCourses.textContent = state.courses.length;
    el.statDone.textContent = t.done;
    el.statRemain.textContent = t.remain;
    el.overallPct.textContent = pct + "%";
    el.ring.style.setProperty("--p", pct);
    el.ring.setAttribute(
      "aria-label",
      "总体完成进度 " + pct + "%，共 " + t.total + " 集，已完成 " + t.done + " 集"
    );
  }

  function renderCourses() {
    el.emptyState.hidden = state.courses.length > 0;

    if (state.courses.length === 0) {
      el.courseList.innerHTML = "";
      return;
    }

    el.courseList.innerHTML = state.courses
      .map((course) => {
        const doneCount = course.done.length;
        const pct = Math.round((doneCount / course.total) * 100);
        const nextEp = findNextUndone(course);

        const eps = [];
        const doneSet = new Set(course.done);
        for (let i = 1; i <= course.total; i++) {
          const isDone = doneSet.has(i);
          const isNext = i === nextEp;
          eps.push(
            '<button type="button" class="ep' +
              (isDone ? " done" : "") +
              (isNext ? " next" : "") +
              '" data-id="' +
              course.id +
              '" data-ep="' +
              i +
              '" aria-pressed="' +
              isDone +
              '" aria-label="第 ' +
              i +
              " 集" +
              (isDone ? "，已完成" : "") +
              '">' +
              i +
              "</button>"
          );
        }

        return (
          '<article class="course" data-id="' +
          course.id +
          '">' +
          '<div class="course-head">' +
          '<div class="course-title">' +
          "<h3>" +
          escapeHtml(course.name) +
          "</h3>" +
          '<p class="mono course-meta">' +
          doneCount +
          " / " +
          course.total +
          ' 集 · <span class="pct">' +
          pct +
          "%</span></p>" +
          "</div>" +
          '<button type="button" class="icon-btn del" data-id="' +
          course.id +
          '" aria-label="删除《' +
          escapeHtml(course.name) +
          '》" title="删除这门课">✕</button>' +
          "</div>" +
          '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
          pct +
          '"><span style="width:' +
          pct +
          '%"></span></div>' +
          '<div class="eps" role="group" aria-label="集数勾选">' +
          eps.join("") +
          "</div>" +
          '<div class="quick">' +
          "<label>快速记录：看到第</label>" +
          '<input type="number" min="1" max="' +
          course.total +
          '" placeholder="' +
          (nextEp || "—") +
          '" data-id="' +
          course.id +
          '" aria-label="看到第几集">' +
          "<span>集</span>" +
          '<button type="button" class="btn ghost apply" data-id="' +
          course.id +
          '">记下</button>' +
          "</div>" +
          "</article>"
        );
      })
      .join("");
  }

  function findNextUndone(course) {
    for (let i = 1; i <= course.total; i++) {
      if (!course.done.includes(i)) return i;
    }
    return 0;
  }

  function renderHeatmap() {
    const today = new Date();
    const weeks = heatWeeks();
    const startSunday = addDays(today, -today.getDay() - (weeks - 1) * 7);
    const totalDays = weeks * 7;

    let html = "";
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(startSunday, i);
      const key = dateKey(d);
      const count = state.activity[key] || 0;
      const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;
      const isFuture = key > todayKey();
      html +=
        '<i class="cell l' +
        level +
        (isFuture ? " future" : "") +
        '" title="' +
        key +
        (isFuture ? "" : " · " + count + " 集") +
        '"></i>';
    }
    el.heatmap.innerHTML = html;
  }

  function renderStreak() {
    let streak = 0;
    let cursor = new Date();
    // 今天还没记的话，从昨天开始数，避免早上就把连击清零
    if (!state.activity[todayKey()]) {
      cursor = addDays(cursor, -1);
    }
    while (state.activity[dateKey(cursor)]) {
      streak++;
      cursor = addDays(cursor, -1);
    }
    el.streakNum.textContent = streak;
  }

  // ---------- 交互：课程 ----------

  function addCourse(name, total) {
    state.courses.push({
      id: makeId(),
      name: name.trim(),
      total,
      done: [],
    });
    saveState();
    renderAll();
    toast("已登记《" + name.trim() + "》，共 " + total + " 集");
  }

  function removeCourse(id) {
    const course = state.courses.find((c) => c.id === id);
    if (!course) return;
    if (!confirm("确定删除《" + course.name + "》吗？该课程的勾选记录会一起删除。")) return;
    state.courses = state.courses.filter((c) => c.id !== id);
    saveState();
    renderAll();
    toast("已删除《" + course.name + "》");
  }

  /** 记录一次「新增完成」，同步累加当天活跃度 */
  function bumpActivity(delta) {
    const key = todayKey();
    const next = (state.activity[key] || 0) + delta;
    if (next > 0) {
      state.activity[key] = next;
    } else {
      delete state.activity[key];
    }
  }

  function toggleEpisode(id, ep) {
    const course = state.courses.find((c) => c.id === id);
    if (!course) return;
    const has = course.done.includes(ep);

    if (has) {
      course.done = course.done.filter((n) => n !== ep);
      bumpActivity(-1);
    } else {
      course.done = uniqueSorted(course.done.concat(ep));
      bumpActivity(1);
    }

    saveState();
    renderStats();
    renderCourses();
    renderHeatmap();
    renderStreak();
  }

  /** 把进度直接设为「1..n 全部看完」 */
  function applyProgress(id, n) {
    const course = state.courses.find((c) => c.id === id);
    if (!course) return;

    const target = clampInt(n, 1, course.total, 0);
    if (!target) {
      toast("请输入 1 到 " + course.total + " 之间的集数");
      return;
    }

    const before = course.done.length;
    const nextDone = [];
    for (let i = 1; i <= target; i++) nextDone.push(i);
    course.done = nextDone;

    // 只统计这一天的净新增集数；回退进度时同步扣减
    const delta = nextDone.length - before;
    if (delta !== 0) bumpActivity(delta);

    saveState();
    renderStats();
    renderCourses();
    renderHeatmap();
    renderStreak();
    toast("《" + course.name + "》已记录到第 " + target + " 集");
  }

  // ---------- 事件绑定 ----------

  el.addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    const name = el.courseName.value.trim();
    const total = clampInt(el.courseTotal.value, 1, 999, 0);

    if (!name) {
      toast("先给课程起个名字吧");
      el.courseName.focus();
      return;
    }
    if (!total) {
      toast("总集数要填 1 到 999 之间的整数");
      el.courseTotal.focus();
      return;
    }
    if (state.courses.some((c) => c.name === name)) {
      toast("已经有一门同名的课程了");
      return;
    }

    addCourse(name, total);
    el.addForm.reset();
    el.courseName.focus();
  });

  el.courseList.addEventListener("click", function (e) {
    const epBtn = e.target.closest(".ep");
    if (epBtn) {
      toggleEpisode(epBtn.dataset.id, parseInt(epBtn.dataset.ep, 10));
      return;
    }

    const delBtn = e.target.closest(".icon-btn.del");
    if (delBtn) {
      removeCourse(delBtn.dataset.id);
      return;
    }

    const applyBtn = e.target.closest(".apply");
    if (applyBtn) {
      const card = applyBtn.closest(".course");
      const input = card.querySelector(".quick input");
      applyProgress(applyBtn.dataset.id, input.value);
    }
  });

  // 快速记录输入框按回车直接提交
  el.courseList.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    const input = e.target.closest(".quick input");
    if (!input) return;
    e.preventDefault();
    applyProgress(input.dataset.id, input.value);
  });

  el.seedBtn.addEventListener("click", function () {
    const today = new Date();
    state.courses = [
      { id: makeId(), name: "C 语言程序设计", total: 86, done: range(1, 12) },
      { id: makeId(), name: "大学计算机基础", total: 24, done: range(1, 8) },
    ];
    // 造几天的历史记录，让热力图有内容可看
    [7, 6, 5, 3, 2, 1].forEach((back, idx) => {
      state.activity[dateKey(addDays(today, -back))] = [2, 3, 1, 4, 2, 5][idx];
    });
    delete state.activity[dateKey(today)]; // 今天留空，由你自己勾
    saveState();
    renderAll();
    toast("已填入示例课程，随时可以删掉换成你自己的");
  });

  function range(a, b) {
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }

  // ---------- 导入导出 ----------

  el.exportBtn.addEventListener("click", function () {
    if (state.courses.length === 0) {
      toast("还没有数据可以导出");
      return;
    }
    const payload = JSON.stringify(
      { v: state.v, exportedAt: new Date().toISOString(), courses: state.courses, activity: state.activity },
      null,
      2
    );
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "学习进度-" + todayKey() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("已导出 JSON 备份文件");
  });

  el.importBtn.addEventListener("click", function () {
    el.importFile.click();
  });

  el.importFile.addEventListener("change", function () {
    const file = el.importFile.files && el.importFile.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function () {
      let data = null;
      try {
        data = sanitize(JSON.parse(reader.result));
      } catch (err) {
        toast("文件不是合法的 JSON，导入失败");
        el.importFile.value = "";
        return;
      }
      if (!data) {
        toast("数据格式不对，导入失败");
        el.importFile.value = "";
        return;
      }
      if (!confirm("导入会覆盖当前所有记录，确定继续吗？")) {
        el.importFile.value = "";
        return;
      }
      state = data;
      saveState();
      renderAll();
      toast("导入成功，共 " + data.courses.length + " 门课程");
      el.importFile.value = "";
    };
    reader.onerror = function () {
      toast("读取文件失败");
      el.importFile.value = "";
    };
    reader.readAsText(file, "utf-8");
  });

  el.clearBtn.addEventListener("click", function () {
    if (state.courses.length === 0) {
      toast("现在就是空的，不用清");
      return;
    }
    if (!confirm("清空所有课程和学习记录？此操作不可撤销，建议先导出备份。")) return;
    state = emptyState();
    saveState();
    renderAll();
    toast("已清空，本子重新开张");
  });

  // ---------- 提示条 ----------

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove("show");
    }, 2400);
  }

  // ---------- 启动 ----------

  renderAll();

  // 窗口尺寸变化时，热力图按新的周数重排
  let resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderHeatmap, 200);
  });
})();
