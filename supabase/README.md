# Supabase 云同步配置说明

站点默认只把进度存在浏览器 `localStorage`（`study-log-v1`）。登录 Supabase 后，同一份进度会再备份到云端。

- 未登录 / 断网：照常记录，数据只在本机
- 登录后：改动 1.5 秒防抖自动上传；另一台设备登录同一账号即可拉取
- 云端和本机都改过时：弹窗让你选「以本地为准 / 以云端为准」，不会静默覆盖

页面不硬编码任何 Supabase 地址或密钥，URL 与 anon key 在页面「设置 · 云同步」里填写，只存在本机浏览器。

## 1. 建项目

1. 打开 <https://supabase.com> → Sign in → New project
2. 填项目名（例如 `study-dashboard`）、数据库密码、选择区域（离你近的，例如 Singapore）
3. 等 1～2 分钟，项目状态变成 Active

免费计划足够个人使用；免费项目长时间没有 API 活动会被暂停，见第 6 节。

## 2. 建表与 RLS

1. 进入项目 → 左侧 **SQL Editor** → New query
2. 把 [`schema.sql`](./schema.sql) 整段粘贴进去 → Run
3. 确认没有报错。脚本可重复执行

脚本会创建：

| 对象 | 作用 |
| --- | --- |
| 表 `public.study_state` | 每个用户一行：`data`（整份进度 JSON）、`rev`（乐观锁版本号）、`updated_at` |
| 4 条 RLS 策略 | 登录用户只能 select / insert / update / delete `auth.uid() = user_id` 的行 |
| 触发器 `study_state_touch` | 每次更新自动刷新 `updated_at`，客户端不用手写时间 |
| 表权限 | `authenticated` 可读写，`anon` 全部收回 |

### 为什么整份 state 存一行，而不是拆成课程表 / 课时表？

- 页面始终是「整份读、整份写」：渲染、导出、导入、示例数据都基于同一个对象；拆表反而要在客户端拼装和事务里维护一致性。
- 同步的正确性靠单行条件更新（`WHERE rev = 上次版本`）即可保证，一次写入就是一个版本，不会出现「课程写成功、课时写失败」的半截状态。
- 数据量很小（个人几十门课、几年打卡，远低于 1 MB 上限），不需要按课时做 SQL 查询。
- 代价：以后若要做跨用户统计、按课程检索，需要再做一份拆表或物化视图；对「一个人用」的场景不值得。

## 3. 创建登录账号

页面只做登录，不开放注册。账号在控制台建：

1. 左侧 **Authentication** → **Users** → **Add user**
2. 填邮箱、密码，勾选 **Auto Confirm User**（否则要收邮件点确认链接）
3. 创建后回到页面，用这个邮箱 + 密码登录

如果看到「邮箱还没验证」，检查这个用户是否已确认，或在 Authentication → Providers → Email 里临时关掉 Confirm email。

## 4. 取 URL 与 anon key

1. 项目 → 左下 **Project Settings** → **API**（新版界面也可能叫 **API Keys**）
2. 复制 **Project URL**，形如 `https://abcdxyz.supabase.co`
3. 复制 **anon public** key（新版叫 **publishable** key 也可以）
4. **不要**复制 `service_role` / secret key：它绕过 RLS，绝不能放进网页

## 5. 填进页面

1. 打开站点（线上 <https://za123-lab.github.io/study-dashboard/> 或本地 `index.html`）
2. 滚到「设置 · 云同步」→ 填 Project URL、anon key → **保存连接配置**
3. 输入第 3 步创建的邮箱、密码 → **登录**
4. 登录后看到「已登录：你的邮箱」，首次会自动核对云端：
   - 云端为空：直接上传本机数据
   - 本机为空：直接拉取云端
   - 两边都有且不一样：弹窗让你选一份
5. 另一台设备重复第 1～3 步，登录同一账号即可看到同一份进度

## 6. 免费额度与「闲置暂停」

Supabase 免费计划的项目在连续约 7 天没有任何 API / 数据库活动后会被暂停（具体时长以 Supabase 当前政策为准）。暂停后：

- 数据不会丢，表结构和内容都在
- 网页会报「连不上 Supabase」或同步失败，本机记录仍然照常可用

恢复步骤：

1. 登录 <https://supabase.com/dashboard>
2. 选中被暂停的项目，页面会提示已暂停，点 **Restore project**（或 Unpause）
3. 等 1～3 分钟，状态回到 Active
4. 回到网页点「立即拉取」或随便改一笔触发自动同步

想少被暂停：隔几天打开页面记一笔（产生一次 API 请求）即可；仅打开 dashboard 不一定算活跃。

## 7. 安全说明：anon key 为什么可以放浏览器

anon key 是 Supabase 设计给浏览器公开使用的密钥，它的权限完全由 RLS 决定。本项目：

- 所有策略都要求 `auth.uid() = user_id`，匿名请求拿不到任何行
- `anon` 角色的表权限已收回
- 页面只保存 anon key；service_role key 永远不要填进页面或提交到仓库

即便如此，本项目仍按你的要求不在仓库里硬编码 URL / key：配置写在页面里、存本机 `localStorage`（键名 `study-supabase-v1`），公开仓库里没有真实项目地址。

## 8. 同步规则（排查时对照）

| 场景 | 行为 |
| --- | --- |
| 未登录 | 只写 localStorage，不发任何请求 |
| 登录后本机有改动 | 1.5 秒防抖后 PATCH，条件 `rev = 上次云端版本` |
| 上传时版本已被别处改过 | 0 行命中 → 拉云端 → 弹窗二选一 |
| 本机无改动、云端 rev 更大 | 静默拉取云端并重绘 |
| 本机有未同步改动、云端也变了 | 弹窗二选一，自动同步暂停 |
| 断网 | 写本地，状态提示离线；恢复联网后自动续期并补传 |
| 退出登录 / 清除配置 | 只清本机 token / 配置，不删本机进度，也不删云端数据 |

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| `relation "public.study_state" does not exist` / `42P01` | 没执行 `schema.sql`；执行后等几秒，或在 SQL Editor 跑 `notify pgrst, 'reload schema';` |
| 登录报「邮箱或密码不对」 | 检查邮箱密码；确认用户是在 Authentication → Users 里创建的 |
| 登录报「邮箱还没验证」 | 控制台确认该用户，或关闭 Confirm email |
| 登录 401 / 同步 401 | 登录过期，重新登录；检查 Project URL 是否填错 |
| 读写 403 / `42501` | `schema.sql` 里的 RLS / grant 没执行完整，重跑一遍 |
| 拉取后课程没变化 | 看状态行是否「冲突」；冲突时要点弹窗里的按钮才会覆盖 |
| 换设备登录后看到空白 | 本机为空会自动拉云端；如果没拉，点「立即拉取」 |
| 免费项目报连不上 | 项目可能被闲置暂停，按第 6 节恢复 |

## 10. 需要你手动完成的事

- [ ] 注册 Supabase，创建项目
- [ ] SQL Editor 执行 `supabase/schema.sql`
- [ ] Authentication → Users 里创建你的邮箱账号（勾选 Auto Confirm）
- [ ] Project Settings → API 复制 URL 与 anon public key
- [ ] 页面里保存配置并登录
- [ ] 第二台设备登录同一账号，确认能看到同一份进度

以上都需要你本人账号操作；本仓库没有你的密钥，也不会自动调用 Supabase API。
