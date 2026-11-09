# 07 · 运行与部署

## 1. 前置条件

| 场景 | 需要 |
| --- | --- |
| 仅本地使用 | 任意现代浏览器（Chrome / Edge / Firefox / Safari 近两年版本） |
| 本地调试云同步 | 一个静态文件服务器（避免 `file://` 的存储与 CORS 差异） |
| 云端备份 | Supabase 免费项目 |
| 公网访问 | 任意静态托管（GitHub Pages / Netlify / Vercel / 对象存储） |
| 可选旧方案 | Cloudflare 账号 + wrangler（**不再需要**） |

**不需要**：Node.js、npm、构建工具、后端服务。仓库里没有 `package.json`，也没有 `node_modules`。

## 2. 本地运行

### 2.1 直接打开（最快）

双击 `index.html`，或用浏览器打开：

```
file:///D:/Users/22608/Desktop/CODE/study-dashboard/index.html
```

能力对照：

| 能力 | `file://` | 本地 HTTP |
| --- | --- | --- |
| 记录课程 / 打卡 / 待办 | ✅ | ✅ |
| 热力图、日历、当日详情 | ✅ | ✅ |
| 导出 / 导入 JSON | ✅ | ✅ |
| 复制提示词 | ✅（自动降级 `execCommand`） | ✅（优先 Clipboard API） |
| 示例数据 | ✅ | ✅ |
| Supabase 云同步 | ⚠️ 可能受浏览器安全策略影响 | ✅ 推荐 |

`file://` 下 `localStorage` 按文件路径隔离，移动文件位置会「丢数据」（其实是换了存储域）。长期使用建议固定目录或改用 HTTP 服务。

### 2.2 本地静态服务器（推荐）

Python（已安装 Python 3 时）：

```bash
python -m http.server 8765
```

然后访问 `http://127.0.0.1:8765/`。

Node 方式（无需安装到项目里）：

```bash
npx serve .
```

VS Code 也可以直接用 Live Server 插件。

### 2.3 首次打开应该看到什么

1. 页头「学业工作台」+ 当天日期 + 连续打卡印章；
2. 三个页签「学习 / 待办 / 日历」；
3. 空的今日卡、0% 圆环、空热力图、空课程列表；
4. 空状态里的「填入示例课程」按钮。

点「填入示例课程」可以立刻看到完整效果：两门示例课、6 天示例打卡、补课明细。示例数据可一键清除，不污染真实记录。

## 3. 部署到 GitHub Pages

仓库的默认线上地址是 `https://za123-lab.github.io/study-dashboard/`（`worker/src/index.js` 与 `worker/wrangler.toml` 里的 `ALLOWED_ORIGIN` 也以此为准）。

步骤：

1. 把 `index.html`、`style.css`、`app.js` 推到 GitHub 仓库（`supabase/`、`docs/`、`worker/` 不需要发布也能工作）；
2. 仓库 **Settings → Pages** → Source 选分支（如 `main`）与根目录；
3. 等待 Actions 完成，访问页面；
4. 每次发版修改 `index.html` 里两处缓存版本号：

```html
<link rel="stylesheet" href="style.css?v=20261109-1">
<script src="app.js?v=20261109-1"></script>
```

两处必须一致，否则用户可能拿到「新 HTML + 旧 JS」或「旧 CSS + 新 JS」。

其他静态托管同理：只需能通过 HTTP 提供这三个文件，且默认首页为 `index.html`。云同步要求站点为 `https`（`localhost` 例外）。

## 4. 接入 Supabase（可选）

详细图文步骤见 `supabase/README.md`，这里给最短路径：

1. <https://supabase.com> 新建项目，等状态变 Active；
2. **SQL Editor → New query** 执行建表脚本（可重复执行）。脚本可以直接用页面「设置 · 云同步」教程里「复制 SQL」按钮一键复制，内容与 `supabase/schema.sql` 相同；
3. **Authentication → Users → Add user** 创建邮箱账号，勾选 **Auto Confirm User**；
4. 地址在 **Project Settings → Data API** 的 **Project URL**，只复制到 `.supabase.co`；
5. 密钥在 **Project Settings → API Keys**：复制 **Publishable key**（`sb_publishable_…` 开头）；
6. 页面「设置 · 云同步」填入两项 → 保存配置 → 用邮箱密码登录；
7. 首次登录自动核对：云端空则上传本地；本地空则拉取云端；两边都有数据则弹冲突框；
8. 第二台设备重复 5～7，登录同一账号即可。

验收：

