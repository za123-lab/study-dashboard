import { clampInt, makeId } from './date'
import type { AppState, Checkin, CheckinLog, Course, DetailItem, Lesson, Todo } from './types'
import { TODO_CATS, TODO_PRI } from './types'

export const SCHEMA_VERSION = 4
const DEFAULT_LESSON_MIN = 45

function cleanLessons(raw: unknown): Lesson[] {
  const list = Array.isArray(raw) ? raw : []
  const out: Lesson[] = []
  list.forEach(function (item) {
    if (!item || typeof item !== 'object') return
    const l = item as Record<string, unknown>
    const totalMin = clampInt(l.totalMin, 0, 9999, 0)
    let watchedMin = clampInt(l.watchedMin, 0, 9999, 0)
    if (totalMin > 0) watchedMin = Math.min(watchedMin, totalMin)
    const lesson: Lesson = {
      id: typeof l.id === 'string' && l.id ? (l.id as string) : makeId(),
      totalMin: totalMin,
      watchedMin: watchedMin,
    }
    if (typeof l.title === 'string' && l.title.trim()) lesson.title = l.title.trim().slice(0, 120)
    out.push(lesson)
  })
  return out
}

/** 旧结构（按集数）→ 新结构：已完成的集视为看满默认时长 */
function migrateCourseV1(raw: Record<string, unknown>): Course {
  const total = clampInt(raw.total, 1, 999, 1)
  const doneSet: Record<string, boolean> = {}
  ;(Array.isArray(raw.done) ? raw.done : []).forEach(function (n) {
    doneSet[String(parseInt(String(n), 10))] = true
  })
  const lessons: Lesson[] = []
  for (let i = 1; i <= total; i++) {
    const isDone = doneSet[String(i)] === true
    lessons.push({
      id: makeId(),
      totalMin: DEFAULT_LESSON_MIN,
      watchedMin: isDone ? DEFAULT_LESSON_MIN : 0,
    })
  }
  return {
    id: String(raw.id || makeId()),
    name: String(raw.name || '').slice(0, 40).trim(),
    lessons: lessons,
  }
}

/** 明细整理：同一天同一课时合并累加 */
export function cleanDetails(raw: unknown): Record<string, DetailItem[]> {
  const out: Record<string, DetailItem[]> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  Object.keys(raw as Record<string, unknown>).forEach(function (k) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return
    const items = (raw as Record<string, unknown>)[k]
    const merged: DetailItem[] = []
    const seen: Record<string, number> = {}
    ;(Array.isArray(items) ? items : []).forEach(function (item) {
      if (!item || typeof item !== 'object') return
      const it = item as Record<string, unknown>
      const cid = typeof it.cid === 'string' ? it.cid.slice(0, 80) : ''
      const lid = typeof it.lid === 'string' ? it.lid.slice(0, 80) : ''
      const min = clampInt(it.min, 1, 99999, 0)
      if (!cid || !lid || min <= 0) return
      const idx = clampInt(it.idx, 1, 9999, 0)
      const at = Number(it.at) > 0 ? Math.min(Number(it.at), 4102444800000) : 0
      const sig = cid + '|' + lid
      if (seen[sig] != null) {
        const prev = merged[seen[sig]]
        prev.min = Math.min(99999, prev.min + min)
        if (at && at > (prev.at || 0)) prev.at = at
        if (!prev.idx && idx) prev.idx = idx
        return
      }
      seen[sig] = merged.length
      const entry: DetailItem = { cid: cid, lid: lid, min: min }
      if (idx) entry.idx = idx
      if (at) entry.at = at
      merged.push(entry)
    })
    if (merged.length) out[k] = merged
  })
  return out
}

export function cleanTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return []
  const out: Todo[] = []
  const seenIds: Record<string, boolean> = {}
  raw.forEach(function (item) {
    if (!item || typeof item !== 'object') return
    const it = item as Record<string, unknown>
    const title = typeof it.title === 'string' ? it.title.trim().slice(0, 120) : ''
    if (!title) return
    let id =
      typeof it.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(it.id) ? it.id : makeId()
    if (seenIds[id]) id = makeId()
    seenIds[id] = true

    const cat = TODO_CATS[it.cat as keyof typeof TODO_CATS] ? (it.cat as Todo['cat']) : 'study'
    const pri = TODO_PRI.indexOf(it.pri as Todo['pri']) >= 0 ? (it.pri as Todo['pri']) : 'P1'
    const due = typeof it.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(it.due) ? it.due : ''
    let dueTime = typeof it.dueTime === 'string' ? it.dueTime.trim() : ''
    if (!/^([01]?\d|2[0-4]):[0-5]\d$/.test(dueTime)) dueTime = ''
    const done = it.done === true

    // 完成时间兼容数字时间戳与 ISO 字符串
    let doneAt = 0
    if (done) {
      const rawAt =
        typeof it.doneAt === 'number'
          ? it.doneAt
          : typeof it.doneAt === 'string'
          ? Date.parse(it.doneAt)
          : NaN
      if (Number.isFinite(rawAt)) doneAt = clampInt(Math.round(rawAt), 0, 4102444800000, 0)
    }

    const note = typeof it.note === 'string' ? it.note.trim().slice(0, 500) : ''
    let link = ''
    if (typeof it.link === 'string' && /^https?:\/\//i.test(it.link.trim())) {
      link = it.link.trim().slice(0, 300)
    }
    const dueNote = typeof it.dueNote === 'string' ? it.dueNote.trim().slice(0, 80) : ''

    const todo: Todo = {
      id: id,
      title: title,
      cat: cat,
      due: due,
      dueTime: dueTime,
      pri: pri,
      done: done,
      doneAt: doneAt || null,
      note: note,
      link: link,
    }
    if (dueNote) todo.dueNote = dueNote
    out.push(todo)
  })
  return out
}

