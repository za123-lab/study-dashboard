# 10 · 桌面小组件插件（@local/dsh-study-widget）

> 代码级说明：一个 DSH 插件如何既在 Web UI 里注册**左栏一级入口与主区整页**，又在桌面上拉起一个独立的 Electron 小窗，
> 并把学习进度以「助手工具 + 斜杠命令 + HTTP 接口」三种方式暴露出去。
> 使用者视角的安装与操作见 [插件 README](../../plugins/study-widget/README.md)；插件总清单见 [plugins/README.md](../../plugins/README.md)；
> 端到端验收清单见 [docs/ACCEPTANCE.md](../../plugins/study-widget/docs/ACCEPTANCE.md)。

## 1. 为什么是插件，而不是另一个网页

网页版和 APP 都是「打开一个页面」的形态，而用户想要的是「不用打开任何东西就能看到今天学到哪」。
DSH 已经常驻桌面，于是把视图做进 DSH：

| 需求 | 落点 |
| --- | --- |
| 一眼看到进度，不打断工作 | 无边框、置顶、380×640 的桌面小窗 |
| **配置也在 DSH 里完成，不再手改 JSON** | 左栏一级入口 → 主区整页面板 → 面板内设置页 |
| 与 DSH 主界面同色同字 | 面板与设置页只读 `--dsw-alias-*` token，不写死颜色 |
| 让助手能回答「我今天学到哪」 | 宿主侧注册 `study_widget_progress` 工具 |
| 不重复写渲染逻辑 | **一份页面**（`assets/widget.*`）+ 三个壳（Electron BrowserWindow、左栏主面板 iframe、右侧栏 iframe） |

关键决策：**渲染只在宿主侧做一次**。Electron 小窗、左栏主面板、右侧栏面板都指向 `/dsh-study-widget/?mode=…`，
数据、样式、文案全部同源，改一处三边同时生效。

## 2. 进程与数据流

```
              ┌──────────────── 宿主进程（node，index.js）────────────────┐
Supabase ◀───▶│ lib/source.js   登录/refresh/拉 public.study_state         │
  (Auth +     │ lib/settings.js settings.json 读写（原子写、密码只进不出）  │
   PostgREST) │ lib/summary.js  归一化 + 复刻 app.js 统计口径              │
              │ lib/stats.js    纯函数：进度、连续天数、紧急度、热力图      │
              │ webServer 前缀路由 /dsh-study-widget（页面 + /api/*）      │
              │ lib/desktop.js  spawn Electron，记住位置，单实例          │
              └───┬──────────────┬──────────────────┬────────────────────┘
                  │ HTTP         │ HTTP             │ spawn
          ┌───────▼───────┐ ┌────▼──────────┐ ┌─────▼────────────┐
          │ 左栏主面板     │ │ 右侧栏 iframe │ │ Electron 小窗     │
          │ main(keyed)   │ │ client.js     │ │ main.cjs/preload │
          │ + 设置页      │ └───────────────┘ └──────────────────┘
          └───────────────┘
```

- 小窗从不直接访问 Supabase：登录态、缓存、限流都在宿主进程里做，token 不落到渲染层。
- 宿主侧缓存默认 30 秒（`summaryTtlSeconds`），页面默认 5 分钟自动刷新（`pageSeconds`），点 ↻ 走 `?refresh=1`。
- 无凭据 / 网络失败 → 回落 `~/.dsh/study-widget/latest.json`，页脚标「显示缓存」，错误原因记在 `/api/status`。
- 设置与凭据同目录：`settings.json`（表单保存）、`login.json`（手写兼容）、`latest.json`（快照）、`window.json`（位置）。

## 3. 目录与职责

