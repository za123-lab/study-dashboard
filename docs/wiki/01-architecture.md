# 01 · 整体架构

## 1. 项目定位

一个「一个人的学业台账」。它不做多用户、不做服务端渲染、不做数据库建模，而是把一个人的全部学习进度压缩成一个 JSON 文档，前端整份读、整份写。

由此推导出三条架构主线：

1. **单文档状态**：`state` 是唯一数据源，渲染函数只读它，写操作只改它，然后 `saveState()` 落盘。
2. **本地优先 + 云端备份**：`localStorage` 永远是主存储；云同步是附加动作，失败不影响记录。
3. **输入靠导入，不靠爬取**：需要外部数据（B 站分 P 时长、AI 整理的任务清单）时，由用户把数据带进来，前端只做校验、预览与写入。

## 2. 技术栈与约束

| 层次 | 技术 | 约束 |
| --- | --- | --- |
| 标记 | 原生 HTML5，语义化标签 + ARIA | 不使用模板引擎，静态骨架全在 `index.html` |
| 样式 | 原生 CSS，自定义属性做设计令牌 | 无预处理器、无 CSS 框架 |
| 逻辑 | 原生 JavaScript，单个 IIFE，`"use strict"` | 无模块系统、无 npm 依赖、无构建步骤；语法为现代 JS（`const/let`、模板字符串、`async/await`），无箭头函数与 `class` |
| 持久化 | `localStorage` | 只存字符串化 JSON；无 IndexedDB |
| 云 | Supabase（Auth / PostgREST / Realtime） | 手写 HTTP 与 WebSocket，配置由用户填在页面里 |
| 可选代理 | Cloudflare Workers + D1 | 已停用，不参与当前运行链路 |

**为什么没有 `package.json`**：项目刻意保持「打开即用」。任何依赖都会带来构建产物、版本锁定和部署复杂度，而个人工具的数据量（几十门课、几年打卡）远小于 1 MB，用不上工程化。

## 3. 目录与文件职责

```
study-dashboard/
├── index.html      # 页面骨架（结构层）
├── style.css       # 视觉与布局（表现层）
├── app.js          # 业务与同步（行为层）
├── DESIGN.md       # 设计决策文档（信息归属 / 颜色语义 / 排版）
├── supabase/       # 云同步的数据库定义与配置手册
└── worker/         # 历史后端，已停用
```

### 3.1 `index.html`

- 一个 `<main>` 容器内并列三个 `role="tabpanel"` 视图：`#viewStudy`、`#viewTodo`、`#viewCalendar`。
- 三个视图共用的弹层放在 `<main>` 之后：`#syncConflict`、`#dayDetail`、`#todoEditor`、`#toast`。
- 页脚之后是「设置 · 云同步」与「B 站课程导入」两个折叠面板。
- 只加载 `style.css` 与 `app.js`，末尾有一段 2.5 秒兜底脚本：若 `data-app-ready` 未置 1，提示用户强刷。

### 3.2 `style.css`

按「令牌 → 布局 → 组件 → 视图 → 响应式」组织，二十多个按注释划分的分区，详见 [04 页面与样式](04-ui.md)。

### 3.3 `app.js`

单个 IIFE 内按注释分成若干区段：

```
常量与运行状态
├── 时间工具 / 日期工具 / 通用工具
├── 存储：loadState / saveState / sanitize / 迁移
├── DOM 引用表 el
├── 渲染：视图 / 课程 / 热力图 / 待办 / 日历 / 头部
├── 课程与课时操作
├── B 站导入（提示词 / 解析 / 预览 / 写入）
├── 云同步（配置 / 认证 / REST / Realtime / 冲突）
├── 导入导出 / 数据清理
└── 事件绑定 + 启动
```

## 4. 分层视图

