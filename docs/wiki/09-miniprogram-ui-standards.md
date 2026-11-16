# 09 · 小程序界面与交互开发规范（Apple 液态玻璃实战）

> 适用：微信小程序 `miniapp/`（Taro 4 + React 18 + TypeScript，designWidth 375）。
> 来源：1.1.7 → 1.1.8 这一轮「Apple 液态玻璃 / 自定义 tabBar / 弹层层级 / 闪烁根治」的真实返工记录。
> 定位：**这是约束清单 + 踩坑日志，不是灵感参考。** 每一条「禁止」背后都有一次真机截图或一次构建返工。
> 动效部分的门禁与时长基线见 [08 动效开发规范](08-motion-standards.md)；本文聚焦材质、层级、微信环境特例与问题诊断。

---

## 1. 先记住这七条铁律

1. **静态表面绝不 `backdrop-filter`**——底下没有真实内容滚过的面（面板、按钮、分段控件），加 blur 只会在 WKWebView 首帧产生「空层闪白」，且没有任何视觉收益。
2. **微信自定义 tabBar 是独立渲染层**——页面内的 `z-index` 无论写多大都压不住它。要盖住它只能让 tabBar 组件隐藏，不是调层级。
3. **独立层里 `transition` 不可靠**——tabBar 的显示/隐藏用「状态类 + 关键帧 + 字面曲线」，不要依赖 CSS 变量或 `transition`。
4. **tab 切换不做整页入场动画**——中频导航就该瞬时切换；`opacity:0→1` 在每次切 tab 时都造成「内容先消失再出现」的闪烁，已彻底移除。
5. **弹层退场要走统一 hook `useDismiss`**——只推迟 `onClose` 的调用时机，绝不动父页面的条件渲染和 overlay 计数（那里已经反复调过 3 轮）。
6. **玻璃材质 = 三层合成**——镜面斜高光 + 半透明暖白渐变 + 边缘透光（亮顶边 / 暗底边）。少任何一层都不像 Apple 的 Liquid Glass。
7. **`switchTab` 的原生导航栏标题会空白**——这是微信已知时序怪癖，四个 tab 页 `useDidShow` 里必须 `setNavigationBarTitle` 兜底。

---

## 2. 材质规范：Apple 液态玻璃的可落地写法

### 2.1 设计取向

保持「方格纸学习手账」的品牌个性（暖米色纸底 `#f6f1e5`、墨蓝字迹、朱红批注、宋体标题、印章），**不照搬 iOS 冷白**。玻璃用暖白半透明，与纸底同色系。

### 2.2 全局 token（`src/app.scss` 的 `page`）

```scss
--glass:        rgba(251, 248, 240, 0.62);  /* 常规半透明 */
--glass-strong: rgba(251, 248, 240, 0.82);  /* 需要更实 */
--glass-edge:   rgba(255, 255, 255, 0.72);  /* 亮边 */
--glass-shadow: 0 12px 34px rgba(32,52,78,.1), 0 2px 8px rgba(32,52,78,.05);
--ease-out:     cubic-bezier(0.23, 1, 0.32, 1);
--ease-drawer:  cubic-bezier(0.32, 0.72, 0, 1);
```

不要平行新建一套 token；扩展而非分叉。

### 2.3 三层合成配方（`.panel` 为例）

```scss
.panel {
  background:
    linear-gradient(118deg, rgba(255,255,255,.42) 0%, rgba(255,255,255,.1) 30%, rgba(255,255,255,0) 48%), /* ① 镜面斜高光 */
    linear-gradient(155deg, rgba(255,255,255,.66) 0%, var(--glass) 48%, rgba(246,241,229,.52) 100%);      /* ② 暖白半透明 */
  border: 1px solid var(--glass-edge);
  box-shadow: var(--glass-shadow),
    inset 0 1px 0 var(--glass-edge),                 /* ③ 亮顶边 */
    inset 0 -1px 0 rgba(32,52,78,.06),               /* ③ 暗底边 */
    inset 0 0 0 1px rgba(32,52,78,.05);
  border-radius: 14px;
  /* 注意：没有 backdrop-filter */
}
```

**适用性判定（关键）**——用 blur 不看「要不要层级感」，看**底下有没有真实内容滚过**：

