/* ==========================================================
   学习进度手账 — 纯前端逻辑
   进度按「分钟」记录，课程与总体进度都用时长加权计算
   数据全部保存在 localStorage，不依赖后端与第三方库
   ========================================================== */

(function () {
  "use strict";

  const STORE_KEY = "study-log-v1"; // 沿用旧 key，老数据读取后自动迁移
  const SUPA_CFG_KEY = "study-supabase-v1"; // Supabase 连接配置，不随导出的进度文件走
  const SUPA_SESSION_KEY = "study-supabase-session-v1"; // 登录态（access/refresh token）
  const SUPA_META_KEY = "study-supabase-meta-v1"; // 每个账号的云端版本号与上次同步快照
  const SUPA_TIMEOUT = 15000;
  const SYNC_DEBOUNCE = 1500;
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

  // 云同步运行状态（Supabase 配置、登录态、云端版本号都存 localStorage）
  let supaCfg = null; // { url, anonKey, auto }
  let supaSession = null; // { accessToken, refreshToken, expiresAt, userId, email }
  let supaMeta = null; // { userId, baseRev, syncedHash, lastSyncAt }
  let supaBusy = false;
  let supaReady = false; // 登录后的首次云端核对是否完成
  let supaRefreshPromise = null;
  let suppressAutoSync = false;
  let autoSyncTimer = null;
  let pendingConflict = null; // { remote: { data, rev, updatedAt }, reason }

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
    // demoActivity 只记「示例打卡」那部分分钟数，方便把示例与真实记录分开清除
    return { v: 2, courses: [], activity: {}, demoActivity: {} };
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
    const course = {
      id: String(c.id || makeId()),
      name: String(c.name).slice(0, 40).trim(),
      lessons: lessons,
    };
    // 示例课程打标记，用于界面提示与「清除示例数据」
    if (c.demo === true) course.demo = true;
    return course;
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
    // 示例打卡的分钟数单独记一份，清除示例时不误伤真实打卡
    const demoActivity = {};
    const rawDemo =
      data.demoActivity && typeof data.demoActivity === "object"
        ? data.demoActivity
        : {};
    Object.keys(rawDemo).forEach(function (k) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      const value = clampInt(rawDemo[k], 0, 99999, 0);
      if (value > 0) demoActivity[k] = value;
    });

    return { v: 2, courses: courses, activity: activity, demoActivity: demoActivity };
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
    heatNote: $("#heatNote"),
    heatNoteText: $("#heatNoteText"),
    heatResetBtn: $("#heatResetBtn"),
    addForm: $("#addForm"),
    courseName: $("#courseName"),
    courseCount: $("#courseCount"),
    courseDefault: $("#courseDefault"),
    courseList: $("#courseList"),
    emptyState: $("#emptyState"),
    seedBtn: $("#seedBtn"),
    demoNotice: $("#demoNotice"),
    demoNoticeText: $("#demoNoticeText"),
    demoClearBtn: $("#demoClearBtn"),
    exportBtn: $("#exportBtn"),
    importBtn: $("#importBtn"),
    importFile: $("#importFile"),
    resetActivityBtn: $("#resetActivityBtn"),
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
    supaConfigBlock: $("#supaConfigBlock"),
    supaUrl: $("#supaUrl"),
    supaKey: $("#supaKey"),
    supaKeyToggle: $("#supaKeyToggle"),
    supaCfgSave: $("#supaCfgSave"),
    supaCfgForget: $("#supaCfgForget"),
    supaLoginBlock: $("#supaLoginBlock"),
    supaLoginForm: $("#supaLoginForm"),
    supaEmail: $("#supaEmail"),
    supaPassword: $("#supaPassword"),
    supaLoginBtn: $("#supaLoginBtn"),
    supaAuthStatus: $("#supaAuthStatus"),
    supaSessionBlock: $("#supaSessionBlock"),
    supaWho: $("#supaWho"),
    supaAuto: $("#supaAuto"),
    supaPushBtn: $("#supaPushBtn"),
    supaPullBtn: $("#supaPullBtn"),
    supaLogoutBtn: $("#supaLogoutBtn"),
    supaSyncStatus: $("#supaSyncStatus"),
    syncPanel: $("#syncPanel"),
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
    renderDemoNotice();
    renderHeatNote();
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
      (course.demo ? '<span class="demo-tag">示例</span>' : "") +
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

  /** 示例数据的规模：几门示例课程、几天示例打卡 */
  function demoSummary() {
    let demoCourses = 0;
    state.courses.forEach(function (c) {
      if (c.demo) demoCourses++;
    });
    let demoDays = 0;
    let demoMin = 0;
    Object.keys(state.demoActivity || {}).forEach(function (k) {
      demoDays++;
      demoMin += state.demoActivity[k];
    });
    return { demoCourses: demoCourses, demoDays: demoDays, demoMin: demoMin };
  }

  /** 当前是否还在看示例数据 —— 明确提示，避免把演示进度当成真实记录 */
  function renderDemoNotice() {
    const s = demoSummary();
    const show = s.demoCourses > 0 || s.demoDays > 0;
    el.demoNotice.hidden = !show;
    if (!show) return;
    const parts = [];
    if (s.demoCourses) parts.push(s.demoCourses + " 门示例课程");
    if (s.demoDays) {
      parts.push(s.demoDays + " 天示例打卡（共 " + s.demoMin + " 分钟）");
    }
    el.demoNoticeText.textContent =
      "当前是示例数据：" + parts.join("、") + "，不是你的真实学习记录。";
  }

  /** 打卡有记录但一门课都没有时，说明这些记录已失去来源 */
  function renderHeatNote() {
    let total = 0;
    Object.keys(state.activity).forEach(function (k) {
      total += state.activity[k];
    });
    const orphan = state.courses.length === 0 && total > 0;
    el.heatNote.hidden = !orphan;
    if (!orphan) return;
    el.heatNoteText.textContent =
      "日历上还留着 " +
      total +
      " 分钟打卡，但当前没有任何课程支撑（课程可能已被删除）。这些记录不会自动消失，想清掉请点右侧「重置打卡记录」。";
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

  /** 从日历里扣掉示例打卡的部分，真实打卡保留 */
  function subtractDemoActivity() {
    Object.keys(state.demoActivity || {}).forEach(function (key) {
      const left = (state.activity[key] || 0) - state.demoActivity[key];
      if (left > 0) {
        state.activity[key] = left;
      } else {
        delete state.activity[key];
      }
    });
    state.demoActivity = {};
  }

  /** 清除示例：示例课程 + 示例打卡，自己登记的课程和打卡不动 */
  function clearDemoData() {
    const s = demoSummary();
    if (!s.demoCourses && !s.demoDays) {
      toast("现在没有示例数据");
      return;
    }
    const parts = [];
    if (s.demoCourses) parts.push(s.demoCourses + " 门示例课程");
    if (s.demoDays) {
      parts.push(s.demoDays + " 天示例打卡（共 " + s.demoMin + " 分钟）");
    }
    if (
      !confirm(
        "清除示例数据？将删掉 " +
          parts.join("、") +
          "。你自己登记的课程和打卡不受影响。"
      )
    ) {
      return;
    }

    const demoIds = new Set();
    state.courses.forEach(function (c) {
      if (c.demo) demoIds.add(c.id);
    });
    state.courses = state.courses.filter(function (c) {
      return !c.demo;
    });
    subtractDemoActivity();

    demoIds.forEach(function (id) {
      openIds.delete(id);
      seenIds.delete(id);
    });

    saveState();
    renderAll();
    toast("已清除示例数据，示例打卡也一并清掉了");
  }

  /** 重置打卡：只清 activity / demoActivity，课程与每节已看时长保留 */
  function resetActivity() {
    const total = Object.keys(state.activity).length;
    if (total === 0) {
      toast("现在没有打卡记录");
      return;
    }
    if (
      !confirm(
        "只清空学习打卡记录？日历热力图和连续打卡天数会归零，课程及每节已看时长都会保留。此操作不可撤销。"
      )
    ) {
      return;
    }
    state.activity = {};
    state.demoActivity = {};
    saveState();
    renderAll();
    toast("打卡记录已重置，课程和已看时长都还在");
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

  // ---------- 云同步（可选，Supabase Auth + PostgREST） ----------
  // 云端只存一行 { user_id, data(jsonb), rev, updated_at }。
  // 上传用 rev 做乐观锁：PATCH ...&rev=eq.{baseRev}，命中 0 行即冲突。
  // 任何冲突都必须由用户选择，绝不自动覆盖。

  function loadStoredJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (err) {
      console.warn("读取本地配置失败：" + key, err);
      return fallback;
    }
  }

  function saveStoredJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn("保存本地配置失败：" + key, err);
    }
  }

  function loadSupaCfg() {
    const o = loadStoredJson(SUPA_CFG_KEY, {});
    return {
      url: typeof o.url === "string" ? o.url : "",
      anonKey: typeof o.anonKey === "string" ? o.anonKey : "",
      auto: o.auto !== false,
    };
  }

  function saveSupaCfg() {
    saveStoredJson(SUPA_CFG_KEY, supaCfg);
  }

  function supaConfigured() {
    return !!(supaCfg && supaCfg.url && supaCfg.anonKey);
  }

  function loadSupaSession() {
    const o = loadStoredJson(SUPA_SESSION_KEY, null);
    if (!o || typeof o.accessToken !== "string" || !o.accessToken) return null;
    return {
      accessToken: o.accessToken,
      refreshToken: typeof o.refreshToken === "string" ? o.refreshToken : "",
      expiresAt: Number.isFinite(o.expiresAt) ? o.expiresAt : 0,
      userId: typeof o.userId === "string" ? o.userId : "",
      email: typeof o.email === "string" ? o.email : "",
    };
  }

  function loadSupaMeta() {
    const o = loadStoredJson(SUPA_META_KEY, {});
    return {
      userId: typeof o.userId === "string" ? o.userId : "",
      baseRev: Number.isFinite(o.baseRev) ? o.baseRev : 0,
      syncedHash: typeof o.syncedHash === "string" ? o.syncedHash : "",
      lastSyncAt: Number.isFinite(o.lastSyncAt) ? o.lastSyncAt : 0,
    };
  }

  function saveSupaMeta() {
    saveStoredJson(SUPA_META_KEY, supaMeta);
  }

  /** 稳定的 JSON 序列化：对象键排序，避免键顺序不同被误判为「有改动」 */
  function canonical(value) {
    if (Array.isArray(value)) {
      return "[" + value.map(canonical).join(",") + "]";
    }
    if (value && typeof value === "object") {
      return (
        "{" +
        Object.keys(value)
          .sort()
          .map(function (k) {
            return JSON.stringify(k) + ":" + canonical(value[k]);
          })
          .join(",") +
        "}"
      );
    }
    return JSON.stringify(value);
  }

  function hashState(data) {
    const text = canonical(data);
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = (h * 33 + text.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36) + ":" + text.length;
  }

  /** 上传 / 比对用的整份快照；示例打卡也记一份，跨设备才能一致 */
  function snapshot() {
    return {
      v: 2,
      courses: state.courses,
      activity: state.activity,
      demoActivity: state.demoActivity || {},
    };
  }

  function hasLocalData() {
    return (
      state.courses.length > 0 ||
      Object.keys(state.activity).length > 0 ||
      Object.keys(state.demoActivity || {}).length > 0
    );
  }

  function localDirty() {
    return hashState(snapshot()) !== supaMeta.syncedHash;
  }

  function normalizeSupaUrl(raw) {
    let url = String(raw == null ? "" : raw).trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    return url;
  }

  function supaUrl(path) {
    return String(supaCfg.url || "").replace(/\/+$/, "") + path;
  }

  function isOnline() {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  function isNetworkError(err) {
    return /Failed to fetch|NetworkError|Load failed|Network request failed|network/i.test(
      String((err && err.message) || err)
    );
  }

  function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, SUPA_TIMEOUT);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).then(
      function (res) {
        clearTimeout(timer);
        return res;
      },
      function (err) {
        clearTimeout(timer);
        throw err;
      }
    );
  }

  async function readErrorBody(res) {
    try {
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  function authErrorText(status, detail) {
    const s = String(detail || "");
    if (/invalid login credentials/i.test(s)) return "邮箱或密码不对";
    if (/email not confirmed/i.test(s)) {
      return "邮箱还没验证：请在 Supabase 控制台确认这个用户，或关闭邮箱验证";
    }
    if (/invalid refresh token|refresh token.*(expired|not found)/i.test(s)) {
      return "登录已过期，请重新登录";
    }
    if (status === 429) return "尝试太频繁，等几分钟再登录";
    if (status === 404) return "接口地址不对：检查 Supabase 项目 URL";
    return "登录失败：" + (s || "HTTP " + status);
  }

  async function supaAuthRequest(path, body) {
    const res = await fetchWithTimeout(supaUrl(path), {
      method: "POST",
      headers: {
        apikey: supaCfg.anonKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      const info = await readErrorBody(res);
      const err = new Error(
        authErrorText(
          res.status,
          info && (info.msg || info.error_description || info.error || info.message)
        )
      );
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function sessionFromAuth(body) {
    if (!body || typeof body.access_token !== "string" || !body.user) {
      throw new Error("登录响应不完整，没有拿到 token");
    }
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : "",
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      userId: String(body.user.id || ""),
      email: String(body.user.email || ""),
    };
  }

  async function refreshSession() {
    if (!supaSession || !supaSession.refreshToken) {
      throw new Error("没有可用的 refresh token，请重新登录");
    }
    if (supaRefreshPromise) return supaRefreshPromise;
    supaRefreshPromise = supaAuthRequest(
      "/auth/v1/token?grant_type=refresh_token",
      { refresh_token: supaSession.refreshToken }
    ).then(function (body) {
      supaSession = sessionFromAuth(body);
      saveStoredJson(SUPA_SESSION_KEY, supaSession);
      supaRefreshPromise = null;
      return supaSession;
    });
    supaRefreshPromise.catch(function () {
      supaRefreshPromise = null;
    });
    return supaRefreshPromise;
  }

  async function ensureSession() {
    if (!supaSession) throw new Error("未登录");
    if (supaSession.expiresAt && Date.now() > supaSession.expiresAt - 120000) {
      return refreshSession();
    }
    return supaSession;
  }

  function authHeaders() {
    return {
      apikey: supaCfg.anonKey,
      Authorization: "Bearer " + (supaSession ? supaSession.accessToken : ""),
      Accept: "application/json",
    };
  }

  /** PostgREST 请求；401 时续期一次再重放 */
  async function restRequest(path, options) {
    await ensureSession();
    const opts = Object.assign({}, options);
    opts.headers = Object.assign({}, (options && options.headers) || {}, authHeaders());
    let res = await fetchWithTimeout(supaUrl(path), opts);
    if (res.status === 401 && supaSession && supaSession.refreshToken) {
      await refreshSession();
      opts.headers = Object.assign({}, (options && options.headers) || {}, authHeaders());
      res = await fetchWithTimeout(supaUrl(path), opts);
    }
    return res;
  }

  async function restErrorText(res) {
    const body = await readErrorBody(res);
    if (body && body.code === "42P01") {
      return "云端还没有建表：请先在 Supabase SQL Editor 执行 supabase/schema.sql";
    }
    if (body && body.code === "42501") {
      return "没有权限：请确认 schema.sql 里的 RLS 策略已经执行";
    }
    const detail =
      (body && (body.msg || body.message || body.details || body.hint)) || "";
    if (res.status === 401) return "登录已失效，请重新登录";
    if (res.status === 403) return "没有权限读写自己的数据（检查 RLS 策略）";
    return detail || "HTTP " + res.status;
  }

  async function fetchRemote() {
    const session = await ensureSession();
    const res = await restRequest(
      "/rest/v1/study_state?user_id=eq." +
        encodeURIComponent(session.userId) +
        "&select=data,rev,updated_at",
      { method: "GET" }
    );
    if (!res.ok) throw new Error(await restErrorText(res));
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const row = rows[0];
    return {
      data: row.data && typeof row.data === "object" ? row.data : {},
      rev: Number.isFinite(Number(row.rev)) ? Number(row.rev) : 0,
      updatedAt: row.updated_at || null,
    };
  }

  function uploadTooBig() {
    const size = JSON.stringify(snapshot()).length;
    if (size > 900000) {
      setSyncStatus("error", "数据接近 1 MB 上限，本次没有上传；建议先导出备份并清理旧记录");
      return true;
    }
    return false;
  }

  async function insertRemote() {
    const session = await ensureSession();
    const res = await restRequest("/rest/v1/study_state", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ user_id: session.userId, data: snapshot(), rev: 1 }),
    });
    if (res.status === 409) {
      return { conflict: true, remote: await fetchRemote() };
    }
    if (!res.ok) throw new Error(await restErrorText(res));
    const rows = await res.json();
    return { row: rows && rows[0] ? rows[0] : null };
  }

  async function updateRemote(baseRev) {
    const session = await ensureSession();
    const res = await restRequest(
      "/rest/v1/study_state?user_id=eq." +
        encodeURIComponent(session.userId) +
        "&rev=eq." +
        baseRev,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ data: snapshot(), rev: baseRev + 1 }),
      }
    );
    if (!res.ok) throw new Error(await restErrorText(res));
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : null;
  }

  function markSynced(row) {
    supaMeta.userId = supaSession.userId;
    supaMeta.baseRev = Number(row && row.rev) || Math.max(1, supaMeta.baseRev + 1);
    supaMeta.syncedHash = hashState(snapshot());
    supaMeta.lastSyncAt = Date.now();
    saveSupaMeta();
  }

  /** 云端覆盖本地：只在用户明确选择后调用 */
  function applyRemote(remote, message) {
    const clean = sanitize(remote && remote.data);
    if (!clean) {
      setSyncStatus("error", "云端数据格式不对，没有应用");
      return false;
    }
    suppressAutoSync = true;
    state = clean;
    saveState();
    suppressAutoSync = false;
    supaMeta.baseRev = remote.rev || 0;
    supaMeta.userId = supaSession ? supaSession.userId : supaMeta.userId;
    supaMeta.syncedHash = hashState(snapshot());
    supaMeta.lastSyncAt = Date.now();
    saveSupaMeta();
    seenIds.clear();
    openIds.clear();
    renderAll();
    setSyncStatus("ok", message || "已拉取云端进度 · " + timeLabel(supaMeta.lastSyncAt));
    return true;
  }

  function adoptRemote(remote, message) {
    supaMeta.baseRev = remote.rev || 0;
    supaMeta.userId = supaSession ? supaSession.userId : supaMeta.userId;
    supaMeta.syncedHash = hashState(snapshot());
    supaMeta.lastSyncAt = Date.now();
    saveSupaMeta();
    setSyncStatus("ok", message || "本机与云端一致 · " + timeLabel(supaMeta.lastSyncAt));
  }

  function showConflict(remote, reason) {
    pendingConflict = {
      remote: remote && typeof remote === "object" ? remote : null,
      reason: reason || "云端有更新",
    };
    const stamp =
      remote && remote.updatedAt
        ? timeLabel(new Date(remote.updatedAt).getTime())
        : "未知";
    el.conflictNote.textContent =
      pendingConflict.reason +
      "。云端版本：" +
      stamp +
      "（rev " +
      (remote && remote.rev != null ? remote.rev : "?") +
      "）；本机现在 " +
      state.courses.length +
      " 门课程。请选择保留哪一份，不会自动覆盖。";
    el.conflictTakeRemote.disabled = !(remote && remote.data);
    el.syncConflict.hidden = false;
    setSyncStatus("conflict", "冲突：云端与本机都有改动，等你选择");
  }

  function closeConflict() {
    el.syncConflict.hidden = true;
  }

  function handleSyncError(err, prefix) {
    if (err && err.name === "AbortError") {
      setSyncStatus("error", "同步超时：15 秒内 Supabase 没有响应，记录仍在本机");
    } else if (isNetworkError(err) || !isOnline()) {
      setSyncStatus("error", "离线或连不上 Supabase：记录已保存在本机，联网后自动同步");
    } else {
      setSyncStatus("error", prefix + "：" + String((err && err.message) || err));
    }
  }

  /** 真正写云端；调用方负责 supaBusy 与状态提示 */
  async function uploadSnapshot(baseRev) {
    let result;
    if (!baseRev) {
      result = await insertRemote();
    } else {
      const row = await updateRemote(baseRev);
      result = row ? { row: row } : { conflict: true, remote: await fetchRemote() };
    }

    if (result.conflict) {
      let remote = result.remote;
      if (!remote) {
        // 条件更新 0 行、云端也读不到：那一行被删了，按首次上传重建
        supaMeta.baseRev = 0;
        supaMeta.syncedHash = "";
        saveSupaMeta();
        result = await insertRemote();
        remote = result.conflict ? result.remote : null;
        if (result.row) {
          markSynced(result.row);
          setSyncStatus("ok", "已上传 · " + timeLabel(supaMeta.lastSyncAt));
          return true;
        }
      }
      if (remote) {
        showConflict(remote, "上传被拒绝：云端已被别的设备改过");
      } else {
        setSyncStatus("conflict", "上传冲突，但读不到云端数据；请稍后重试");
      }
      return false;
    }
    if (!result.row) throw new Error("云端没有返回写入结果");

    markSynced(result.row);
    pendingConflict = null;
    setSyncStatus("ok", "已上传 · " + timeLabel(supaMeta.lastSyncAt));
    return true;
  }

  async function pushLocal(baseRev, notify) {
    if (!supaSession || !supaConfigured()) {
      toast("先保存 Supabase 配置并登录");
      return false;
    }
    if (!isOnline()) {
      supaReady = true;
      setSyncStatus("error", "离线：改动已保存在本机，联网后会自动上传");
      if (notify) toast("当前离线，先记在本机");
      return false;
    }
    if (supaBusy) return false;
    if (uploadTooBig()) return false;

    supaBusy = true;
    setSyncStatus("busy", "正在上传…");
    try {
      const ok = await uploadSnapshot(baseRev);
      if (ok && notify) toast("已同步到云端");
      return ok;
    } catch (err) {
      handleSyncError(err, "上传失败");
      return false;
    } finally {
      supaBusy = false;
    }
  }

  /** 登录后 / 恢复登录后的首次核对 */
  async function syncAfterLogin() {
    if (!supaSession || !supaConfigured()) return;
    if (supaBusy) return;
    if (!isOnline()) {
      supaReady = true;
      setSyncStatus("error", "离线：已使用本机缓存，联网后自动同步");
      return;
    }

    supaBusy = true;
    supaReady = false;
    setSyncStatus("busy", "正在检查云端…");
    try {
      if (supaMeta.userId !== supaSession.userId) {
        supaMeta = { userId: supaSession.userId, baseRev: 0, syncedHash: "", lastSyncAt: 0 };
        saveSupaMeta();
      }

      const remote = await fetchRemote();
      if (!remote) {
        if (!hasLocalData()) {
          supaMeta.syncedHash = hashState(snapshot());
          saveSupaMeta();
          setSyncStatus("ok", "云端暂无数据；记下一笔后会自动上传");
        } else {
          await uploadSnapshot(0);
        }
        supaReady = true;
        return;
      }

      const localHash = hashState(snapshot());
      if (supaMeta.baseRev === 0 || !supaMeta.syncedHash) {
        // 这台设备还没参与过云同步：本机空就用云端，否则必须让用户选
        if (!hasLocalData()) {
          applyRemote(remote, "已拉取云端进度");
        } else if (localHash === hashState(remote.data)) {
          adoptRemote(remote, "本机与云端一致");
        } else {
          showConflict(remote, "首次登录：本机与云端都有数据");
        }
      } else if (remote.rev === supaMeta.baseRev) {
        if (localHash !== supaMeta.syncedHash) {
          await uploadSnapshot(supaMeta.baseRev);
        } else {
          setSyncStatus("ok", "已是最新 · " + timeLabel(supaMeta.lastSyncAt));
        }
      } else if (remote.rev > supaMeta.baseRev) {
        if (localHash === supaMeta.syncedHash) {
          applyRemote(remote, "已拉取云端更新");
        } else {
          showConflict(remote, "云端有更新的版本，本机也有未同步的改动");
        }
      } else {
        showConflict(remote, "云端版本比本机记录的还旧（可能被重置过）");
      }
      supaReady = true;
    } catch (err) {
      if (err && (err.status === 400 || err.status === 401)) {
        await logout(false);
        setAuthStatus("error", "登录已过期，请重新登录");
      } else {
        handleSyncError(err, "检查云端失败");
      }
      supaReady = true;
    } finally {
      supaBusy = false;
    }
  }

  async function manualPush() {
    if (!supaSession) {
      toast("先登录才能上传");
      return;
    }
    if (supaBusy) {
      toast("上一个同步请求还没结束，稍等一下");
      return;
    }
    if (!isOnline()) {
      setSyncStatus("error", "离线：记录已在本机，联网后再上传");
      toast("当前离线，先记在本机");
      return;
    }

    supaBusy = true;
    setSyncStatus("busy", "正在检查云端…");
    try {
      const remote = await fetchRemote();
      if (remote && remote.rev !== supaMeta.baseRev) {
        showConflict(remote, "上传前发现云端已更新");
        return;
      }
      if (!remote && supaMeta.baseRev > 0) {
        // 云端那行被删了，退回首次上传
        supaMeta.baseRev = 0;
        supaMeta.syncedHash = "";
        saveSupaMeta();
      }
      if (remote && !localDirty()) {
        setSyncStatus("ok", "已是最新 · " + timeLabel(supaMeta.lastSyncAt));
        toast("云端已经是最新");
        return;
      }
      if (!remote && !hasLocalData()) {
        setSyncStatus("ok", "云端暂无数据；记下一笔后会自动上传");
        toast("本机还没有可上传的记录");
        return;
      }
      if (uploadTooBig()) return;
      const ok = await uploadSnapshot(supaMeta.baseRev);
      if (ok) toast("已同步到云端");
    } catch (err) {
      handleSyncError(err, "上传失败");
    } finally {
      supaBusy = false;
    }
  }

  async function manualPull() {
    if (!supaSession) {
      toast("先登录才能拉取");
      return;
    }
    if (supaBusy) {
      toast("上一个同步请求还没结束，稍等一下");
      return;
    }
    if (!isOnline()) {
      setSyncStatus("error", "离线：本机记录照常可用，联网后再拉取");
      toast("当前离线，拉取失败");
      return;
    }

    supaBusy = true;
    setSyncStatus("busy", "正在拉取云端…");
    try {
      const remote = await fetchRemote();
      if (!remote) {
        setSyncStatus("error", "云端还没有数据：先在这台设备上传一次");
        toast("云端还没有数据");
        return;
      }
      const clean = hashState(snapshot()) === supaMeta.syncedHash;
      if (remote.rev === supaMeta.baseRev && clean) {
        setSyncStatus("ok", "已是最新 · " + timeLabel(supaMeta.lastSyncAt));
        toast("已经是最新，不需要覆盖");
        return;
      }
      if (!clean && hasLocalData()) {
        showConflict(remote, "手动拉取：本机有未同步的改动");
        return;
      }
      if (applyRemote(remote, "已用云端进度覆盖本机")) {
        toast("已用云端进度覆盖本机");
      }
    } catch (err) {
      handleSyncError(err, "拉取失败");
    } finally {
      supaBusy = false;
    }
  }

  function setAuthStatus(kind, text) {
    el.supaAuthStatus.textContent = text;
    el.supaAuthStatus.dataset.state = kind;
  }

  function renderSupaPanel() {
    const configured = supaConfigured();
    const loggedIn = !!(supaSession && configured);
    el.supaConfigBlock.hidden = loggedIn;
    el.supaLoginBlock.hidden = !configured || loggedIn;
    el.supaSessionBlock.hidden = !loggedIn;
    el.supaCfgForget.hidden = !configured || loggedIn;

    if (!loggedIn) {
      el.supaUrl.value = supaCfg.url;
      el.supaKey.value = supaCfg.anonKey;
      setAuthStatus("idle", configured ? "已配置，请登录" : "尚未配置 Supabase");
      return;
    }
    el.supaWho.textContent = supaSession.email || supaSession.userId;
    el.supaAuto.checked = !!supaCfg.auto;
  }

  async function loginWithPassword(email, password) {
    if (!supaConfigured()) {
      setAuthStatus("error", "先保存 Supabase 地址与 anon key");
      toast("先保存连接配置");
      return;
    }
    if (!isOnline()) {
      setAuthStatus("error", "当前离线，登录需要联网");
      toast("当前离线，登录失败");
      return;
    }
    el.supaLoginBtn.disabled = true;
    setAuthStatus("busy", "正在登录…");
    try {
      const body = await supaAuthRequest("/auth/v1/token?grant_type=password", {
        email: email,
        password: password,
      });
      supaSession = sessionFromAuth(body);
      saveStoredJson(SUPA_SESSION_KEY, supaSession);
      el.supaPassword.value = "";
      pendingConflict = null;
      renderSupaPanel();
      setSyncStatus("busy", "已登录，正在检查云端…");
      await syncAfterLogin();
      toast("登录成功");
    } catch (err) {
      setAuthStatus("error", String((err && err.message) || err));
      toast("登录失败");
    } finally {
      el.supaLoginBtn.disabled = false;
    }
  }

  async function logout(showToast) {
    const old = supaSession;
    clearTimeout(autoSyncTimer);
    supaSession = null;
    supaReady = false;
    pendingConflict = null;
    try {
      localStorage.removeItem(SUPA_SESSION_KEY);
    } catch (err) {
      console.warn("清除登录态失败", err);
    }
    if (old && supaConfigured() && isOnline()) {
      // 尽力注销云端会话；失败不影响本地退出
      fetchWithTimeout(supaUrl("/auth/v1/logout"), {
        method: "POST",
        headers: {
          apikey: supaCfg.anonKey,
          Authorization: "Bearer " + old.accessToken,
        },
      }).catch(function () {});
    }
    renderSupaPanel();
    setAuthStatus("idle", "已退出登录，本机记录仍在");
    if (showToast) toast("已退出登录，本机数据没有删除");
  }

  async function saveSupaConfig() {
    const url = normalizeSupaUrl(el.supaUrl.value);
    const key = String(el.supaKey.value || "").trim();
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch (err) {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      toast("Supabase 地址格式不对，应形如 https://xxxx.supabase.co");
      el.supaUrl.focus();
      return;
    }
    if (
      parsed.protocol === "http:" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1"
    ) {
      toast("线上站点请使用 https:// 的 Supabase 地址");
      return;
    }
    if (!key || /\s/.test(key) || key.length < 20) {
      toast("anon key 看起来不完整，请从 Supabase 控制台整段复制");
      el.supaKey.focus();
      return;
    }

    const changed = url !== supaCfg.url || key !== supaCfg.anonKey;
    if (changed && supaSession) {
      await logout(false);
      supaMeta = { userId: "", baseRev: 0, syncedHash: "", lastSyncAt: 0 };
      saveSupaMeta();
    }
    supaCfg = { url: url, anonKey: key, auto: supaCfg.auto };
    saveSupaCfg();
    el.supaUrl.value = url;
    renderSupaPanel();
    setAuthStatus("idle", "配置已保存，请登录");
    toast("连接配置已保存，请登录");
  }

  async function forgetSupaConfig() {
    if (
      !confirm(
        "清除本机的 Supabase 连接配置与登录态？云端数据和本机进度都不会删除。"
      )
    ) {
      return;
    }
    await logout(false);
    supaCfg = { url: "", anonKey: "", auto: true };
    saveSupaCfg();
    supaMeta = { userId: "", baseRev: 0, syncedHash: "", lastSyncAt: 0 };
    saveSupaMeta();
    el.supaUrl.value = "";
    el.supaKey.value = "";
    renderSupaPanel();
    toast("已清除本机连接配置，进度仍在本机");
  }

  async function restoreSession() {
    if (!supaSession || !supaConfigured()) return;
    if (supaBusy) return;
    if (!isOnline()) {
      supaReady = true;
      setSyncStatus("error", "离线：已使用本机缓存；联网后自动续期并同步");
      return;
    }
    try {
      if (supaSession.expiresAt && Date.now() > supaSession.expiresAt - 120000) {
        await refreshSession();
      }
      await syncAfterLogin();
    } catch (err) {
      if (err && (err.status === 400 || err.status === 401)) {
        await logout(false);
        setAuthStatus("error", "登录已过期，请重新登录");
      } else {
        handleSyncError(err, "恢复登录失败");
        supaReady = true;
      }
    }
  }

  function scheduleAutoSync() {
    if (!supaCfg || suppressAutoSync || !supaSession || !supaCfg.auto || !supaReady) {
      return;
    }
    if (pendingConflict) return; // 冲突没解决前不再自动上传
    if (!isOnline()) {
      setSyncStatus("error", "离线：改动已保存在本机，联网后自动同步");
      return;
    }
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(function () {
      if (
        !supaSession ||
        !supaCfg.auto ||
        supaBusy ||
        pendingConflict ||
        !supaReady
      ) {
        return;
      }
      pushLocal(supaMeta.baseRev, false);
    }, SYNC_DEBOUNCE);
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
    el.supaSyncStatus.textContent = text;
    el.supaSyncStatus.dataset.state = kind;
  }

  function initSupa() {
    supaCfg = loadSupaCfg();
    supaSession = loadSupaSession();
    supaMeta = loadSupaMeta();
    renderSupaPanel();

    if (supaSession && supaConfigured()) {
      el.supaWho.textContent = supaSession.email || supaSession.userId;
      if (supaMeta.lastSyncAt) {
        setSyncStatus("ok", "上次同步：" + timeLabel(supaMeta.lastSyncAt));
      } else {
        setSyncStatus("busy", "已登录，正在同步…");
      }
      restoreSession();
    } else if (supaSession) {
      // 配置被清掉但还留着 token：token 已经没用了
      supaSession = null;
      try {
        localStorage.removeItem(SUPA_SESSION_KEY);
      } catch (err) {}
      setSyncStatus("idle", "尚未配置");
    }
  }

  window.addEventListener("online", function () {
    if (!supaSession) return;
    supaReady = false;
    setSyncStatus("busy", "网络已恢复，正在同步…");
    if (supaBusy) {
      setTimeout(function () {
        if (!supaBusy) restoreSession();
      }, 1000);
      return;
    }
    restoreSession();
  });

  window.addEventListener("offline", function () {
    if (!supaSession) return;
    setSyncStatus("error", "离线：记录照常保存在本机，联网后自动同步");
  });

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

  // ---------- 云同步事件（Supabase） ----------

  el.supaKeyToggle.addEventListener("click", function () {
    const shown = el.supaKey.type === "text";
    el.supaKey.type = shown ? "password" : "text";
    el.supaKeyToggle.textContent = shown ? "显示" : "隐藏";
    el.supaKeyToggle.setAttribute("aria-pressed", String(!shown));
  });

  el.supaCfgSave.addEventListener("click", saveSupaConfig);
  el.supaCfgForget.addEventListener("click", forgetSupaConfig);

  el.supaLoginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    const email = el.supaEmail.value.trim();
    const password = el.supaPassword.value;
    if (!email) {
      setAuthStatus("error", "先填邮箱");
      el.supaEmail.focus();
      return;
    }
    if (!password) {
      setAuthStatus("error", "先填密码");
      el.supaPassword.focus();
      return;
    }
    loginWithPassword(email, password);
  });

  el.supaAuto.addEventListener("change", function () {
    supaCfg.auto = el.supaAuto.checked;
    saveSupaCfg();
    if (!supaCfg.auto) {
      clearTimeout(autoSyncTimer);
      setSyncStatus("idle", "自动同步已关闭；改动只保存在本机");
      toast("已关闭自动同步");
    } else {
      toast("已开启自动同步");
      if (supaReady) syncAfterLogin();
    }
  });

  el.supaPushBtn.addEventListener("click", manualPush);
  el.supaPullBtn.addEventListener("click", manualPull);
  el.supaLogoutBtn.addEventListener("click", function () {
    if (!confirm("退出登录？本机进度不会删除，云端数据也不会动。")) return;
    logout(true);
  });

  el.conflictTakeRemote.addEventListener("click", function () {
    if (!pendingConflict || !pendingConflict.remote) return;
    const remote = pendingConflict.remote;
    closeConflict();
    pendingConflict = null;
    if (applyRemote(remote, "已用云端覆盖本地")) {
      toast("已用云端覆盖本地");
    }
  });

  el.conflictPushLocal.addEventListener("click", function () {
    if (!pendingConflict) return;
    const base = pendingConflict.remote ? pendingConflict.remote.rev : supaMeta.baseRev;
    closeConflict();
    pendingConflict = null;
    toast("正在用本地覆盖云端…");
    pushLocal(base, true);
  });

  el.conflictCancel.addEventListener("click", function () {
    // 保留 pendingConflict：自动上传继续被挡住，直到用户明确选一份
    closeConflict();
    setSyncStatus("conflict", "冲突未解决：云端与本机各自保留，手动同步时会再次提示");
    toast("已暂时搁置冲突，自动同步暂停");
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

    // 只替换上一次的示例课程，自己登记的课程保留
    state.courses = state.courses.filter(function (c) {
      return !c.demo;
    });

    state.courses.push(
      { id: makeId(), name: "C 语言程序设计", lessons: cLessons, demo: true },
      { id: makeId(), name: "大学计算机基础", lessons: bLessons, demo: true }
    );

    // 先扣掉上一次的示例打卡，再写入新的，避免重复叠加
    subtractDemoActivity();
    const demo = {};
    [7, 6, 5, 3, 2, 1].forEach(function (back, idx) {
      const key = dateKey(addDays(today, -back));
      const min = [45, 90, 20, 60, 30, 120][idx];
      demo[key] = min;
      state.activity[key] = (state.activity[key] || 0) + min;
    });
    state.demoActivity = demo;

    saveState();
    seenIds.clear();
    openIds.clear();
    renderAll();
    toast("已填入示例课程（带「示例」标记），随时可以一键清除");
  });

  // ---------- 导入导出 ----------

  el.exportBtn.addEventListener("click", function () {
    if (state.courses.length === 0 && Object.keys(state.activity).length === 0) {
      toast("还没有数据可以导出");
      return;
    }
    const payload = JSON.stringify(
      {
        v: 2,
        exportedAt: new Date().toISOString(),
        courses: state.courses,
        activity: state.activity,
        demoActivity: state.demoActivity,
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
    if (
      state.courses.length === 0 &&
      Object.keys(state.activity).length === 0
    ) {
      toast("现在就是空的，不用清");
      return;
    }
    if (
      !confirm(
        "清空所有课程和打卡记录？课程、每节已看时长、日历打卡会一起清除，且不可撤销。建议先导出备份。"
      )
    ) {
      return;
    }
    state = emptyState();
    saveState();
    seenIds.clear();
    openIds.clear();
    renderAll();
    toast("已清空课程和打卡，本子重新开张");
  });

  el.demoClearBtn.addEventListener("click", clearDemoData);
  el.resetActivityBtn.addEventListener("click", resetActivity);
  el.heatResetBtn.addEventListener("click", resetActivity);

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
  initSupa();

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
