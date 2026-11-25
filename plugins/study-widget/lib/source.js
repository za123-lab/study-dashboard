/**
 * 数据源：按网页端的优先级读取整份进度。
 *
 *   1. 手工指定的本地文件（设置里的 data.stateFile，或 pluginConfig.stateFile）—— 便于离线/调试
 *   2. Supabase：Auth 登录 → PostgREST 读自己那一行（与网页端同一套协议）
 *   3. 上一次成功读到的快照（磁盘缓存 latest.json，断网时兜底）
 *
 * 顺序与网页端一致：本机优先，云端其次；本插件只读，不写云端。
 *
 * 凭据来源（两处，设置优先）：
 *   a. 设置文件 ~/.dsh/study-widget/settings.json 的 supabase 分区（设置页填的，含 password）
 *   b. 老式凭据文件 ~/.dsh/study-widget/login.json（手工写的；决定迁移后仍可继续用）
 *   两边都没有时会提示「去设置页填 Supabase」。
 *
 * login.json 结构（向下兼容，仍可用）：
 *   { "url": "https://xxxx.supabase.co", "anonKey": "eyJ...", "email": "you@example.com", "password": "••••••" }
 * 也支持 accessToken / refreshToken（网页端 localStorage 里那份）、passwordCommand（执行命令取密码）。
 *
 * 根目录可用 DSH_STUDY_WIDGET_HOME 改；state.json 是网页端「监听本地文件」那条链路留下的快照。
 */
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createClient } from "./supabase.js";

/** 凭据/Http 细节统一走 lib/supabase.js，这里只做「读哪儿、回退到哪儿」 */
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
    settings: path.join(home, "settings.json"),
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
  return String(raw == null ? "" : raw).trim().replace(/\/+$/, "");
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

/** 把一份 state 统一成 { data, rev, updatedAt }（兼容 {data,rev,updated_at} 包裹与裸 state） */
export function unwrapState(raw, extra) {
  const e = extra || {};
  if (!raw || typeof raw !== "object") return null;
  const data = raw.data && !Array.isArray(raw.courses) ? raw.data : raw;
  return {
    data,
    rev: Number(raw.rev != null ? raw.rev : e.rev) || 0,
    updatedAt: String(raw.updated_at || raw.updatedAt || raw.syncedAt || e.updatedAt || ""),
  };
}

export class StudySource {
  /**
   * @param {object} [options]
   * @param {object} [options.store] 注入 SettingsStore（测试用）；缺省在需要时懒加载
   */
  constructor(options) {
    const opts = options || {};
    this.session = null;
    this.cache = null; // { data, rev, updatedAt, source, email, fetchedAt }
    this.lastError = null;
    this.client = null;
    this.clientKey = "";
    this.storePromise = opts.store ? Promise.resolve(opts.store) : null;
  }

  /** 懒加载 SettingsStore：只依赖 lib/settings.js 导出，循环依赖由 ESM 处理 */
  async settingsStore() {
    if (!this.storePromise) {
      this.storePromise = import("./settings.js").then(function (mod) {
        return new mod.SettingsStore();
      });
    }
    return this.storePromise;
  }

  /** 读设置（读失败不炸：设置文件坏了就回落到 login.json） */
  async settings() {
    try {
      const store = await this.settingsStore();
      await store.load();
      const raw = store.raw();
      // load() 会把 login.json 里的 url/anonKey 并进视图（兼容老用户）：
      // 这种「迁移来的」凭据来源仍是 login.json，回写 refresh token 也要回 login.json
      raw.migratedFromLogin = !!store.migratedFromLogin;
      this.settingsSnapshot = raw;
      return raw;
    } catch (err) {
      this.lastError = err;
      return null;
    }
  }

