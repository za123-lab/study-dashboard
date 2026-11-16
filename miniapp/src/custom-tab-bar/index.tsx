import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { View, Text, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { TABBAR_OVERLAY_EVENT } from '../data/overlay'
import './index.scss'

interface TabItem {
  path: string
  text: string
  icon: string
  iconOn: string
}

const TABS: TabItem[] = [
  { path: 'pages/study/index', text: '学习', icon: '/assets/tabbar/study.png', iconOn: '/assets/tabbar/study-on.png' },
  { path: 'pages/todo/index', text: '待办', icon: '/assets/tabbar/todo.png', iconOn: '/assets/tabbar/todo-on.png' },
  { path: 'pages/calendar/index', text: '日历', icon: '/assets/tabbar/calendar.png', iconOn: '/assets/tabbar/calendar-on.png' },
  { path: 'pages/courses/index', text: '课程', icon: '/assets/tabbar/courses.png', iconOn: '/assets/tabbar/courses-on.png' },
]

export const TAB_SELECT_EVENT = 'custom-tabbar:select'

export interface CustomTabBarRef {
  setSelected: (index: number) => void
}

const CustomTabBar = forwardRef<CustomTabBarRef>(function CustomTabBar(_props, ref) {
  const [selected, setSelected] = useState(0)
  const [hidden, setHidden] = useState(false)
  const selectedRef = useRef(0)

  const apply = useCallback(function (index: number) {
    if (index < 0 || index >= TABS.length) return
    selectedRef.current = index
    setSelected(index)
  }, [])

  useImperativeHandle(ref, function () {
    return { setSelected: apply }
  }, [apply])

  useEffect(function () {
    function onOverlay(on: boolean) {
      setHidden(on)
    }
    Taro.eventCenter.on(TAB_SELECT_EVENT, apply)
    Taro.eventCenter.on(TABBAR_OVERLAY_EVENT, onOverlay)
    // 首次挂载按当前路由推断选中项，避免刚进小程序时短暂高亮「学习」
    const pages = Taro.getCurrentPages()
    const route = pages[pages.length - 1] && pages[pages.length - 1].route
    if (route) {
      apply(TABS.findIndex(function (t) { return t.path === route }))
    }
    return function () {
      Taro.eventCenter.off(TAB_SELECT_EVENT, apply)
      Taro.eventCenter.off(TABBAR_OVERLAY_EVENT, onOverlay)
    }
  }, [apply])

  const onTap = useCallback(function (index: number) {
    if (index === selectedRef.current) return
    const tab = TABS[index]
    apply(index)
    Taro.switchTab({ url: '/' + tab.path })
  }, [apply])

  // 弹层出现时底栏滑出屏幕并隐藏。用两个状态类各带一段关键帧动画
  // （transition 在底栏的独立渲染层不可靠，关键帧类一加上必定播放）。
  // opacity 0 + 位移出视口 + visibility，独立层也看不见、点不到。
  return (
    <View className={'tabbar ' + (hidden ? 'tabbar-hidden' : 'tabbar-shown')}>
      <View className='tabbar-surface'>
        {TABS.map(function (tab, i) {
          const on = i === selected
          return (
            <View
              key={tab.path}
              className={'tabbar-item' + (on ? ' tabbar-item-on' : '')}
              hoverClass='tabbar-item-hover'
              onClick={function () { onTap(i) }}
            >
              <View className='tabbar-icon-wrap'>
                <Image className='tabbar-icon' src={on ? tab.iconOn : tab.icon} />
              </View>
              <Text className='tabbar-text'>{tab.text}</Text>
            </View>
          )
        })}
      </View>
    </View>
  )
})

export default CustomTabBar
