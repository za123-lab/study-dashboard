/**
 * 插件设置：读写 <数据目录>/settings.json（默认 ~/.dsh/study-widget/settings.json）。
 *
 * 为什么不用 configEditor.edit()：它会让插件重启，HTTP 路由、桌面窗口和小窗 token 全部断掉。
 * 这里只是一份普通 JSON 文件，原子写复用 source.js 的 writeJson。
 *
 * 对外只有两种形状（字段名与契约 4.1 逐字一致）：
 *   SettingsView —— 给前端的只读视图：密码永不回传，只给 hasPassword / hasRefreshToken
 *   SettingsInput —— 前端可写的子集；password 是写入专用字段（只进不出）
 *
 * 为了兼容老用户，第一次读的时候会把 login.json 里已有的 url / anonKey / email 并进来
 * （只读迁移，不删原文件；password 不搬，用户重新填一次即可）。
 */
import path from "node:path";

import { credentialPaths, readJson, writeJson } from "./source.js";

/** 契约 4.1 的默认值 */
export const DEFAULTS = {
  supabase: { url: "", anonKey: "", email: "" },
  desktop: { autoOpen: false, alwaysOnTop: true, width: 380, height: 640 },
  refresh: { summaryTtlSeconds: 30, pageSeconds: 300, autoRefresh: true },
  data: { offline: false, stateFile: "" },
  advanced: { electronPath: "" },
};

/** 数值字段的合法区间；超界直接拒绝而不是悄悄裁剪 */
const RANGES = {
  "desktop.width": [300, 1600],
  "desktop.height": [320, 1600],
  "refresh.summaryTtlSeconds": [0, 3600],
  "refresh.pageSeconds": [10, 86400],
};

const BOOLEAN_PATHS = [
  "desktop.autoOpen",
  "desktop.alwaysOnTop",
  "refresh.autoRefresh",
  "data.offline",
];

const TEXT_PATHS = ["supabase.url", "supabase.anonKey", "supabase.email", "data.stateFile", "advanced.electronPath"];

/** 认的输入路径（防止前端把 SettingsView 里多给的字段原样回写） */
const INPUT_PATHS = TEXT_PATHS.concat(BOOLEAN_PATHS, Object.keys(RANGES), ["supabase.password"]);

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pick(target, source, section, keys) {
  const from = isObject(source) && isObject(source[section]) ? source[section] : null;
  if (!from) return false;
  let any = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(from, key)) {
      target[section][key] = from[key];
      any = true;
    }
  }
  return any;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeUrl(raw) {
  return String(raw == null ? "" : raw).trim().replace(/\/+$/, "");
}

function badField(path, code, message) {
  const err = new Error(message);
  err.code = code;
  err.field = path;
  return err;
}

export class SettingsStore {
  /**
   * @param {object} [options]
   * @param {string} [options.home] 覆盖数据目录（测试用）；缺省走 credentialPaths().home
   */
  constructor(options) {
    const opts = options || {};
    this.home = opts.home ? path.resolve(opts.home) : credentialPaths().home;
    this.file = path.join(this.home, "settings.json");
    this.value = null; // 已合并缺省值的内部结构（含 password / refreshToken 明文）
  }

  /**
   * 读盘并合并缺省值；文件不存在 → 全是缺省值。
   * 每次都重新读盘（不缓存），这样外部改 settings.json / 迁移逻辑调整后立刻生效。
   */
  async load() {
    const disk = await readJson(this.file).catch(function (err) {
      // 文件坏了就让用户看到错误，不要静默重置成空设置
      const wrapped = new Error("settings.json 解析失败：" + ((err && err.message) || err));
      wrapped.code = "BAD_SETTINGS_FILE";
      wrapped.path = this && this.file;
      throw wrapped;
    });
    const merged = clone(DEFAULTS);
    const source = isObject(disk) ? disk : {};

    // 设置文件里的已知字段
    pick(merged, source, "supabase", ["url", "anonKey", "email"]);
    pick(merged, source, "desktop", Object.keys(DEFAULTS.desktop));
    pick(merged, source, "refresh", Object.keys(DEFAULTS.refresh));
    pick(merged, source, "data", Object.keys(DEFAULTS.data));
    pick(merged, source, "advanced", ["electronPath"]);

    // 记下迁移前的状态：来源是磁盘上的设置还是 login.json（source.js 据此决定 source 标什么）
    const onDisk = merged.supabase;

    // 写入专用字段：只在内部保存
    this.secret = {
      password: typeof source.password === "string" ? source.password : "",
      refreshToken: typeof source.refreshToken === "string" ? source.refreshToken : "",
    };

    // 老用户迁移：login.json 里的 url / anonKey / email 并进来。
    // 只在设置里这几项一个都没有时才迁移 —— 否则会把用户刚清空的设置又"复活"回来。
    const hasAnyConnection = !!(onDisk.url || onDisk.anonKey || onDisk.email);
    this.migratedFromLogin = false;
    const login = hasAnyConnection
      ? undefined
      : await readJson(credentialPaths().login).catch(function () {
          return undefined;
        });
    if (isObject(login)) {
      this.migratedFromLogin = true;
      if (!merged.supabase.url && login.url) merged.supabase.url = String(login.url);
      if (!merged.supabase.anonKey && login.anonKey) merged.supabase.anonKey = String(login.anonKey);
      if (!merged.supabase.email && login.email) merged.supabase.email = String(login.email);
      if (!this.secret.refreshToken && typeof login.refreshToken === "string") {
        this.secret.refreshToken = login.refreshToken;
      }
    }

    merged.supabase.url = normalizeUrl(merged.supabase.url);
    this.value = merged;
    return this.view();
  }