- 状态行出现「已登录：邮箱」；
- 「实时：已连接，云端改动会自动拉取」或「实时未连接；已使用每 60 秒自动检查云端」；
- 在 A 设备改一笔，1.5 秒后 B 设备（已登录）自动出现同样改动。

### 4.1 建表脚本做了什么

| 对象 | 作用 |
| --- | --- |
| `public.study_state` | 每用户一行：`data`（整份 JSON）、`rev`、`updated_at` |
| 4 条 RLS 策略 | 登录用户只能读写 `auth.uid() = user_id` 的行 |
| `study_state_touch` 触发器 | 每次更新把 `updated_at` 刷成 `now()` |
| 权限 | `authenticated` 读写；`anon` 全部收回 |
| Realtime 发布 | 把表加入 `supabase_realtime`，页面才能收到变更通知 |

### 4.2 免费额度注意

Supabase 免费项目连续约 7 天无 API 活动会被暂停。暂停后数据不丢，网页会提示连不上，本机记录照常可用；去 Dashboard 点 **Restore / Unpause**，等 1–3 分钟即可恢复。隔几天打开页面记一笔即可保持活跃。

## 5. 部署旧 Worker（不需要）

仅当你确实想要 `/bili` 代理时才考虑：

```bash
npm install -g wrangler
wrangler login
cd worker
wrangler d1 create study-dashboard
# 把输出的 database_id 填进 wrangler.toml
wrangler d1 execute study-dashboard --file=./schema.sql --remote
wrangler deploy
```

注意：`wrangler.toml` 里的 `database_id` 指向原作者云账号下的 D1 库；在自己的账号部署时必须替换成 `wrangler d1 create` 输出的新 ID，否则会连不上。页面已不再请求 Worker，部署它不会给当前功能带来任何变化。

## 6. 运行方式速查

| 操作 | 命令 / 入口 |
| --- | --- |
| 本地打开 | 双击 `index.html` |
| 本地服务 | `python -m http.server 8765` |
| 查看示例 | 空状态「填入示例课程」 |
| 备份 | 页脚「导出数据」→ `<站点名>-YYYY-MM-DD.json` |
| 恢复 | 页脚「导入数据」→ 选择 JSON → 确认覆盖 |
| 清示例 | 示例提示条「清除示例数据」 |
| 重置打卡 | 页脚 / 热力图提示「重置打卡记录」 |
| 清空全部 | 页脚「清空数据」（不可撤销） |
| 云同步配置 | 页面最下方「设置 · 云同步」 |
| B 站导入 | 页面底部「B 站课程导入」折叠面板 |
| 待办批量导入 | 待办视图底部「待办批量导入」折叠面板 |

## 7. 验收清单

### 7.1 本地

- [ ] 页面无报错，`document.documentElement.data-app-ready === "1"`；
- [ ] 登记一门 10 节的课程，出现在列表，进度 0%；
- [ ] 给某节填「已看 30 / 总 45」，今日分钟 +30，圆环上升，热力图今天有格子；
- [ ] 点热力图今天，弹层显示课程名、课时名、30 分钟；
- [ ] 新增一条今天的待办，待办视图与日历都能看到；
- [ ] 刷新页面，以上数据仍在；
- [ ] 导出 JSON，清空数据，再导入，数据恢复；
- [ ] 窄屏（≤560px）按钮可点、输入不缩放、日历切换为列表。

### 7.2 云同步（如已配置）

- [ ] 保存配置后状态行显示「连接配置已保存」；
- [ ] 登录后显示邮箱，首次核对完成；
- [ ] 改一笔，1.5 秒后状态行显示「已上传 · 时间」；
- [ ] 第二台设备登录后能拉到同一份数据；
- [ ] 两边同时改，出现冲突弹窗，三个按钮都可用；
- [ ] 断网后继续记录，恢复网络自动补传；
- [ ] 退出登录后本机数据仍在。

