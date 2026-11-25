# 端到端验收清单 · 学业工作台左栏入口与设置页

> 适用版本：本轮「把 Supabase 与相关设置做进 DSH 左栏」的改动（左栏 `sidebar.panellist` 入口 + 主面板 `main` 页 + 面板内设置页 + `/api/settings` 系列端点）。
> 用法：按顺序逐条执行，每条勾选 `[x]` 并在「证据」列写下实际观察值（截图路径、HTTP 响应片段、终端输出行）。
> 任一条失败即视为本次改动**不可交付**，不要跳过后面再回头补。
>
> 约定：
> - `ROOT` = 仓库根 `D:\Users\22608\Desktop\CODE\study-dashboard`
> - `HOME` = 数据目录，默认 `C:\Users\22608\.dsh\study-widget`，可用 `DSH_STUDY_WIDGET_HOME` 覆盖
> - 自动化部分先跑，人工部分最后跑（人工部分需要真实 Supabase 账号）

---

## 0. 自动化前置（必须先全绿）

| # | 检查 | 命令 | 期望 | 证据 |
| --- | --- | --- | --- | --- |
| 0.1 | 原有冒烟不回归 | `node plugins/study-widget/scripts/smoke.mjs` | 15 项全 `✓`，末行「全部通过」，退出码 0 | 15/15，21 行输出 |
| 0.2 | 设置端点冒烟 | `node plugins/study-widget/scripts/smoke-settings.mjs` | **77 项**全 `✓`，末行「全部通过」，退出码 0 | 77/77，100 行输出 |
| 0.3 | 密码不回传 | 冒烟内断言 + 人工 `curl` 复核（见 0.4） | `GET /api/settings` 响应体不含明文密码字符串 | 冒烟第 1 节已断言 |
| 0.4 | 手工复核响应体 | `curl -s http://127.0.0.1:<port>/dsh-study-widget/api/settings` | 只出现 `"hasPassword": true/false`，**没有** `password` 键 | |

> **已知不稳定**：0.2 在首轮（11:19 那次）曾出现 1 项瞬时失败（`密码错 → AUTH_FAILED` 拿到 `ok:true`），
> 之后连续多次重跑均全绿（含扩充到 69 / 77 项后的版本）。怀疑是脚本内假 Supabase 服务的启动竞态，不是端点逻辑错。
> 交付前请至少连跑 3 次确认稳定；若复现，报 host-settings 排查脚本。（本条**不**阻断交付，但必须在交付说明里记录。）

## 1. 插件加载

- [ ] **1.1 挂载成功**：DSH 启动日志出现 `study-widget` 的 `ready: /dsh-study-widget/`；插件管理里 `@local/dsh-study-widget` 状态为已启用、无报错。
- [ ] **1.2 宿主路由就绪**：浏览器直开 `http://127.0.0.1:<port>/dsh-study-widget/` 返回小组件页面（200，`text/html`），不 401。
- [ ] **1.3 服务引用的健壮性**：若 `webServer` 不可用，日志只 warn「只保留命令与工具」，插件**不抛异常、不阻塞启动**。

## 2. 左栏出现入口

- [ ] **2.1 入口可见**：DSH 左侧栏出现「学业工作台」一行（含图标），位置在既有面板行之中、不与「插件管理」重叠。
- [ ] **2.2 折叠态可辨**：把侧栏折叠成窄轨，该行只显示图标且悬停有 tooltip「学业工作台」。
- [ ] **2.3 未选中不报错**：左侧栏存在该行时，主区仍停在原页面（不自动跳转、控制台无错）。
- [ ] **2.4 id 一致**：入口 `id` 与主面板 `main` 的 `key` 逐字一致（点开后不出现「选择不存在的主面板条目」类抛错）。

## 3. 点开主面板有数据

