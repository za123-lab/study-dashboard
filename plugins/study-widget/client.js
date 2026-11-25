/**
 * @local/dsh-study-widget —— 学业工作台（client 半边）
 *
 * 在 DSH 右侧栏注册一个「学习进度」标签页，用 iframe 承载 host 提供的
 * /dsh-study-widget/ 页面（桌面上独立的置顶小窗用的是同一个页面）。
 * 这样 Web UI 与桌面窗口共享一份渲染逻辑：数据口径、样式、刷新策略都一致。
 *
 * 注意：本文件**不是** ESM 模块，由宿主模块加载器执行，
 * 必须通过 window.__ModuleLoader__.load({ id, factory }) 注册。
 */
;(() => {
  const PLUGIN_ID = "@local/dsh-study-widget";
  const TAB_ID = "dsh-study-widget";
  const TAB_KIND = "study-widget";
  /** 左栏一级入口的 id，同时是主区 main 槽的 key —— 两处必须逐字一致，否则点开入口会抛错 */
  const PANEL_ID = "dsh-study-widget";
  const ROUTE_PATH = "/dsh-study-widget/";
  const inject = ["slots", "locale"];

  function makeFactory() {
    return function factory(require) {
      const react = require("react");
      const jsxRuntime = require("react/jsx-runtime");
      const h = react.createElement;
      const jsx = jsxRuntime.jsx;
      const jsxs = jsxRuntime.jsxs;

      const LOCALE_NS = "dsh-study-widget";
      const dictZh = {
        tabTitle: "学习进度",
        tabGuide: "查看学业工作台的今日学习、总进度、待办与打卡",
        panelLabel: "学业工作台",
        settings: "设置",
        navData: "进度",
        loading: "正在载入学习数据…",
        refresh: "刷新",
        openDesktop: "桌面小窗",
        openDesktopTip: "在桌面上打开置顶小窗（可一直看着进度）",
        closeDesktop: "关闭小窗",
        openWeb: "网页版",
        openWebTip: "打开学业工作台网页版",
        failed: "载入失败",
        desktopOn: "桌面小窗已开启",
        desktopOff: "桌面小窗未开启",
      };
      const dictEn = {
        tabTitle: "Study progress",
        tabGuide: "Today's study, overall progress, todos and check-ins",
        panelLabel: "Study dashboard",
        settings: "Settings",
        navData: "Progress",
        loading: "Loading study data…",
        refresh: "Refresh",
        openDesktop: "Desktop window",
        openDesktopTip: "Open an always-on-top window on your desktop",
        closeDesktop: "Close window",
        openWeb: "Web app",
        openWebTip: "Open the study dashboard web app",
        failed: "Load failed",
        desktopOn: "Desktop window running",
        desktopOff: "Desktop window closed",
      };

      function localeOf(ctx) {
        const locale = ctx.get("locale");
        if (!locale || typeof locale.bind !== "function") return function (key) {
          return dictZh[key] || key;
        };
        if (typeof locale.register === "function") {
          try {
            locale.register(LOCALE_NS, "zh", dictZh);
            locale.register(LOCALE_NS, "en", dictEn);
          } catch (err) {
            console.warn("[study-widget] locale register failed", err);
          }
        }
        const bind = locale.bind(LOCALE_NS);
        return function (key) {
          try {
            const value = bind(key);
            return typeof value === "string" && value && value !== key ? value : dictZh[key] || key;
          } catch {
            return dictZh[key] || key;
          }
        };
      }

      /** 面板模式使用宿主主题变量，与 DSH 界面保持一致 */
      const PANEL_CSS = `
.sw-panel-host {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  position: relative;
  color: var(--dsw-alias-label-primary, inherit);
  /* 面板外壳也是一块玻璃：铺低饱和环境光，让里面的 iframe 玻璃有东西可透 */
  background:
    linear-gradient(118deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.03) 34%, transparent 58%),
    var(--dsw-alias-bg-layer-1, transparent);
}
.sw-panel-host::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  opacity: 0.5;
  background:
    radial-gradient(42% 38% at 88% 4%, rgba(196, 90, 78, 0.14), transparent 72%),
    radial-gradient(46% 40% at 4% 68%, rgba(88, 128, 174, 0.14), transparent 74%),
    radial-gradient(38% 34% at 62% 100%, rgba(210, 168, 96, 0.14), transparent 72%);
}
.sw-panel-host > * {
  position: relative;
  z-index: 1;
}
.sw-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.25));
  box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.06);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.10), transparent 78%),
    var(--dsw-alias-bg-layer-2, transparent);
  backdrop-filter: blur(18px) saturate(170%);
  -webkit-backdrop-filter: blur(18px) saturate(170%);
  flex: 0 0 auto;
}
.sw-bar-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sw-btn {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3));
  background:
    linear-gradient(118deg, rgba(255, 255, 255, 0.10), transparent 62%),
    var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.6;
  padding: 3px 9px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
}
.sw-btn:hover {
  color: var(--dsw-alias-label-primary, inherit);
  border-color: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.45));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 2px 6px -3px rgba(0, 0, 0, 0.3);
}
.sw-btn:active { transform: scale(0.96); }
.sw-frame {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  border: 0;
  background: transparent;
  display: block;
}
.sw-hint {
  padding: 16px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, inherit);
}
/* 顶栏分段控件：数据页 / 设置页。等宽相连，当前页高亮 */
.sw-seg {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  gap: 2px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3));
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.08));
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.08);
  overflow: hidden;
  flex: 0 0 auto;
}
.sw-seg > button {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 11px;
  line-height: 1.6;
  padding: 2px 10px;
  border-radius: 999px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: background-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
}
.sw-seg > button + button {
  border-left: 0;
}
.sw-seg > button:hover {
  color: var(--dsw-alias-label-primary, inherit);
}
.sw-seg > button[aria-selected="true"] {
  background:
    linear-gradient(160deg, rgba(255, 255, 255, 0.18), transparent 62%),
    var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, 0.16));
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 600;
  box-shadow:
    0 1px 4px -2px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.22);
}
.sw-btn .sw-ic,
.sw-seg .sw-ic {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  display: block;
}
`;

      let cssOwner = null;
      function injectCss(key, text) {
        const existing = document.querySelector('style[data-dsh-study-widget-css="' + key + '"]');
        if (existing) {
          existing.dataset.refs = String(Number(existing.dataset.refs || "0") + 1);
          return function () {
            const refs = Number(existing.dataset.refs || "1") - 1;
            existing.dataset.refs = String(Math.max(refs, 0));
            if (refs <= 0) existing.remove();
          };
        }
        const style = document.createElement("style");
        style.dataset.dshStudyWidgetCss = key;
        style.dataset.refs = "1";
        style.textContent = text;
        document.head.appendChild(style);
        return function () {
          const refs = Number(style.dataset.refs || "1") - 1;
          style.dataset.refs = String(Math.max(refs, 0));
          if (refs <= 0) style.remove();
        };
      }

      function routeUrl() {
        const base = typeof document === "undefined" ? "" : document.baseURI || "";
        let prefix = "";
        try {
          const url = new URL(base);
          if (url.protocol === "http:" || url.protocol === "https:") prefix = url.pathname.replace(/\/+$/, "");
        } catch {
          prefix = "";
        }
        return prefix + ROUTE_PATH;
      }

      /** 顶栏小图标：一律内联 SVG、跟随 currentColor，不用 emoji */
      function barIcon(path, size) {
        return h(
          "svg",
          {
            className: "sw-ic",
            width: size || 12,
            height: size || 12,
            viewBox: "0 0 24 24",
            fill: "none",
            "aria-hidden": "true",
            focusable: "false",
          },
          path
        );
      }
      const ICON_PIN = [
        h("path", { key: "a", d: "M15 3.8 20.2 9l-3.1.8-3.4 3.4-.5 3.9-1.6 1.6-6.9-6.9 1.6-1.6 3.9-.5L14.2 6 15 3.8Z", stroke: "currentColor", strokeWidth: "1.6", strokeLinejoin: "round" }),
        h("path", { key: "b", d: "M9.2 14.8 4 20", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" }),
      ];
      const ICON_REFRESH = [
        h("path", { key: "a", d: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round" }),
        h("path", { key: "b", d: "M19.6 4.2v4.4h-4.4", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round" }),
      ];
      const ICON_GEAR = [
        h("circle", { key: "a", cx: "12", cy: "12", r: "3.1", stroke: "currentColor", strokeWidth: "1.6" }),
        h("path", {
          key: "b",
          d: "M12 3.3v2.1M12 18.6v2.1M4.7 7.9l1.8 1M17.5 15.1l1.8 1M4.7 16.1l1.8-1M17.5 8.9l1.8-1",
          stroke: "currentColor",
          strokeWidth: "1.6",
          strokeLinecap: "round",
        }),
      ];
      const ICON_CHART = [
        h("path", { key: "a", d: "M4 19.5h16", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round" }),
        h("path", { key: "b", d: "M7 16V11M12 16V6.5M17 16v-3", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round" }),
      ];

      function makePanel(ctx, t) {
        return function StudyWidgetPanel() {
          const frameRef = react.useRef(null);
          const [nonce, setNonce] = react.useState(0);
          /** "data" = 学习数据页， "settings" = 设置页；同一 iframe 内切换，不新开窗口 */
          const [view, setView] = react.useState("data");
          react.useEffect(
            function () {
              if (cssOwner === null) cssOwner = injectCss("panel", PANEL_CSS);
              return function () {
                if (cssOwner) {
                  cssOwner();
                  cssOwner = null;
                }
              };
            },
            []
          );
          const base = routeUrl();
          const src =
            view === "settings"
              ? base + "settings?v=" + nonce
              : base + "?mode=panel&v=" + nonce;
          const title = view === "settings" ? t("settings") : t("tabTitle");
          return jsxs("div", {
            className: "sw-panel-host",
            children: [
              jsxs("div", {
                className: "sw-bar",
                children: [
                  jsx("span", { className: "sw-bar-title", children: title }),
                  jsxs("div", {
                    className: "sw-seg",
                    role: "tablist",
                    "aria-label": t("panelLabel"),
                    children: [
                      jsx("button", {
                        type: "button",
                        role: "tab",
                        "aria-selected": view === "data" ? "true" : "false",
                        onClick: function () {
                          setView("data");
                        },
                        children: [barIcon(ICON_CHART), t("navData")],
                      }),
                      jsx("button", {
                        type: "button",
                        role: "tab",
                        "aria-selected": view === "settings" ? "true" : "false",
                        onClick: function () {
                          setView("settings");
                        },
                        children: [barIcon(ICON_GEAR), t("settings")],
                      }),
                    ],
                  }),
                  view === "data"
                    ? jsx("button", {
                        type: "button",
                        className: "sw-btn",
                        title: t("openDesktopTip"),
                        onClick: function () {
                          const frame = frameRef.current;
                          if (frame && frame.contentWindow) {
                            frame.contentWindow.postMessage({ type: "study-widget:open-desktop" }, "*");
                          }
                        },
                        children: [barIcon(ICON_PIN), t("openDesktop")],
                      })
                    : null,
                  jsx("button", {
                    type: "button",
                    className: "sw-btn",
                    title: t("refresh"),
                    onClick: function () {
                      setNonce(function (n) {
                        return n + 1;
                      });
                    },
                    children: [barIcon(ICON_REFRESH), t("refresh")],
                  }),
                ],
              }),
              jsx("iframe", {
                ref: frameRef,
                className: "sw-frame",
                title: title,
                src: src,
                allow: "clipboard-read; clipboard-write",
              }),
            ],
          });
        };
      }

      /** 左栏一级入口的图标：16px 时给 16，收起态给 18；跟随 currentColor 与主题 */
      function StudyPanelIcon(props) {
        const size = props && Number(props.size) > 0 ? Number(props.size) : 16;
        return h(
          "svg",
          {
            width: size,
            height: size,
            viewBox: "0 0 24 24",
            fill: "none",
            "aria-hidden": "true",
            focusable: "false",
          },
          h("path", {
            d: "M4 19.5V5.5A1.5 1.5 0 0 1 5.5 4H13v16H5.5A1.5 1.5 0 0 0 4 21.5",
            stroke: "currentColor",
            strokeWidth: "1.7",
            strokeLinejoin: "round",
          }),
          h("path", {
            d: "M13 4h5.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H13",
            stroke: "currentColor",
            strokeWidth: "1.7",
            strokeLinejoin: "round",
          }),
          h("path", {
            d: "M6.5 9.5h4M6.5 13h4M15.5 8.5h2M15.5 12h2",
            stroke: "currentColor",
            strokeWidth: "1.5",
            strokeLinecap: "round",
          })
        );
      }

      function apply(ctx) {
        const t = localeOf(ctx);
        const Panel = makePanel(ctx, t);
        // 左栏一级入口 + 主区整页（设置页）：两边用同一个 PANEL_ID 寻址
        ctx.effect(
          function () {
            const disposeMain = ctx.slots.inject("main", function* () {
              yield ctx.slots.register(
                {
                  name: "main",
                  key: PANEL_ID,
                  locale: LOCALE_NS,
                },
                function MainPanel() {
                  return h(Panel, {});
                }
              );
            });
            const disposeEntry = ctx.slots.inject("sidebar.panellist", function* () {
              yield ctx.slots.register(
                {
                  name: "sidebar.panellist",
                  id: PANEL_ID,
                  order: 30,
                  locale: LOCALE_NS,
                  label: function () {
                    return t("panelLabel");
                  },
                },
                StudyPanelIcon
              );
            });
            return function () {
              try {
                disposeEntry && disposeEntry();
              } catch {
                /* 忽略 */
              }
              try {
                disposeMain && disposeMain();
              } catch {
                /* 忽略 */
              }
            };
          },
          "study-widget: left panel entry"
        );
        ctx.effect(
          function () {
            const tabs = ctx.get("sidebarRightTabs");
            if (!tabs || typeof tabs.register !== "function") {
              console.warn("[study-widget] 右侧栏不可用：没有 sidebarRightTabs 服务，学习进度标签页未注册");
              return function () {};
            }
            const disposeType = tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: "extension",
              title: function () {
                return t("tabTitle");
              },
              guide: [
                {
                  id: TAB_KIND,
                  order: 420,
                  title: function () {
                    return t("tabTitle");
                  },
                  description: function () {
                    return t("tabGuide");
                  },
                  icon: function () {
                    return h("img", {
                      src: routeUrl() + "icon.png",
                      alt: "",
                      style: { width: "100%", height: "100%", objectFit: "contain" },
                    });
                  },
                },
              ],
            });
            const disposeSlot = ctx.slots.inject("sidebar.right.pane.tab", function* () {
              yield ctx.slots.register(
                {
                  name: "sidebar.right.pane.tab",
                  key: TAB_ID,
                  order: 120,
                },
                function () {
                  return h(Panel, {});
                }
              );
            });
            return function () {
              try {
                disposeSlot && disposeSlot();
              } catch {
                /* 忽略 */
              }
              disposeType();
            };
          },
          "study-widget: sidebar tab"
        );
      }

      return { apply, inject, name: PLUGIN_ID };
    };
  }

  window.__ModuleLoader__.load({ id: PLUGIN_ID, factory: makeFactory() });
})();
