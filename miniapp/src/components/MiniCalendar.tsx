import { useState } from 'react'
import { Text, View } from '@tarojs/components'
import { addDays, dateKey, keyToDate, todayKey } from '../data/date'
import './index.scss'

const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日']

interface Props {
  value: string
  onChange: (key: string) => void
}

/** 表单里内嵌的月历，点哪天就选哪天 */
export default function MiniCalendar(props: Props) {
  const initial = keyToDate(props.value || todayKey())
  const [year, setYear] = useState(initial.getFullYear())
  const [month, setMonth] = useState(initial.getMonth())
  const today = todayKey()

  function shift(delta: number) {
    const d = new Date(year, month + delta, 1)
    setYear(d.getFullYear())
    setMonth(d.getMonth())
  }

  const first = new Date(year, month, 1)
  const offset = first.getDay() === 0 ? 6 : first.getDay() - 1
  const gridStart = addDays(first, -offset)
  const cells: string[] = []
  for (let i = 0; i < 42; i++) cells.push(dateKey(addDays(gridStart, i)))

  return (
    <View className='mini-cal'>
      <View className='mini-cal-head'>
        <Text className='mini-cal-nav' onClick={function () { shift(-1) }}>‹</Text>
        <Text className='mini-cal-month mono'>{year} 年 {month + 1} 月</Text>
        <Text className='mini-cal-nav' onClick={function () { shift(1) }}>›</Text>
      </View>
      <View className='mini-cal-week'>
        {WEEK_CN.map(function (w) {
          return <View className='mini-cal-wd' key={w}>{w}</View>
        })}
      </View>
      <View className='mini-cal-grid'>
        {cells.map(function (k) {
          const d = keyToDate(k)
          const cls =
            'mini-cell' +
            (d.getMonth() !== month ? ' mini-cell-out' : '') +
            (k === props.value ? ' mini-cell-on' : '') +
            (k === today ? ' mini-cell-today' : '')
          return (
            <View className={cls} key={k} onClick={function () { props.onChange(k) }}>
              {d.getDate()}
            </View>
          )
        })}
      </View>
    </View>
  )
}