| 表面 | 底下内容 | 是否 blur | 透明度档 |
| --- | --- | --- | --- |
| `.panel` / `.btn` / `.seg` / `.mini-cal` / `.field-input` / `.sync-conflict` | 纯纸色，无内容滚过 | ❌ 禁止 | 半透明渐变（0.4–0.66） |
| `.day-card` / `.sheet-card` | 弹层压住的页面内容 | ✅ `blur(24px) saturate(175%)` | 0.90 / 0.88 / 0.90 |
| `.tabbar-surface` | 全站唯一「有内容真实滚过」的玻璃面 | ✅ `blur(28px) saturate(190%)` | 0.72 / 0.66 |

- 弹层不要叠两层浅色半透明（Apple 明令避免）——卡片自身够亮，用 `blur` 糊底保证密集文字可读，而不是把背景调实。
- 透明度曾两度返工：0.96→实色会丢玻璃感；调回半透明但保留 blur 才对。**闪白的元凶是 `backdrop-filter`，不是透明度。**

### 2.4 无障碍降级

- `prefers-reduced-motion`：静态面板 `animation:none`；弹层/底栏改纯淡入淡出（140–180ms），去位移与缩放。
- `prefers-reduced-transparency`：各玻璃面统一 `background: var(--paper-2); backdrop-filter:none`，高光层随之被覆盖，无需逐条处理。

---

## 3. 自定义 tabBar 规范

### 3.1 三个必备文件（缺一不可）

| 文件 | 作用 | 坑 |
| --- | --- | --- |
| `app.config.ts` | `tabBar.custom = true`，保留 4 个 tab 与 PNG 图标 | — |
| `src/custom-tab-bar/index.tsx` / `index.scss` | 胶囊组件与玻璃样式 | — |
| `src/custom-tab-bar/index.config.ts` | `export default definePageConfig({ component: true })` | **漏了它，编译出的 `index.json` 是 `{}`，组件根本不渲染。** Taro 不会自动生成，必须手写。 |

图标复用 `src/assets/tabbar/*.png` 两套（灰蓝描边 / 朱红选中），路径写 `/assets/tabbar/xxx.png`。

### 3.2 选中态同步

- 各 tab 页 `useDidShow` 里 `Taro.eventCenter.trigger('custom-tabbar:select', n)`（n=0/1/2/3），组件内 `on` / `off` 监听。
- 组件首次挂载用 `Taro.getCurrentPages()` 的路由推断一次，避免刚进小程序短暂高亮「学习」。
- 这套事件通信比 `getTabBar().setSelected` 更不依赖挂载时机。新增 tab 页记得补事件，别忘了 `import Taro`。

### 3.3 独立层铁律（最重要）

根因：微信把自定义 tabBar 注入在**独立渲染层**，页面内 `z-index:1100` 也压不住 `z-index:900` 的底栏。真机截图证明：弹窗背景已经不透字，底栏照样盖在上面。

**唯一正确做法**：弹层出现时直接隐藏 tabBar 组件，用**弹层计数器**而非布尔（兼容嵌套）：

```ts
// src/data/overlay.ts
export const TABBAR_OVERLAY_EVENT = 'tabbar:overlay'
let count = 0
export function pushOverlay() { count++; Taro.eventCenter.trigger(TABBAR_OVERLAY_EVENT, count > 0) }
export function popOverlay()  { if (count > 0) count--; Taro.eventCenter.trigger(TABBAR_OVERLAY_EVENT, count > 0) }
```

- Sheet / DayDetail 在 `useEffect([])` 里 `pushOverlay` / `popOverlay`；PromptHost 在 `useEffect([!!req])`。
- 层级约定：tabbar 900 < day 1000 < sheet 1100——但**这是给页面内元素看的，压不住独立层**，别指望调 z-index 解决问题。

### 3.4 显示/隐藏动画（关键帧，不是 transition）

组件**始终挂载**，靠两个状态类切换；曲线**直接写字面值**，不依赖 CSS 变量（独立层里解析存疑）：

```scss
.tabbar-shown  { animation: tabbar-up   320ms cubic-bezier(.32,.72,0,1) both; }
.tabbar-hidden { animation: tabbar-down 260ms cubic-bezier(.32,.72,0,1) both; }
/* keyframes 内写 opacity + translateY(130%) + visibility，fill:both 保持终态；
   visibility 写进关键帧，避免提前隐藏；hidden 下 .tabbar-surface pointer-events:none */
```

