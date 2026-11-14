import Taro from '@tarojs/taro'
import { applyRemote, getState, onSave } from './store'

const CFG_KEY = 'cloud-cfg-v1'
const DIRTY_KEY = 'cloud-dirty-v1'

export interface CloudCfg {
  base: string
  token: string
  userId: string
  rev: number
  lastSyncAt: number
}

export type SyncState = 'off' | 'idle' | 'syncing' | 'ok' | 'error' | 'conflict'

export interface SyncStatus {
  state: SyncState
  message: string
  at: number
}

const DEFAULT_CFG: CloudCfg = { base: '', token: '', userId: '', rev: 0, lastSyncAt: 0 }

function loadCfg(): CloudCfg {
  try {
    const raw = Taro.getStorageSync(CFG_KEY)
    if (!raw) return { ...DEFAULT_CFG }
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return { ...DEFAULT_CFG, ...parsed }
  } catch (err) {
    return { ...DEFAULT_CFG }
  }
}

let cfg: CloudCfg = loadCfg()
let dirty: boolean = Taro.getStorageSync(DIRTY_KEY) === true
let busy = false
let timer: any = null
let status: SyncStatus = { state: 'off', message: '未配置', at: 0 }

const listeners: Array<(s: SyncStatus) => void> = []

function persist(): void {
  Taro.setStorageSync(CFG_KEY, cfg)
}

function persistDirty(): void {
  Taro.setStorageSync(DIRTY_KEY, dirty)
}

function setStatus(state: SyncState, message: string): void {
  status = { state: state, message: message, at: Date.now() }
  listeners.forEach(function (fn) {
    try {
      fn(status)
    } catch (err) {
      // 忽略单个订阅者的异常
    }
  })
}

export function onStatus(fn: (s: SyncStatus) => void): () => void {
  listeners.push(fn)
  return function () {
    const i = listeners.indexOf(fn)
    if (i >= 0) listeners.splice(i, 1)
  }
}

export function getStatus(): SyncStatus {
  return status
}

export function getCfg(): CloudCfg {
  return cfg
}

export function isConfigured(): boolean {
  return !!(cfg.base && cfg.token)
}

export function isDirty(): boolean {
  return dirty
}

/** 本机是否已经有内容，用来决定首次同步要不要问「以谁为准」 */
function hasLocalData(): boolean {
  const s: any = getState()
  if (!s) return false
  const count = function (v: any): number {
    return v ? Object.keys(v).length : 0
  }
  return (
    (s.courses || []).length > 0 ||
    (s.todos || []).length > 0 ||
    (s.checkins || []).length > 0 ||
    count(s.activity) > 0 ||
    count(s.details) > 0
  )
}

/** 保存配置；改了地址或 token 就重置版本与用户，避免拿旧 rev 去写新库 */
export function configure(base: string, token: string): void {
  const nextBase = base.trim().replace(/\/+$/, '')
  const nextToken = token.trim()
  const changed = nextBase !== cfg.base || nextToken !== cfg.token
  cfg.base = nextBase
  cfg.token = nextToken
  if (changed) {
    cfg.userId = ''
    cfg.rev = 0
    dirty = hasLocalData()
    persistDirty()
  }
  persist()
  if (!isConfigured()) {
    setStatus('off', '未配置')
    return
  }
  setStatus(
    'idle',
    dirty ? '本机已有数据，首次同步会让你选择以谁为准' : '配置已保存，点「立即同步」'
  )
}

export function clearConfig(): void {
  cfg = { ...DEFAULT_CFG }
  dirty = false
  persist()
  persistDirty()
  setStatus('off', '已清空配置')
}

