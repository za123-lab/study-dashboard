import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Text, View } from '@tarojs/components'
import { pushOverlay, popOverlay } from '../data/overlay'
import { useDismiss } from '../data/motion'
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
  const { closing, dismiss } = useDismiss(props.onClose)

  useEffect(function () {
    pushOverlay()
    return function () {
      popOverlay()
    }
  }, [])

  const maskCls = 'sheet-mask' + (closing ? ' mask-closing' : '')
  const cardCls = 'sheet-card' + (closing ? ' card-closing' : '')

  return (
    <View className={maskCls} onClick={dismiss}>
      <View className={cardCls} onClick={function (e) { e.stopPropagation() }}>
        <View className='sheet-head'>
          <View className='sheet-head-main'>
            <Text className='sheet-kicker mono'>{props.kicker}</Text>
            <Text className='sheet-title'>{props.title}</Text>
          </View>
          <Text className='sheet-close' onClick={dismiss}>关闭</Text>
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
