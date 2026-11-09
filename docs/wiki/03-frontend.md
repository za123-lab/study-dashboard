# 03 · 前端逻辑（app.js）

## 1. 文件角色

`app.js` 是整个项目唯一的逻辑文件：约 5300 行，一个 IIFE，`"use strict"`，不使用模块、不使用类、不使用 TypeScript。所有函数都是闭包内的普通函数声明或函数表达式，外部只能通过 DOM 事件触达。

**没有「类」**：项目里不存在 `class` 或原型式对象。通常由类承担的职责被拆成三部分——

| 通常的类职责 | 本项目的对应物 |
| --- | --- |
| 实例状态 | 模块级变量 `state`（整份数据）与 `supaCfg` / `supaSession` / `supaMeta` |
| 方法 | 闭包内的一组函数（`addCourse`、`commitLessonField`、`pushLocal` ……） |
| 数据校验 / 序列化 | 纯函数 `sanitize` / `snapshot` / `hashState` |

所以阅读时按「数据在哪个变量里、由哪组函数改、改完谁重绘」来理解，比按 OOP 结构理解更快。

顶部注释说明了核心口径：**进度按「分钟」记录，课程与总体进度都用时长加权计算；数据全部保存在 `localStorage`，不依赖后端与第三方库。**

## 2. 代码分区

`app.js` 用注释切成下列区段，阅读时建议按此顺序：

| 区段 | 主要内容 |
| --- | --- |
| 常量与运行状态 | 存储键、同步参数、`state`、云同步各运行变量、待办常量、紧急度常量 |
| 时间工具 | `pad` `fmtDur` `parseDuration` `clampInt` `lessonPct` `courseStats` `overallStats` |
| 日期工具 | `dateKey` `todayKey` `addDays` `heatWeeks` `minuteLevel` `makeId` `escapeHtml` |
| 读取 / 迁移 / 保存 | `emptyState` `loadState` `saveState` `migrateCourseV1` `cleanCourseV2` `cleanDetails` `cleanTodos` `sanitize` |
| DOM | `$` 与 `el` 引用表 |
| 渲染 | 视图调度、品牌、折叠面板、今日、统计、课程、热力图、当日详情 |
| 待办 | 截止时刻、紧急度、排序、计数、列表渲染 |
| 日历 | 月历与手机列表渲染、月份切换 |
| 视图切换 | `setView` `bindTabKeys` |
| 待办编辑与批量导入 | 弹层表单、提示词、解析、预览、确认 |
| 数据操作 | 课程 / 课时 / 打卡 / 明细 / 清理 |
| B 站导入 | 提示词、时长解析、JSON 校验、预览、写入 |
| 云同步 | 配置、认证、REST、上传、拉取、冲突 |
| 自动拉取 | Realtime、轮询、前台检查、请求合并 |
| 事件 | 全部 DOM 事件绑定 |
| 启动 | 品牌、提示词填充、面板绑定、云同步初始化、首屏渲染、迁移落盘、resize |

## 3. 常量

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `APP_NAME` | `"学业工作台"` | 站点名唯一出处：标题、页脚、导出文件名 |
| `SCHEMA_VERSION` | `3` | 数据结构版本，高于本版本的快照不自动上传 |
| `STORE_KEY` | `"study-log-v1"` | 主数据键，沿用旧名以便原地迁移 |
| `SUPA_CFG_KEY` | `"study-supabase-v1"` | Supabase 连接配置 |
| `SUPA_SESSION_KEY` | `"study-supabase-session-v1"` | 登录态 token |
| `SUPA_META_KEY` | `"study-supabase-meta-v1"` | 云端版本号与上次同步快照 |
| `SUPA_TIMEOUT` | `15000` | 单个 Supabase 请求超时（毫秒） |
| `SYNC_DEBOUNCE` | `1500` | 本地改动后自动上传防抖 |
| `PULL_POLL_MS` | `60000` | 实时断开后的兜底轮询间隔 |
| `FOCUS_PULL_GAP` | `5000` | 回到前台触发拉取的最小间隔 |
| `DEFAULT_LESSON_MIN` | `45` | v1 迁移与新增课时的默认时长 |
| `BILI_URL_RE` | `^https?://(www\.)?bilibili\.com/video/BV[0-9A-Za-z]{10}` | 只接受站内视频链接 |

