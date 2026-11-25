/**
 * 数据源：按网页端的优先级读取整份进度。
 *
 *   1. 手工指定的本地文件（pluginConfig.stateFile）—— 便于离线/调试
 *   2. Supabase：Auth 登录 → PostgREST 读自己那一行（与网页端同一套协议）
 *   3. 上一次成功读到的快照（磁盘缓存，断网时兜底）
 *
 * 顺序与网页端一致：本机优先，云端其次；本插件只读，不写云端。
 *
 * 凭据文件（默认 ~/.dsh/study-widget/login.json，可用 DSH_STUDY_WIDGET_HOME 改根目录）：
 *   {
 *     "url": "https://xxxx.supabase.co",
 *     "anonKey": "eyJ...",
 *     "email": "you@example.com",
 *     "password": "••••••"
 *   }
 * 也支持直接用 accessToken / refreshToken（网页端 localStorage 里那份），
 * 以及 robots-friendly 的 "passwordCommand"（执行命令取密码）。
 */
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TIMEOUT_MS = 15000;

export function widgetHome() {
  const fromEnv = process.env.DSH_STUDY_WIDGET_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  const root = dshHome ? path.resolve(dshHome) : path.join(os.homedir() || process.cwd(), ".dsh");
  return path.join(root, "study-widget");
}

export function credentialPaths() {
  const home = widgetHome();
  return {
    home,
    login: path.join(home, "login.json"),
    state: path.join(home, "state.json"),
    latest: path.join(home, "latest.json"),
    windowState: path.join(home, "window.json"),
  };
}

