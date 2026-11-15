# 项目状态总览（2026-11-15）

> 一份文档说明「今日一页 / 学业工作台」当前做到了哪一步：两端功能对照、云同步与数据库、隐私合规、发布方式、遗留事项。
> 更细的代码级说明见 [docs/wiki](wiki/README.md)。

## 1. 两端形态

| 端 | 位置 | 技术 | 部署 |
| --- | --- | --- | --- |
| 网页版 | 仓库根目录 `index.html` / `style.css` / `app.js` | 原生 HTML/CSS/JS，零构建 | GitHub Pages（推 `main` 自动发布） |
| 微信小程序 | `miniapp/` | Taro 4.1.9 + React 18 + TypeScript（designWidth 375） | 微信公众平台 · 体验版（当前 1.1.6） |

两端共用同一套数据结构和云同步协议，数据默认只存本机，开启云同步后可互相同步。

## 2. 功能对照

| 能力 | 网页版 | 小程序 |
| --- | --- | --- |
| 今日概览（视频时长 / 完成待办 / 打卡次数 / 连续天数） | ✅ | ✅ |
| 循环打卡（每天 / 每周 / 每隔 N 天，视频打卡写入课时） | ✅ | ✅ |
| 学习日历热力图 + 当日明细（视频、待办、打卡） | ✅ | ✅ |
| 待办（状态筛选、类别筛选、优先级、截止日、备注、链接、编辑、删除） | ✅ | ✅ |
| 待办批量导入（AI 生成 JSON → 粘贴 → 预览 → 写入） | ✅ | ✅ 读剪贴板 |
| 课程登记（一次生成 N 个课时） | ✅ | ✅ |
| 课时进度（标题、总时长、已看时长、自动记录到当天） | ✅ | ✅ |
| 课时删除 / 课程删除 | ✅ | ✅ |
| B 站课程导入 | ✅ 提示词 + JSON | ✅ 直接输 BV 号，调 B 站公开接口 |
| 云同步（手动 / 自动、冲突二选一） | ✅ Supabase 直连 + Realtime + 60s 兜底 | ✅ 经自建云函数中转 |
| 历史版本（查看最近 20 版、恢复） | ✅ | ✅ |
| 本机备份导出 / 导入 | ✅ | ✅ 走剪贴板 |
| 重置打卡 / 清空数据 | ✅ | ✅ |
| 桌面宽屏布局 | ✅ | — （移动端布局） |

数据结构版本 `SCHEMA_VERSION = 3`，两端一致；示例数据与「填入示例课程」入口已全部下线，旧数据里的示例课程/示例打卡分钟会在读取时自动剔除并同步回云端。

待办类别固定为四类：`学业课程`、`学科竞赛`、`文体活动`、`其他`；旧数据里的「其他」继续有效。

## 3. 云同步架构

```
微信小程序 ──(x-sync-token)──▶ 腾讯云 SCF Web 函数 ──(apikey: sb_secret_…)──▶ Supabase PostgREST
                                        │
                                    只放行 /rest/v1/*
网页版 ─────────(Supabase Auth + anon key)──────────────────────────────────▶ Supabase PostgREST / Realtime
```

- 小程序侧配置项：函数 URL + `SYNC TOKEN`，保存在本机 Storage（`cloud-cfg-v1`）。
- 云函数环境变量：`SUPA_URL`、`SUPA_KEY`（Supabase secret key）、`SYNC_TOKEN`；secret key 只能放在 `apikey` 头，不能当 Bearer 用。
- 同步协议：
  1. `GET /rest/v1/study_state?select=rev,updated_at` 探版本；
  2. `PATCH /rest/v1/study_state?user_id=eq.X&rev=eq.N`，body `{ data, rev: N+1 }` 乐观锁，命中 0 行即冲突；
  3. 本机改动 2.5 秒防抖上传；应用远端数据时不再反向触发上传；
  4. 冲突必须二选一（云端 / 本机），不静默覆盖。
