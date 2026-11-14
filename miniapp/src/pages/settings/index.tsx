import { useCallback, useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import {
  clearConfig,
  configure,
  getCfg,
  getStatus,
  isConfigured,
  isDirty,
  listHistory,
  onStatus,
  restoreHistory,
  syncNow,
  useCloud,
  useLocal,
} from '../../data/cloud'
import type { HistoryItem, SyncStatus } from '../../data/cloud'
import { confirmText, PromptHost } from '../../components/Prompt'
import { commit, emptyState, getState, reload, replaceState } from '../../data/store'
import { sanitize } from '../../data/sanitize'
import './index.scss'

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

function timeText(ts: number): string {
  if (!ts) return '还没同步过'
  const d = new Date(ts)
  return (
    (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  )
}

function statusText(s: SyncStatus): string {
  if (s.state === 'off') return '未配置'
  if (s.state === 'syncing') return '同步中'
  if (s.state === 'ok') return '已同步'
  if (s.state === 'conflict') return '需要选择'
  if (s.state === 'error') return '出错'
  return '待同步'
}

export default function SettingsPage() {
  const [base, setBase] = useState('')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<SyncStatus>(getStatus())
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [, setTick] = useState(0)

  useDidShow(
    useCallback(function () {
      reload()
      const cfg = getCfg()
      setBase(cfg.base)
      setToken(cfg.token)
      setStatus(getStatus())
      loadHistory()
      setTick(function (n) {
        return n + 1
      })
    }, [])
  )

  async function loadHistory() {
    if (!isConfigured()) {
      setHistory([])
      return
    }
    try {
      setHistory(await listHistory(8))
    } catch (err) {
      setHistory([])
    }
  }

  async function onRestore(item: HistoryItem) {
    const ok = await confirmText(
      '恢复 rev ' + item.rev + '？',
      '这一版会作为新版本写回云端，并覆盖本机当前数据。'
    )
    if (!ok) return
    await restoreHistory(item.id)
    refresh()
    Taro.showToast({ title: getStatus().message, icon: 'none' })
    await loadHistory()
  }

  function refresh() {
    setStatus(getStatus())
    setTick(function (n) {
      return n + 1
    })
  }

  const cfg = getCfg()
  const running = status.state === 'syncing'

  async function onSave() {
    if (!base.trim() || !token.trim()) {
      Taro.showToast({ title: '地址和通行证都要填', icon: 'none' })
      return
    }
    configure(base, token)
    refresh()
    Taro.showToast({ title: '已保存，开始同步', icon: 'none' })
    await onSync()
  }

  async function onSync() {
    const unsub = onStatus(function (s) {
      setStatus(s)
    })
    const result = await syncNow()
    unsub()
    refresh()
    if (result === 'ok') Taro.showToast({ title: '同步完成', icon: 'success' })
    if (result === 'error') Taro.showToast({ title: getStatus().message, icon: 'none' })
    loadHistory()
  }

  async function onUseCloud() {
    await useCloud()
    refresh()
  }

  async function onUseLocal() {
    await useLocal()
    refresh()
  }

  function onExport() {
    const s = getState()
    const payload = {
      v: 2,
      schemaVersion: s.schemaVersion,
      exportedAt: new Date().toISOString(),
      courses: s.courses,
      activity: s.activity,
      demoActivity: s.demoActivity,
      details: s.details,
      demoDetails: s.demoDetails,
      todos: s.todos,
      checkins: s.checkins,
      courseOpen: s.courseOpen,
      panelOpen: s.panelOpen,
    }
    Taro.setClipboardData({ data: JSON.stringify(payload, null, 2) }).then(function () {
      Taro.showToast({ title: '备份已复制到剪贴板', icon: 'none' })
    })
  }

  async function onImport() {
    let text = ''
    try {
      const clip = await Taro.getClipboardData()
      text = String((clip && clip.data) || '').trim()
    } catch (err) {
      Taro.showToast({ title: '读不到剪贴板', icon: 'none' })
      return
    }
    if (!text) {
      Taro.showToast({ title: '剪贴板是空的', icon: 'none' })
      return
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      Taro.showToast({ title: '剪贴板不是合法 JSON', icon: 'none' })
      return
    }
    if (!sanitize(parsed)) {
      Taro.showToast({ title: '结构不对，请用网页版导出的备份', icon: 'none' })
      return
    }
    const ok = await confirmText(
      '导入备份？',
      '会用这份备份整体覆盖本机数据，之后自动同步到云端。'
    )
    if (!ok) return
    replaceState(parsed)
    refresh()
    Taro.showToast({ title: '已导入', icon: 'success' })
  }

  async function onResetActivity() {
    if (Object.keys(getState().activity).length === 0) {
      Taro.showToast({ title: '现在没有打卡记录', icon: 'none' })
      return
    }
    const ok = await confirmText(
      '重置打卡记录',
      '只清空日历热力图和连续打卡天数，课程与每节已看时长都会保留。',
      '重置'
    )
    if (!ok) return
    commit(function () {
      const s = getState()
      s.activity = {}
      s.demoActivity = {}
      s.details = {}
      s.demoDetails = {}
    })
    refresh()
    Taro.showToast({ title: '打卡记录已重置', icon: 'success' })
  }

  async function onClearAll() {
    const s = getState()
    if (
      s.courses.length === 0 &&
      Object.keys(s.activity).length === 0 &&
      s.todos.length === 0 &&
      s.checkins.length === 0
    ) {
      Taro.showToast({ title: '现在就是空的', icon: 'none' })
      return
    }
    const ok = await confirmText(
      '清空全部数据',
      '课程、已看时长、日历打卡、循环打卡、待办会一起清除，且不可撤销。建议先导出备份。',
      '清空'
    )
    if (!ok) return
    replaceState(emptyState())
    refresh()
    Taro.showToast({ title: '已清空', icon: 'success' })
  }

  function onClear() {
    Taro.showModal({
      title: '清空云端配置',
      content: '只清掉本机的地址和通行证，不影响云端数据。',
      confirmColor: '#c0453a',
      success: function (res) {
        if (!res.confirm) return
        clearConfig()
        setBase('')
        setToken('')
        refresh()
      },
    })
  }

  return (
    <View className='page sync-page'>
      <View className='masthead'>
        <View>
          <Text className='kicker mono'>CLOUD · SUPABASE</Text>
          <Text className='title'>云同步</Text>
          <Text className='today-line'>
            状态：{statusText(status)}
            {cfg.rev ? ' · rev ' + cfg.rev : ''}
          </Text>
        </View>
      </View>

      <View className='panel'>
        <View className='sync-head'>
          <View className={'sync-dot sync-dot-' + status.state} />
          <Text className='sync-msg'>{status.message}</Text>
        </View>
        <View className='sync-meta'>
          <Text className='sync-meta-item'>上次同步 {timeText(cfg.lastSyncAt)}</Text>
          <Text className='sync-meta-item'>{isDirty() ? '有改动待上传' : '本机已是最新'}</Text>
        </View>

        {status.state === 'conflict' && (
          <View className='sync-conflict'>
            <Text className='sync-conflict-tip'>
              云端和你本机都改过。选一个为准，另一边会被覆盖。
            </Text>
            <View className='btn-row'>
              <View className='btn-ghost' onClick={onUseLocal}>
                以本机为准
              </View>
              <View className='btn-main' onClick={onUseCloud}>
                以云端为准
              </View>
            </View>
          </View>
        )}
      </View>

      <View className='panel'>
        <View className='panel-head'>
          <View>
            <Text className='panel-title'>连接</Text>
            <Text className='panel-cap'>填腾讯云函数 URL 和通行证，只存在本机</Text>
          </View>
        </View>

        <View className='field'>
          <Text className='field-label mono'>FUNCTION URL</Text>
          <Input
            className='field-input'
            type='text'
            value={base}
            placeholder='https://xxxx.ap-guangzhou.tencentscf.com'
            placeholderClass='field-ph'
            onInput={function (e) {
              setBase(e.detail.value)
            }}
          />
        </View>

        <View className='field'>
          <Text className='field-label mono'>SYNC TOKEN</Text>
          <Input
            className='field-input'
            type='text'
            value={token}
            placeholder='云函数里的 SYNC_TOKEN'
            placeholderClass='field-ph'
            onInput={function (e) {
              setToken(e.detail.value)
            }}
          />
        </View>

        <View className='btn-row'>
          <View className='btn-ghost' onClick={onSave}>
            保存
          </View>
          <View className={'btn-main' + (running || !isConfigured() ? ' btn-main-off' : '')} onClick={onSync}>
            {running ? '同步中…' : '立即同步'}
          </View>
        </View>

        <Text className='sync-note'>
          数据存在你自己的 Supabase 里，和网页版共用一份；本机改动 2.5 秒后自动上传。
        </Text>

        {isConfigured() && (
          <Text className='sync-clear' onClick={onClear}>
            清空本机配置
          </Text>
        )}
      </View>

      <View className='panel'>
        <View className='panel-head'>
          <View>
            <Text className='panel-title'>本机数据</Text>
            <Text className='panel-cap'>导出走剪贴板，导入也读剪贴板；JSON 与网页版通用</Text>
          </View>
        </View>

        <View className='btn-row'>
          <View className='btn-ghost' onClick={onExport}>导出备份</View>
          <View className='btn-ghost' onClick={onImport}>导入备份</View>
        </View>

        <View className='btn-row'>
          <View className='btn-ghost' onClick={onResetActivity}>重置打卡</View>
          <View className='btn-ghost btn-ghost-danger' onClick={onClearAll}>清空数据</View>
        </View>

        <Text className='sync-note'>
          导出会把整份 JSON 复制到剪贴板，粘到记事本或发给自己保存；导入时先复制备份内容，再点「导入备份」。
        </Text>
      </View>

      {isConfigured() && (
        <View className='panel'>
          <View className='panel-head'>
            <View>
              <Text className='panel-title'>历史版本</Text>
              <Text className='panel-cap'>每次写入前自动留一版，云端保留最近 20 版</Text>
            </View>
            <Text className='link-btn' onClick={loadHistory}>刷新</Text>
          </View>

          {history.length === 0 && (
            <Text className='empty'>还没有历史版本。改动一次并同步后就会出现。</Text>
          )}

          {history.map(function (item) {
            const ts = Date.parse(item.archivedAt)
            return (
              <View className='hist-row' key={item.id}>
                <Text className='hist-rev mono'>rev {item.rev}</Text>
                <Text className='hist-time'>{ts ? timeText(ts) : item.archivedAt}</Text>
                <Text className='hist-act' onClick={function () { onRestore(item) }}>
                  恢复
                </Text>
              </View>
            )
          })}
        </View>
      )}
      <PromptHost />
    </View>
  )
}
