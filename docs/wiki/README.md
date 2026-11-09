# 学业工作台 · Code Wiki

> 面向维护者与二次开发者的项目文档集。阅读完本套文档，你应当能够独立运行、修改、部署这个项目，并理解每一层代码为什么这样写。

## 1. 项目是什么

「学业工作台」是一个纯静态的个人学习管理网页，用三个视图组织一个人的日常学习：

| 视图 | 解决什么问题 |
| --- | --- |
| 学习 | 今天学了多久、课程进度到哪、接下来学什么 |
| 待办 | 一共有哪些事、哪些已逾期、怎么筛选和改 |
| 日历 | 这个月哪天有事、那天具体做了什么 |

核心特征：

- **零依赖、零构建**：只有 `index.html` + `style.css` + `app.js` 三个文件，双击即可运行。
- **本地优先**：所有数据默认写入浏览器 `localStorage`，不登录、不联网也能完整使用。
- **可选云同步**：登录 Supabase 后整份进度备份到云端，多设备通过乐观锁（`rev`）安全合并。
- **AI 辅助录入**：B 站课程、待办清单都通过「复制提示词 → 交给任意 AI → 粘贴 JSON → 预览 → 确认写入」的方式导入，前端不直接调用第三方接口。
- **零后端依赖**：仓库里的 `worker/` 是历史方案（Cloudflare Workers + D1），页面当前不再请求它。

## 2. 文档目录

| 文档 | 内容 | 建议读者 |
| --- | --- | --- |
| [01 整体架构](01-architecture.md) | 技术栈、目录结构、分层与数据流、模块职责、关键设计决策 | 所有人，先读这篇 |
| [02 数据模型](02-data-model.md) | `state` 结构、字段约束、localStorage 键、迁移与校验、导出格式 | 改数据结构的人 |
| [03 前端逻辑](03-frontend.md) | `app.js` 分区、常量、关键函数、渲染机制、事件绑定 | 改交互与业务的人 |
| [04 页面与样式](04-ui.md) | `index.html` 结构树、三视图信息归属、CSS 令牌与分区、响应式、可访问性 | 改界面的人 |
| [05 云同步](05-cloud-sync.md) | Supabase 认证、PostgREST、`rev` 乐观锁、Realtime、冲突状态机 | 改同步逻辑的人 |
| [06 Worker（已停用）](06-worker.md) | Cloudflare Worker 路由契约、D1 表结构、安全策略 | 需要复活旧方案的人 |
| [07 运行与部署](07-run-and-deploy.md) | 本地运行、静态托管、Supabase 接入、故障排查 | 首次部署的人 |

## 3. 仓库文件清单

```
study-dashboard/
├── index.html              # 唯一页面：三视图 + 全部弹层与面板的静态骨架
├── style.css               # 全部样式（设计令牌 / 组件 / 响应式 / 动画）
├── app.js                  # 全部前端逻辑（数据层 / 渲染层 / 云同步 / 事件）
├── DESIGN.md               # 界面改版设计说明（信息归属、颜色语义、排版规则）
├── supabase/
│   ├── schema.sql          # 建表 + RLS + 触发器 + Realtime 发布（可重复执行）
│   └── README.md           # Supabase 配置手册与同步规则对照表
└── worker/                 # 历史方案，已停用，仅供追溯
    ├── src/index.js        # Worker 入口：/bili 透传 + /sync/{code} 读写
    ├── schema.sql          # D1 表 sync_docs(code, data, updated_at)
    ├── wrangler.toml       # Worker 名称、D1 绑定、允许来源
    ├── README.md           # 部署步骤与接口契约
    └── .gitignore          # 忽略 .wrangler 本地缓存
```

## 4. 技术速览

| 维度 | 选择 | 说明 |
| --- | --- | --- |
| 语言 | 原生 HTML / CSS / JavaScript（单 IIFE，`const/let` + `async/await`） | 无 TypeScript、无框架、无打包、无箭头函数 |
| 运行环境 | 任意现代浏览器 | 直接打开 `file://` 亦可，云同步需 `https`/`localhost` |
| 本地存储 | `localStorage` | 4 个键，见 [02 数据模型](02-data-model.md) |
| 云同步 | Supabase Auth + PostgREST + Realtime | 手写 `fetch` / `WebSocket`，不引入 SDK |
| 可选代理 | Cloudflare Workers + D1 | 已停用，页面不再依赖 |
| 字体 | 系统衬线 / 无衬线 / 等宽字体栈 | 不加载 Web Font，避免首屏阻塞 |

## 5. 三分钟跑起来

1. 直接用浏览器打开 `index.html`（或 `python -m http.server 8765` 后访问）。
2. 点「填入示例课程」即可看到完整界面与示例数据。
3. 需要多设备同步时，按 [07 运行与部署](07-run-and-deploy.md) 第 4 节接入 Supabase。

## 6. 维护约定

- 站点名称唯一来源是 `app.js` 里的 `APP_NAME`，标题、页脚、导出文件名都由它派生。
- 数据结构版本唯一来源是 `SCHEMA_VERSION`（当前 3），改动结构时必须同步：
  `sanitize()`、`snapshot()`、导出逻辑、`supabase/schema.sql` 里的数据体积约束。
- 提示词常量（`BILI_PROMPT`、`TODO_IMPORT_PROMPT`）与对应解析函数的校验规则严格耦合，改字段必须两边一起改。
- 任何「云端与本地都有改动」的情况都不允许静默覆盖，必须走冲突弹窗。
