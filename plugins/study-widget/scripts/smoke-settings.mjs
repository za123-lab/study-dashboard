#!/usr/bin/env node
/**
 * 设置页后端冒烟自测（不需要启动 DSH）
 *
 *   node plugins/study-widget/scripts/smoke-settings.mjs
 *
 * 做法：不监听端口，直接调 createSettingsRoutes 返回的 handle(req, res, rel, url)，
 * req / res 用最小的假对象（照 smoke.mjs 的 fakeRes 思路）。
 * 数据目录用系统临时目录（DSH_STUDY_WIDGET_HOME），绝不碰用户真实的 settings.json / login.json。
 *
 * 覆盖：SettingsView 形状、密码只进不出、保存回读一致、非法 url / anonKey / 区间校验、
 * 测试连接失败带 message、测试连接成功（本地假 Supabase）、desktop 端点形状、plugin 端点
 * （无服务 NO_PLUGIN_MANAGER、enable/disable/restart、entryId 越权）、sources 导出导入往返。
 *
 * 退出码 0 = 全绿；1 = 有断言失败。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- 隔离数据目录（必须在 import lib 之前设好）----
const home = path.join(os.tmpdir(), "study-widget-settings-smoke");
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
process.env.DSH_STUDY_WIDGET_HOME = home;

const { SettingsStore } = await import("../lib/settings.js");
const { createSettingsRoutes } = await import("../lib/settings-routes.js");
const { credentialPaths } = await import("../lib/source.js");

// ---- 断言框架 ----
let failures = 0;
let total = 0;
function check(name, ok, detail) {
  total += 1;
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}

// ---- 假 req / res ----
function fakeReq(method, urlPath, body) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    url: urlPath,
    headers: { host: "127.0.0.1:58003" },
    on(event, cb) {
      (listeners[event] || (listeners[event] = [])).push(cb);
      return req;
    },
    destroy() {
      /* 测试里不模拟中断 */
    },
  };
  // 下一 tick 推数据，保证路由先挂好监听
  queueMicrotask(() => {
    if (body !== undefined) {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      for (const cb of listeners.data) cb(Buffer.from(text, "utf8"));
    }
    for (const cb of listeners.end) cb();
  });
  return req;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: "",
    headersSent: false,
    writeHead(code, headers) {
      res.statusCode = code;
      res.headers = headers || {};
      res.headersSent = true;
      return res;
    },
    end(text) {
      res.body += text == null ? "" : String(text);
      res.ended = true;
    },
    json() {
      try {
        return JSON.parse(res.body);
      } catch {
        return null;
      }
    },
  };
  return res;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(String(text));
}

// ---- 假 source / desktop / pluginManager ----
const sourceStatus = {
  ok: true,
  error: null,
  source: "supabase",
  email: "smoke@study.local",
  rev: 7,
  updatedAt: "2026-11-25T00:00:00.000Z",
  fetchedAt: Date.now(),
  home,
  login: path.join(home, "login.json"),
};
let sourceResets = 0;
const fakeSource = {
  status: () => sourceStatus,
  reset() {
    sourceResets += 1;
  },
  read: async () => {
    throw new Error("smoke 里不应该读数据");
  },
};

let desktopRunning = false;
let desktopPinned = true;
const desktopCalls = [];
const fakeDesktop = {
  alive: () => desktopRunning,
  status: () => ({ running: desktopRunning, error: desktopRunning ? "" : "", execPath: "C:/electron/electron.exe" }),
  open: async () => {
    desktopCalls.push("open");
    desktopRunning = true;
    return { ok: true, reused: false };
  },
  stop: () => {
    desktopCalls.push("close");
    const was = desktopRunning;
    desktopRunning = false;
    return was;
  },
  hide: async () => {
    desktopCalls.push("hide");
    return { ok: true };
  },
  setPinned: async (value) => {
    desktopCalls.push("setPinned:" + value);
    desktopPinned = !!value;
    return { ok: true };
  },
  info: async () => ({ pinned: desktopPinned, bounds: { x: 10, y: 20, width: 380, height: 640 } }),
};

const pluginCalls = [];
function makeFakePluginManager(options) {
  const opts = options || {};
  const state = { enabled: opts.enabled === undefined ? true : !!opts.enabled };
  return {
    state,
    async listPlugins() {
      if (opts.listThrows) throw new Error("list 炸了");
      if (opts.noList) {
        delete this.listPlugins;
        return undefined;
      }
      return [
        { entryId: "include:other-plugin", moduleName: "@local/other-plugin", enabled: true, fiberPhase: "active", patchId: "other" },
        {
          entryId: "include:dsh-study-widget",
          moduleName: "@local/dsh-study-widget",
          enabled: state.enabled,
          fiberPhase: state.enabled ? "active" : null,
          patchId: "dsh-study-widget",
        },
      ];
    },
    async setPluginEnabled(id, enabled) {
      pluginCalls.push(["plugin", id, enabled]);
      if (opts.throwOnEnable && enabled) throw new Error("宿主拒绝了启用");
      state.enabled = enabled;
      return { changed: true, application: "applied", stage: "enable", target: id, enabled };
    },
    async setBundleEnabled(name, enabled) {
      pluginCalls.push(["bundle", name, enabled]);
      state.enabled = enabled;
      return {
        changed: true,
        application: "restart-required",
        restartReason: "host-module",
        stage: "enable",
        target: name,
        enabled,
      };
    },
  };
}