| 文件 | 职责 | 不该做什么 |
| --- | --- | --- |
| `index.js` | 注册路由、`/api`、设置端点、agent 工具、`/study` 命令、按 `desktop.autoOpen` 自动开窗 | 不写统计逻辑；不自己改 profile patch |
| `client.js` | 注册 `sidebar.panellist` 入口 + `main` 主面板页；顶栏「进度 / 设置」分段切换同一 iframe 的两个页面；保留 `sidebarRightTabs` 右侧栏标签 | 不直接算数据 |
| `lib/settings.js` | `settings.json` 读写与归一化、原子写、密码掩码（`hasPassword`） | 不发起网络请求 |
| `lib/source.js` | 凭据读取（settings.json → login.json）、Supabase 认证与查询、快照落盘 | 不做展示格式化 |
| `lib/summary.js` | 把 `state` 归一化成小组件快照（字段见下） | 不做网络请求 |
| `lib/stats.js` | 与 `app.js` **逐字对齐**的统计口径 | 不依赖宿主 |
| `lib/desktop.js` | 找 Electron、spawn、复用、退出、位置记忆 | 不碰业务数据 |
| `desktop/main.cjs` | BrowserWindow、置顶、右键菜单、IPC、设置页模式（`--relaunch-settings`） | 不写 HTML |
| `desktop/preload.cjs` | `contextBridge` 暴露最小 IPC 面 | 不暴露 node |
| `assets/widget.*` | 页面、样式、前端渲染（widget / panel 两种模式） | 不直连数据库 |
| `assets/settings.*` | 设置页：左侧分区导航 + 右侧表单 | 不自己拼 Supabase 请求（走 `/api/settings/test`） |

## 4. 左栏入口与设置页

### 4.1 为什么是 `sidebar.panellist` + `main`，而不是 `settings.section`

DSH 的侧栏外壳（`@deepseek-ai/dsh-client-ui-sidebar`）把导航位分成几类：

| 类别 | slot | 形态 | 本轮是否采用 |
| --- | --- | --- | --- |
| 一级面板入口 | root 作用域 `sidebar.panellist`（list） | 侧栏里的图标 + 名称行，选中后由布局把主区切到**同 id** 的 `main` 组件 | ✅ **采用** |
| 一级面板本体 | root 作用域 `main`（keyed） | 主区整页 | ✅ **采用**（key 与 panellist id 逐字相同） |
| 面板行的附加动作 | `sidebar.panellist.actions` | 面板行后的「更多」菜单 | ⬜ 本轮不需要 |
| 设置弹窗内的分区 | `settings.section` | 设置外壳里的一页 | ❌ 不用 |
| 底栏设置齿轮席位 | `sidebar.settings` | 侧栏底部那一个入口 | ❌ 不要抢 |

理由（按重要性排序）：

1. **用户原话是「做进左栏」**，不是「塞进设置弹窗」。`settings.section` 是设置弹窗内的分区账本，
   进来要先点齿轮、再找分区，路径比左栏一级入口长两步，且主区空间被设置弹窗压窄 —— 面板里要放进度条与设置表单，放不下。
2. **主区才是整页**。panellist 选中的面板渲染在 root 作用域 `main` keyed slot 里，是全宽整页；
   设置弹窗与右侧栏标签都只有半宽。
3. **`sidebar.settings` 是 single 槽，已由 settings-general 独占**。抢它会直接顶掉 DSH 自己的设置齿轮入口，
   属于破坏宿主导航，绝对不能碰。
4. **panellist 的 id 与 main 的 key 是同一套寻址**：同一 id 寻址布局中 root 作用域 `main` keyed slot 的组件，
   选中一个不存在的主面板条目会**抛错并保留当前选中态** —— 所以两份注册的 id 必须逐字一致，
   这也是最容易写错的一处（见第 7 节踩坑 9）。

参考实现（宿主自带的插件管理面板）：`@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`
同时注册 `main`（`key: PANEL_ID`）与 `sidebar.panellist`（`id: PANEL_ID`），本插件照这个形状写。

### 4.2 设置持久化为什么不用 `configEditor.edit()`

插件的静态配置（`apply(ctx, config)` 的第二参数）确实可以用 `configEditor.edit()` 改，但那会触发**插件重启**：

- 重启期间 Host 的 `/dsh-study-widget` 前缀路由被卸掉，正在加载的面板 iframe、设置页本身全部断连；
- Electron 小窗里的 URL 带着一次性 `?t=<token>`，token 是 `apply()` 时现生成的，重启即失效 → 小窗白屏；
- 桌面窗口是独立进程，没有宿主 Cookie，token 一换就必须重开窗口，用户会看到窗口闪一下又消失。

