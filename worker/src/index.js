/* ==========================================================
   学习进度手账 · 云同步 Worker（Cloudflare Workers + D1）
   - GET  /bili?bvid=BVxxx   原样透传 B 站 view 接口（带 CORS）
   - GET  /sync/{code}       读取云端进度
   - PUT  /sync/{code}       条件写入，冲突返回 409
   - OPTIONS                 预检
   安全约定：{code} 视为口令，长度不足 16 位直接拒绝；
             任何日志都不打印 code 与数据内容。
   ========================================================== */

const DEFAULT_ORIGIN = "https://za123-lab.github.io";
const BILI_VIEW = "https://api.bilibili.com/x/web-interface/view";
const BILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BV_RE = /^BV[0-9A-Za-z]{10}$/;
const CODE_MIN = 16;
const CODE_MAX = 128;
const BODY_MAX = 1024 * 1024; // 1 MiB，够存几千节课
const CACHE_TTL = 3600; // B 站视频信息缓存 1 小时

function corsHeaders(allowOrigin) {
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(payload, status, allowOrigin) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: Object.assign(
      {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
      corsHeaders(allowOrigin)
    ),
  });
}

function errorBody(code, message) {
  return { error: code, message: message };
}

/** 取同步码：路由里的编码值；非法编码返回 null */
function readCode(pathname) {
  const m = pathname.match(/^\/sync\/([^/]+)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch (err) {
    return "";
  }
}

/** 云同步：GET /sync/{code} */
async function handleGet(request, env, code, allowOrigin) {
  const row = await env.DB.prepare(
    "SELECT data, updated_at FROM sync_docs WHERE code = ?1"
  )
    .bind(code)
    .first();

  if (!row) {
    return jsonResponse(
      errorBody("NOT_FOUND", "云端还没有这个同步码的数据"),
      404,
      allowOrigin
    );
  }

  let data;
  try {
    data = JSON.parse(row.data);
  } catch (err) {
    // 只报类型，不带出内容
    return jsonResponse(
      errorBody("STORED_DATA_BROKEN", "云端数据已损坏，无法解析"),
      500,
      allowOrigin
    );
  }

  return jsonResponse({ data: data, updatedAt: row.updated_at }, 200, allowOrigin);
}

/** 云同步：PUT /sync/{code}，条件写入 + 409 冲突 */
async function handlePut(request, env, code, allowOrigin) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse(
      errorBody("BAD_JSON", "请求体不是合法 JSON"),
      400,
      allowOrigin
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(
      errorBody("BAD_BODY", "请求体应为 { data, baseUpdatedAt }"),
      400,
      allowOrigin
    );
  }
  if (!("data" in body)) {
    return jsonResponse(
      errorBody("MISSING_DATA", "缺少 data 字段"),
      400,
      allowOrigin
    );
  }
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return jsonResponse(
      errorBody("BAD_DATA", "data 必须是对象（整份进度文档）"),
      400,
      allowOrigin
    );
  }

  const rawBase = body.baseUpdatedAt;
  const base = typeof rawBase === "number" ? rawBase : null;
  if (rawBase !== undefined && rawBase !== null && typeof rawBase !== "number") {
    return jsonResponse(
      errorBody("BAD_BASE", "baseUpdatedAt 应为数字或 null"),
      400,
      allowOrigin
    );
  }

  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch (err) {
    return jsonResponse(
      errorBody("BAD_DATA", "data 无法序列化成 JSON"),
      400,
      allowOrigin
    );
  }
  if (serialized.length > BODY_MAX) {
    return jsonResponse(
      errorBody("TOO_LARGE", "数据超过 1 MB，请精简后再同步"),
      413,
      allowOrigin
    );
  }

  // 递增时间戳，避免同一毫秒内的两次写入生成相同的版本号
  const now = base === null ? Date.now() : Math.max(Date.now(), base + 1);

  let changes = 0;
  if (base === null) {
    // 首次写入：云端已有记录就视为冲突，绝不覆盖
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO sync_docs (code, data, updated_at) VALUES (?1, ?2, ?3)"
    )
      .bind(code, serialized, now)
      .run();
    changes = (res.meta && res.meta.changes) || 0;
  } else {
    // 版本号必须与服务端一致才允许写入（原子条件更新）
    const res = await env.DB.prepare(
      "UPDATE sync_docs SET data = ?2, updated_at = ?3 WHERE code = ?1 AND updated_at = ?4"
    )
      .bind(code, serialized, now, base)
      .run();
    changes = (res.meta && res.meta.changes) || 0;
  }

  if (changes === 0) {
    const current = await env.DB.prepare(
      "SELECT data, updated_at FROM sync_docs WHERE code = ?1"
    )
      .bind(code)
      .first();
    let serverData = null;
    if (current) {
      try {
        serverData = JSON.parse(current.data);
      } catch (err) {
        serverData = null;
      }
    }
    return jsonResponse(
      {
        error: "CONFLICT",
        message: "云端已被其他设备更新，未写入",
        data: serverData,
        updatedAt: current ? current.updated_at : null,
      },
      409,
      allowOrigin
    );
  }

  return jsonResponse({ updatedAt: now }, 200, allowOrigin);
}