export function cleanCheckins(raw: unknown): Checkin[] {
  if (!Array.isArray(raw)) return []
  const out: Checkin[] = []
  const seenIds: Record<string, boolean> = {}
  raw.forEach(function (item) {
    if (!item || typeof item !== 'object') return
    const it = item as Record<string, unknown>
    const name = typeof it.name === 'string' ? it.name.trim().slice(0, 40) : ''
    if (!name) return
    let id =
      typeof it.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(it.id) ? it.id : makeId()
    if (seenIds[id]) id = makeId()
    seenIds[id] = true

    const kind = it.kind === 'video' ? 'video' : 'custom'
    const cadence =
      it.cadence === 'weekly' || it.cadence === 'interval' ? (it.cadence as Checkin['cadence']) : 'daily'
    const intervalDays = clampInt(it.intervalDays, 2, 30, 3)
    const courseId = typeof it.courseId === 'string' ? it.courseId.trim().slice(0, 80) : ''

    const logs: CheckinLog[] = []
    ;(Array.isArray(it.logs) ? it.logs : []).forEach(function (log) {
      if (!log || typeof log !== 'object') return
      const lg = log as Record<string, unknown>
      if (typeof lg.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lg.date)) return
      const at = clampInt(lg.at, 0, 4102444800000, 0)
      const min = clampInt(lg.min, 0, 9999, 0)
      const entry: CheckinLog = { date: lg.date, at: at }
      if (min > 0) entry.min = min
      if (typeof lg.cid === 'string' && lg.cid) entry.cid = lg.cid.slice(0, 80)
      if (typeof lg.lid === 'string' && lg.lid) entry.lid = lg.lid.slice(0, 80)
      const note = typeof lg.note === 'string' ? lg.note.trim().slice(0, 200) : ''
      if (note) entry.note = note
      logs.push(entry)
    })
    logs.sort(function (a, b) {
      return (a.at || 0) - (b.at || 0)
    })
    if (logs.length > 1000) logs.splice(0, logs.length - 1000)

    out.push({
      id: id,
      name: name,
      kind: kind,
      cadence: cadence,
      intervalDays: intervalDays,
      courseId: courseId,
      logs: logs,
    })
  })
  return out
}

/** 把外部数据整理成可信结构，非法则返回 null */
export function sanitize(data: unknown): AppState | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, any>

  const rawCourses = Array.isArray(raw.courses) ? raw.courses : []
  const courses: Course[] = rawCourses
    .filter(function (c: any) {
      return c && typeof c.name === 'string' && c.name.trim() && c.demo !== true
    })
    .map(function (c: any) {
      if (Array.isArray(c.lessons)) return cleanCourse(c)
      return migrateCourseV1(c)
    })

  const courseOpen: Record<string, boolean> = {}
  const rawOpen = raw.courseOpen && typeof raw.courseOpen === 'object' ? raw.courseOpen : {}
  Object.keys(rawOpen).forEach(function (id) {
    if (rawOpen[id] === true && courses.some(function (c) { return c.id === id })) courseOpen[id] = true
  })

  const rawPanel = raw.panelOpen && typeof raw.panelOpen === 'object' ? raw.panelOpen : {}
  const panelOpen = { sync: rawPanel.sync === true, bili: rawPanel.bili === true }

  const checkins = cleanCheckins(raw.checkins)
  checkins.forEach(function (item) {
    if (item.courseId && !courses.some(function (c) { return c.id === item.courseId })) item.courseId = ''
  })

  const activity: Record<string, number> = {}
  const rawActivity = raw.activity && typeof raw.activity === 'object' ? raw.activity : {}
  Object.keys(rawActivity).forEach(function (k) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return
    const value = clampInt(rawActivity[k], 0, 99999, 0)
    if (value > 0) activity[k] = value
  })

  // 示例数据已下线：扣掉旧数据里残留的示例打卡，字段也一并清空
  const rawDemo = raw.demoActivity && typeof raw.demoActivity === 'object' ? raw.demoActivity : {}
  Object.keys(rawDemo).forEach(function (k) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return
    const value = clampInt(rawDemo[k], 0, 99999, 0)
    if (value <= 0) return
    const left = (activity[k] || 0) - value
    if (left > 0) activity[k] = left
    else delete activity[k]
  })

  return {
    v: 2,
    schemaVersion: SCHEMA_VERSION,
    courses: courses,
    activity: activity,
    demoActivity: {},
    details: cleanDetails(raw.details),
    demoDetails: {},
    todos: cleanTodos(raw.todos),
    checkins: checkins,
    courseOpen: courseOpen,
    panelOpen: panelOpen,
  }
}

function cleanCourse(c: Record<string, any>): Course {
  const course: Course = {
    id: String(c.id || makeId()),
    name: String(c.name).slice(0, 40).trim(),
    lessons: cleanLessons(c.lessons),
  }
  if (c.source === 'bili') {
    course.source = 'bili'
    const bv = typeof c.bvid === 'string' ? c.bvid.match(/BV[0-9A-Za-z]{10}/) : null
    if (bv) course.bvid = bv[0]
  }
  return course
}
