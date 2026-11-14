/** 日期与数值工具：与网页版保持同一套口径 */

export function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

export function dateKey(d: Date): string {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

export function todayKey(): string {
  return dateKey(new Date())
}

export function addDays(d: Date, n: number): Date {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  copy.setDate(copy.getDate() + n)
  return copy
}

export function keyToDate(key: string): Date {
  const p = String(key).split('-')
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
}

export const WEEK_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** 分钟数 → "时:分" */
export function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min || 0))
  return Math.floor(m / 60) + ':' + pad(m % 60)
}

/** 纯数字按分钟，"1:23" 按 1 小时 23 分 */
export function parseDuration(raw: string): number | null {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  const hm = s.match(/^(\d+)\s*[:：]\s*(\d{1,2})$/)
  if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10)
  return null
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = parseInt(String(value), 10)
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

export function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}
