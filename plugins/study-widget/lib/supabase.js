/**
 * Supabase 客户端（纯 HTTP，不依赖浏览器）。
 *
 * 与网页版 app.js 同一套协议：
 *   POST /auth/v1/token?grant_type=password      邮箱 + 密码换 access/refresh token
 *   POST /auth/v1/token?grant_type=refresh_token 用 refresh token 续期
 *   GET  /rest/v1/study_state?user_id=eq.<uid>&select=data,rev,updated_at
 * GET 遇到 401 会用 refresh token 重试一次。
 *
 * 只读：本模块没有任何写 Supabase 的代码路径。
 */

const TIMEOUT_MS = 15000;

export class SupabaseError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "SupabaseError";
    this.code = code;
    if (status != null) this.status = status;
  }
}

export function normalizeUrl(raw) {
  return String(raw == null ? "" : raw).trim().replace(/\/+$/, "");
}

export function authErrorText(status, text) {
  const s = String(text || "");
  if (/invalid login credentials/i.test(s)) return "邮箱或密码不对";
  // Supabase 有时只给 error:"invalid_grant"（GoTrue 的 OAuth 错误码），不带说明
  if (/invalid_grant|invalid login/i.test(s)) return "邮箱或密码不对（Supabase 返回 invalid_grant）";
  if (/email not confirmed/i.test(s)) return "邮箱还没验证：请在 Supabase 控制台确认这个用户";
  if (/invalid refresh token|refresh token.*(expired|not found)/i.test(s)) return "登录已过期，请重新登录";
  if (status === 429) return "尝试太频繁，等几分钟再试";
  if (status === 404) return "接口地址不对：检查 Supabase 项目 URL";
  return "登录失败：" + (s || "HTTP " + status);
}

export function restErrorText(status, body) {
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
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new SupabaseError("TIMEOUT", "连接超时（" + Math.round(TIMEOUT_MS / 1000) + " 秒内没有响应）：" + url);
    }
    const cause = (err && err.cause && err.cause.message) || (err && err.message) || String(err);
    throw new SupabaseError("NETWORK", "连不上服务器：" + cause);
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

function sessionFromAuth(body) {
  if (!body || typeof body.access_token !== "string" || !body.user) {
    throw new SupabaseError("AUTH_FAILED", "登录响应不完整，没有拿到 token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : "",
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    userId: String(body.user.id || ""),
    email: String(body.user.email || body.user.email_address || ""),
  };
}

function headers(anonKey, token) {
  const h = { apikey: anonKey, Accept: "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

/**
 * @param {object} options { url, anonKey, email, password, refreshToken }
 */
export function createClient(options) {
  const cred = options || {};
  const url = normalizeUrl(cred.url);
  const anonKey = String(cred.anonKey || "").trim();
  let session = null;

  function assertConfigured() {
    if (!url || !anonKey) {
      throw new SupabaseError("NO_CREDENTIALS", "还没有填 Supabase URL 与 anonKey");
    }
  }

  async function passwordLogin() {
    assertConfigured();
    if (!cred.password) throw new SupabaseError("NO_PASSWORD", "没有密码：请填一次密码，或先登录拿到 refresh token");
    const res = await timedFetch(url + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: Object.assign(headers(anonKey), { "Content-Type": "application/json" }),
      body: JSON.stringify({ email: String(cred.email || ""), password: String(cred.password) }),
    });
    const body = await readBody(res);
    if (!res.ok) {
      const text = body && (body.msg || body.error_description || body.error || body.message);
      throw new SupabaseError("AUTH_FAILED", authErrorText(res.status, text), res.status);
    }
    session = sessionFromAuth(body);
    return session;
  }

  async function refreshSession(token) {
    assertConfigured();
    const res = await timedFetch(url + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: Object.assign(headers(anonKey), { "Content-Type": "application/json" }),
      body: JSON.stringify({ refresh_token: token }),
    });
    const body = await readBody(res);
    if (!res.ok) {
      const text = body && (body.msg || body.error_description || body.message);
      throw new SupabaseError("REFRESH_FAILED", authErrorText(res.status, text), res.status);
    }
    session = sessionFromAuth(body);
    return session;
  }

  /** 已登录就用现成 session；否则先 refresh token；再不行用密码 */
  async function signIn() {
    if (session && session.expiresAt - 120000 > Date.now()) return session;
    if (cred.refreshToken) {
      try {
        return await refreshSession(cred.refreshToken);
      } catch {
        session = null;
        if (!cred.password) throw new SupabaseError("REFRESH_FAILED", "登录已过期，请重新填密码");
      }
    }
    return passwordLogin();
  }

  async function fetchState() {
    assertConfigured();
    let current = await signIn();
    const request = function () {
      return timedFetch(
        url +
          "/rest/v1/study_state?user_id=eq." +
          encodeURIComponent(current.userId) +
          "&select=data,rev,updated_at",
        { method: "GET", headers: headers(anonKey, current.accessToken) }
      );
    };
    let res = await request();
    if (res.status === 401) {
      // 401 重试一次：refresh token 换新 token 再打
      if (!current.refreshToken) {
        const body = await readBody(res);
        throw new SupabaseError("REST_FAILED", restErrorText(res.status, body), res.status);
      }
      current = await refreshSession(current.refreshToken);
      res = await request();
    }
    if (!res.ok) {
      const body = await readBody(res);
      throw new SupabaseError("REST_FAILED", restErrorText(res.status, body), res.status);
    }
    const rows = await readBody(res);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.data) {
      throw new SupabaseError("EMPTY_REMOTE", "云端还没有进度数据（先在网页端开启云同步推一次）");
    }
    return {
      data: row.data,
      rev: row.rev || 0,
      updatedAt: row.updated_at || "",
      email: current.email,
      userId: current.userId,
      session: current,
    };
  }

  /**
   * 「测试连接」用：登录 + 拉一次数据，两步分别报告，失败也把已成功的部分带上。
   * @returns {{auth: {ok, email?, userId?}, data: {ok, rev?, updatedAt?, todoOpen?, courses?, error?}}}
   */
  async function testConnection() {
    const out = { auth: { ok: false }, data: { ok: false } };
    let current;
    try {
      current = await signIn();
    } catch (err) {
      out.auth = { ok: false, message: (err && err.message) || String(err), code: (err && err.code) || "AUTH_FAILED" };
      return out;
    }
    out.auth = { ok: true, email: current.email, userId: current.userId };
    try {
      const remote = await fetchState();
      out.data = {
        ok: true,
        rev: remote.rev,
        updatedAt: remote.updatedAt,
        todoOpen: Array.isArray(remote.data.todos) ? remote.data.todos.filter(function (t) { return !t.done; }).length : 0,
        courses: Array.isArray(remote.data.courses) ? remote.data.courses.length : 0,
      };
      out.session = remote.session;
    } catch (err) {
      out.data = { ok: false, message: (err && err.message) || String(err), code: (err && err.code) || "REST_FAILED" };
    }
    return out;
  }

  return {
    url,
    signIn,
    refreshSession,
    fetchState,
    testConnection,
    get session() {
      return session;
    },
  };
}

export default createClient;
