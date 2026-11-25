/**
 * 桌面小组件窗口：在独立的 Electron 小窗里打开 /dsh-study-widget/ 页面。
 *
 * 选 Electron 而不是浏览器 --app：能拿到无边框、透明、置顶、不占任务栏，
 * 也能记住窗口位置。Electron 可执行文件来自：
 *   pluginConfig.electronPath → env DSH_STUDY_WIDGET_ELECTRON → $DSH_HOME/electron/electron.exe
 */
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { credentialPaths, readJson, writeJson } from "./source.js";

const APP_ID = "dsh-study-widget";

function candidates(settings) {
  const out = [];
  const push = function (p) {
    if (p && typeof p === "string" && p.trim()) out.push(path.resolve(p.trim()));
  };
  push(settings.electronPath);
  push(process.env.DSH_STUDY_WIDGET_ELECTRON);
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  const home = dshHome ? path.resolve(dshHome) : path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  if (process.platform === "win32") push(path.join(home, "electron", "electron.exe"));
  else if (process.platform === "darwin") push(path.join(home, "electron", "Electron.app", "Contents", "MacOS", "Electron"));
  else push(path.join(home, "electron", "electron"));
  return out;
}

async function resolveElectron(settings) {
  for (const candidate of candidates(settings)) {
    try {
      await fsPromises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* 继续找下一个 */
    }
  }
  return "";
}

/** 页面地址里的 origin 来自 webServer，端口随宿主变，所以每次启动都重新拼 */
function widgetUrl(origin, token) {
  const base = String(origin || "").replace(/\/+$/, "");
  return base + "/dsh-study-widget/?t=" + encodeURIComponent(token || "");
}