- `return null` 卸载 → 关闭后重新挂载没有任何过渡，就是「闪出来」；`opacity:0` 藏起来 → 独立层会压在遮罩上方。两条死路都别走。
- 时序编排：弹窗向下退场 220ms → 底栏向上弹回 320ms；打开时反向（底栏先滑下，遮罩淡入、sheet 上滑）。
- `prefers-reduced-motion`：降级为 `tabbar-fade` / `tabbar-fade-out` 160ms 纯淡入淡出。

### 3.5 页面留白

`.page` 的 `padding-bottom: calc(78px + env(safe-area-inset-bottom))`（宽屏 84PX），否则悬浮胶囊盖住内容。

---

## 4. 弹层与退场规范

### 4.1 统一 `useDismiss`（`src/data/motion.ts`）

关闭时先 `setClosing(true)`，220ms 后才调真正的 `onClose`；退场中重复点击直接忽略。遮罩/关闭按钮的 `onClick` 一律换成 `dismiss`。

- **绝不改父页面的条件渲染**（弹层仍挂载，overlay 计数保持，底栏继续隐藏），退场结束才一起恢复。
- PromptHost 这类常驻宿主：用 `resultRef` 存结果，`dismiss` 到动画结束才 publish+resolve；新请求进来 `useEffect([!!req])` 调 `reset` 清残留退场态。

### 4.2 退场 CSS（`src/components/index.scss`）

| 元素 | 进场 | 退场 |
| --- | --- | --- |
| 卡片 | `sheet-up 320ms`（`translateY(12%) scale(.985)` → none） | `sheet-down 220ms`（沉回 + 淡出，反向） |
| 遮罩 | `glass-mask 180ms` | `mask-out 200ms` |

- `.card-closing` / `.mask-closing` 用 `both` 停在透明态直到组件真正卸载。
- 退场比进场短 = 系统响应要利落（Apple 非对称进出）。

---

## 5. 页面与导航栏规范

### 5.1 页面切换：只做「玻璃显影」

- **禁止**整页 `opacity:0→1` 入场（`page-enter-*`），每次切 tab 都重播就是「闪」，已彻底删除，不要恢复。
- 采用 `.panel` 的 `panel-in`：`from { opacity: .3; transform: translateY(5px) }`，260ms `--ease-out` `both`。只在 tab 首次挂载播放（tab 页切走不卸载、回来不重播），页面背景/标题/底栏始终稳定，永不整页空白。
- 起始透明度 **0.3 而非 0**——面板始终隐约可见，是「材质显影」不是「内容消失再出现」。
- `prefers-reduced-motion` 下 `.panel { animation: none }`。

### 5.2 导航栏标题兜底

- 现象：`switchTab` 跳转时微信会「先跳回旧 tab 再跳目标」，标题时序竞争导致空白（待办/课程两页必现，学习/日历正常）。`index.config.ts` 与产物 json 里标题都是对的，运行时却空白。
- 双保险：四个 tab 页 `useDidShow` 里显式 `Taro.setNavigationBarTitle({ title: '今日一页' | '待办' | '日历' | '课程' })`；页面 json 标题保留。
- 每个页面（含 `settings`）都要有 `index.config.ts`；settings 曾缺失导致标题继承全局「今日一页」。

---

## 6. 业务逻辑约定：打卡按天去重

- `dayStats(key)`：同一打卡项同一天多条 log 只算 **1 次**打卡（每项当天 `hitToday` 就 break），但视频分次看的时长仍累加到 activity / 课时。
- `checkinCanRun`：`daily` 直接返回 `true`，允许一天内无限次累加；`weekly` / `interval` 保留周期限制。
- 文案：当天已记显示「今天已记，可继续累加」，学习页按钮显示「再记」。`累计 N 次` 仍是 `logs.length`（真实记录条数），与打卡次数是两回事。

---

## 7. 构建、验证与发布

### 7.1 构建产物核对（别只看 `app.wxss`）

Taro 4 把全局样式编译到 **`app-origin.wxss` + `common.wxss`**，`app.wxss` 只有 `@import`。核对材质/动画是否进产物时查对文件：

```
npm run build:weapp
# 玻璃/关键帧 → app-origin.wxss、common.wxss
# tabBar 动画 → custom-tab-bar/index.wxss
# 文案/事件名 → common.js、pages/*/index.js
```

### 7.2 预览码与上传

