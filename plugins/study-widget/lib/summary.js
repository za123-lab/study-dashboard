/**
 * 把整份进度快照（study_state.data，结构与网页端 study-log-v1 相同）
 * 压缩成小组件/面板一次渲染所需的全部字段。
 *
 * 所有数字口径来自 lib/stats.js，与网页端 app.js 保持一致。
 */
import {
  TODO_CATS,
  TODO_PRI,
  WEEK_CN,
  addDays,
  checkinCadenceText,
  checkinCycle,
  courseStats,
  dateKey,
  dayStats,
  fmtDur,
  fmtTodoDue,
  lessonPct,
  minuteLevel,
  overallStats,
  sortedTodos,
  streakDays,
  sumActivity,
  todoCounts,
  todoDeadline,
  todoLeftText,
  todoUrgency,
} from "./stats.js";

const HEAT_DAYS = 70; // 10 周 × 7 天

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function text(v, max) {
  const s = String(v == null ? "" : v);
  return max && s.length > max ? s.slice(0, max) : s;
}

/** 兼容旧快照：缺失字段补默认值，过滤掉坏数据 */
export function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const courses = (Array.isArray(s.courses) ? s.courses : [])
    .filter(function (c) {
      return c && typeof c === "object";
    })
    .map(function (c) {
      return {
        id: text(c.id),
        name: text(c.name, 60) || "未命名课程",
        source: c.source || "",
        bvid: c.bvid || "",
        videoTitle: text(c.videoTitle, 120),
        lessons: (Array.isArray(c.lessons) ? c.lessons : [])
          .filter(function (l) {
            return l && typeof l === "object";
          })
          .map(function (l, i) {
            return {
              id: text(l.id) || "l" + i,
              title: text(l.title, 120) || "第 " + (i + 1) + " 节",
              totalMin: Math.max(0, num(l.totalMin)),
              watchedMin: Math.max(0, num(l.watchedMin)),
              page: l.page || "",
              url: l.url || "",
            };
          }),
      };
    });
  const activity = {};
  Object.keys(s.activity && typeof s.activity === "object" ? s.activity : {}).forEach(function (k) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k)) activity[k] = Math.max(0, Math.round(num(s.activity[k])));
  });
  const todos = (Array.isArray(s.todos) ? s.todos : [])
    .filter(function (t) {
      return t && typeof t === "object" && t.title;
    })
    .map(function (t, i) {
      return {
        id: text(t.id) || "t" + i,
        title: text(t.title, 200),
        cat: TODO_CATS[t.cat] ? t.cat : "other",
        pri: TODO_PRI.indexOf(t.pri) >= 0 ? t.pri : "P2",
        due: /^\d{4}-\d{2}-\d{2}$/.test(t.due || "") ? t.due : "",
        dueTime: t.dueTime || "",
        dueNote: text(t.dueNote, 120),
        note: text(t.note, 400),
        link: t.link || "",
        done: !!t.done,
        doneAt: num(t.doneAt),
      };
    });
  const checkins = (Array.isArray(s.checkins) ? s.checkins : [])
    .filter(function (c) {
      return c && typeof c === "object" && c.name;
    })
    .map(function (c, i) {
      return {
        id: text(c.id) || "c" + i,
        name: text(c.name, 60),
        kind: c.kind === "video" ? "video" : "custom",
        cadence: c.cadence === "weekly" || c.cadence === "interval" ? c.cadence : "daily",
        intervalDays: Math.max(1, Math.round(num(c.intervalDays) || 1)),
        courseId: text(c.courseId),
        logs: (Array.isArray(c.logs) ? c.logs : [])
          .filter(function (l) {
            return l && /^\d{4}-\d{2}-\d{2}$/.test(l.date || "");
          })
          .map(function (l) {
            return { date: l.date, at: num(l.at), min: num(l.min) };
          }),
      };
    });
  return {
    schemaVersion: num(s.schemaVersion),
    courses,
    activity,
    todos,
    checkins,
  };
}

function heatmap(activity, now) {
  // 今天是周日时，本周从周一开始，保证最后一列是本周
  const offset = (now.getDay() + 6) % 7;
  const start = addDays(now, -offset - (Math.ceil(HEAT_DAYS / 7) - 1) * 7);
  const cells = [];
  for (let i = 0; i < Math.ceil(HEAT_DAYS / 7) * 7; i++) {
    const d = addDays(start, i);
    const key = dateKey(d);
    if (d > now) {
      cells.push({ key, min: null });
      continue;
    }
    const min = activity[key] || 0;
    cells.push({ key, min, level: minuteLevel(min) });
  }
  return {
    cols: Math.ceil(HEAT_DAYS / 7),
    cells,
  };
}

function recentDays(activity, now, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = addDays(now, -i);
    const key = dateKey(d);
    out.push({ key, label: String(d.getDate()), min: activity[key] || 0, level: minuteLevel(activity[key] || 0) });
  }
  return out;
}

/**
 * @param {object} raw study_state.data
 * @param {object} opts { now?: Date, source?: string, syncedAt?: number, rev?: number, email?: string }
 */
