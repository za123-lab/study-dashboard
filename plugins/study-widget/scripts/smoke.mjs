#!/usr/bin/env node
/**
 * study-widget 冒烟自测（不需要启动 DSH）
 *
 *   node plugins/study-widget/scripts/smoke.mjs [--port 39117]
 *
 * 做法：用一组最小假 ctx（logger / effect / webServer / tools / commands）
 * 把 index.js 的 apply() 跑起来，真的监听一个 HTTP 端口，然后依次请求
 * 页面、样式、脚本、图标和各个 /api 接口，核对状态码与关键字段。
 *
 * 数据侧用系统临时目录作为 DSH_STUDY_WIDGET_HOME，写一份演示快照，
 * 不碰用户真实的 login.json / latest.json。
 *
 * 退出码 0 = 全绿；1 = 有断言失败。
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const portArg = process.argv.indexOf("--port");
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 39117;

function pad(n) {
  return String(n).padStart(2, "0");
}
function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// 与网页版一致：待办用 due(YYYY-MM-DD) + dueTime(HH:MM) 两段表示截止时刻

// 隔离的数据目录：复制一份演示快照，别碰用户真实凭据
const home = path.join(os.tmpdir(), "study-widget-smoke");
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "latest.json"),
  JSON.stringify({
    rev: 7,
    source: "supabase",
    email: "smoke@study.local",
    syncedAt: new Date().toISOString(),
    data: {
      activity: { [dayKey(0)]: 45, [dayKey(-1)]: 30, [dayKey(-2)]: 20 },
      courses: [
        {
          id: "c1",
          name: "冒烟课程",
          lessons: [
            { id: "l1", title: "第 1 讲", totalMin: 60, watchedMin: 60 },
            { id: "l2", title: "第 2 讲", totalMin: 60, watchedMin: 30 },
          ],
        },
      ],
      todos: [
        { id: "t1", title: "逾期任务", done: false, pri: "P1", cat: "course", due: dayKey(-1), dueTime: "09:00" },
        { id: "t2", title: "已完成任务", done: true, doneAt: Date.now() },
      ],
      checkins: [],
    },
  }),
);
process.env.DSH_STUDY_WIDGET_HOME = home;

// ---- 假宿主 ----
const routes = [];
const disposers = [];
function track(fn) {
  const dispose = fn();
  if (typeof dispose === "function") disposers.push(dispose);
}
const fakeCtx = {
  logger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: console.error }),
  effect: track,
  webServer: {
    register(route) {
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i > -1) routes.splice(i, 1);
      };
    },
    getOrigin() {
      // autoOpen 要等「拿得到地址」才开窗；这里给个假 origin 让自动开窗流程也能跑通
      return `http://127.0.0.1:${PORT}`;
    },
  },
  inject(services, cb) {
    if (services.includes("tools")) cb({ effect: track, tools: { register: (tool) => tool } });
    // 与真实宿主一致：webServer 已在 get() 里可见，依赖满足立即回调
    if (services.includes("webServer")) cb({ effect: track, webServer: fakeCtx.webServer });
  },
  get(service) {
    if (service === "webServer") return fakeCtx.webServer;
    if (service === "commands") return { register: (cmd) => cmd };
    return undefined;
  },
};

const mod = await import("../index.js");
mod.apply(fakeCtx, {});

const route = routes[0];
const handler = typeof route === "function" ? route : route && route.handler;
if (typeof handler !== "function") {
  console.error("插件没有注册 HTTP 路由（webServer.register 未被调用）");
  process.exit(1);
}
console.log(`路由 ${route.kind} ${route.path}`);

// ---- 真 HTTP 服务器：把请求转给插件路由 ----
const server = http.createServer((req, res) => {
  try {
    handler(req, res);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err && err.message));
  }
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

function request(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, method: "GET", path: urlPath },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
            bytes: Buffer.concat(chunks).length,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function json(res) {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

console.log(`study-widget smoke @ http://127.0.0.1:${PORT}`);
console.log(`home = ${home}\n`);

const page = await request("/dsh-study-widget/");
check("页面 200 + text/html", page.status === 200 && /text\/html/.test(page.headers["content-type"] || ""), `${page.status} ${page.headers["content-type"]}`);

const css = await request("/dsh-study-widget/widget.css");
check("样式 200", css.status === 200 && css.text.includes("--sw"), `${css.status} ${css.bytes}B`);

const js = await request("/dsh-study-widget/widget.js");
check("脚本 200", js.status === 200 && js.bytes > 1000, `${js.status} ${js.bytes}B`);

const icon = await request("/dsh-study-widget/icon.png");
check("图标 200 + image/png", icon.status === 200 && /image\/png/.test(icon.headers["content-type"] || ""), `${icon.status} ${icon.bytes}B`);

const summaryRes = await request("/dsh-study-widget/api/summary");
const envelope = json(summaryRes);
const summary = envelope && envelope.summary;
check("摘要 200 且 ok", summaryRes.status === 200 && envelope?.ok === true, `${summaryRes.status} ${summaryRes.text.slice(0, 160)}`);
check("摘要回落缓存 latest.json", summary?.source === "supabase" && summary?.rev === 7, `source=${summary?.source} rev=${summary?.rev}`);
check("总进度按课时计算 75% 1/2", summary?.overall?.pct === 75 && summary?.overall?.doneLessons === 1, `${summary?.overall?.pct}% ${summary?.overall?.doneLessons}/${summary?.overall?.count}`);
check("待办逾期被识别", summary?.counts?.overdue === 1, JSON.stringify(summary?.counts));
check("已完成待办计数", summary?.today?.todosDone === 1, `todosDone=${summary?.today?.todosDone}`);
check("今日学习 45 分钟", summary?.today?.min === 45, `min=${summary?.today?.min}`);
check("热力图 70 格", summary?.heat?.cells?.length === 70, `${summary?.heat?.cells?.length} 格`);
check("课程/课时结构完整", summary?.courses?.[0]?.lessons?.length === 2, `${summary?.courses?.length} 门课`);

const statusRes = await request("/dsh-study-widget/api/status");
check("状态接口 200 + 含 login.json", statusRes.status === 200 && /login\.json/.test(statusRes.text), String(statusRes.status));

const missing = await request("/dsh-study-widget/api/nope");
check("未知接口 404", missing.status === 404, String(missing.status));

// ?.被正规化成目录后落到静态白名单，取不到包根目录的源码（返回 404 或页面本体，都不是 package.json）
const bar = await request("/dsh-study-widget/../package.json");
check("越权路径不泄露源码", bar.status === 404 || !/"name"\s*:\s*"@local/.test(bar.text), `${bar.status} ${bar.text.slice(0, 80)}`);

// ---- 收尾 ----
await new Promise((resolve) => server.close(resolve));
for (const dispose of disposers) {
  try {
    dispose();
  } catch {
    /* 清理失败不影响结论 */
  }
}
fs.rmSync(home, { recursive: true, force: true });

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
