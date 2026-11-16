# 08 · 动效开发规范

> 适用两端：Web 版（`index.html` / `style.css` / `app.js`）与微信小程序（`miniapp/`，Taro + React）。
> 这份规范是**强制审查清单**，不是灵感参考。新增或修改任何动画前先过「门禁」，交付时按文末格式自查。

## 1. 先回答四个问题（门禁）

| 顺序 | 问题 | 判定 |
| --- | --- | --- |
| 1 | **该不该动？** | 键盘快捷键、命令面板、tab 切换这类高频操作**不加动画**；模态/抽屉/吐司偶尔出现，标准动画；引导/成功/庆祝罕见，可加 delight。 |
| 2 | **目的是什么？** | 空间一致性、状态指示、解释因果、反馈、避免突兀跳变。只写「好看」且高频出现 → 删掉。 |
| 3 | **哪种缓动？** | 进场/退场 `ease-out`；屏上移动/变形 `ease-in-out`；颜色/悬停 `ease`；匀速进度 `linear`。**禁止 `ease-in`**（起步慢，恰是用户紧盯的瞬间）。 |
| 4 | **多快？** | UI 动效一律 **< 300ms**。按压 100–160ms；提示/小弹层 125–200ms；下拉/选择 150–250ms；模态/抽屉 200–500ms。 |

**频率档速查**：高频（tab 切换、列表滚动、键盘）→ 不动或几乎不可见；中频（折叠面板、下拉）→ 150–250ms；低频（弹窗、吐司）→ 标准动画。

## 2. 十条不可妥协标准

1. **动机正当**——高频元素不能用「好看」当理由。
2. **频率适配**——键盘触发的动作一律不动画。
3. **响应式缓动**——进场/退场用 `ease-out` 或强曲线，禁用 `ease-in`。
4. **UI < 300ms**——超时必须在代码注释里写理由。
5. **原点与物理正确**——弹层从触发点缩放，绝不 `scale(0)`（模态居中豁免）；从 `scale(0.95) + opacity:0` 起。
6. **可中断**——高频/手势动效用 `transition` 或弹簧，不用 `keyframes` 反复重启。
7. **仅 GPU 属性**——只动 `transform` / `opacity`（`clip-path` 例外）；不动宽高/边距/`all`。
8. **无障碍**——`prefers-reduced-motion` 随动画一并交付（更轻柔，而非清零）；悬停动效用 `@media (hover: hover) and (pointer: fine)` 门控。
9. **非对称进出**——人主动触发的动作稍慢，系统响应要快（退场比进场短）。
10. **整体协调**——不确定时「删掉它」最稳。

