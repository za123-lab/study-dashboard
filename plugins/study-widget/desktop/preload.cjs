/** 把宿主可用的桌面能力暴露给小组件页面（只暴露这几个，不做通配）。 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("studyWidget", {
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