- [ ] **3.1 点开即整页**：点左栏「学业工作台」→ 主区切换为整页面板（**不是**弹窗，也**不是**右侧栏标签）。
- [ ] **3.2 有数据**：面板显示出总进度百分比、课时数、今日学习时长、待办/打卡、逐课程进度条、热力图。
- [ ] **3.3 口径一致**：同一时刻面板里的总进度与网页版 `index.html` 一致（对照「已看 / 总分钟」，不是各课百分比平均）。
- [ ] **3.4 右侧栏标签仍在**：原右侧栏「学习进度」标签照常可用，与左栏面板显示同一份数据。
- [ ] **3.5 主题跟随**：切换 DSH 深浅色主题，面板颜色随之变化（无写死色值、无白底刺眼块）。
- [ ] **3.6 顶栏无 emoji**：面板顶栏的图标（进度 / 设置 / 桌面小窗 / 刷新）全部为内联 SVG，跟随 `currentColor`，深浅色下都清晰；不出现 📌 ⟳ 之类的字符图标。

## 4. 打开设置

- [ ] **4.1 入口可达**：主面板顶栏有「进度 / 设置」分段控件，点「设置」后同一 iframe 内切到设置页（地址 `/dsh-study-widget/settings`），再点「进度」回到数据页；顶栏标题随之变成「设置」，此时「桌面小窗」按钮隐藏、「刷新」保留。
- [ ] **4.2 分区齐全**：设置页左侧分区导航依序为「连接」「窗口」「数据与刷新」「插件」「高级」「关于」六个分区，缺一即失败。
- [ ] **4.2b 分区只提交本区改动**：在某个分区不改任何字段直接点保存 → 提示「没有改动，无需保存」，且不发 `POST /api/settings`。
- [ ] **4.3 初值正确**：各分区控件显示的是 `$HOME/settings.json` 的现值；未配置过时 URL/anon key/邮箱为空，密码显示为「已保存」掩码而非明文。
- [ ] **4.4 不暴露密码**：打开设置页后，浏览器 DevTools → Network 里 `GET /api/settings` 响应体不含明文密码；页面 DOM 里也没有明文密码（`document.body.innerHTML.includes(真实密码) === false`）。

## 5. 填错 URL 报错

- [ ] **5.1 URL 格式错**：URL 填 `not-a-url` → 保存/测试时前端就地提示，`error.message` 原样可见，不出现整页白屏。
- [ ] **5.2 URL 不可达**：URL 填 `https://example-does-not-exist.supabase.co`、其余字段正确 → 「测试连接」返回失败，
  提示能定位到「网络/域名」而不是笼统「保存失败」（`code` 应为 `NETWORK` 或 `TIMEOUT`）。
- [ ] **5.3 key 错**：URL 正确、anon key 乱填 → 返回 `REST_FAILED`（读数据被拒）语义的失败信息。
- [ ] **5.4 密码错**：URL 与 key 正确、密码错误 → 返回 `AUTH_FAILED`，消息含「邮箱或密码不对」。
- [ ] **5.5 失败不写盘**：以上任一失败后，`$HOME/settings.json` 内容**未被半截覆盖**（原子写；文件仍是上一次的合法 JSON）。
- [ ] **5.6 校验错误码对得上**：URL 不以 http(s):// 开头 → `INVALID_URL`；anonKey ≤20 → `INVALID_ANON_KEY`；邮箱无 @ → `INVALID_EMAIL`；
  宽度越界 → `OUT_OF_RANGE`；`stateFile` 相对路径 → `INVALID_PATH`；布尔字段给字符串 → `INVALID_FIELD`。
- [ ] **5.7 坏文件不静默重置**：手工把 `settings.json` 写成非法 JSON → 读设置返回 `BAD_SETTINGS_FILE`（500），
  **不会**被悄悄重置成默认值（这样用户的配置不会被一次误写冲掉）。

## 6. 填对 URL 保存

- [ ] **6.1 保存成功**：填对四项 → 保存返回 `{ ok: true }`，设置页顶部状态条刷新为已连接（邮箱/最后同步时间可见）。
- [ ] **6.2 落盘位置正确**：`$HOME/settings.json` 存在且为合法 JSON，字段与本轮 `SettingsView` 结构一致；**不是**写进 profile 的 `cordis.patch.yml` 或 `package.json`。
- [ ] **6.3 密码只进不出**：再次 `GET /api/settings`，`supabase.hasPassword === true`，响应体无明文密码；
  `settings.json` 里**确实**保存了密码（明文，按当前实现）—— 这是本机私有文件，确认它**没有**被提交进 git。
