import { useCallback, useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Sheet from '../../components/Sheet'
import { PromptHost, promptText, confirmText } from '../../components/Prompt'
import { clampInt, fmtDur, makeId, parseDuration } from '../../data/date'
import { addActivity, commit, courseStats, getState, overallStats, recordDetail, reload } from '../../data/store'
import type { Course, Lesson } from '../../data/types'
import { autoSync } from '../../data/cloud'
import './index.scss'

export default function CoursesPage() {
  const [, setTick] = useState(0)
  const [openId, setOpenId] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCount, setNewCount] = useState('1')
  const [newDur, setNewDur] = useState('45')
  const [biliOpen, setBiliOpen] = useState(false)
  const [biliInput, setBiliInput] = useState('')
  const [biliBusy, setBiliBusy] = useState(false)
  const [lesOpen, setLesOpen] = useState(false)
  const [lesCourse, setLesCourse] = useState('')
  const [lesId, setLesId] = useState('')
  const [lesTitle, setLesTitle] = useState('')
  const [lesTotal, setLesTotal] = useState('')
  const [lesWatched, setLesWatched] = useState('')

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

  const state = getState()
  const overall = overallStats()
  const lesTotalMin = parseDuration(lesTotal) || 0
  const lesWatchedMin = parseDuration(lesWatched) || 0
  const lesPct = lesTotalMin > 0 ? Math.min(100, Math.round((lesWatchedMin / lesTotalMin) * 100)) : null

  function refresh() {
    setTick(function (n) {
      return n + 1
    })
  }

  function onAddCourse() {
    setNewName('')
    setNewCount('1')
    setNewDur('45')
    setNewOpen(true)
  }

  function onCreateCourse() {
    const name = newName.trim()
    if (!name) {
      Taro.showToast({ title: '课程名不能为空', icon: 'none' })
      return
    }
    const count = clampInt(newCount, 1, 999, 1)
    const dur = Math.max(1, Math.round(parseDuration(newDur) || 45))
    commit(function () {
      const s = getState()
      const lessons: Lesson[] = []
      for (let i = 0; i < count; i++) {
        lessons.push({ id: makeId(), totalMin: dur, watchedMin: 0 })
      }
      s.courses.push({ id: makeId(), name: name.slice(0, 40), lessons: lessons })
    })
    setNewOpen(false)
    refresh()
    Taro.showToast({ title: '已建 ' + count + ' 节', icon: 'success' })
  }

  async function onAddLesson(course: Course) {
    const input = await promptText('添加课时', '这一节的总时长（分钟）', '45')
    if (input == null) return
    const total = parseDuration(input)
    if (total == null || total <= 0) {
      Taro.showToast({ title: '请填有效时长', icon: 'none' })
      return
    }
    commit(function () {
      course.lessons.push({ id: makeId(), totalMin: clampInt(total, 1, 9999, 45), watchedMin: 0 })
    })
    refresh()
  }

  function onLessonTap(course: Course, lesson: Lesson) {
    setLesCourse(course.id)
    setLesId(lesson.id)
    setLesTitle(lesson.title || '')
    setLesTotal(lesson.totalMin ? String(lesson.totalMin) : '')
    setLesWatched(lesson.watchedMin ? String(lesson.watchedMin) : '')
    setLesOpen(true)
  }

  function bumpWatched(delta: number) {
    const cur = parseDuration(lesWatched) || 0
    const total = parseDuration(lesTotal) || 0
    let next = Math.max(0, cur + delta)
    if (total > 0) next = Math.min(next, total)
    setLesWatched(String(next))
  }

  function onSaveLesson() {
    const course = getState().courses.find(function (c) {
      return c.id === lesCourse
    })
    const lesson = course && course.lessons.find(function (l) {
      return l.id === lesId
    })
    if (!course || !lesson) {
      setLesOpen(false)
      return
    }
    const total = Math.max(0, Math.round(parseDuration(lesTotal) || 0))
    const watchedRaw = Math.max(0, Math.round(parseDuration(lesWatched) || 0))
    commit(function () {
      const prev = lesson.watchedMin
      lesson.title = lesTitle.trim().slice(0, 120)
      lesson.totalMin = total
      const next = total > 0 ? Math.min(watchedRaw, total) : watchedRaw
      lesson.watchedMin = next
      const add = next - prev
      if (add > 0) {
        addActivity(add)
        recordDetail(course.id, lesson.id, add)
      }
    })
    setLesOpen(false)
    refresh()
    Taro.showToast({ title: '进度已保存', icon: 'success' })
  }

  async function onDeleteLesson() {
    const ok = await confirmText(
      '删除这一节',
      '这一节会从课程里移除，之前记过的观看时长仍留在学习日历里。',
      '删除'
    )
    if (!ok) return
    commit(function () {
      const course = getState().courses.find(function (c) {
        return c.id === lesCourse
      })
      if (!course) return
      course.lessons = course.lessons.filter(function (l) {
        return l.id !== lesId
      })
    })
    setLesOpen(false)
    refresh()
  }

  async function onAddLessonOrDelete(course: Course) {
    try {
      const res = await Taro.showActionSheet({ itemList: ['添加课时', '删除这门课'] })
      if (res.tapIndex === 0) {
        onAddLesson(course)
        return
      }
      const ok = await confirmText(
        '删除课程',
        '「' + course.name + '」的课时进度会一起删除，历史日历记录保留。',
        '删除'
      )
      if (!ok) return
      commit(function () {
        const s = getState()
        s.courses = s.courses.filter(function (c) {
          return c.id !== course.id
        })
        s.checkins.forEach(function (item) {
          if (item.courseId === course.id) item.courseId = ''
        })
      })
      refresh()
    } catch (err) {
      return
    }
  }

  function onOpenBili() {
    setBiliInput('')
    setBiliBusy(false)
    setBiliOpen(true)
  }

  function onImportBili() {
    const match = biliInput.match(/BV[0-9A-Za-z]{10}/)
    if (!match) {
      Taro.showToast({ title: '没识别出 BV 号', icon: 'none' })
      return
    }
    const bv = match[0]
    setBiliBusy(true)
    Taro.request({
      url: 'https://api.bilibili.com/x/web-interface/view?bvid=' + bv,
      timeout: 15000,
      success: function (res) {
        setBiliBusy(false)
        const data = res.data as any
        if (!data || data.code !== 0 || !data.data) {
          Taro.showToast({ title: (data && data.message) || '拉取失败', icon: 'none' })
          return
        }
        const view = data.data
        const pages: any[] = Array.isArray(view.pages) ? view.pages : []
        if (!pages.length) {
          Taro.showToast({ title: '这个视频没有分P', icon: 'none' })
          return
        }
        commit(function () {
          getState().courses.push({
            id: makeId(),
            name: String(view.title || bv).slice(0, 40),
            source: 'bili',
            bvid: bv,
            lessons: pages.map(function (p) {
              return {
                id: makeId(),
                title: String(p.part || '').slice(0, 120),
                totalMin: Math.max(1, Math.round(Number(p.duration || 0) / 60)),
                watchedMin: 0,
              }
            }),
          })
        })
        setBiliOpen(false)
        refresh()
        Taro.showToast({ title: '已导入 ' + pages.length + ' 节', icon: 'success' })
      },
      fail: function () {
        setBiliBusy(false)
        Taro.showToast({ title: '请求失败，先检查域名白名单', icon: 'none' })
      },
    })
  }

  return (
    <View className='page'>
      <View className='masthead'>
        <View>
          <Text className='kicker mono'>COURSES</Text>
          <Text className='title'>课程</Text>
          <Text className='today-line'>按时长加权算总进度</Text>
        </View>
      </View>

      <View className='panel'>
        <View className='overall'>
          <View className='metric'>
            <Text className='overall-num mono'>{overall.pct}%</Text>
            <Text className='metric-cap'>总进度</Text>
          </View>
          <View className='metric'>
            <Text className='metric-num mono'>{state.courses.length}</Text>
            <Text className='metric-cap'>在学课程</Text>
          </View>
          <View className='metric'>
            <Text className='metric-num mono'>{overall.doneLessons}</Text>
            <Text className='metric-cap'>已看完节数</Text>
          </View>
          <View className='metric'>
            <Text className='metric-num mono'>{fmtDur(overall.watchedMin)}</Text>
            <Text className='metric-cap'>累计观看</Text>
          </View>
        </View>
      </View>

      <View className='panel'>
        <View className='panel-head'>
          <View>
            <Text className='panel-title'>我的课程</Text>
            <Text className='panel-cap'>点课时记录进度；点课名右侧「⋯」添加课时或删除</Text>
          </View>
          <View className='panel-actions'>
            <Text className='link-btn' onClick={onOpenBili}>B 站导入</Text>
            <Text className='link-btn' onClick={onAddCourse}>+ 新建课程</Text>
          </View>
        </View>

        {state.courses.length === 0 && (
          <Text className='empty'>还没有课程。先新建一门，再往里加课时。</Text>
        )}

        <View className='course-grid'>
          {state.courses.map(function (course) {
          const s = courseStats(course)
          const open = openId === course.id
          return (
            <View className='course-block' key={course.id}>
              <View className='course-top'>
                <Text
                  className='course-name'
                  onClick={function () { setOpenId(open ? '' : course.id) }}
                >
                  {open ? '▾ ' : '▸ '}
                  {course.name}
                </Text>
                <Text className='course-pct mono'>{s.pct}%</Text>
                <Text className='link-btn' onClick={function () { onAddLessonOrDelete(course) }}>⋯</Text>
              </View>
              <View className='bar'>
                <View className='bar-fill' style={'width:' + s.pct + '%'} />
              </View>
              <Text className='course-meta'>
                {s.count} 节 · 已看 {s.watchedMin} / {s.totalMin} 分钟 · 看完 {s.doneLessons} 节
              </Text>

              {open &&
                course.lessons.map(function (lesson, i) {
                  const done = lesson.totalMin > 0 && lesson.watchedMin >= lesson.totalMin
                  return (
                    <View
                      className='lesson-row'
                      key={lesson.id}
                      onClick={function () { onLessonTap(course, lesson) }}
                    >
                      <Text className='lesson-name'>
                        第 {i + 1} 节{lesson.title ? ' · ' + lesson.title : ''}
                      </Text>
                      <Text className='lesson-time mono'>
                        {lesson.watchedMin}/{lesson.totalMin || '—'}′
                      </Text>
                      {done && <Text className='lesson-done'>已看完</Text>}
                    </View>
                  )
                })}

              {open && (
                <View className='course-actions'>
                  <Text className='btn btn-small' onClick={function () { onAddLesson(course) }}>
                    + 添加课时
                  </Text>
                </View>
              )}
            </View>
          )
        })}
        </View>
      </View>

      <Text className='empty'>看视频的分钟会同时记进学习日历与当天视频时长</Text>

      {newOpen && (
        <Sheet
          kicker='NEW COURSE'
          title='登记新课程'
          onClose={function () { setNewOpen(false) }}
          footer={
            <View className='sheet-foot'>
              <View className='sheet-btn sheet-btn-cancel' onClick={function () { setNewOpen(false) }}>取消</View>
              <View className='sheet-btn sheet-btn-ok' onClick={onCreateCourse}>保存</View>
            </View>
          }
        >
          <View className='form-group'>
            <Text className='form-label'>课程名</Text>
            <View className='prompt-field'>
              <Input
                className='prompt-input'
                value={newName}
                maxlength={40}
                placeholder='比如：线性代数'
                placeholderStyle='color:#97a3b1'
                onInput={function (e) { setNewName(e.detail.value) }}
              />
            </View>
          </View>

          <View className='form-group'>
            <Text className='form-label'>节数 / 每节默认时长（分钟）</Text>
            <View className='lesson-fields'>
              <View className='lesson-field'>
                <Text className='form-hint'>节数</Text>
                <View className='prompt-field'>
                  <Input
                    className='prompt-input'
                    type='number'
                    value={newCount}
                    placeholder='1'
                    placeholderStyle='color:#97a3b1'
                    onInput={function (e) { setNewCount(e.detail.value) }}
                  />
                </View>
              </View>
              <View className='lesson-field'>
                <Text className='form-hint'>每节分钟</Text>
                <View className='prompt-field'>
                  <Input
                    className='prompt-input'
                    type='text'
                    value={newDur}
                    placeholder='45'
                    placeholderStyle='color:#97a3b1'
                    onInput={function (e) { setNewDur(e.detail.value) }}
                  />
                </View>
              </View>
            </View>
            <Text className='form-hint'>
              一次生成 {clampInt(newCount, 1, 999, 1)} 节课时，每节默认{' '}
              {Math.max(1, Math.round(parseDuration(newDur) || 45))} 分钟，之后可逐节改标题和进度。
            </Text>
          </View>
        </Sheet>
      )}

      {lesOpen && (
        <Sheet
          kicker='LESSON'
          title='课时进度'
          onClose={function () { setLesOpen(false) }}
          footer={
            <View className='sheet-foot'>
              <View className='sheet-btn sheet-btn-cancel' onClick={function () { setLesOpen(false) }}>取消</View>
              <View className='sheet-btn sheet-btn-ok' onClick={onSaveLesson}>保存</View>
            </View>
          }
        >
          <View className='form-group'>
            <Text className='form-label'>课时标题</Text>
            <View className='prompt-field'>
              <Input
                className='prompt-input'
                value={lesTitle}
                maxlength={60}
                placeholder='可留空，默认「第 N 节」'
                placeholderStyle='color:#97a3b1'
                onInput={function (e) { setLesTitle(e.detail.value) }}
              />
            </View>
          </View>

          <View className='form-group'>
            <Text className='form-label'>总时长 / 已看（分钟）</Text>
            <View className='lesson-fields'>
              <View className='lesson-field'>
                <Text className='form-hint'>总时长</Text>
                <View className='prompt-field'>
                  <Input
                    className='prompt-input'
                    type='number'
                    value={lesTotal}
                    placeholder='45'
                    placeholderStyle='color:#97a3b1'
                    onInput={function (e) { setLesTotal(e.detail.value) }}
                  />
                </View>
              </View>
              <View className='lesson-field'>
                <Text className='form-hint'>已看</Text>
                <View className='prompt-field'>
                  <Input
                    className='prompt-input'
                    type='number'
                    value={lesWatched}
                    placeholder='0'
                    placeholderStyle='color:#97a3b1'
                    onInput={function (e) { setLesWatched(e.detail.value) }}
                  />
                </View>
              </View>
            </View>
            <View className='chip-row' style='margin-top:14px'>
              <View className='chip' onClick={function () { bumpWatched(5) }}>+5 分</View>
              <View className='chip' onClick={function () { bumpWatched(15) }}>+15 分</View>
              <View className='chip' onClick={function () { setLesWatched(lesTotal) }}>看完</View>
              <View className='chip' onClick={function () { setLesWatched('0') }}>清零</View>
            </View>
            <Text className='form-hint'>
              {lesPct == null ? '未填总时长，这一节不计入统计' : '当前进度 ' + lesPct + '%'}
            </Text>
          </View>

          <Text className='sheet-del' onClick={onDeleteLesson}>删除这一节</Text>
        </Sheet>
      )}

      {biliOpen && (
        <Sheet
          kicker='BILI IMPORT'
          title='从 B 站导入'
          onClose={function () { setBiliOpen(false) }}
          footer={
            <View className='sheet-foot'>
              <View className='sheet-btn sheet-btn-cancel' onClick={function () { setBiliOpen(false) }}>取消</View>
              <View className='sheet-btn sheet-btn-ok' onClick={onImportBili}>
                {biliBusy ? '导入中…' : '导入'}
              </View>
            </View>
          }
        >
          <View className='form-group'>
            <Text className='form-label'>视频链接或 BV 号</Text>
            <View className='prompt-field'>
              <Input
                className='prompt-input'
                value={biliInput}
                maxlength={120}
                placeholder='https://www.bilibili.com/video/BV…'
                placeholderStyle='color:#97a3b1'
                onInput={function (e) { setBiliInput(e.detail.value) }}
              />
            </View>
            <Text className='form-hint'>会把分P依次导入成一门课的课时，时长按视频自动填好；导入后可单独调整。</Text>
          </View>
        </Sheet>
      )}

      <PromptHost />
    </View>
  )
}