另有三个业务常量：

- `TODO_CATS = { study: "学业", contest: "竞赛", event: "赛事", other: "其他" }`
- `TODO_PRI = ["P0", "P1", "P2"]`
- `URGENCY_LABEL` / `URGENCY_RANK`：`overdue(0) < soon(1) < week(2) < far(3)`

## 4. 运行时状态变量

| 变量 | 类型 | 用途 |
| --- | --- | --- |
| `state` | object | 当前整份进度（见 [02 数据模型](02-data-model.md)） |
| `schemaTooNew` | boolean | 读到更高版本数据后置真，停止自动上传 |
| `migratedOnLoad` | boolean | 本次启动是否发生了 v1→v2 迁移 |
| `toastTimer` | number | 轻提示定时器 |
| `pendingImport` | object \| null | 已解析、待确认写入的 B 站课程 |
| `supaCfg` | object | `{ url, anonKey, auto }` |
| `supaSession` | object \| null | `{ accessToken, refreshToken, expiresAt, userId, email }` |
| `supaMeta` | object | `{ userId, baseRev, syncedHash, lastSyncAt }` |
| `supaBusy` | boolean | 是否有同步请求在飞 |
| `supaReady` | boolean | 登录后首次云端核对是否完成 |
| `suppressAutoSync` | boolean | 应用云端数据期间抑制自动上传 |
| `autoSyncTimer` | number | 1.5 秒防抖定时器 |
| `pendingConflict` | object \| null | `{ remote, reason }`，存在时挡住自动同步 |
| `pullInFlight` / `pullQueued` | Promise / boolean | 自动拉取请求合并 |
| `pollTimer` | number | 60 秒兜底轮询 |
| `focusPullAt` | number | 上次前台拉取时间 |
| `realtimeWs` 等 | - | Realtime 连接、心跳、重连退避、是否被拒 |
| `pendingEditPull` | boolean | 用户正在输入课时时，把云端更新推迟 |
| `currentView` | `"study" \| "todo" \| "calendar"` | 当前视图 |
| `viewDirty` | object | 三个视图是否需要重渲染 |
| `viewScroll` | object | 三个视图各自的滚动位置 |
| `todoCatFilter` / `todoStatusFilter` | string | 待办筛选 |
| `todoDoneFoldOpen` | boolean | 「已完成」分组展开状态 |
| `calYear` / `calMonthIdx` | number | 日历当前年月 |

## 5. 关键函数说明

### 5.1 时间与统计

| 函数 | 签名 | 行为 |
| --- | --- | --- |
| `pad` | `(n) => string` | 补零到两位 |
| `fmtDur` | `(min) => "h:mm"` | 分钟 → `"1:23"`；负数按 0 |
| `parseDuration` | `(raw) => number \| null` | 纯数字按分钟；`"1:23"` / `"1：23"` 按 1 小时 23 分 |
| `clampInt` | `(value, min, max, fallback) => number` | 取整并夹在区间内，非法返回 fallback |
| `lessonPct` | `(lesson) => number \| null` | 单节百分比，`totalMin=0` 返回 null |
| `courseStats` | `(course) => { totalMin, watchedMin, doneLessons, invalid, count, pct }` | 按**时长加权**汇总课程 |
| `overallStats` | `() => {...}` | 汇总全部课程，`pct` 同样按时长加权 |

### 5.2 日期与通用工具

| 函数 | 行为 |
| --- | --- |
| `dateKey(d)` | `"YYYY-MM-DD"` |
| `todayKey()` | 今天的日期键 |
| `addDays(d, n)` | 返回新的 `Date`，不改原对象 |
| `heatWeeks()` | 视口宽度决定热力图周数：`<560 → 13`，`<900 → 20`，否则 `26` |
| `minuteLevel(min)` | 0 / 1（≤15）/ 2（≤45）/ 3（≤90）/ 4（>90） |
| `makeId()` | `Date.now().toString(36) + 随机 5 位 base36` |
| `escapeHtml(str)` | 转义 `& < > " '`，所有拼接进 `innerHTML` 的文本都必须经它 |

