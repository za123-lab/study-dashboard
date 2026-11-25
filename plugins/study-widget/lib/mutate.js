/**
 * 写入：待办勾选 / 取消，循环打卡 / 取消打卡。
 *
 * 数据口径与网页端 app.js 完全一致：
 *   - 待办勾选：todo.done = checked；todo.doneAt = checked ? Date.now() : null
 *   - 打卡：往 checkin.logs 里 push { date: "YYYY-MM-DD", at: Date.now() }，
 *     视频打卡额外带 min（>0 才写，与 app.js 的 addCheckinLog 同规则）
 *   - 取消打卡：把 date 等于今天的那些 log 删掉
 *   - 追加打卡（/api/checkin/log）：每次都 push 一条独立 log，带 cid/lid/idx/min；
 *     同时把分钟数累加到 activity[today]、合并进 details[today]、并推进该节 watchedMin。
 *     与 app.js recordDetail / addCheckinLog 的写法一致，网页端与小程序都能读懂。
 *
 * 写入策略（乐观锁 + 自动重试）：
 *   1. 先读一次云端，拿到最新 { data, rev }
 *   2. 在原始 data 的深拷贝上改（注意：不经过 normalizeState，
 *      否则会把网页端存的其它字段一起冲掉）
 *   3. PATCH 带 rev=eq.<baseRev>
 *   4. 冲突（云端 rev 已变）→ 用服务端回传的最新数据再改一次，最多重试 MAX_RETRY 次
 *
 * 只在数据源是 supabase 时允许写入；本地文件 / 缓存一律拒绝，
 * 避免"看起来成功了，其实云端没变"。
 */
import { buildSummary } from "./summary.js";

