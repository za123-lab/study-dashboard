import { View, Text } from '@tarojs/components'
import { fmtDur, keyToDate, WEEK_CN } from '../data/date'
import {
  dayStats,
  doneTodosOn,
  findCourse,
  getState,
  todosOnDay,
  todoDayLeftText,
} from '../data/store'
import type { CheckinLog, Checkin, DetailItem } from '../data/types'
import './index.scss'

interface Props {
  dayKey: string
  onClose: () => void
}

function lessonName(entry: DetailItem): string {
  const course = findCourse(entry.cid)
  const idxText = entry.idx ? '第 ' + entry.idx + ' 节' : '一节课时'
  if (!course) return '已删除的课程 · ' + idxText
  return course.name + ' · ' + idxText
}

export default function DayDetail(props: Props) {
  const state = getState()
  const key = props.dayKey
  const min = state.activity[key] || 0
  const real = state.details[key] || []
  const items: { entry: DetailItem; demo: boolean }[] = real.map(function (e) {
    return { entry: e, demo: false }
  })
  const stats = dayStats(key)
  const dayTodos = todosOnDay(key)
  const doneTodos = doneTodosOn(key)
  const checkinLogs: { item: Checkin; log: CheckinLog }[] = []
  state.checkins.forEach(function (item) {
    item.logs.forEach(function (log) {
      if (log.date === key) checkinLogs.push({ item: item, log: log })
    })
  })
  checkinLogs.sort(function (a, b) {
    return (a.log.at || 0) - (b.log.at || 0)
  })

  const d = keyToDate(key)
  const title = d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · ' + WEEK_CN[d.getDay()]
  const isEmpty =
    !items.length && !min && !dayTodos.length && !checkinLogs.length && !stats.done && !doneTodos.length

  return (
    <View className='day-mask' onClick={props.onClose}>
      <View className='day-card' onClick={function (e) { e.stopPropagation() }}>
        <View className='day-head'>
          <Text className='day-title'>{title}</Text>
          <Text className='day-close' onClick={props.onClose}>关闭</Text>
        </View>

        <Text className='day-total mono'>
          {min ? '视频时长 ' + min + ' 分钟（' + fmtDur(min) + '）' : '这天没有视频记录'}
        </Text>
        <Text className='day-metrics'>
          完成待办 {stats.done} 项 · 打卡 {stats.checkins} 次
        </Text>

        {items.length > 0 && (
          <View className='day-block'>
            <Text className='day-h'>视频明细 · {items.length} 条</Text>
            {items.map(function (rec, i) {
              return (
                <View className='day-line' key={i}>
                  <Text className='day-line-name'>{lessonName(rec.entry)}</Text>
                  <Text className='day-line-min mono'>+{rec.entry.min} 分钟</Text>
                </View>
              )
            })}
          </View>
        )}

        {dayTodos.length > 0 && (
          <View className='day-block'>
            <Text className='day-h'>当天待办 · {dayTodos.length} 项</Text>
            {dayTodos.map(function (t) {
              return (
                <View className='day-line' key={t.id}>
                  <Text className={'day-line-name' + (t.done ? ' day-line-done' : '')}>{t.title}</Text>
                  <Text className='day-line-min'>{todoDayLeftText(t)}</Text>
                </View>
              )
            })}
          </View>
        )}

        {checkinLogs.length > 0 && (
          <View className='day-block'>
            <Text className='day-h'>当天打卡 · {checkinLogs.length} 次</Text>
            {checkinLogs.map(function (rec, i) {
              const sub: string[] = []
              if (rec.log.min) sub.push('+' + rec.log.min + ' 分钟视频')
              if (rec.log.note) sub.push(rec.log.note)
              if (!sub.length) sub.push('已完成')
              return (
                <View className='day-line' key={i}>
                  <Text className='day-line-name'>{rec.item.name}</Text>
                  <Text className='day-line-min'>{sub.join(' · ')}</Text>
                </View>
              )
            })}
          </View>
        )}

        {isEmpty && <Text className='empty'>这天没有安排，也没有记录。</Text>}
        {!isEmpty && !items.length && <Text className='empty'>这天没有视频明细。</Text>}
      </View>
    </View>
  )
}
