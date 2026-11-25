# 插件 · 学业工作台桌面小组件

> 本目录下每个子目录是一个可被 DSH 加载的插件包（`@local/*`）。子目录之间互不引用，只共享宿主 API。

## 1. 清单

| 目录 | 包名 | 形态 | 说明 |
| --- | --- | --- | --- |
| [study-widget](study-widget/) | `@local/dsh-study-widget` | host + web client + Electron 小窗 | 学习进度常驻桌面小窗 / DSH 侧栏面板 / `study_widget_progress` 工具 / `/study` 命令 |

## 2. 开发约定

与仓库其它部分一样遵循「文档随代码」：

1. **每加一个插件，补一行清单**，并新建 `docs/wiki/10-<名称>.md`（代码级说明：结构、接口、边界、踩坑）。
2. **插件自述**放在各自 `README.md`：安装、配置、操作、接口、自测怎么跑。面向使用者。
3. **测试随包走**：`scripts/smoke.mjs` 之类必须零外部依赖、不启动 DSH 也能跑，数据目录用临时目录。
4. **截图归属**：交付用的界面图放 `<插件>/docs/shots/`（进 git）；调试过程中的散图放 `.screenshots/`（已被忽略）。
5. **不进 git 的东西**：`node_modules/`、真实凭据（`~/.dsh/study-widget/login.json`）、本机私有配置、
   临时目录（`.tmp-skill/`，见根 `.gitignore`）。
6. **提交粒度**：一个逻辑改动一个提交，代码 + 文档 + 测试一起提交，提交信息写清改了什么。
7. **插件包结构固定为**：`package.json`（`dsh.bundle.patch` + `dsh.client`）、`cordis.patch.yml`、
   `index.js`（host）、`client.js`（web）、`lib/`（纯函数与宿主适配）、`assets/`（页面）、`locale/`（文案）。
   可以少，不要多出新层级。

## 3. 加载与热重载

- 插件通过 profile 的 `package.json` → `dsh.profile.bundles` 挂载；仓库内开发用 `link:` 依赖，
  改完代码无需重新安装。
- 生效方式：插件管理里把对应条目 `disabled` 再打开（等价于 `set_plugin enabled:false → true`），
  host 侧路由与工具会随之重建；只改 `assets/` 的话刷新页面即可。
- 宿主侧的 Electron 小窗是独立进程，改 `desktop/*.cjs` 必须关掉小窗再打开（或重启 DSH）。