于是本轮把「用户可改的设置」与「插件静态配置」分成两层：

| 层 | 存哪 | 改法 | 生效 |
| --- | --- | --- | --- |
| 静态配置（`electronPath`、`autoOpen`、`stateFile`、`offline`） | profile 的 patch 层 | `configEditor` / 手改 patch | 需重载插件 |

> `autoOpen` 特殊：设置页的 `desktop.autoOpen` **优先于**这里的静态配置，只有在 `settings.json` 里
> 没有该布尔值时才回落静态配置（见踩坑 19）。
| **运行时设置**（连接、窗口、刷新、数据、高级） | `~/.dsh/study-widget/settings.json`，原子写 | `POST /api/settings` | **立即**，不重启插件 |

`settings.json` 与 `login.json` 同目录（`credentialPaths().home`），便于迁移；原子写复用 `lib/source.js` 里已有的
`writeJson`（写 `.tmp` 再 `rename`），中途失败不会把文件写坏。

### 4.3 安全边界

| 边界 | 规则 | 落点 |
| --- | --- | --- |
| **密码只进不出** | `GET /api/settings` 只返回 `hasPassword` / `hasRefreshToken`，永不返回密码；登录成功后只在内存中复用 refresh token | `lib/settings.js` 的 `view()` 投影 |
| **明文密码的边界要说清** | 设置页保存的密码在 `settings.json` 的 `secret.password` 里是**明文**（本机私有文件）。文档必须明说，别让读者误以为是加密的；不接受明文的人应改用 `refreshToken` / `passwordCommand` | `lib/settings.js` 的写入逻辑 |
| **留空不覆盖** | 保存时 `password` 为空 = 保持原密码，而不是清空 | `POST /api/settings` 的 `sanitize()` 合并逻辑 |
| **主机鉴权** | `/api/*` 放行「本机同源 / DSH Cookie / `?t=<token>`」三者之一，其余 401；有 `Origin` 头时必须与 `Host` 同源（防其它本地网页跨站读） | `index.js` 的 `authorized()` |
| **静态资源不越界** | 只从 `assets/` 读，`path.resolve` 后必须仍以 assetsDir 开头，越界 403/404 | `index.js` 的 `serveAsset()` |
| **插件开关委托宿主** | 插件**不得自己读写** `cordis.patch.yml` / `package.json`；`/api/plugin` 只是一层委托，真正落盘与热重载由宿主 `pluginManager` 负责；enable/disable 只调 `setPluginEnabled(entryId)`，**不会**自动 fallback 到 `setBundleEnabled`；拿不到服务时返回 `NO_PLUGIN_MANAGER`，不回退成自己改 YAML | `lib/settings-routes.js` 的 `handlePlugin()` |
| **成功与否以 `applied` 为准** | 宿主返回 `application`（`applied` / `restart-required` / `overridden` / `cancelled` / `failed`），端点原样透传、不做「乐观成功」；`failed` 时把宿主原文拼进 `message` | `changeResultOf()` |
| **凭据来源可追溯** | settings.json 的 `supabase` 优先，回落 login.json；迁移来的凭据内部标 `source: "login"`，refresh token 仍回写 login.json | `lib/source.js` 的 `loadCredentials()` |
| **只读数据** | 插件不往 Supabase 写；测试连接只做 Auth 与一次 `select` | `lib/source.js` / `lib/supabase.js` |
| **主题只用变量** | 前端只用 `--dsw-alias-*`，不写死颜色，深浅色随 DSH | `assets/settings.css`、`client.js` |
| **坏文件不静默重置** | `settings.json` 解析失败返回 `BAD_SETTINGS_FILE`，不退回默认值 —— 宁可报错也不冲掉用户配置 | `lib/settings.js` 的 `load()` |