function request(method: string, path: string, query: string, body?: any): Promise<{ code: number; data: any }> {
  const url = cfg.base + path + (query ? '?' + query : '')
  return new Promise(function (resolve, reject) {
    Taro.request({
      url: url,
      method: method as any,
      timeout: 15000,
      header: {
        'x-sync-token': cfg.token,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      data: body,
      success: function (res) {
        resolve({ code: res.statusCode, data: res.data })
      },
      fail: function (err) {
        reject(new Error(err && err.errMsg ? err.errMsg : '网络请求失败'))
      },
    })
  })
}

function failText(res: { code: number; data: any }): string {
  if (res.code === 401) return '通行证不对（检查 SYNC_TOKEN）'
  if (res.code === 403) return '云函数只允许 /rest/v1/ 路径'
  const msg =
    res.data && (res.data.message || res.data.error_description || res.data.hint || res.data.details)
  return '同步失败（' + res.code + '）' + (msg ? '：' + msg : '')
}

interface Head {
  userId: string
  rev: number
}

/** 只查版本号，省流量 */
async function probe(): Promise<Head | null> {
  const res = await request('GET', '/rest/v1/study_state', 'select=user_id,rev&limit=1')
  if (res.code >= 400) throw new Error(failText(res))
  const rows = Array.isArray(res.data) ? res.data : []
  if (!rows.length) return null
  return { userId: String(rows[0].user_id || ''), rev: Number(rows[0].rev) || 0 }
}

async function fetchFull(): Promise<{ rev: number; data: any }> {
  const res = await request('GET', '/rest/v1/study_state', 'select=rev,data&limit=1')
  if (res.code >= 400) throw new Error(failText(res))
  const rows = Array.isArray(res.data) ? res.data : []
  if (!rows.length) throw new Error('云端没有数据')
  return { rev: Number(rows[0].rev) || 0, data: rows[0].data }
}

/** 条件更新；返回 false 表示版本对不上（云端已被别处改过） */
async function pushWithRev(baseRev: number): Promise<boolean> {
  const userId = cfg.userId
  if (!userId) return false
  const body = { data: getState(), rev: baseRev + 1 }
  const res = await request(
    'PATCH',
    '/rest/v1/study_state',
    'user_id=eq.' + encodeURIComponent(userId) + '&rev=eq.' + baseRev,
    body
  )
  if (res.code >= 400) throw new Error(failText(res))
  const rows = Array.isArray(res.data) ? res.data : []
  if (!rows.length) return false
  cfg.rev = Number(rows[0].rev) || baseRev + 1
  cfg.lastSyncAt = Date.now()
  dirty = false
  persist()
  persistDirty()
  return true
}

/** 冲突时强制以本机为准：不带 rev 条件，版本号取云端当前值 + 1 */
async function forcePush(): Promise<void> {
  const head = await probe()
  if (!head) throw new Error('云端没有数据')
  cfg.userId = head.userId
  const res = await request('PATCH', '/rest/v1/study_state', 'user_id=eq.' + encodeURIComponent(head.userId), {
    data: getState(),
    rev: head.rev + 1,
  })
  if (res.code >= 400) throw new Error(failText(res))
  cfg.rev = head.rev + 1
  cfg.lastSyncAt = Date.now()
  dirty = false
  persist()
  persistDirty()
}

/** 拉云端整份覆盖本机 */
async function pullOverwrite(): Promise<void> {
  const row = await fetchFull()
  if (!applyRemote(row.data)) throw new Error('云端数据格式不认识')
  const head = await probe()
  if (head) cfg.userId = head.userId
  cfg.rev = row.rev
  cfg.lastSyncAt = Date.now()
  dirty = false
  persist()
  persistDirty()
}

export async function syncNow(): Promise<SyncState> {
  if (!isConfigured()) {
    setStatus('off', '未配置云同步')
    return 'off'
  }
  if (busy) return status.state
  busy = true
  setStatus('syncing', '正在同步…')
  try {
    const head = await probe()
    if (!head) {
      setStatus('error', '云端还没有数据，先在网页版同步一次')
      return 'error'
    }
    cfg.userId = head.userId
    persist()

    if (head.rev > cfg.rev) {
      if (dirty) {
        setStatus('conflict', '云端有新版本，本机也有未上传的改动')
        return 'conflict'
      }
      await pullOverwrite()
      setStatus('ok', '已从云端更新到 rev ' + cfg.rev)
      return 'ok'
    }

    if (dirty) {
      const ok = await pushWithRev(head.rev)
      if (!ok) {
        setStatus('conflict', '云端刚被改过，本机也有改动')
        return 'conflict'
      }
      setStatus('ok', '已上传，rev ' + cfg.rev)
      return 'ok'
    }

    cfg.lastSyncAt = Date.now()
    persist()
    setStatus('ok', '已是最新，rev ' + cfg.rev)
    return 'ok'
  } catch (err) {
    setStatus('error', err && (err as Error).message ? (err as Error).message : '同步失败')
    return 'error'
  } finally {
    busy = false
  }
}

/** 冲突：以云端为准 */
export async function useCloud(): Promise<void> {
  try {
    setStatus('syncing', '正在拉取云端…')
    await pullOverwrite()
    setStatus('ok', '已用云端覆盖本机，rev ' + cfg.rev)
  } catch (err) {
    setStatus('error', (err as Error).message || '同步失败')
  }
}

/** 冲突：以本机为准 */
export async function useLocal(): Promise<void> {
  try {
    setStatus('syncing', '正在上传本机…')
    await forcePush()
    setStatus('ok', '已用本机覆盖云端，rev ' + cfg.rev)
  } catch (err) {
    setStatus('error', (err as Error).message || '同步失败')
  }
}

/** 云端历史快照（只读，由数据库触发器写入） */
export interface HistoryItem {
  id: number
  rev: number
  archivedAt: string
}

/** 拉最近几版快照的列表，只需要 rev 和时间 */
export async function listHistory(limit?: number): Promise<HistoryItem[]> {
  if (!isConfigured()) return []
  const head = await probe()
  if (!head) return []
  cfg.userId = head.userId
  persist()
  const res = await request(
    'GET',
    '/rest/v1/study_state_history',
    'user_id=eq.' +
      encodeURIComponent(head.userId) +
      '&select=id,rev,archived_at&order=id.desc&limit=' +
      (limit || 10)
  )
  if (res.code >= 400) throw new Error(failText(res))
  const rows = Array.isArray(res.data) ? res.data : []
  return rows.map(function (row: any) {
    return {
      id: Number(row.id) || 0,
      rev: Number(row.rev) || 0,
      archivedAt: String(row.archived_at || ''),
    }
  })
}

/** 把某一版历史快照当作新版本推回云端，并覆盖本机 */
export async function restoreHistory(id: number): Promise<SyncState> {
  if (!isConfigured()) return 'off'
  if (busy) return status.state
  busy = true
  setStatus('syncing', '正在恢复历史版本…')
  try {
    const rowRes = await request(
      'GET',
      '/rest/v1/study_state_history',
      'id=eq.' + id + '&select=rev,data&limit=1'
    )
    if (rowRes.code >= 400) throw new Error(failText(rowRes))
    const rows = Array.isArray(rowRes.data) ? rowRes.data : []
    if (!rows.length) throw new Error('这条历史记录已经不在了')
    const snapshot = rows[0].data
    const snapshotRev = Number(rows[0].rev) || 0

    const head = await probe()
    if (!head) throw new Error('云端没有数据')
    cfg.userId = head.userId

    const nextRev = head.rev + 1
    const res = await request(
      'PATCH',
      '/rest/v1/study_state',
      'user_id=eq.' + encodeURIComponent(head.userId) + '&rev=eq.' + head.rev,
      { data: snapshot, rev: nextRev }
    )
    if (res.code >= 400) throw new Error(failText(res))
    const patched = Array.isArray(res.data) ? res.data : []
    if (!patched.length) {
      throw new Error('云端刚被改过，再点一次恢复')
    }

    if (!applyRemote(snapshot)) throw new Error('这版数据格式不认识')
    cfg.rev = nextRev
    cfg.lastSyncAt = Date.now()
    dirty = false
    persist()
    persistDirty()
    setStatus('ok', '已恢复到 rev ' + snapshotRev + '（现为 rev ' + nextRev + '）')
    return 'ok'
  } catch (err) {
    setStatus('error', (err as Error).message || '恢复失败')
    return 'error'
  } finally {
    busy = false
  }
}

/** 页面显示时静默检查一次；没有配置就什么都不做 */
export function autoSync(): Promise<SyncState> {
  if (!isConfigured()) return Promise.resolve<SyncState>('off')
  return syncNow()
}

/** 本地改动后防抖上传 */
function schedulePush(): void {
  if (!isConfigured()) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(function () {
    timer = null
    if (!isConfigured()) return
    syncNow()
  }, 2500)
}

onSave(function () {
  dirty = true
  persistDirty()
  setStatus('idle', '有改动待上传')
  schedulePush()
})