## 8. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 页面空白，2.5 秒后提示「脚本未加载」 | `app.js` 路径错 / 缓存旧版 / 被拦截 | 强刷（Ctrl+F5）；检查 `app.js` 是否存在；确认没有把 HTML 改名 |
| 点按钮没反应，控制台报 `$ is not defined` | 脚本加载失败或顺序错 | 确认 `<script src="app.js">` 在兜底脚本之前 |
| 数据刷新后消失 | 浏览器禁用本地存储 / 无痕模式 / `file://` 换路径 | 换普通窗口或固定 HTTP 地址；用导出备份迁移 |
| 本地保存失败提示 | `localStorage` 配额满 | 导出后清空旧记录；清理同域其他数据 |
| 云端报 `42P01` | 没执行 `schema.sql` | 执行脚本；必要时 `notify pgrst, 'reload schema';` |
| 云端报 `42501` / 403 | RLS 或 grant 没执行完整 | 重跑 `supabase/schema.sql` |
| 登录报「邮箱或密码不对」 | 账号不是在本项目创建 / 密码错 | Authentication → Users 检查 |
| 登录报「邮箱还没验证」 | 未 Auto Confirm | 控制台确认用户，或关闭 Confirm email |
| 登录 404 | Project URL 填错 | 填 `https://xxxx.supabase.co`，不要带 `/rest/v1` |
| 状态行「实时不可用」 | Realtime 未发布该表 | 重跑最新 `schema.sql`；不影响使用，自动降级 60 秒轮询 |
| 状态行「实时连接断开」 | 网络抖动 / 项目被暂停 | 恢复后自动重连；期间仍轮询 |
| 拉取后没变化 | 存在未处理冲突 | 打开冲突弹窗选择保留哪份 |
| 换设备登录看到空白 | 首次核对未完成 / 本机空 | 点「立即拉取」；确认登录邮箱是同一账号 |
| 上传提示「数据接近 1 MB」 | 快照 > 900000 字符 | 导出备份，清理旧明细 / 旧课程后再传 |
| 上传提示「数据来自更新版本」 | 页面是旧缓存，读到新结构 | 强制刷新页面 |
| 同步一直转圈 | `supaBusy` 卡住（网络挂起） | 15 秒超时后自动释放；刷新页面 |
| 提示词复制失败 | `file://` 下 Clipboard API 不可用 | 已自动降级 `execCommand`；仍失败就手动全选复制 |
| B 站 JSON 解析报行列号 | AI 输出被截断 / 多了注释 | 按错误提示的「第 N 行第 M 列」修正，或重新生成 |
| 待办导入全部被跳过 | 标题 + 截止日期与现有重复 | 改标题或日期；重复项不会覆盖现有内容 |
| 手机输入框聚焦时页面放大 | iOS 对 <16px 输入框的行为 | 已用 16px 规避；若仍发生，检查是否被自定义样式覆盖 |

## 9. 数据备份、恢复与迁移

### 9.1 备份

页脚「导出数据」生成：

```json
{ "v": 2, "schemaVersion": 3, "exportedAt": "...", "courses": [], "activity": {},
  "demoActivity": {}, "details": {}, "demoDetails": {}, "todos": [],
  "courseOpen": {}, "panelOpen": {} }
```

文件名由 `APP_NAME` + 当天日期组成。备份**不含** Supabase 配置与 token。

### 9.2 恢复

页脚「导入数据」→ 选择 JSON → 确认「会覆盖当前所有记录」→ 立即 `sanitize` 后替换并重绘。旧版只含 `courses` 的文件也能导入，其余字段按空值兜底。

### 9.3 换设备

三种方式，任选其一：

1. 导出 → 新设备导入（最可靠，不依赖网络）；
2. Supabase 登录同一账号，首次核对自动拉取（需要两边都能联网）；
3. 手动把 `localStorage["study-log-v1"]` 的内容拷到新设备（不推荐，容易出错）。

### 9.4 升级数据结构（维护者）

1. 提升 `SCHEMA_VERSION`；
2. `sanitize` 增加旧结构 → 新结构的迁移分支；
3. `snapshot` 带出新字段；
4. 导出逻辑与 `supabase/schema.sql` 的体积约束同步检查；
5. 旧页面读到新版本会自动停止上传（不会写丢字段），但用户需要刷新才能继续同步；
6. 发版前先导出备份，并用「示例数据 + 导入旧文件」各跑一遍。

## 10. 运行时行为参数

| 参数 | 值 | 影响 |
| --- | --- | --- |
| 自动上传防抖 | 1500ms | 连续输入只上传最后一次 |
| Supabase 请求超时 | 15000ms | 超时提示「记录仍在本机」 |
| 兜底轮询 | 60000ms | 页面可见时才跑 |
| 前台拉取节流 | 5000ms | 频繁切窗口不会连发请求 |
| Realtime 心跳 | 30000ms | 保活；并发连接每标签页最多 1 条 |
| 重连退避 | 1000ms → 20000ms → … 上限 60000ms | 断开后逐步退避 |
| 热力图 resize 防抖 | 200ms | 窗口尺寸变化后重建 |
| 轻提示时长 | 2400ms | `toast` 自动消失 |
| 上传体积阈值 | 900000 字符 | 超过则拒绝上传并提示 |
| 数据库 data 上限 | 1000000 字节 | 表级 CHECK 约束 |
| 待办导入上限 | 500 条 | 超出报错 |
| B 站课时上限 | 999 节 | 超出报错 |
