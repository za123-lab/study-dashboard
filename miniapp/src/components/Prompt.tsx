import { useEffect, useState } from 'react'
import { Input, Text, View } from '@tarojs/components'
import './index.scss'

interface InputRequest {
  kind: 'input'
  title: string
  placeholder: string
  defaultValue: string
  hint: string
  resolve: (value: string | null) => void
}

interface ConfirmRequest {
  kind: 'confirm'
  title: string
  message: string
  okText: string
  resolve: (ok: boolean) => void
}

type Request = InputRequest | ConfirmRequest

let pending: Request | null = null
const hosts: Array<(req: Request | null) => void> = []

function publish() {
  hosts.forEach(function (fn) {
    fn(pending)
  })
}

function cancelPending() {
  const cur = pending
  if (!cur) return
  pending = null
  if (cur.kind === 'input') cur.resolve(null)
  else cur.resolve(false)
  publish()
}

export function promptText(
  title: string,
  placeholder: string,
  defaultValue?: string,
  hint?: string
): Promise<string | null> {
  cancelPending()
  return new Promise(function (resolve) {
    pending = {
      kind: 'input',
      title: title,
      placeholder: placeholder,
      defaultValue: defaultValue || '',
      hint: hint || '',
      resolve: resolve,
    }
    publish()
  })
}

export function confirmText(title: string, message: string, okText?: string): Promise<boolean> {
  cancelPending()
  return new Promise(function (resolve) {
    pending = {
      kind: 'confirm',
      title: title,
      message: message,
      okText: okText || '确定',
      resolve: resolve,
    }
    publish()
  })
}

/** 挂在页面里当输入/确认面板；隐藏的 tab 页不参与绘制，所有宿主共享同一份请求状态 */
export function PromptHost() {
  const [req, setReq] = useState<Request | null>(null)
  const [value, setValue] = useState('')

  useEffect(function () {
    function sync(next: Request | null) {
      setReq(next)
      setValue(next && next.kind === 'input' ? next.defaultValue : '')
    }
    hosts.push(sync)
    if (pending) sync(pending)
    return function () {
      const i = hosts.indexOf(sync)
      if (i >= 0) hosts.splice(i, 1)
    }
  }, [])

  function close(result: string | null) {
    const cur = pending
    if (!cur) return
    pending = null
    publish()
    if (cur.kind === 'input') cur.resolve(result)
    else cur.resolve(result !== null)
  }

  if (!req) return null

  return (
    <View className='sheet-mask' onClick={function () { close(null) }}>
      <View className='sheet-card' onClick={function (e) { e.stopPropagation() }}>
        <View className='sheet-head'>
          <View className='sheet-head-main'>
            <Text className='sheet-kicker mono'>{req.kind === 'input' ? '写一笔 · NOTE' : '确认 · CONFIRM'}</Text>
            <Text className='sheet-title'>{req.title}</Text>
          </View>
          <Text className='sheet-close' onClick={function () { close(null) }}>关闭</Text>
        </View>

        <View className='sheet-body'>
          {req.kind === 'input' ? (
            <View className='form-group'>
              {!!req.hint && <Text className='form-hint'>{req.hint}</Text>}
              <View className='prompt-field'>
                <Input
                  className='prompt-input'
                  value={value}
                  maxlength={80}
                  placeholder={req.placeholder}
                  placeholderStyle='color:#97a3b1'
                  confirmType='done'
                  onInput={function (e) {
                    setValue(e.detail.value)
                  }}
                  onConfirm={function () {
                    close(value.trim())
                  }}
                />
              </View>
            </View>
          ) : (
            <Text className='sheet-msg'>{req.message}</Text>
          )}
        </View>

        <View className='sheet-foot'>
          <View className='sheet-btn sheet-btn-cancel' onClick={function () { close(null) }}>
            取消
          </View>
          <View
            className='sheet-btn sheet-btn-ok'
            onClick={function () { close(req.kind === 'input' ? value.trim() : 'ok') }}
          >
            {req.kind === 'input' ? '确定' : req.okText}
          </View>
        </View>
      </View>
    </View>
  )
}