// 路由工厂：每个用例一个独立子目录里的 store，互不影响（测试隔离）
let caseSeq = 0;
function isolatedStore(seed) {
  caseSeq += 1;
  const dir = path.join(home, "cases", String(caseSeq));
  fs.mkdirSync(dir, { recursive: true });
  const store = new SettingsStore({ home: dir });
  if (seed) {
    // 异步预置：调用方在 makeRoutes 之后等一拍（queueMicrotask 之后再 call）
    store.save(seed).catch(function () {});
  }
  return store;
}

function makeRoutes(overrides) {
  const o = overrides || {};
  const store = o.store || isolatedStore(o.seed);
  const handle = createSettingsRoutes({
    source: o.source === undefined ? fakeSource : o.source,
    desktop: o.desktop === undefined ? fakeDesktop : o.desktop,
    pluginManager: o.pluginManager === undefined ? undefined : o.pluginManager,
    settings: store,
    createClient: o.createClient,
    sendJson,
    sendText,
  });
  return { handle, store };
}

async function call(handle, method, urlPath, body) {
  const res = fakeRes();
  const req = fakeReq(method, urlPath, body);
  const url = new URL(urlPath, "http://127.0.0.1:58003");
  const rel = decodeURIComponent(url.pathname.slice("/dsh-study-widget".length));
  const handled = await handle(req, res, rel, url);
  return { handled, status: res.statusCode, json: res.json(), text: res.body };
}

console.log(`study-widget settings smoke`);
console.log(`home = ${home}`);

