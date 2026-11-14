import { useCallback, useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Sheet, { Chip } from '../../components/Sheet'
import MiniCalendar from '../../components/MiniCalendar'
import { addDays, dateKey, makeId, todayKey } from '../../data/date'
import {
  commit,
  getState,
  reload,
  sortedTodos,
  todoDayLeftText,
  todoUrgency,
  toggleTodo,
  calUrgency,
} from '../../data/store'
import type { Todo } from '../../data/types'
import { TODO_CATS } from '../../data/types'
import { TODO_IMPORT_PROMPT, parseTodoImport } from '../../data/todoImport'
import type { TodoImportResult } from '../../data/todoImport'
import { autoSync } from '../../data/cloud'
import './index.scss'

type Filter = 'open' | 'done' | 'all'

export default function TodoPage() {
  const [, setTick] = useState(0)
  const [filter, setFilter] = useState<Filter>('open')
  const [newOpen, setNewOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState<'today' | 'tomorrow' | 'custom' | 'none'>('today')
  const [customDue, setCustomDue] = useState(todayKey())
  const [newPri, setNewPri] = useState<Todo['pri']>('P1')
  const [newCat, setNewCat] = useState<Todo['cat']>('study')
  const [catFilter, setCatFilter] = useState<'all' | Todo['cat']>('all')
  const [editOpen, setEditOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editDue, setEditDue] = useState('')
  const [editTime, setEditTime] = useState('')
  const [editPri, setEditPri] = useState<Todo['pri']>('P1')
  const [editCat, setEditCat] = useState<Todo['cat']>('study')
  const [editNote, setEditNote] = useState('')
  const [editLink, setEditLink] = useState('')
  const [impOpen, setImpOpen] = useState(false)
  const [impResult, setImpResult] = useState<TodoImportResult | null>(null)

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

  const all = sortedTodos()
  const list = all.filter(function (t) {
    if (catFilter !== 'all' && t.cat !== catFilter) return false
    if (filter === 'open') return !t.done
    if (filter === 'done') return t.done
    return true
  })
  const openCount = all.filter(function (t) {
    return !t.done
  }).length

  function refresh() {
    setTick(function (n) {
      return n + 1
    })
  }

  function onAdd() {
    setNewTitle('')
    setNewDue('today')
    setCustomDue(todayKey())
    setNewPri('P1')
    setNewCat('study')
    setNewOpen(true)
  }

  function onCreateTodo() {
    const title = newTitle.trim()
    if (!title) {
      Taro.showToast({ title: '标题不能为空', icon: 'none' })
      return
    }

    let due = todayKey()
    if (newDue === 'tomorrow') due = dateKey(addDays(new Date(), 1))
    if (newDue === 'custom') due = customDue
    if (newDue === 'none') due = ''

    commit(function () {
      getState().todos.push({
        id: makeId(),
        title: title,
        cat: newCat,
        due: due,
        dueTime: '',
        pri: newPri,
        done: false,
        doneAt: null,
        note: '',
        link: '',
      })
    })
    setNewOpen(false)
    refresh()
    Taro.showToast({ title: '已添加', icon: 'success' })
  }

  function onToggle(id: string) {
    toggleTodo(id)
    refresh()
  }

  function openEdit(t: Todo) {
    setEditId(t.id)
    setEditTitle(t.title)
    setEditDue(t.due || '')
    setEditTime(t.dueTime || '')
    setEditPri(t.pri)
    setEditCat(t.cat)
    setEditNote(t.note || '')
    setEditLink(t.link || '')
    setEditOpen(true)
  }

  function onSaveEdit() {
    const title = editTitle.trim()
    if (!title) {
      Taro.showToast({ title: '标题不能为空', icon: 'none' })
      return
    }
    commit(function () {
      getState().todos.forEach(function (t) {
        if (t.id !== editId) return
        t.title = title.slice(0, 60)
        t.due = editDue
        t.dueTime = editTime.trim()
        t.pri = editPri
        t.cat = editCat
        t.note = editNote.trim()
        t.link = editLink.trim()
      })
    })
    setEditOpen(false)
    refresh()
    Taro.showToast({ title: '已保存', icon: 'success' })
  }

  function onDeleteTodo(t: Todo) {
    commit(function () {
      const s = getState()
      s.todos = s.todos.filter(function (x) {
        return x.id !== t.id
      })
    })
    refresh()
  }

  function onCopyLink(url: string) {
    Taro.setClipboardData({ data: url }).then(function () {
      Taro.showToast({ title: '链接已复制', icon: 'success' })
    })
  }

  function onOpenImport() {
    setImpResult(null)
    setImpOpen(true)
  }

  function onCopyPrompt() {
    Taro.setClipboardData({ data: TODO_IMPORT_PROMPT }).then(function () {
      Taro.showToast({ title: '提示词已复制', icon: 'success' })
    })
  }

  async function onReadImport() {
    let text = ''
    try {
      const clip = await Taro.getClipboardData()
      text = String((clip && clip.data) || '')
    } catch (err) {
      Taro.showToast({ title: '读不到剪贴板', icon: 'none' })
      return
    }
    setImpResult(parseTodoImport(text, getState().todos))
  }

  function onCommitImport() {
    const items = impResult && impResult.items ? impResult.items : []
    if (!items.length) {
      Taro.showToast({ title: '没有可写入的待办', icon: 'none' })
      return
    }
    commit(function () {
      const s = getState()
      items.forEach(function (it) {
        s.todos.push({
          id: makeId(),
          title: it.title,
          cat: it.cat,
          due: it.due,
          dueTime: it.dueTime,
          pri: it.pri,
          done: false,
          doneAt: null,
          note: it.note,
          link: it.link,
        })
      })
    })
    setImpOpen(false)
    setImpResult(null)
    refresh()
    Taro.showToast({ title: '已导入 ' + items.length + ' 条', icon: 'success' })
  }

  function onLongPress(t: Todo) {
    Taro.showActionSheet({ itemList: ['编辑这条待办', '删除这条待办'] })
      .then(function (res) {
        if (res.tapIndex === 0) {
          openEdit(t)
          return
        }
        onDeleteTodo(t)
      })
      .catch(function () {})
  }

  return (
    <View className='page'>
      <View className='masthead'>
        <View>
          <Text className='kicker mono'>TODO</Text>
          <Text className='title'>待办</Text>
          <Text className='today-line'>还有 {openCount} 项没做</Text>
        </View>
      </View>

      <View className='seg'>
        <Text
          className={'seg-item' + (filter === 'open' ? ' seg-item-on' : '')}
          onClick={function () { setFilter('open') }}
        >
          未完成 {openCount}
        </Text>
        <Text
          className={'seg-item' + (filter === 'done' ? ' seg-item-on' : '')}
          onClick={function () { setFilter('done') }}
        >
          已完成
        </Text>
        <Text
          className={'seg-item' + (filter === 'all' ? ' seg-item-on' : '')}
          onClick={function () { setFilter('all') }}
        >
          全部
        </Text>
      </View>

      <View className='todo-cats'>
        <Chip on={catFilter === 'all'} onClick={function () { setCatFilter('all') }}>全部</Chip>
        {(['study', 'contest', 'event', 'other'] as Todo['cat'][]).map(function (c) {
          return (
            <Chip key={c} on={catFilter === c} onClick={function () { setCatFilter(c) }}>
              {TODO_CATS[c]}
            </Chip>
          )
        })}
      </View>

      <View className='todo-top'>
        <Text className='todo-count'>
          {filter === 'open' ? '按截止时间排序' : filter === 'done' ? '最近完成的在前' : '全部 ' + all.length + ' 项'}
        </Text>
        <View className='todo-actions'>
          <Text className='todo-add' onClick={onOpenImport}>批量导入</Text>
          <Text className='todo-add' onClick={onAdd}>+ 新建</Text>
        </View>
      </View>

      <View className='panel todo-list' style='padding-top:4px;padding-bottom:4px'>
        {list.length === 0 && <Text className='empty'>这里还是空的。</Text>}
        {list.map(function (t) {
          const urgency = todoUrgency(t)
          const cls = t.done ? 'far' : urgency === 'no-deadline' ? 'far' : calUrgency(t)
          return (
            <View
              className='todo-row'
              key={t.id}
              onLongPress={function () { onLongPress(t) }}
            >
              <View
                className={'todo-box' + (t.done ? ' todo-box-on' : '')}
                onClick={function () { onToggle(t.id) }}
              >
                {t.done ? '✓' : ''}
              </View>
              <View className='todo-body' onClick={function () { onToggle(t.id) }}>
                <Text className={'todo-title' + (t.done ? ' todo-title-done' : '')}>{t.title}</Text>
                <Text className='todo-meta'>
                  {TODO_CATS[t.cat]} · {t.pri}
                  {t.due ? ' · ' + t.due.slice(5) + (t.dueTime ? ' ' + t.dueTime : '') : ' · 无截止'}
                </Text>
                {!!t.note && <Text className='todo-note'>{t.note}</Text>}
                {!!t.link && (
                  <Text
                    className='todo-link'
                    onClick={function (e) {
                      e.stopPropagation()
                      onCopyLink(t.link)
                    }}
                  >
                    链接 ↗
                  </Text>
                )}
              </View>
              <View className='todo-side'>
                <Text className={'todo-left todo-left-' + cls}>{todoDayLeftText(t)}</Text>
              </View>
            </View>
          )
        })}
      </View>
      <Text className='empty'>点方框打勾；长按一条待办可以编辑或删除</Text>

      {impOpen && (
        <Sheet
          kicker='BULK IMPORT'
          title='批量导入待办'
          onClose={function () { setImpOpen(false) }}
          footer={
            <View className='sheet-foot'>
              <View className='sheet-btn sheet-btn-cancel' onClick={function () { setImpOpen(false) }}>取消</View>
              <View className='sheet-btn sheet-btn-ok' onClick={onCommitImport}>
                写入 {impResult && impResult.items ? impResult.items.length : 0} 条
              </View>
            </View>
          }
        >
          <Text className='imp-tip'>
            先复制提示词，把任务原文一起发给 AI；拿到返回的 JSON 后复制，再点「读取剪贴板」预览，确认后写入。
          </Text>

          <View className='imp-btns'>
            <View className='imp-btn' onClick={onCopyPrompt}>复制提示词</View>
            <View className='imp-btn' onClick={onReadImport}>读取剪贴板</View>
          </View>

          {impResult && impResult.error && (
            <View className='imp-error'>
              <Text className='imp-error-text'>{impResult.error}</Text>
            </View>
          )}

          {impResult && !impResult.error && (
            <View className='imp-preview'>
              <Text className='imp-summary'>
                可写入 {impResult.items ? impResult.items.length : 0} 条
                {impResult.skipped && impResult.skipped.length
                  ? ' · 跳过 ' + impResult.skipped.length + ' 条重复'
                  : ''}
              </Text>
              {(impResult.items || []).slice(0, 6).map(function (it, i) {
                return (
                  <View className='imp-row' key={i}>
                    <Text className='imp-title'>{it.title}</Text>
                    <Text className='imp-meta'>
                      {TODO_CATS[it.cat]} · {it.pri}
                      {it.due ? ' · ' + it.due : ' · 无截止'}
                    </Text>
                  </View>
                )
              })}
              {impResult.items && impResult.items.length > 6 && (
                <Text className='imp-more'>还有 {impResult.items.length - 6} 条…</Text>
              )}
            </View>
          )}
        </Sheet>
      )}

      {newOpen && (
        <Sheet
          kicker='NEW TODO'
          title='新建待办'
          onClose={function () { setNewOpen(false) }}
          footer={
            <View className='sheet-foot'>
              <View className='sheet-btn sheet-btn-cancel' onClick={function () { setNewOpen(false) }}>取消</View>
              <View className='sheet-btn sheet-btn-ok' onClick={onCreateTodo}>保存</View>
            </View>
          }
        >
          <View className='form-group'>
            <Text className='form-label'>要做什么</Text>
            <View className='prompt-field'>
              <Input
                className='prompt-input'
                value={newTitle}
                maxlength={60}
                placeholder='比如：看完第三章'
                placeholderStyle='color:#97a3b1'
                onInput={function (e) { setNewTitle(e.detail.value) }}
              />
            </View>
          </View>

          <View className='form-group'>
            <Text className='form-label'>截止</Text>
            <View className='chip-row'>
              <Chip on={newDue === 'today'} onClick={function () { setNewDue('today') }}>今天</Chip>
              <Chip on={newDue === 'tomorrow'} onClick={function () { setNewDue('tomorrow') }}>明天</Chip>
              <Chip on={newDue === 'custom'} onClick={function () { setNewDue('custom') }}>选日期</Chip>
              <Chip on={newDue === 'none'} onClick={function () { setNewDue('none') }}>不设截止</Chip>
            </View>
            {newDue === 'custom' && (
              <MiniCalendar value={customDue} onChange={setCustomDue} />
            )}
          </View>

          <View className='form-group'>
            <Text className='form-label'>优先级</Text>
            <View className='chip-row'>
              <Chip on={newPri === 'P0'} onClick={function () { setNewPri('P0') }}>P0 最要紧</Chip>
              <Chip on={newPri === 'P1'} onClick={function () { setNewPri('P1') }}>P1 正常</Chip>
              <Chip on={newPri === 'P2'} onClick={function () { setNewPri('P2') }}>P2 有空再说</Chip>
            </View>
          </View>

          <View className='form-group'>
            <Text className='form-label'>类别</Text>
            <View className='chip-row'>
              {(['study', 'contest', 'event', 'other'] as Todo['cat'][]).map(function (c) {
                return (
                  <Chip key={c} on={newCat === c} onClick={function () { setNewCat(c) }}>
                    {TODO_CATS[c]}
                  </Chip>
                )
              })}
            </View>
          </View>
        </Sheet>
      )}

      {editOpen && (
        <Sheet
          kicker='EDIT TODO'
          title='编辑待办'
          onClose={function () { setEditOpen(false) }}
          footer={
            <View className='sheet-foot'>
              <View className='sheet-btn sheet-btn-cancel' onClick={function () { setEditOpen(false) }}>取消</View>
              <View className='sheet-btn sheet-btn-ok' onClick={onSaveEdit}>保存</View>
            </View>
          }
        >
          <View className='form-group'>
            <Text className='form-label'>要做什么</Text>
            <View className='prompt-field'>
              <Input
                className='prompt-input'
                value={editTitle}
                maxlength={60}
                placeholder='待办标题'
                placeholderStyle='color:#97a3b1'
                onInput={function (e) { setEditTitle(e.detail.value) }}
              />
            </View>
          </View>

          <View className='form-group'>
            <Text className='form-label'>截止</Text>
            <View className='chip-row'>
              <Chip on={editDue === ''} onClick={function () { setEditDue('') }}>不设截止</Chip>
              <Chip on={editDue === todayKey()} onClick={function () { setEditDue(todayKey()) }}>今天</Chip>
              <Chip on={editDue === dateKey(addDays(new Date(), 1))} onClick={function () { setEditDue(dateKey(addDays(new Date(), 1))) }}>明天</Chip>
            </View>
            <MiniCalendar value={editDue || todayKey()} onChange={setEditDue} />
            <View className='prompt-field' style='margin-top:10px'>
              <Input
                className='prompt-input'
                value={editTime}
                maxlength={5}
                placeholder='具体时间，可留空，如 18:00'
                placeholderStyle='color:#97a3b1'
                onInput={function (e) { setEditTime(e.detail.value) }}
              />
            </View>
          </View>

          <View className='form-group'>
            <Text className='form-label'>优先级</Text>
            <View className='chip-row'>
              <Chip on={editPri === 'P0'} onClick={function () { setEditPri('P0') }}>P0 最要紧</Chip>
              <Chip on={editPri === 'P1'} onClick={function () { setEditPri('P1') }}>P1 正常</Chip>
              <Chip on={editPri === 'P2'} onClick={function () { setEditPri('P2') }}>P2 有空再说</Chip>
            </View>
          </View>

          <View className='form-group'>
            <Text className='form-label'>类别</Text>
            <View className='chip-row'>
              {(['study', 'contest', 'event', 'other'] as Todo['cat'][]).map(function (c) {
                return (
                  <Chip key={c} on={editCat === c} onClick={function () { setEditCat(c) }}>
                    {TODO_CATS[c]}
                  </Chip>
                )
              })}
            </View>
          </View>

          <View className='form-group'>
            <Text className='form-label'>备注</Text>
            <View className='prompt-field'>
              <Input
                className='prompt-input'
                value={editNote}
                maxlength={200}
                placeholder='可留空'
                placeholderStyle='color:#97a3b1'
                onInput={function (e) { setEditNote(e.detail.value) }}
              />
            </View>
          </View>

          <View className='form-group'>
            <Text className='form-label'>链接</Text>
            <View className='prompt-field'>
              <Input
                className='prompt-input'
                value={editLink}
                maxlength={300}
                placeholder='可留空'
                placeholderStyle='color:#97a3b1'
                onInput={function (e) { setEditLink(e.detail.value) }}
              />
            </View>
          </View>
        </Sheet>
      )}
    </View>
  )
}