> 关于「插件开关」的表述校正：宿主**没有**「启用/禁用插件」的 HTTP 路由，真实能力就是 `pluginManager` 服务方法，
> 而它内部才会去改 profile patch（`dsh-plugin-manager/lib/index.js` 的 `writePluginEnabled`）。
> 所以正确说法是「插件开关只能委托宿主服务」，而不是「只能走某个 `/api/plugin/*` 端点」——
> 后者是插件自己暴露的一层壳，壳里仍然是委托。
>
> **已知边界**：宿主 `setPluginEnabled` 对 profile patch 里 `include` 行加载的插件判定为 `unaddressable`
> （DSH 源码 `packages/boot/plugin-manager/src/index.ts` 483–489 行）—— 这是 **DSH 自身行为，不是本插件 bug**。
> 表现为运行中开关返回 `applied: "failed"`；`restart` 若禁用阶段即失败则返回 `partial: true` + 「已尝试禁用但失败，插件仍在运行」。
> 因此设置页的开关只能写成「委托调用，结果以 `applied` 为准」，不能承诺「一定可用」。

`POST /api/plugin` 的 `applied` **保留宿主原始字符串**（`applied` / `restart-required` / `failed` / `cancelled` / `overridden`），
`restart` 在禁用阶段失败时多一个 `partial: true`；
`GET /api/plugin` 的形状是 `{ ok, entryId: "include:dsh-study-widget", enabled, phase, packageName: "@local/dsh-study-widget", note? }`。

### 4.4 设置页的数据流

```
设置页（assets/settings.*）
   │  打开 → GET  /api/settings         → {settings(掩码), status, desktop, plugin}
   │  测试 → POST /api/settings/test    → {auth:{ok,email,userId}, data:{ok,rev,updatedAt,todoOpen,courses}}
   │  保存 → POST /api/settings         → 同 GET；随后页面刷新状态条并触发一次数据拉取
   │  窗口 → GET  /api/desktop / POST /api/desktop {action: open|close|hide|pin}
   │  插件 → GET  /api/plugin / POST /api/plugin {action: enable|disable|restart}
   ▼
lib/settings.js ← 写 settings.json（原子） → 触发 index.js 清一次 summary 缓存
```

设置页与主面板是**两个页面**，但在 DSH 里**共用一个 iframe**：面板顶栏是「进度 | 设置」等宽分段控件
（`role=tablist`，`aria-selected` 同步），`makePanel` 用 `view` 状态（`data` / `settings`）切换 iframe 的 `src`——
`data` 走 `?mode=panel`，`settings` 走 `settings?v=<nonce>`。切视图时重置 `nonce` 会重新加载 current view，
所以「刷新」在设置页也一样有效；设置视图下顶栏标题变「设置」，「桌面小窗」按钮隐藏。

顶栏图标一律内联 SVG（`ICON_PIN` / `ICON_REFRESH` / `ICON_GEAR` / `ICON_CHART`，`stroke="currentColor"`），
不用 emoji —— emoji 在深浅色主题、不同字体下渲染不一致，且无法跟随主题色。

设置页与主面板共享同一份 `settings.json`：在设置页保存后，主面板下一次刷新就用新凭据；
反之在面板里点 ↻ 也会重新读设置。两侧都不缓存「凭据」本身，只缓存快照。

### 4.5 桌面端口的降级行为

`/api/desktop` 的三条降级路径值得单独记，因为它们决定「点了按钮但没反应」时该怪谁：

| 动作 | 有实时通道（Electron 窗口内） | 没有通道（浏览器 / 面板里） |
| --- | --- | --- |
| `pin` | 直连 `window.studyWidget.setAlwaysOnTop()` | 持久化到 `desktop.alwaysOnTop`，返回 `applied: "persisted"`（下次打开小窗生效）；值本来就相同也给 `persisted`，消息说明「本来就是…」 |
| `hide` | 直连 `window.studyWidget.hide()` | 关闭小窗，返回 `applied: "closed"`；小窗本来就没开则 `applied: "noop"` |
| `bounds` 读取 | 返回当前真实位置 | 无记录时为 `null`（不是 `{}`，前端必须判空） |

