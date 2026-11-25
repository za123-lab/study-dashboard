# 10 · 桌面小组件插件（@local/dsh-study-widget）

> 代码级说明：一个 DSH 插件如何既在 Web UI 里注册侧栏面板，又在桌面上拉起一个独立的 Electron 小窗，
> 并把学习进度以「助手工具 + 斜杠命令 + HTTP 接口」三种方式暴露出去。
> 使用者视角的安装与操作见 [插件 README](../../plugins/study-widget/README.md)；插件总清单见 [plugins/README.md](../../plugins/README.md)。

## 1. 为什么是插件，而不是另一个网页

网页版和 APP 都是「打开一个页面」的形态，而用户想要的是「不用打开任何东西就能看到今天学到哪」。
DSH 已经常驻桌面，于是把视图做进 DSH：

| 需求 | 落点 |
| --- | --- |
| 一眼看到进度，不打断工作 | 无边框、置顶、380×640 的桌面小窗 |
| 与 DSH 主界面同色同字 | 侧栏面板复用同一套页面，用 `--dsw-alias-*` token 换肤 |
| 让助手能回答「我今天学到哪」 | 宿主侧注册 `study_widget_progress` 工具 |
| 不重复写渲染逻辑 | **一份页面**（`assets/widget.*`）+ 两个壳（Electron BrowserWindow、侧栏 iframe） |

关键决策：**渲染只在宿主侧做一次**。Electron 小窗和侧栏 iframe 都指向 `/dsh-study-widget/?mode=…`，
数据、样式、文案全部同源，改一处两边同时生效。

## 2. 进程与数据流

```
              ┌──────────────── 宿主进程（node，index.js）────────────────┐
Supabase ◀───▶│ lib/source.js  登录/refresh/拉 public.study_state          │
  (Auth +     │ lib/summary.js 归一化 + 复刻 app.js 统计口径               │
   PostgREST) │ lib/stats.js   纯函数：进度、连续天数、紧急度、热力图        │
              │ webServer 前缀路由 /dsh-study-widget（页面 + /api/*）      │
              │ lib/desktop.js  spawn Electron，记住位置，单实例          │
              └───────┬───────────────────────────────┬─────────────────┘
                      │ HTTP（页面与 /api/summary）      │ spawn
              ┌───────▼────────┐              ┌────────▼─────────┐
              │ 侧栏 iframe     │              │ Electron 小窗     │
              │ client.js       │              │ main.cjs/preload │
              └────────────────┘              └──────────────────┘
```

- 小窗从不直接访问 Supabase：登录态、缓存、限流都在宿主进程里做，token 不落到渲染层。
- 宿主侧缓存 30 秒（`SUMMARY_TTL_MS`），页面 5 分钟自动刷新，点 ↻ 走 `?refresh=1`。
- 无凭据 / 网络失败 → 回落 `~/.dsh/study-widget/latest.json`，页脚标「显示缓存」，错误原因记在 `/api/status`。

## 3. 目录与职责

| 文件 | 职责 | 不该做什么 |
| --- | --- | --- |
| `index.js` | 注册路由、`/api`、agent 工具、`/study` 命令、按配置自动开窗 | 不写统计逻辑 |
| `client.js` | 向 `sidebarRightTabs` 注册标签、向 `sidebar.right.pane.tab` 注册面板 | 不直接算数据 |
| `lib/source.js` | 凭据读取、Supabase 认证与查询、快照落盘 | 不做展示格式化 |
| `lib/summary.js` | 把 `state` 归一化成小组件快照（字段见下） | 不做网络请求 |
| `lib/stats.js` | 与 `app.js` **逐字对齐**的统计口径 | 不依赖宿主 |
| `lib/desktop.js` | 找 Electron、spawn、复用、退出、位置记忆 | 不碰业务数据 |
| `desktop/main.cjs` | BrowserWindow、置顶、右键菜单、IPC | 不写 HTML |
| `desktop/preload.cjs` | `contextBridge` 暴露最小 IPC 面 | 不暴露 node |
| `assets/widget.*` | 页面、样式、前端渲染（widget / panel 两种模式） | 不直连数据库 |

## 4. 统计口径（必须与网页版一致）

`lib/stats.js` 是 `app.js` 对应函数的移植，改网页版口径时必须同步改这里，并跑 `scripts/smoke.mjs`：

| 量 | 规则 |
| --- | --- |
| 课时进度 | `watchedMin / totalMin`，`totalMin <= 0` 的课时不计入分母 |
| 总进度 | 全部课时已看分钟 / 全部课时总分钟（不是各课百分比的平均） |
| 连续天数 | 从今天（今天没学则从昨天）往前连续有记录的天数 |
| 待办紧急度 | 已逾期 / 24 小时内 / 7 天内 / 更远，四档，与 `DESIGN.md` 的颜色语义对应 |
| 热力图色阶 | `<=0 → 0`、`<=15 → 1`、`<=45 → 2`、`<=90 → 3`、其余 `4` |
| 打卡周期 | `daily` / `weekly`（自然周）/ `interval`（每隔 N 天） |

字段契约（`/api/summary` 的 `summary`）：

```text
overall{pct,doneLessons,count,totalText,watchedText,remainingText}
today{min,minText,streak,todosDone,todosOpen,checkins,checkinsTotal,todos[],next,minutes7}
counts{overdue,today,week}
todos{open,done,overdue[],soon[],week[],later[],doneToday[]}   # 每项含 title/pri/dueLabel/left/catLabel/urgency
courses[{name,stats{pct,...},lessons[]}]
checkins[{name,cadenceLabel,done,due,status}]
heat{cols,cells[70]{key,min,level}}   week[7]   totals{activityMin,activityText}
```

## 5. 宿主侧接口

| 名称 | 类型 | 参数 / 返回 |
| --- | --- | --- |
| `study_widget_progress` | agent tool | `detail: "summary"｜"full"` → JSON 文本 |
| `/study` | 斜杠命令 | 无参开窗；`status` 打印一行进度 |
| `/dsh-study-widget/*` | HTTP 前缀路由 | 见 [插件 README 第 5 节](../../plugins/study-widget/README.md#5-http-接口) |

鉴权：`?t=<token>`、DSH Cookie、或本机同源三种之一；其余 401。静态资源限制在 `assets/` 内，越界 403/404。

## 6. 踩坑记录（改代码前先看）

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

## 7. 自测与验证

```bash
node plugins/study-widget/scripts/smoke.mjs        # 15 项，零依赖，不启动 DSH
```

覆盖：页面/样式/脚本/图标的 MIME 与状态码、`/api/summary` 的缓存回落与关键数值（75% 1/2、逾期 1、今日 45 分钟、
热力图 70 格）、`/api/status`、未知接口 404、路径越权不泄露源码。数据目录指向系统临时目录。

小窗的实机验证只能人工看：`/api/status` 的 `desktop.running`、窗口是否出现在右上角、右键菜单五项、
置顶后是否压在最前。截图归档在 [docs/shots](../../plugins/study-widget/docs/shots/)。

## 8. 边界与后续

- **只读**：插件不写 Supabase，打卡、改待办仍需网页版或小程序（写入走 `rev` 乐观锁，放在插件里会把冲突弹窗搬进小窗）。
- **单用户**：与网页版一样用 Auth 登录自己的账号，不支持多账号切换。
- 桌面小窗依赖 DSH 自带的 Electron（`$DSH_HOME/electron/electron.exe`），DSH 升级后路径变化会回落报错，需在
  `/api/status` 里看 `execPath`。
