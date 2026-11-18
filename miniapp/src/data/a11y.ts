import Taro from '@tarojs/taro'
import { useEffect, useState } from 'react'

/**
 * 无障碍偏好：减少动效。
 * 微信小程序 WXSS 的 @media (prefers-reduced-motion) 在各基础库 / WebView 上
 * 映射并不稳定，所以这里提供可靠的应用内开关：持久化偏好，各页面根节点通过
 * useReduceMotion() 订阅并挂上 `reduce-motion` class，SCSS 里的降级规则
 * 同时挂到该 class（与 @media 共用一份）。
 */

const KEY = 'studyhub_reduce_motion'

let enabled = readStored()
const listeners: Array<(v: boolean) => void> = []

function readStored(): boolean {
  try {
    return Taro.getStorageSync(KEY) === true
  } catch (err) {
    return false
  }
}

export function isReduceMotion(): boolean {
  return enabled
}

export function setReduceMotion(v: boolean): void {
  enabled = v
  try {
    Taro.setStorageSync(KEY, v)
  } catch (err) {
    // 存储异常不影响本次会话的偏好
  }
  listeners.forEach(function (fn) {
    fn(enabled)
  })
}

export function toggleReduceMotion(): boolean {
  setReduceMotion(!enabled)
  return enabled
}

/**
 * 页面根节点订阅减少动效偏好。
 * 返回当前值；把返回值拼进根 View 的 className，并用返回的 class 字符串
 * 让 SCSS 降级规则生效（如 `className={'page ' + motionClass}`）。
 */
export function useReduceMotion(): { enabled: boolean; motionClass: string } {
  const [value, setValue] = useState(enabled)
  useEffect(function () {
    setValue(enabled)
    return onReduceMotionChange(setValue)
  }, [])
  return { enabled: value, motionClass: value ? ' reduce-motion' : '' }
}

export function onReduceMotionChange(fn: (v: boolean) => void): () => void {
  listeners.push(fn)
  return function () {
    const i = listeners.indexOf(fn)
    if (i >= 0) listeners.splice(i, 1)
  }
}

/** App 启动时从存储恢复偏好（模块加载已读一次，这里保证时机确定） */
export function initA11y(): void {
  enabled = readStored()
  listeners.forEach(function (fn) {
    fn(enabled)
  })
}