设置页跑在 Electron 窗口内时优先直连 IPC；跑在 DSH 主界面 iframe 里时只能走持久化路径。
所以「置顶改完没立刻生效」在面板里是**预期行为**，卡片会提示「下次打开小窗生效」。

响应形状（与实现逐字一致）：

```text
GET  /api/desktop → { ok, running, pinned, pinnedSource, bounds, execPath, error }
                     pinnedSource ∈ "settings" | "live" | "unknown"
POST /api/desktop → { ok, desktop, applied?, message?, reused?, error? }
                     applied ∈ "persisted" | "closed" | "noop"
                     open/close 走真通道时不带 applied，只带 reused
```

`pinnedSource` 是排查「置顶怎么不生效」的关键：`live` = 读的是小窗进程真实值；`settings` = 没有实时通道，
读的是持久化配置（下次开窗才生效）；`unknown` = 拿不到。

## 5. 统计口径（必须与网页版一致）

`lib/stats.js` 是 `app.js` 对应函数的移植，改网页版口径时必须同步改这里，并跑 `scripts/smoke.mjs`：

| 量 | 规则 |
| --- | --- |
| 课时进度 | `watchedMin / totalMin`，`totalMin <= 0` 的课时不计入分母 |
| 总进度 | 全部课时已看分钟 / 全部课时总分钟（不是各课百分比的平均） |
| 连续天数 | 从今天（今天没学则从昨天）往前连续有记录的天数 |
| 待办紧急度 | 已逾期 / 24 小时内 / 7 天内 / 更远，四档，与 `DESIGN.md` 的颜色语义对应 |
| 热力图色阶 | `<=0 → 0`、`<=15 → 1`、`<=45 → 2`、`<=90 → 3`、其余 `4` |
| 打卡周期 | `daily` / `weekly`（自然周）/ `interval`（每隔 N 天） |
| 当前节次 | `currentLesson()`：该课程**第一个 `totalMin > 0` 且 `watchedMin < totalMin`** 的课时；全看完返回 `null`。一节看完后自动落到下一节 |
| 打卡计数 | 当天每有**一条 log** 记 1 次（一天多次就计多次），与小程序 `dayStats` 一致 |

字段契约（`/api/summary` 的 `summary`）：

```text
overall{pct,doneLessons,count,totalText,watchedText,remainingText}
today{min,minText,streak,todosDone,todosOpen,checkins,checkinsTotal,todos[],next,minutes7}
counts{overdue,today,week}
todos{open,done,overdue[],soon[],week[],later[],doneToday[]}   # 每项含 title/pri/dueLabel/left/catLabel/urgency
courses[{name,stats{pct,...},lessons[]}]
checkins[{name,cadenceLabel,done,due,status,todayMin,totalLogs,
          todayLogs[]{at,min,idx,lid,cid,note},            # 今天的每次打卡，一天可多条
          current{id,idx,title,before,total,beforeText,totalText},  # 节次；全部看完为 null
          lessonOptions[]{id,index,title,totalMin,watchedMin,done,totalText,watchedText,courseId}}]
heat{cols,cells[70]{key,min,level}}   week[7]   totals{activityMin,activityText}
```

## 6. 宿主侧接口