### 5.3 存储与校验

| 函数 | 行为 |
| --- | --- |
| `emptyState()` | 返回完整空结构（含 `panelOpen` 默认值） |
| `loadState()` | 读 `localStorage` → `sanitize`，异常则重置并 `console.warn` |
| `saveState()` | 落盘；失败 `toast`；成功后按需 `scheduleAutoSync()` |
| `migrateCourseV1(c)` | v1 课程 → v2 课程，已完成集按 45 分钟计 |
| `cleanCourseV2(c)` | 白名单清洗课程与课时；截断越界值；只保留合法 B 站链接 |
| `cleanDetails(raw)` | 明细清洗 + 同日同课时合并 |
| `cleanTodos(raw)` | 待办白名单清洗 + ID 去重 |
| `sanitize(data)` | 总入口：版本检测、v1 判定、逐字段清洗、输出 v2 |

### 5.4 渲染调度

| 函数 | 行为 |
| --- | --- |
| `applyBranding()` | 把 `APP_NAME` 写入 `document.title`、`#appTitle`、`#appFoot` |
| `renderView(name)` | 清 `viewDirty[name]` 后按视图渲染对应模块 |
| `renderAll()` | 渲染头部与连续打卡，把三个视图标记为 dirty，只渲染当前视图，再应用折叠面板 |
| `applyFoldPanel(fold)` | 同步 `is-open` class、`aria-expanded`、`aria-hidden` 与 `inert` |
| `bindFoldPanels()` | 绑定两个折叠面板的点击，展开状态写入 `state.panelOpen` 并持久化 |
| `renderHeader()` | 页头日期行 |
| `stateContent(title, text)` | 统一空 / 加载 / 错误态 HTML，所有模块共用 |

### 5.5 学习视图

| 函数 | 行为 |
| --- | --- |
| `renderToday()` | 今日分钟、今日待办（最多 3 条，逾期优先）、最近截止项 |
| `renderStats()` | 三个统计卡 + 圆环 `--p` 与 `aria-label` |
| `renderCourses()` | 空状态显隐；课程列表整体重建 |
| `courseCardHtml(course)` | 课程卡片：标题、B 站视频行、加权 meta、删除按钮、进度条、展开按钮、课时列表、添加一节 |
| `lessonLabel(lesson, idx)` | 有标题用标题；带 `page` 且标题未含 `P{n}` 时补 `P{n}` 前缀 |
| `lessonRowHtml(course, lesson, idx)` | 课时行：标题（可点击编辑）、总时长 / 已看输入框、进度条、百分比、`+15 分` / `看完` / `删除` / B 站链接 |
| `renderHeatmap()` | 按周生成 7×N 的按钮网格；未来日期禁用；有记录或明细的日期可打开 |
| `hasDayDetails(key)` | 真实明细或示例明细是否存在 |
| `dayLabel(key)` | `"2026 年 11 月 7 日 · 星期五"` |
| `describeDetail(entry)` | 明细 → 课程名 / 课时名 / 当前进度（含课程或课时已删除的降级文案） |
| `openDayDetail(key, cell, forceOpen)` | 打开当日弹层：学习明细 + 当天待办；记录返回焦点 |
| `closeDayDetail()` | 隐藏弹层并把焦点还给触发元素 |
| `todosOnDay(key)` | 某天的待办，按完成状态 → 紧急度 → 截止时刻 → 优先级排序 |

### 5.6 待办