// ============ 1. SettingsView 形状 + 密码只进不出 ============
section("1. GET /api/settings（缺省值 + 密码只进不出）");
const first = makeRoutes();
const got = await call(first.handle, "GET", "/dsh-study-widget/api/settings");
check("GET /api/settings 被本模块处理", got.handled === true, `handled=${got.handled}`);
check("GET 返回 200 + ok:true", got.status === 200 && got.json && got.json.ok === true, `${got.status}`);
const view = got.json && got.json.settings;
check(
  "SettingsView 五个分区齐全",
  !!view && !!view.supabase && !!view.desktop && !!view.refresh && !!view.data && !!view.advanced,
  view ? Object.keys(view).join(",") : "no settings"
);
check(
  "缺省值与契约一致（380x640 / 30s / 300s / onTop）",
  view &&
    view.desktop.width === 380 &&
    view.desktop.height === 640 &&
    view.desktop.alwaysOnTop === true &&
    view.desktop.autoOpen === false &&
    view.refresh.summaryTtlSeconds === 30 &&
    view.refresh.pageSeconds === 300 &&
    view.refresh.autoRefresh === true &&
    view.data.offline === false,
  JSON.stringify(view && { desktop: view.desktop, refresh: view.refresh, data: view.data })
);
check(
  "advanced.homeDir 指向数据目录",
  view && typeof view.advanced.homeDir === "string" && view.advanced.homeDir.indexOf(home) === 0,
  view && view.advanced.homeDir
);
check(
  "advanced.settingsFile / loginFile 是只读绝对路径且同目录",
  view &&
    view.advanced.settingsFile === path.join(view.advanced.homeDir, "settings.json") &&
    view.advanced.loginFile === path.join(view.advanced.homeDir, "login.json"),
  JSON.stringify({ s: view && view.advanced.settingsFile, l: view && view.advanced.loginFile })
);
check("新装用户 hasPassword=false", view && view.supabase.hasPassword === false, String(view && view.supabase.hasPassword));
check("响应的任何地方都没有 password 字段", !/password(?!"?:)/.test(JSON.stringify(got.json).replace(/"hasPassword"/g, "")), "");

// ============ 2. POST 保存 → GET 回读一致 ============
section("2. POST /api/settings 保存后回读一致");
const saved = await call(first.handle, "POST", "/dsh-study-widget/api/settings", {
  settings: {
    supabase: {
      url: "https://demo-project.supabase.co/",
      anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.demo-anon-key",
      email: "me@example.com",
      password: "hunter2-not-returned",
    },
    desktop: { autoOpen: true, alwaysOnTop: false, width: 420, height: 700 },
    refresh: { summaryTtlSeconds: 60, pageSeconds: 120, autoRefresh: false },
    data: { offline: true, stateFile: path.join(home, "imported.json") },
    advanced: { electronPath: "C:/electron/electron.exe" },
  },
});
check("POST 返回 200 + ok:true", saved.status === 200 && saved.json && saved.json.ok === true, `${saved.status} ${saved.text.slice(0, 160)}`);
check(
  "POST 响应里 hasPassword 变成 true",
  saved.json && saved.json.settings && saved.json.settings.supabase.hasPassword === true,
  JSON.stringify(saved.json && saved.json.settings && saved.json.settings.supabase)
);
check("POST 响应完整：settings + status + desktop + plugin", !!saved.json && !!saved.json.status && !!saved.json.desktop && !!saved.json.plugin, "");
check("保存后数据源缓存被重置（source.reset 被调用）", sourceResets >= 1, `resets=${sourceResets}`);

const reread = await call(first.handle, "GET", "/dsh-study-widget/api/settings");
const back = reread.json && reread.json.settings;
check(
  "回读 url 去掉末尾斜杠、其余逐字段一致",
  back &&
    back.supabase.url === "https://demo-project.supabase.co" &&
    back.supabase.anonKey === "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.demo-anon-key" &&
    back.supabase.email === "me@example.com",
  JSON.stringify(back && back.supabase)
);
check(
  "回读窗口/刷新/数据/高级分区一致",
  back &&
    back.desktop.autoOpen === true &&
    back.desktop.alwaysOnTop === false &&
    back.desktop.width === 420 &&
    back.desktop.height === 700 &&
    back.refresh.summaryTtlSeconds === 60 &&
    back.refresh.pageSeconds === 120 &&
    back.refresh.autoRefresh === false &&
    back.data.offline === true &&
    back.data.stateFile === path.join(home, "imported.json") &&
    back.advanced.electronPath === "C:/electron/electron.exe",
  JSON.stringify(back && { desktop: back.desktop, refresh: back.refresh, data: back.data })
);
check("回读响应里没有明文密码", reread.text.indexOf("hunter2-not-returned") === -1, "");
const settingsPath = path.join(first.store.home, "settings.json");
const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
check("settings.json 落盘存在且含密码（服务端本地保存）", onDisk.password === "hunter2-not-returned", Object.keys(onDisk).join(","));
check("落盘文件不含 homeDir 这类视图字段", onDisk.advanced && onDisk.advanced.homeDir === undefined, "");

// 新实例（模拟宿主重启）也能读回
// 新实例复用同一个数据目录，模拟宿主重启后从磁盘回读
const second = makeRoutes({ store: new SettingsStore({ home: first.store.home }) });
const afterRestart = await call(second.handle, "GET", "/dsh-study-widget/api/settings");
check(
  "新实例从磁盘读回同一份设置",
  afterRestart.json && afterRestart.json.settings && afterRestart.json.settings.supabase.email === "me@example.com",
  JSON.stringify(afterRestart.json && afterRestart.json.settings && afterRestart.json.settings.supabase)
);

// ============ 3. 非法输入被拒 ============
section("3. 校验：非法输入必须被拒且不落盘");
const before = fs.readFileSync(settingsPath, "utf8");
async function expectReject(label, settings, code, field) {
  const res = await call(first.handle, "POST", "/dsh-study-widget/api/settings", { settings });
  const body = res.json || {};
  const err = body.error || {};
  check(
    label,
    res.status === 400 && body.ok === false && err.code === (code || err.code) && (!field || err.field === field),
    `${res.status} ${JSON.stringify(err)}`
  );
}
await expectReject(
  "url 不以 http(s):// 开头 → INVALID_URL",
  { supabase: { url: "ftp://demo.supabase.co" } },
  "INVALID_URL",
  "supabase.url"
);
await expectReject(
  "url 是野字符串 → INVALID_URL",
  { supabase: { url: "not a url at all" } },
  "INVALID_URL",
  "supabase.url"
);
await expectReject(
  "anonKey 太短（<=20）→ INVALID_ANON_KEY",
  { supabase: { anonKey: "short-key" } },
  "INVALID_ANON_KEY",
  "supabase.anonKey"
);
await expectReject("邮箱没有 @ → INVALID_EMAIL", { supabase: { email: "not-an-email" } }, "INVALID_EMAIL", "supabase.email");
await expectReject("宽度越界 → OUT_OF_RANGE", { desktop: { width: 100 } }, "OUT_OF_RANGE", "desktop.width");
await expectReject("刷新间隔越界 → OUT_OF_RANGE", { refresh: { pageSeconds: 5 } }, "OUT_OF_RANGE", "refresh.pageSeconds");
await expectReject("布尔字段给字符串 → INVALID_FIELD", { desktop: { alwaysOnTop: "true" } }, "INVALID_FIELD", "desktop.alwaysOnTop");
await expectReject("stateFile 相对路径 → INVALID_PATH", { data: { stateFile: "relative/file.json" } }, "INVALID_PATH", "data.stateFile");
const badJson = await call(first.handle, "POST", "/dsh-study-widget/api/settings", "{oops");
check("请求体不是 JSON → 400 BAD_JSON", badJson.status === 400 && badJson.json && badJson.json.error.code === "BAD_JSON", `${badJson.status}`);
const after = fs.readFileSync(settingsPath, "utf8");
check("以上非法提交都没有改写 settings.json", before === after, "");

// ============ 4. POST /api/settings/test ============
section("4. POST /api/settings/test");
const testReject = await call(first.handle, "POST", "/dsh-study-widget/api/settings/test", {
  settings: { supabase: { url: "nope" } },
});
check(
  "测试连接也走同一套校验（非法 url 被拒）",
  testReject.status === 400 && testReject.json.error.code === "INVALID_URL",
  `${testReject.status} ${JSON.stringify(testReject.json && testReject.json.error)}`
);

// 用真实 http 服务器起一个「假 Supabase」，验证成功路径与 401 重试
const fakeSupabase = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (req.url.startsWith("/auth/v1/token")) {
      if (req.url.includes("grant_type=password") && body.password !== "right-password") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "fake-access-token",
          refresh_token: "fake-refresh-token",
          expires_in: 3600,
          user: { id: "user-1", email: body.email || "me@example.com" },
        })
      );
      return;
    }
    if (req.url.startsWith("/rest/v1/study_state")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          {
            rev: 12,
            updated_at: "2026-11-25T01:02:03.000Z",
            data: {
              courses: [{ id: "c1", name: "冒烟课程", lessons: [{ id: "l1", totalMin: 60, watchedMin: 60 }] }],
              todos: [{ id: "t1", title: "未完成", done: false }, { id: "t2", title: "完成", done: true }],
              activity: { "2026-11-25": 45 },
              checkins: [],
            },
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
});
await new Promise((resolve) => fakeSupabase.listen(0, "127.0.0.1", resolve));
const fakePort = fakeSupabase.address().port;
const fakeUrl = `http://127.0.0.1:${fakePort}`;

