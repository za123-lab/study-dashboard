import { useCallback, useState } from 'react'
import { View, Text } from '@tarojs/components'
import { useDidShow } from '@tarojs/taro'
import DayDetail from '../../components/DayDetail'
import { dateKey, todayKey } from '../../data/date'
import { calUrgency, dayStats, getState, reload, todosOnDay } from '../../data/store'
import { autoSync } from '../../data/cloud'
import './index.scss'

const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日']

interface Cell {
  key: string
  day: number
  inMonth: boolean
  min: number
  done: number
  checkins: number
  todos: { urgency: string }[]
}

function buildMonth(year: number, month: number): Cell[] {
  const state = getState()
  const first = new Date(year, month, 1)
  const offset = (first.getDay() + 6) % 7 // 周一为第一列
  const start = new Date(year, month, 1 - offset)
  const cells: Cell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const key = dateKey(d)
    const stats = dayStats(key)
    cells.push({
      key: key,
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      min: state.activity[key] || 0,
      done: stats.done,
      checkins: stats.checkins,
      todos: todosOnDay(key).map(function (t) {
        return { urgency: calUrgency(t) }
      }),
    })
  }
  return cells
}

export default function CalendarPage() {
  const [, setTick] = useState(0)
  const [offset, setOffset] = useState(0)
  const [dayOpen, setDayOpen] = useState('')

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

  const now = new Date()
  const base = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const year = base.getFullYear()
  const month = base.getMonth()
  const cells = buildMonth(year, month)
  const today = todayKey()

  let monthMin = 0
  let monthDays = 0
  cells.forEach(function (c) {
    if (!c.inMonth) return
    if (c.min > 0) {
      monthMin += c.min
      monthDays++
    }
  })

  function onCell(c: Cell) {
    setDayOpen(c.key)
  }

  return (
    <View className='page'>
      <View className='masthead'>
        <View>
          <Text className='kicker mono'>CALENDAR</Text>
          <Text className='title'>学习日历</Text>
          <Text className='today-line'>点任意一天，看当天视频、完成待办与打卡</Text>
        </View>
      </View>

      <View className='panel cal-panel'>
        <View className='cal-head'>
          <Text
            className='cal-nav'
            onClick={function () { setOffset(offset - 1) }}
          >
            ← 上月
          </Text>
          <Text className='cal-month'>
            {year} 年 {month + 1} 月
          </Text>
          <Text
            className='cal-nav'
            onClick={function () { setOffset(offset + 1) }}
          >
            下月 →
          </Text>
        </View>

        <View className='cal-weekbar'>
          {WEEK_HEAD.map(function (w) {
            return (
              <Text className='cal-week' key={w}>
                {w}
              </Text>
            )
          })}
        </View>

        <View className='cal-grid'>
          {cells.map(function (c) {
            let innerCls = 'cal-inner'
            if (!c.inMonth) innerCls += ' cal-inner-out'
            if (c.key === today) innerCls += ' cal-inner-today'
            return (
              <View className='cal-cell' key={c.key} onClick={function () { onCell(c) }}>
                <View className={innerCls}>
                  <Text className='cal-num mono'>{c.day}</Text>
                  {c.min > 0 && <Text className='cal-min mono'>{c.min}′</Text>}
                  {(c.done > 0 || c.checkins > 0) && (
                    <Text className='cal-stat mono'>
                      {c.done > 0 ? '✓' + c.done : ''}
                      {c.done > 0 && c.checkins > 0 ? ' ' : ''}
                      {c.checkins > 0 ? '卡' + c.checkins : ''}
                    </Text>
                  )}
                  {c.todos.length > 0 && (
                    <View className='cal-dots'>
                      {c.todos.slice(0, 3).map(function (t, i) {
                        return (
                          <View
                            key={i}
                            className={'cal-dot'}
                            style={'background:' + urgencyColor(t.urgency)}
                          />
                        )
                      })}
                    </View>
                  )}
                </View>
              </View>
            )
          })}
        </View>

        <View className='cal-summary'>
          <Text>本月学习 {monthDays} 天</Text>
          <Text>视频共 {monthMin} 分钟</Text>
        </View>
      </View>

      {dayOpen && <DayDetail dayKey={dayOpen} onClose={function () { setDayOpen('') }} />}
    </View>
  )
}

function urgencyColor(urgency: string): string {
  if (urgency === 'overdue') return '#c0453a'
  if (urgency === 'soon') return '#b4741f'
  if (urgency === 'week') return '#a08a2c'
  return '#6f8398'
}