export function createDesktopLauncher(ctx, settings) {
  let child = null;
  let lastSpawnAt = 0;
  let lastError = "";
  let execPath = "";

  function alive() {
    return !!(child && child.exitCode == null && !child.killed);
  }

  function stop() {
    if (!child) return false;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    child = null;
    return true;
  }

  async function open() {
    if (alive()) {
      // 已经在跑：再点一次就当作「带到前面」——Electron 端只允许一个实例，第二实例会唤回窗口
      await spawnWindow(true);
      return { ok: true, reused: true };
    }
    const now = Date.now();
    if (now - lastSpawnAt < 1500) {
      return { ok: false, error: "窗口正在启动，稍等一下" };
    }
    lastSpawnAt = now;
    return spawnWindow(false);
  }

  async function spawnWindow(reused) {
    const electron = await resolveElectron(settings);
    execPath = electron;
    if (!electron) {
      lastError = "找不到 Electron 可执行文件：可在插件配置 electronPath 里指一份，或设置 DSH_STUDY_WIDGET_ELECTRON";
      return { ok: false, error: lastError };
    }
    const origin = settings.originProvider();
    if (!origin) {
      lastError = "webServer 还没就绪，拿不到页面地址";
      return { ok: false, error: lastError };
    }
    const paths = credentialPaths();
    const windowState = await readJson(paths.windowState).catch(function () {
      return undefined;
    });
    // 主题：settings.json 的 appearance.theme（system|dark|light），传给 Electron 与页面，壳和内容必须同一个值
    let theme = "system";
    try {
      const raw = await readJson(path.join(paths.home, "settings.json"));
      const value = raw && raw.appearance ? raw.appearance.theme : undefined;
      if (value === "dark" || value === "light" || value === "system") theme = value;
    } catch {
      theme = "system";
    }
    const mainScript = settings.mainScript;
    const env = Object.assign({}, process.env);
    // 宿主也是 Electron 时这个变量会让子进程进纯 Node 模式 → require('electron') 立刻失败
    delete env.ELECTRON_RUN_AS_NODE;
    env.DSH_STUDY_WIDGET_URL = widgetUrl(origin, settings.token());
    env.DSH_STUDY_WIDGET_APP_ID = APP_ID;
    env.DSH_STUDY_WIDGET_STATE_FILE = paths.windowState;
    env.DSH_STUDY_WIDGET_THEME = theme;
    if (settings.iconPath) env.DSH_STUDY_WIDGET_ICON = settings.iconPath;
    if (windowState) env.DSH_STUDY_WIDGET_BOUNDS = JSON.stringify(windowState);

    try {
      child = nodeSpawn(electron, [mainScript], {
        cwd: path.dirname(mainScript),
        env,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      lastError = String((err && err.message) || err);
      return { ok: false, error: lastError };
    }
    lastError = "";
    let stderrTail = "";
    let stdoutTail = "";
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", function (chunk) {
        stderrTail = (stderrTail + chunk).slice(-4000);
        settings.log("desktop stderr: " + String(chunk).trim());
      });
    }
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", function (chunk) {
        stdoutTail = (stdoutTail + chunk).slice(-4000);
        settings.log("desktop: " + String(chunk).trim());
      });
    }
    child.on("error", function (err) {
      lastError = String((err && err.message) || err);
      settings.log("desktop error: " + lastError);
    });
    child.on("exit", function (code) {
      settings.log("desktop exited: " + code + (stderrTail ? "\n" + stderrTail.slice(-1200) : ""));
      child = null;
    });
    lastError = "";
    return { ok: true, reused: !!reused, url: env.DSH_STUDY_WIDGET_URL };
  }

  async function saveBounds(bounds) {
    if (!bounds || typeof bounds !== "object") return false;
    const clean = {};
    ["x", "y", "width", "height"].forEach(function (k) {
      const n = Number(bounds[k]);
      if (Number.isFinite(n)) clean[k] = Math.round(n);
    });
    if (Object.keys(clean).length === 0) return false;
    await writeJson(credentialPaths().windowState, clean);
    return true;
  }

  function status() {
    return {
      running: alive(),
      error: lastError,
      execPath: execPath,
    };
  }

  /**
   * 设置页/接口要的聚合快照。
   * - bounds：window.json（6 条写盘路径共同维护；文件缺失/半截 JSON 一律当无记录，返回 null）
   * - pinned：settings.json 的 desktop.alwaysOnTop（「上次保存的意图」，不是实时值）
   * - pinnedSource：live（界面直接问过渲染进程）/ settings（来自设置文件）/ unknown
   * - running：进程是否还活着
   */
  async function info() {
    const paths = credentialPaths();
    let bounds = null;
    try {
      const saved = await readJson(paths.windowState);
      if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
        bounds = {
          x: Number(saved.x),
          y: Number(saved.y),
          width: Number(saved.width),
          height: Number(saved.height),
        };
      }
    } catch {
      bounds = null;
    }
    let pinned = null;
    let pinnedSource = "unknown";
    try {
      const raw = await readJson(path.join(paths.home, "settings.json"));
      const value = raw && raw.desktop ? raw.desktop.alwaysOnTop : undefined;
      if (typeof value === "boolean") {
        pinned = value;
        pinnedSource = "settings";
      }
    } catch {
      pinned = null;
    }
    return {
      running: alive(),
      bounds,
      pinned,
      pinnedSource,
      error: lastError,
      execPath,
      live: alive(),
    };
  }

  /**
   * 隐藏窗口。Electron 子进程没有进程内控制通道，这里退化为 stop()：
   * before-quit 已冲刷 window.json，所以下次打开仍在原位，无副作用。
   */
  async function hide() {
    if (!alive()) return { ok: false, error: "窗口未运行", code: "NO_HIDE" };
    stop();
    return { ok: true, mode: "stop" };
  }

  /**
   * 置顶。Host 侧无法直接调渲染进程 IPC，这里只把意图写进 settings.json；
   * 运行时切换由设置页/小组件页直接调 window.studyWidget.setAlwaysOnTop() 完成。
   */
  async function setPinned(value) {
    const wanted = !!value;
    const settingsFile = path.join(credentialPaths().home, "settings.json");
    try {
      const raw = (await readJson(settingsFile)) || {};
      const desktopCfg = Object.assign({}, raw.desktop || {}, { alwaysOnTop: wanted });
      raw.desktop = desktopCfg;
      await writeJson(settingsFile, raw);
      return { ok: true, applied: "persisted", pinned: wanted, pinnedSource: "settings" };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), code: "NO_PIN" };
    }
  }

  function dispose() {
    stop();
  }

  return { open, stop, status, saveBounds, dispose, alive, info, hide, setPinned };
}
