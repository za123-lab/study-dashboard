/**
 * 设置页的 HTTP 端点（可挂载模块）：/dsh-study-widget/api/*
 *
 * 只负责「设置 / 桌面窗口 / 插件开关 / 数据源快照」这四组接口，
 * 不碰 index.js 既有的 /api/summary、/api/status、静态资源。
 * 返回 true = 已处理；false = 不认识，交回 index.js。
 *
 * 接线（index.js，由 lead 完成）：
 *   const settingsRoutes = createSettingsRoutes({
 *     source, desktop, pluginManager: ctx.get("pluginManager"), sendJson, sendText, authorized,
 *   });
 *   if (await settingsRoutes(req, res, rel, url)) return;
 *
 * 契约（TEAM-BRIEF 4.1）：
 *   GET  /api/settings         → { ok, settings: SettingsView, status, desktop, plugin }
 *   POST /api/settings         { settings: Partial<SettingsInput> } → 同上
 *   POST /api/settings/test    { settings?: Partial<SettingsInput> }
 *                              → { ok:true, auth:{ok,email,userId}, data:{ok,rev,updatedAt,todoOpen,courses} }
 *   GET  /api/desktop          → { ok, running, pinned, bounds, execPath, error }
 *   POST /api/desktop          { action: "open"|"close"|"hide"|"pin", value?: boolean } → { ok, desktop }
 *   GET  /api/plugin           → { ok, entryId, enabled, phase, packageName? }
 *   POST /api/plugin           { action: "enable"|"disable"|"restart", packageName? } → { ok, applied, message }
 *   GET  /api/sources          → { ok, sources, active, latest }
 *   POST /api/sources/import   { text } → { ok, summary }
 *   POST /api/sources/export   → { ok, filename, text }
 *
 * 关于 /api/plugin：宿主没有「启用/禁用插件」的 HTTP 路由，唯一合法途径是插件管理器服务
 * （ctx.get("pluginManager") 的 setBundleEnabled / setPluginEnabled）。本模块只做委托调用，
 * 绝不自己读写 profile 的 cordis.patch.yml（B1）。服务不存在时返回
 *   { ok:false, error:{ code:"NO_PLUGIN_MANAGER", message:"当前 profile 没有挂载 plugin-manager" } }
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SettingsStore } from "./settings.js";
import { createClient } from "./supabase.js";
import { credentialPaths, readJson, writeJson } from "./source.js";

const ENTRY_BASE = "dsh-study-widget";
/** 允许被本模块操作/展示的插件 entry id 形状（include:<name>），防越权 */
const ENTRY_RE = /^include:[A-Za-z0-9._@/-]+$/;
const MAX_BODY = 512 * 1024;
const RESTART_GAP_MS = 300;

