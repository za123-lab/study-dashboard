/**
 * Electron 端：一个无边框、置顶、透明的桌面小组件窗口。
 *
 * 由 lib/desktop.js 拉起，通过环境变量接收参数：
 *   DSH_STUDY_WIDGET_URL          要加载的页面（宿主 webServer 的 /dsh-study-widget/）
 *   DSH_STUDY_WIDGET_SETTINGS_URL 设置页地址（可选）：带 --settings 启动时加载它
 *   DSH_STUDY_WIDGET_BOUNDS       JSON {x,y,width,height}，上次关窗时的位置
 *   DSH_STUDY_WIDGET_STATE_FILE   关窗/拖动时把位置写回这里
 *   DSH_STUDY_WIDGET_ICON         图标（可选）
 *   DSH_STUDY_WIDGET_PINNED       初始置顶态 "1"/"0"（可选，缺省 1；Host 用 settings.json 的 desktop.alwaysOnTop 传）
 *   DSH_STUDY_WIDGET_THEME        外观 "system"/"dark"/"light"（可选，缺省 system；与设置页「外观」分区同一个值）
 *
 * 液态玻璃：
 *   Windows 11 (build >= 22000) 且主题为 system 时，窗口背景用原生 acrylic（backgroundMaterial），
 *   页面再画一层自己的玻璃；强制深/浅时关掉原生材质，避免系统亚克力与页面主题打架。
 *   其它平台/老系统走纯透明窗口，玻璃完全由页面 CSS 负责。
 *
 * 命令行：
 *   --settings（或 --relaunch-settings）  同一个窗口改载设置页，不新开窗口
 *
 * 右键菜单 / 拖拽 / 置顶都在页面里通过 preload 暴露的 window.studyWidget 调用。
 */
const { app, BrowserWindow, ipcMain, Menu, nativeTheme, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const URL_TO_LOAD = process.env.DSH_STUDY_WIDGET_URL || "";
const SETTINGS_URL = process.env.DSH_STUDY_WIDGET_SETTINGS_URL || "";
const STATE_FILE = process.env.DSH_STUDY_WIDGET_STATE_FILE || "";
const ICON = process.env.DSH_STUDY_WIDGET_ICON || "";
const PINNED_ENV = process.env.DSH_STUDY_WIDGET_PINNED || "";
// 主题：跟随系统（默认）或被 DSH 设置页强制 dark/light。页面侧也会读同一个值，不会出现壳与内容两种主题。
const THEME_ENV = (process.env.DSH_STUDY_WIDGET_THEME || "system").trim().toLowerCase();

// Windows 11 (build >= 22000) 支持原生亚克力材质；其它平台退回纯透明 + 页面自己的玻璃
const IS_WIN11 =
  process.platform === "win32" && Number(String(require("node:os").release()).split(".")[2] || 0) >= 22000;

function resolveThemeSource() {
  if (THEME_ENV === "dark" || THEME_ENV === "light") return THEME_ENV;
  return "system";
}

const DEFAULT_SIZE = { width: 380, height: 640 };
const TITLE = "学业工作台";
const TITLE_SETTINGS = "学业工作台 · 设置";
// 拖动/缩放会高频触发 move，合并成一次写盘；关闭窗口时先冲刷，位置不会丢
const MOVE_SAVE_DELAY = 400;

let win = null;

function isSettingsFlag(arg) {
  return arg === "--settings" || arg === "--relaunch-settings";
}

function hasSettingsFlag(argv) {
  return Array.isArray(argv) && argv.slice(1).some(isSettingsFlag);
}

/** 初始置顶态：DSH_STUDY_WIDGET_PINNED 为 0/false/off 时关闭置顶；其它（含未传）保持原来的 true */
function readInitialPinned() {
  const raw = String(PINNED_ENV).trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  if (raw && raw !== "1" && raw !== "true" && raw !== "on" && raw !== "yes") {
    console.error("[study-widget] ignore bad DSH_STUDY_WIDGET_PINNED", JSON.stringify(PINNED_ENV));
  }
  return true;
}

// ready 之前就要决定加载哪个页面 / 初始置顶态
let settingsMode = hasSettingsFlag(process.argv);
let initialPinned = readInitialPinned();

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

/** 只认 http/https：javascript:、file:、ms-*: 之类一律拒绝 */
function isSafeExternalUrl(url) {
  if (typeof url !== "string") return false;
  const text = url.trim();
  if (!text || text.length > 4096) return false;
  // 控制字符（含换行）可以拿来截断/伪装 URL，直接拒绝
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 0x20) return false;
  }
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function openExternalSafe(url, tag) {
  if (!isSafeExternalUrl(url)) {
    console.error("[study-widget] reject external url", tag || "", JSON.stringify(String(url).slice(0, 200)));
    return false;
  }
  try {
    const pending = shell.openExternal(url.trim());
    if (pending && typeof pending.catch === "function") {
      pending.catch(function (err) {
        console.error("[study-widget] openExternal failed", tag || "", err && err.message ? err.message : err);
      });
    }
    return true;
  } catch (err) {
    console.error("[study-widget] openExternal threw", tag || "", err && err.message ? err.message : err);
    return false;
  }
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

/** window.json 是唯一的位置真相：close / 拖动结束 / resize / hide / 退出前都走这里 */
function saveBounds() {
  if (!win || !STATE_FILE || win.isDestroyed()) return false;
  let b = null;
  try {
    b = win.getBounds();
  } catch (err) {
    console.error("[study-widget] getBounds failed", err && err.message ? err.message : err);
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(b, null, 2), "utf8");
    return true;
  } catch (err) {
    // 写不进去就算了，下次用默认位置；但要在 stderr 里留痕
    console.error("[study-widget] saveBounds failed", err && err.message ? err.message : err);
    return false;
  }
}

