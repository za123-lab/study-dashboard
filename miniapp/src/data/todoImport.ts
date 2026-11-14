import type { Todo, TodoCat, TodoPri } from './types'
import { TODO_PRI } from './types'

/** 与网页版保持同一套提示词和校验规则，两端导入结果一致 */
export const TODO_IMPORT_PROMPT = [
  '请把下面的任务信息整理成待办清单 JSON。',
  '',
  '只接受 JSON，请严格遵守以下规则：',
  '1. 只输出一个 JSON 数组，即使只有 1 条也要用 [ ] 包起来：第一个字符是 [，最后一个字符是 ]。',
  '2. 不要输出任何解释、开场白、结尾语，也不要用 ```json 代码块包裹。',
  '3. 每条待办只能有 title、cat、due、dueTime、pri、note、link 七个字段，不要添加其它字段。',
  '4. title：必填，任务标题原文，不要加序号，不要超过 120 字。',
  '5. cat：类别，只接受 study、contest、event、other 四个值（分别对应 学业课程、学科竞赛、文体活动、其他）。',
  '6. due：截止日期，只接受 YYYY-MM-DD，例如 2026-11-11；不确定就留空字符串 ""。',
  '7. dueTime：可选截止时间，只接受 HH:mm（24 小时制，00:00–23:59），例如 09:30；不确定就留空字符串 ""。',
  '8. pri：优先级，只接受 P0、P1、P2 三个值；不确定就留空字符串 ""。',
  '9. note：备注，可选；没有就留空字符串 ""。',
  '10. link：关联链接，可选；只写 http:// 或 https:// 开头的完整网址；没有就留空字符串 ""。',
  '11. 拿不准的字段一律留空字符串 ""，不要编造日期、时间、链接或备注。',
  '12. 不要输出 done、id、createdAt 等其它字段。',
  '',
  '输出示例（照这个结构，不要照抄内容）：',
  '[',
  '  {"title": "计算机专业英语期末大作业", "cat": "study", "due": "2026-11-11", "dueTime": "18:00", "pri": "P0", "note": "先完成双语总结文档", "link": ""},',
  '  {"title": "提交米兰设计周作品", "cat": "contest", "due": "2027-01-18", "dueTime": "", "pri": "P2", "note": "", "link": "https://example.com"}',
  ']',
  '',
  '任务信息：',
  '<把任务原文粘在这里>',
].join('\n')

export interface TodoDraft {
  title: string
  cat: TodoCat
  due: string
  dueTime: string
  pri: TodoPri
  note: string
  link: string
}

export interface TodoImportSkipped {
  title: string
  reason: 'existing' | 'input'
}

export interface TodoImportResult {
  error?: string
  items?: TodoDraft[]
  skipped?: TodoImportSkipped[]
}

const CAT_MAP: Record<string, TodoCat> = {
  study: 'study',
  学业课程: 'study',
  学业: 'study',
  contest: 'contest',
  学科竞赛: 'contest',
  竞赛: 'contest',
  event: 'event',
  文体活动: 'event',
  赛事: 'event',
  other: 'other',
  其他: 'other',
}

function dupKey(t: { title?: string; due?: string }): string {
  const title = String((t && t.title) || '')
    .trim()
    .replace(/\s+/g, ' ')
  const due = String((t && t.due) || '').trim()
  return title + '\u0000' + due
}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const y = Number(s.slice(0, 4))
  const mo = Number(s.slice(5, 7))
  const d = Number(s.slice(8, 10))
  if (y < 1900 || y > 2999) return false
  const dt = new Date(y, mo - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d
}

function normTime(input: string): string | null {
  const m = input.trim().match(/^(\d{1,2}):(\d{1,2})$/)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return (h < 10 ? '0' + h : String(h)) + ':' + (mi < 10 ? '0' + mi : String(mi))
}