```
┌──────────────────────────────────────────────────────────────┐
│ 表现层  index.html（静态骨架） + style.css（令牌与组件）        │
├──────────────────────────────────────────────────────────────┤
│ 渲染层  renderView / renderAll                                │
│         ├── 学习视图：renderToday / renderStats / renderCourses│
│         │             / renderHeatmap / renderDemoNotice       │
│         ├── 待办视图：renderTodos                              │
│         └── 日历视图：renderCalendar                           │
├──────────────────────────────────────────────────────────────┤
│ 业务层  课程 / 课时 / 打卡 / 明细 / 待办 / 导入导出             │
│         全部是纯函数操作 state，再 saveState()                 │
├──────────────────────────────────────────────────────────────┤
│ 数据层  state（内存唯一源） ⇄ localStorage(study-log-v1)        │
│         sanitize() 负责读入校验与版本兼容                       │
├──────────────────────────────────────────────────────────────┤
│ 同步层  Supabase Auth + PostgREST + Realtime（可选）           │
│         snapshot() / hashState() / rev 乐观锁 / 冲突弹窗        │
└──────────────────────────────────────────────────────────────┘
            （可选、已停用）Cloudflare Worker + D1
```

## 5. 关键数据流

### 5.1 本地读写（主链路）

```
用户操作（点击 / 输入 / 提交）
   ↓ 事件委托（app.js 底部）
修改 state（addCourse / commitLessonField / confirmTodoImport ...）
   ↓
saveState()
   ├── JSON.stringify → localStorage["study-log-v1"]
   └── scheduleAutoSync()  （登录且开启自动同步时，1.5 秒防抖后上传）
   ↓
renderAll() 或局部 renderXxx()
   ↓
DOM 更新（innerHTML 或 textContent）
```

### 5.2 读入与迁移（启动链路）

```
localStorage 原始字符串
   ↓ JSON.parse
sanitize(data)
   ├── 检查 schemaVersion 是否高于当前页面 → schemaTooNew=true（停止自动上传）
   ├── 判断 v1 / v2 结构
   ├── courses  ：v2 → cleanCourseV2，v1 → migrateCourseV1
   ├── activity ：日期键校验；v1 的「集数」×45 折算成分钟
   ├── details / demoDetails → cleanDetails（同日同课时合并）
   ├── todos → cleanTodos（字段白名单 + 兜底默认值）
   └── courseOpen / panelOpen → 只保留有效键
   ↓
state（规范化后的 v2 结构）
   ↓
renderAll()
```

### 5.3 B 站课程导入

```
复制提示词（BILI_PROMPT） → 交给 AI → AI 返回 JSON
   ↓ 用户粘贴
parseBiliPayload()
   ├── 去掉 ```json 包裹
   ├── JSON.parse 失败 → locatePos / findBracketMismatch 定位行列
   ├── 校验 bvid / title / lessons[].page,title,duration
   ├── duration 支持 "mm:ss"、"h:mm:ss"、纯秒数
   └── 生成统一结构（含默认 url、totalMin）
   ↓
showImportResult() → 预览表 + 重复课程检测（同 bvid 或同名）
   ↓ 用户选择「新增 / 覆盖」
confirmBiliImport() → state.courses 变更 → saveState → renderAll
```

### 5.4 云同步

```
saveState() → scheduleAutoSync()（1.5s 防抖）
   ↓
pushLocal() → uploadSnapshot()
   ├── 先 fetchRemote() 比对最新 rev
   ├── rev 不一致 → showConflict（绝不覆盖）
   ├── 无记录 → insertRemote（POST，rev=1）
   └── 有记录 → updateRemote（PATCH ...&rev=eq.{baseRev}，rev+1）
   ↓