### 项目缓动 token

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);      /* 进场默认 */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);  /* 屏上移动 */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);    /* 抽屉 */
```

不要平行新建一套 token；复用现有变量，扩展而非分叉。

## 3. Web 版实现约定

### 3.1 弹层：必须走统一开关

**唯一入口**：`app.js` 顶部 `openModal(node)` / `closeModal(node, afterClose)`。

- `openModal`：取消待执行的关闭定时器 → `hidden = false` → `void node.offsetWidth` 强制回流 → 加 `.is-open`。
- `closeModal`：移除 `.is-open` → 200ms 后 `hidden = true` → 再执行 `afterClose`（表单 reset 等）。
- 退场中的判断一律用 `.is-open`，**不能用 `.hidden`**——退场期间 `hidden` 仍为 `false`，用它判断会导致 ESC 重复处理、表单被提前清空。
- 新弹层必须复用这套封装，禁止直接写 `el.xxx.hidden = true/false`。

CSS 配套（`.modal` / `.modal-backdrop` / `.modal-card`）：

- 容器 `.modal` 默认 `pointer-events: none`，`.is-open` 时 `auto`——退场期间不拦截点击。
- 遮罩与卡片都用 `transition`，不用只有进场的 `animation`。
- 卡片 `opacity: 0` + `translateY(10px) scale(0.96)` → `none`，200ms `ease-out`，可随时中断。

### 3.2 页面切换：入场只播一次

根因：`display: none → block` 会**重置** CSS animation。视图里的 `.reveal` / `.course` 带 `animation: rise 0.6s both`（含 0.04–0.22s 交错 delay），每次切 tab 都会重演整段，表现为「一闪一闪」。

约定：

- 入场动画只属于**首次加载**。切进视图时 `settleReveals(view)` 把内部 `.reveal` / `.course` 的 `animation` 置为 `none`。
- 视图自身用 `.is-entering` + `viewIn` 160ms 短淡入（remove class → 强制回流 → add class 以重播）。
- 新增带入场动画的区块时，如果它会被 `hidden` 切换，必须同步纳入 `settleReveals()`。

### 3.3 其他

- 禁止 `transition: all`，一律写具体属性。
- 进度条宽度优先 `transform: scaleX()`；若沿用 `width` 过渡，需在评审里说明理由。
- `prefers-reduced-motion` 保留淡入淡出、去掉位移/缩放，不把时长清零。
- 修改 CSS 后同步 `index.html` 里 `style.css` 与 `app.js` 的缓存版本号（两处必须一致）。

## 4. 小程序实现约定

> 本节只讲动效时序。材质、层级、tabBar 独立渲染层、发布与踩坑日志见 [09 小程序界面与交互开发规范](09-miniprogram-ui-standards.md)。

### 4.1 页面切换：不做整页入场，只做「玻璃显影」

**已彻底移除 `usePageEnter()`**（含 `page-enter-a/b` keyframes 与四页的 `enterCls`），不要以任何形式恢复。

- 根因：tab 切换属中频导航，`opacity:0→1` 在每次切 tab（首次挂载）时都重播，内容先消失再出现 = 「闪」；原生 `UITabBarController` 就是瞬时切换。
- 替代：`.panel` 用 `panel-in` 260ms `--ease-out` `both`，`from { opacity: .3; translateY(5px) }`。起始 0.3 而非 0——面板始终隐约可见，是「材质显影」不是「内容消失」。只在 tab 首次挂载播放，背景/标题/底栏始终稳定。
- **禁止**用 `useDidShow` 递增 phase 交替 class 来重播入场。

### 4.2 弹层退场：`useDismiss` + 内部 closing 态

- `src/data/motion.ts` 的 `useDismiss(onClose)` 统一处理：先 `setClosing(true)`，220ms 后才调 `onClose`。
- **绝对不要动父页面的条件渲染**，也不要改 `src/data/overlay.ts` 的 overlay 计数——层级/计数已反复调整过多轮。
- Sheet / DayDetail / PromptHost 内部用 `closing` 加 `mask-closing` / `card-closing` 播退场，动画结束才真正卸载。
- 退场期间 overlay 保持、底栏继续隐藏；这是有意为之（见 4.3）。

### 4.3 底栏：状态类 + 关键帧，不用 transition、不卸载

根因：微信自定义 tabBar 在**独立渲染层**——`z-index` 压不住、`transition` 不可靠、`return null` 重挂载无过渡、`opacity:0` 又会压在遮罩上方。四条路都踩过。

- 组件**始终挂载**，靠 `hidden` 切换 `.tabbar-shown` / `.tabbar-hidden` 两个状态类。
- 动画用**关键帧 + 字面曲线**：`.tabbar-shown` = `tabbar-up 320ms cubic-bezier(.32,.72,0,1) both`，`.tabbar-hidden` = `tabbar-down 260ms` 同曲线。keyframes 内写 `opacity` + `translateY(130%)` + `visibility`，`both` 保持终态；曲线直接写字面值，不依赖 CSS 变量。
- 时序：弹窗退场 220ms → 底栏弹回 320ms（先下后上的连续动线）。
- `prefers-reduced-motion` 降级为 `tabbar-fade` / `tabbar-fade-out` 160ms 纯淡入淡出。

### 4.4 时长对照表

| 动效 | 进场 | 退场 | 备注 |
| --- | --- | --- | --- |
| Sheet / DayDetail 卡片 | `sheet-up` 320ms | `sheet-down` 220ms | 退场更快，系统响应利落；进场从 `scale(.985)` 起 |
| 遮罩 | `glass-mask` 180ms | `mask-out` 200ms | 与退场错开 20ms |
| 面板显影（页面切换） | `panel-in` 260ms | — | `opacity .3→1`，只首次挂载播 |
| 底栏 | `tabbar-up` 320ms | `tabbar-down` 260ms | 状态类 + 关键帧，独立层不用 transition |
| 勾选反馈 | `check-pop` 260ms | — | 260ms ease-drawer 带回弹 |
| reduced-motion | 140–180ms 纯淡入 | 140–160ms 纯淡出 | 去掉位移与缩放 |

## 5. 审查输出格式（强制）

审查动效代码时，必须用三列表格，一行一个 issue：

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: transform 200ms ease-out` | 指定精确属性，避免带动非 GPU 属性 |
| `transform: scale(0)` | `transform: scale(0.95); opacity: 0` | 现实中没有东西凭空出现 |
| 下拉菜单 `ease-in` | `ease-out` + 自定义曲线 | `ease-in` 起步慢，显得迟钝 |
| 按钮无 `:active` | `:active { transform: scale(0.97) }` | 按钮必须对手指有响应 |
| `animation: rise` 随 `hidden` 重播 | JS 收掉 + 160ms 短淡入 | display 切换会重置 animation |

## 6. 验收清单

提交前逐项确认：

- [ ] 每个动画都能回答「为什么动」，高频动作没有动画；
- [ ] 进场/退场是 `ease-out`，没有 `ease-in`；
- [ ] UI 动效 < 300ms，超时有注释说明；
- [ ] 弹层不是 `scale(0)`，从 `0.95` 起；
- [ ] 弹层有完整退场，退场结束才卸载/隐藏；
- [ ] 只用 `transform` / `opacity`，没有 `all`、宽高过渡；
- [ ] `prefers-reduced-motion` 已处理（更轻柔，不清零）；
- [ ] Web 版改 CSS 后同步了两个缓存版本号；
- [ ] 小程序改了动画后 `npm run build:weapp` 通过，并核对产物含新类名；
- [ ] 真机 2–5× 慢放或逐帧看过：快速连点、动画中切 tab、低端机是否掉帧。

**体感无法从代码判断时**（交叉淡入、弹簧 bounce、退场与底栏淡入的空档），必须明确写出验证方式与待确认点，不能只凭代码宣称「没问题」。
