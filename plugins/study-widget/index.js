/**
 * @dsh-external/study-widget —— 学业工作台桌面小组件（host 半边）
 *
 * 职责：
 *   1. 注册 /dsh-study-widget/ 路由：桌面页面、样式脚本、数据接口
 *   2. 从 Supabase 只读拉取整份学习进度（协议与网页端 app.js 一致）
 *   3. 提供「打开/关闭桌面小窗」能力（Electron 无边框置顶窗口）
 *   4. /study 斜杠命令与 agent tool，让 DSH 里的助手也能直接报进度
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StudySource, widgetHome } from "./lib/source.js";
import { buildSummary } from "./lib/summary.js";
import { createDesktopLauncher } from "./lib/desktop.js";
import { createSettingsRoutes } from "./lib/settings-routes.js";
import { createMutator } from "./lib/mutate.js";
import { SettingsStore } from "./lib/settings.js";

export const name = "study-widget";

/** 本文件所在目录；日志回退路径也用它，必须在 writePluginLog 之前定义 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 同步写一行日志。为什么不用 logger：宿主 logger 在很多部署里不落盘，
 * 插件 apply 抛错时 loader 只把它标成 absent，界面上完全没痕迹——排查时等于瞎。
 * 同步写保证崩溃/退出前已经刷到磁盘。
 *
 * 目标顺序：
 *   1. ~/.dsh/study-widget/plugin.log（正式位置）
 *   2. <repo>/.tmp-probe/plugin.log（工作区内回退；沙盒/权限不让写上面时仍能取证）
 */
export function writePluginLog(line) {
  const text = "[" + new Date().toISOString() + "] " + line + "\n";
  const targets = [];
  try {
    targets.push(path.join(widgetHome(), "plugin.log"));
  } catch {
    /* widgetHome 极端情况下会抛，忽略 */
  }
  targets.push(path.join(HERE, "..", "..", ".tmp-probe", "plugin.log"));
  for (const file of targets) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, text, "utf8");
      return file;
    } catch {
      /* 换下一个目标 */
    }
  }
  return "";
}

const ROUTE = "/dsh-study-widget";
const SUMMARY_TTL_MS = 30 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

export function apply(ctx, config) {
  // 进入 apply 先落一行：能区分「loader 根本没调用 apply」（这行都没有）
  // 和「apply 内部抛错」（有这行、没有后续 ready 行）。
  writePluginLog("apply enter; node=" + process.version + " electron=" + (process.versions.electron || "-"));
  try {
    return applyInner(ctx, config);
  } catch (err) {
    const detail = err && err.stack ? err.stack : String((err && err.message) || err);
    writePluginLog("apply FAILED: " + detail);
    throw err;
  }
}