| 函数 | 行为 |
| --- | --- |
| `todoDeadline(t)` | 截止时刻：无 `dueTime` 按当天 23:59；`"24:00"` 也归到 23:59；无 `due` 返回 null |
| `todoUrgency(t)` | `""` / `"no-deadline"` / `"overdue"` / `"soon"` / `"week"`；已完成统一返回 `""` |
| `calUrgency(t)` | 把上面四档压成 `overdue / soon / week / far`，供日历与首屏使用 |
| `fmtTodoDue(t)` | `"11 月 11 日 周三 18:00"`，跨年补年份 |
| `todoLeftText(t)` | `"还剩 3 小时"` / `"已逾期 2 天"` / `"已完成"` / `"截止待确认"` |
| `todoDayLeftText(t)` | 统一按天表达，用于首屏与当日弹层 |
| `sortedTodos()` | 未完成在前；已完成按 `doneAt` 倒序；有截止的按截止升序；无截止排最后；同刻按优先级 |
| `todoCounts()` | 逾期 / 今日 / 本周三个计数（只算未完成且有截止） |
| `todoItemHtml(t)` | 单条待办 HTML：勾选框、优先级、标题、类别、截止、剩余、备注、链接、编辑/删除 |
| `renderTodos()` | 计数条 + 筛选 + 未完成列表 + 「已完成」折叠分组 |

### 5.7 日历

| 函数 | 行为 |
| --- | --- |
| `calDayAria(key, todos, min)` | 生成日期格的无障碍描述（未完成数、最紧急档、学习分钟） |
| `renderCalendar()` | 月标题、本月逾期 / 本周截止、桌面网格、手机列表 |
| `shiftMonth(delta)` | 切换月份并重渲染 |

日期格颜色只取当天**最紧急**的一项待办决定（`URGENCY_RANK` 最小者）；格内同时显示当天学习分钟（`min′`）。

### 5.8 视图切换

`setView(name)`：

1. 目标视图不是 dirty 且就是当前视图 → 直接返回；
2. 保存旧视图滚动位置；
3. 切换三个视图的 `hidden`、页签 `is-active`、`aria-selected`、`tabIndex`；
4. B 站导入面板只属于学习视图，切走时 `hidden = true`（内容与预览状态保留）；
5. 若目标视图 dirty → `renderView(name)`；
6. 用 `requestAnimationFrame` 恢复目标视图的滚动位置。

`bindTabKeys()`：在 `#viewTabs` 上监听 `ArrowLeft / ArrowRight / Home / End`，切换并聚焦对应页签。

### 5.9 课程与课时操作

| 函数 | 行为 |
| --- | --- |
| `findCourse(id)` / `findLesson(course, id)` | 线性查找 |
| `adjustActivity(delta)` | 今日 `activity` 增减；减到 0 时删除该日键 |
| `recordDetail(course, lesson, delta)` | 只记正增量；同日同课时合并；写入 `state.details` |
| `subtractDemoActivity()` | 从 `activity` 扣掉 `demoActivity`，并清空示例明细 |
| `clearDemoData()` | 删除示例课程与示例打卡（`confirm` 后执行） |
| `resetActivity()` | 只清打卡与明细，保留课程与已看时长 |
| `addCourse(name, count, defaultMin)` | 按节数批量生成课时 |
| `removeCourse(id)` | 删除课程及其展开状态 |
| `commitLessonField(courseId, lessonId, field, raw, input)` | 提交「总时长 / 已看」输入；非法输入回填原值；总时长调小会截断已看；改已看会 `adjustActivity` + `recordDetail` |
| `applyLessonAction(courseId, lessonId, act)` | `del` 删除单节（有记录时确认）；`add15` 加 15 分钟；`full` 标记看完 |
| `addLesson(courseId)` | 新增一节，默认沿用上一节时长或 45 分钟 |
| `openLessonTitleEditor(btn)` | 标题按钮原地切换为输入框 |
| `commitLessonTitle(courseId, lessonId, raw)` | 保存或清空标题（清空后回退为「第 N 节」） |

### 5.10 待办编辑与批量导入

