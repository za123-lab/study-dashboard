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
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.sw-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25));
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
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.6;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.sw-btn:hover { color: var(--dsw-alias-label-primary, inherit); }
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

      function makePanel(ctx, t) {
        return function StudyWidgetPanel() {
          const frameRef = react.useRef(null);
          const [nonce, setNonce] = react.useState(0);
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
          const src = routeUrl() + "?mode=panel&v=" + nonce;
          return jsxs("div", {
            className: "sw-panel-host",
            children: [
              jsxs("div", {
                className: "sw-bar",
                children: [
                  jsx("span", { className: "sw-bar-title", children: t("tabTitle") }),
                  jsx("button", {
                    type: "button",
                    className: "sw-btn",
                    title: t("openDesktopTip"),
                    onClick: function () {
                      const frame = frameRef.current;
                      if (frame && frame.contentWindow) {
                        frame.contentWindow.postMessage({ type: "study-widget:open-desktop" }, "*");
                      }
                    },
                    children: "📌 " + t("openDesktop"),
                  }),
                  jsx("button", {
                    type: "button",
                    className: "sw-btn",
                    onClick: function () {
                      setNonce(function (n) {
                        return n + 1;
                      });
                    },
                    children: t("refresh"),
                  }),
                ],
              }),
              jsx("iframe", {
                ref: frameRef,
                className: "sw-frame",
                title: t("tabTitle"),
                src: src,
                allow: "clipboard-read; clipboard-write",
              }),
            ],
          });
        };
      }

      function apply(ctx) {
        const t = localeOf(ctx);
        const Panel = makePanel(ctx, t);
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
