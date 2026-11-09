# 02 · 数据模型与本地存储

## 1. 唯一数据源：`state`

`app.js` 中的模块级变量 `state` 是运行时唯一数据源。结构为「v2 格式 + `schemaVersion` 版本号」：

```jsonc
{
  "v": 2,                        // 内部结构代际：v1 是「集数制」，v2 是「分钟制」
  "schemaVersion": 3,            // 快照版本号，用于跨页面/跨设备防护
  "courses": [
    {
      "id": "lq3k9x2ab",         // 字符串 ID，makeId() 生成
      "name": "C 语言程序设计",   // ≤ 40 字符
      "lessons": [
        {
          "id": "lq3k9x2cd",
          "totalMin": 45,        // 总时长（分钟），0 表示未设，不计入统计
          "watchedMin": 30,      // 已看时长（分钟），不得超过 totalMin
          "title": "P1 绪论",     // 可选，≤ 120 字符
          "page": 1,             // 可选，B 站分 P 序号
          "url": "https://www.bilibili.com/video/BV...?p=1" // 可选，仅站内链接
        }
      ],
      "demo": true,              // 可选：示例课程标记
      "source": "bili",          // 可选：来源，仅 "bili" 会被识别为 B 站课程
      "bvid": "BV1xx411c7mD",    // 可选：BV 号（source=bili 时保留）
      "videoTitle": "完整视频标题" // 可选：B 站原视频标题，≤ 200 字符
    }
  ],
  "activity": {                  // 每天累计观看分钟数（统计卡与热力图只认它）
    "2026-11-07": 43
  },
  "demoActivity": {              // 示例打卡单独记一份，便于整份清除
    "2026-11-01": 45
  },
  "details": {                   // 每日明细，与 activity 并存
    "2026-11-07": [
      { "cid": "课程ID", "lid": "课时ID", "idx": 3, "min": 43, "at": 1762528800000 }
    ]
  },
  "demoDetails": {               // 示例明细
    "2026-11-01": []
  },
  "todos": [
    {
      "id": "lq3k9x2ef",
      "title": "提交计算机专业英语大作业",
      "cat": "study",            // study | contest | event | other
      "due": "2026-11-11",       // YYYY-MM-DD，可为空
      "dueTime": "18:00",        // HH:mm，可为空
      "pri": "P0",               // P0 | P1 | P2
      "done": false,
      "doneAt": null,            // 毫秒时间戳，未完成时 null
      "note": "先完成双语总结文档", // ≤ 500 字符
      "link": "https://example.com", // 仅 http/https，≤ 300 字符
      "dueNote": "老师口头通知"     // 可选，截止待确认时的补充说明，≤ 80 字符
    }
  ],
  "courseOpen": { "课程ID": true },        // 课程卡片展开状态
  "panelOpen": { "sync": false, "bili": false } // 底部折叠面板展开状态
}
```

### 1.1 顶层字段约束

| 字段 | 类型 | 约束 | 清洗函数 |
| --- | --- | --- | --- |
| `v` | number | 固定输出 2 | `sanitize` |
| `schemaVersion` | number | 固定输出当前 `SCHEMA_VERSION`（3） | `sanitize` |
| `courses` | array | 只保留 `name` 非空字符串的项 | `sanitize` |
| `activity` | object | 键必须是 `YYYY-MM-DD`，值 0–99999，只保留 > 0 | `sanitize` |
| `demoActivity` | object | 同上，但只记录示例部分 | `sanitize` |
| `details` / `demoDetails` | object | 键 `YYYY-MM-DD`，值按 `cleanDetails` 合并 | `cleanDetails` |
| `todos` | array | 按 `cleanTodos` 逐条白名单校验 | `cleanTodos` |
| `courseOpen` | object | 只保留仍存在课程且值为 `true` 的键 | `sanitize` |
| `panelOpen` | object | 只读取 `sync` / `bili` 两个键的布尔值 | `sanitize` |

### 1.2 字段级边界值

| 对象 | 字段 | 边界 | 代码位置 |
| --- | --- | --- | --- |
| 课程 | `name` | 40 字符 | `cleanCourseV2` |
| 课时 | `totalMin` | 0–9999 | `cleanCourseV2` |
| 课时 | `watchedMin` | 0–9999，且 ≤ `totalMin` | `cleanCourseV2` / `commitLessonField` |
| 课时 | `title` | 120 字符 | `cleanCourseV2` |
| 课时 | `page` | 1–9999 | `cleanCourseV2` |
| 课时 | `url` | 必须匹配 `BILI_URL_RE`（B 站视频链接） | `cleanCourseV2` |
| 打卡 | 日分钟 | 0–99999 | `sanitize` |
| 明细 | `min` | 1–99999 | `cleanDetails` |
| 明细 | `at` | ≤ 4102444800000（约 2100 年） | `cleanDetails` |
| 待办 | `title` | 120 字符 | `cleanTodos` / `parseTodoImport` |
| 待办 | `id` | `/^[A-Za-z0-9_-]{1,40}$/`，冲突时重新生成 | `cleanTodos` |
| 待办 | `due` | `YYYY-MM-DD`（`cleanTodos` 只校验格式；批量导入时另用 `isValidTodoDate` 校验真实日期） | `cleanTodos` / `isValidTodoDate` |
| 待办 | `dueTime` | `00:00–24:00`；提示词要求 `00:00–23:59`，解析器额外兼容 `24:00`（计算截止时按 23:59） | `cleanTodos` / `normalizeTodoTime` |
| 待办 | `note` | 500 字符 | `cleanTodos` |
| 待办 | `link` | 必须 `http://` 或 `https://`，300 字符 | `cleanTodos` |
| 待办 | `doneAt` | 0–4102444800000 | `cleanTodos` |