  /** 只读视图：给前端、给 /api/settings（不含密码） */
  view() {
    const v = this.value || clone(DEFAULTS);
    const secret = this.secret || {};
    const credentialLogin = isObject(v.supabase) ? v.supabase : DEFAULTS.supabase;
    return {
      supabase: {
        url: credentialLogin.url || "",
        anonKey: credentialLogin.anonKey || "",
        email: credentialLogin.email || "",
        hasPassword: !!secret.password,
        hasRefreshToken: !!secret.refreshToken,
      },
      desktop: Object.assign({}, DEFAULTS.desktop, v.desktop),
      refresh: Object.assign({}, DEFAULTS.refresh, v.refresh),
      data: Object.assign({}, DEFAULTS.data, v.data),
      advanced: Object.assign({}, DEFAULTS.advanced, v.advanced, {
        homeDir: this.home,
        // 只读路径：前端不用自己拼分隔符（Windows 上是反斜杠）
        settingsFile: this.file,
        loginFile: path.join(this.home, "login.json"),
      }),
    };
  }

  /**
   * 校验前端提交的 SettingsInput。只校验出现的字段；未知字段忽略。
   * @param {object} partial
   * @returns {{value: object, secret: object}} 规范化后的增量
   */
  sanitize(partial) {
    if (!isObject(partial)) throw badField("settings", "INVALID_SETTINGS", "settings 必须是一个对象");
    const out = { supabase: {}, desktop: {}, refresh: {}, data: {}, advanced: {} };
    const secret = {};

    if (Object.prototype.hasOwnProperty.call(partial, "supabase")) {
      const s = partial.supabase;
      if (!isObject(s)) throw badField("supabase", "INVALID_FIELD", "supabase 必须是对象");
      if (Object.prototype.hasOwnProperty.call(s, "url")) {
        const url = normalizeUrl(s.url);
        if (url && !/^https?:\/\//i.test(url)) {
          throw badField("supabase.url", "INVALID_URL", "Supabase URL 必须以 https:// 或 http:// 开头");
        }
        if (url) {
          try {
            // eslint-disable-next-line no-new
            new URL(url);
          } catch {
            throw badField("supabase.url", "INVALID_URL", "Supabase URL 不是合法地址：" + url);
          }
        }
        out.supabase.url = url;
      }
      if (Object.prototype.hasOwnProperty.call(s, "anonKey")) {
        const key = String(s.anonKey == null ? "" : s.anonKey).trim();
        if (key && key.length <= 20) {
          throw badField("supabase.anonKey", "INVALID_ANON_KEY", "anonKey 看起来不对：长度应大于 20 个字符");
        }
        if (key && /\s/.test(key)) {
          throw badField("supabase.anonKey", "INVALID_ANON_KEY", "anonKey 里不该有空格或换行");
        }
        out.supabase.anonKey = key;
      }
      if (Object.prototype.hasOwnProperty.call(s, "email")) {
        const email = String(s.email == null ? "" : s.email).trim();
        if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) {
          throw badField("supabase.email", "INVALID_EMAIL", "邮箱格式不对：" + email);
        }
        out.supabase.email = email;
      }
      // password 只进不出：空串 = 不改；"__clear__" 这类显式清除用 clearPassword 字段
      if (Object.prototype.hasOwnProperty.call(s, "password")) {
        const password = typeof s.password === "string" ? s.password : "";
        if (s.password != null && typeof s.password !== "string") {
          throw badField("supabase.password", "INVALID_FIELD", "password 必须是字符串");
        }
        if (password) secret.password = password;
      }
    }

