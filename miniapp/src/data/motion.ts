import { useCallback, useEffect, useRef, useState } from 'react'
// 注意：此处原有 usePageEnter 页面入场动画已移除——tab 切换属中频导航，
// 淡入会造成内容"先消失再出现"的闪烁，原生 tabBar 也是瞬时切换。

const DISMISS_MS = 220

/**
 * 弹窗退场：关闭时先播退场动画，动画结束再真正卸载。
 * 父页面的条件渲染逻辑完全不用改——只是把 onClose 的调用推迟到动画结束。
 * 退场期间弹窗仍挂载，overlay 计数保持、底栏继续隐藏；卸载后才一起恢复。
 */
export function useDismiss(onClose: () => void) {
  const [closing, setClosing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cb = useRef(onClose)
  cb.current = onClose

  useEffect(
    function () {
      return function () {
        if (timer.current) clearTimeout(timer.current)
      }
    },
    []
  )

  const dismiss = useCallback(function () {
    if (timer.current) return // 退场中重复点击直接忽略
    setClosing(true)
    timer.current = setTimeout(function () {
      timer.current = null
      cb.current()
    }, DISMISS_MS)
  }, [])

  // PromptHost 这类常驻宿主：新请求进来时清掉上次的退场态，保证入场能重播
  const reset = useCallback(function () {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setClosing(false)
  }, [])

  return { closing: closing, dismiss: dismiss, reset: reset }
}