| 函数 | 行为 |
| --- | --- |
| `normalizeTodoTime(raw)` | `"9:5"` → `"09:05"`；非法或 `24:00` 以后返回 null；空串返回 `""` |
| `openTodoEditor(id)` | 有 id 为编辑，无 id 为新增；填充表单并聚焦标题 |
| `closeTodoEditor()` | 隐藏并重置表单 |
| `saveTodos(message)` | `saveState()` + `renderAll()` + 可选 toast |
| `TODO_IMPORT_PROMPT` | 给任意 AI 的固定提示词，要求只输出数组，字段仅 `title/cat/due/dueTime/pri/note/link` |
| `todoDupKey(t)` | 去重键：标题（空白折叠）+ `\0` + 截止日期 |
| `isValidTodoDate(s)` | 格式 + 真实日期双重校验（1900–2999） |
| `parseTodoImport(raw)` | 支持单对象、数组、`{todos}`、`{data:{todos}}`；最多 500 条；逐条校验；返回 `{ items, skipped }` 或 `{ error }` |
| `renderTodoImportPreview(res)` | 预览表 + 跳过原因（清单已有 / 本次 JSON 内重复） |
| `runTodoImportPreview()` | 解析并预览，错误就地显示 |
| `clearTodoImport()` | 清空粘贴框、预览与错误 |
| `confirmTodoImport()` | 把 `items` 写入 `state.todos`，提示新增与跳过数量 |

`TODO_IMPORT_CAT_MAP` 同时接受内部 key 与中文标签（学业 / 竞赛 / 赛事 / 其他），避免 AI 输出中文类别时被误判非法。

### 5.11 示例、头部与提示

| 函数 | 行为 |
| --- | --- |
| `renderStreak()` | 连续打卡天数 |
| `demoSummary()` | 示例课程数、示例打卡天数与分钟数 |
| `renderDemoNotice()` | 示例数据提示条显隐与文案 |
| `renderHeatNote()` | 有打卡但已无课程时，提示「记录已失去来源」并提供重置入口 |
| `toast(msg)` | 2.4 秒轻提示，重复调用会重置计时 |

### 5.12 B 站导入

| 函数 | 行为 |
| --- | --- |
| `BILI_PROMPT` | 固定提示词：要求输出 `{ bvid, title, lessons[] }`，`duration` 只接受三种写法 |
| `fmtHMS(seconds)` | 秒 → `"m:ss"` 或 `"h:mm:ss"` |
| `parseSecondsValue(raw)` | 支持数字秒、`"mm:ss"`、`"h:mm:ss"`；≤ 0 或非法返回 null |
| `locatePos(text, pos)` | 字符下标 → 「第 N 行第 M 列」 |
| `findBracketMismatch(text)` | 浏览器报错不带位置时，自己扫括号配对，指出多余 / 未闭合 / 不匹配的位置 |
| `parseBiliPayload(raw)` | 去代码块包裹 → `JSON.parse` → 校验 bvid/title/lessons → 生成 `totalMin = max(1, round(seconds/60))`、默认 `url` → 按 page 排序 |
| `findImportDup(p)` | 先按同 `bvid` 找 B 站课程，再退回同名课程 |
| `showImportResult(value)` | 渲染预览表、总时长、重复课程选择（新增 / 覆盖） |
| `showImportError(msg)` | 隐藏预览，显示错误 |
| `resetImportPanel()` | 清空输入、预览与错误 |
| `confirmBiliImport()` | 新增课程，或覆盖已有课程（**按节序沿用已看时长**，并更新标题 / BV / 视频标题） |
| `copyText(text)` | 优先 `navigator.clipboard`，失败降级 `fallbackCopy` |
| `fallbackCopy(text)` | 隐藏 textarea + `execCommand("copy")`，兼容 `file://` |

### 5.13 云同步

云同步函数数量较多，单独成篇：[05 云同步](05-cloud-sync.md)。此处只列入口：

- 认证：`loginWithPassword` `restoreSession` `refreshSession` `logout`
- 配置：`saveSupaConfig` `forgetSupaConfig` `renderSupaPanel`
- 推送：`manualPush` `pushLocal` `uploadSnapshot`
- 拉取：`manualPull` `syncAfterLogin` `runAutoPull`
- 冲突：`showConflict` `applyRemote` `adoptRemote`

