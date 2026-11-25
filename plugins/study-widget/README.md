# 学业工作台 · 桌面小组件插件（DSH）

[study-dashboard](../index.html) 的第三个端：把「今天学了多久、课程进度到哪、接下来该做什么」做成一个
**常驻桌面小窗**，同时也能在 DSH 里以侧栏面板、助手工具、斜杠命令三种方式打开。

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| 桌面小窗 | 屏幕右上角（记住上次位置） | 无边框、可拖动、置顶、不占任务栏 |
| 侧栏面板 | DSH 右侧栏「学业工作台」 | 与桌面小窗共用同一套页面 |
| Agent 工具 | 任意对话 | `study_widget_progress`，`detail: summary \| full` |
| 斜杠命令 | 输入框 | `/study` 开窗，`/study status` 打印一句进度 |

![桌面小窗](docs/shots/widget-desktop.png)

展示内容与网页版同源同口径：今日学习时长 / 连续天数 / 今日待办完成数 / 今日打卡数、总进度（已看、剩余、完成节数）、
逐课程进度条、逾期·今日·本周待办（优先级 + 剩余时间）、循环打卡周期状态、近 10 周热力图 + 近 7 天柱状图。

---

## 1. 安装

插件以本地 link 依赖方式挂在 `desktop` profile 上（仓库内路径，改动即时生效）：

```bash
# 在 DSH 里执行（等价于 plugin_manager install_bundle）
dsh plugin --profile desktop add D:/Users/22608/Desktop/CODE/study-dashboard/plugins/study-widget
```

安装后 profile 的 `package.json` 会多出：

```json
"dependencies": { "@local/dsh-study-widget": "link:D:/Users/22608/Desktop/CODE/study-dashboard/plugins/study-widget" },
"dsh": { "profile": { "bundles": [ "...", "@local/dsh-study-widget" ] } }
```

插件自带的 `cordis.patch.yml` 负责把它插入 loader，无需改 profile 的 patch 层。

## 2. 首次配置（唯一必做）

小组件只读**你自己**的 Supabase 数据，凭据放在用户目录，不进仓库：

```
C:\Users\22608\.dsh\study-widget\login.json
```

```json
{
  "url": "https://xxxx.supabase.co",
  "anonKey": "eyJhbGciOi...（Supabase 控制台 Settings → API 的 anon public key）",
  "email": "你的账号邮箱",
  "password": "你的密码"
}
```

- 密码登录成功后，refresh token 会自动回写同一文件，之后不再需要密码。
- 不想存密码：只填 `email`，在网页版登录一次，把 localStorage 里 `study-supabase-session-v1`
  的 `refresh_token` 贴到 login.json 的 `refreshToken` 字段。
- 同目录其它文件：`latest.json`（最近一次成功快照，断网/未配置时用它，页脚标「显示缓存」）、
  `window.json`（小窗位置）、`state.json`（上一次监听，可选）。
- 换数据目录：环境变量 `DSH_STUDY_WIDGET_HOME`。

当前该目录放的是一份**演示数据**（`demo@study.local`），填好真实凭据后点 ↻ 即切换。

## 3. 日常操作

| 操作 | 效果 |
| --- | --- |
| 按住顶栏拖动 | 移动窗口，松手记住位置 |
| ↻ | 立即刷新 |
| 📌 | 切换置顶 |
| — / × | 隐藏 / 退出 |
| 右键 | 置顶、刷新数据、打开网页版工作台、隐藏、退出 |

小窗关掉后：`/study` 或侧栏面板顶栏的「📌 桌面小窗」可重新打开。

## 4. 配置项

在插件管理里编辑，或写进 profile patch：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `electronPath` | 空 | 自定义 Electron；留空则 `$DSH_HOME/electron/electron.exe`，再不行用 `DSH_STUDY_WIDGET_ELECTRON` |
| `autoOpen` | `false` | 插件加载后自动开窗 |
| `stateFile` | 空 | 覆盖 `latest.json` 路径 |
| `offline` | `false` | 强制离线，只读缓存 |

数据新鲜度：页面每 5 分钟拉一次；host 侧 30 秒缓存，避免把 Supabase 打满。

## 5. HTTP 接口

前缀 `/dsh-study-widget`：

| 路径 | 说明 |
| --- | --- |
| `GET /` | 小组件页面（`?t=<token>`、DSH Cookie 或本机同源可访问） |
| `GET /api/summary` | 统计数据 JSON，包一层 `{ok, summary, status}`；`?refresh=1` 强制拉取 |
| `GET /api/status` | 凭据路径、上次同步、小窗进程状态 |
| `POST /api/open-desktop` / `POST /api/close-desktop` | 开关小窗 |
| `GET/POST /api/bounds` | 读取 / 保存小窗位置 |

鉴权失败一律 401；静态资源限制在 `assets/` 目录内，越界返回 403/404。

## 6. 自测

```bash
node plugins/study-widget/scripts/smoke.mjs        # 15 项断言，不用启动 DSH
```

用假 ctx 跑 `apply()`，真实监听端口，覆盖页面/样式/脚本/图标、`/api/summary`（缓存回落、总进度 75% 1/2、
逾期计数、热力图 70 格）、`/api/status`、404 与路径越权。数据目录用临时目录，不碰真实凭据。

## 7. 文件结构

```
plugins/study-widget/
├── index.js            host 半边：路由、/api、小窗启动、agent tool、/study 命令
├── client.js           侧栏标签 + 面板（iframe 承载同一套页面，主题 token 透传）
├── cordis.patch.yml    自动挂载
├── lib/
│   ├── stats.js        统计口径（复刻网页版 app.js）
│   ├── summary.js      把 Supabase 原始 state 归一化成快照
│   ├── source.js       登录 / refresh / 拉取 / 缓存回落
│   └── desktop.js      Electron 进程的启动、复用、退出与位置记忆
├── desktop/
│   ├── main.cjs        Electron 主进程（窗口、置顶、右键菜单、单实例）
│   └── preload.cjs     contextBridge 暴露的最小 IPC 面
├── assets/             页面、样式、图标
├── locale/             中英文案
├── scripts/smoke.mjs   冒烟自测
└── docs/shots/         界面截图（文档用）
```

> `desktop/*.cjs` 必须是 `.cjs`：包是 `"type": "module"`，Electron 主进程要用 CommonJS 的 `require`。

## 8. 常见问题

**小窗没出现？** 看 `/api/status` 的 `desktop`：`running=false` 且有 `error` → 按提示检查 Electron 路径；
`execPath` 为空说明没找到 Electron。

**显示「还没有配置」？** login.json 四项目前为空，按第 2 节填。

**数据比网页版旧？** 页脚「rev N · X 前同步」。点 ↻ 强制刷新；Supabase 不可达时继续用 `latest.json` 并标「显示缓存」。

**改了代码？** 在插件管理里关掉再打开（或重启 DSH）；只改 `assets/widget.*` 刷新小窗即可。

**想让它跟着开机启动？** 配置项 `autoOpen: true`，再把 DSH 本身加入开机启动项。
