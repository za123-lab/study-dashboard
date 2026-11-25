/**
 * 统计口径 —— 逐条复刻网页端 app.js 的实现，供桌面小组件与侧栏面板共用。
 *
 * 对照来源（改网页端统计时请同步这里）：
 *   app.js:123  fmtDur
 *   app.js:150  lessonPct
 *   app.js:157  courseStats
 *   app.js:185  overallStats
 *   app.js:210  dateKey / addDays
 *   app.js:1524 todoDeadline / todoUrgency / todoLeftText
 *   app.js:1603 sortedTodos
 *   app.js:1617 todoCounts
 *   app.js:2042 checkinKeyToDate / checkinWeekStartKey / checkinLastLog / checkinCycle
 *   app.js:2913 renderStreak
 *   app.js:1194 dayStats
 */

export const SCHEMA_VERSION = 4;
export const TODO_CATS = {
  study: "学业课程",
  contest: "学科竞赛",
  event: "文体活动",
  other: "其他",
};
export const TODO_PRI = ["P0", "P1", "P2"];
export const WEEK_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

const DAY_MS = 24 * 3600 * 1000;

function pad(n) {
  return (n < 10 ? "0" : "") + n;
}

/** 分钟数 → "时:分"（与 app.js:123 一致） */
export function fmtDur(min) {
  const m = Math.max(0, Math.round(min || 0));
  return Math.floor(m / 60) + ":" + pad(m % 60);
}

/** 单节百分比，总时长为 0 时返回 null */
export function lessonPct(lesson) {
  if (!lesson.totalMin) return null;
  const watched = Math.min(lesson.watchedMin || 0, lesson.totalMin);
  return Math.round((watched / lesson.totalMin) * 100);
}

/** 课程汇总：按时长加权，只统计 totalMin > 0 的课时 */
export function courseStats(course) {
  let totalMin = 0;
  let watchedMin = 0;
  let doneLessons = 0;
  let invalid = 0;
  const lessons = Array.isArray(course.lessons) ? course.lessons : [];
  lessons.forEach(function (l) {
    if (l.totalMin > 0) {
      totalMin += l.totalMin;
      const w = Math.min(l.watchedMin || 0, l.totalMin);
      watchedMin += w;
      if (w >= l.totalMin) doneLessons++;
    } else {
      invalid++;
    }
  });
  return {
    totalMin,
    watchedMin,
    doneLessons,
    invalid,
    count: lessons.length,
    pct: totalMin ? Math.round((watchedMin / totalMin) * 100) : 0,
  };
}

export function overallStats(courses) {
  const out = { totalMin: 0, watchedMin: 0, doneLessons: 0, count: 0, invalid: 0, pct: 0 };
  (courses || []).forEach(function (c) {
    const s = courseStats(c);
    out.totalMin += s.totalMin;
    out.watchedMin += s.watchedMin;
    out.doneLessons += s.doneLessons;
    out.count += s.count;
    out.invalid += s.invalid;
  });
  out.pct = out.totalMin ? Math.round((out.watchedMin / out.totalMin) * 100) : 0;
  return out;
}

export function dateKey(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

export function todayKey(now) {
  return dateKey(now || new Date());
}

export function addDays(d, n) {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  copy.setDate(copy.getDate() + n);
  return copy;
}

export function keyToDate(key) {
  const parts = String(key).split("-");
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

// ---------- 待办 ----------

/** 截止时刻：只有日期时按当天 23:59 算，「24:00」也归到当天结束 */
export function todoDeadline(t) {
  if (!t || !t.due) return null;
  const p = String(t.due).split("-");
  let hh = 23;
  let mm = 59;
  if (t.dueTime) {
    const q = String(t.dueTime).split(":");
    const h = parseInt(q[0], 10);
    const m = parseInt(q[1], 10);
    if (h === 24) {
      hh = 23;
      mm = 59;
    } else {
      hh = Number.isFinite(h) ? h : 23;
      mm = Number.isFinite(m) ? m : 59;
    }
  }
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), hh, mm, 0, 0).getTime();
}

/** 逾期 / 24 小时内 / 7 天内 / 无截止，未完成才算 */
export function todoUrgency(t, nowMs) {
  if (!t || t.done) return "";
  const dl = todoDeadline(t);
  if (dl == null) return "no-deadline";
  const now = nowMs == null ? Date.now() : nowMs;
  if (dl < now) return "overdue";
  if (dl - now <= DAY_MS) return "soon";
  if (dl - now <= 7 * DAY_MS) return "week";
  return "";
}

export function todoLeftText(t, nowMs) {
  if (!t || t.done) return "已完成";
  const dl = todoDeadline(t);
  if (dl == null) return "截止待确认";
  const now = nowMs == null ? Date.now() : nowMs;
  const diff = dl - now;
  if (diff < 0) {
    const hours = Math.max(1, Math.ceil(-diff / 3600000));
    if (hours <= 24) return "已逾期 " + hours + " 小时";
    return "已逾期 " + Math.ceil(hours / 24) + " 天";
  }
  const hours = diff / 3600000;
  if (hours <= 24) return "还剩 " + Math.max(1, Math.round(hours)) + " 小时";
  return "还剩 " + Math.ceil(hours / 24) + " 天";
}