### 5.14 导入导出（事件内联）

导出：无数据时拒绝；否则拼装完整快照 + `exportedAt`，`Blob` + `URL.createObjectURL` + 临时 `<a download>` 触发下载，最后 `revokeObjectURL`。

导入：`FileReader` 读取 → `sanitize` → 确认覆盖 → 替换 `state` → `saveState` → `renderAll`。

## 6. 渲染机制

### 6.1 惰性渲染

```js
const viewDirty = { study: true, todo: true, calendar: true };
const viewScroll = { study: 0, todo: 0, calendar: 0 };
```

- 首屏只渲染 `study`；`todo` / `calendar` 保持 dirty，等用户第一次切过去时才构建 DOM。
- 任何数据变更后统一走 `renderAll()`：把三个视图标记为 dirty，但只重渲染当前视图。
- `setView` 负责在切换时补渲染并恢复滚动位置。

### 6.2 DOM 更新方式

- 列表类（课程、课时、待办、日历格、预览表）用 `innerHTML` 拼接字符串，所有动态文本必须过 `escapeHtml`。
- 文本类（统计数字、状态行、标题）用 `textContent` 或 `innerHTML`（仅用于含 `<b>` 的固定模板）。
- 不保存元素引用做 diff，整体重建换取实现简单；对个人数据量（几十门课、几百条待办）足够。

### 6.3 事件委托

课程列表、待办列表、热力图、日历网格、日历列表都只在容器上绑定一次监听，用 `e.target.closest()` 找到具体目标，再读 `data-*` 属性派发。这样重渲染 `innerHTML` 不需要重新绑定。

| 容器 | 读取的属性 | 动作 |
| --- | --- | --- |
| `#courseList` | `data-cid` / `data-lid` / `data-act` | 展开、删除课程、添加一节、改标题、课时操作 |
| `#todoList` | `data-todo-done` / `data-todo-edit` / `data-todo-del` | 勾选、编辑、删除 |
| `#heatmap` | `data-date` | 打开当日详情 |
| `#calGrid` / `#calList` | `data-cal-date` | 打开当日详情（空白日也允许） |

## 7. 事件绑定总表