    for (const section of ["desktop", "refresh", "data", "advanced"]) {
      if (!Object.prototype.hasOwnProperty.call(partial, section)) continue;
      const given = partial[section];
      if (!isObject(given)) throw badField(section, "INVALID_FIELD", section + " 必须是对象");
      for (const key of Object.keys(given)) {
        const field = section + "." + key;
        if (INPUT_PATHS.indexOf(field) === -1) continue;
        if (BOOLEAN_PATHS.indexOf(field) > -1) {
          if (typeof given[key] !== "boolean") {
            throw badField(field, "INVALID_FIELD", field + " 必须是布尔值");
          }
          out[section][key] = given[key];
          continue;
        }
        if (RANGES[field]) {
          const n = Number(given[key]);
          const [min, max] = RANGES[field];
          if (!Number.isFinite(n) || n < min || n > max) {
            throw badField(field, "OUT_OF_RANGE", field + " 需在 " + min + "–" + max + " 之间");
          }
          out[section][key] = Math.round(n);
          continue;
        }
        // 文本字段
        const text = String(given[key] == null ? "" : given[key]).trim();
        if (field === "data.stateFile" && text && !path.isAbsolute(text)) {
          throw badField(field, "INVALID_PATH", "数据文件要填绝对路径：" + text);
        }
        out[section][key] = text;
      }
    }
    return { value: out, secret };
  }

  /** 校验 + 合并 + 原子写；返回新的 SettingsView */
  async save(partial) {
    const delta = this.sanitize(partial);
    const base = this.value || clone(DEFAULTS);
    const next = clone(base);
    for (const section of Object.keys(delta.value)) {
      const fields = delta.value[section];
      for (const key of Object.keys(fields)) next[section][key] = fields[key];
    }
    const secret = Object.assign({}, this.secret || {}, delta.secret);
    if (secret.password === "" && delta.secret.password === undefined) delete secret.password;

    // 落盘：设置字段 + 写入专用字段（password / refreshToken 不进 SettingsView）
    const record = clone(next);
    delete record.supabase;
    record.supabase = Object.assign({}, next.supabase);
    if (secret.password) record.password = secret.password;
    if (secret.refreshToken) record.refreshToken = secret.refreshToken;
    record.updatedAt = new Date().toISOString();
    record.version = 1;
    if (!record.advanced) record.advanced = clone(DEFAULTS.advanced);
    // 视图专用的只读路径不落盘
    delete record.advanced.homeDir;
    delete record.advanced.settingsFile;
    delete record.advanced.loginFile;

    await writeJson(this.file, record);
    this.value = next;
    this.secret = { password: secret.password || "", refreshToken: secret.refreshToken || "" };
    return this.view();
  }

  /** 显式清除密码（前端「忘记密码」） */
  async clearPassword() {
    const next = Object.assign({}, this.value || clone(DEFAULTS));
    const secret = Object.assign({}, this.secret || {});
    secret.password = "";
    this.value = next;
    this.secret = secret;
    const record = await readJson(this.file).catch(function () {
      return undefined;
    });
    const out = isObject(record) ? record : {};
    delete out.password;
    out.updatedAt = new Date().toISOString();
    out.version = 1;
    await writeJson(this.file, out);
    return this.view();
  }

  /** 内部使用（source.js 读凭据）：返回含明文的完整结构 */
  raw() {
    const v = this.value || clone(DEFAULTS);
    return {
      supabase: Object.assign({}, DEFAULTS.supabase, v.supabase, {
        password: (this.secret && this.secret.password) || "",
        refreshToken: (this.secret && this.secret.refreshToken) || "",
      }),
      desktop: Object.assign({}, DEFAULTS.desktop, v.desktop),
      refresh: Object.assign({}, DEFAULTS.refresh, v.refresh),
      data: Object.assign({}, DEFAULTS.data, v.data),
      advanced: Object.assign({}, DEFAULTS.advanced, v.advanced),
      home: this.home,
      file: this.file,
    };
  }

  /** 把 password / refreshToken 回写到 settings.json（登录成功后复用），不影响其余字段 */
  async saveTokens(tokens) {
    const t = tokens || {};
    const current = Object.assign({}, this.value || clone(DEFAULTS));
    const secret = Object.assign({}, this.secret || {});
    if (typeof t.refreshToken === "string" && t.refreshToken) secret.refreshToken = t.refreshToken;
    if (typeof t.userId === "string" && t.userId) current.userId = t.userId;
    this.value = current;
    this.secret = { password: secret.password || "", refreshToken: secret.refreshToken || "" };
    const record = await readJson(this.file).catch(function () {
      return undefined;
    });
    const out = isObject(record) ? record : clone(DEFAULTS);
    delete out.advanced;
    out.advanced = Object.assign({}, (this.value && this.value.advanced) || DEFAULTS.advanced);
    delete out.advanced.homeDir;
    delete out.advanced.settingsFile;
    delete out.advanced.loginFile;
    out.supabase = Object.assign({}, this.value.supabase);
    if (secret.password) out.password = secret.password;
    if (secret.refreshToken) out.refreshToken = secret.refreshToken;
    if (current.userId) out.userId = current.userId;
    out.updatedAt = new Date().toISOString();
    out.version = 1;
    delete out.advanced.homeDir;
    await writeJson(this.file, out);
    return this.view();
  }
}

export { INPUT_PATHS, RANGES };
export default SettingsStore;