/** 冲突重试上限：第一次 + 最多 2 次重试 */
const MAX_RETRY = 2;
/** 与 app.js addCheckinLog 一致：logs 上限 1000 条 */
const MAX_LOGS = 1000;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 本地日期键 YYYY-MM-DD（与网页端 dateKey/todayKey 同口径，按本机时区） */
export function todayKey(now) {
  const d = now instanceof Date ? now : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

/** 深拷贝：写入前必须脱离原对象，避免中途失败把缓存里的数据也改脏了 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 待办勾选：按 id 找到待办，翻转 done。
 * @returns {object} 被修改的待办（原始对象，已就地更新）
 */
function applyTodoToggle(data, id, checked) {
  const todos = asArray(data.todos);
  const todo = todos.filter(function (t) {
    return t && t.id === id;
  })[0];
  if (!todo) throw fail("TODO_NOT_FOUND", "找不到这条待办（可能已在网页端删掉，刷新一下）");
  const want = typeof checked === "boolean" ? checked : !todo.done;
  todo.done = want;
  todo.doneAt = want ? Date.now() : null;
  return todo;
}

/**
 * 追加一次打卡（可一天多次）。
 *
 * 每次调用都写一条独立 log —— 不合并，这样「今天第几次打卡、每次看了多少」是可追溯的。
 * 视频打卡同时推进课时进度，口径与 app.js recordDetail / addCheckinLog 一致：
 *   1. activity[today] += min
 *   2. details[today] 里同 cid+lid 合并累加（网页端「当天明细」就是这么存的）
 *   3. lesson.watchedMin += min，并封顶到 totalMin（totalMin 为 0 时封顶 9999）
 *
 * @param {object} data 原始 state.data 的深拷贝
 * @param {string} id 循环打卡项 id
 * @param {object} opts { min?, cid?, lid?, note? }
 */
function applyCheckinLog(data, id, options) {
  const opts = options || {};
  const today = todayKey();
  const checkins = asArray(data.checkins);
  const item = checkins.filter(function (c) {
    return c && c.id === id;
  })[0];
  if (!item) throw fail("CHECKIN_NOT_FOUND", "找不到这个打卡项（可能已在网页端删掉，刷新一下）");
  if (!Array.isArray(item.logs)) item.logs = [];

  const min = Math.round(Number(opts.min));
  const hasMin = Number.isFinite(min) && min > 0;

  // 视频打卡必须带有效分钟数与课时定位，否则会写出一条"看起来打了卡但进度没动"的记录
  if (item.kind === "video" && !hasMin) {
    throw fail("MIN_REQUIRED", "视频打卡需要填写本次学习的分钟数");
  }

  const cid = opts.cid ? String(opts.cid) : "";
  const lid = opts.lid ? String(opts.lid) : "";
  if (item.kind === "video" && (!cid || !lid)) {
    throw fail("LESSON_REQUIRED", "视频打卡需要指定课程与节次");
  }

  const courses = asArray(data.courses);
  const course = cid
    ? courses.filter(function (c) {
        return c && c.id === cid;
      })[0]
    : null;
  if (item.kind === "video" && !course) {
    throw fail("LESSON_NOT_FOUND", "找不到这门课程（可能已在网页端删掉，刷新一下）");
  }
  const lessons = course && Array.isArray(course.lessons) ? course.lessons : [];
  const lesson = lid
    ? lessons.filter(function (l) {
        return l && l.id === lid;
      })[0]
    : null;
  if (item.kind === "video" && !lesson) {
    throw fail("LESSON_NOT_FOUND", "找不到这一节（可能已在网页端删掉，刷新一下）");
  }

  const idx = lesson ? lessons.indexOf(lesson) + 1 : 0;
  const log = { date: today, at: Date.now() };
  if (hasMin) log.min = min;
  if (cid) log.cid = cid;
  if (lid) log.lid = lid;
  if (idx > 0) log.idx = idx;
  if (opts.note) log.note = String(opts.note).slice(0, 200);

  item.logs.push(log);
  if (item.logs.length > MAX_LOGS) item.logs.splice(0, item.logs.length - MAX_LOGS);

  let lessonBefore = 0;
  let lessonAfter = 0;
  let lessonDone = false;
  if (hasMin) {
    // 1) 当天累计时长
    if (!data.activity || typeof data.activity !== "object") data.activity = {};
    const base = Math.max(0, Math.round(Number(data.activity[today]) || 0));
    data.activity[today] = base + min;

    // 2) 当天明细：同一天同一课时合并累加（网页端 recordDetail 的口径）
    if (lesson) {
      if (!data.details || typeof data.details !== "object") data.details = {};
      const list = Array.isArray(data.details[today]) ? data.details[today] : [];
      let found = null;
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].cid === cid && list[i].lid === lid) {
          found = list[i];
          break;
        }
      }
      if (found) {
        found.min = Math.min(99999, (Number(found.min) || 0) + min);
        found.at = log.at;
        if (!found.idx && idx > 0) found.idx = idx;
      } else {
        list.push({ cid: cid, lid: lid, idx: idx, min: min, at: log.at });
      }
      data.details[today] = list;
    }

    // 3) 推进课时已看时长（封顶 totalMin，未填总时长时封顶 9999）
    if (lesson) {
      lessonBefore = Math.max(0, Math.round(Number(lesson.watchedMin) || 0));
      const total = Math.max(0, Math.round(Number(lesson.totalMin) || 0));
      const cap = total > 0 ? total : 9999;
      lessonAfter = Math.min(cap, lessonBefore + min);
      lesson.watchedMin = lessonAfter;
      lessonDone = total > 0 ? lessonAfter >= total : false;
    }
  }

  return {
    item,
    course,
    lesson,
    idx,
    log,
    min: hasMin ? min : 0,
    todayMin: hasMin ? Math.max(0, Math.round(Number(data.activity[today]) || 0)) : 0,
    lessonBefore,
    lessonAfter,
    lessonDone,
  };
}

/**
 * 去掉某条打卡记录（幂等：找不到就算了）。
 * 只删 log 本身；已经计入的 activity / details / watchedMin 不回滚 ——
 * 与网页端的口径一致（网页端也不支持反算），避免"删一条记录把历史时长改小"。
 */