- 单用户方案：网页端用 Supabase Auth 登录自己的账号，小程序用 secret key 直写自己那一行；多用户需另做账号体系。

### 数据库

| 表 | 作用 |
| --- | --- |
| `public.study_state` | `user_id`、`data jsonb`、`rev bigint`、`updated_at`，每个用户一行 |
| `public.study_state_history` | 每次 UPDATE 前归档旧数据（`rev`、`data`、`archived_at`），触发器自动保留最近 20 版 |

- 建表与 RLS：[supabase/schema.sql](../supabase/schema.sql)
- 历史归档触发器：[supabase/history.sql](../supabase/history.sql)（已在线上执行）
- 恢复历史 = 取该版 `data`，以当前 `rev + 1` 写回；写成功后两端都会随之回滚。

## 4. 隐私与合规

- 不采集微信昵称/头像、手机号、位置、相册、相机、麦克风、通讯录；无统计、埋点、广告 SDK。
- 唯一涉及的隐私接口是剪贴板，且只在用户主动点击时读写：批量导入、导入备份（读），导出备份、复制提示词/链接（写）。
- 网络请求只有两个目标：自建云函数（同步）与 `api.bilibili.com`（仅发送 BV 号）。
- 发布前需在微信后台「用户隐私保护指引」声明剪切板用途；完整文案已提供，可放在 `docs/` 或小程序内说明页。

## 5. 发布与更新

### 小程序

1. `cd miniapp && npm run build:weapp`
2. 用 `miniprogram-ci` 上传（脚本在系统临时目录，改 version 后运行），二维码输出到 `.screenshots/preview-qr.jpg`
3. 微信公众平台 → 管理 → 版本管理：设为体验版（自用）；要对外则提交审核 → 发布
4. 服务器域名需加入：云函数 URL 域名、`https://api.bilibili.com`
5. 仓库里的 `project.config.json` 用占位 AppID，真实 AppID 在本机被忽略的 `project.private.config.json`

### 网页版

推送到 `main` 后由 GitHub Pages 自动部署，强制刷新即可看到新版本。

### 已知环境问题

本机 DNS 可能把 `github.com` 解析到不可达 IP，导致 `Connection was reset`；推送时可用：

```
git -c http.curloptResolve=github.com:443:140.82.112.3 push origin main
```

## 6. 目录速览

```
study-dashboard/
├── index.html / style.css / app.js     网页版（唯一页面 + 全部逻辑）
├── docs/
│   ├── PROJECT-STATUS.md               本文档
│   └── wiki/                           代码级文档（架构、数据、UI、云同步、部署）
├── supabase/
│   ├── schema.sql                      主表 + RLS + Realtime
│   └── history.sql                     历史归档表 + 触发器
├── miniapp/                            微信小程序（Taro + React + TS）
│   └── src/
│       ├── pages/                      study / todo / calendar / courses / settings
│       ├── components/                 Sheet、Prompt、MiniCalendar、DayDetail
│       └── data/                       store、cloud、types、date、sanitize、todoImport
├── worker/                             历史方案（Cloudflare Workers + D1），已停用
└── assets/                             应用图标
```

## 7. 遗留与后续

- **定时学习提醒（未实现，方案已定）**：GitHub Actions 定时读 Supabase，按「早上提醒今天要做的事 / 每晚提醒未打卡 / 断签预警 / 每周复盘」四类判定后推送到通知渠道；渠道待选（飞书群机器人最省事，微信订阅消息受个人主体一次性订阅限制）。
- 网页端 B 站导入依赖外部 AI 生成 JSON；小程序已可直连 B 站接口。
- 若未来要多用户使用，需要引入 Supabase Auth 或给每个用户单独配置同步行，不能共用当前单用户方案。
- `worker/` 保留仅作历史追溯，不参与构建与部署。