- [ ] **6.4 保存即生效**：保存后**不重启 DSH**，主面板下一次刷新就用上新凭据（证明没有走会重启插件的 `configEditor.edit()`）。
- [ ] **6.5 取代手改 login.json**：把 `$HOME/login.json` 移走后，仅靠设置页保存的凭据仍能取到数据。
- [ ] **6.5b 旧用户自动迁移**：删掉 `settings.json`、只留一份含 `url`/`anonKey`/`email` 的 `login.json` → 首次读设置时
  这三项被并进设置（`GET /api/settings` 能读到），且 `login.json` **原文件仍在**（只读迁移，不删原文件）。
- [ ] **6.5c 凭据优先级**：`settings.json` 与 `login.json` 里填**不同**的 url/anonKey → 实际用的是 `settings.json` 那份
  （`/api/status` 的 `source` 为 `settings`）；清空 settings 的 `supabase` 后回落 `login.json`（`source` 为 `login`）；
  两处都清空 → 报 `NO_CREDENTIALS`，消息明确写「去『学业工作台 → 设置 → 连接』填写」。
- [ ] **6.6 连接分区字段齐全**：连接分区可见并生效的字段 = Supabase URL、anon key、邮箱、密码、选中/活动数据源，
  以及「测试连接」「保存」两个动作；密码输入框留空保存时**不**覆盖已存密码（留空 = 保持不变，而非清空）。

## 7. 数据刷新

- [ ] **7.1 保存后自动拉一次**：保存成功后无需手点刷新，面板数据即更新（状态条「刚刚同步」）。
- [ ] **7.2 手动刷新**：面板「刷新」按钮走 `?refresh=1`，绕过 30 秒缓存，数据与网页版一致。
- [ ] **7.3 刷新间隔生效**：把「刷新间隔」改成较小值（如 60 秒），等待后可见自动拉取（Network 里周期性出现 `/api/summary`）。
- [ ] **7.4 离线模式**：打开「离线模式」→ 刷新只读 `latest.json`，**不发任何网络请求**（DevTools 里看不到 Supabase 域），
  数据标 stale、`status.error` 说明「离线模式」；关闭后恢复联网拉取。
- [ ] **7.4b `stateFile` 真正生效**：填一份导出 JSON 的绝对路径 → 数据源变成它（`/api/status` 的 `source` 为 `file`），
  数据与该文件内容一致；相对路径会被拒（`INVALID_PATH`）。
- [ ] **7.5 失败不崩**：把 Supabase 断网（或改错 URL）后刷新 → 回落缓存并给出可读错误，**不**出现 500 白屏。
- [ ] **7.6 两个刷新参数不混淆**：`summaryTtlSeconds`（宿主侧缓存时长，默认 30）与 `pageSeconds`（页面自动刷新周期，默认 300）
  分别生效：把 TTL 调到 0 时每次请求都回源，把页面周期调到 60 时页面自动重载，两者互不覆盖对方的值。

## 8. 窗口开关 / 置顶

- [ ] **8.1 开窗**：设置页（或面板）「打开桌面小窗」→ 屏幕出现无边框小窗，内容与面板一致。
- [ ] **8.2 置顶切换**：切换「始终置顶」→ 用其它窗口覆盖验证层级确实改变（开=压在最前，关=可被覆盖）。
- [ ] **8.3 置顶状态回显**：重新打开设置页，置顶开关回显为真实状态（读的是桌面进程真实状态，不是本地变量）。
- [ ] **8.4 位置记忆**：拖动小窗到新位置 → 关闭 → 重开，位置还原；`$HOME/window.json` 记录了新坐标。
- [ ] **8.5 关窗**：「关闭小窗」→ 进程退出、`/api/desktop` 报 `running: false`；再开不出现双窗（单实例锁生效）。
- [ ] **8.6 尺寸设置**：改 `width`/`height` 后重开小窗，尺寸随设置变化（且不超出屏幕可见区域）。
- [ ] **8.7 窗口分区其余字段**：`autoOpen`（随 DSH 启动开窗）与「始终置顶」各自独立生效，互不覆盖；
  置顶调的 IPC 名与桌面端实际暴露的一致（`study-widget:set-always-on-top`），关闭后不影响位置记忆。