/** GET /bili?bvid=BVxxx：原样透传，不解析不重组 */
async function handleBili(request, url, allowOrigin) {
  const bvid = (url.searchParams.get("bvid") || "").trim();
  if (!BV_RE.test(bvid)) {
    return jsonResponse(
      errorBody("BAD_BVID", "bvid 应为 BV 号，形如 BV1xx411c7mD"),
      400,
      allowOrigin
    );
  }

  let upstream;
  try {
    upstream = await fetch(BILI_VIEW + "?bvid=" + encodeURIComponent(bvid), {
      method: "GET",
      headers: {
        Referer: "https://www.bilibili.com/",
        "User-Agent": BILI_UA,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      // 命中 Cloudflare 边缘缓存，减少回源与 412 概率
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
  } catch (err) {
    return jsonResponse(
      errorBody("UPSTREAM_FAILED", "请求 B 站接口失败"),
      502,
      allowOrigin
    );
  }

  // 直接把上游 body 流透传，保留原始字节，避免 JSON 解析开销
  const headers = Object.assign(
    {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      "Cache-Control": "public, max-age=300",
      "X-Upstream-Status": String(upstream.status),
    },
    corsHeaders(allowOrigin)
  );

  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request, env) {
    const allowOrigin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    try {
      if (url.pathname === "/bili") {
        if (request.method !== "GET") {
          return jsonResponse(
            errorBody("METHOD_NOT_ALLOWED", "只支持 GET"),
            405,
            allowOrigin
          );
        }
        return await handleBili(request, url, allowOrigin);
      }

      const code = readCode(url.pathname);
      if (code !== null) {
        if (!code || code.length < CODE_MIN) {
          return jsonResponse(
            errorBody(
              "CODE_TOO_SHORT",
              "同步码至少 " + CODE_MIN + " 位（当前 " + code.length + " 位）"
            ),
            400,
            allowOrigin
          );
        }
        if (code.length > CODE_MAX) {
          return jsonResponse(
            errorBody("CODE_TOO_LONG", "同步码太长（最多 " + CODE_MAX + " 位）"),
            400,
            allowOrigin
          );
        }
        if (/[\s]/.test(code)) {
          return jsonResponse(
            errorBody("CODE_HAS_SPACE", "同步码不能包含空白字符"),
            400,
            allowOrigin
          );
        }

        if (request.method === "GET") {
          return await handleGet(request, env, code, allowOrigin);
        }
        if (request.method === "PUT") {
          return await handlePut(request, env, code, allowOrigin);
        }
        return jsonResponse(
          errorBody("METHOD_NOT_ALLOWED", "只支持 GET / PUT"),
          405,
          allowOrigin
        );
      }

      if (url.pathname === "/") {
        return jsonResponse(
          {
            ok: true,
            endpoints: [
              "GET /bili?bvid=BVxxx",
              "GET /sync/{code}",
              "PUT /sync/{code}",
            ],
          },
          200,
          allowOrigin
        );
      }

      return jsonResponse(errorBody("NOT_FOUND", "没有这个接口"), 404, allowOrigin);
    } catch (err) {
      // 只记录错误类型，不带出 code / data
      console.error("request failed:", (err && err.name) || "Error");
      return jsonResponse(
        errorBody("INTERNAL", "服务器内部错误"),
        500,
        allowOrigin
      );
    }
  },
};