function applyCheckinLogRemove(data, id, at) {
  const checkins = asArray(data.checkins);
  const item = checkins.filter(function (c) {
    return c && c.id === id;
  })[0];
  if (!item) throw fail("CHECKIN_NOT_FOUND", "找不到这个打卡项（可能已在网页端删掉，刷新一下）");
  if (!Array.isArray(item.logs)) item.logs = [];
  const target = Number(at);
  const before = item.logs.length;
  let removed = null;
  item.logs = item.logs.filter(function (log) {
    if (removed) return true;
    if (log && Number(log.at) === target) {
      removed = log;
      return false;
    }
    return true;
  });
  return { item, removed, before, after: item.logs.length };
}

/**
 * 打卡：以 todayKey 为准。
 * - 未打卡 → 追加一条 log（视频打卡带 min）
 * - 已打卡 → 删掉今天所有 log（支持取消）
 *
 * 与网页端的规则对齐：
 *   custom（普通）类型当天只允许一次，所以"已打卡"就等于"取消"；
 *   video 允许一天多次，这里点一次就记一次，要撤销时同样按"今天已打过卡"整体删。
 */
function applyCheckinToggle(data, id, options) {
  const opts = options || {};
  const today = todayKey();
  const checkins = asArray(data.checkins);
  const item = checkins.filter(function (c) {
    return c && c.id === id;
  })[0];
  if (!item) throw fail("CHECKIN_NOT_FOUND", "找不到这个打卡项（可能已在网页端删掉，刷新一下）");
  if (!Array.isArray(item.logs)) item.logs = [];

  const todays = item.logs.filter(function (log) {
    return log && log.date === today;
  });

  if (todays.length > 0) {
    // 取消：移除今天的记录
    item.logs = item.logs.filter(function (log) {
      return !(log && log.date === today);
    });
    return { item: item, action: "uncheckin", removed: todays.length };
  }

  // 打卡：按 app.js addCheckinLog 的字段规则组装
  const log = { date: today, at: Date.now() };
  if (item.kind === "video") {
    const min = Math.round(Number(opts.min));
    if (!Number.isFinite(min) || min <= 0) {
      throw fail("MIN_REQUIRED", "视频打卡需要填写本次学习的分钟数");
    }
    log.min = min;
  }
  if (opts.note) log.note = String(opts.note).slice(0, 400);
  item.logs.push(log);
  if (item.logs.length > MAX_LOGS) item.logs.splice(0, item.logs.length - MAX_LOGS);
  return { item: item, action: "checkin", log: log };
}

/**
 * 建一个写入器。
 * @param {object} source StudySource 实例（提供 read()）
 * @param {object} [opts] { now?: () => Date }
 */