## 2. 统计口径

### 2.1 单节百分比

```
lessonPct(lesson) = round(min(watchedMin, totalMin) / totalMin × 100)
totalMin = 0 → null（显示「—」，且不计入课程统计）
```

### 2.2 课程汇总（`courseStats`）

- 只累计 `totalMin > 0` 的课时；
- `watchedMin` 先截断到 `totalMin`；
- `doneLessons`：`watchedMin >= totalMin` 的节数；
- `pct`：按**时长加权**，不是按节数平均；
- `invalid`：总时长缺失的节数，界面会提示「N 节未设时长，未计入」。

### 2.3 总体汇总（`overallStats`）

对所有课程累加 `totalMin / watchedMin / doneLessons / count / invalid`，再按时长加权算总百分比。首屏圆环与三个统计卡全部来自它。

### 2.4 连续打卡（`renderStreak`）

从今天往前数 `activity` 有记录的天数；今天还没记时从昨天开始数，避免早上打开就把连击清零。

## 3. localStorage 键

| 键 | 内容 | 谁写 | 是否随导出文件走 |
| --- | --- | --- | --- |
| `study-log-v1` | 整份进度 `state` | `saveState()` | 是（导出文件） |
| `study-supabase-v1` | `{ url, anonKey, auto }` | `saveSupaCfg()` | 否 |
| `study-supabase-session-v1` | `{ accessToken, refreshToken, expiresAt, userId, email }` | 登录 / 续期 | 否 |
| `study-supabase-meta-v1` | `{ userId, baseRev, syncedHash, lastSyncAt }` | `saveSupaMeta()` | 否 |

设计要点：

- 主数据键沿用旧名 `study-log-v1`，老用户的 v1 数据能原地读取后迁移，不需要换键。
- 云同步配置与登录态和进度完全分离：清除配置 / 退出登录不会删除本机进度，导出文件也不会带出密钥。
- `anonKey` 字段存的是 Publishable key，是可公开的浏览器密钥，真正的安全边界是 Supabase 表上的 RLS（见 [05 云同步](05-cloud-sync.md)）。

## 4. 读写流水线

### 4.1 启动读取（`loadState`）

```
localStorage.getItem("study-log-v1")
  ├── 无值 → emptyState()
  └── 有值 → JSON.parse → sanitize()
        ├── 返回 null（不是对象）→ emptyState()
        └── 抛异常 → console.warn → emptyState()
```

### 4.2 写入（`saveState`）

```
JSON.stringify(state) → localStorage.setItem
  ├── 失败（配额满）→ toast("本地保存失败，可能是浏览器存储空间已满")
  └── 成功后，若未 suppressAutoSync → scheduleAutoSync()（1.5 秒防抖）
```

`suppressAutoSync` 只在「用云端数据覆盖本地」期间置真，避免刚拉下来的数据又立刻被当成新改动上传。

### 4.3 清洗顺序（`sanitize`）

1. 非对象直接返回 `null`。
2. 读取 `schemaVersion`，若大于当前 `SCHEMA_VERSION` → 置 `schemaTooNew = true`（停止自动上传）。
3. 判断是否 v1：`data.v === 1`，或存在 `!Array.isArray(c.lessons) && "total" in c` 的课程。
4. 课程：有 `lessons` 数组走 `cleanCourseV2`，否则走 `migrateCourseV1`。
5. `courseOpen`：只保留仍存在课程的键；`panelOpen`：只认 `sync` / `bili`。
6. `activity`：日期键校验；v1 数据把「集数」乘以 `DEFAULT_LESSON_MIN = 45`。
7. `demoActivity`：同上但不做 v1 折算。
8. `details` / `demoDetails`：`cleanDetails`。
9. `todos`：`cleanTodos`。
10. 输出统一 v2 结构。

### 4.4 v1 → v2 迁移（`migrateCourseV1`）

v1 课程的形状是 `{ id, name, total, done: [集数...] }`。

```
total = clampInt(total, 1, 999, 1)
doneSet = Set(done 数组中的整数)
逐节生成：{ id: makeId(), totalMin: 45, watchedMin: 已完成 ? 45 : 0 }
```