function applyInner(ctx, config) {
  const cfg = config || {};
  const logger = (ctx && ctx.logger) ? ctx.logger("study-widget") : console;
  const assetsDir = path.resolve(HERE, cfg.assetsDir || "assets");
  const source = new StudySource();
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const cache = { summary: null, at: 0 };
  const waiters = new Map();
  const settingsStore = new SettingsStore();
  /** 写入器：待办勾选 / 打卡。只在数据源是 supabase 时放行，见 lib/mutate.js */
  const mutator = createMutator(source);

  const webServer = ctx.get("webServer");
  writePluginLog("webServer=" + (webServer ? (typeof webServer) : "undefined"));
  /**
   * 每次调用都重新取一次服务：apply 时拿到的快照可能是 undefined，
   * 而桌面小窗真正开窗时服务早已就绪。返回空串表示此刻还不可用。
   */
  const originProvider = function () {
    try {
      const server = ctx.get("webServer");
      return server && server.getOrigin ? server.getOrigin() : "";
    } catch {
      return "";
    }
  };

  const desktop = createDesktopLauncher(ctx, {
    electronPath: cfg.electronPath,
    originProvider,
    token: function () {
      return token;
    },
    mainScript: path.join(HERE, "desktop", "main.cjs"),
    iconPath: path.join(HERE, "assets", "icon.png"),
    log: function (line) {
      logger.info ? logger.info(line) : logger.log(line);
    },
  });

  /**
   * 设置页/接口层：托管 /api/settings、/api/desktop、/api/plugin、/api/sources。
   * 必须在 desktop / settingsStore 定义之后创建：对象字面量参数会立即求值，顺序反了就是 TDZ，
   * 被 try/catch 吞掉后设置页整组接口会全部 404。
   * pluginManager 传函数而不是对象，因为服务可能比本插件晚挂载。
   */
  const settingsRoutes = (function () {
    try {
      return createSettingsRoutes({
        source,
        desktop,
        pluginManager: function () {
          return ctx.get("pluginManager");
        },
        sendJson,
        sendText,
        authorized,
        settings: settingsStore,
      });
    } catch (err) {
      logger.warn && logger.warn("settings routes 初始化失败，设置页将不可用：" + ((err && err.message) || err));
      return null;
    }
  })();

  async function readData(force) {
    return source.read({ stateFile: cfg.stateFile, offline: !!cfg.offline, force: force }).then(
      function (row) {
        return row;
      }
    );
  }

    /**
   * 快照缓存秒数：设置页的 refresh.summaryTtlSeconds（0 = 每次都读云端）。
   * 设置读不出来一律回落 30 秒——设置问题不能把数据接口打挂。
   */
  async function summaryTtlMs() {
    try {
      if (settingsRoutes && typeof settingsRoutes.ttlSeconds === "function") {
        const seconds = await settingsRoutes.ttlSeconds();
        return Math.max(0, Number(seconds) || 0) * 1000;
      }
    } catch {
      /* 回落常量 */
    }
    return SUMMARY_TTL_MS;
  }

  /** 读一次并组装快照；同刻并发请求共享一次读取 */
  async function summary(force) {
    const ttlMs = await summaryTtlMs();
    if (!force && cache.summary && ttlMs > 0 && Date.now() - cache.at < ttlMs) {
      return { summary: cache.summary, status: source.status() };
    }
    if (waiters.has("load")) return waiters.get("load");
    const job = (async function () {
      try {
        const row = await readData(force);
        const built = buildSummary(row.data, {
          source: row.source,
          rev: row.rev,
          email: row.email,
          syncedAt: row.fetchedAt || Date.now(),
        });
        cache.summary = built;
        cache.at = Date.now();
        return { summary: built, status: source.status() };
      } finally {
        waiters.delete("load");
      }
    })();
    waiters.set("load", job);
    return job;
  }

  // ---------- HTTP ----------

  function sendJson(res, statusCode, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  function sendText(res, statusCode, text, type) {
    res.writeHead(statusCode, {
      "Content-Type": type || "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  /**
   * 读一个 JSON 请求体。
   * 上限 64KB：这里的接口只收 { id, checked, min } 这种小对象，
   * 给大一点是给未来的批量操作留余量，同时仍然挡住被当成上传通道。
   */
  function readJsonBody(req, limit) {
    const cap = limit || 64 * 1024;
    return new Promise(function (resolve, reject) {
      let body = "";
      let aborted = false;
      req.on("data", function (chunk) {
        if (aborted) return;
        body += chunk;
        if (body.length > cap) {
          aborted = true;
          const err = new Error("请求体太大");
          err.code = "BODY_TOO_LARGE";
          reject(err);
          req.destroy();
        }
      });
      req.on("end", function () {
        if (aborted) return;
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(body);
          resolve(parsed && typeof parsed === "object" ? parsed : {});
        } catch {
          const err = new Error("请求体不是合法 JSON");
          err.code = "BAD_JSON";
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  /** 把 mutate 抛出的业务错误翻成 HTTP 状态 + 结构化 payload */
  function sendWriteError(res, err) {
    const code = (err && err.code) || "WRITE_FAILED";
    const message = String((err && err.message) || err);
    const status =
      code === "TODO_NOT_FOUND" || code === "CHECKIN_NOT_FOUND"
        ? 404
        : code === "READ_ONLY_SOURCE"
          ? 409
          : code === "MIN_REQUIRED" || code === "BAD_ID" || code === "BAD_DATA"
            ? 400
            : code === "CONFLICT"
              ? 409
              : 502;
    writePluginLog("write failed: " + code + " " + message);
    sendJson(res, status, { ok: false, error: { code: code, message: message } });
  }

  function authorized(req, url) {
    if (cfg.requireToken === false) return true;
    const given = url.searchParams.get("token") || "";
    if (given && given === token) return true;
    // 宿主页面本身（同源 fetch 会带 cookie）视为已登录
    if (req.headers.cookie && /dsh/i.test(String(req.headers.cookie))) return true;
    // 桌面窗口是独立的浏览器上下文，没有宿主的 cookie，只能靠 token；
    // 但本机直连（127.0.0.1 / localhost 且无外网 Host 头）也放行，
    // 否则用户在浏览器里直接打开本页面就永远看不到数据。
    const host = String(req.headers.host || "");
    const hostName = host.replace(/:\d+$/, "").toLowerCase();
    const isLocal = hostName === "127.0.0.1" || hostName === "localhost" || hostName === "[::1]" || hostName === "::1";
    if (!isLocal) return false;
    // 有 Origin 头时，必须同源（防其他本地网页跨站读取）
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        if (o.host.toLowerCase() !== host.toLowerCase()) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async function serveAsset(res, rel) {
    const abs = path.resolve(assetsDir, rel);
    if (!abs.startsWith(assetsDir)) {
      sendText(res, 403, "forbidden");
      return;
    }
    try {
      let body = await fsPromises.readFile(abs);
      let type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
      // widget.css / settings.css 都是「共用材质 + 布局 + 组件玻璃覆盖」的拼装产物：
      // 材质那份（liquid-glass.css）三端共用，避免小窗/设置页/面板各写一套配方漂移。
      // 注意：开发期磁盘上的 widget.css / settings.css 已经是拼好的正式版（scripts/build-css.py --write），
      // 这里再拼一次会重复，所以用「文件头是否已含材质变量」判断，只在还是纯布局稿时才拼。
      if (rel === "widget.css" || rel === "settings.css") {
        const text = body.toString("utf8");
        if (text.indexOf("--lg-fill:") === -1) {
          const files = ["liquid-glass.css", rel];
          if (rel === "settings.css") files.push("liquid-glass-settings.css");
          const parts = [];
          for (const f of files) parts.push(await fsPromises.readFile(path.join(assetsDir, f), "utf8"));
          body = Buffer.from(parts.join("\n"), "utf8");
          type = "text/css; charset=utf-8";
        }
      }
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-cache",
        "Content-Length": body.length,
      });
      res.end(body);
    } catch {
      sendText(res, 404, "not found");
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const rel = decodeURIComponent(url.pathname.slice(ROUTE.length));
    const isApi = rel.indexOf("/api/") === 0;

    if (isApi && !authorized(req, url)) {
      sendJson(res, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "没有访问桌面上小组件数据的权限" } });
      return;
    }

    // 设置/桌面/插件/数据源这几组接口由 lib/settings-routes.js 独占，不认识的原路返回 false
    if (settingsRoutes) {
      const handled = await settingsRoutes(req, res, rel, url);
      if (handled) return;
    }

    if (rel === "/api/summary" || rel === "/api/summary.json") {
      try {
        const out = await summary(url.searchParams.get("refresh") === "1");
        sendJson(res, 200, {
          ok: true,
          summary: out.summary,
          status: out.status,
        });
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          error: {
            code: (err && err.code) || "READ_FAILED",
            message: String((err && err.message) || err),
            path: (err && err.path) || "",
          },
          status: source.status(),
        });
      }
      return;
    }

    if (rel === "/api/status") {
      sendJson(res, 200, { ok: true, status: source.status(), desktop: desktop.status() });
      return;
    }

    /*
     * 写入接口（面板 / 小窗点勾选与打卡时调用）。
     *
     *   POST /api/todo/toggle     { id, checked? }        checked 省略 = 翻转
     *   POST /api/checkin/toggle  { id, min?, note? }     视频打卡必须带 min
     *
     * 写成功后清掉快照缓存并回传最新 summary，界面可以直接拿它重绘，
     * 不必再等下一次轮询。
     */
    if (
      rel === "/api/todo/toggle" ||
      rel === "/api/checkin/toggle" ||
      rel === "/api/checkin/log" ||
      rel === "/api/checkin/unlog"
    ) {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "只接受 POST" } });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (err) {
        sendWriteError(res, err);
        return;
      }
      try {
        let result;
        if (rel === "/api/todo/toggle") {
          result = await mutator.toggleTodo(payload.id, typeof payload.checked === "boolean" ? payload.checked : undefined);
        } else if (rel === "/api/checkin/log") {
          result = await mutator.logCheckin(payload.id, {
            min: payload.min,
            cid: payload.cid,
            lid: payload.lid,
            note: payload.note,
          });
        } else if (rel === "/api/checkin/unlog") {
          result = await mutator.removeCheckinLog(payload.id, payload.at);
        } else {
          result = await mutator.toggleCheckin(payload.id, { min: payload.min, note: payload.note });
        }
        /*
         * 用刚写回的数据重建快照，不再额外拉一次云端：
         * mutator 已经把写成功后的 { data, rev } 放进了 source.cache，
         * 直接基于它算 summary，省一次往返，也避免"刚写完又读到旧值"的窗口。
         */
        let summary = null;
        try {
          const row = source.cache;
          if (row && row.data) {
            summary = buildSummary(row.data, {
              source: row.source,
              rev: row.rev,
              email: row.email,
              syncedAt: row.fetchedAt || Date.now(),
            });
            cache.summary = summary;
            cache.at = Date.now();
          }
        } catch (err) {
          logger.warn && logger.warn("写入后重建快照失败：" + ((err && err.message) || err));
        }
        sendJson(res, 200, Object.assign({ ok: true }, result, { summary: summary }));
      } catch (err) {
        sendWriteError(res, err);
      }
      return;
    }

    if (rel === "/api/open-desktop" || rel === "/api/close-desktop") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: { message: "只接受 POST" } });
        return;
      }
      const result = rel === "/api/open-desktop" ? await desktop.open() : { ok: desktop.stop() };
      sendJson(res, 200, Object.assign({ ok: true }, result, { desktop: desktop.status() }));
      return;
    }

    if (rel === "/api/bounds" && req.method === "POST") {
      let body = "";
      req.on("data", function (chunk) {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      req.on("end", async function () {
        let parsed = null;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          parsed = null;
        }
        sendJson(res, 200, { ok: await desktop.saveBounds(parsed) });
      });
      return;
    }

    if (rel === "/icon.png" || rel === "/icon.svg") {
      const name = rel === "/icon.png" ? "icon.png" : "icon.svg";
      try {
        const body = await fsPromises.readFile(path.join(HERE, "assets", name));
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(name)],
          "Cache-Control": "public, max-age=3600",
          "Content-Length": body.length,
        });
        res.end(body);
      } catch {
        sendText(res, 404, "not found");
      }
      return;
    }

    if (rel === "/" || rel === "" || rel === "/index.html") {
      await serveAsset(res, "widget.html");
      return;
    }

    // 设置页：/settings 与 /settings/ 都指向同一个自包含页面（它自带 ./settings.css、./settings.js）
    if (rel === "/settings" || rel === "/settings/" || rel === "/settings.html") {
      await serveAsset(res, "settings.html");
      return;
    }
    // 设置页样式同样拼上共用材质
    if (rel === "/settings.css") {
      await serveAsset(res, "settings.css");
      return;
    }
    if (rel === "/liquid-glass.css") {
      await serveAsset(res, "liquid-glass.css");
      return;
    }
    await serveAsset(res, rel.replace(/^\/+/, ""));
  }

  // 路由注册必须等 webServer 服务就绪。
  // Cordis 的 ctx.get() 是同步取值：apply 执行时 webServer 可能还没挂载（Desktop 实测为
  // undefined），早先的写法会在这里判定「不可用」并永久跳过注册——面板 iframe 于是拿到 404
  // 空白页，桌面小窗也加载不到页面。用 ctx.inject 声明依赖，服务出现后回调才会执行。
  ctx.inject(["webServer"], function (sctx) {
    const server = sctx.webServer;
    if (!server || typeof server.register !== "function") {
      logger.warn("webServer 服务不完整：没有 register()，路由无法注册");
      return;
    }
    writePluginLog("webServer ready -> registering " + ROUTE);
    sctx.effect(function () {
      return server.register({
        kind: "prefix",
        path: ROUTE,
        handler: function (req, res) {
          handle(req, res).catch(function (err) {
            logger.warn("route error: " + ((err && err.stack) || err));
            try {
              sendJson(res, 500, { ok: false, error: { message: String((err && err.message) || err) } });
            } catch {
              /* 响应可能已经结束 */
            }
          });
        },
      });
    }, "study-widget: web routes");
  });

  // ---------- 命令 & 工具 ----------

  const openDesktop = async function () {
    return desktop.open();
  };

  const readForTool = async function () {
    const out = await summary(true);
    return out.summary;
  };

  ctx.inject(["tools"], function (sctx) {
    const tool = sctx.tools;
    if (tool && typeof tool.register === "function") {
      sctx.effect(
      function () {
        return tool.register({
          name: "study_widget_progress",
          description:
            "读取学业工作台（study-dashboard）的学习进度快照：总进度与各课程课时百分比、今日学习分钟/连续天数/待办完成数/打卡数、按逾期-今日-本周排序的未完成待办、循环打卡周期状态、最近 10 周热力图。数据来自用户自己配置的 Supabase（只读）。",
          parameters: {
            type: "object",
            properties: {
              detail: {
                type: "string",
                enum: ["summary", "full"],
                description: "summary 只返回今日/总览/待办概览；full 额外返回每门课的课时明细。",
              },
            },
            additionalProperties: false,
          },
          async execute(args) {
            const s = await readForTool();
            if (!s) return { content: "没有读到数据" };
            const wantFull = args && args.detail === "full";
            const payload = Object.assign({}, s, {
              courses: s.courses.map(function (c) {
                return Object.assign({}, c, { lessons: wantFull ? c.lessons : undefined });
              }),
              heat: { cols: s.heat.cols },
            });
            return { content: JSON.stringify(payload, null, 2) };
          },
        });
      },
      "study-widget: agent tool"
      );
    }
  });

  // /study 斜杠命令（服务可用时注册；不可用不影响其它能力）
  const commands = ctx.get("commands");
  if (commands && typeof commands.register === "function") {
    ctx.effect(
      function () {
        return commands.register({
          name: "study",
          description: "打开学业工作台桌面小组件；/study status 只打印一句进度",
          handler: async function (args) {
            const arg = String(args || "").trim();
            if (arg === "status" || arg === "进度") {
              const s = await summary(true).then(function (r) {
                return r.summary;
              });
              return {
                message:
                  "今日 " +
                  s.today.minText +
                  " · 连续 " +
                  s.today.streak +
                  " 天 · 总进度 " +
                  s.overall.pct +
                  "%（" +
                  s.overall.doneLessons +
                  "/" +
                  s.overall.count +
                  " 节）· 逾期 " +
                  s.counts.overdue +
                  " · 今天到期 " +
                  s.counts.today,
              };
            }
            const result = await openDesktop();
            return {
              message: result.ok
                ? "已打开桌面小组件窗口（" + (result.reused ? "已存在的窗口" : "新窗口") + "）"
                : "打开失败：" + result.error,
            };
          },
        });
      },
      "study-widget: /study command"
    );
  }

  logger.info && logger.info("ready: " + ROUTE + "/ (desktop window " + (desktop.alive() ? "running" : "idle") + ")");
  writePluginLog("ready: " + ROUTE + "/ route registered; assetsDir=" + assetsDir);

  // autoOpen：桌面设置页的「随 DSH 启动自动打开小窗」（settings.json 的 desktop.autoOpen），
  // 插件配置 cfg.autoOpen 仅在设置项没有明确写布尔值时兜底。
  // 早先只看 cfg.autoOpen，而 profile 的 insert 行从不给 config，开关写了也不生效。
  // 开窗还必须等 webServer 就绪（originProvider 拿得到地址），所以用 inject 而不是 setTimeout 干等；
  // 失败只记日志，不炸插件。
  autoOpenIfEnabled();

  async function autoOpenIfEnabled() {
    let wanted = null;
    let from = "settings.json";
    // 开关读不出来（文件坏了）就按关处理：设置问题不该在启动时反复弹失败
    const saved = await Promise.resolve()
      .then(function () {
        return settingsStore.load();
      })
      .catch(function (err) {
        writePluginLog("autoOpen: 读设置失败，本次不自动开窗：" + String((err && err.message) || err));
        return null;
      });
    const value = saved && saved.desktop ? saved.desktop.autoOpen : undefined;
    if (typeof value === "boolean") wanted = value;
    if (wanted === null) {
      wanted = !!cfg.autoOpen;
      from = "插件配置";
    }
    writePluginLog("autoOpen=" + wanted + "（来源：" + from + "）");
    if (!wanted) return;

    ctx.inject(["webServer"], function (sctx) {
      const server = sctx.webServer;
      if (!server || typeof server.getOrigin !== "function") return;
      const timer = setTimeout(function () {
        desktop.open({}).then(
          function (result) {
            writePluginLog("autoOpen -> " + (result && result.ok ? "opened " + (result.reused ? "(reused)" : "") : "failed: " + (result && result.error)));
          },
          function (err) {
            const detail = String((err && err.message) || err);
            writePluginLog("autoOpen failed: " + detail);
            logger.warn && logger.warn("autoOpen failed: " + detail);
          }
        );
      }, 800);
      sctx.effect(
        function () {
          return function () {
            clearTimeout(timer);
          };
        },
        "study-widget: autoOpen timer"
      );
    });
  }

  return function () {
    desktop.dispose();
  };
}
