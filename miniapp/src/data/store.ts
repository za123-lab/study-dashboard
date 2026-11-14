import Taro from '@tarojs/taro'
import { addDays, clampInt, dateKey, keyToDate, makeId, todayKey } from './date'
import { sanitize, SCHEMA_VERSION } from './sanitize'
import type { AppState, Checkin, CheckinLog, Course, Lesson, Todo } from './types'
import { TODO_PRI } from './types'

const STORE_KEY = 'study-log-v1'

export function emptyState(): AppState {
  return {
    v: 2,
    schemaVersion: SCHEMA_VERSION,
    courses: [],
    activity: {},
    demoActivity: {},
    details: {},
    demoDetails: {},
    todos: [],
    checkins: [],
    courseOpen: {},
    panelOpen: { sync: false, bili: false },
  }
}

let state: AppState = loadState()

export function loadState(): AppState {
  try {
    const raw = Taro.getStorageSync(STORE_KEY)
    if (!raw) return emptyState()
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return sanitize(parsed) || emptyState()
  } catch (err) {
    console.warn('读取本地数据失败，已重置', err)
    return emptyState()
  }
}

export function getState(): AppState {
  return state
}

/** 重新从存储读取，用于从其他页面返回时刷新 */
export function reload(): AppState {
  state = loadState()
  return state
}

/** 保存钩子：云同步用它标记“有改动待上传” */
const saveHooks: Array<() => void> = []
let silentSave = false

export function onSave(fn: () => void): void {
  saveHooks.push(fn)
}

export function save(): void {
  try {
    Taro.setStorageSync(STORE_KEY, state)
  } catch (err) {
    console.warn('本地保存失败', err)
    Taro.showToast({ title: '本地保存失败', icon: 'none' })
  }
  if (silentSave) return
  saveHooks.forEach(function (fn) {
    try {
      fn()
    } catch (err) {
      // 钩子异常不能影响本地落盘
    }
  })
}

/** 用云端数据整体覆盖本机；这条路径不再触发上传 */
export function applyRemote(raw: unknown): boolean {
  silentSave = true
  const ok = replaceState(raw)
  silentSave = false
  return ok
}

/** 改状态并落盘，返回被调用函数的结果 */
export function commit<T>(fn: (draft: AppState) => T): T {
  const result = fn(state)
  save()
  return result
}

// ---------- 课程与进度 ----------

export function courseStats(course: Course) {
  let totalMin = 0
  let watchedMin = 0
  let doneLessons = 0
  course.lessons.forEach(function (l) {
    if (l.totalMin > 0) {
      totalMin += l.totalMin
      const w = Math.min(l.watchedMin, l.totalMin)
      watchedMin += w
      if (w >= l.totalMin) doneLessons++
    }
  })
  return {
    totalMin: totalMin,
    watchedMin: watchedMin,
    doneLessons: doneLessons,
    count: course.lessons.length,
    pct: totalMin ? Math.round((watchedMin / totalMin) * 100) : 0,
  }
}

export function overallStats() {
  const out = { totalMin: 0, watchedMin: 0, doneLessons: 0, count: 0, pct: 0 }
  state.courses.forEach(function (c) {
    const s = courseStats(c)
    out.totalMin += s.totalMin
    out.watchedMin += s.watchedMin
    out.doneLessons += s.doneLessons
    out.count += s.count
  })
  out.pct = out.totalMin ? Math.round((out.watchedMin / out.totalMin) * 100) : 0
  return out
}

export function findCourse(cid: string): Course | null {
  for (let i = 0; i < state.courses.length; i++) {
    if (state.courses[i].id === cid) return state.courses[i]
  }
  return null
}

export function findLesson(cid: string, lid: string): { course: Course; lesson: Lesson } | null {
  const course = findCourse(cid)
  if (!course) return null
  for (let i = 0; i < course.lessons.length; i++) {
    if (course.lessons[i].id === lid) return { course: course, lesson: course.lessons[i] }
  }
  return null
}

/** 把分钟记到某一天的累计里 */
export function addActivity(min: number, key?: string): void {
  const day = key || todayKey()
  if (!min || min <= 0) return
  state.activity[day] = (state.activity[day] || 0) + min
}

/** 写当日明细，同一天同一课时合并 */
export function recordDetail(cid: string, lid: string, min: number, key?: string): void {
  const day = key || todayKey()
  if (!state.details[day]) state.details[day] = []
  const list = state.details[day]
  for (let i = 0; i < list.length; i++) {
    if (list[i].cid === cid && list[i].lid === lid) {
      list[i].min += min
      list[i].at = Date.now()
      return
    }
  }
  const course = findCourse(cid)
  let idx = 0
  if (course) {
    for (let i = 0; i < course.lessons.length; i++) {
      if (course.lessons[i].id === lid) idx = i + 1
    }
  }
  list.push({ cid: cid, lid: lid, idx: idx, min: min, at: Date.now() })
}

