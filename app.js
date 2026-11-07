/* ==========================================================
   学习进度手账 — 纯前端逻辑
   进度按「分钟」记录，课程与总体进度都用时长加权计算
   数据全部保存在 localStorage，不依赖后端与第三方库
   ========================================================== */

(function () {
  "use strict";

  const STORE_KEY = "study-log-v1"; // 沿用旧 key，老数据读取后自动迁移
  const SYNC_KEY = "study-sync-v1"; // 云同步设置，与进度数据分开存（同步码不会跟随导出）
  const SYNC_CODE_MIN = 16;
  const SYNC_TIMEOUT = 15000;
  const DEFAULT_LESSON_MIN = 45; // 旧数据迁移时，每节按 45 分钟折算
  const BILI_URL_RE = /^https?:\/\/(www\.)?bilibili\.com\/video\/BV[0-9A-Za-z]{10}/;

  /**
   * 数据结构（v2）：
   * {
   *   v: 2,
   *   courses: [{ id, name, lessons: [{ id, totalMin, watchedMin }] }],
   *   activity: { "2026-11-07": 43 }   // 当天累计观看的分钟数
   * }
   *
   * 旧结构（v1）：
   * { v: 1, courses: [{ id, name, total, done: [集数...] }], activity: { 日期: 集数 } }
   */

  let state;
  let migratedOnLoad = false;
  let toastTimer = null;
  let pendingImport = null; // 已解析、待确认写入的 B 站课程

  // 展开状态的课程 id（只在内存里，不写入存储）
  const openIds = new Set();
  const seenIds = new Set();

  // 云同步运行状态（同步码等设置存在 localStorage）
  let syncCfg = null; // { code, baseUrl, auto, updatedAt, lastSyncAt }
  let syncBusy = false;
  let suppressAutoSync = false;
  let autoSyncTimer = null;
  let pendingConflict = null;

  state = loadState();

  // ---------- 时间工具 ----------

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /** 分钟数 → "时:分" */
  function fmtDur(min) {
    const m = Math.max(0, Math.round(min || 0));
    return Math.floor(m / 60) + ":" + pad(m % 60);
  }

  /**
   * 解析用户输入：纯数字按分钟算，"1:23" 按 1 小时 23 分算
   * 无法识别时返回 null
   */
  function parseDuration(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const hm = s.match(/^(\d+)\s*[:：]\s*(\d{1,2})$/);
    if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
    return null;
  }

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  /** 单节百分比：已看 ÷ 总时长，四舍五入到整数 */
  function lessonPct(lesson) {
    if (!lesson.totalMin) return null;
    const watched = Math.min(lesson.watchedMin, lesson.totalMin);
    return Math.round((watched / lesson.totalMin) * 100);
  }

  /** 课程汇总：按时长加权 */
  function courseStats(course) {
    let totalMin = 0;
    let watchedMin = 0;
    let doneLessons = 0;
    let invalid = 0;

    course.lessons.forEach(function (l) {
      if (l.totalMin > 0) {
        totalMin += l.totalMin;
        const w = Math.min(l.watchedMin, l.totalMin);
        watchedMin += w;
        if (w >= l.totalMin) doneLessons++;
      } else {
        invalid++; // 总时长为 0 / 未填，不计入统计
      }
    });

    const pct = totalMin ? Math.round((watchedMin / totalMin) * 100) : 0;
    return {
      totalMin: totalMin,
      watchedMin: watchedMin,
      doneLessons: doneLessons,
      invalid: invalid,
      count: course.lessons.length,
      pct: pct,
    };
  }

  function overallStats() {
    const out = {
      totalMin: 0,
      watchedMin: 0,
      doneLessons: 0,
      count: 0,
      invalid: 0,
      pct: 0,
    };
    state.courses.forEach(function (c) {
      const s = courseStats(c);
      out.totalMin += s.totalMin;
      out.watchedMin += s.watchedMin;
      out.doneLessons += s.doneLessons;
      out.count += s.count;
      out.invalid += s.invalid;
    });
    out.pct = out.totalMin
      ? Math.round((out.watchedMin / out.totalMin) * 100)
      : 0;
    return out;
  }

  // ---------- 日期工具 ----------

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

  const WEEK_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  /** 热力图显示的周数：屏幕越窄显示越少，避免格子被压得太碎 */
  function heatWeeks() {
    const w = document.documentElement.clientWidth;
    if (w < 560) return 13;
    if (w < 900) return 20;
    return 26;
  }

  /** 当天分钟数 → 热力图档位 */
  function minuteLevel(min) {
    if (min <= 0) return 0;
    if (min <= 15) return 1;
    if (min <= 45) return 2;
    if (min <= 90) return 3;
    return 4;
  }

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------- 读取 / 迁移 / 保存 ----------

  function emptyState() {
    return { v: 2, courses: [], activity: {} };
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

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      toast("本地保存失败，可能是浏览器存储空间已满");
      console.warn(err);
    }
    // 本地始终是主存储，自动上传只是附加动作
    if (!suppressAutoSync) scheduleAutoSync();
  }

  /** 旧结构的一门课 → 新结构（已完成的集视为已看满默认时长） */
  function migrateCourseV1(c) {
    const total = clampInt(c.total, 1, 999, 1);
    const doneSet = new Set(
      (Array.isArray(c.done) ? c.done : []).map(function (n) {
        return parseInt(n, 10);
      })
    );
    const lessons = [];
    for (let i = 1; i <= total; i++) {
      const isDone = doneSet.has(i);
      lessons.push({
        id: makeId(),
        totalMin: DEFAULT_LESSON_MIN,
        watchedMin: isDone ? DEFAULT_LESSON_MIN : 0,
      });
    }
    return {
      id: String(c.id || makeId()),
      name: String(c.name).slice(0, 40).trim(),
      lessons: lessons,
    };
  }

  function cleanCourseV2(c) {
    const lessons = (Array.isArray(c.lessons) ? c.lessons : []).map(function (l) {
      const totalMin = clampInt(l.totalMin, 0, 9999, 0);
      let watchedMin = clampInt(l.watchedMin, 0, 9999, 0);
      // 已看时长不能超过总时长
      if (totalMin > 0) watchedMin = Math.min(watchedMin, totalMin);
      const lesson = {
        id: String(l.id || makeId()),
        totalMin: totalMin,
        watchedMin: watchedMin,
      };
      // 只接受站内视频链接，避免导入数据里混入 javascript: 之类的地址
      if (typeof l.url === "string" && BILI_URL_RE.test(l.url)) {
        lesson.url = l.url;
      }
      return lesson;
    });
    return {
      id: String(c.id || makeId()),
      name: String(c.name).slice(0, 40).trim(),
      lessons: lessons,
    };
  }

  /** 把外部数据（本地存储或导入的 JSON）整理成可信结构，非法则返回 null */
  function sanitize(data) {
    if (!data || typeof data !== "object") return null;

    const rawCourses = Array.isArray(data.courses) ? data.courses : [];
    const isV1 =
      data.v === 1 ||
      rawCourses.some(function (c) {
        return c && !Array.isArray(c.lessons) && "total" in c;
      });

    const courses = rawCourses
      .filter(function (c) {
        return c && typeof c.name === "string" && c.name.trim();
      })
      .map(function (c) {
        return Array.isArray(c.lessons) ? cleanCourseV2(c) : migrateCourseV1(c);
      });

    const rawActivity =
      data.activity && typeof data.activity === "object" ? data.activity : {};
    const activity = {};
    Object.keys(rawActivity).forEach(function (k) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      let value = clampInt(rawActivity[k], 0, 99999, 0);
      // 旧数据记的是「集数」，按默认时长折算成分钟
      if (isV1) value = value * DEFAULT_LESSON_MIN;
      if (value > 0) activity[k] = value;
    });

    if (isV1) migratedOnLoad = true;
    return { v: 2, courses: courses, activity: activity };
  }

  // ---------- DOM ----------

  const $ = function (sel) {
    return document.querySelector(sel);
  };

  const el = {
    todayLine: $("#todayLine"),
    streakNum: $("#streakNum"),
    ring: $("#overallRing"),
    overallPct: $("#overallPct"),
    statCourses: $("#statCourses"),
    statDone: $("#statDone"),
    statDoneCap: $("#statDoneCap"),
    statWatched: $("#statWatched"),
    heatmap: $("#heatmap"),
    addForm: $("#addForm"),
    courseName: $("#courseName"),
    courseCount: $("#courseCount"),
    courseDefault: $("#courseDefault"),
    courseList: $("#courseList"),
    emptyState: $("#emptyState"),
    seedBtn: $("#seedBtn"),
    exportBtn: $("#exportBtn"),
    importBtn: $("#importBtn"),
    importFile: $("#importFile"),
    clearBtn: $("#clearBtn"),
    promptText: $("#promptText"),
    copyPromptBtn: $("#copyPromptBtn"),
    biliJson: $("#biliJson"),
    previewBtn: $("#previewBtn"),
    biliClearBtn: $("#biliClearBtn"),
    biliError: $("#biliError"),
    biliPreview: $("#biliPreview"),
    previewTitle: $("#previewTitle"),
    previewMeta: $("#previewMeta"),
    previewBody: $("#previewBody"),
    previewDup: $("#previewDup"),
    dupText: $("#dupText"),
    dupNew: $("#dupNew"),
    dupOverwrite: $("#dupOverwrite"),
    confirmImportBtn: $("#confirmImportBtn"),
    cancelImportBtn: $("#cancelImportBtn"),
    syncCode: $("#syncCode"),
    syncCodeToggle: $("#syncCodeToggle"),
    syncBase: $("#syncBase"),
    syncAuto: $("#syncAuto"),
    syncUploadBtn: $("#syncUploadBtn"),
    syncPullBtn: $("#syncPullBtn"),
    syncForgetBtn: $("#syncForgetBtn"),
    syncStatus: $("#syncStatus"),
    syncConflict: $("#syncConflict"),
    conflictNote: $("#conflictNote"),
    conflictTakeRemote: $("#conflictTakeRemote"),
    conflictPushLocal: $("#conflictPushLocal"),
    conflictCancel: $("#conflictCancel"),
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

  function renderStats() {
    const t = overallStats();

    el.statCourses.textContent = state.courses.length;
    el.statDone.textContent = t.doneLessons;
    el.statDoneCap.textContent = "已看完 · 共 " + t.count + " 节";
    el.statWatched.textContent = fmtDur(t.watchedMin);

    el.overallPct.textContent = t.pct + "%";
    el.ring.style.setProperty("--p", t.pct);
    el.ring.setAttribute(
      "aria-label",
      "按观看时长加权的总进度 " +
        t.pct +
        "%，已看 " +
        fmtDur(t.watchedMin) +
        "，总时长 " +
        fmtDur(t.totalMin)
    );
  }

  /** 决定课程卡片是否展开；首次出现时按节数决定默认值 */
  function isCourseOpen(course) {
    if (!seenIds.has(course.id)) {
      seenIds.add(course.id);
      if (course.lessons.length <= 12) openIds.add(course.id);
    }
    return openIds.has(course.id);
  }

  function renderCourses() {
    el.emptyState.hidden = state.courses.length > 0;

    if (state.courses.length === 0) {
      el.courseList.innerHTML = "";
      return;
    }

    el.courseList.innerHTML = state.courses.map(courseCardHtml).join("");
  }

  function courseCardHtml(course) {
    const st = courseStats(course);
    const open = isCourseOpen(course);

    const invalidNote = st.invalid
      ? ' · <span class="warn-txt">' + st.invalid + " 节未设时长，未计入</span>"
      : "";

    const lessonsHtml = open
      ? '<div class="lessons">' +
        course.lessons
          .map(function (lesson, idx) {
            return lessonRowHtml(course, lesson, idx);
          })
          .join("") +
        "</div>"
      : "";

    return (
      '<article class="course" data-cid="' +
      course.id +
      '">' +
      '<div class="course-head">' +
      '<div class="course-title">' +
      "<h3>" +
      escapeHtml(course.name) +
      "</h3>" +
      '<p class="mono course-meta">' +
      "加权 <span class=\"pct\">" +
      st.pct +
      "%</span> · 已看完 " +
      st.doneLessons +
      "/" +
      st.count +
      " 节 · 已看 " +
      fmtDur(st.watchedMin) +
      " / " +
      fmtDur(st.totalMin) +
      invalidNote +
      "</p>" +
      "</div>" +
      '<button type="button" class="icon-btn del" data-cid="' +
      course.id +
      '" aria-label="删除《' +
      escapeHtml(course.name) +
      '》" title="删除这门课">✕</button>' +
      "</div>" +
      '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      st.pct +
      '"><span style="width:' +
      st.pct +
      '%"></span></div>' +
      '<button type="button" class="btn ghost course-toggle" data-cid="' +
      course.id +
      '" aria-expanded="' +
      open +
      '">' +
      (open ? "收起课时" : "展开 " + st.count + " 节课时") +
      "</button>" +
      lessonsHtml +
      '<div class="course-foot">' +
      '<button type="button" class="btn ghost add-lesson" data-cid="' +
      course.id +
      '">+ 添加一节</button>' +
      '<span class="note">时长填 45 或 0:45；导入来的课时会带一个「B 站」链接</span>' +
      "</div>" +
      "</article>"
    );
  }

  function lessonRowHtml(course, lesson, idx) {
    const pct = lessonPct(lesson);
    const done = lesson.totalMin > 0 && lesson.watchedMin >= lesson.totalMin;
    const noTotal = lesson.totalMin === 0;

    const totalVal = lesson.totalMin ? fmtDur(lesson.totalMin) : "";
    const watchedVal = lesson.watchedMin
      ? fmtDur(lesson.watchedMin)
      : lesson.totalMin
      ? "0:00"
      : "";

    return (
      '<div class="lesson' +
      (done ? " done" : "") +
      '" data-cid="' +
      course.id +
      '" data-lid="' +
      lesson.id +
      '">' +
      '<span class="l-idx mono">' +
      (idx + 1) +
      "</span>" +
      '<label class="l-field"><span>总时长</span>' +
      '<input class="l-input mono" data-k="total" value="' +
      totalVal +
      '" placeholder="0:00" aria-label="第 ' +
      (idx + 1) +
      ' 节总时长"></label>' +
      '<label class="l-field"><span>已看</span>' +
      '<input class="l-input mono" data-k="watched" value="' +
      watchedVal +
      '" placeholder="0:00" aria-label="第 ' +
      (idx + 1) +
      ' 节已看时长"></label>' +
      '<div class="l-bar"><i style="width:' +
      (pct || 0) +
      '%"></i></div>' +
      '<span class="l-pct mono">' +
      (pct === null ? "—" : pct + "%") +
      "</span>" +
      '<span class="l-actions">' +
      '<button type="button" class="mini" data-act="add15" title="加 15 分钟">+15</button>' +
      '<button type="button" class="mini" data-act="full" title="标记为已看完">看完</button>' +
      '<button type="button" class="icon-btn l-del" data-act="del" aria-label="删除第 ' +
      (idx + 1) +
      ' 节" title="删除这一节">✕</button>' +
      "</span>" +
      (lesson.url
        ? '<a class="l-open" href="' +
          escapeHtml(lesson.url) +
          '" target="_blank" rel="noopener noreferrer" title="在新标签打开这一节的 B 站视频">B 站 ↗</a>'
        : "") +
      (noTotal
        ? '<span class="l-warn">未填总时长，这一节不计入统计</span>'
        : "") +
      "</div>"
    );
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
      const min = state.activity[key] || 0;
      const isFuture = key > todayKey();
      html +=
        '<i class="cell l' +
        minuteLevel(min) +
        (isFuture ? " future" : "") +
        '" title="' +
        key +
        (isFuture ? "" : " · 看了 " + min + " 分钟") +
        '"></i>';
    }
    el.heatmap.innerHTML = html;
  }

  function renderStreak() {
    let streak = 0;
    let cursor = new Date();
    // 今天还没记的话从昨天开始数，避免早上就把连击清零
    if (!state.activity[todayKey()]) {
      cursor = addDays(cursor, -1);
    }
    while (state.activity[dateKey(cursor)]) {
      streak++;
      cursor = addDays(cursor, -1);
    }
    el.streakNum.textContent = streak;
  }

  // ---------- 数据操作 ----------

  function findCourse(id) {
    return state.courses.find(function (c) {
      return c.id === id;
    });
  }

  function findLesson(course, id) {
    return course.lessons.find(function (l) {
      return l.id === id;
    });
  }

  /** 当天观看分钟数增减 */
  function adjustActivity(delta) {
    if (!delta) return;
    const key = todayKey();
    const next = (state.activity[key] || 0) + delta;
    if (next > 0) {
      state.activity[key] = next;
    } else {
      delete state.activity[key];
    }
  }

  function addCourse(name, count, defaultMin) {
    const lessons = [];
    for (let i = 0; i < count; i++) {
      lessons.push({ id: makeId(), totalMin: defaultMin, watchedMin: 0 });
    }
    const course = { id: makeId(), name: name.trim(), lessons: lessons };
    state.courses.push(course);
    saveState();
    renderAll();
    toast("已登记《" + name.trim() + "》，共 " + count + " 节");
  }

  function removeCourse(id) {
    const course = findCourse(id);
    if (!course) return;
    if (!confirm("确定删除《" + course.name + "》吗？该课程的观看记录会一起删除。")) return;
    state.courses = state.courses.filter(function (c) {
      return c.id !== id;
    });
    saveState();
    renderAll();
    toast("已删除《" + course.name + "》");
  }

  /** 提交一节的时长输入 */
  function commitLessonField(courseId, lessonId, field, rawValue, input) {
    const course = findCourse(courseId);
    if (!course) return;
    const lesson = findLesson(course, lessonId);
    if (!lesson) return;

    const minutes = parseDuration(rawValue);

    if (minutes === null) {
      toast("时间看不懂，可以填 43 或 1:23");
      input.value =
        field === "total"
          ? lesson.totalMin
            ? fmtDur(lesson.totalMin)
            : ""
          : lesson.watchedMin
          ? fmtDur(lesson.watchedMin)
          : lesson.totalMin
          ? "0:00"
          : "";
      return;
    }

    if (field === "total") {
      lesson.totalMin = Math.min(minutes, 9999);
      // 总时长改小后，已看时长自动截断
      if (lesson.totalMin > 0 && lesson.watchedMin > lesson.totalMin) {
        lesson.watchedMin = lesson.totalMin;
        toast("已看时长超过新的总时长，已自动截断");
      }
    } else {
      const before = lesson.watchedMin;
      let next = Math.max(0, Math.min(minutes, 9999));
      if (lesson.totalMin > 0) {
        if (next > lesson.totalMin) {
          next = lesson.totalMin;
          toast("已看时长不能超过总时长，已截断到 100%");
        }
      }
      lesson.watchedMin = next;
      adjustActivity(next - before);
    }

    saveState();
    renderAll();
  }

  function applyLessonAction(courseId, lessonId, act) {
    const course = findCourse(courseId);
    if (!course) return;
    const lesson = findLesson(course, lessonId);
    if (!lesson) return;

    if (act === "del") {
      if (
        lesson.watchedMin > 0 &&
        !confirm("这一节已记录 " + lesson.watchedMin + " 分钟，确定删除吗？")
      ) {
        return;
      }
      course.lessons = course.lessons.filter(function (l) {
        return l.id !== lessonId;
      });
      saveState();
      renderAll();
      toast("已删除一节");
      return;
    }

    if (act === "add15") {
      const before = lesson.watchedMin;
      let next = lesson.watchedMin + 15;
      if (lesson.totalMin > 0 && next > lesson.totalMin) {
        next = lesson.totalMin;
        toast("已到总时长上限，自动标记为看完");
      }
      lesson.watchedMin = next;
      adjustActivity(next - before);
    }

    if (act === "full") {
      if (lesson.totalMin === 0) {
        toast("先填这一节的总时长，再标记看完");
        return;
      }
      const before = lesson.watchedMin;
      lesson.watchedMin = lesson.totalMin;
      adjustActivity(lesson.totalMin - before);
    }

    saveState();
    renderAll();
  }

  function addLesson(courseId) {
    const course = findCourse(courseId);
    if (!course) return;
    const last = course.lessons[course.lessons.length - 1];
    const totalMin = last && last.totalMin ? last.totalMin : DEFAULT_LESSON_MIN;
    course.lessons.push({ id: makeId(), totalMin: totalMin, watchedMin: 0 });
    openIds.add(courseId);
    saveState();
    renderAll();
    toast("已添加第 " + course.lessons.length + " 节");
  }

  // ---------- B 站：提示词 + JSON 导入 ----------

  /**
   * 固定提示词。字段与 parseBiliPayload 的校验规则严格对应，
   * 改 JSON 结构时必须同步改这里，否则用户按提示词生成的数据会导不进来。
   */
  const BILI_PROMPT = [
    "请帮我查询下面这个 B 站视频的公开信息，并整理成 JSON。",
    "",
    "只接受 JSON，请严格遵守以下规则：",
    "1. 只输出一个 JSON 对象：第一个字符是 {，最后一个字符是 }。",
    "2. 不要输出任何解释、开场白、结尾语，也不要使用 ```json 代码块包裹。",
    "3. 顶层只能有 bvid、title、lessons 三个字段。",
    "4. bvid 是 11 位 BV 号（BV 加 10 位字母数字），不要带链接前缀。",
    "5. title 是视频标题原文。",
    "6. lessons 必须把这个视频的每个分 P 都列出来，一条一个分 P，按 page 从小到大排序。",
    "7. page 是分 P 序号，从 1 开始的整数；单 P 视频也写 1。",
    "8. 每条 lesson 的 title 是该分 P 的标题；没有分 P 标题时写「P{序号} 视频标题」。",
    "9. 每条 lesson 的 duration 是该分 P 的时长，只接受三种写法：\"mm:ss\"（例如 \"12:34\"）、\"h:mm:ss\"（超过 1 小时，例如 \"1:02:33\"）、纯秒数（例如 754）。不要写「分钟」「小时」等单位。",
    "10. 每条 lesson 的 url 固定写成 https://www.bilibili.com/video/{bvid}?p={page}。",
    "11. 不要添加任何多余字段。",
    "",
    "如果某个分 P 的时长查不到，不要编造：照样列出这一条，把 duration 写成 \"0:00\"，我导入时会被提示手动修改。",
    "",
    "输出示例（照这个结构，不要照抄内容）：",
    "{",
    '  "bvid": "BV1xx411c7mD",',
    '  "title": "数据结构与算法 · 全程班",',
    '  "lessons": [',
    '    {"page": 1, "title": "P1 绪论", "duration": "12:34", "url": "https://www.bilibili.com/video/BV1xx411c7mD?p=1"},',
    '    {"page": 2, "title": "P2 线性表", "duration": "1:02:33", "url": "https://www.bilibili.com/video/BV1xx411c7mD?p=2"},',
    '    {"page": 3, "title": "P3 栈与队列", "duration": 754, "url": "https://www.bilibili.com/video/BV1xx411c7mD?p=3"}',
    "  ]",
    "}",
    "",
    "视频链接：<把 B 站链接粘在这里>",
  ].join("\n");

  /** 秒数 → "m:ss" / "h:mm:ss" */
  function fmtHMS(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? h + ":" + pad(m) + ":" + pad(sec) : m + ":" + pad(sec);
  }

  /** 解析时长的三种写法：mm:ss、h:mm:ss、纯秒数；非法或为 0 时返回 null */
  function parseSecondsValue(raw) {
    if (typeof raw === "number") {
      return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
    }
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      return n > 0 ? n : null;
    }
    const hms = s.match(/^(\d{1,3})\s*[:：]\s*(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
    if (hms) {
      const h = parseInt(hms[1], 10);
      const m = parseInt(hms[2], 10);
      const sec = parseInt(hms[3], 10);
      if (m > 59 || sec > 59) return null;
      const total = h * 3600 + m * 60 + sec;
      return total > 0 ? total : null;
    }
    const ms = s.match(/^(\d{1,4})\s*[:：]\s*(\d{1,2})$/);
    if (ms) {
      const m = parseInt(ms[1], 10);
      const sec = parseInt(ms[2], 10);
      if (sec > 59) return null;
      const total = m * 60 + sec;
      return total > 0 ? total : null;
    }
    return null;
  }

  /** 字符下标 → "第 N 行第 M 列"，用于指出 JSON 语法错误的位置 */
  function locatePos(text, pos) {
    const before = text.slice(0, Math.max(0, Math.min(pos, text.length)));
    const line = before.split("\n").length;
    const col = before.length - before.lastIndexOf("\n");
    return "第 " + line + " 行第 " + col + " 列";
  }

  /**
   * 浏览器给的 JSON 报错有时不带位置，这里再扫一遍括号配对，
   * 尽量指出具体出错的行列。
   */
  function findBracketMismatch(text) {
    const stack = [];
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === "\\") {
          i++;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        stack.push({ ch: ch, i: i });
      } else if (ch === "}" || ch === "]") {
        const open = stack.pop();
        if (!open) return { index: i, why: "多了一个 " + ch };
        const want = open.ch === "{" ? "}" : "]";
        if (want !== ch) {
          return {
            index: i,
            why: ch + " 与 " + locatePos(text, open.i) + " 的 " + open.ch + " 不匹配",
          };
        }
      }
    }
    if (stack.length) {
      const open = stack[stack.length - 1];
      return { index: open.i, why: "这个 " + open.ch + " 一直没有闭合" };
    }
    return null;
  }

  /**
   * 解析并校验收到的 JSON。
   * 返回 { value } 或 { error }，error 里会指明具体是哪一条哪一节有问题。
   */
  function parseBiliPayload(raw) {
    let text = String(raw == null ? "" : raw).trim();
    if (!text) {
      return {
        error: "粘贴框是空的。先点「复制提示词」，把 B 站链接发给 AI，再把返回的 JSON 粘进来。",
      };
    }
    // 兼容 AI 偶尔加的 ```json 包裹
    text = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      const msg = String((err && err.message) || "解析失败");
      const m = msg.match(/position\s+(\d+)/i);
      let where = "";
      if (m) {
        where = "（" + locatePos(text, parseInt(m[1], 10)) + " 附近）";
      } else {
        const bad = findBracketMismatch(text);
        if (bad) {
          where = "（" + locatePos(text, bad.index) + " 附近：" + bad.why + "）";
        }
      }
      return {
        error:
          "不是合法 JSON" +
          where +
          "：" +
          msg +
          "。常见原因：夹带了说明文字、末尾多了逗号、用了中文引号。",
      };
    }

    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return {
        error:
          "JSON 顶层必须是对象 {...}，现在是 " +
          (Array.isArray(data) ? "数组 [...]" : data === null ? "null" : typeof data) +
          "。",
      };
    }

    const bvidRaw = typeof data.bvid === "string" ? data.bvid.trim() : "";
    if (!bvidRaw) {
      return { error: "缺少 bvid 字段。它应该是 11 位 BV 号，例如 BV1xx411c7mD。" };
    }
    const bm = bvidRaw.match(/BV[0-9A-Za-z]{10}/);
    if (!bm) {
      return {
        error:
          'bvid 格式不对："' +
          bvidRaw.slice(0, 30) +
          '" 里找不到 BV 号，应形如 BV1xx411c7mD（BV + 10 位字母数字）。',
      };
    }
    const bvid = bm[0];

    const title = typeof data.title === "string" ? data.title.trim() : "";
    if (!title) {
      return { error: "缺少 title 字段（课程标题）。" };
    }

    if (!Array.isArray(data.lessons)) {
      return {
        error: "缺少 lessons 数组。结构应为 lessons: [{page, title, duration, url}, ...] 。",
      };
    }
    if (data.lessons.length === 0) {
      return { error: "lessons 是空数组，至少要有 1 个分 P。" };
    }
    if (data.lessons.length > 999) {
      return {
        error: "分 P 数量太多（" + data.lessons.length + " 条），最多支持 999 条。",
      };
    }

    const errors = [];
    const lessons = [];
    const pageSeen = {};

    data.lessons.forEach(function (item, i) {
      const at = "第 " + (i + 1) + " 条（lessons[" + i + "]）";
      let bad = false;

      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(at + ' 不是对象，应形如 {"page":1,"title":"...","duration":"12:34"}');
        return;
      }

      const pageNum =
        typeof item.page === "number" ? item.page : parseInt(item.page, 10);
      if (!Number.isInteger(pageNum) || pageNum < 1) {
        errors.push(
          at +
            " 的 page 不是从 1 开始的整数：" +
            JSON.stringify(item.page === undefined ? "（缺失）" : item.page)
        );
        bad = true;
      } else if (pageSeen[pageNum]) {
        errors.push(
          at + " 的 page=" + pageNum + " 与" + pageSeen[pageNum] + " 重复"
        );
        bad = true;
      } else {
        pageSeen[pageNum] = at;
      }

      const lTitle = typeof item.title === "string" ? item.title.trim() : "";
      if (!lTitle) {
        errors.push(at + " 缺少 title（分 P 标题）。");
        bad = true;
      }

      const seconds = parseSecondsValue(item.duration);
      if (seconds === null) {
        errors.push(
          at +
            " 的 duration 无法识别：" +
            JSON.stringify(item.duration === undefined ? "（缺失）" : item.duration) +
            '（只支持 "mm:ss"、"h:mm:ss" 或纯秒数，且要大于 0）'
        );
        bad = true;
      }

      if (bad) return;

      let url = "";
      if (typeof item.url === "string" && BILI_URL_RE.test(item.url.trim())) {
        url = item.url.trim();
      }
      if (!url) {
        url = "https://www.bilibili.com/video/" + bvid + "?p=" + pageNum;
      }

      lessons.push({
        page: pageNum,
        title: lTitle,
        seconds: seconds,
        durationText: fmtHMS(seconds),
        totalMin: Math.max(1, Math.round(seconds / 60)),
        url: url,
      });
    });

    if (errors.length) {
      const shown = errors.slice(0, 8);
      const rest = errors.length - shown.length;
      return {
        error:
          "发现 " +
          errors.length +
          " 处问题：\n· " +
          shown.join("\n· ") +
          (rest > 0 ? "\n…还有 " + rest + " 处未列出" : ""),
      };
    }

    lessons.sort(function (a, b) {
      return a.page - b.page;
    });

    let totalSeconds = 0;
    let totalMin = 0;
    lessons.forEach(function (l) {
      totalSeconds += l.seconds;
      totalMin += l.totalMin;
    });

    const clipped = title.length > 40;
    return {
      value: {
        bvid: bvid,
        title: title,
        name: title.slice(0, 40),
        clipped: clipped,
        lessons: lessons,
        totalSeconds: totalSeconds,
        totalMin: totalMin,
      },
    };
  }

  /** 把校验结果渲染成预览，等用户确认 */
  function showImportResult(value) {
    pendingImport = value;

    const st = courseStats({ lessons: value.lessons.map(function (l) {
      return { totalMin: l.totalMin, watchedMin: 0 };
    }) });

    el.biliError.hidden = true;
    el.biliPreview.hidden = false;
    el.previewTitle.textContent = value.name;
    el.previewMeta.textContent =
      "共 " +
      value.lessons.length +
      " 节 · 总计时长 " +
      fmtHMS(value.totalSeconds) +
      " · 计入课程 " +
      fmtDur(value.totalMin) +
      "（" +
      st.count +
      " 节待看）" +
      (value.clipped ? " · 标题超过 40 字，已截断" : "");

    el.previewBody.innerHTML = value.lessons
      .map(function (l) {
        return (
          '<tr><td class="mono">P' +
          l.page +
          "</td><td>" +
          escapeHtml(l.title) +
          '</td><td class="mono">' +
          l.durationText +
          '</td><td class="mono">' +
          l.totalMin +
          " 分钟</td></tr>"
        );
      })
      .join("");

    const dup = state.courses.find(function (c) {
      return c.name === value.name;
    });
    if (dup) {
      el.previewDup.hidden = false;
      el.dupNew.checked = true;
      el.dupText.textContent =
        "已有同名课程《" +
        dup.name +
        "》（" +
        dup.lessons.length +
        " 节）。确认前请选择：新增一门同名课程，还是覆盖它。";
      el.confirmImportBtn.textContent = "按所选方式导入";
    } else {
      el.previewDup.hidden = true;
      el.confirmImportBtn.textContent = "确认导入";
    }
  }

  function showImportError(msg) {
    pendingImport = null;
    el.biliPreview.hidden = true;
    el.biliError.hidden = false;
    el.biliError.textContent = msg;
  }

  function resetImportPanel() {
    pendingImport = null;
    el.biliJson.value = "";
    el.biliPreview.hidden = true;
    el.biliError.hidden = true;
  }

  /** 确认写入：默认新增课程，不覆盖已有课程 */
  function confirmBiliImport() {
    const p = pendingImport;
    if (!p) return;

    const dup = state.courses.find(function (c) {
      return c.name === p.name;
    });
    const overwrite = !!(dup && el.dupOverwrite.checked);

    const lessons = p.lessons.map(function (l) {
      return { id: makeId(), totalMin: l.totalMin, watchedMin: 0, url: l.url };
    });

    if (overwrite) {
      // 按节序沿用原来的已看时长，避免覆盖时把进度清零
      let kept = 0;
      lessons.forEach(function (l, i) {
        const old = dup.lessons[i];
        if (old && old.watchedMin > 0) {
          l.watchedMin = Math.min(old.watchedMin, l.totalMin);
          kept++;
        }
      });
      dup.lessons = lessons;
      openIds.add(dup.id);
      saveState();
      renderAll();
      toast(
        "已覆盖《" +
          dup.name +
          "》，共 " +
          lessons.length +
          " 节" +
          (kept ? "，沿用 " + kept + " 节已看时长" : "")
      );
    } else {
      const course = { id: makeId(), name: p.name, lessons: lessons };
      state.courses.push(course);
      seenIds.add(course.id);
      openIds.add(course.id);
      saveState();
      renderAll();
      toast(
        "已导入《" +
          p.name +
          "》，共 " +
          lessons.length +
          " 节，总时长 " +
          fmtDur(p.totalMin)
      );
    }

    resetImportPanel();
  }

  /** 复制文本，file:// 下 clipboard API 可能不可用，降级到 execCommand */
  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            resolve(true);
          },
          function () {
            resolve(fallbackCopy(text));
          }
        );
        return;
      }
      resolve(fallbackCopy(text));
    });
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  // ---------- 云同步（可选，Cloudflare Workers + D1） ----------
  // 契约：GET /sync/{code} → { data, updatedAt }；PUT 带 baseUpdatedAt，
  // 版本不一致返回 409 且附服务端内容。任何冲突都必须由用户选择，绝不自动覆盖。

  function loadSyncCfg() {
    const fallback = {
      code: "",
      baseUrl: "",
      auto: false,
      updatedAt: null,
      lastSyncAt: 0,
    };
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      if (!raw) return fallback;
      const o = JSON.parse(raw);
      return {
        code: typeof o.code === "string" ? o.code : "",
        baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : "",
        auto: !!o.auto,
        updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : null,
        lastSyncAt: typeof o.lastSyncAt === "number" ? o.lastSyncAt : 0,
      };
    } catch (err) {
      return fallback;
    }
  }

  function saveSyncCfg() {
    try {
      localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));
    } catch (err) {
      console.warn("保存同步设置失败");
    }
  }

  /** 把界面上的同步码 / 地址 / 自动同步写回配置 */
  function readSyncInputs() {
    if (!syncCfg) return;
    syncCfg.code = el.syncCode.value.trim();
    syncCfg.baseUrl = el.syncBase.value.trim();
    syncCfg.auto = el.syncAuto.checked;
    saveSyncCfg();
    return syncCfg;
  }

  function syncConfigError() {
    if (!syncCfg.baseUrl) return "还没填 Worker 地址";
    if (!syncCfg.code) return "还没填同步码";
    if (syncCfg.code.length < SYNC_CODE_MIN) {
      return (
        "口令错误：同步码至少 " +
        SYNC_CODE_MIN +
        " 位，现在只有 " +
        syncCfg.code.length +
        " 位"
      );
    }
    return null;
  }

  function syncEndpoint(code) {
    let base = String(syncCfg.baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return null;
    if (!/^https?:\/\//i.test(base)) base = "https://" + base;
    return base + "/sync/" + encodeURIComponent(code);
  }

  /** 上传用的快照：只带进度，不带同步码 */
  function snapshot() {
    return { v: 2, courses: state.courses, activity: state.activity };
  }

  function timeLabel(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    return (
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  function setSyncStatus(kind, text) {
    el.syncStatus.textContent = text;
    el.syncStatus.dataset.state = kind;
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        const err = new Error("timeout");
        err.name = "AbortError";
        reject(err);
      }, ms);
      promise.then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (err) {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  /** 用云端数据覆盖本地（保留同步码，不触发自动上传回声） */
  function applyRemote(data, updatedAt) {
    const clean = sanitize(data);
    if (!clean) return false;
    suppressAutoSync = true;
    state = clean;
    saveState();
    suppressAutoSync = false;
    syncCfg.updatedAt = typeof updatedAt === "number" ? updatedAt : null;
    syncCfg.lastSyncAt = Date.now();
    saveSyncCfg();
    seenIds.clear();
    openIds.clear();
    renderAll();
    return true;
  }

  function showConflict(server, reason) {
    const s = server && typeof server === "object" ? server : {};
    pendingConflict = {
      data: s.data && typeof s.data === "object" ? s.data : null,
      updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : null,
      reason: reason || "云端有更新",
    };

    el.conflictNote.textContent =
      pendingConflict.reason +
      "。云端版本：" +
      (pendingConflict.updatedAt ? timeLabel(pendingConflict.updatedAt) : "（无记录）") +
      "；本机现有 " +
      state.courses.length +
      " 门课程。请选择保留哪一份，不会自动覆盖。";
    el.conflictTakeRemote.disabled = !pendingConflict.data;
    el.syncConflict.hidden = false;
    setSyncStatus("conflict", "冲突：云端已被别处改过，等你选择");
  }

  function closeConflict() {
    el.syncConflict.hidden = true;
    pendingConflict = null;
  }

  /** 上传：forceBase 用于冲突时「用本地覆盖云端」 */
  function syncUpload(forceBase) {
    if (syncBusy) {
      toast("上一个同步请求还没结束，稍等一下");
      return;
    }
    readSyncInputs();
    const bad = syncConfigError();
    if (bad) {
      setSyncStatus("error", bad);
      toast(bad);
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setSyncStatus("error", "离线：网络不可用，进度仍保存在本机");
      toast("当前离线，先记在本地，联网后再上传");
      return;
    }
    const endpoint = syncEndpoint(syncCfg.code);
    if (!endpoint) {
      setSyncStatus("error", "Worker 地址无效");
      return;
    }

    // baseUpdatedAt 永远是「上次从云端拿到的版本号」；首次上传为 null
    const base = forceBase === undefined ? syncCfg.updatedAt : forceBase;
    let payload;
    try {
      payload = JSON.stringify({ data: snapshot(), baseUpdatedAt: base });
    } catch (err) {
      setSyncStatus("error", "本地数据无法序列化，上传失败");
      return;
    }

    syncBusy = true;
    setSyncStatus("busy", "正在上传…");

    withTimeout(
      fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }),
      SYNC_TIMEOUT
    )
      .then(function (res) {
        if (res.status === 200) {
          return res.json().then(function (body) {
            if (body && typeof body.updatedAt === "number") {
              syncCfg.updatedAt = body.updatedAt;
            }
            syncCfg.lastSyncAt = Date.now();
            saveSyncCfg();
            setSyncStatus("ok", "上次同步：" + timeLabel(syncCfg.lastSyncAt) + " · 已上传");
            toast("已上传到云端");
          });
        }
        if (res.status === 409) {
          return res.json().then(function (body) {
            showConflict(body, "上传被拒绝：云端已被别的设备改过");
          });
        }
        if (res.status === 400) {
          return res.json().then(function (body) {
            const msg = "口令错误：" + ((body && body.message) || "同步码不合法");
            setSyncStatus("error", msg);
            toast("同步码不合法：至少 16 位，且不能含空格");
          });
        }
        if (res.status === 404) {
          setSyncStatus("error", "地址不对：Worker 没有这个接口，检查 Worker 地址");
          return;
        }
        if (res.status === 413) {
          setSyncStatus("error", "数据太大（超过 1 MB），上传失败");
          return;
        }
        throw new Error("HTTP " + res.status);
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") {
          setSyncStatus("error", "同步超时：Worker 15 秒内没有响应");
        } else if (err && /^HTTP /.test(String(err.message || ""))) {
          setSyncStatus("error", "同步失败：" + err.message + "，进度仍在本机");
        } else {
          setSyncStatus("error", "离线或 Worker 地址不可达：上传失败");
        }
        toast("上传失败，进度仍保存在本机");
      })
      .then(function () {
        syncBusy = false;
      });
  }

  /** 拉取：云端版本更新时先确认，再覆盖本地 */
  function syncPull() {
    if (syncBusy) {
      toast("上一个同步请求还没结束，稍等一下");
      return;
    }
    readSyncInputs();
    const bad = syncConfigError();
    if (bad) {
      setSyncStatus("error", bad);
      toast(bad);
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setSyncStatus("error", "离线：网络不可用，本机记录照常可用");
      toast("当前离线，拉取失败");
      return;
    }
    const endpoint = syncEndpoint(syncCfg.code);
    if (!endpoint) {
      setSyncStatus("error", "Worker 地址无效");
      return;
    }

    syncBusy = true;
    setSyncStatus("busy", "正在拉取…");

    withTimeout(
      fetch(endpoint, { method: "GET", headers: { Accept: "application/json" } }),
      SYNC_TIMEOUT
    )
      .then(function (res) {
        if (res.status === 200) {
          return res.json().then(function (body) {
            if (!body || !body.data) {
              setSyncStatus("error", "云端返回的数据不完整，没有应用");
              return;
            }
            if (
              typeof body.updatedAt === "number" &&
              body.updatedAt === syncCfg.updatedAt
            ) {
              setSyncStatus("ok", "云端与本机版本一致：" + timeLabel(body.updatedAt));
              toast("已经是最新，不需要覆盖");
              return;
            }
            if (
              state.courses.length > 0 &&
              !confirm(
                "用云端进度覆盖本机？\n本机现有 " +
                  state.courses.length +
                  " 门课程，覆盖后无法撤销，建议先导出备份。"
              )
            ) {
              setSyncStatus("idle", "已取消拉取，本机数据没有变化");
              return;
            }
            if (applyRemote(body.data, body.updatedAt)) {
              setSyncStatus("ok", "上次同步：" + timeLabel(syncCfg.lastSyncAt) + " · 已拉取");
              toast("已用云端进度覆盖本机");
            } else {
              setSyncStatus("error", "云端数据格式不对，没有应用");
            }
          });
        }
        if (res.status === 404) {
          setSyncStatus("error", "口令错误或云端无数据：这个同步码还没有记录");
          toast("检查同步码是否输错，或先在这台设备上传一次");
          return;
        }
        if (res.status === 400) {
          return res.json().then(function (body) {
            setSyncStatus("error", "口令错误：" + ((body && body.message) || "同步码不合法"));
          });
        }
        throw new Error("HTTP " + res.status);
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") {
          setSyncStatus("error", "同步超时：Worker 15 秒内没有响应");
        } else if (err && /^HTTP /.test(String(err.message || ""))) {
          setSyncStatus("error", "拉取失败：" + err.message + "，本机数据未变");
        } else {
          setSyncStatus("error", "离线或 Worker 地址不可达：拉取失败");
        }
        toast("拉取失败，本机数据未变");
      })
      .then(function () {
        syncBusy = false;
      });
  }

  function scheduleAutoSync() {
    if (suppressAutoSync || !syncCfg || !syncCfg.auto) return;
    if (pendingConflict) return; // 冲突没解决前不再自动上传
    if (!syncCfg.code || syncCfg.code.length < SYNC_CODE_MIN) return;
    if (!syncCfg.baseUrl) return;
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(function () {
      syncUpload();
    }, 2000);
  }

  function initSyncPanel() {
    el.syncCode.value = syncCfg.code;
    el.syncBase.value = syncCfg.baseUrl;
    el.syncAuto.checked = !!syncCfg.auto;
    if (syncCfg.lastSyncAt) {
      setSyncStatus("ok", "上次同步：" + timeLabel(syncCfg.lastSyncAt));
    } else {
      setSyncStatus("idle", "尚未同步");
    }
  }

  // ---------- 事件 ----------

  el.addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    const name = el.courseName.value.trim();
    const count = clampInt(el.courseCount.value, 1, 999, 0);
    const defaultMin = parseDuration(el.courseDefault.value);

    if (!name) {
      toast("先给课程起个名字吧");
      el.courseName.focus();
      return;
    }
    if (!count) {
      toast("节数要填 1 到 999 之间的整数");
      el.courseCount.focus();
      return;
    }
    if (defaultMin === null || defaultMin <= 0) {
      toast("每节默认时长请填 45 或 0:45 这样的格式");
      el.courseDefault.focus();
      return;
    }
    if (
      state.courses.some(function (c) {
        return c.name === name;
      })
    ) {
      toast("已经有一门同名的课程了");
      return;
    }

    addCourse(name, count, Math.min(defaultMin, 9999));
    el.addForm.reset();
    el.courseDefault.value = "45";
    el.courseName.focus();
  });

  el.courseList.addEventListener("click", function (e) {
    const toggle = e.target.closest(".course-toggle");
    if (toggle) {
      const id = toggle.dataset.cid;
      if (openIds.has(id)) {
        openIds.delete(id);
      } else {
        openIds.add(id);
      }
      renderCourses();
      return;
    }

    const delCourse = e.target.closest(".icon-btn.del");
    if (delCourse) {
      removeCourse(delCourse.dataset.cid);
      return;
    }

    const addBtn = e.target.closest(".add-lesson");
    if (addBtn) {
      addLesson(addBtn.dataset.cid);
      return;
    }

    const action = e.target.closest(".mini[data-act], .l-del[data-act]");
    if (action) {
      const row = action.closest(".lesson");
      if (row) {
        applyLessonAction(row.dataset.cid, row.dataset.lid, action.dataset.act);
      }
    }
  });

  // 输入框失焦 / 回车时提交
  el.courseList.addEventListener("change", function (e) {
    const input = e.target.closest(".l-input");
    if (!input) return;
    const row = input.closest(".lesson");
    commitLessonField(row.dataset.cid, row.dataset.lid, input.dataset.k, input.value, input);
  });

  el.courseList.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    const input = e.target.closest(".l-input");
    if (!input) return;
    e.preventDefault();
    input.blur();
  });

  // B 站课程导入
  el.copyPromptBtn.addEventListener("click", function () {
    copyText(BILI_PROMPT).then(function (ok) {
      toast(
        ok
          ? "提示词已复制，粘到 AI 里，再把 B 站链接附在后面"
          : "复制失败，请手动选中提示词复制"
      );
    });
  });

  el.previewBtn.addEventListener("click", function () {
    const res = parseBiliPayload(el.biliJson.value);
    if (res.error) {
      showImportError(res.error);
      return;
    }
    showImportResult(res.value);
  });

  el.biliClearBtn.addEventListener("click", function () {
    resetImportPanel();
    el.biliJson.focus();
  });

  el.confirmImportBtn.addEventListener("click", confirmBiliImport);

  el.cancelImportBtn.addEventListener("click", function () {
    pendingImport = null;
    el.biliPreview.hidden = true;
    toast("已取消，没有写入任何课程");
  });

  // Ctrl / Cmd + Enter 直接预览
  el.biliJson.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      el.previewBtn.click();
    }
  });

  // ---------- 云同步事件 ----------

  el.syncCodeToggle.addEventListener("click", function () {
    const shown = el.syncCode.type === "text";
    el.syncCode.type = shown ? "password" : "text";
    el.syncCodeToggle.textContent = shown ? "显示" : "隐藏";
    el.syncCodeToggle.setAttribute("aria-pressed", String(!shown));
  });

  el.syncCode.addEventListener("change", readSyncInputs);
  el.syncBase.addEventListener("change", readSyncInputs);

  el.syncAuto.addEventListener("change", function () {
    readSyncInputs();
    toast(syncCfg.auto ? "已开启自动上传，改动后 2 秒内同步" : "已关闭自动上传");
  });

  el.syncUploadBtn.addEventListener("click", function () {
    syncUpload();
  });

  el.syncPullBtn.addEventListener("click", syncPull);

  el.syncForgetBtn.addEventListener("click", function () {
    if (!confirm("清除本机的同步码和 Worker 地址？云端数据不会被删除。")) return;
    syncCfg = { code: "", baseUrl: "", auto: false, updatedAt: null, lastSyncAt: 0 };
    saveSyncCfg();
    el.syncCode.value = "";
    el.syncBase.value = "";
    el.syncAuto.checked = false;
    setSyncStatus("idle", "尚未同步");
    toast("已清除本机同步设置");
  });

  el.conflictTakeRemote.addEventListener("click", function () {
    if (!pendingConflict || !pendingConflict.data) return;
    if (!confirm("用云端数据覆盖本机全部记录？此操作不可撤销。")) return;
    const ok = applyRemote(pendingConflict.data, pendingConflict.updatedAt);
    closeConflict();
    if (ok) {
      setSyncStatus("ok", "上次同步：" + timeLabel(syncCfg.lastSyncAt) + " · 已用云端覆盖本地");
      toast("已用云端覆盖本地");
    } else {
      setSyncStatus("error", "云端数据格式不对，没有应用");
    }
  });

  el.conflictPushLocal.addEventListener("click", function () {
    if (!pendingConflict) return;
    const base = pendingConflict.updatedAt;
    closeConflict();
    toast("正在用本地覆盖云端…");
    syncUpload(base);
  });

  el.conflictCancel.addEventListener("click", function () {
    closeConflict();
    setSyncStatus("conflict", "冲突未解决：云端与本机各自保留，下次同步还会提示");
    toast("已暂时搁置冲突");
  });

  el.seedBtn.addEventListener("click", function () {
    const today = new Date();

    const cLessons = [];
    for (let i = 1; i <= 86; i++) {
      let totalMin = 45;
      let watchedMin = i <= 12 ? 45 : 0;
      if (i === 13) {
        // 示例：一节 1 小时 23 分，看到 43 分钟
        totalMin = 83;
        watchedMin = 43;
      }
      cLessons.push({ id: makeId(), totalMin: totalMin, watchedMin: watchedMin });
    }

    const bLessons = [];
    for (let i = 1; i <= 24; i++) {
      bLessons.push({
        id: makeId(),
        totalMin: 30,
        watchedMin: i <= 8 ? 30 : 0,
      });
    }

    state.courses = [
      { id: makeId(), name: "C 语言程序设计", lessons: cLessons },
      { id: makeId(), name: "大学计算机基础", lessons: bLessons },
    ];

    [7, 6, 5, 3, 2, 1].forEach(function (back, idx) {
      state.activity[dateKey(addDays(today, -back))] = [45, 90, 20, 60, 30, 120][idx];
    });
    delete state.activity[dateKey(today)]; // 今天留空，由你自己记

    saveState();
    seenIds.clear();
    openIds.clear();
    renderAll();
    toast("已填入示例课程，随时可以删掉换成你自己的");
  });

  // ---------- 导入导出 ----------

  el.exportBtn.addEventListener("click", function () {
    if (state.courses.length === 0) {
      toast("还没有数据可以导出");
      return;
    }
    const payload = JSON.stringify(
      {
        v: 2,
        exportedAt: new Date().toISOString(),
        courses: state.courses,
        activity: state.activity,
      },
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
      seenIds.clear();
      openIds.clear();
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
    seenIds.clear();
    openIds.clear();
    renderAll();
    toast("已清空，本子重新开张");
  });

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove("show");
    }, 2400);
  }

  // ---------- 启动 ----------

  el.promptText.textContent = BILI_PROMPT;
  syncCfg = loadSyncCfg();
  initSyncPanel();

  renderAll();

  if (migratedOnLoad) {
    saveState(); // 迁移结果立刻落盘，v2 结构只迁移一次
    toast("旧数据已迁移：已完成的课按每节 45 分钟记为看满");
  }

  let resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderHeatmap, 200);
  });
})();
