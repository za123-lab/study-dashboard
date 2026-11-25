/**
 * Electron 端：一个无边框、置顶、透明的桌面小组件窗口。
 *
 * 由 lib/desktop.js 拉起，通过环境变量接收参数：
 *   DSH_STUDY_WIDGET_URL        要加载的页面（宿主 webServer 的 /dsh-study-widget/）
 *   DSH_STUDY_WIDGET_BOUNDS     JSON {x,y,width,height}，上次关窗时的位置
 *   DSH_STUDY_WIDGET_STATE_FILE 关窗时把位置写回这里
 *   DSH_STUDY_WIDGET_ICON       图标（可选）
 *
 * 右键菜单 / 拖拽 / 置顶都在页面里通过 preload 暴露的 window.studyWidget 调用。
 */
const { app, BrowserWindow, ipcMain, Menu, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const URL_TO_LOAD = process.env.DSH_STUDY_WIDGET_URL || "";
const STATE_FILE = process.env.DSH_STUDY_WIDGET_STATE_FILE || "";
const ICON = process.env.DSH_STUDY_WIDGET_ICON || "";

const DEFAULT_SIZE = { width: 380, height: 640 };
let win = null;

function readBounds() {
  const raw = process.env.DSH_STUDY_WIDGET_BOUNDS;
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) return b;
  } catch {
    /* 忽略坏数据 */
  }
  return null;
}

function clampToDisplay(b) {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.max(280, b.width), Math.max(320, area.width));
  const height = Math.min(Math.max(240, b.height), Math.max(320, area.height));
  const maxX = area.x + area.width - 40;
  const maxY = area.y + area.height - 40;
  const x = Number.isFinite(b.x) ? Math.min(Math.max(b.x, area.x - width + 80), maxX) : area.x + area.width - width - 24;
  const y = Number.isFinite(b.y) ? Math.min(Math.max(b.y, area.y - 40), maxY) : area.y + 72;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function saveBounds() {
  if (!win || !STATE_FILE || win.isDestroyed()) return;
  const b = win.getBounds();
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(b, null, 2), "utf8");
  } catch {
    /* 写不进去就算了，下次用默认位置 */
  }
}

function createWindow() {
  const saved = readBounds();
  const bounds = clampToDisplay(saved || DEFAULT_SIZE);

  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 280,
    minHeight: 240,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: true,
    fullscreenable: false,
    maximizable: false,
    title: "学业工作台",
    ...(ICON && fs.existsSync(ICON) ? { icon: ICON } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, "floating");
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  } catch {
    /* 非 macOS 会抛，忽略 */
  }
  try {
    win.setSkipTaskbar(true);
  } catch {
    /* 忽略 */
  }

  win.once("ready-to-show", function () {
    console.log("[study-widget] ready-to-show bounds", JSON.stringify(win.getBounds()));
    win.showInactive();
  });
  win.webContents.on("render-process-gone", function (_e, d) {
    console.error("renderer gone", JSON.stringify(d));
  });
  win.webContents.setWindowOpenHandler(function (details) {
    // 课程链接用系统浏览器打开，别在小组件里跳走
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url);
    return { action: "deny" };
  });
  win.on("close", saveBounds);
  win.on("closed", function () {
    win = null;
  });
  win.webContents.on("did-fail-load", function (_e, code, desc) {
    console.error("load failed", code, desc);
  });
  win.loadURL(URL_TO_LOAD || "about:blank");
}

ipcMain.handle("study-widget:minimize", function () {
  if (win && !win.isDestroyed()) win.hide();
  return true;
});

ipcMain.handle("study-widget:close", function () {
  if (win && !win.isDestroyed()) win.close();
  return true;
});

ipcMain.handle("study-widget:toggle-pin", function () {
  if (!win || win.isDestroyed()) return false;
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next, next ? "floating" : "normal");
  return next;
});

ipcMain.handle("study-widget:is-pinned", function () {
  return !!(win && !win.isDestroyed() && win.isAlwaysOnTop());
});

let dragging = null;

ipcMain.handle("study-widget:move-state", function (_e, active) {
  if (!win || win.isDestroyed()) return false;
  dragging = active ? { x: win.getBounds().x, y: win.getBounds().y } : null;
  return !!dragging;
});

ipcMain.handle("study-widget:move-by", function (_e, dx, dy) {
  if (!win || win.isDestroyed() || !dragging) return false;
  const nx = Math.round(dragging.x + (Number(dx) || 0));
  const ny = Math.round(dragging.y + (Number(dy) || 0));
  win.setPosition(nx, ny, false);
  return true;
});

ipcMain.handle("study-widget:get-bounds", function () {
  if (!win || win.isDestroyed()) return null;
  return win.getBounds();
});

ipcMain.handle("study-widget:resize", function (_e, w, h) {
  if (!win || win.isDestroyed()) return false;
  const nw = Math.round(Number(w) || DEFAULT_SIZE.width);
  const nh = Math.round(Number(h) || DEFAULT_SIZE.height);
  const cur = win.getBounds();
  win.setBounds(clampToDisplay({ x: cur.x, y: cur.y, width: nw, height: nh }));
  saveBounds();
  return true;
});

ipcMain.handle("study-widget:open-external", function (_e, url) {
  if (typeof url === "string" && /^https?:/i.test(url)) shell.openExternal(url);
  return true;
});

ipcMain.handle("study-widget:context-menu", function (event) {
  if (!win || win.isDestroyed()) return false;
  const pinned = win.isAlwaysOnTop();
  const menu = Menu.buildFromTemplate([
    {
      label: "置顶显示",
      type: "checkbox",
      checked: pinned,
      click: function () {
        win.setAlwaysOnTop(!win.isAlwaysOnTop(), "floating");
        win.webContents.send("study-widget:pinned-changed", win.isAlwaysOnTop());
      },
    },
    {
      label: "刷新数据",
      click: function () {
        win.webContents.send("study-widget:refresh");
      },
    },
    { type: "separator" },
    {
      label: "打开网页版工作台",
      click: function () {
        shell.openExternal("https://glebah23.github.io/study-dashboard/");
      },
    },
    {
      label: "隐藏窗口",
      click: function () {
        win.hide();
      },
    },
    {
      label: "退出小组件",
      click: function () {
        win.close();
      },
    },
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
  return true;
});

if (!app.requestSingleInstanceLock()) {
  // 第二次启动：把已有窗口唤到前面（最小化的也显示出来）
  app.quit();
} else {
  app.on("second-instance", function () {
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.showInactive();
      win.setAlwaysOnTop(true, "floating");
    }
  });
  process.on("uncaughtException", function (err) {
    console.error("[study-widget] uncaught", err && err.stack ? err.stack : err);
  });
  app.whenReady().then(function () {
    app.setName("Study Widget");
    console.log("[study-widget] electron", process.versions.electron, "pid", process.pid);
    if (process.platform === "win32") {
      try {
        app.setAppUserModelId("com.dsh.study-widget");
      } catch {
        /* 忽略 */
      }
    }
    createWindow();
  });
  app.on("window-all-closed", function () {
    app.quit();
  });
}