// ---------- 待办 ----------

export function todoDeadline(t: Todo): number | null {
  if (!t.due) return null
  const p = t.due.split('-')
  let hh = 23
  let mm = 59
  if (t.dueTime) {
    const q = t.dueTime.split(':')
    const h = parseInt(q[0], 10)
    const m = parseInt(q[1], 10)
    if (h === 24) {
      hh = 23
      mm = 59
    } else {
      hh = h
      mm = m
    }
  }
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), hh, mm, 0, 0).getTime()
}

/** overdue / soon / week / ''；未完成才算 */
export function todoUrgency(t: Todo): string {
  if (t.done) return ''
  const dl = todoDeadline(t)
  if (dl == null) return 'no-deadline'
  const now = Date.now()
  if (dl < now) return 'overdue'
  if (dl - now <= 24 * 3600 * 1000) return 'soon'
  if (dl - now <= 7 * 24 * 3600 * 1000) return 'week'
  return ''
}

export function calUrgency(t: Todo): 'overdue' | 'soon' | 'week' | 'far' {
  const u = todoUrgency(t)
  if (u === 'overdue' || u === 'soon' || u === 'week') return u
  return 'far'
}

export const URGENCY_RANK: Record<string, number> = { overdue: 0, soon: 1, week: 2, far: 3 }

export function todoDayLeftText(t: Todo): string {
  if (t.done) return '已完成'
  const dl = todoDeadline(t)
  if (dl == null) return '截止待确认'
  const diff = dl - Date.now()
  if (diff < 0) return '已逾期 ' + Math.max(1, Math.ceil(-diff / 86400000)) + ' 天'
  return '还有 ' + Math.max(1, Math.ceil(diff / 86400000)) + ' 天'
}

export function sortedTodos(): Todo[] {
  return state.todos.slice().sort(function (a, b) {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.done && b.done) return (b.doneAt || 0) - (a.doneAt || 0)
    const da = todoDeadline(a)
    const db = todoDeadline(b)
    if (da == null && db == null) return TODO_PRI.indexOf(a.pri) - TODO_PRI.indexOf(b.pri)
    if (da == null) return 1
    if (db == null) return -1
    if (da !== db) return da - db
    return TODO_PRI.indexOf(a.pri) - TODO_PRI.indexOf(b.pri)
  })
}

export function todosOnDay(key: string): Todo[] {
  return state.todos
    .filter(function (t) {
      return t.due === key
    })
    .sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1
      const ra = URGENCY_RANK[calUrgency(a)]
      const rb = URGENCY_RANK[calUrgency(b)]
      if (ra !== rb) return ra - rb
      const da = todoDeadline(a)
      const db = todoDeadline(b)
      if (da != null && db != null && da !== db) return da - db
      return TODO_PRI.indexOf(a.pri) - TODO_PRI.indexOf(b.pri)
    })
}

export function doneTodosOn(key: string): Todo[] {
  return state.todos.filter(function (t) {
    return t.done && t.doneAt && dateKey(new Date(t.doneAt)) === key
  })
}

/** 今日要做的：今天到期的未完成 + 已逾期的 */
export function todayFocus(): Todo[] {
  const today = todayKey()
  return state.todos
    .filter(function (t) {
      if (t.done) return false
      if (!t.due) return false
      return t.due <= today
    })
    .sort(function (a, b) {
      const ra = URGENCY_RANK[calUrgency(a)]
      const rb = URGENCY_RANK[calUrgency(b)]
      if (ra !== rb) return ra - rb
      const da = todoDeadline(a)
      const db = todoDeadline(b)
      if (da != null && db != null && da !== db) return da - db
      return TODO_PRI.indexOf(a.pri) - TODO_PRI.indexOf(b.pri)
    })
}

export function toggleTodo(id: string): void {
  commit(function () {
    state.todos.forEach(function (t) {
      if (t.id !== id) return
      t.done = !t.done
      t.doneAt = t.done ? Date.now() : null
    })
  })
}

// ---------- 打卡 ----------

/** 某天除视频时长外的量化数据 */
export function dayStats(key: string): { done: number; checkins: number } {
  let done = 0
  state.todos.forEach(function (t) {
    if (t.done && t.doneAt && dateKey(new Date(t.doneAt)) === key) done++
  })
  let checkins = 0
  state.checkins.forEach(function (item) {
    item.logs.forEach(function (log) {
      if (log.date === key) checkins++
    })
  })
  return { done: done, checkins: checkins }
}