let moveSaveTimer = null;

function scheduleSaveBounds() {
  if (moveSaveTimer) return;
  moveSaveTimer = setTimeout(function () {
    moveSaveTimer = null;
    saveBounds();
  }, MOVE_SAVE_DELAY);
  if (moveSaveTimer && typeof moveSaveTimer.unref === "function") moveSaveTimer.unref();
}

function flushPendingSave() {
  if (!moveSaveTimer) return;
  clearTimeout(moveSaveTimer);
  moveSaveTimer = null;
  saveBounds();
}

function alwaysOnTopLevel() {
  return "floating";
}

/** 设置并回传真实状态；异常只写 stderr，不弹窗 */
function applyAlwaysOnTop(on) {
  if (!win || win.isDestroyed()) return false;
  const value = !!on;
  try {
    win.setAlwaysOnTop(value, value ? alwaysOnTopLevel() : "normal");
  } catch (err) {
    console.error("[study-widget] setAlwaysOnTop failed", err && err.message ? err.message : err);
  }
  try {
    return win.isAlwaysOnTop();
  } catch (err) {
    console.error("[study-widget] isAlwaysOnTop failed", err && err.message ? err.message : err);
    return value;
  }
}

/** 同一个窗口换页面：不新建窗口，避免第二份状态 */
function loadTarget(target) {
  if (!win || win.isDestroyed()) return false;
  const url = isSafeExternalUrl(target) ? target : "";
  try {
    win.setTitle(url && url === SETTINGS_URL ? TITLE_SETTINGS : TITLE);
  } catch {
    /* 标题只是装饰 */
  }
  const pending = win.loadURL(url || "about:blank");
  if (pending && typeof pending.catch === "function") {
    pending.catch(function (err) {
      console.error("[study-widget] loadURL failed", url, err && err.message ? err.message : err);
    });
  }
  return true;
}

function currentTarget() {
  if (settingsMode && SETTINGS_URL) return SETTINGS_URL;
  return URL_TO_LOAD;
}