| 名称 | 类型 | 参数 / 返回 |
| --- | --- | --- |
| `study_widget_progress` | agent tool | `detail: "summary"｜"full"` → JSON 文本 |
| `/study` | 斜杠命令 | 无参开窗；`status` 打印一行进度 |
| `/dsh-study-widget/settings` | HTTP 页面 | 设置页 |
| `/dsh-study-widget/api/settings` 等 | HTTP 前缀路由 | 见 [插件 README 第 6 节](../../plugins/study-widget/README.md#6-http-接口) |
| `POST /api/checkin/log` | HTTP 写入 | `{id, min, cid, lid, note?}` → `{ok, action:"checkin", checkin:{idx,min,todayMin,lessonBefore,lessonAfter,lessonDone,todays}, summary}` |
| `POST /api/checkin/unlog` | HTTP 写入 | `{id, at}` → `{ok, action:"unlog", removed, checkin:{id,name,logs}, summary}` |

鉴权：`?t=<token>`、DSH Cookie、或本机同源三种之一；其余 401。静态资源限制在 `assets/` 内，越界 403/404。

`SettingsView`（`GET /api/settings` 里的投影，密码永远不在其中）：

```jsonc
{
  "supabase": { "url": "", "anonKey": "", "email": "", "hasPassword": false, "hasRefreshToken": false },
  "desktop":  { "autoOpen": false, "alwaysOnTop": true, "width": 380, "height": 640 },
  "refresh":  { "summaryTtlSeconds": 30, "pageSeconds": 300, "autoRefresh": true },
  "data":     { "offline": false, "stateFile": "" },
  "advanced": { "electronPath": "", "homeDir": "C:\\Users\\...\\.dsh\\study-widget",
                "settingsFile": "...\\study-widget\\settings.json", "loginFile": "...\\study-widget\\login.json" }
}
```

`settingsFile` / `loginFile` 是**只读字段**（绝对路径，不落盘 —— 写入前会被删掉），供排查时确认设置实际写在哪个文件。
`data.stateFile` 与 `data.offline` 都真正生效：前者把该文件直接当数据源（`source: "file"`），
后者只读 `latest.json`、**不发起任何网络请求**（数据标 stale，`status.error` 说明「离线模式」）。

`/api/sources` 的摘要字段：`{rev, updatedAt, origin, courses, lessons, todos, todoOpen, email, checkins, activityDays}`；
`import` 额外返回 `missing / savedTo / backup`（导入前把旧 `latest.json` 备份成 `latest.json.bak`）。

### 6.1 打卡写入（`lib/mutate.js`）

一次 `logCheckin` 在**同一份深拷贝**上做四处改动，全部靠 `rev` 乐观锁提交（冲突最多重试 2 次）：

| 写入 | 规则 | 对应网页端 |
| --- | --- | --- |
| `checkins[].logs` | `push {date, at, min, cid, lid, idx, note?}`，**每条独立、不合并** | `addCheckinLog` |
| `activity[today]` | `+= min` | `addActivity` |
| `details[today]` | 同 cid+lid 合并累加，新建时带 `idx` | `recordDetail` |
| `lessons[].watchedMin` | `min(cap, watchedMin + min)`，`cap = totalMin > 0 ? totalMin : 9999`（与小程序一致） | `onRunCheckin` |

为什么**每次独立一条**而不是当天合并：用户要能回答「今天第几次打卡、每次看了多久」，
这和小程序「按天去重算 1 次打卡、但允许累加多条 log」的口径一致。
`logs` 上限 1000 条（`MAX_LOGS`），超出从头裁剪。

撤销（`removeCheckinLog`）**只删 log**，不回滚 `activity` / `details` / `watchedMin` ——
网页端同样没有反算逻辑，回滚会让两端统计对不上。

## 7. 踩坑记录（改代码前先看）

1. **`desktop/*.cjs` 必须用 `.cjs` 扩展名**：包是 `"type": "module"`，Electron 主进程按 ESM 加载
   `main.js` 会直接报 `ReferenceError: require is not defined in ES module scope`，窗口根本不出现
   （表现为一个空的 "Error" 对话框）。`preload` 同理。
2. **命令注册用 `handler` 不是 `run`**：写成 `run` 会被拒绝，提示 `command "study" handler must be a function`。
3. **工具要经 `ctx.inject(["tools"], …)` 注册**，`ctx.get("tools")` 拿不到；`ctx.get("webServer")` 可以。
4. **不能在任何地方读 `ctx.config`**（除非声明 inject），会抛 `cannot get property "config" without inject`。
   Electron 路径这类配置由 `index.js` 读出后作为参数传给 `lib/desktop.js`。
5. **路由鉴权别照抄「只认 token」**：浏览器直接打开页面时没有 `?t=`，必须放行同源/Cookie，否则永远 401。
6. **spawn 前要 `delete env.ELECTRON_RUN_AS_NODE`**，否则 Electron 退化成一个普通 node 进程。
7. **小窗单实例**：`requestSingleInstanceLock()` 失败时只唤醒已有窗口并立即退出（exit 0）。
8. **侧栏面板用 iframe**：面板内部不要再用 `slots` 注册东西，避免与宿主样式互相污染；主题通过
   `getComputedStyle` 读 `--dsw-alias-*` 后写进 iframe 的 CSS 变量。
9. **`sidebar.panellist` 的 id 必须与 `main` 的 key 逐字相同**：两边是同一套寻址，写错（大小写、连字符、命名空间前缀）
   时不会在加载期报错，而是点入口的瞬间抛「主面板条目不存在」，且侧栏停在原选中态 —— 表现为「点了没反应」。
   本插件两个 id 都取常量 `dsh-study-widget`，不要一处用包名一处用短名。
10. **别抢 `sidebar.settings`**：那是底栏设置齿轮的 single 槽，已被 settings-general 占据；
    往那儿注册会顶掉宿主自己的设置入口，属于破坏宿主导航。
11. **不要用 `configEditor.edit()` 存运行时设置**：它会重启本插件，路由与小窗 token 一起失效（见 4.2）。
    运行时设置走 `settings.json` + `POST /api/settings`。
12. **`settings.json` 必须原子写**：`.tmp` + `rename`。设置页会连续保存多次，直接 `writeFile` 在强杀时可能留下半截 JSON，
    下次启动整个配置读不出来，表现为「设置全丢了」。
13. **密码字段只进不出**：任何返回设置的接口（含错误响应、日志）都不能带密码；日志里打的是 `hasPassword` 而非值。
    保存时 `password` 为空要当成「不修改」，不能当成「清空」，否则用户每次改刷新间隔都会把凭据抹掉。
14. **插件开关不要自己写 YAML**：读改 `cordis.patch.yml` 会因为注释、缩进、`!!js` 标签被 `js-yaml` 重新序列化而丢内容，
    且有并发写风险；一律委托 `pluginManager.setPluginEnabled` / `setBundleEnabled`，拿不到服务就返回
    `NO_PLUGIN_MANAGER` 让用户去插件管理里操作，不要退化成自己改文件。
15. **设置页是独立页面，也要鉴权**：`GET /settings` 与 `/api/*` 走同一套 `authorized()`；
    Electron 打开它时带 `?t=<token>`，浏览器直开靠同源/Cookie，别只给 API 加鉴权而漏了页面本身。
16. **`--relaunch-settings` 复用同一窗口**：设置页由 `DSH_STUDY_WIDGET_SETTINGS_URL` 传 URL，
    不要另起第二个 BrowserWindow（会变成两个窗口抢 `requestSingleInstanceLock`）。
17. **接线顺序坑（本轮真踩过，最容易误判）**：`index.js` 里
    `createSettingsRoutes({ source, desktop, settings, ... })` 的参数对象字面量会在**求值瞬间**读 `desktop` / `settingsStore`。
    如果它们的 `const` 声明写在这次调用**之后**，会抛 `ReferenceError: Cannot access 'desktop' before initialization`；
    这个异常若被外层 `try/catch` 吞掉，`settingsRoutes` 就静默变成 `null`，于是
    `/api/settings` `/api/desktop` `/api/plugin` `/api/sources` **全部 404**，而 `/api/summary` 依然正常 ——
    现象很像「模块缓存没生效」，实际是初始化顺序错了。
    **正确顺序：`settingsStore → webServer → desktop → settingsRoutes`。**
18. **新增的 lib 文件必须重启 DSH 才会被加载**：热重载只对**已加载**的文件生效；
    `lib/settings-routes.js` / `lib/settings.js` / `lib/supabase.js` 这类**新文件**在旧进程里不会被重新 `import`，
    表现为「代码明明写了但路由还是 404」。改完新文件先重启 DSH，再判断是不是别的问题。
19. **`autoOpen` 曾经读错来源（真踩过）**：旧写法只认插件配置 `cfg.autoOpen`，但 profile 的
    `insert` 行从不给 `config`，于是这个值永远是 `undefined` —— **设置页的「随 DSH 启动自动打开小窗」
    写了也不生效**，表现为「开关是开的，但启动 DSH 后小窗不出现」。现在先读 `settings.json` 的
    `desktop.autoOpen`，只有它缺失时才回落插件配置；并且用 `ctx.inject(["webServer"])` 等
    `getOrigin()` 可用后才开窗，不再用裸 `setTimeout` 赌时序。
20. **CRLF 文件改写脚本的锚点坑**：本仓库多数文件是 CRLF。用 `fs.readFileSync` + `s.replace(锚点, …)`
    改文件时，锚点字符串若按 `\n` 写会**静默匹配失败**（`includes` 返回 false）。改写脚本里先把锚点
    `replace(/\r?\n/g, "\r\n")` 统一，或直接用编辑工具，不要用内联命令拼多行锚点。
21. **打卡弹层是纯前端组件**：`widget.js` 的 `openCheckinSheet` 只认 `summary.checkins[i]` 里已有的
    `current` / `lessonOptions` / `todayLogs`。往弹层加字段时，先改 `lib/summary.js` 的投影，
    再改前端 —— 前端不要自己去 `courses` 里找节次，否则「课程被删」「没绑课程」这两条分支会各写一遍。

## 8. 自测与验证

```bash
node plugins/study-widget/scripts/smoke.mjs           # 15 项，零依赖，不启动 DSH
node plugins/study-widget/scripts/smoke-settings.mjs  # 77 项，零依赖，不启动 DSH
```

覆盖：页面/样式/脚本/图标的 MIME 与状态码、`/api/summary` 的缓存回落与关键数值（75% 1/2、逾期 1、今日 45 分钟、
热力图 70 格）、`/api/status`、未知接口 404、路径越权不泄露源码；设置侧覆盖读取与掩码、保存回读、测试连接失败语义、
`NO_PLUGIN_MANAGER` 降级。数据目录指向系统临时目录。

打卡链路（`/api/checkin/log`、`/api/checkin/unlog`）目前靠人工 + 一次性验证脚本覆盖，**没有进 `smoke.mjs`**，
因为 `index.js` 内部 `new StudySource()` 会打真实云端。要回归它，按下面三条手工确认即可：

1. `summary.checkins[].current.idx` = 第一个没看完的节次；
2. 同一天连打两次，`logs` 长度 +2，`activity[today]` 增加两次之和，`details[today]` 仍只有 1 条（合并）；
3. 把某节补到 `totalMin` 后重开弹层，`current.idx` 自动 +1。

小窗的实机验证只能人工看：`/api/status` 的 `desktop.running`、窗口是否出现在右上角、右键菜单五项、
置顶后是否压在最前。截图归档在 [docs/shots](../../plugins/study-widget/docs/shots/)；
完整的人工步骤见 [docs/ACCEPTANCE.md](../../plugins/study-widget/docs/ACCEPTANCE.md)。

## 9. 边界与后续

- **可写，但只写两件事**：待办勾选、打卡（含一天多次）。所有写入走 `lib/mutate.js` 的 `rev` 乐观锁，
  冲突时基于服务端最新数据重试（最多 2 次），失败把 `error.code` 原样交给界面（不吞）。
  其余数据（课程、课时总时长、循环打卡的增删改）仍只在网页版/小程序里改。
- **撤销不回滚时长**：`/api/checkin/unlog` 只删 log 行，`activity` / `details` / `watchedMin` 保持不变，
  与网页端口径一致。要「真正撤销」得在网页版改课时进度。
- **小窗不是独立数据源**：弹层提交后由宿主回传整份 `summary` 重绘，小窗不自己维护一份课程/节次缓存。
- **单用户**：与网页版一样用 Auth 登录自己的账号，不支持多账号切换。
- 桌面小窗依赖 DSH 自带的 Electron（`$DSH_HOME/electron/electron.exe`），DSH 升级后路径变化会回落报错，需在
  设置页「高级」或 `/api/status` 里看 `execPath`。
- 两套配置并存（运行时 `settings.json` 与插件静态配置）是刻意的取舍：前者要「立即生效」，后者要「随 patch 版本化」。
  新增配置项时先问一句「改它要不要重启插件」，答案决定了它该去哪一层。