export function fmtTodoDue(t) {
  if (!t || !t.due) return (t && t.dueNote) || "截止待确认";
  const p = String(t.due).split("-");
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  const now = new Date();
  let s = Number(p[1]) + " 月 " + Number(p[2]) + " 日";
  if (Number(p[0]) !== now.getFullYear()) s = Number(p[0]) + " 年 " + s;
  s += " " + WEEK_CN[d.getDay()].replace("星期", "周");
  if (t.dueTime) s += " " + t.dueTime;
  return s;
}

export function sortedTodos(todos) {
  return (todos || []).slice().sort(function (a, b) {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (a.done && b.done) return (b.doneAt || 0) - (a.doneAt || 0);
    const da = todoDeadline(a);
    const db = todoDeadline(b);
    if (da == null && db == null) return TODO_PRI.indexOf(a.pri) - TODO_PRI.indexOf(b.pri);
    if (da == null) return 1;
    if (db == null) return -1;
    if (da !== db) return da - db;
    return TODO_PRI.indexOf(a.pri) - TODO_PRI.indexOf(b.pri);
  });
}

export function todoCounts(todos, now) {
  const at = now || new Date();
  const nowMs = at.getTime();
  const today = dateKey(at);
  const weekEnd = dateKey(addDays(at, 6 - at.getDay()));
  let overdue = 0;
  let todayN = 0;
  let week = 0;
  (todos || []).forEach(function (t) {
    if (t.done || !t.due) return;
    const dl = todoDeadline(t);
    if (dl != null && dl < nowMs) overdue++;
    if (t.due === today) todayN++;
    if (t.due >= today && t.due <= weekEnd) week++;
  });
  return { overdue, today: todayN, week };
}

// ---------- 打卡 ----------

export function checkinWeekStartKey(now) {
  const at = now || new Date();
  const offset = (at.getDay() + 6) % 7; // 周一算一周的第一天
  return dateKey(addDays(at, -offset));
}

export function checkinLastLog(item) {
  let last = null;
  (item.logs || []).forEach(function (log) {
    if (!last || log.date > last.date || (log.date === last.date && (log.at || 0) >= (last.at || 0))) {
      last = log;
    }
  });
  return last;
}

/** 当前周期的状态：是否已完成 / 是否到了可打卡的日期 */
export function checkinCycle(item, now) {
  const at = now || new Date();
  const today = dateKey(at);
  const logs = item.logs || [];

  if (item.cadence === "weekly") {
    const start = checkinWeekStartKey(at);
    const done = logs.some(function (log) {
      return log.date >= start && log.date <= today;
    });
    return { done, due: !done, status: done ? "本周已打卡" : "本周待打卡" };
  }

  if (item.cadence === "interval") {
    const last = checkinLastLog(item);
    if (!last) return { done: false, due: true, status: "待首次打卡" };
    const days = Math.max(1, parseInt(item.intervalDays, 10) || 1);
    const next = dateKey(addDays(keyToDate(last.date), days));
    if (today < next) return { done: false, due: false, status: "下次 " + next.slice(5) };
    return { done: false, due: true, status: today === next ? "今天到期" : "已到期 · 今天补上" };
  }

  const done = logs.some(function (log) {
    return log.date === today;
  });
  return { done, due: !done, status: done ? "今天已打卡" : "今天待打卡" };
}

export function checkinCadenceText(item) {
  if (item.cadence === "weekly") return "每周";
  if (item.cadence === "interval") return "每 " + item.intervalDays + " 天";
  return "每天";
}

// ---------- 日历 / 连续天数 ----------

export function streakDays(activity, now) {
  const at = now || new Date();
  let streak = 0;
  let cursor = at;
  if (!activity[dateKey(at)]) cursor = addDays(cursor, -1);
  while (activity[dateKey(cursor)]) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function dayStats(state, key) {
  let done = 0;
  (state.todos || []).forEach(function (t) {
    if (t.done && t.doneAt && dateKey(new Date(t.doneAt)) === key) done++;
  });
  let checkins = 0;
  (state.checkins || []).forEach(function (item) {
    (item.logs || []).forEach(function (log) {
      if (log.date === key) checkins++;
    });
  });
  return { done, checkins };
}

export function sumActivity(activity) {
  let total = 0;
  Object.keys(activity || {}).forEach(function (k) {
    const v = Number(activity[k]);
    if (Number.isFinite(v)) total += v;
  });
  return total;
}

/** 热力图档位（与 app.js:235 minuteLevel 一致：<=0→0，<=15→1，<=45→2，<=90→3，其余→4） */
export function minuteLevel(min) {
  const m = Number(min) || 0;
  if (m <= 0) return 0;
  if (m <= 15) return 1;
  if (m <= 45) return 2;
  if (m <= 90) return 3;
  return 4;
}