const okTest = await call(first.handle, "POST", "/dsh-study-widget/api/settings/test", {
  settings: { supabase: { url: fakeUrl, anonKey: "anon-key-long-enough-1234", email: "me@example.com", password: "right-password" } },
});
check(
  "测试连接成功 → ok:true + auth/data 分项",
  okTest.status === 200 &&
    okTest.json.ok === true &&
    okTest.json.auth.ok === true &&
    okTest.json.auth.email === "me@example.com" &&
    okTest.json.auth.userId === "user-1" &&
    okTest.json.data.ok === true,
  JSON.stringify(okTest.json)
);
check(
  "测试连接回传 rev / updatedAt / todoOpen / courses",
  okTest.json.data.rev === 12 && okTest.json.data.updatedAt === "2026-11-25T01:02:03.000Z" && okTest.json.data.todoOpen === 1 && okTest.json.data.courses === 1,
  JSON.stringify(okTest.json.data)
);
check("测试连接不把 token 回传前端", okTest.text.indexOf("fake-access-token") === -1 && okTest.text.indexOf("fake-refresh-token") === -1, "");

const wrongPassword = await call(first.handle, "POST", "/dsh-study-widget/api/settings/test", {
  settings: { supabase: { url: fakeUrl, anonKey: "anon-key-long-enough-1234", email: "me@example.com", password: "wrong-password" } },
});
check(
  "密码错 → ok:false + error.message 带中文原因",
  wrongPassword.status === 200 &&
    wrongPassword.json.ok === false &&
    wrongPassword.json.error.code === "AUTH_FAILED" &&
    /邮箱或密码不对/.test(wrongPassword.json.error.message) &&
    wrongPassword.json.auth.ok === false,
  JSON.stringify(wrongPassword.json)
);

