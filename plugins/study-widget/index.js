/**
 * @dsh-external/study-widget —— 学业工作台桌面小组件（host 半边）
 *
 * 职责：
 *   1. 注册 /dsh-study-widget/ 路由：桌面页面、样式脚本、数据接口
 *   2. 从 Supabase 只读拉取整份学习进度（协议与网页端 app.js 一致）
 *   3. 提供「打开/关闭桌面小窗」能力（Electron 无边框置顶窗口）
 *   4. /study 斜杠命令与 agent tool，让 DSH 里的助手也能直接报进度
 */
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StudySource } from "./lib/source.js";
import { buildSummary } from "./lib/summary.js";
import { createDesktopLauncher } from "./lib/desktop.js";
import { createSettingsRoutes } from "./lib/settings-routes.js";
import { SettingsStore } from "./lib/settings.js";

export const name = "study-widget";

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
  const cfg = config || {};
  const logger = ctx.logger ? ctx.logger("study-widget") : console;
  const assetsDir = path.resolve(HERE, cfg.assetsDir || "assets");
  const source = new StudySource();
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const cache = { summary: null, at: 0 };
  const waiters = new Map();
  const settingsStore = new SettingsStore();

  const webServer = ctx.get("webServer");
  const originProvider = function () {
    try {
      return webServer && webServer.getOrigin ? webServer.getOrigin() : "";
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
      const body = await fsPromises.readFile(abs);
      const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
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
    await serveAsset(res, rel.replace(/^\/+/, ""));
  }

  ctx.effect(function () {
    if (!webServer) {
      logger.warn("webServer 不可用：桌面小组件页面无法提供，只保留命令与工具");
      return function () {};
    }
    return webServer.register({
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

  // autoOpen：等 webServer 就绪（originProvider 拿得到地址）再开窗，失败只记日志不炸插件
  if (cfg.autoOpen) {
    const timer = setTimeout(function () {
      desktop.open({}).catch(function (err) {
        logger.warn && logger.warn("autoOpen failed: " + String((err && err.message) || err));
      });
    }, 1500);
    ctx.effect(
      function () {
        return function () {
          clearTimeout(timer);
        };
      },
      "study-widget: autoOpen timer"
    );
  }

  return function () {
    desktop.dispose();
  };
}