- `npm run preview`（`scripts/preview.js`）：`ci.preview` 生成**开发版预览码**，扫码看最新 dist，不影响后台版本，25 分钟过期。密钥只从 `MINIPROGRAM_PRIVATE_KEY` 环境变量读，绝不写进脚本/仓库。
- `ci.upload`（临时脚本 `C:/Users/22608/AppData/Local/Temp/taro-upload-miniapp.js`）：上传到后台是**开发版本**，不会自动变体验版；需到公众平台 → 管理 → 版本管理手动设为体验版。
- 当前版本 **1.1.8**，描述「液态玻璃界面与底栏动效、弹窗加透、标题兜底」；下次上传递增到 1.1.9。
- `dist/project.config.json` 默认 `touristappid`，本地导入需换真实 AppID（`wxda700742e96716d0`），真实配置在本机被忽略的 `project.private.config.json`。

### 7.3 真机必测项

- iOS 圆角 + `backdrop-filter` 是否外溢；低端安卓 blur 是否掉帧；暗遮罩上玻璃的亮度。
- 快速连点、动画中切 tab、退场 220ms 与底栏弹回 320ms 的空档是否可接受。
- 四个 tab 页标题、弹窗关闭后底栏是否平滑复现。

---

## 8. 踩坑问题日志（现象 → 错误尝试 → 根因 → 最终方案）

| # | 现象 | 错误尝试 | 根因 | 最终方案 |
| --- | --- | --- | --- | --- |
| 1 | 自定义 tabBar 完全不出现 | 只建 tsx/scss | 缺 `index.config.ts`，产物 `index.json` 为 `{}` | 补 `component: true` 声明 |
| 2 | 弹窗被底栏盖住 | `z-index` 1000 / 1100 往上堆 | 自定义 tabBar 是独立渲染层，页面 z-index 压不住 | overlay 计数器 + 组件条件渲染隐藏底栏 |
| 3 | 弹窗关闭后底栏「闪出来」 | 先 `return null` 卸载（重挂载无过渡）；再试 `opacity:0` 藏（压在遮罩上）；再试 `transition`（独立层失效） | 独立层里 transition 不可靠、卸载无动画 | 状态类 + 关键帧 + 字面曲线，组件始终挂载 |
| 4 | 页面切换整页闪白 | `page-enter-a/b` 用 `useDidShow` 重播 / 固定 class 只播一次 | 每次切 tab 首次挂载都播 `opacity:0→1`，内容先消失再出现 | 彻底移除整页入场，改 `.panel` 从 0.3 显影 |
| 5 | 静态面板首帧发白 | 给 `.panel` 等加 blur 做层级感 | WKWebView 把 `backdrop-filter` 变成异步合成层，首帧出空层；静态面底下无内容，blur 无收益 | 静态面去 blur、保半透明；blur 只留卡片与底栏 |
| 6 | 玻璃观感丢失 | 为修闪白把透明度调到 0.96 近实色 | 误把元凶当成透明度；真正元凶是 blur | 恢复半透明渐变，继续不用 blur |
| 7 | 顶栏标题两个空白 | 检查 config 与产物 json（都是对的） | `switchTab` 时序怪癖，运行时标题竞争 | 四页 `useDidShow` 里 `setNavigationBarTitle` 兜底 |
| 8 | 弹层嵌套层级错乱 | 用布尔标记显隐 | 多弹层叠加时布尔会被提前清零 | `pushOverlay` / `popOverlay` 计数器 |

---

## 9. 验收清单（提交前逐项确认）

- [ ] 新增静态表面没有 `backdrop-filter`；只有真浮层（卡片/底栏）用 blur。
- [ ] 玻璃三层齐全：斜高光 + 暖白半透明 + 亮顶/暗底边。
- [ ] 新增 tab 页有 `index.config.ts` 且 `useDidShow` 发了 select 事件 + 标题兜底。
- [ ] 新增弹层接入 `pushOverlay/popOverlay` 与 `useDismiss`，退场结束才卸载。
- [ ] 没有恢复 `page-enter-*`；页面切换只有 `.panel` 的 `panel-in`。
- [ ] tabBar 动画是关键帧 + 字面曲线，没有回到 `transition` 或 `return null`。
- [ ] `prefers-reduced-motion` 与 `prefers-reduced-transparency` 已覆盖新元素。
- [ ] `npm run build:weapp` 通过，并在 `app-origin.wxss` / `common.wxss` / `custom-tab-bar/index.wxss` 核对到新类名。
- [ ] 真机验证过快速连点、动画中切 tab、弹窗关闭底栏复现、四页标题。

> **体感无法从代码判断时**（空档时长、弹簧手感、blur 掉帧），必须写清验证方式与待确认点，不能只凭代码宣称「没问题」。
