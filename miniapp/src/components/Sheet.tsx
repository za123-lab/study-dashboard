import type { ReactNode } from 'react'
import { Text, View } from '@tarojs/components'
import './index.scss'

interface SheetProps {
  kicker: string
  title: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
}

/** 纸感表单面板：手机上贴底，宽屏居中 */
export default function Sheet(props: SheetProps) {
  return (
    <View className='sheet-mask' onClick={props.onClose}>
      <View className='sheet-card' onClick={function (e) { e.stopPropagation() }}>
        <View className='sheet-head'>
          <View className='sheet-head-main'>
            <Text className='sheet-kicker mono'>{props.kicker}</Text>
            <Text className='sheet-title'>{props.title}</Text>
          </View>
          <Text className='sheet-close' onClick={props.onClose}>关闭</Text>
        </View>
        <View className='sheet-body'>{props.children}</View>
        <View className='sheet-foot'>{props.footer}</View>
      </View>
    </View>
  )
}

interface ChipProps {
  on: boolean
  children: ReactNode
  onClick: () => void
}

export function Chip(props: ChipProps) {
  return (
    <View
      className={'chip' + (props.on ? ' chip-on' : '')}
      onClick={props.onClick}
    >
      {props.children}
    </View>
  )
}