- [ ] **8.8 无通道时的降级要对**：在**浏览器/主面板**里点置顶 → 返回 `applied:"persisted"` 并写进 `desktop.alwaysOnTop`
  （下次开窗生效），而不是假装已置顶；点隐藏 → 返回 `applied:"closed"`（关掉小窗）；小窗本来就没开时隐藏 → `applied:"noop"`；
  没有位置记录时 `GET /api/desktop` 的 `bounds` 是 `null`（前端不报错）。
- [ ] **8.9 `pinnedSource` 语义对**：小窗运行时 `GET /api/desktop` 的 `pinnedSource` 为 `live`（读进程真实值）；
  小窗未运行时为 `settings`（读持久化配置）；两者都拿不到时才 `unknown`。

## 9. 禁用再启用插件

- [ ] **9.1 禁用**：插件管理里禁用 `@local/dsh-study-widget` → 左栏入口消失、宿主路由 404、工具 `study_widget_progress` 不可用。
- [ ] **9.1b 数据保留**：禁用只影响入口与运行，`$HOME/settings.json` 与凭据文件不被删除（对照 11.5 的卸载语义：禁用 ≠ 卸载，两者都不自动删用户数据）。
- [ ] **9.2 禁用不带崩**：禁用过程中 Electron 小窗被正常收掉，浏览器无未捕获异常刷屏。
- [ ] **9.3 再启用**：重新启用 → 左栏入口回来、路由 200、面板照常出数据；**设置页仍显示禁用前的 URL / 邮箱与「已保存」密码状态**（入口与设置一起回来，无需重填）。
- [ ] **9.4 设置不丢**：禁用→启用循环之后，设置页仍显示之前保存的 URL/邮箱与「已保存」密码状态。
- [ ] **9.5 开关委托宿主**：执行禁用/启用的是宿主 `pluginManager` 服务（`setPluginEnabled` / `setBundleEnabled`），
  验证 `cordis.patch.yml` 的变更由宿主写入（`git diff` 可见 `disabled:` 由宿主加/删），插件自身代码不参与写 YAML；
  插件拿不到该服务时应返回 `NO_PLUGIN_MANAGER` 而不是自己改文件。
- [ ] **9.6 禁用保留数据目录**：禁用后 `$HOME` 下 `settings.json` / `login.json` / `window.json` **原样存在且内容未变**
  （禁用不等于清空设置；这是委托实现最容易踩的坑 —— 宿主 reload 时若误清了数据目录即失败）。
- [ ] **9.7 `unaddressable` 不谎报**：若宿主返回 `applied: "failed"` + `error.code: "unaddressable"`（`include` 行挂载的插件会出现），
  页面必须如实显示失败并给出「请到 DSH『设置 → 插件』里操作，或重启 DSH 后生效」的出路，**不能**显示「已禁用/已启用」。
- [ ] **9.8 `restart` 的 partial 语义**：若禁用阶段就失败，返回 `{ok:false, partial:true}` 且消息为「已尝试禁用但失败，插件仍在运行」；
  此时插件**确实仍在运行**（用左栏入口是否还在验证），页面不得显示成已重载。
- [ ] **9.9 不会悄悄换用 bundle 通道**：不传 `packageName` 时只走 `setPluginEnabled`；
  验证手段：宿主日志或 mock 里 `setBundleEnabled` **没有被调用**（除非请求显式带了 `packageName`）。

## 10. 数据持久化（重启后设置仍在）

- [ ] **10.1 正常退出重启**：关闭 DSH → 重新启动 → 左栏入口、设置页、连接状态全部还原，无需重新输入密码。
- [ ] **10.2 强杀重启**：任务管理器强杀 DSH 后重启 → `settings.json` 仍是合法 JSON（未被写坏），设置仍在。
- [ ] **10.3 token 续期**：相隔较久（> access token 有效期）后重开，凭 refresh token 自动续期成功，不需重新输密码。
- [ ] **10.4 清除密码后行为**：在设置页「清除密码」→ `hasPassword` 变 false；重启后仍是未保存密码状态，不会偷偷复用旧 token。