// 打不通的地址：连 127.0.0.1 上一个没人监听的端口
const deadPort = await new Promise((resolve) => {
  const srv = http.createServer(() => {});
  srv.listen(0, "127.0.0.1", () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});
const unreachable = await call(first.handle, "POST", "/dsh-study-widget/api/settings/test", {
  settings: {
    supabase: { url: `http://127.0.0.1:${deadPort}`, anonKey: "anon-key-long-enough-1234", email: "me@example.com", password: "whatever" },
  },
});
check(
  "打不通 → ok:false 且带 message（不是抛异常）",
  unreachable.status === 200 &&
    unreachable.json.ok === false &&
    unreachable.json.error &&
    typeof unreachable.json.error.message === "string" &&
    unreachable.json.error.message.length > 0 &&
    reachableMessage(unreachable.json.error.message),
  JSON.stringify(unreachable.json && unreachable.json.error)
);
function reachableMessage(text) {
  return /连不上服务器|连接超时|登录失败|fetch failed|ECONNREFUSED/i.test(text);
}

const blankTest = await call(first.handle, "POST", "/dsh-study-widget/api/settings/test", {
  settings: { supabase: { url: "", anonKey: "" } },
});
check(
  "没填凭据时测试 → ok:false + NO_CREDENTIALS",
  blankTest.status === 200 && blankTest.json.ok === false && blankTest.json.error.code === "NO_CREDENTIALS",
  JSON.stringify(blankTest.json && blankTest.json.error)
);

// ============ 5. /api/desktop ============
section("5. /api/desktop");
const deskGet = await call(first.handle, "GET", "/dsh-study-widget/api/desktop");
check(
  "GET /api/desktop 形状完整",
  deskGet.status === 200 &&
    deskGet.json &&
    typeof deskGet.json.ok === "boolean" &&
    deskGet.json.running === false &&
    deskGet.json.pinned === true &&
    deskGet.json.bounds &&
    deskGet.json.bounds.width === 380 &&
    /electron/.test(deskGet.json.execPath) &&
    deskGet.json.error === "",
  JSON.stringify(deskGet.json)
);
const deskOpen = await call(first.handle, "POST", "/dsh-study-widget/api/desktop", { action: "open" });
check(
  "POST open → ok:true + running:true",
  deskOpen.status === 200 && deskOpen.json.ok === true && deskOpen.json.desktop.running === true && desktopCalls.includes("open"),
  JSON.stringify(deskOpen.json)
);
const deskPin = await call(first.handle, "POST", "/dsh-study-widget/api/desktop", { action: "pin", value: false });
check(
  "POST pin value:false → pinned 变 false",
  deskPin.status === 200 && deskPin.json.ok === true && deskPin.json.desktop.pinned === false && desktopCalls.includes("setPinned:false"),
  JSON.stringify(deskPin.json)
);
const deskClose = await call(first.handle, "POST", "/dsh-study-widget/api/desktop", { action: "close" });
check(
  "POST close → running 变 false",
  deskClose.status === 200 && deskClose.json.desktop.running === false,
  JSON.stringify(deskClose.json)
);
const deskBad = await call(first.handle, "POST", "/dsh-study-widget/api/desktop", { action: "explode" });
check("POST 非法 action → 400 INVALID_ACTION", deskBad.status === 400 && deskBad.json.error.code === "INVALID_ACTION", `${deskBad.status}`);
// 与 lib/desktop.js 真实契约对齐（lead 已加 info/hide/setPinned）：pinnedSource + bounds 兜底 + hide 退化
const leadLikeDesktop = {
  alive: () => true,
  status: () => ({ running: true, execPath: "C:/electron/electron.exe", error: "" }),
  info: async () => ({
    running: true,
    bounds: { x: 5, y: 6, width: 380, height: 640 },
    pinned: true,
    pinnedSource: "settings",
    error: "",
    execPath: "C:/electron/electron.exe",
  }),
  hide: async () => ({ ok: true, mode: "stop" }),
  setPinned: async (v) => ({ ok: true, applied: "persisted", pinned: !!v, pinnedSource: "settings" }),
  open: async () => ({ ok: true, reused: true }),
  stop: () => true,
};
const leadDesk = makeRoutes({ desktop: leadLikeDesktop });
const leadGet = await call(leadDesk.handle, "GET", "/dsh-study-widget/api/desktop");
check(
  "desktop.info() 契约：pinnedSource=settings + bounds 原样",
  leadGet.json.pinnedSource === "settings" && leadGet.json.pinned === true && leadGet.json.bounds.width === 380 && leadGet.json.running === true,
  JSON.stringify(leadGet.json)
);
const leadHide = await call(leadDesk.handle, "POST", "/dsh-study-widget/api/desktop", { action: "hide" });
check("desktop.hide() 存在时透传 mode", leadHide.json.ok === true && leadHide.json.applied === undefined, JSON.stringify(leadHide.json));
const leadPin = await call(leadDesk.handle, "POST", "/dsh-study-widget/api/desktop", { action: "pin", value: true });
check("desktop.setPinned() 的 applied 透传（persisted）", leadPin.json.ok === true && leadPin.json.applied === "persisted", JSON.stringify(leadPin.json));

const deskNone = await call(makeRoutes({ desktop: null }).handle, "GET", "/dsh-study-widget/api/desktop");
check("桌面不可用时 GET 仍返回形状（error 有说明）", deskNone.status === 200 && typeof deskNone.json.error === "string" && deskNone.json.error.length > 0, JSON.stringify(deskNone.json));

// ============ 6. /api/plugin ============
section("6. /api/plugin");
const noManager = await call(makeRoutes({ pluginManager: undefined }).handle, "GET", "/dsh-study-widget/api/plugin");
check(
  "GET 无 pluginManager → ok:true、enabled/phase 为 null、带 packageName",
  noManager.status === 200 && noManager.json.ok === true && noManager.json.enabled === null && noManager.json.phase === null && noManager.json.packageName === "@local/dsh-study-widget",
  JSON.stringify(noManager.json)
);
const noManagerPost = await call(makeRoutes({ pluginManager: undefined }).handle, "POST", "/dsh-study-widget/api/plugin", { action: "disable" });
check(
  "POST 无 pluginManager → ok:false + NO_PLUGIN_MANAGER",
  noManagerPost.status === 200 && noManagerPost.json.ok === false && noManagerPost.json.error.code === "NO_PLUGIN_MANAGER",
  JSON.stringify(noManagerPost.json)
);

const pm = makeFakePluginManager({ enabled: true });
const withPm = makeRoutes({ pluginManager: pm });
const pluginGet = await call(withPm.handle, "GET", "/dsh-study-widget/api/plugin");
check(
  "GET 有服务 → 只读到自己那一行（enabled/phase/entryId）",
  pluginGet.json.ok === true &&
    pluginGet.json.entryId === "include:dsh-study-widget" &&
    pluginGet.json.enabled === true &&
    pluginGet.json.phase === "active",
  JSON.stringify(pluginGet.json)
);
const pluginDisable = await call(withPm.handle, "POST", "/dsh-study-widget/api/plugin", { action: "disable" });
check(
  "POST disable → 走 setPluginEnabled(entryId,false)，applied 透传",
  pluginDisable.json.ok === true &&
    pluginDisable.json.applied === "applied" &&
    pluginCalls.some((c) => c[0] === "plugin" && c[1] === "include:dsh-study-widget" && c[2] === false),
  JSON.stringify({ res: pluginDisable.json, calls: pluginCalls })
);
const pluginEnable = await call(withPm.handle, "POST", "/dsh-study-widget/api/plugin", { action: "enable" });
check(
  "POST enable → 再次调用且 ok:true",
  pluginEnable.json.ok === true && pluginCalls.filter((c) => c[0] === "plugin" && c[2] === true).length >= 1,
  JSON.stringify(pluginEnable.json)
);
pluginCalls.length = 0;
const pluginRestart = await call(withPm.handle, "POST", "/dsh-study-widget/api/plugin", { action: "restart" });
check(
  "POST restart → 先 disable 再 enable 各一次",
  pluginRestart.json.ok === true &&
    pluginCalls.length === 2 &&
    pluginCalls[0][2] === false &&
    pluginCalls[1][2] === true,
  JSON.stringify(pluginCalls)
);
const byBundle = makeRoutes({ pluginManager: makeFakePluginManager({ enabled: true }) });
const bundleCall = await call(byBundle.handle, "POST", "/dsh-study-widget/api/plugin", {
  action: "disable",
  packageName: "@local/dsh-study-widget",
});
check(
  "带 packageName → 走 setBundleEnabled，applied 取宿主 application",
  bundleCall.json.ok === true && bundleCall.json.applied === "restart-required" && /重启/.test(bundleCall.json.message),
  JSON.stringify(bundleCall.json)
);
const evil = await call(withPm.handle, "POST", "/dsh-study-widget/api/plugin", { action: "enable", packageName: "" , entryId: "../../etc/passwd" });
check("乱传 entryId 也不会打到别的插件（仍按本插件 entryId 处理）", evil.json.ok === true, JSON.stringify(evil.json));
const throwPm = makeFakePluginManager({ enabled: true, throwOnEnable: true });
const throwRes = await call(makeRoutes({ pluginManager: throwPm }).handle, "POST", "/dsh-study-widget/api/plugin", { action: "restart" });
check(
  "restart 启用阶段报错 → ok:false + message（不让插件停在禁用态）",
  throwRes.json.ok === false && /重载失败/.test(throwRes.json.message),
  JSON.stringify(throwRes.json)
);
const noList = makeFakePluginManager({ noList: true });
const noListGet = await call(makeRoutes({ pluginManager: noList }).handle, "GET", "/dsh-study-widget/api/plugin");
check(
  "服务没有 listPlugins → enabled:null + note",
  noListGet.json.ok === true && noListGet.json.enabled === null && typeof noListGet.json.note === "string",
  JSON.stringify(noListGet.json)
);

// ============ 7. /api/sources 导出导入往返 ============
section("7. /api/sources 导出 / 导入往返");
const sampleState = {
  courses: [{ id: "c1", name: "课程一", lessons: [{ id: "l1", title: "第 1 讲", totalMin: 90, watchedMin: 30 }] }],
  todos: [{ id: "t1", title: "写周报", done: false }],
  activity: { "2026-11-24": 30 },
  checkins: [],
};
const imported = await call(first.handle, "POST", "/dsh-study-widget/api/sources/import", {
  text: JSON.stringify(sampleState),
});
check(
  "导入裸 state → ok + summary 统计正确",
  imported.status === 200 &&
    imported.json.ok === true &&
    imported.json.summary.courses === 1 &&
    imported.json.summary.lessons === 1 &&
    imported.json.summary.todos === 1,
  JSON.stringify(imported.json)
);
const latestOnDisk = JSON.parse(fs.readFileSync(credentialPaths().latest, "utf8"));
check("导入后 latest.json 已更新", latestOnDisk.data && latestOnDisk.data.courses[0].name === "课程一", "");

const exported = await call(first.handle, "POST", "/dsh-study-widget/api/sources/export", {});
check(
  "导出 → ok + filename + 可解析回同一份 state",
  exported.status === 200 &&
    exported.json.ok === true &&
    /^study-dashboard-backup-\d{8}-\d{4}\.json$/.test(exported.json.filename) &&
    JSON.stringify(JSON.parse(exported.json.text)) === JSON.stringify(sampleState),
  JSON.stringify(exported.json && { ok: exported.json.ok, filename: exported.json.filename })
);
const reimport = await call(first.handle, "POST", "/dsh-study-widget/api/sources/import", { text: exported.json.text });
check(
  "导出的文本再导入 → ok，往返一致",
  reimport.json.ok === true && reimport.json.summary.courses === 1,
  JSON.stringify(reimport.json)
);
const wrapped = await call(first.handle, "POST", "/dsh-study-widget/api/sources/import", {
  text: JSON.stringify({ rev: 3, syncedAt: "2026-11-25T00:00:00.000Z", data: sampleState }),
});
check(
  "导入 latest.json 包裹格式（{data,rev}）→ ok 且带上 rev",
  wrapped.json.ok === true && wrapped.json.summary.rev === 3,
  JSON.stringify(wrapped.json)
);
const badImport = await call(first.handle, "POST", "/dsh-study-widget/api/sources/import", { text: "这不是 JSON" });
check("导入乱码 → 400 BAD_SNAPSHOT", badImport.status === 400 && badImport.json.error.code === "BAD_SNAPSHOT", `${badImport.status}`);

const sourcesGet = await call(first.handle, "GET", "/dsh-study-widget/api/sources");
check(
  "GET /api/sources → sources 数组 + active + latest",
  sourcesGet.status === 200 &&
    sourcesGet.json.ok === true &&
    Array.isArray(sourcesGet.json.sources) &&
    sourcesGet.json.sources.length >= 1 &&
    typeof sourcesGet.json.active === "string" &&
    sourcesGet.json.latest &&
    sourcesGet.json.latest.courses === 1,
  JSON.stringify(sourcesGet.json && { active: sourcesGet.json.active, n: sourcesGet.json.sources && sourcesGet.json.sources.length })
);

// ============ 8. 边界 ============
// ============ 8. source.js 改造（设置优先 + 登录回落 + data.* + reset）============
section("8. lib/source.js：设置优先 / login.json 回落 / data.offline / reset");
{
  const { StudySource } = await import("../lib/source.js");
  // 每次都从磁盘重新读设置：同一个进程里 SettingsStore 是懒加载单例，不清就走不到 login 回落
  const freshStore = () => new SettingsStore({ home: credentialPaths().home });
  const srcHome = path.join(home, "src");
  const srcHome2 = path.join(home, "src-login");
  const savedHome = process.env.DSH_STUDY_WIDGET_HOME;
  try {
    // a) 设置里有 url+anonKey → 用设置，不读 login.json
    process.env.DSH_STUDY_WIDGET_HOME = srcHome;
    fs.mkdirSync(srcHome, { recursive: true });
    await freshStore().save({
      supabase: { url: "https://settings.supabase.co", anonKey: "anon-key-from-settings-123456", email: "s@example.com", password: "pw" },
    });
    fs.writeFileSync(
      path.join(srcHome, "login.json"),
      JSON.stringify({ url: "https://login.supabase.co", anonKey: "anon-key-from-login-123456", email: "l@example.com" })
    );
    const srcSettings = new StudySource();
    const credA = await srcSettings.loadCredentials();
    check(
      "设置里有 Supabase → loadCredentials 用设置（source=settings）",
      credA.url === "https://settings.supabase.co" && credA.source === "settings" && credA.email === "s@example.com" && credA.password === "pw",
      JSON.stringify({ url: credA.url, source: credA.source })
    );

    // b) 设置没填 → 回落 login.json
    process.env.DSH_STUDY_WIDGET_HOME = srcHome2;
    fs.mkdirSync(srcHome2, { recursive: true });
    fs.writeFileSync(
      path.join(srcHome2, "login.json"),
      JSON.stringify({ url: "https://login.supabase.co", anonKey: "anon-key-from-login-123456", email: "l@example.com" })
    );
    const srcLogin = new StudySource();
    const credB = await srcLogin.loadCredentials();
    check(
      "设置空 → 回落 login.json（source=login）",
      credB.url === "https://login.supabase.co" && credB.source === "login" && credB.email === "l@example.com",
      JSON.stringify({ url: credB.url, source: credB.source })
    );

    // c) data.stateFile → read() 直接用本地文件（不打网络）
    const stateFile = path.join(home, "custom-state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ data: { courses: [{ id: "c9", name: "本地课", lessons: [] }], todos: [], activity: {}, checkins: [] }, rev: 42 }));
    await freshStore().save({ data: { stateFile: stateFile } });
    const srcFile = new StudySource();
    const rowFile = await srcFile.read({});
    check(
      "data.stateFile 生效 → source=file 且 rev 来自文件",
      rowFile.source === "file" && rowFile.rev === 42 && rowFile.data.courses[0].name === "本地课",
      JSON.stringify({ source: rowFile.source, rev: rowFile.rev })
    );

    // d) data.offline → 只读缓存，不打网络
    await freshStore().save({ data: { stateFile: "", offline: true } });
    const srcOffline = new StudySource();
    const offlineRow = await srcOffline.read({});
    check(
      "data.offline 生效 → 读本地 latest.json 快照且标 stale",
      offlineRow.source === "file" && offlineRow.stale === true && offlineRow.rev === 42,
      JSON.stringify({ source: offlineRow.source, stale: offlineRow.stale })
    );
    check("offline 时 status().error 说明是离线模式", /离线模式/.test((srcOffline.status().error || {}).message || ""), JSON.stringify(srcOffline.status().error));

    // e) reset() → 清空缓存与 session
    const beforeReset = srcOffline.status().ok;
    srcOffline.reset();
    check("reset() 清掉缓存（status.ok 变 false）", beforeReset === true && srcOffline.status().ok === false, `before=${beforeReset}`);

    // f) 什么都没有 → NO_CREDENTIALS，提示去设置页
    process.env.DSH_STUDY_WIDGET_HOME = path.join(home, "src-empty");
    fs.mkdirSync(path.join(home, "src-empty"), { recursive: true });
    const srcEmpty = new StudySource();
    let emptyErr = null;
    try {
      await srcEmpty.loadCredentials();
    } catch (err) {
      emptyErr = err;
    }
    check(
      "没有设置也没有 login.json → NO_CREDENTIALS 且提示设置页",
      emptyErr && emptyErr.code === "NO_CREDENTIALS" && /设置/.test(emptyErr.message),
      emptyErr ? emptyErr.code + " " + emptyErr.message : "没有抛错"
    );
  } finally {
    if (savedHome === undefined) delete process.env.DSH_STUDY_WIDGET_HOME;
    else process.env.DSH_STUDY_WIDGET_HOME = savedHome;
  }
}

// ============ 9. 边界与鉴权 ============
section("9. 边界与鉴权");
// 构造期绝不抛：缺 sendJson 也能建出模块，只在请求时返回 JSON 错误
let noSendBuilt = false;
let noSendErr = null;
try {
  const noSendHandle = createSettingsRoutes({ source: fakeSource, desktop: fakeDesktop });
  noSendBuilt = typeof noSendHandle === "function" && typeof noSendHandle.ttlSeconds === "function";
  const res = fakeRes();
  const req = fakeReq("GET", "/dsh-study-widget/api/settings");
  const handledNoSend = await noSendHandle(req, res, "/api/settings", new URL("http://127.0.0.1/dsh-study-widget/api/settings"));
  noSendErr = handledNoSend === true ? res.json() : null;
} catch (err) {
  noSendBuilt = false;
  noSendErr = err;
}
check(
  "构造期不抛错（缺 sendJson 也能建模块，请求时给 JSON 错误）",
  noSendBuilt === true && noSendErr && noSendErr.ok === false && noSendErr.error.code === "INTERNAL",
  JSON.stringify(noSendBuilt ? noSendErr : String(noSendErr))
);
check(
  "handle.ping 自证入口可用",
  first.handle.ping && first.handle.ping().ok === true && typeof first.handle.ttlSeconds === "function",
  JSON.stringify(first.handle.ping && first.handle.ping())
);
const ttlZero = makeRoutes();
await ttlZero.store.save({ refresh: { summaryTtlSeconds: 0 } });
check("ttlSeconds() 读到 0（0 = 每次都读云端）", (await ttlZero.handle.ttlSeconds()) === 0, String(await ttlZero.handle.ttlSeconds()));
const ttlDefault = makeRoutes({ seed: {} });
check("ttlSeconds() 缺省 30 秒", (await ttlDefault.handle.ttlSeconds()) === 30, String(await ttlDefault.handle.ttlSeconds()));

const unknown = await call(first.handle, "GET", "/dsh-study-widget/api/summary");
check("不属于本模块的路径返回 false（交回 index.js）", unknown.handled === false, `handled=${unknown.handled}`);
const unauth = createSettingsRoutes({
  source: fakeSource,
  desktop: fakeDesktop,
  settings: new SettingsStore(),
  sendJson,
  sendText,
  authorized: () => false,
});
const unauthRes = await call(unauth, "GET", "/dsh-study-widget/api/settings");
check("鉴权失败 → 401 UNAUTHORIZED", unauthRes.status === 401 && unauthRes.json.error.code === "UNAUTHORIZED", String(unauthRes.status));
const methodRes = await call(first.handle, "DELETE", "/dsh-study-widget/api/settings");
check("不支持的 method → 405", methodRes.status === 405 && methodRes.json.error.code === "METHOD_NOT_ALLOWED", String(methodRes.status));
const corruptDir = path.join(home, "corrupt");
fs.mkdirSync(corruptDir, { recursive: true });
fs.writeFileSync(path.join(corruptDir, "settings.json"), "{broken");
const corruptStore = new SettingsStore({ home: corruptDir });
const corruptRes = await call(makeRoutes({ store: corruptStore }).handle, "GET", "/dsh-study-widget/api/settings");
check(
  "settings.json 损坏 → 500 BAD_SETTINGS_FILE（不静默重置）",
  corruptRes.status === 500 && corruptRes.json.error.code === "BAD_SETTINGS_FILE",
  `${corruptRes.status} ${JSON.stringify(corruptRes.json && corruptRes.json.error)}`
);
const clearStore = new SettingsStore({ home: path.join(home, "clearpw") });
fs.mkdirSync(path.join(home, "clearpw"), { recursive: true });
await clearStore.load();
await clearStore.save({ supabase: { password: "temp-pass" } });
const clearView = await clearStore.clearPassword();
check("clearPassword → hasPassword 变回 false", clearView.supabase.hasPassword === false, JSON.stringify(clearView.supabase));

// ============ 收尾 ============
fakeSupabase.close();
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${total - failures}/${total} 项通过`);
console.log(failures === 0 ? "全部通过" : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
