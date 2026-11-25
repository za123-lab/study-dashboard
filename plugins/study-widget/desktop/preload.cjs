/** 把宿主可用的桌面能力暴露给小组件页面（只暴露这几个，不做通配）。 */
const { contextBridge, ipcRenderer, nativeTheme } = require("electron");

/**
 * 读当前真实主题。
 *
 * 这里必须**每次实时读**，不能像以前那样在 preload 顶层算一次快照：
 *   1. 快照会把加载那一刻的结果冻住，系统切深浅色后页面拿到的永远是旧值
 *      （"小窗不跟随系统"就是这么来的）；
 *   2. 旧的 catch 兜底是硬编码深色——只要读不到，浅色系统也会被画成深色。
 *
 * 取值优先级：
 *   a. sendSync 问主进程（最权威：主进程才知道 themeSource 和系统实际深浅）
 *   b. preload 里自己能拿到的 nativeTheme
 *   c. 都拿不到返回 null，交给页面用 matchMedia(prefers-color-scheme) 兜底，
 *      让"跟随系统"真的跟随系统，而不是退化成某个写死的颜色。
 */
function readTheme() {
  try {
    const fromMain = ipcRenderer.sendSync("study-widget:get-theme-sync");
    if (fromMain && typeof fromMain.light === "boolean") return fromMain;
  } catch {
    /* 主进程还没注册这个通道，往下退 */
  }
  try {
    const dark = !!nativeTheme.shouldUseDarkColors;
    return { light: !dark, dark: dark, source: "native" };
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld("studyWidget", {
  /** 首帧主题：同步值（不返回 Promise）。读不到返回 null。 */
  getTheme: function () {
    return readTheme();
  },
  // 系统切换主题后主进程会推一条；页面同时自己监听 matchMedia 兜底
  onThemeChanged: function (cb) {
    const listener = function (_e, theme) {
      cb(theme);
    };
    ipcRenderer.on("study-widget:theme-changed", listener);
    return function () {
      ipcRenderer.removeListener("study-widget:theme-changed", listener);
    };
  },
  minimize: function () {
    return ipcRenderer.invoke("study-widget:minimize");
  },
  // 隐藏窗口：不销毁、不退出，下次唤醒仍在原位置
  hide: function () {
    return ipcRenderer.invoke("study-widget:hide");
  },
  close: function () {
    return ipcRenderer.invoke("study-widget:close");
  },
  togglePin: function () {
    return ipcRenderer.invoke("study-widget:toggle-pin");
  },
  // 显式设置置顶；resolve 的是设置后的真实状态
  setAlwaysOnTop: function (on) {
    return ipcRenderer.invoke("study-widget:set-always-on-top", !!on);
  },
  isPinned: function () {
    return ipcRenderer.invoke("study-widget:is-pinned");
  },
  // 无边框窗口自己实现拖动：用窗口偏移量跟着鼠标走，跨显示器/缩放都准
  moveBy: function (dx, dy) {
    return ipcRenderer.invoke("study-widget:move-by", dx, dy);
  },
  moveState: function (active) {
    return ipcRenderer.invoke("study-widget:move-state", !!active);
  },
  getBounds: function () {
    return ipcRenderer.invoke("study-widget:get-bounds");
  },
  resize: function (w, h) {
    return ipcRenderer.invoke("study-widget:resize", w, h);
  },
  // 主进程只放行 http/https，其它协议直接忽略
  shellOpen: function (url) {
    return ipcRenderer.invoke("study-widget:shell-open", String(url == null ? "" : url));
  },
  openExternal: function (url) {
    return ipcRenderer.invoke("study-widget:open-external", url);
  },
  contextMenu: function () {
    return ipcRenderer.invoke("study-widget:context-menu");
  },
  onRefresh: function (cb) {
    const listener = function () {
      cb();
    };
    ipcRenderer.on("study-widget:refresh", listener);
    return function () {
      ipcRenderer.removeListener("study-widget:refresh", listener);
    };
  },
  onPinnedChanged: function (cb) {
    const listener = function (_e, pinned) {
      cb(pinned);
    };
    ipcRenderer.on("study-widget:pinned-changed", listener);
    return function () {
      ipcRenderer.removeListener("study-widget:pinned-changed", listener);
    };
  },
});