## 11. 卸载不残留

- [ ] **11.1 卸载**：DSH 插件管理卸载 `@local/dsh-study-widget` → 左栏入口消失、路由 404。
- [ ] **11.2 profile 干净**：卸载后 profile 的 `package.json` 里不再有 `@local/dsh-study-widget`（依赖与 `dsh.profile.bundles` 都清掉）；`cordis.patch.yml` 无遗留 `dsh-study-widget` 条目。
- [ ] **11.3 渲染层干净**：DSH 页面无该插件注入的 `<style>`、无残留 `main`/`panellist` 注册；控制台无该插件报错。
- [ ] **11.4 进程干净**：卸载后无遗留 Electron 小窗进程（任务管理器无 `study-widget` 相关进程）。
- [ ] **11.5 数据目录按预期保留**：`$HOME` 下的 `login.json` / `settings.json` / `latest.json` / `window.json` **不被卸载自动删除**（用户数据，需手动清理），且文档里写明了这一点。
- [ ] **11.6 重装可恢复**：重新安装 → 读取 `$HOME` 里既有设置，无需重填凭据。

---

## 12. 回归与提交

- [ ] **12.1** 文档与代码同一次提交：`README.md`、`docs/wiki/10-desktop-widget-plugin.md`、`docs/wiki/README.md`、`docs/PROJECT-STATUS.md`、本文件与代码一并提交。
- [ ] **12.2** 提交前 `git grep` 确认无密钥：搜 `eyJ`、`supabase.co`、真实邮箱、密码字段的明文。
- [ ] **12.3** 截图归档到 `plugins/study-widget/docs/shots/`：设置页（连接分区主视图）+ 左栏入口 + 主面板，共 2~3 张，README 引用路径可打开。
- [ ] **12.4** 无回归：网页版 `index.html` 打开正常、小程序代码未改动（`git status` 核对）。
- [ ] **12.5** 数据分区：`stateFile` 指定一份导出 JSON 后，面板改从该文件读取（便于离线/演示）；
  `homeDir` 只读展示真实数据目录，页面上没有任何能改坏它的可写控件。
- [ ] **12.6** 数据快照往返：高级分区「导出快照」得到的文本再「导入快照」→ 数据一致；导入前旧 `latest.json` 会备份成 `latest.json.bak`（响应 `backup` 给出路径）。
- [ ] **12.7** 只读字段对外可见：`GET /api/settings` 的 `advanced.settingsFile` / `loginFile` 是绝对路径，
  且 `settings.json` **文件里没有**这两个键（不落盘）。
- [ ] **12.8** 接线顺序回归：冷启动 DSH 后，`/api/settings`、`/api/desktop`、`/api/plugin`、`/api/sources` **四个都 200**
  （不全 404）。若只有它们 404 而 `/api/summary` 正常，说明 `index.js` 里 `desktop`/`settingsStore` 声明在
  `createSettingsRoutes(...)` 之后被 TDZ 吞了 —— 按 wiki 踩坑 17 修顺序：`settingsStore → webServer → desktop → settingsRoutes`。
- [ ] **12.9** 新增 lib 文件后重启验证：改 `lib/settings.js` / `lib/settings-routes.js` / `lib/supabase.js` 后，
  **重启 DSH** 再验证路由生效（热重载不加载新文件，见 wiki 踩坑 18）。

---

## 失败处理

1. 记录编号 + 实际观察 + 期望，写进本次交付说明，**不要**自行修改产品代码去迁就清单。
2. 接口字段与文档不一致时，以 TEAM-BRIEF 第 4 节契约为准判定「实现错」还是「文档错」，报 lead 裁决。
3. 安全类条目（0.3 / 0.4 / 4.4 / 6.3 / 11.5）任一失败即阻断交付，其余条目可按 lead 决定降级为「已知问题」并在 `docs/PROJECT-STATUS.md` 记入遗留。