  /** 凭据优先级：settings.json 的 supabase 有 url+anonKey → 用它；否则 login.json */
  async loadCredentials() {
    const paths = credentialPaths();

    let settings = null;
    try {
      settings = await this.settings();
    } catch {
      settings = null;
    }
    const fromSettings = settings && settings.supabase ? settings.supabase : null;
    const migrated = !!(settings && settings.migratedFromLogin);
    if (fromSettings && fromSettings.url && fromSettings.anonKey) {
      return {
        url: normalizeUrl(fromSettings.url),
        anonKey: String(fromSettings.anonKey || "").trim(),
        email: fromSettings.email || "",
        password: fromSettings.password || "",
        refreshToken: fromSettings.refreshToken || "",
        // 迁移来的凭据等于老路径：标 login，refresh token 也回写 login.json
        source: migrated ? "login" : "settings",
        path: paths.settings,
        raw: {
          url: fromSettings.url,
          anonKey: fromSettings.anonKey,
          email: fromSettings.email,
          password: fromSettings.password,
          refreshToken: fromSettings.refreshToken,
        },
      };
    }

    const cred = await readJson(paths.login);
    if (!cred || typeof cred !== "object") {
      // 设置里只填了一半也算「配置了」：报缺少的字段比「什么都没有」更好定位
      if (fromSettings && (fromSettings.url || fromSettings.anonKey)) {
        const err = new Error(
          "Supabase 设置不完整：请到 DSH「学业工作台 → 设置 → 连接」补全 URL 与 anonKey。"
        );
        err.code = "BAD_CREDENTIALS";
        err.path = paths.settings;
        throw err;
      }
      const err = new Error(
        "还没有配置 Supabase。请在 DSH 的「学业工作台 → 设置 → 连接」里填写 URL / anonKey / 邮箱 / 密码，" +
          "或直接编辑 " +
          paths.login +
          "。"
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
    return { url, anonKey, email: cred.email || "", source: "login", path: paths.login, raw: cred };
  }

  /** 同一个 (url, anonKey, 账号, 密码) 复用同一个客户端，避免重复建对象与丢 session */
  getClient(cred) {
    const password = String(cred.raw.password || cred.password || "");
    const key = [cred.url, cred.anonKey, cred.email, password, cred.refreshToken || cred.raw.refreshToken || ""].join("\u0000");
    if (this.client && this.clientKey === key) return this.client;
    this.clientKey = key;
    this.client = createClient({
      url: cred.url,
      anonKey: cred.anonKey,
      email: cred.email,
      password: password,
      refreshToken: cred.refreshToken || cred.raw.refreshToken || "",
    });
    return this.client;
  }

  /** 登录（保留旧签名，内部交给 supabase 客户端） */
  async authenticate(cred) {
    const client = this.getClient(cred);
    const session = await client.signIn();
    this.session = Object.assign({ url: cred.url, anonKey: cred.anonKey }, session);
    return this.session;
  }

  /** 登录成功后把 refresh token 回写：设置在 → settings.json；否则老路径 login.json */
  async persistSession(cred, session) {
    if (!session || !session.refreshToken) return;
    if (cred.source === "settings") {
      try {
        const store = await this.settingsStore();
        await store.saveTokens({ refreshToken: session.refreshToken, userId: session.userId });
      } catch {
        /* 设置文件只读时忽略：下次用密码重新登录 */
      }
      return;
    }
    try {
      const paths = credentialPaths();
      const existing = (await readJson(paths.login)) || {};
      await writeJson(paths.login, Object.assign({}, existing, { refreshToken: session.refreshToken }));
    } catch {
      /* 凭据文件只读时忽略：下次用密码重新登录 */
    }
  }

  async refresh(cred, refreshToken) {
    const client = this.getClient(cred);
    const session = await client.refreshSession(refreshToken);
    this.session = Object.assign({ url: cred.url, anonKey: cred.anonKey }, session);
    await this.persistSession(cred, session);
    return this.session;
  }

  async fetchRemote(cred) {
    // 老式 login.json 里的 passwordCommand：先算出密码，再交给纯 HTTP 客户端
    if (cred.source !== "settings" && !cred.raw.password && cred.raw.passwordCommand) {
      const password = await passwordFrom(cred.raw);
      if (!password) {
        const err = new Error("凭据文件里没有 password（或 passwordCommand 没输出密码）");
        err.code = "NO_PASSWORD";
        throw err;
      }
      cred.raw = Object.assign({}, cred.raw, { password });
      this.clientKey = "";
    }
    const client = this.getClient(cred);
    const remote = await client.fetchState();
    await this.persistSession(cred, remote.session);
    return { data: remote.data, rev: remote.rev, updatedAt: remote.updatedAt, email: remote.email };
  }

  /** 本地文件数据源：设置里的 data.stateFile 优先，其次 pluginConfig.stateFile */
  async readStateFile(file, label, paths) {
    const abs = path.resolve(file);
    const raw = await readJson(abs);
    if (!raw) return null;
    const unwrapped = unwrapState(raw);
    if (!unwrapped) return null;
    this.cache = {
      data: unwrapped.data,
      rev: unwrapped.rev,
      updatedAt: unwrapped.updatedAt,
      source: label || "file",
      email: "",
      fetchedAt: Date.now(),
      file: abs,
    };
    this.lastError = null;
    await writeJson(paths.latest, this.cache).catch(function () {});
    return this.cache;
  }

  /**
   * 读取一次最新数据；成功时写缓存，失败时回退到缓存。
   * @param {object} [config] { stateFile?, offline? }（pluginConfig 的旧口径，设置优先）
   */
  async read(config) {
    const cfg = config || {};
    const paths = credentialPaths();

    // 设置里的 data.stateFile / data.offline 优先，其次插件配置
    const settings = await this.settings();
    const dataCfg = (settings && settings.data) || {};
    const stateFile = dataCfg.stateFile || cfg.stateFile || "";
    const offline = dataCfg.offline !== undefined ? !!dataCfg.offline : !!cfg.offline;

    if (stateFile) {
      try {
        const hit = await this.readStateFile(stateFile, "file", paths);
        if (hit) return hit;
        const err = new Error("数据文件读不出来或不是合法的 state：" + path.resolve(stateFile));
        err.code = "BAD_STATE_FILE";
        err.path = path.resolve(stateFile);
        throw err;
      } catch (err) {
        // 设置里指定的文件坏了：记下来，继续往 Supabase 走（离线模式则直接回缓存）
        this.lastError = err;
        if (offline) return this.fromCache(err);
      }
    }

    if (offline) {
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

  /** 设置/数据变更后清掉内存缓存与客户端 session，让下一次 read 重新来（设置页保存会调） */
  reset() {
    this.cache = null;
    this.session = null;
    this.client = null;
    this.clientKey = "";
    this.lastError = null;
    return true;
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
      settings: paths.settings,
    };
  }
}

export { readJson, writeJson, removeFile, credentialPaths as paths };
