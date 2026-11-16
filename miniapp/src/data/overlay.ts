import Taro from '@tarojs/taro'

/**
 * 弹层计数器。
 * 微信自定义 tabBar 由框架注入在独立层，页面内的 z-index 压不住它，
 * 所以弹层出现时直接让 tabBar 隐藏。用计数而非布尔，兼容弹层嵌套。
 */
export const TABBAR_OVERLAY_EVENT = 'tabbar:overlay'

let count = 0

function publish() {
  Taro.eventCenter.trigger(TABBAR_OVERLAY_EVENT, count > 0)
}

export function pushOverlay(): void {
  count++
  publish()
}

export function popOverlay(): void {
  if (count > 0) count--
  publish()
}