| 元素 | 事件 | 行为 |
| --- | --- | --- |
| `#addForm` | `submit` | 校验名称 / 节数 / 默认时长 / 重名 → `addCourse` |
| `#heatmap` | `click` / `keydown` | 打开当日详情；未来日期与无记录日期给 toast |
| `#dayClose` `#dayCloseBtn` `#dayDetail` 背景 | `click` | 关闭当日详情 |
| `document` | `keydown` | `Escape`：优先关待办编辑，再关当日详情 |
| `#tabStudy` `#tabTodo` `#tabCalendar` | `click` | `setView` |
| `#viewTabs` | `keydown` | ←/→/Home/End 切换页签 |
| `#todayGoTodo` | `click` | 切到待办并聚焦页签 |
| `#todoAddBtn` `#todoEditorClose` 背景 | `click` | 打开 / 关闭待办编辑 |
| `#todoCopyPromptBtn` | `click` | 复制待办提示词 |
| `#todoParseBtn` | `click` | 解析并预览 |
| `#todoImportJson` | `keydown` | `Ctrl/Cmd + Enter` 预览 |
| `#todoImportClearBtn` `#todoCancelImportBtn` | `click` | 清空导入面板 |
| `#todoConfirmImportBtn` | `click` | 确认导入 |
| `#todoCatFilter` `#todoStatusFilter` | `change` | 更新筛选并重渲染 |
| `#todoList` | `change` | 勾选完成 / 取消完成，写 `doneAt` |
| `#todoList` | `click` | 编辑 / 删除 |
| `#todoForm` | `submit` | 新增或更新待办；校验标题、时间、链接 |
| `#calPrev` `#calNext` `#calToday` | `click` | 月份切换 / 回到本月 |
| `#courseList` | `click` | 展开收起、删除课程、添加一节、改标题、课时操作 |
| `#courseList` | `change` | 课时标题 / 时长输入提交 |
| `#courseList` | `keydown` | 标题输入：Enter 提交、Escape 取消；时长输入：Enter 提交 |
| `#copyPromptBtn` | `click` | 复制 B 站提示词 |
| `#previewBtn` | `click` | 解析 B 站 JSON 并预览 |
| `#biliClearBtn` | `click` | 清空 B 站导入面板 |
| `#confirmImportBtn` | `click` | 确认写入（新增或覆盖） |
| `#cancelImportBtn` | `click` | 取消预览 |
| `#biliJson` | `keydown` | `Ctrl/Cmd + Enter` 预览 |
| `#supaKeyToggle` | `click` | 切换 Publishable key 明文 / 密文 |
| `#supaSqlCopyBtn` | `click` | 复制教程内嵌的建表 SQL（`copyText`，失败给降级提示） |
| `#supaCfgSave` `#supaCfgForget` | `click` | 保存 / 清除连接配置 |
| `#supaLoginForm` | `submit` | 校验邮箱密码 → 登录 |
| `#supaAuto` | `change` | 开关自动同步（关闭时停轮询与实时） |
| `#supaPushBtn` `#supaPullBtn` `#supaLogoutBtn` | `click` | 立即上传 / 立即拉取 / 退出登录 |
| `#conflictTakeRemote` `#conflictPushLocal` `#conflictCancel` | `click` | 冲突三选一 |
| `#seedBtn` | `click` | 填入示例课程与示例打卡 |
| `#exportBtn` | `click` | 导出 JSON |
| `#importBtn` `#importFile` | `click` / `change` | 选择并导入 JSON 备份 |
| `#clearBtn` `#resetActivityBtn` `#heatResetBtn` `#demoClearBtn` | `click` | 清空 / 重置打卡 / 清除示例 |
| `window` | `online` / `offline` | 恢复或暂停同步、重连实时 |
| `document` | `visibilitychange` | 隐藏时停轮询；可见时 `onForeground` |
| `window` | `focus` | `onForeground` |
| `document` | `focusout` | 若存在 `pendingEditPull` 且不再编辑课时 → 触发补拉 |
| `window` | `resize` | 200 毫秒防抖后重绘热力图（或标记 study dirty） |

## 8. 启动顺序

```js
applyBranding();                       // 站点名
el.promptText.textContent = BILI_PROMPT;
el.todoPromptText.textContent = TODO_IMPORT_PROMPT;
bindFoldPanels();                      // 云同步 / B 站导入折叠
initSupa();                            // 读配置、恢复登录、渲染面板
renderAll();                           // 首屏
if (schemaTooNew) {...}                // 版本过新提示
if (migratedOnLoad) saveState();       // 迁移结果立刻落盘
window.addEventListener("resize", ...);
document.documentElement.setAttribute("data-app-ready", "1");
```

`data-app-ready = 1` 是 `index.html` 尾部兜底脚本的判断依据：2.5 秒内没有置位就提示「脚本没有加载成功，请强制刷新」。

## 9. 代码风格与扩展建议

- 代码使用现代 JavaScript：`const` / `let`、模板字符串、`async/await` 与 `Promise`，但**没有**箭头函数、没有 `class`、没有 ES Module。新增代码沿用这一风格（普通 `function` + `const`），浏览器兼容不是约束重点，一致性更重要。
- 新增视图时：在 `index.html` 加 `role="tabpanel"` 区块 → `el` 引用表加字段 → `viewDirty`/`viewScroll` 加键 → `renderView` 分支 → `setView` 的 `views`/`tabs` 映射 → `bindTabKeys` 的 `order`。
- 新增可选字段时：`sanitize` 的白名单要放行 → `snapshot()` 要带上（否则同步会丢）→ 导出逻辑要带上 → 旧数据按默认值兜底。
- 新增会改 `state` 的操作时：必须 `saveState()`；如果影响多个视图，用 `renderAll()`，只影响单视图再用局部 `renderXxx()`。