function errorJson(code, message, extra) {
  return { ok: false, error: Object.assign({ code: code, message: message }, extra || {}) };
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let text = "";
    let tooBig = false;
    req.on("data", function (chunk) {
      text += chunk;
      if (text.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", function () {
      if (tooBig) {
        const err = new Error("请求体太大（上限 " + MAX_BODY + " 字节）");
        err.code = "BODY_TOO_LARGE";
        reject(err);
        return;
      }
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
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

function packageNameOf(pkg) {
  return pkg && typeof pkg === "object" ? String(pkg.name || "") : "";
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * 把宿主 ChangeResult 归一到 { ok, applied, message, partial? }。
 * applied 保留宿主原文（字符串），ok 只表示「宿主没判失败」。
 */
function changeResultOf(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, applied: "failed", message: "插件管理器没有返回结果" };
  }
  const application = result.application || (result.error ? "failed" : "applied");
  const failed = application === "failed" || application === "cancelled";
  const err = result.error;
  const diagnostic = err ? String(err.diagnostic || err.message || err.code || "") : "";
  let message;
  if (application === "applied") message = "已生效";
  else if (application === "restart-required") {
    message = "已保存，重启 DSH 后生效" + (result.restartReason ? "（" + result.restartReason + "）" : "");
  } else if (application === "overridden") message = "已保存，但被更高优先级的层覆盖";
  else if (application === "cancelled") message = "操作已取消，文件已还原";
  else if (application === "failed") {
    // 最常见的失败就是「运行中不允许开关由 bundle 加载的插件」：把出路写清楚
    message =
      "当前宿主不允许在运行中开关由 bundle 加载的插件（" +
      (diagnostic || "failed") +
      "）。请到 DSH「设置 → 插件」里操作，或重启 DSH 后生效";
    if (diagnostic) message += "。宿主原文：" + diagnostic;
  } else message = String(application);
  return {
    ok: !failed,
    applied: application,
    message: String(message),
    changed: result.changed === undefined ? undefined : !!result.changed,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.source      StudySource 实例（读数据 / status()）
 * @param {object} deps.desktop     createDesktopLauncher 返回值
 * @param {object} [deps.pluginManager] ctx.get("pluginManager")，可为 undefined
 * @param {(res, code, payload) => void} deps.sendJson
 * @param {(res, code, text, type?) => void} [deps.sendText]
 * @param {(req, url) => boolean} [deps.authorized] 鉴权函数，缺省放行（index.js 已在外层鉴权）
 * @param {object} [deps.settings]  SettingsStore 实例（测试注入用）
 * @param {(opts) => object} [deps.createClient] 测试注入用
 */
export function createSettingsRoutes(deps) {
  const d = deps || {};
  const source = d.source;
  const desktop = d.desktop;
  const authorized = typeof d.authorized === "function" ? d.authorized : function () { return true; };
  let sendJson = d.sendJson;
  // 构造期绝不抛错：index.js 会在 try/catch 里建这个模块，一抛整个设置页就变 null。
  // sendJson 缺失只在真正处理请求时报出来（见下面的 fallbackSend）。
  const fallbackSend = function (res, statusCode, payload) {
    try {
      const text = JSON.stringify({
        ok: false,
        error: { code: "INTERNAL", message: "createSettingsRoutes 缺少 sendJson（接线错误）" },
        payload: payload && payload.ok === false ? payload : undefined,
      });
      res.writeHead(statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(text);
    } catch {
      /* 响应已经结束 */
    }
  };
  if (typeof sendJson !== "function") sendJson = fallbackSend;
  const sendText =
    typeof d.sendText === "function"
      ? d.sendText
      : function (res, code, text, type) {
          sendJson(res, code, { ok: false, error: { code: "TEXT", message: String(text) }, type: type || "" });
        };

  // 任何 store 形状都能用（只要 load/sanitize/save/raw 齐全）：宿主里 SettingsStore 可能是
  // 与测试不同的模块实例，instanceof 会跨模块触发 false，导致这里悄悄换成另一个目录的 store。
  const store =
    d.settings && typeof d.settings.load === "function" && typeof d.settings.save === "function"
      ? d.settings
      : new SettingsStore();
  const makeClient = typeof d.createClient === "function" ? d.createClient : createClient;

  /** 设置文件里的 ttl（秒）。读失败一律回落 30 秒，绝不让设置问题打挂数据接口 */
  async function ttlSeconds() {
    try {
      const view = await store.load();
      const value = view && view.refresh ? Number(view.refresh.summaryTtlSeconds) : NaN;
      if (!Number.isFinite(value) || value < 0) return 30;
      return value;
    } catch {
      return 30;
    }
  }

  /** 登录成功后拿到的最新 refresh token（不落盘也能在本次进程内复用，测试连接后按保存立即可用） */
  let liveRefreshToken = "";
  /** 最近一次插件开关的结论（只在进程内，重启即清） */
  let lastPluginNote = "";

  /** pluginManager 每次现取：服务可能晚于本插件挂载（lead 传函数也行） */
  function manager() {
    try {
      if (typeof d.pluginManager === "function") return d.pluginManager() || undefined;
      if (d.pluginManager) return d.pluginManager;
    } catch {
      return undefined;
    }
    return undefined;
  }

  // ---------- 组装响应 ----------

  function statusOf() {
    if (!source || typeof source.status !== "function") {
      return { ok: false, error: null, source: "", email: "", rev: 0, updatedAt: "", fetchedAt: 0, home: credentialPaths().home };
    }
    const s = source.status() || {};
    // online：最近一次读取有没有网络错误
    return Object.assign({}, s, { online: !s.error });
  }

  async function desktopSnapshot() {
    if (!desktop) {
      return { running: false, pinned: false, pinnedSource: "unknown", bounds: null, execPath: "", error: "桌面启动器不可用" };
    }
    let running = false;
    try {
      running = typeof desktop.alive === "function" ? !!desktop.alive() : false;
    } catch {
      running = false;
    }
    const base = { running: running, pinned: false, pinnedSource: "unknown", bounds: null, execPath: "", error: "" };

    // 1) 进程状态：status() 给 running / execPath / 最近一次错误
    try {
      if (typeof desktop.status === "function") {
        const st = desktop.status() || {};
        base.running = st.running === undefined ? running : !!st.running;
        base.execPath = st.execPath || "";
        base.error = st.error || "";
      }
    } catch {
      /* status 失败不影响其它字段 */
    }

    // 2) 聚合快照：desktop.info() 给 bounds / pinned / pinnedSource（缺了就看下面兜底）
    let info = null;
    try {
      if (typeof desktop.info === "function") info = (await desktop.info()) || null;
    } catch {
      info = null;
    }
    if (info) {
      if (info.running !== undefined) base.running = !!info.running;
      if (info.error !== undefined) base.error = info.error || "";
      if (info.bounds) base.bounds = info.bounds;
      if (typeof info.pinned === "boolean") {
        base.pinned = info.pinned;
        base.pinnedSource = info.pinnedSource || "settings";
      }
    }

    // 3) bounds 兜底：window.json（只认四个字段都是有限数的记录，否则当"未记录"）
    if (!base.bounds) {
      try {
        const saved = await readJson(credentialPaths().windowState);
        const nums = saved && ["x", "y", "width", "height"].every(function (k) {
          return Number.isFinite(Number(saved[k]));
        });
        base.bounds = nums
          ? { x: Number(saved.x), y: Number(saved.y), width: Number(saved.width), height: Number(saved.height) }
          : null;
      } catch {
        base.bounds = null;
      }
    }

    // 4) pinned 兜底：settings.json 的 desktop.alwaysOnTop（「上次保存的意图」）
    if (base.pinnedSource === "unknown") {
      try {
        const disk = await readJson(credentialPaths().settings);
        const value = disk && disk.desktop ? disk.desktop.alwaysOnTop : undefined;
        if (typeof value === "boolean") {
          base.pinned = value;
          base.pinnedSource = "settings";
        }
      } catch {
        /* 设置读不出来就保持 unknown */
      }
    }
    return base;
  }

  function pluginEntryId() {
    const candidates = [ENTRY_BASE, "@local/" + ENTRY_BASE];
    const explicit = d.entryId || d.packageName || "";
    if (explicit) candidates.unshift(String(explicit));
    return candidates.map(function (c) {
      return normalizeEntryId(c);
    })[0];
  }

  function normalizeEntryId(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return "";
    if (text.charAt(0) === "@") {
      const slash = text.indexOf("/");
      if (slash < 0) return "";
      return "include:" + text.slice(slash + 1);
    }
    if (text.indexOf("include:") === 0) return text;
    return "include:" + text;
  }

  async function pluginSnapshot() {
    const entryId = pluginEntryId();
    const pkg = packageNameOf(d.packageJson) || "@local/dsh-study-widget";
    const pm = manager();
    const out = { entryId: entryId, enabled: null, phase: null, packageName: pkg };
    // 设置页的「上次开关结果」：宿主对 include 行多半判 unaddressable，
    // 不把一次失败留成持久状态，只在这份快照里带一句提示，避免用户反复点。
    if (lastPluginNote) out.note = lastPluginNote;
    if (!pm || typeof pm.listPlugins !== "function") {
      out.note = "宿主未暴露 listPlugins";
      return out;
    }
    try {
      const rows = await pm.listPlugins();
      const list = Array.isArray(rows) ? rows : [];
      const mine =
        list.find(function (row) {
          return row && (row.entryId === entryId || row.entryId === ENTRY_BASE);
        }) ||
        list.find(function (row) {
          const moduleName = row && row.moduleName;
          return typeof moduleName === "string" && /dsh-study-widget$/.test(moduleName);
        });
      if (mine) {
        out.entryId = mine.entryId || entryId;
        out.enabled = !!mine.enabled;
        out.phase = mine.fiberPhase == null ? null : mine.fiberPhase;
      } else {
        out.note = "插件列表里没有找到本插件";
      }
    } catch (err) {
      out.note = "读取插件列表失败：" + String((err && err.message) || err);
    }
    return out;
  }

  async function settingsEnvelope() {
    const settings = await store.load();
    const [desk, plugin] = await Promise.all([desktopSnapshot(), pluginSnapshot()]);
    return { ok: true, settings: settings, status: statusOf(), desktop: desk, plugin: plugin };
  }

  // ---------- 数据源快照（导入 / 导出） ----------

  function looksLikeState(obj) {
    if (!obj || typeof obj !== "object") return false;
    return Array.isArray(obj.courses) || Array.isArray(obj.todos) || obj.activity !== undefined || obj.checkins !== undefined;
  }

  /** 从任意一份粘贴文本里认出一份 state：{ data, rev, updatedAt, origin } */
  function parseSnapshot(raw, depth) {
    const level = depth || 0;
    if (level > 3) return null;
    if (raw == null) return null;
    let value = raw;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return null;
      try {
        value = JSON.parse(text);
      } catch {
        return null;
      }
      return parseSnapshot(value, level + 1);
    }
    if (Array.isArray(value)) {
      // 网页版备份有的是数组套一层
      for (const item of value) {
        const hit = parseSnapshot(item, level + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    if (value.data && looksLikeState(value.data)) {
      return {
        data: value.data,
        rev: Number(value.rev) || 0,
        updatedAt: String(value.updated_at || value.updatedAt || value.syncedAt || ""),
        origin: "wrapped",
      };
    }
    if (looksLikeState(value)) {
      return {
        data: value,
        rev: Number(value.rev) || 0,
        updatedAt: String(value.updated_at || value.updatedAt || ""),
        origin: "bare",
      };
    }
    // 网页版撤销/版本列表常见 { snapshots: [...] } 或 { state: {...} }
    for (const key of ["state", "snapshot", "latest", "backup", "versions", "history"]) {
      if (value[key] !== undefined) {
        const hit = parseSnapshot(value[key], level + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** 这份 state 里「还没完成的待办」条数（导入摘要用） */
  function todoOpenOf(state) {
    const list = state && Array.isArray(state.todos) ? state.todos : [];
    return list.filter(function (t) {
      return t && !t.done && !t.doneAt;
    }).length;
  }

  function snapshotSummary(hit) {
    const state = (hit && hit.data) || {};
    const courses = Array.isArray(state.courses) ? state.courses.length : 0;
    const todos = Array.isArray(state.todos) ? state.todos.length : 0;
    const lessons = Array.isArray(state.courses)
      ? state.courses.reduce(function (acc, c) {
          return acc + (Array.isArray(c && c.lessons) ? c.lessons.length : 0);
        }, 0)
      : 0;
    return {
      rev: (hit && hit.rev) || 0,
      updatedAt: (hit && hit.updatedAt) || "",
      origin: (hit && hit.origin) || "",
      courses: courses,
      lessons: lessons,
      todos: todos,
      todoOpen: todoOpenOf(state),
      email: typeof state.email === "string" ? state.email : "",
      checkins: Array.isArray(state.checkins) ? state.checkins.length : 0,
      activityDays: state.activity && typeof state.activity === "object" ? Object.keys(state.activity).length : 0,
    };
  }

  const REQUIRED_TABLES = {
    courses: "course",
    lessons: "lesson",
    todos: "todo",
    activity: "activity",
    checkins: "checkin",
  };

  async function sourcesSnapshot() {
    const paths = credentialPaths();
    const latest = await readJson(paths.latest).catch(function () {
      return undefined;
    });
    const stateFile = await readJson(paths.state).catch(function () {
      return undefined;
    });
    const settings = await store.load();
    const configuredState = settings.data && settings.data.stateFile ? String(settings.data.stateFile) : "";
    const options = [];
    if (latest && latest.data) {
      options.push(
        Object.assign(
          { id: "latest", label: "上次同步的快照 latest.json", path: paths.latest, badge: "自动" },
          snapshotSummary({ data: latest.data, rev: latest.rev, updatedAt: latest.updatedAt || latest.syncedAt })
        )
      );
    }
    if (stateFile && stateFile.data) {
      options.push(
        Object.assign(
          { id: "state", label: "监听到的 state.json", path: paths.state, badge: "监听" },
          snapshotSummary({ data: stateFile.data, rev: stateFile.rev })
        )
      );
    }
    if (configuredState) {
      const custom = await readJson(path.resolve(configuredState)).catch(function () {
        return undefined;
      });
      const hit = parseSnapshot(custom);
      if (hit) {
        options.push(
          Object.assign(
            { id: "stateFile", label: "本地数据文件（设置里的 stateFile）", path: path.resolve(configuredState), badge: "设置" },
            snapshotSummary(hit)
          )
        );
      }
    }
    const active = settings.data && settings.data.stateFile ? "stateFile" : options.length ? options[0].id : "";
    const latestSummary = latest && latest.data
      ? Object.assign(
          { fetchedAt: latest.fetchedAt || latest.syncedAt || 0, source: latest.source || "", email: latest.email || "" },
          snapshotSummary({ data: latest.data, rev: latest.rev, updatedAt: latest.updatedAt || latest.syncedAt })
        )
      : null;
    return { sources: options, active: active, latest: latestSummary };
  }

  // ---------- 各端点 ----------

  async function handleSettings(req, res) {
    if (req.method === "GET" || req.method === "HEAD") {
      sendJson(res, 200, await settingsEnvelope());
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, errorJson("METHOD_NOT_ALLOWED", "只接受 GET / POST"));
      return true;
    }
    const body = await readBody(req);
    const partial = body && body.settings !== undefined ? body.settings : body;
    try {
      await store.save(partial);
    } catch (err) {
      const code = (err && err.code) || "SAVE_FAILED";
      const status = /^INVALID_|OUT_OF_RANGE/.test(code) ? 400 : 500;
      sendJson(
        res,
        status,
        errorJson(code, String((err && err.message) || err), { field: (err && err.field) || "" })
      );
      return true;
    }
    if (source && typeof source.reset === "function") {
      try {
        source.reset();
      } catch {
        /* 重置缓存失败不影响保存 */
      }
    }
    sendJson(res, 200, await settingsEnvelope());
    return true;
  }

  async function handleSettingsTest(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, errorJson("METHOD_NOT_ALLOWED", "只接受 POST"));
      return true;
    }
    const body = await readBody(req);
    const partial = body && body.settings !== undefined ? body.settings : body || {};
    let effective;
    let emailChanged = false;
    try {
      const delta = store.sanitize(partial);
      const base = store.raw();
      // 用「当前已保存 + 本次提交」拼出要测的凭据，不落盘
      effective = {
        url: delta.value.supabase.url !== undefined ? delta.value.supabase.url : base.supabase.url,
        anonKey: delta.value.supabase.anonKey !== undefined ? delta.value.supabase.anonKey : base.supabase.anonKey,
        email: delta.value.supabase.email !== undefined ? delta.value.supabase.email : base.supabase.email,
        password: delta.secret.password || base.supabase.password,
        // 换了邮箱就必须重新登录，不能拿旧账号的 refresh token 去续期
        refreshToken: "",
      };
      // 同一套凭据（url / anonKey / email 与已保存的一致）才复用 token；
      // 换了邮箱或项目地址就必须用提交的密码重新登录，不能拿旧账号的 token 续期
      const baseEmail = String(base.supabase.email || "");
      const baseUrl = String(base.supabase.url || "");
      const sameAccount =
        (!baseEmail || !effective.email || effective.email === baseEmail) &&
        (!baseUrl || !effective.url || effective.url === baseUrl) &&
        (!base.supabase.anonKey || !effective.anonKey || effective.anonKey === base.supabase.anonKey);
      emailChanged = !sameAccount;
      if (sameAccount) effective.refreshToken = liveRefreshToken || base.supabase.refreshToken;
    } catch (err) {
      sendJson(
        res,
        400,
        errorJson((err && err.code) || "INVALID_SETTINGS", String((err && err.message) || err), {
          field: (err && err.field) || "",
        })
      );
      return true;
    }
    if (!effective.url || !effective.anonKey) {
      sendJson(res, 200, {
        ok: false,
        error: { code: "NO_CREDENTIALS", message: "先填 Supabase URL 与 anonKey 再测试" },
        auth: { ok: false },
        data: { ok: false },
      });
      return true;
    }
    let client;
    try {
      client = makeClient(effective);
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        error: { code: (err && err.code) || "CLIENT_FAILED", message: String((err && err.message) || err) },
        auth: { ok: false },
        data: { ok: false },
      });
      return true;
    }
    let result;
    try {
      result = await client.testConnection();
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        error: { code: (err && err.code) || "TEST_FAILED", message: String((err && err.message) || err) },
        auth: { ok: false },
        data: { ok: false },
      });
      return true;
    }
    const ok = !!(result && result.auth && result.auth.ok && result.data && result.data.ok);
    const payload = { ok: ok, auth: result.auth, data: result.data };
    if (!ok) {
      const reason =
        (result.auth && !result.auth.ok && result.auth.message) ||
        (result.data && !result.data.ok && result.data.message) ||
        "测试失败";
      payload.error = {
        code: (result.auth && result.auth.ok ? result.data && result.data.code : result.auth.code) || "TEST_FAILED",
        message: reason,
        stage: result.auth && result.auth.ok ? "data" : "auth",
      };
    }
    // 登录成功顺手把 refresh token 记下来（密码只进不出，不回传）
    if (result && result.session && result.session.refreshToken) {
      liveRefreshToken = result.session.refreshToken;
      try {
        await store.saveTokens({ refreshToken: result.session.refreshToken, userId: result.session.userId });
      } catch {
        /* 写不进去也不影响测试结论 */
      }
    }
    sendJson(res, 200, payload);
    return true;
  }

  async function handleDesktop(req, res) {
    if (req.method === "GET" || req.method === "HEAD") {
      const snap = await desktopSnapshot();
      sendJson(
        res,
        200,
        Object.assign(
          {
            ok: !snap.error || snap.running,
            running: snap.running,
            pinned: snap.pinned,
            pinnedSource: snap.pinnedSource,
            bounds: snap.bounds,
            execPath: snap.execPath,
            error: snap.error || "",
          }
        )
      );
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, errorJson("METHOD_NOT_ALLOWED", "只接受 GET / POST"));
      return true;
    }
    const body = await readBody(req);
    const action = String((body && body.action) || "").trim();
    const value = body && body.value;
    if (["open", "close", "hide", "pin"].indexOf(action) === -1) {
      sendJson(res, 400, errorJson("INVALID_ACTION", "action 只能是 open / close / hide / pin"));
      return true;
    }
    if (!desktop) {
      sendJson(res, 200, {
        ok: false,
        error: { code: "NO_DESKTOP", message: "桌面启动器不可用" },
        desktop: await desktopSnapshot(),
      });
      return true;
    }
    let result;
    try {
      if (action === "open") result = await desktop.open();
      else if (action === "close") result = { ok: desktop.stop() };
      else if (action === "hide") {
        if (typeof desktop.hide === "function") {
          result = await desktop.hide();
        } else {
          // Host 进程 invoke 不到 Electron 的 ipcMain 通道，没有 hide 时退化成「关闭小窗」：
          // 位置已在窗口退出前写进 window.json，是无损的（desktop-hooks 确认）
          const closed = desktop.stop();
          result = { ok: true, applied: closed ? "closed" : "noop", message: "已关闭小窗（hide 通道不可用，位置已保存）" };
        }
      } else {
        const want = value === undefined ? true : !!value;
        if (typeof desktop.setPinned === "function") {
          result = await desktop.setPinned(want);
        } else {
          // 没有实时通道：把意图存进设置（desktop.alwaysOnTop），下次打开小窗生效
          const view = await store.load();
          if (view.desktop.alwaysOnTop === want) {
            result = { ok: true, applied: "persisted", message: "置顶设置本来就是" + (want ? "开" : "关") + "的，下次打开小窗生效" };
          } else {
            await store.save({ desktop: { alwaysOnTop: want } });
            result = {
              ok: true,
              applied: "persisted",
              message: "已保存置顶设置（" + (want ? "开" : "关") + "），下次打开小窗生效",
            };
          }
        }
      }
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        error: { code: "DESKTOP_FAILED", message: String((err && err.message) || err) },
        desktop: await desktopSnapshot(),
      });
      return true;
    }
    const ok = !result || result.ok !== false;
    const payload = { ok: ok, desktop: await desktopSnapshot() };
    if (result && result.reused !== undefined) payload.reused = !!result.reused;
    if (result && result.applied) payload.applied = result.applied;
    if (result && result.message) payload.message = String(result.message);
    if (!ok) {
      payload.error = {
        code: (result && result.code) || "DESKTOP_FAILED",
        message: (result && (result.error || result.message)) || "桌面窗口操作失败",
      };
    }
    sendJson(res, 200, payload);
    return true;
  }

  async function handlePlugin(req, res) {
    if (req.method === "GET" || req.method === "HEAD") {
      const snap = await pluginSnapshot();
      const payload = { ok: true, entryId: snap.entryId, enabled: snap.enabled, phase: snap.phase };
      if (snap.packageName) payload.packageName = snap.packageName;
      if (snap.note) payload.note = snap.note;
      sendJson(res, 200, payload);
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, errorJson("METHOD_NOT_ALLOWED", "只接受 GET / POST"));
      return true;
    }
    const body = await readBody(req);
    const action = String((body && body.action) || "").trim();
    if (["enable", "disable", "restart"].indexOf(action) === -1) {
      sendJson(res, 400, errorJson("INVALID_ACTION", "action 只能是 enable / disable / restart"));
      return true;
    }
    const pm = manager();
    if (!pm) {
      sendJson(res, 200, errorJson("NO_PLUGIN_MANAGER", "当前 profile 没有挂载 plugin-manager"));
      return true;
    }
    const requested = String((body && body.packageName) || "").trim();
    const useBundle = !!requested;
    let target = "";
    if (useBundle) {
      target = requested;
    } else {
      target = normalizeEntryId(pluginEntryId());
      if (!ENTRY_RE.test(target)) {
        sendJson(res, 400, errorJson("INVALID_ENTRY_ID", "entryId 形状不合法：" + target));
        return true;
      }
    }
    const method = useBundle ? "setBundleEnabled" : "setPluginEnabled";
    if (typeof pm[method] !== "function") {
      sendJson(
        res,
        200,
        errorJson("NO_PLUGIN_MANAGER", "宿主没有暴露 " + method + "，无法在设置页开关插件")
      );
      return true;
    }
    const call = async function (enabled) {
      const res = await pm[method](target, enabled);
      const normalized = changeResultOf(res);
      lastPluginNote = normalized.ok
        ? "上次" + (action === "restart" ? "重载" : enabled ? "启用" : "禁用") + "结果：" + normalized.applied
        : "上次" + (enabled ? "启用" : "禁用") + "失败（" + normalized.applied + "）：" + normalized.message;
      return res;
    };

    try {
      if (action === "restart") {
        // 先停再启；中间给宿主 300ms 消化（HMR / loader 重载），启动失败回滚到启用
        const off = changeResultOf(await call(false));
        if (!off.ok) {
          sendJson(res, 200, {
            ok: false,
            applied: off.applied,
            partial: true,
            message: "已尝试禁用但失败，插件仍在运行：" + off.message,
          });
          return true;
        }
        await sleep(RESTART_GAP_MS);
        let on;
        try {
          on = changeResultOf(await call(true));
        } catch (err) {
          on = { ok: false, applied: "failed", message: String((err && err.message) || err) };
        }
        if (!on.ok) {
          // 回滚：再尝试一次启用，保证插件不至于停着
          let rolled = "";
          try {
            const again = changeResultOf(await call(true));
            rolled = again.ok ? "（已回滚为启用）" : "（回滚也失败：" + again.message + "）";
          } catch (err) {
            rolled = "（回滚也失败：" + String((err && err.message) || err) + "）";
          }
          sendJson(res, 200, {
            ok: false,
            applied: on.applied,
            partial: true,
            message: "重载失败：" + on.message + rolled,
          });
          return true;
        }
        sendJson(res, 200, { ok: true, applied: on.applied, message: on.message === "已生效" ? "已重载" : on.message });
        return true;
      }
      const enabled = action === "enable";
      const result = changeResultOf(await call(enabled));
      const payload = { ok: result.ok, applied: result.applied, message: result.message };
      if (!result.ok) payload.error = { code: "PLUGIN_CHANGE_FAILED", message: result.message };
      sendJson(res, 200, payload);
      return true;
    } catch (err) {
      const code = (err && (err.code || err.name)) || "PLUGIN_CHANGE_FAILED";
      sendJson(res, 200, {
        ok: false,
        applied: "failed",
        message: String((err && err.message) || err),
        error: { code: String(code), message: String((err && err.message) || err) },
      });
      return true;
    }
  }

  async function handleSources(req, res, rel) {
    if (rel === "/api/sources" && (req.method === "GET" || req.method === "HEAD")) {
      const snap = await sourcesSnapshot();
      sendJson(res, 200, { ok: true, sources: snap.sources, active: snap.active, latest: snap.latest });
      return true;
    }
    if (rel === "/api/sources/export" && req.method === "POST") {
      const latest = await readJson(credentialPaths().latest).catch(function () {
        return undefined;
      });
      const hit = parseSnapshot(latest) || parseSnapshot(await readJson(credentialPaths().state).catch(function () {
        return undefined;
      }));
      if (!hit) {
        sendJson(res, 200, errorJson("NO_SNAPSHOT", "还没有可导出的快照：先在网页版同步一次，或导入一份备份"));
        return true;
      }
      const stamp = new Date();
      const pad = function (n) {
        return String(n).padStart(2, "0");
      };
      const filename =
        "study-dashboard-backup-" +
        stamp.getFullYear() +
        pad(stamp.getMonth() + 1) +
        pad(stamp.getDate()) +
        "-" +
        pad(stamp.getHours()) +
        pad(stamp.getMinutes()) +
        ".json";
      const text = JSON.stringify(hit.data, null, 2);
      sendJson(res, 200, { ok: true, filename: filename, text: text, summary: snapshotSummary(hit) });
      return true;
    }
    if (rel === "/api/sources/import" && req.method === "POST") {
      const body = await readBody(req);
      const hit = parseSnapshot(body && body.text !== undefined ? body.text : body);
      if (!hit) {
        sendJson(
          res,
          400,
          errorJson("BAD_SNAPSHOT", "认不出这份数据：需要 latest.json、网页版备份，或直接粘贴 state（含 courses/todos）")
        );
        return true;
      }
      // 校验已知集合，避免把乱码写进 latest.json 覆盖好数据
      const missing = Object.keys(REQUIRED_TABLES).filter(function (key) {
        return hit.data[key] === undefined;
      });
      if (missing.length === Object.keys(REQUIRED_TABLES).length) {
        sendJson(res, 400, errorJson("BAD_SNAPSHOT", "数据里没有任何已知字段（courses/todos/activity/checkins）"));
        return true;
      }
      const paths = credentialPaths();
      // 先备份旧快照（只留一份），再原子写
      try {
        const previous = await readJson(paths.latest);
        if (previous) await writeJson(paths.latest + ".bak", previous);
      } catch {
        /* 备份失败不阻塞导入 */
      }
      const record = {
        data: hit.data,
        rev: hit.rev || 0,
        source: "import",
        email: (hit.data && hit.data.email) || "",
        syncedAt: new Date().toISOString(),
        fetchedAt: Date.now(),
        importedAt: new Date().toISOString(),
      };
      await writeJson(paths.latest, record);
      if (source && typeof source.reset === "function") {
        try {
          source.reset();
        } catch {
          /* ignore */
        }
      }
      sendJson(res, 200, {
        ok: true,
        summary: Object.assign(snapshotSummary(hit), {
          missing: missing,
          savedTo: paths.latest,
          backup: paths.latest + ".bak",
        }),
      });
      return true;
    }
    if (rel === "/api/sources" || rel.indexOf("/api/sources/") === 0) {
      sendJson(res, 405, errorJson("METHOD_NOT_ALLOWED", "这个数据源接口不存在或方法不对"));
      return true;
    }
    return false;
  }

  /** @returns {Promise<boolean>} true = 已处理 */
  async function handle(req, res, rel, url) {
    const route = String(rel || "").split("?")[0];
    const isSettings = route === "/api/settings" || route === "/api/settings/test";
    const isDesktop = route === "/api/desktop";
    const isPlugin = route === "/api/plugin";
    const isSources = route === "/api/sources" || route.indexOf("/api/sources/") === 0;
    if (!isSettings && !isDesktop && !isPlugin && !isSources) return false;

    // index.js 已在外层鉴权；这里再做一次，便于模块单独挂载
    if (!authorized(req, url)) {
      sendJson(res, 401, errorJson("UNAUTHORIZED", "没有访问设置接口的权限"));
      return true;
    }

    try {
      if (route === "/api/settings") return await handleSettings(req, res);
      if (route === "/api/settings/test") return await handleSettingsTest(req, res);
      if (isDesktop) return await handleDesktop(req, res);
      if (isPlugin) return await handlePlugin(req, res);
      return await handleSources(req, res, route);
    } catch (err) {
      if (res.headersSent) return true;
      const code = (err && err.code) || "INTERNAL";
      const status = code === "BAD_JSON" ? 400 : code === "BODY_TOO_LARGE" ? 413 : 500;
      sendJson(res, status, errorJson(String(code), String((err && err.message) || err)));
      return true;
    }
  }

  // 暴露给 index.js 用（SUMMARY_TTL_MS 现在按设置里的 refresh.summaryTtlSeconds 走）
  handle.ttlSeconds = ttlSeconds;
  // 自证入口：lead 可以临时挂 /api/settings/ping 看模块实例是否新鲜、是否挂上
  handle.ping = function () {
    return { ok: true, routes: "settings", version: 2, ttl: typeof ttlSeconds === "function" };
  };
  handle.store = store;
  handle.snapshot = settingsEnvelope;
  return handle;
}

export { ENTRY_RE };
export default createSettingsRoutes;