export function buildSummary(raw, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const state = normalizeState(raw);
  const today = dateKey(now);
  const overall = overallStats(state.courses);

  const courses = state.courses.map(function (c) {
    const st = courseStats(c);
    const lessons = c.lessons.map(function (l) {
      const pct = lessonPct(l);
      return {
        id: l.id,
        title: l.title,
        totalMin: l.totalMin,
        watchedMin: Math.min(l.watchedMin, l.totalMin || l.watchedMin),
        totalText: l.totalMin ? fmtDur(l.totalMin) : "—",
        watchedText: fmtDur(l.watchedMin),
        pct,
        done: l.totalMin > 0 ? l.watchedMin >= l.totalMin : false,
        url: l.url,
      };
    });
    return {
      id: c.id,
      name: c.name,
      source: c.source,
      bvid: c.bvid,
      videoTitle: c.videoTitle,
      stats: {
        pct: st.pct,
        doneLessons: st.doneLessons,
        count: st.count,
        totalText: fmtDur(st.totalMin),
        watchedText: fmtDur(st.watchedMin),
        remainingText: fmtDur(Math.max(0, st.totalMin - st.watchedMin)),
      },
      lessons,
    };
  });

  const todayMin = state.activity[today] || 0;
  const totalMin = sumActivity(state.activity);
  const streak = streakDays(state.activity, now);
  const ds = dayStats(state, today);

  const counts = todoCounts(state.todos, now);
  const sorted = sortedTodos(state.todos);
  const open = sorted.filter(function (t) {
    return !t.done;
  });
  const decorate = function (t) {
    return {
      id: t.id,
      title: t.title,
      cat: t.cat,
      catLabel: TODO_CATS[t.cat],
      pri: t.pri,
      due: t.due,
      dueLabel: fmtTodoDue(t),
      left: todoLeftText(t, now.getTime()),
      urgency: todoUrgency(t, now.getTime()),
      deadline: todoDeadline(t),
      done: t.done,
      link: t.link,
      note: t.note,
    };
  };
  const bucket = function (u) {
    return open.filter(function (t) {
      return todoUrgency(t, now.getTime()) === u;
    });
  };
  const todayList = open
    .filter(function (t) {
      const u = todoUrgency(t, now.getTime());
      return u === "overdue" || t.due === today;
    })
    .slice(0, 6)
    .map(decorate);

  const doneToday = state.todos.filter(function (t) {
    return t.done && t.doneAt && dateKey(new Date(t.doneAt)) === today;
  }).length;

  const checkins = state.checkins.map(function (c) {
    const cyc = checkinCycle(c, now);
    const course = state.courses.find(function (x) {
      return x.id === c.courseId;
    });
    const todayLogs = c.logs.filter(function (l) {
      return l.date === today;
    });
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      cadenceLabel: checkinCadenceText(c),
      courseName: course ? course.name : "",
      done: cyc.done,
      due: cyc.due,
      status: cyc.status,
      todayMin: todayLogs.reduce(function (a, l) {
        return a + (l.min || 0);
      }, 0),
      totalLogs: c.logs.length,
    };
  });
  const checkinToday = state.checkins.reduce(function (a, c) {
    return (
      a +
      c.logs.filter(function (l) {
        return l.date === today;
      }).length
    );
  }, 0);

  const next = open
    .filter(function (t) {
      return todoDeadline(t) != null;
    })
    .sort(function (a, b) {
      return todoDeadline(a) - todoDeadline(b);
    })[0];

  const last7 = recentDays(state.activity, now, 7);
  const avg7 = Math.round(
    last7.reduce(function (a, d) {
      return a + d.min;
    }, 0) / 7
  );

  return {
    app: "学业工作台",
    generatedAt: now.getTime(),
    date: {
      today,
      label: today + " " + WEEK_CN[now.getDay()],
      weekday: WEEK_CN[now.getDay()],
    },
    source: o.source || "unknown",
    syncedAt: o.syncedAt || 0,
    rev: o.rev || 0,
    email: o.email || "",
    overall: {
      pct: overall.pct,
      doneLessons: overall.doneLessons,
      count: overall.count,
      totalText: fmtDur(overall.totalMin),
      watchedText: fmtDur(overall.watchedMin),
      remainingText: fmtDur(Math.max(0, overall.totalMin - overall.watchedMin)),
      totalMin: overall.totalMin,
      watchedMin: overall.watchedMin,
    },
    today: {
      date: today,
      min: todayMin,
      minText: fmtDur(todayMin),
      streak,
      todosDone: doneToday,
      todosOpen: open.length,
      checkins: checkinToday,
      checkinsTotal: state.checkins.length,
      todos: todayList,
      next: next ? decorate(next) : null,
      minutes7: avg7,
    },
    counts,
    todos: {
      open: open.length,
      done: state.todos.length - open.length,
      overdue: bucket("overdue").map(decorate),
      soon: bucket("soon").map(decorate),
      week: bucket("week").map(decorate),
      later: open
        .filter(function (t) {
          const u = todoUrgency(t, now.getTime());
          return u === "" || u === "no-deadline";
        })
        .slice(0, 8)
        .map(decorate),
      doneToday: state.todos
        .filter(function (t) {
          return t.done && t.doneAt && dateKey(new Date(t.doneAt)) === today;
        })
        .slice(0, 5)
        .map(decorate),
    },
    courses,
    checkins,
    heat: heatmap(state.activity, now),
    week: last7,
    totals: {
      activityMin: totalMin,
      activityText: fmtDur(totalMin),
      courses: state.courses.length,
      lessons: overall.count,
    },
  };
}