function createWindow() {
  const saved = readBounds();
  const bounds = clampToDisplay(saved || DEFAULT_SIZE);
  settingsMode = hasSettingsFlag(process.argv);
  initialPinned = readInitialPinned();

  // 原生材质只在 Windows 11 且跟随系统时开：强制深/浅时由页面自己画玻璃，避免系统亚克力颜色与页面主题打架
  nativeTheme.themeSource = resolveThemeSource();
  /**
   * Windows 原生 acrylic 的颜色由系统主题服务决定，而且**浅色系统下也偏深**，
   * 和页面自己的液态玻璃（--lg-fill / backdrop-filter）叠在一起就会变成"一坨灰"。
   * 页面既然已经有完整玻璃，外壳就不该再涂一层：
   * 关闭原生材质，走纯透明窗口，让页面完全决定外观。
   * 想恢复的话把下面的 ENABLE_NATIVE_MATERIAL 改回 true 即可。
   */
  const ENABLE_NATIVE_MATERIAL = false;
  const useNativeMaterial = ENABLE_NATIVE_MATERIAL && IS_WIN11 && nativeTheme.themeSource === "system";

  // 诊断：把主进程看到的主题真值落盘，排查"浅色系统被画成深色"时用。
  // 只写诊断文件，不改变任何窗口行为。
  try {
    const diag = {
      at: new Date().toISOString(),
      environmentTheme: THEME_ENV,
      themeSource: nativeTheme.themeSource,
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      isWin11: IS_WIN11,
      useNativeMaterial: useNativeMaterial,
      prefersReducedTransparency: (() => {
        try {
          return nativeTheme.prefersReducedTransparency;
        } catch {
          return "unavailable";
        }
      })(),
    };
    fs.appendFileSync(path.join(path.dirname(STATE_FILE || __dirname), "theme-diagnostic.jsonl"), JSON.stringify(diag) + "\n", "utf8");
  } catch {
    /* 诊断写不了不影响启动 */
  }

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
    alwaysOnTop: initialPinned,
    skipTaskbar: true,
    resizable: true,
    /*
     * hasShadow 必须关掉：Windows 上 transparent 窗口再要系统阴影时，
     * DWM 会给窗口铺一层不透明底板，结果就是页面的圆角外侧出现一圈白边
     * （"能看到圆角，但后面还有白色背景"）。阴影改由页面 .app 的 box-shadow 画。
     */
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    title: settingsMode && SETTINGS_URL ? TITLE_SETTINGS : TITLE,
    ...(useNativeMaterial ? { backgroundMaterial: "acrylic" } : {}),
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

  /*
   * 只在真的启用原生材质时才调 setBackgroundMaterial。
   * 之前无条件调 "none" 会覆盖 transparent 窗口的合成层，在部分 Windows 版本上
   * 把透明窗口变回不透明底板——那正是"圆角外发白"的另一个来源。
   */
  if (useNativeMaterial && typeof win.setBackgroundMaterial === "function") {
    try {
      win.setBackgroundMaterial("acrylic");
    } catch {
      /* 老版本没有这个 API，忽略 */
    }
  }

  if (initialPinned) win.setAlwaysOnTop(true, alwaysOnTopLevel());
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
    if (!win || win.isDestroyed()) return;
    console.log("[study-widget] ready-to-show bounds", JSON.stringify(win.getBounds()), "target", settingsMode ? "settings" : "widget");
    win.showInactive();
  });
  win.webContents.on("render-process-gone", function (_e, d) {
    console.error("renderer gone", JSON.stringify(d));
  });
  win.webContents.setWindowOpenHandler(function (details) {
    // 课程链接用系统浏览器打开，别在小组件里跳走
    openExternalSafe(details.url, "window-open");
    return { action: "deny" };
  });
  // 页面自身跳出宿主 origin（比如设置页里的外链）也交给系统浏览器
  win.webContents.on("will-navigate", function (event, url) {
    if (!isSafeExternalUrl(url)) return;
    let sameOrigin = false;
    try {
      const base = currentTarget();
      sameOrigin = !!base && new URL(url).origin === new URL(base).origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin) return;
    event.preventDefault();
    openExternalSafe(url, "will-navigate");
  });
  win.on("close", function () {
    flushPendingSave();
    saveBounds();
  });
  // 外部拖动（系统窗口管理器）也落盘，防止拖动后位置丢失
  win.on("move", scheduleSaveBounds);
  win.on("resized", scheduleSaveBounds);
  win.on("closed", function () {
    flushPendingSave();
    win = null;
  });
  win.webContents.on("did-fail-load", function (_e, code, desc) {
    console.error("load failed", code, desc);
  });
  // 系统深浅色切换时告诉页面，让玻璃跟着换（页面也会自己监听 matchMedia，这里多一条兜底）
  nativeTheme.on("updated", function () {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send("study-widget:theme-changed", currentTheme());
    } catch {
      /* 窗口正在关闭 */
    }
  });
  loadTarget(currentTarget());
}

/** 当前真实主题快照：{ source: 'system'|'dark'|'light', light: boolean } */
function currentTheme() {
  const source = resolveThemeSource();
  // nativeTheme.themeSource 已被我们设成 system/dark/light，shouldUseDarkColors 就是最终答案
  // （不是 system 时也应读它，而不是硬编码 === light，否则强制深色会被算成浅色）
  const light = !nativeTheme.shouldUseDarkColors;
  let reducedTransparency = false;
  try {
    reducedTransparency = !!nativeTheme.prefersReducedTransparency;
  } catch {
    reducedTransparency = false;
  }
  return {
    source: source,
    light: light,
    dark: !light,
    native: IS_WIN11,
    reducedTransparency: reducedTransparency,
  };
}