markSynced(row) → 记录 baseRev / syncedHash / lastSyncAt
```

拉取方向由三条触发源合并：Realtime WebSocket 变更通知、页面回到前台、60 秒兜底轮询。三者最终都调用 `requestPull()`，同一时刻只允许一个请求。详见 [05 云同步](05-cloud-sync.md)。

## 6. 模块职责表

| 模块 | 位置 | 职责 | 对外接口（内部函数） |
| --- | --- | --- | --- |
| 时间与日期工具 | `app.js` 顶部 | 分钟/时长格式化、日期键、周数、热力档位 | `fmtDur` `parseDuration` `dateKey` `todayKey` `addDays` `minuteLevel` |
| 统计 | `app.js` 顶部 | 单节百分比、课程与总体加权进度 | `lessonPct` `courseStats` `overallStats` |
| 存储与校验 | `app.js` 存储区 | 读入、迁移、白名单清洗、落盘 | `loadState` `saveState` `sanitize` `cleanCourseV2` `cleanDetails` `cleanTodos` |
| 学习视图 | `app.js` 渲染区 | 今日摘要、统计卡、课程卡片、热力图、示例提示 | `renderToday` `renderStats` `renderCourses` `renderHeatmap` |
| 当日详情 | `app.js` 渲染区 | 热力图/日历点开某天，展示学习明细与当天待办 | `openDayDetail` `describeDetail` `todosOnDay` |
| 待办 | `app.js` 待办区 | 清单渲染、筛选、计数、紧急度、增删改、批量导入 | `renderTodos` `sortedTodos` `parseTodoImport` `confirmTodoImport` |
| 日历 | `app.js` 日历区 | 月历网格、手机列表、月度统计、日期点击 | `renderCalendar` `shiftMonth` `calUrgency` |
| 视图切换 | `app.js` 视图区 | 惰性渲染、滚动位置恢复、键盘切换 | `setView` `bindTabKeys` |
| 课程操作 | `app.js` 数据操作区 | 增删课程/课时、改时长、加 15 分、看完、改标题 | `addCourse` `removeCourse` `commitLessonField` `applyLessonAction` |
| 数据清理 | `app.js` 数据操作区 | 清示例、重置打卡、清空全部 | `clearDemoData` `resetActivity` `emptyState` |
| 导入导出 | `app.js` 尾部事件区 | JSON 备份下载 / 文件导入 | 事件内联逻辑 |
| B 站导入 | `app.js` B 站区 | 提示词、JSON 校验、预览、新增/覆盖 | `parseBiliPayload` `showImportResult` `confirmBiliImport` |
| 云同步 | `app.js` 云同步区 | 配置、登录、上传、拉取、冲突、状态提示 | 见 05 文档 |
| 自动拉取 | `app.js` 自动拉取区 | Realtime、轮询、前台检查、请求合并 | `requestPull` `runAutoPull` `realtimeConnect` |
| Worker（停用） | `worker/src/index.js` | B 站接口透传、同步码读写 | `export default { fetch }` |

## 7. 外部依赖关系

```
浏览器
 ├── localStorage                     （强依赖）
 ├── fetch / WebSocket / AbortController（云同步时使用）
 ├── Date + 手写格式化                 （日期键、周几、时长）
 └── navigator.clipboard + execCommand（复制提示词降级链）

网页 ──(可选, HTTPS)──> Supabase
 ├── POST /auth/v1/token?grant_type=password
 ├── POST /auth/v1/token?grant_type=refresh_token
 ├── POST /auth/v1/logout
 ├── GET  /rest/v1/study_state?...
 ├── POST /rest/v1/study_state
 ├── PATCH /rest/v1/study_state?user_id=eq...&rev=eq...
 └── WS   /realtime/v1/websocket?apikey=...&vsn=1.0.0

网页 ──(不再调用)──> Cloudflare Worker
 ├── GET /bili?bvid=BV...
 └── GET|PUT /sync/{code}
```

## 8. 关键设计决策

| 决策 | 原因 | 代价 |
| --- | --- | --- |
| 整份 JSON 存一行，而不是拆课程表/课时表 | 渲染、导出、导入、示例数据共用同一对象；单行条件更新天然原子 | 以后要做跨用户统计或按课程检索，需要拆表或物化视图 |
| 用 `rev` 而不是时间戳做乐观锁 | 版本号单调递增，比较不受设备时钟影响 | 必须在每次成功写入后同步本地 `baseRev` |
| 冲突必须用户选择 | 学习记录不可再生，静默覆盖会丢数据 | 多设备同时改时多一步交互 |
| 按视图惰性渲染 | 首屏只构建学习视图，减少无谓 DOM | 需要维护 `viewDirty` 标记 |
| 用 AI 生成 JSON 而不是直连 B 站 API | 绕开 CORS 与 412 风控，也不需要在仓库里放代理密钥 | 依赖用户手动两步操作 |
| 所有外部输入都过 `sanitize` / `cleanXxx` | 导入文件、云端数据、旧版本数据都不可信 | 白名单字段需要随结构演进同步维护 |
| `schemaVersion` 单向防护 | 旧页面读到新数据时停止上传，避免把新字段写丢 | 用户需要刷新页面才能继续同步 |

## 9. 阅读下一步

- 想改数据结构 → [02 数据模型](02-data-model.md)
- 想改业务逻辑 → [03 前端逻辑](03-frontend.md)
- 想改界面 → [04 页面与样式](04-ui.md)
- 想改同步 → [05 云同步](05-cloud-sync.md)
- 想部署 → [07 运行与部署](07-run-and-deploy.md)
