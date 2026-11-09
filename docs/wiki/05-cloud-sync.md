# 05 · 云同步（Supabase）

## 1. 目标与原则

云同步是**可选增强**，不是运行前提。它需要同时满足：

1. **本地永不阻塞**：离线、超时、401、表不存在，都只影响云同步状态行，本机记录照常读写。
2. **绝不静默覆盖**：只要「云端有更新」且「本地也有未上传改动」，就停下弹冲突框，由人选择。
3. **版本可比较**：用数据库里的 `rev`（单调递增整数）而不是时间戳，避免多设备时钟偏差。
4. **整份文档为单位**：每次上传写整份 `data`，不做字段级合并。
5. **零 SDK**：只用 `fetch` 与原生 `WebSocket`，不引入 `@supabase/supabase-js`。

## 2. 参与组件

| 层 | 组件 | 职责 |
| --- | --- | --- |
| 配置 | `study-supabase-v1` | 项目 URL、Publishable key、是否自动同步 |
| 认证 | Supabase Auth `/auth/v1/*` | 邮箱密码登录、refresh token 续期、退出 |
| 数据 | PostgREST `/rest/v1/study_state` | 单行读写，`rev` 条件更新 |
| 实时 | Supabase Realtime `/realtime/v1/websocket` | 云端变更通知，只作「去拉取」的信号 |
| 数据库 | `public.study_state` + RLS + 触发器 | 每用户一行；`updated_at` 由数据库维护 |

## 3. 数据库结构

`supabase/schema.sql` 可整段重复执行。页面「设置 · 云同步」的教程里内嵌了同一份 SQL，点「复制 SQL」即可粘贴到 Supabase **SQL Editor → New query** 执行，不需要再去仓库翻文件。

控制台取配置的位置（2026 新版界面）：

- 地址：**Project Settings → Data API** 的 **Project URL**，只复制到 `.supabase.co`；
- 密钥：**Project Settings → API Keys** 的 **Publishable key**（`sb_publishable_…` 开头）。

```sql
create table if not exists public.study_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  rev        bigint not null default 1 check (rev > 0),
  updated_at timestamptz not null default now(),
  constraint study_state_data_is_object check (jsonb_typeof(data) = 'object'),
  constraint study_state_data_size check (octet_length(data::text) <= 1000000)
);
```

| 字段 | 说明 |
| --- | --- |
| `user_id` | 主键，外键指向 `auth.users`，删用户级联删数据 |
| `data` | 整份进度快照（`snapshot()` 的结果） |
| `rev` | 乐观锁版本，第一次插入为 1，之后每次成功更新 +1 |
| `updated_at` | 触发器 `study_state_touch()` 在每次 UPDATE 时写成 `now()`；客户端不写 |

安全配置：

- `enable row level security`；
- 四条策略（select / insert / update / delete）都要求 `auth.uid() = user_id`，且 `to authenticated`；
- `revoke all from anon`，未登录用户完全拿不到这张表；
- 把表加入 `supabase_realtime` 发布列表（幂等 `do $$ ... $$`），Realtime 才会推送变更。

## 4. 认证

### 4.1 登录

```
POST {projectUrl}/auth/v1/token?grant_type=password
apikey: {anonKey}
Content-Type: application/json
{ "email": "...", "password": "..." }
```

成功响应 → `sessionFromAuth()` 归一化为：

```js
{
  accessToken, refreshToken,
  expiresAt: Date.now() + expires_in * 1000,
  userId, email
}
```

写入 `study-supabase-session-v1`。`supaReady` 在首次云端核对完成前保持 false，此期间自动拉取与自动上传都不动作。

### 4.2 续期

`ensureSession()` 在 `expiresAt - 120000`（提前 2 分钟）内触发 `refreshSession()`：

```
POST /auth/v1/token?grant_type=refresh_token
{ "refresh_token": "..." }
```

- 并发调用合并到同一个 `supaRefreshPromise`，避免同时刷新导致 token 失效；
- 续期成功后，如果 Realtime 已连接，会发送 `access_token` 事件把新 token 同步给订阅通道，避免被踢；
- `restRequest()` 遇到 401 会自动续期一次并重放原请求（只重试一次）。

### 4.3 退出

- 清 `STORE_KEY` 之外的登录态键；
- 停自动拉取、清防抖定时器、清冲突；
- 尽力调用 `POST /auth/v1/logout`（失败忽略）；
- **不删除任何本地进度**，状态行明确写「已退出登录，本机记录仍在」。

