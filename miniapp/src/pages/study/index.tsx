import { useCallback, useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import DayDetail from '../../components/DayDetail'
import Sheet, { Chip } from '../../components/Sheet'
import { PromptHost, promptText, confirmText } from '../../components/Prompt'
import { addDays, dateKey, parseDuration, todayKey, WEEK_CN } from '../../data/date'
import {
  addCheckin,
  addCheckinLog,
  checkinCadenceText,
  checkinCanRun,
  checkinStatusText,
  commit,
  dayStats,
  findCourse,
  getState,
  reload,
  removeCheckin,
  streakDays,
  todayFocus,
  toggleTodo,
} from '../../data/store'
import type { Checkin } from '../../data/types'
import { autoSync, getCfg, getStatus, isConfigured } from '../../data/cloud'
import './index.scss'

interface HeatCell {
  key: string
  level: number
  hasStats: boolean
  statLevel: number
  future: boolean
  today: boolean
}

/** 热力图周数：窄屏保持 18 周，宽屏多铺几周，而不是把格子等比放大 */
function heatWeeks(): number {
  const w = Taro.getSystemInfoSync().windowWidth || 375
  if (w < 420) return 18
  if (w < 760) return 22
  return 26
}

function minuteLevel(min: number): number {
  if (min <= 0) return 0
  if (min <= 15) return 1
  if (min <= 45) return 2
  if (min <= 90) return 3
  return 4
}

function buildHeat(weeks: number): HeatCell[][] {
  const state = getState()
  const today = new Date()
  const dow = today.getDay()
  const offset = dow === 0 ? -6 : 1 - dow
  const thisMonday = addDays(today, offset)
  const start = addDays(thisMonday, -(weeks - 1) * 7)
  const todayStr = todayKey()

  const out: HeatCell[][] = []
  for (let w = 0; w < weeks; w++) {
    const week: HeatCell[] = []
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d)
      const key = dateKey(date)
      const min = state.activity[key] || 0
      const stats = dayStats(key)
      const count = stats.done + stats.checkins
      week.push({
        key: key,
        level: minuteLevel(min),
        hasStats: count > 0,
        statLevel: count >= 3 ? 3 : count,
        future: key > todayStr,
        today: key === todayStr,
      })
    }
    out.push(week)
  }
  return out
}