export function parseTodoImport(raw: string, existing: Todo[]): TodoImportResult {
  let text = String(raw == null ? '' : raw).trim()
  if (!text) {
    return { error: '剪贴板是空的。先点「复制提示词」，把任务原文发给 AI，再复制返回的 JSON。' }
  }
  text = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  let data: any
  try {
    data = JSON.parse(text)
  } catch (err) {
    return {
      error: '不是合法 JSON。常见原因：夹带了说明文字、末尾多了逗号、用了中文引号。',
    }
  }

  let list: any[] | null = null
  let source = 'object'
  if (Array.isArray(data)) {
    list = data
    source = 'array'
  } else if (data && typeof data === 'object') {
    if (Array.isArray(data.todos)) {
      list = data.todos
      source = 'todos'
    } else if (data.data && Array.isArray(data.data.todos)) {
      list = data.data.todos
      source = 'data.todos'
    } else if (typeof data.title === 'string') {
      list = [data]
      source = 'single'
    } else {
      return {
        error: 'JSON 顶层是对象，但里面没有 todos 数组，也没有 title 字段。',
      }
    }
  } else {
    return { error: 'JSON 顶层必须是对象 {...} 或数组 [...]。' }
  }

  if (!list.length) return { error: '没有可导入的待办：列表是空的。' }
  if (list.length > 500) {
    return { error: '一次最多导入 500 条，当前 ' + list.length + ' 条，请分批复制。' }
  }

  const errors: string[] = []
  const parsed: TodoDraft[] = []

  list.forEach(function (item: any, i: number) {
    const path =
      source === 'array'
        ? '[' + i + ']'
        : source === 'todos'
          ? 'todos[' + i + ']'
          : source === 'data.todos'
            ? 'data.todos[' + i + ']'
            : '对象'
    const at = '第 ' + (i + 1) + ' 条（' + path + '）'

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(at + ' 不是对象')
      return
    }

    let bad = false
    const title =
      typeof item.title === 'string' ? item.title.trim().replace(/\s+/g, ' ').slice(0, 120) : ''
    if (!title) {
      errors.push(at + ' 缺少 title')
      bad = true
    }

    let cat: TodoCat = 'other'
    if (item.cat !== undefined && item.cat !== null && item.cat !== '') {
      const key = typeof item.cat === 'string' ? item.cat.trim() : ''
      if (!key || !CAT_MAP[key]) {
        errors.push(at + ' 的 cat 非法：' + JSON.stringify(item.cat))
        bad = true
      } else {
        cat = CAT_MAP[key]
      }
    }

    let due = ''
    if (item.due !== undefined && item.due !== null && item.due !== '') {
      const key = typeof item.due === 'string' ? item.due.trim() : ''
      if (!key || !validDate(key)) {
        errors.push(at + ' 的 due 非法：' + JSON.stringify(item.due))
        bad = true
      } else {
        due = key
      }
    }

    let dueTime = ''
    if (item.dueTime !== undefined && item.dueTime !== null && item.dueTime !== '') {
      const norm = typeof item.dueTime === 'string' ? normTime(item.dueTime) : null
      if (!norm) {
        errors.push(at + ' 的 dueTime 非法：' + JSON.stringify(item.dueTime))
        bad = true
      } else {
        dueTime = norm
      }
    }

    let pri: TodoPri = 'P1'
    if (item.pri !== undefined && item.pri !== null && item.pri !== '') {
      const key = typeof item.pri === 'string' ? item.pri.trim().toUpperCase() : ''
      if (TODO_PRI.indexOf(key as TodoPri) < 0) {
        errors.push(at + ' 的 pri 非法：' + JSON.stringify(item.pri))
        bad = true
      } else {
        pri = key as TodoPri
      }
    }

    let note = ''
    if (item.note !== undefined && item.note !== null) {
      if (typeof item.note !== 'string') {
        errors.push(at + ' 的 note 必须是字符串')
        bad = true
      } else {
        note = item.note.trim().slice(0, 500)
      }
    }

    let link = ''
    if (item.link !== undefined && item.link !== null && item.link !== '') {
      if (typeof item.link !== 'string' || !/^https?:\/\//i.test(item.link.trim())) {
        errors.push(at + ' 的 link 非法：' + JSON.stringify(item.link))
        bad = true
      } else {
        link = item.link.trim().slice(0, 300)
      }
    }

    if (!bad) parsed.push({ title: title, cat: cat, due: due, dueTime: dueTime, pri: pri, note: note, link: link })
  })

  if (errors.length) {
    const head = errors.slice(0, 5).join('；')
    const more = errors.length > 5 ? '；还有 ' + (errors.length - 5) + ' 处问题' : ''
    return { error: head + more }
  }

  const seen: Record<string, boolean> = {}
  existing.forEach(function (t) {
    seen[dupKey(t)] = true
  })
  const taken: Record<string, boolean> = {}
  const items: TodoDraft[] = []
  const skipped: TodoImportSkipped[] = []
  parsed.forEach(function (t) {
    const key = dupKey(t)
    if (seen[key]) {
      skipped.push({ title: t.title, reason: 'existing' })
    } else if (taken[key]) {
      skipped.push({ title: t.title, reason: 'input' })
    } else {
      taken[key] = true
      items.push(t)
    }
  })

  return { items: items, skipped: skipped }
}