### 4.4 配置校验（`saveSupaConfig`）

| 检查 | 规则 |
| --- | --- |
| URL 为空 | 拒绝 |
| 协议 | 必须是 `http:` / `https:`；`http` 只在 `localhost` / `127.0.0.1` 下允许，其余一律要求 `https` |
| 自动补全 | 无协议补 `https://`，去掉结尾 `/` |
| key 为空 | 拒绝 |
| key 含空白 | 拒绝（避免复制断行） |
| key 以 `sb_secret_` 开头 | 拒绝（服务端密钥不能进浏览器） |
| key 长度 < 20 | 拒绝（多半没复制完整） |
| 配置变更且已登录 | 自动登出并清空 `supaMeta`（旧 token 属于旧项目，必须重登） |

支持的 key 形式：新版 `sb_publishable_`；页面只引导填写这一种。

## 5. PostgREST 接口

| 操作 | 请求 | 成功 | 冲突 |
| --- | --- | --- | --- |
| 读 | `GET /rest/v1/study_state?user_id=eq.{uid}&select=data,rev,updated_at` | 返回 0/1 行，归一化为 `{data,rev,updatedAt}` | — |
| 首次写 | `POST /rest/v1/study_state`，body `{user_id,data,rev:1}`，`Prefer: return=representation` | 返回新行 | HTTP 409（主键已存在）→ 重新读云端 |
| 条件更新 | `PATCH /rest/v1/study_state?user_id=eq.{uid}&rev=eq.{baseRev}`，body `{data,rev:baseRev+1}` | 返回更新后行 | 更新 0 行 → 视为冲突并重新读云端 |

请求头统一为：

```
apikey: anonKey
Authorization: Bearer {accessToken}
Accept: application/json
```

写入时额外加 `Content-Type: application/json` 与 `Prefer: return=representation`。

**为什么更新也带条件**：即使上传前已经读过最新 `rev`，并发窗口里仍可能有另一台设备写入；`rev=eq.{baseRev}` 是数据库层的第二道保险，保证「读到的版本没变才允许写」。

## 6. 快照与哈希

```js
function snapshot() {
  return { v: 2, schemaVersion: 4, courses, activity, demoActivity,
           details, demoDetails, todos, checkins, courseOpen, panelOpen };
}
```

- 快照**包含**示例数据、明细、待办、循环打卡、展开状态，确保跨设备完全一致；
- `canonical(value)` 对对象键递归排序后序列化；
- `hashState()` 用 djb2（`h*33 + code`）生成 `base36:长度`，只用于**判断本地是否较上次同步有变化**（`localDirty()`），不用于密码学校验；
- `supaMeta.syncedHash` 在每次成功上传 / 应用云端后更新。

## 7. 上传算法（`uploadSnapshot`）

```
1. schemaTooNew → 停止并提示刷新
2. fetchRemote()
3. 云端 schemaVersion > 4 → 停止自动上传，暂停自动拉取
4. 云端 rev !== baseRev → showConflict("上传前发现云端已更新")，不写
5. 云端不存在但 baseRev > 0 → 云端行被删，baseRev 归零，走首次插入
6. baseRev = 0 → insertRemote()
   6.1 409 → 重新读云端 → 有数据则弹冲突
   6.2 条件更新返回 0 行且读不到 → 行被删 → 重新插入
7. baseRev > 0 → updateRemote(baseRev)（PATCH rev=eq.baseRev）
8. 成功 → markSynced(row)：baseRev=row.rev，syncedHash=当前哈希，lastSyncAt=now
```

入口：

| 入口 | 触发 | 说明 |
| --- | --- | --- |
| `scheduleAutoSync` | `saveState()` 后 | 1.5 秒防抖；需已登录、自动同步开启、`supaReady`、无冲突、在线 |
| `pushLocal` | 自动同步 / 自动拉取后补推 | 串行锁 `supaBusy`，结束后 `drainAutoPull()` |
| `manualPush` | 「立即上传」 | 先比对 rev，已是最新会直接提示；本地无数据也会提示 |
| `syncAfterLogin` | 登录 / 恢复会话 | 首次核对，见第 9 节 |

三条硬性拒绝：`schemaTooNew`、本地快照 > 900000 字符（`uploadTooBig`）、离线。

## 8. 拉取算法（`runAutoPull`）

判定表（`base = supaMeta.baseRev`，`clean = !localDirty()`）：