async function readJson(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return undefined;
    throw err;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function removeFile(file) {
  try {
    await fs.unlink(file);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
}

function normalizeUrl(raw) {
  let url = String(raw == null ? "" : raw).trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

function authErrorText(status, text) {
  const s = String(text || "");
  if (/invalid login credentials/i.test(s)) return "邮箱或密码不对";
  if (/email not confirmed/i.test(s)) return "邮箱还没验证：请在 Supabase 控制台确认这个用户";
  if (/invalid refresh token|refresh token.*(expired|not found)/i.test(s)) return "登录已过期，请重新登录";
  if (status === 429) return "尝试太频繁，等几分钟再试";
  if (status === 404) return "接口地址不对：检查 Supabase 项目 URL";
  return "登录失败：" + (s || "HTTP " + status);
}

function restErrorText(status, body) {
  if (body && body.code === "42P01") return "云端还没有建表：请先执行 supabase/schema.sql";
  if (body && body.code === "42501") return "没有权限：确认 schema.sql 里的 RLS 策略已执行";
  if (status === 401) return "登录已失效";
  if (status === 403) return "没有权限读取自己的数据（检查 RLS 策略）";
  const detail = (body && (body.msg || body.message || body.details || body.hint)) || "";
  return detail || "HTTP " + status;
}

async function timedFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function passwordFrom(cred) {
  if (typeof cred.password === "string" && cred.password) return cred.password;
  const cmd = cred.passwordCommand;
  if (!cmd) return "";
  return new Promise(function (resolve, reject) {
    const child = nodeSpawn(cmd, { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", function (chunk) {
      out += String(chunk);
    });
    child.on("error", reject);
    child.on("close", function () {
      resolve(out.replace(/\r?\n$/, "").trim());
    });
  });
}

function sessionFromAuth(body) {
  if (!body || typeof body.access_token !== "string" || !body.user) {
    throw new Error("登录响应不完整，没有拿到 token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : "",
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    userId: String(body.user.id || ""),
    email: String(body.user.email || ""),
  };
}

export class StudySource {
  constructor() {
    this.session = null;
    this.cache = null; // { data, rev, updatedAt, source, email, fetchedAt }
    this.lastError = null;
  }

  async loadCredentials() {
    const paths = credentialPaths();
    const cred = await readJson(paths.login);
    if (!cred || typeof cred !== "object") {
      const err = new Error(
        "还没有配置 Supabase 登录信息。请在 " + paths.login + " 填写 { url, anonKey, email, password }。"
      );
      err.code = "NO_CREDENTIALS";
      err.path = paths.login;
      throw err;
    }
    const url = normalizeUrl(cred.url);
    const anonKey = String(cred.anonKey || "").trim();
    if (!url || !anonKey) {
      const err = new Error("凭据文件缺少 url 或 anonKey：" + paths.login);
      err.code = "BAD_CREDENTIALS";
      err.path = paths.login;
      throw err;
    }
    return { url, anonKey, email: cred.email || "", raw: cred };
  }

  async authenticate(cred) {
    if (this.session && this.session.url === cred.url && this.session.expiresAt - 120000 > Date.now()) {
      return this.session;
    }
    if (
      this.session &&
      this.session.url === cred.url &&
      this.session.refreshToken &&
      this.session.userId
    ) {
      try {
        return await this.refresh(cred, this.session.refreshToken);
      } catch {
        this.session = null;
      }
    }
    const password = await passwordFrom(cred.raw);
    if (!password) {
      const err = new Error("凭据文件里没有 password（或 passwordCommand 没输出密码）");
      err.code = "NO_PASSWORD";
      throw err;
    }
    const res = await timedFetch(cred.url + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: cred.anonKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: cred.email, password }),
    });
    const body = await readBody(res);
    if (!res.ok) {
      const err = new Error(authErrorText(res.status, body && (body.msg || body.error_description || body.error || body.message)));
      err.code = "AUTH_FAILED";
      throw err;
    }
    const session = sessionFromAuth(body);
    session.url = cred.url;
    session.anonKey = cred.anonKey;
    this.session = session;
    await this.persistSession(cred, session);
    return session;
  }

  async persistSession(cred, session) {
    // 只把 refresh token 存回去，避免密码折腾；文件不存在就新建
    try {
      const paths = credentialPaths();
      const existing = (await readJson(paths.login)) || {};
      await writeJson(paths.login, Object.assign({}, existing, { refreshToken: session.refreshToken }));
    } catch {
      /* 凭据文件只读时忽略：下次用密码重新登录 */
    }
  }

  async refresh(cred, refreshToken) {
    const res = await timedFetch(cred.url + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { apikey: cred.anonKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const body = await readBody(res);
    if (!res.ok) {
      const err = new Error(authErrorText(res.status, body && (body.msg || body.error_description || body.message)));
      err.code = "REFRESH_FAILED";
      throw err;
    }
    const session = sessionFromAuth(body);
    session.url = cred.url;
    session.anonKey = cred.anonKey;
    this.session = session;
    await this.persistSession(cred, session);
    return session;
  }

  async fetchRemote(cred) {
    let session = await this.authenticate(cred);
    const request = async function () {
      return timedFetch(
        cred.url +
          "/rest/v1/study_state?user_id=eq." +
          encodeURIComponent(session.userId) +
          "&select=data,rev,updated_at",
        {
          method: "GET",
          headers: {
            apikey: cred.anonKey,
            Authorization: "Bearer " + session.accessToken,
            Accept: "application/json",
          },
        }
      );
    };
    let res = await request();
    if (res.status === 401 && session.refreshToken) {
      session = await this.refresh(cred, session.refreshToken);
      res = await request();
    }
    if (!res.ok) {
      const body = await readBody(res);
      const err = new Error(restErrorText(res.status, body));
      err.code = "REST_FAILED";
      throw err;
    }
    const rows = await readBody(res);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.data) {
      const err = new Error("云端还没有进度数据（先在网页端开启云同步推一次）");
      err.code = "EMPTY_REMOTE";
      throw err;
    }
    return { data: row.data, rev: row.rev || 0, updatedAt: row.updated_at || "", email: session.email };
  }

  /** 读取一次最新数据；成功时写缓存，失败时回退到缓存 */
  async read(config) {
    const cfg = config || {};
    const paths = credentialPaths();

    if (cfg.stateFile) {
      const raw = await readJson(path.resolve(cfg.stateFile));
      if (raw) {
        const data = raw && raw.data && !raw.courses ? raw.data : raw;
        this.cache = {
          data,
          rev: Number(raw && raw.rev) || 0,
          updatedAt: raw && raw.updated_at ? raw.updated_at : "",
          source: "file",
          email: "",
          fetchedAt: Date.now(),
          file: path.resolve(cfg.stateFile),
        };
        this.lastError = null;
        await writeJson(paths.latest, this.cache).catch(function () {});
        return this.cache;
      }
    }

    if (cfg.offline) {
      return this.fromCache(new Error("离线模式（offline=true），只显示上一次读到的数据"));
    }

    // 没有凭据时不去打网络：直接显示磁盘缓存的上一份快照，并把「怎么配置」当成提示
    try {
      const cred = await this.loadCredentials();
      const remote = await this.fetchRemote(cred);
      this.cache = {
        data: remote.data,
        rev: remote.rev,
        updatedAt: remote.updatedAt,
        source: "supabase",
        email: remote.email,
        fetchedAt: Date.now(),
      };
      this.lastError = null;
      await writeJson(paths.latest, this.cache).catch(function () {});
      return this.cache;
    } catch (err) {
      this.lastError = err;
      if (this.cache) return this.cache;
      const disk = await readJson(paths.latest).catch(function () {
        return undefined;
      });
      if (disk && disk.data) {
        this.cache = Object.assign({ stale: true, hint: err.code || "" }, disk);
        return this.cache;
      }
      throw err;
    }
  }

  async fromCache(err) {
    this.lastError = err;
    if (this.cache) return this.cache;
    const paths = credentialPaths();
    const disk = await readJson(paths.latest).catch(function () {
      return undefined;
    });
    if (disk && disk.data) {
      this.cache = Object.assign({ stale: true }, disk);
      return this.cache;
    }
    throw err;
  }

  status() {
    const paths = credentialPaths();
    return {
      ok: !!this.cache,
      error: this.lastError
        ? { code: this.lastError.code || "ERROR", message: this.lastError.message, path: this.lastError.path || "" }
        : null,
      source: this.cache ? this.cache.source : "",
      email: this.cache ? this.cache.email : "",
      rev: this.cache ? this.cache.rev : 0,
      updatedAt: this.cache ? this.cache.updatedAt : "",
      fetchedAt: this.cache ? this.cache.fetchedAt : 0,
      home: paths.home,
      login: paths.login,
    };
  }
}

export { readJson, writeJson, removeFile, credentialPaths as paths };