export default function StudyPage() {
  const [, setTick] = useState(0)
  const [dayOpen, setDayOpen] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCadence, setNewCadence] = useState<Checkin['cadence']>('daily')
  const [newDays, setNewDays] = useState(3)
  const [newKind, setNewKind] = useState<'custom' | 'video'>('custom')
  const [newCourse, setNewCourse] = useState('')

  useDidShow(
    useCallback(function () {
      reload()
      autoSync().then(function () {
        reload()
        setTick(function (n) {
          return n + 1
        })
      })
    }, [])
  )

  const state = getState()
  const today = todayKey()
  const min = state.activity[today] || 0
  const stats = dayStats(today)
  const focus = todayFocus()
  const weeks = buildHeat(heatWeeks())
  const d = new Date()
  const todayLabel =
    (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · ' + WEEK_CN[d.getDay()] + ' · 今天'

  function refresh() {
    setTick(function (n) {
      return n + 1
    })
  }

  function onToggleTodo(id: string) {
    toggleTodo(id)
    refresh()
  }

  function onNewCheckin() {
    setNewName('')
    setNewCadence('daily')
    setNewDays(3)
    setNewKind('custom')
    setNewCourse(state.courses[0] ? state.courses[0].id : '')
    setNewOpen(true)
  }

  function onCreateCheckin() {
    const name = newName.trim()
    if (!name) {
      Taro.showToast({ title: '名称不能为空', icon: 'none' })
      return
    }
    if (newKind === 'video' && !newCourse) {
      Taro.showToast({ title: '先去「课程」添加一门课', icon: 'none' })
      return
    }
    const created = addCheckin(name, newCadence, newDays)
    if (newKind === 'video') {
      commit(function () {
        created.kind = 'video'
        created.courseId = newCourse
      })
    }
    setNewOpen(false)
    refresh()
  }

  async function onRunCheckin(item: Checkin) {
    if (!checkinCanRun(item)) {
      Taro.showToast({ title: checkinStatusText(item), icon: 'none' })
      return
    }

    if (item.kind === 'video' && item.courseId) {
      const course = findCourse(item.courseId)
      if (!course) {
        Taro.showToast({ title: '绑定的课程已删除', icon: 'none' })
        return
      }
      let target = null as null | { lesson: any; idx: number }
      for (let i = 0; i < course.lessons.length; i++) {
        const lesson = course.lessons[i]
        if (lesson.totalMin > 0 && lesson.watchedMin < lesson.totalMin) {
          target = { lesson: lesson, idx: i + 1 }
          break
        }
      }
      if (!target) {
        Taro.showToast({ title: '这门课已经看完了', icon: 'none' })
        return
      }
      const remain = target.lesson.totalMin - target.lesson.watchedMin
      const input = await promptText(
        '第 ' + target.idx + ' 节 · 还剩 ' + remain + ' 分钟',
        '这次看了多少分钟',
        String(remain)
      )
      if (input == null) return
      const parsed = parseDuration(input)
      if (parsed == null || parsed <= 0) {
        Taro.showToast({ title: '请填写有效分钟数', icon: 'none' })
        return
      }
      const use = Math.min(parsed, remain)
      addCheckinLog(item, { min: use, cid: course.id, lid: target.lesson.id })
      refresh()
      Taro.showToast({ title: '已记 ' + use + ' 分钟', icon: 'success' })
      return
    }

    addCheckinLog(item, {})
    refresh()
    Taro.showToast({ title: '打卡完成', icon: 'success' })
  }

  async function onDeleteCheckin(id: string) {
    const ok = await confirmText('删除循环打卡', '删除后这条打卡的历史记录也会一起消失。', '删除')
    if (!ok) return
    removeCheckin(id)
    refresh()
  }

  function onTapCell(cell: HeatCell) {
    if (cell.future) {
      Taro.showToast({ title: '还没到这天', icon: 'none' })
      return
    }
    if (!(state.activity[cell.key] || 0) && !cell.hasStats && !(state.details[cell.key] || []).length) {
      Taro.showToast({ title: '这天还没有记录', icon: 'none' })
      return
    }
    setDayOpen(cell.key)
  }

  return (
    <View className='page'>
      <View className='masthead'>
        <View>
          <Text className='kicker mono'>STUDY HUB · 学业 · 待办 · 日程</Text>
          <Text className='title'>今日一页</Text>
          <Text className='today-line'>{todayLabel}</Text>
        </View>
        <View className='stamp'>
          <Text className='stamp-num mono'>{streakDays()}</Text>
          <Text className='stamp-label'>连续打卡 · 天</Text>
        </View>
      </View>

      <View className='cols'>
        <View className='panel'>
          <View className='panel-head'>
            <Text className='panel-title'>今天要做什么</Text>
          </View>
        <View className='today-metrics'>
          <View className='metric'>
            <Text className='metric-num mono'>{min}</Text>
            <Text className='metric-cap'>视频时长</Text>
          </View>
          <View className='metric'>
            <Text className='metric-num mono'>{stats.done}</Text>
            <Text className='metric-cap'>完成待办</Text>
          </View>
          <View className='metric'>
            <Text className='metric-num mono metric-num-red'>{stats.checkins}</Text>
            <Text className='metric-cap'>打卡次数</Text>
          </View>
        </View>

        {focus.length === 0 && <Text className='empty'>今天没有到期的事。</Text>}
        {focus.slice(0, 4).map(function (t) {
          return (
            <View className='row' key={t.id} onClick={function () { onToggleTodo(t.id) }}>
              <View className={'dot dot-' + (t.done ? 'far' : tUrgencyClass(t))} />
              <View className='row-main'>
                <Text className='row-title'>{t.title}</Text>
                <Text className='row-sub'>{t.due === today ? '今天到期' : '已逾期 · ' + t.due}</Text>
              </View>
              <Text className='tag'>{t.pri}</Text>
            </View>
          )
        })}
        {focus.length > 4 && (
          <Text className='link-btn' onClick={function () { Taro.switchTab({ url: '/pages/todo/index' }) }}>
            还有 {focus.length - 4} 项，去待办 →
          </Text>
        )}
      </View>

      <View className='panel'>
        <View className='panel-head'>
          <View>
            <Text className='panel-title'>循环打卡</Text>
            <Text className='panel-cap'>每天、每周或每隔几天要做的固定动作</Text>
          </View>
          <Text className='link-btn' onClick={onNewCheckin}>+ 新建</Text>
        </View>

        {state.checkins.length === 0 && (
          <Text className='empty'>还没有循环打卡。比如「每天看一节视频」「每周复盘一次」。</Text>
        )}
        {state.checkins.map(function (item) {
          const can = checkinCanRun(item)
          return (
            <View className='checkin-row' key={item.id}>
              <View className='checkin-main'>
                <Text className='checkin-name'>{item.name}</Text>
                <Text className='checkin-meta'>
                  {checkinCadenceText(item)} · {checkinStatusText(item)}
                  <Text className='checkin-count'>累计 {item.logs.length} 次</Text>
                </Text>
              </View>
              <Text
                className={'btn btn-small' + (can ? ' btn-primary' : ' btn-disabled')}
                onClick={function () { onRunCheckin(item) }}
              >
                {can ? '打卡' : '已完成'}
              </Text>
              <Text className='link-btn' onClick={function () { onDeleteCheckin(item.id) }}>删除</Text>
            </View>
          )
        })}
      </View>
      </View>

      <View className='panel'>
        <View className='panel-head'>
          <View>
            <Text className='panel-title'>学习日历</Text>
            <Text className='panel-cap'>颜色深浅是当天视频时长；点有记录的日期看明细</Text>
          </View>
        </View>

        <View className='heat-wrap'>
          {weeks.map(function (week, wi) {
            return (
              <View className='heat-week' key={wi}>
                {week.map(function (cell) {
                  let cls = 'cell'
                  if (cell.level > 0) cls += ' cell-l' + cell.level
                  if (cell.future) cls += ' cell-future'
                  if (cell.hasStats && cell.level === 0) cls += ' cell-stats'
                  if (cell.today) cls += ' cell-today'
                  return (
                    <View
                      key={cell.key}
                      className={cls}
                      onClick={function () { onTapCell(cell) }}
                    />
                  )
                })}
              </View>
            )
          })}
        </View>

        <View className='legend'>
          <Text className='legend-gap'>视频时长 少</Text>
          <View className='cell legend-cell cell-l0' />
          <View className='cell legend-cell cell-l1' />
          <View className='cell legend-cell cell-l2' />
          <View className='cell legend-cell cell-l3' />
          <View className='cell legend-cell cell-l4' />
          <Text>多</Text>
        </View>
        <View className='legend' style='margin-top:4px'>
          <Text>细红框＝只有待办或打卡；有视频时右下角圆点越深，待办与打卡条数越多</Text>
        </View>
      </View>

      <View className='panel'>
        <View className='panel-head'>
          <View>
            <Text className='panel-title'>云同步</Text>
            <Text className='panel-cap'>
              {!isConfigured()
                ? '还没连云端，数据只在本机'
                : getStatus().state === 'ok'
                  ? '已同步 · rev ' + getCfg().rev
                  : getStatus().message}
            </Text>
          </View>
          <Text className='link-btn' onClick={function () { Taro.navigateTo({ url: '/pages/settings/index' }) }}>
            设置 →
          </Text>
        </View>
      </View>

      {dayOpen && <DayDetail dayKey={dayOpen} onClose={function () { setDayOpen('') }} />}

      {newOpen && (
        <Sheet
          kicker='NEW CHECK-IN'
          title='新建循环打卡'
          onClose={function () { setNewOpen(false) }}
          footer={
            <View className='sheet-foot'>
              <View className='sheet-btn sheet-btn-cancel' onClick={function () { setNewOpen(false) }}>取消</View>
              <View className='sheet-btn sheet-btn-ok' onClick={onCreateCheckin}>保存</View>
            </View>
          }
        >
          <View className='form-group'>
            <Text className='form-label'>要做什么</Text>
            <View className='prompt-field'>
              <Input
                className='prompt-input'
                value={newName}
                maxlength={40}
                placeholder='比如：每天看一节视频'
                placeholderStyle='color:#97a3b1'
                onInput={function (e) { setNewName(e.detail.value) }}
              />
            </View>
          </View>

          <View className='form-group'>
            <Text className='form-label'>频率</Text>
            <View className='chip-row'>
              <Chip on={newCadence === 'daily'} onClick={function () { setNewCadence('daily') }}>每天</Chip>
              <Chip on={newCadence === 'weekly'} onClick={function () { setNewCadence('weekly') }}>每周一次</Chip>
              <Chip on={newCadence === 'interval'} onClick={function () { setNewCadence('interval') }}>每隔几天</Chip>
            </View>
            {newCadence === 'interval' && (
              <View className='stepper'>
                <Text className='stepper-btn' onClick={function () { setNewDays(Math.max(2, newDays - 1)) }}>−</Text>
                <Text className='stepper-num mono'>{newDays}</Text>
                <Text className='stepper-btn' onClick={function () { setNewDays(Math.min(30, newDays + 1)) }}>＋</Text>
                <Text className='stepper-cap'>天一次（2–30）</Text>
              </View>
            )}
          </View>

          <View className='form-group'>
            <Text className='form-label'>类型</Text>
            <View className='chip-row'>
              <Chip on={newKind === 'custom'} onClick={function () { setNewKind('custom') }}>自定义打卡</Chip>
              <Chip on={newKind === 'video'} onClick={function () { setNewKind('video') }}>视频打卡</Chip>
            </View>
            {newKind === 'video' && (
              state.courses.length === 0 ? (
                <Text className='form-hint'>还没有课程，先去「课程」添加一门。</Text>
              ) : (
                <View className='chip-row' style='margin-top:10px'>
                  {state.courses.map(function (c) {
                    return (
                      <Chip key={c.id} on={newCourse === c.id} onClick={function () { setNewCourse(c.id) }}>
                        {c.name}
                      </Chip>
                    )
                  })}
                </View>
              )
            )}
          </View>
        </Sheet>
      )}

      <PromptHost />
    </View>
  )
}

function tUrgencyClass(t: { due: string; dueTime: string }): string {
  const dl = new Date(
    Number(t.due.slice(0, 4)),
    Number(t.due.slice(5, 7)) - 1,
    Number(t.due.slice(8, 10)),
    23,
    59,
    0,
    0
  ).getTime()
  const diff = dl - Date.now()
  if (diff < 0) return 'overdue'
  if (diff <= 24 * 3600 * 1000) return 'soon'
  if (diff <= 7 * 24 * 3600 * 1000) return 'week'
  return 'far'
}