export function createMutator(source, opts) {
  const o = opts || {};

  /** 读一次云端最新数据；本地文件 / 缓存来源直接拒绝写入 */
  async function readForWrite() {
    const row = await source.read({});
    if (!row) throw fail("NO_DATA", "没有读到数据，无法写入");
    if (row.source !== "supabase") {
      throw fail(
        "READ_ONLY_SOURCE",
        "当前数据来自" + (row.source === "file" ? "本地文件" : "缓存") + "，不能写回云端。请先到设置页连上 Supabase。"
      );
    }
    if (!Number.isFinite(Number(row.rev)) || Number(row.rev) <= 0) {
      throw fail("NO_REV", "云端数据缺少版本号，无法安全写入");
    }
    return row;
  }

  /**
   * 通用写入骨架：改 → 写 → 冲突就基于服务端最新数据重来。
   * @param {function} mutateFn (data) => result  在深拷贝上就地修改
   */
  async function writeThrough(mutateFn) {
    let row = await readForWrite();
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
      const data = clone(row.data);
      let result;
      try {
        result = mutateFn(data);
      } catch (err) {
        throw err; // 业务错误（找不到条目 / 缺 min）直接抛出，不重试
      }
      const client = source.getClient ? source.getClient(await source.loadCredentials()) : null;
      if (!client || typeof client.patchState !== "function") {
        throw fail("NO_CLIENT", "Supabase 客户端不可用，无法写入");
      }
      const res = await client.patchState(row.rev, data);
      if (res && res.ok) {
        // 写成功后同步本地缓存，避免下一次读拿到旧 rev
        source.cache = {
          data: data,
          rev: Number(res.row && res.row.rev) || Number(row.rev) + 1,
          updatedAt: (res.row && res.row.updated_at) || new Date().toISOString(),
          source: "supabase",
          email: row.email,
          fetchedAt: Date.now(),
        };
        return { result: result, data: data, rev: source.cache.rev };
      }
      if (res && res.conflict) {
        // 云端被别处改过：拿最新数据再来一轮
        lastError = fail("CONFLICT", "云端数据刚被别处改过");
        if (res.remote && res.remote.data) {
          row = { data: res.remote.data, rev: res.remote.rev, email: row.email, source: "supabase" };
          continue;
        }
        // 服务端没给最新数据：重新读一次
        row = await readForWrite();
        continue;
      }
      throw fail("WRITE_FAILED", (res && res.error) || "写入失败");
    }
    throw lastError || fail("CONFLICT", "多次冲突后仍未能写入，请刷新后重试");
  }

  /** 勾选 / 取消勾选一条待办 */
  async function toggleTodo(id, checked) {
    if (!id) throw fail("BAD_ID", "缺少待办 id");
    const out = await writeThrough(function (data) {
      return applyTodoToggle(data, String(id), checked);
    });
    return {
      ok: true,
      action: out.result.done ? "done" : "undone",
      todo: { id: out.result.id, done: out.result.done, doneAt: out.result.doneAt },
      rev: out.rev,
    };
  }

  /** 打卡 / 取消打卡一个循环项 */
  async function toggleCheckin(id, options) {
    if (!id) throw fail("BAD_ID", "缺少打卡项 id");
    const out = await writeThrough(function (data) {
      return applyCheckinToggle(data, String(id), options);
    });
    return {
      ok: true,
      action: out.result.action,
      checkin: {
        id: out.result.item.id,
        name: out.result.item.name,
        logs: asArray(out.result.item.logs).length,
        todays: asArray(out.result.item.logs).filter(function (log) {
          return log && log.date === todayKey();
        }).length,
      },
      rev: out.rev,
    };
  }

  /** 写完之后重建一份 summary，供界面直接替换 */
  function summarize(row) {
    return buildSummary(row.data, {
      source: row.source,
      rev: row.rev,
      email: row.email,
      syncedAt: row.fetchedAt || Date.now(),
      now: o.now ? o.now() : new Date(),
    });
  }

  /** 追加一次打卡（一天可多次），每次一条独立记录 */
  async function logCheckin(id, options) {
    if (!id) throw fail("BAD_ID", "缺少打卡项 id");
    const out = await writeThrough(function (data) {
      return applyCheckinLog(data, String(id), options);
    });
    const r = out.result;
    return {
      ok: true,
      action: "checkin",
      checkin: {
        id: r.item.id,
        name: r.item.name,
        idx: r.idx,
        lessonId: r.lesson ? r.lesson.id : "",
        lessonTitle: r.lesson ? r.lesson.title : "",
        min: r.min,
        todayMin: r.todayMin,
        lessonBefore: r.lessonBefore,
        lessonAfter: r.lessonAfter,
        lessonDone: r.lessonDone,
        todays: asArray(r.item.logs).filter(function (log) {
          return log && log.date === todayKey();
        }).length,
      },
      rev: out.rev,
    };
  }

  /** 撤销某一条打卡记录（按 at 时间戳定位） */
  async function removeCheckinLog(id, at) {
    if (!id) throw fail("BAD_ID", "缺少打卡项 id");
    const out = await writeThrough(function (data) {
      return applyCheckinLogRemove(data, String(id), at);
    });
    return {
      ok: true,
      action: "unlog",
      removed: !!out.result.removed,
      checkin: { id: out.result.item.id, name: out.result.item.name, logs: out.result.after },
      rev: out.rev,
    };
  }

  return { toggleTodo, toggleCheckin, logCheckin, removeCheckinLog, summarize };
}