| 云端状态 | 本地状态 | 动作 |
| --- | --- | --- |
| 无记录 | 有数据且（脏 或 `base>0`） | `pushLocal(0)` 重建 |
| 无记录 | 无数据或干净且 base=0 | 提示「云端暂无数据」 |
| `rev === base` | clean | 「已是最新」 |
| `rev === base` | dirty | `pushLocal(base)` |
| `rev > base` | clean | 若正在编辑课时 → `pendingEditPull=true` 推迟；否则 `applyRemote()` |
| `rev > base` | dirty | `showConflict("云端有更新的版本，本机也有未同步的改动")` |
| `rev < base` | clean | `applyRemote()`（云端可能被重置） |
| `rev < base` | dirty | `showConflict("云端版本比本机记录的还旧")` |

`editingCourseField()`：当前焦点在 `.course` 内的 `input` 时不重绘，避免用户正在输入的数字被云端覆盖；`focusout` 后若 `pendingEditPull` 再补拉。

### 8.1 首次登录核对（`syncAfterLogin`）

```
userId 变化 → supaMeta 清零
fetchRemote()
├── 云端 schema 太新 → 停止
├── 云端无记录
│   ├── 本地无数据 → 记下 syncedHash，等首次输入
│   └── 本地有数据 → uploadSnapshot(0)
├── 本机从未参与同步（baseRev=0 或 syncedHash 空）
│   ├── 本地空 → applyRemote
│   ├── 哈希相同 → adoptRemote（只更新 meta）
│   └── 两者都有数据 → showConflict("首次登录：本机与云端都有数据")
├── rev === base
│   ├── 脏 → 上传
│   └── 干净 → 已是最新
├── rev > base → 干净则拉取，脏则冲突
└── rev < base → 冲突
```

登录成功、恢复会话、网络恢复都走这条路径。

## 9. 自动拉取三路触发源

```
① Realtime WebSocket —— 云端行变化时立刻通知
② window focus / visibilitychange —— 回到前台立刻检查（5 秒节流）
③ setInterval 60 秒 —— 兜底，页面不可见时暂停
            ↓ 全部汇入
       requestPull(reason)
            ↓
    同一时刻只有一个 runAutoPull
```

### 9.1 请求合并

- `pullInFlight` 为真或 `supaBusy` 为真 → `pullQueued = true`，不重复发请求；
- 当前请求结束后若 `pullQueued` 且无冲突 → 立刻补拉一次；
- `drainAutoPull()` 在上传 / 手动操作结束后负责消费排队。

### 9.2 Realtime 协议（原生 WebSocket）

```
URL: wss://{project}.supabase.co/realtime/v1/websocket
     ?apikey={anonKey}&vsn=1.0.0

帧格式（JSON）：
{ topic, event, payload, ref }

join:
  topic   = "realtime:public:study_state"
  event   = "phx_join"
  payload = {
    config: { broadcast:{self:false}, presence:{key:""},
              postgres_changes:[{event:"*", schema:"public",
                                 table:"study_state",
                                 filter:"user_id=eq.{uid}"}] },
    access_token: accessToken
  }

心跳：每 30 秒发 topic="phoenix", event="heartbeat"
收到 postgres_changes → requestPull("云端有新改动")
收到 phx_reply status=ok → 标记已连接，立即补拉一次
```

### 9.3 连接治理

| 情况 | 行为 |
| --- | --- |
| 服务端明确拒绝（`phx_reply` 非 ok / 非 token 类 system error） | `realtimeBlocked = true`，降级轮询，不再重试，等重新登录 |
| token 失效 | 续期后重连，不永久放弃 |
| 普通断开 / 网络错误 | 指数退避重连：1s → 2s → … 上限 60s；同时保持 60 秒轮询 |
| 页面不可见 | 不重连、停轮询，回前台再连 |
| 浏览器不支持 WebSocket | 直接降级轮询 |
| 离线 | 全部暂停，`online` 事件后 `restoreSession()` |

Realtime 只是「有变化」的信号源，**数据仍然走 REST 拉整份**，所以订阅丢一条消息最多延迟 60 秒被发现，不会导致数据不一致。

## 10. 冲突处理

`showConflict(remote, reason)`：

- 记录 `pendingConflict = { remote, reason }`；
- 文案包含原因、云端时间、云端 `rev`、本机课程数；
- 三个按钮：

