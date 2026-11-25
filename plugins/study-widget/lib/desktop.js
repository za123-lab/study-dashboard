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
    const mainScript = settings.mainScript;
    const env = Object.assign({}, process.env);
    // 宿主也是 Electron 时这个变量会让子进程进纯 Node 模式 → require('electron') 立刻失败
    delete env.ELECTRON_RUN_AS_NODE;
    env.DSH_STUDY_WIDGET_URL = widgetUrl(origin, settings.token());
    env.DSH_STUDY_WIDGET_APP_ID = APP_ID;
    env.DSH_STUDY_WIDGET_STATE_FILE = paths.windowState;
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

  function dispose() {
    stop();
  }

  return { open, stop, status, saveBounds, dispose, alive };
}