同时把 `activity` 的「集数」按 45 分钟/节折算成分钟，并置 `migratedOnLoad = true`。启动结束后立即 `saveState()` 落盘，并在界面上提示「旧数据已迁移」，保证只迁移一次。

### 4.5 明细清洗（`cleanDetails`）

目标结构：`{ "YYYY-MM-DD": [{ cid, lid, idx?, min, at? }] }`。

- 非 `YYYY-MM-DD` 的键直接丢弃；
- 每条要求 `cid` / `lid` 非空、`min > 0`；
- **同一天同一课时（`cid|lid`）合并累加**，`min` 上限 99999，`at` 取更大值，`idx` 取先出现的非零值；
- 旧数据没有 `details` 字段时返回空对象，不报错。

### 4.6 待办清洗（`cleanTodos`）

- 必须有非空 `title`，否则丢弃；
- `cat` 不在 `study/contest/event/other` → `other`；
- `pri` 不在 `P0/P1/P2` → `P1`；
- `due` 必须 `YYYY-MM-DD`；`dueTime` 必须 `HH:mm` 或 `24:00`；
- `link` 必须 `http(s)://`，否则清空；
- 重复 `id` 自动重新生成；
- 未知字段一律丢弃（`dueNote` 是唯一额外保留的可选字段）。

## 5. 导出文件格式

`导出数据` 按钮生成 `<APP_NAME>-<YYYY-MM-DD>.json`，缩进 2 空格：

```jsonc
{
  "v": 2,
  "schemaVersion": 3,
  "exportedAt": "2026-11-09T...Z",
  "courses": [...],
  "activity": {...},
  "demoActivity": {...},
  "details": {...},
  "demoDetails": {...},
  "todos": [...],
  "courseOpen": {...},
  "panelOpen": {...}
}
```

导入时：

1. `FileReader.readAsText(file, "utf-8")`；
2. `JSON.parse` → `sanitize`；
3. 确认「会覆盖当前所有记录」；
4. `state = data` → `saveState()` → `renderAll()`。

`exportedAt` 只用于人查看，不参与任何逻辑。导入同样接受只含 `courses` 的旧文件，缺失字段按空值兜底。

## 6. 示例数据机制

示例数据与真实数据在结构上完全同构，但通过三个标记隔离：

| 标记 | 作用 |
| --- | --- |
| `course.demo = true` | 课程卡片显示「示例」标签 |
| `state.demoActivity` | 示例打卡单独累计，清除时从这里扣回 |
| `state.demoDetails` | 示例明细单独存放，清除时整份删除 |

`seedBtn`（填入示例课程）会：

1. 先移除上一次的示例课程，保留用户自己的课程；
2. 新增「C 语言程序设计」（86 节，第 13 节为 83 分钟只看 43 分钟的样例）与「大学计算机基础」（24 节 × 30 分钟）；
3. `subtractDemoActivity()` 先扣掉旧示例打卡，防止重复叠加；
4. 写入 6 天示例打卡（45/90/20/60/30/120 分钟）与逐条示例明细。

`demoClearBtn`（清除示例数据）只删 `demo === true` 的课程、`demoActivity` 与 `demoDetails`，并把这部分分钟数从 `activity` 中扣回；用户自己登记的数据不受影响。

`heatResetBtn` / `resetActivityBtn`（重置打卡记录）则清空 `activity / demoActivity / details / demoDetails`，但保留课程与每节 `watchedMin`。

## 7. 版本防护（`schemaVersion`）

| 场景 | 行为 |
| --- | --- |
| 本地数据 `schemaVersion > 3` | `schemaTooNew = true`，停止自动上传，状态行提示「请刷新页面」 |
| 云端数据 `schemaVersion > 3` | `blockNewerSchema()`，停止上传并暂停自动拉取 |
| 本地缺少 `todos` / `details` / `schemaVersion` | 按空数组 / 空对象 / 当前版本读取，不报错 |
| 上传数据接近 1 MB | `uploadTooBig()`：本地体积 > 900000 字符时拒绝上传并提示先导出备份 |

## 8. 数据清理的三种粒度

| 操作 | 入口 | 清除范围 | 保留 |
| --- | --- | --- | --- |
| 清除示例数据 | 示例提示条 | 示例课程、示例打卡、示例明细 | 真实课程 / 打卡 / 待办 |
| 重置打卡记录 | 页脚 / 热力图提示 | `activity`、`demoActivity`、`details`、`demoDetails` | 课程与每节已看时长 |
| 清空数据 | 页脚 | 全部（回到 `emptyState()`） | 无（仅保留界面展开状态默认值） |

三者都不可撤销，且都会先 `confirm()`；清空后重新 `saveState()` 并 `renderAll()`，登录状态下会触发一次云同步（即云端也会被清空，因此界面文案明确提示「建议先导出备份」）。
