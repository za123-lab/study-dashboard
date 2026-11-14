/** 数据结构定义：与网页版 study-log-v1 完全一致，便于导入导出与后续云同步 */

export type TodoCat = 'study' | 'contest' | 'event' | 'other'
export type TodoPri = 'P0' | 'P1' | 'P2'

export interface Lesson {
  id: string
  totalMin: number
  watchedMin: number
  title?: string
}

export interface Course {
  id: string
  name: string
  lessons: Lesson[]
  demo?: boolean
  source?: 'bili'
  bvid?: string
}

export interface DetailItem {
  cid: string
  lid: string
  idx?: number
  min: number
  at?: number
}

export interface Todo {
  id: string
  title: string
  cat: TodoCat
  due: string
  dueTime: string
  pri: TodoPri
  done: boolean
  doneAt: number | null
  note: string
  link: string
  dueNote?: string
}

export interface CheckinLog {
  date: string
  at: number
  min?: number
  cid?: string
  lid?: string
  note?: string
}

export interface Checkin {
  id: string
  name: string
  kind: 'video' | 'custom'
  cadence: 'daily' | 'weekly' | 'interval'
  intervalDays: number
  courseId: string
  logs: CheckinLog[]
}

export interface AppState {
  v: 2
  schemaVersion: number
  courses: Course[]
  activity: Record<string, number>
  demoActivity: Record<string, number>
  details: Record<string, DetailItem[]>
  demoDetails: Record<string, DetailItem[]>
  todos: Todo[]
  checkins: Checkin[]
  courseOpen: Record<string, boolean>
  panelOpen: { sync: boolean; bili: boolean }
}

export const TODO_CATS: Record<TodoCat, string> = {
  study: '学业课程',
  contest: '学科竞赛',
  event: '文体活动',
  other: '其他',
}

export const TODO_PRI: TodoPri[] = ['P0', 'P1', 'P2']