ipcMain.handle("study-widget:minimize", function () {
  if (win && !win.isDestroyed()) win.hide();
  return true;
});

ipcMain.handle("study-widget:hide", function () {
  if (win && !win.isDestroyed()) {
    flushPendingSave();
    win.hide();
  }
  return true;
});

ipcMain.handle("study-widget:close", function () {
  if (win && !win.isDestroyed()) win.close();
  return true;
});

ipcMain.handle("study-widget:toggle-pin", function () {
  if (!win || win.isDestroyed()) return false;
  return applyAlwaysOnTop(!win.isAlwaysOnTop());
});

ipcMain.handle("study-widget:set-always-on-top", function (_e, on) {
  return applyAlwaysOnTop(!!on);
});

ipcMain.handle("study-widget:is-pinned", function () {
  return !!(win && !win.isDestroyed() && win.isAlwaysOnTop());
});

// 主题查询：preload 的 getTheme() 同步快照之外，也允许页面异步再问一次（系统切换后）
ipcMain.handle("study-widget:get-theme", function () {
  return currentTheme();
});

/**
 * 同步主题查询：preload 要在首帧之前拿到主题（避免先画错颜色再跳），
 * 而 ipcMain.handle 是异步的，await 期间页面已经画过一帧了。
 * sendSync 是 Electron 给这种「必须同步」场景的口子，代价是一次阻塞往返，
 * 只在 preload 初始化时打一次，可以接受。
 */
ipcMain.on("study-widget:get-theme-sync", function (event) {
  try {
    event.returnValue = currentTheme();
  } catch {
    event.returnValue = null;
  }
});

let dragging = null;

ipcMain.handle("study-widget:move-state", function (_e, active) {
  if (!win || win.isDestroyed()) return false;
  if (active) {
    const b = win.getBounds();
    dragging = { x: b.x, y: b.y };
  } else {
    dragging = null;
    // 拖完立刻落盘一次，别等节流定时器
    saveBounds();
  }
  return !!dragging;
});

ipcMain.handle("study-widget:move-by", function (_e, dx, dy) {
  if (!win || win.isDestroyed() || !dragging) return false;
  const nx = Math.round(dragging.x + (Number(dx) || 0));
  const ny = Math.round(dragging.y + (Number(dy) || 0));
  try {
    win.setPosition(nx, ny, false);
  } catch (err) {
    console.error("[study-widget] setPosition failed", err && err.message ? err.message : err);
    return false;
  }
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
  openExternalSafe(url, "open-external");
  return true;
});

ipcMain.handle("study-widget:shell-open", function (_e, url) {
  return openExternalSafe(url, "shell-open");
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
        const next = applyAlwaysOnTop(!win.isAlwaysOnTop());
        win.webContents.send("study-widget:pinned-changed", next);
      },
    },
    {
      label: "刷新数据",
      // 设置页没有 onRefresh 监听，设置模式下干脆不显示这一项
      visible: !settingsMode,
      click: function () {
        if (!win || win.isDestroyed() || settingsMode) return;
        win.webContents.send("study-widget:refresh");
      },
    },
    { type: "separator" },
    {
      label: "打开网页版工作台",
      click: function () {
        openExternalSafe("https://glebah23.github.io/study-dashboard/", "menu");
      },
    },
    {
      label: "隐藏窗口",
      click: function () {
        flushPendingSave();
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
  // 第二次启动：把已有窗口唤到前面（最小化的也显示出来），然后退出
  app.quit();
} else {
  app.on("second-instance", function (_event, argv) {
    if (!win || win.isDestroyed()) return;
    // 第二次启动带 --settings：同一个窗口换成设置页，不新开窗口
    if (hasSettingsFlag(argv)) {
      if (!win.isVisible()) win.showInactive();
      if (SETTINGS_URL) loadTarget(SETTINGS_URL);
      return;
    }
    if (!win.isVisible()) win.showInactive();
    win.setAlwaysOnTop(true, alwaysOnTopLevel());
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
  app.on("before-quit", function () {
    // 退出前把没落盘的拖动位置补上
    flushPendingSave();
    saveBounds();
  });
  app.on("window-all-closed", function () {
    app.quit();
  });
}