| 按钮 | 行为 | 结果 |
| --- | --- | --- |
| 用云端覆盖本地 | `applyRemote`：`sanitize` → 抑制自动同步 → 替换 `state` → `saveState` → 更新 meta → `renderAll` | 本地被覆盖，`baseRev = remote.rev` |
| 用本地覆盖云端 | 清 `pendingConflict`，`pushLocal(remote.rev)`：以云端最新 rev 为基线写入 | 云端被覆盖，`rev+1` |
| 先不处理 | 关闭弹窗 | 保持 `pendingConflict`，自动上传与自动拉取全部暂停 |

`pendingConflict` 存在时：

- `scheduleAutoSync()` 直接返回；
- `requestPull()` 把实时状态写成 `hold` 并返回；
- 状态行显示 `conflict`，并顶到折叠面板标题栏，面板收起也能看见。

## 11. 状态文案与错误映射

### 11.1 状态行

| 位置 | 元素 | `data-state` 取值 |
| --- | --- | --- |
| 折叠标题 | `#supaHeadStatus` | `idle` / `error` / `conflict`（异常时顶到标题） |
| 配置状态 | `#supaCfgStatus` | `idle` / `ok` / `error` |
| 认证状态 | `#supaAuthStatus` | `idle` / `busy` / `error` |
| 同步状态 | `#supaSyncStatus` | `busy` / `ok` / `error` / `conflict` |
| 实时状态 | `#supaLiveStatus` | `idle` / `connecting` / `ok` / `warn` / `error` / `hold` |

### 11.2 错误翻译

| 来源 | 原始信号 | 用户看到的文案 |
| --- | --- | --- |
| Auth | `invalid login credentials` | 邮箱或密码不对 |
| Auth | `email not confirmed` | 去控制台确认用户，或关闭邮箱验证 |
| Auth | `invalid refresh token` / expired | 登录已过期，请重新登录 |
| Auth | 429 | 尝试太频繁，等几分钟再登录 |
| Auth | 404 | 接口地址不对：检查 Supabase 项目 URL |
| PostgREST | `42P01` | 云端还没建表：先执行 `supabase/schema.sql` |
| PostgREST | `42501` | 没有权限：确认 RLS 策略已执行 |
| PostgREST | 401 | 登录已失效，请重新登录 |
| PostgREST | 403 | 没有权限读写自己的数据（检查 RLS） |
| 网络 | `AbortError` | 同步超时：15 秒没有响应，记录仍在本机 |
| 网络 | `Failed to fetch` / offline | 离线或连不上 Supabase：记录已在本机，联网后自动同步 |
| Realtime | unauthorized / jwt | 登录态失效 |
| Realtime | not enabled | Realtime 没为这张表启用（重新执行 schema.sql） |
| Realtime | permission / rls / policy | 没有订阅权限（检查 RLS） |

## 12. 边界情况

| 场景 | 处理 |
| --- | --- |
| 云端行被删除 | 读不到且 `baseRev > 0` → `baseRev` 归零，按首次插入重建 |
| 云端数据不是对象 | `applyRemote` 的 `sanitize` 失败 → 报错且不应用 |
| 云端 `schemaVersion` 更高 | `blockNewerSchema()`：停止上传、暂停拉取，提示刷新 |
| 本地数据接近 1 MB | 900000 字符时拒绝上传，提示先导出并清理 |
| 两标签页同时打开 | 各自持有 `rev`，后写者会收到 409 / 0 行更新 → 弹冲突，不会互相覆盖 |
| 用户切账号 | `syncAfterLogin` 发现 `userId` 变化，把 `supaMeta` 清零后重新核对 |
| 清除连接配置 | 登出 + 清 meta，但**不删本地进度与云端数据** |
| 登录期间退出 | `runAutoPull` 在拉取返回后会检查 `supaSession` 是否还存在，避免退出后仍改本地 |

## 13. 安全说明

- **Publishable key 是公开密钥**，放在浏览器里是设计允许的；真正的边界是 RLS。
- 绝不能填 `service_role` / `sb_secret_*`：前者绕过 RLS，后者是服务端密钥。配置表单会主动拒绝 `sb_secret_`。
- `access_token` / `refresh_token` 存在 `localStorage`，这是纯前端应用的常见取舍；共享电脑使用后应「退出登录」。
- 传输必须 HTTPS（`localhost` 例外），否则 token 可被中间人截获。
- 本项目不做端到端加密：拥有 Supabase 项目权限的人可以直接读 `data`。