export function checkinLastLog(item: Checkin): CheckinLog | null {
  if (!item.logs.length) return null
  return item.logs[item.logs.length - 1]
}

/** 本周起始（周一）的日期键 */
function weekStartKey(base: Date): string {
  const day = base.getDay()
  const offset = day === 0 ? -6 : 1 - day
  return dateKey(addDays(base, offset))
}

/** 已经打过卡的日期键集合，用于判断今天是否已完成 */
export function checkinDayKeys(item: Checkin): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  item.logs.forEach(function (log) {
    map[log.date] = true
  })
  return map
}

export function checkinDoneToday(item: Checkin): boolean {
  return checkinDayKeys(item)[todayKey()] === true
}

export function checkinDoneThisWeek(item: Checkin): boolean {
  const start = weekStartKey(new Date())
  const keys = checkinDayKeys(item)
  const startDate = new Date(start)
  for (let i = 0; i < 7; i++) {
    if (keys[dateKey(addDays(startDate, i))]) return true
  }
  return false
}

/** 周期说明文案 */
export function checkinCadenceText(item: Checkin): string {
  if (item.cadence === 'daily') return '每天'
  if (item.cadence === 'weekly') return '每周一次'
  return '每 ' + item.intervalDays + ' 天'
}

/** 下一次可打卡的日期键；null 表示今天就能打 */
export function checkinNextKey(item: Checkin): string | null {
  if (item.cadence === 'interval') {
    const last = checkinLastLog(item)
    if (!last) return null
    return dateKey(addDays(keyToDate(last.date), item.intervalDays))
  }
  return null
}

export function checkinCanRun(item: Checkin): boolean {
  if (item.cadence === 'daily') return !checkinDoneToday(item)
  if (item.cadence === 'weekly') return !checkinDoneThisWeek(item)
  const next = checkinNextKey(item)
  if (!next) return true
  return next <= todayKey()
}

export function checkinStatusText(item: Checkin): string {
  if (checkinCanRun(item)) {
    return item.kind === 'video' && item.courseId ? '可以打卡' : '今天可以打卡'
  }
  if (item.cadence === 'daily') return '今天已完成'
  if (item.cadence === 'weekly') return '本周已完成'
  const next = checkinNextKey(item)
  return next ? next.slice(5) + ' 后可再打卡' : '已完成'
}

/** 追加一次打卡；视频打卡同时写入课时进度与当天视频时长 */
export function addCheckinLog(
  item: Checkin,
  payload: { min?: number; cid?: string; lid?: string; note?: string }
): void {
  const log: CheckinLog = { date: todayKey(), at: Date.now() }
  const min = clampInt(payload.min, 0, 9999, 0)
  if (min > 0) log.min = min
  if (payload.cid) log.cid = payload.cid
  if (payload.lid) log.lid = payload.lid
  if (payload.note) log.note = payload.note.trim().slice(0, 200)

  item.logs.push(log)
  if (item.logs.length > 1000) item.logs.splice(0, item.logs.length - 1000)

  if (min > 0) {
    addActivity(min)
    if (payload.cid && payload.lid) {
      recordDetail(payload.cid, payload.lid, min)
      const found = findLesson(payload.cid, payload.lid)
      if (found) {
        found.lesson.watchedMin = Math.min(
          found.lesson.totalMin > 0 ? found.lesson.totalMin : 9999,
          found.lesson.watchedMin + min
        )
      }
    }
  }
  save()
}

/** 连续打卡天数：今天还没记就从昨天开始数 */
export function streakDays(): number {
  let streak = 0
  let cursor = new Date()
  if (!state.activity[todayKey()]) cursor = addDays(cursor, -1)
  while (state.activity[dateKey(cursor)]) {
    streak++
    cursor = addDays(cursor, -1)
  }
  return streak
}

/** 新增一条自定义打卡 */
export function addCheckin(name: string, cadence: Checkin['cadence'], intervalDays: number): Checkin {
  const item: Checkin = {
    id: makeId(),
    name: name.slice(0, 40),
    kind: 'custom',
    cadence: cadence,
    intervalDays: intervalDays,
    courseId: '',
    logs: [],
  }
  commit(function () {
    state.checkins.push(item)
  })
  return item
}

export function removeCheckin(id: string): void {
  commit(function () {
    state.checkins = state.checkins.filter(function (c) {
      return c.id !== id
    })
  })
}

/** 校验并整体替换（用于导入 JSON） */
export function replaceState(raw: unknown): boolean {
  const next = sanitize(raw)
  if (!next) return false
  state = next
  save()
  return true
}
