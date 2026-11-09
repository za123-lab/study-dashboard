# 06 · Cloudflare Worker（已停用，历史方案）

> **状态：停用。** 页面当前完全使用 Supabase 同步（[05 云同步](05-cloud-sync.md)），不再请求本目录的 Worker。本文件用于理解旧实现、必要时复活代理能力。
> `worker/README.md` 的原文也明确写着「已停用，仅作历史参考」。

## 1. 它曾经解决什么问题

纯静态页面直接 `fetch api.bilibili.com` 会被 CORS 拦（响应不带 `Access-Control-Allow-Origin`），JSONP 也不可用。Worker 提供两件事：

1. **`/bili` 代理**：服务端带 `Referer` 与浏览器 UA 去请求 B 站，再把 JSON 原样透传回浏览器；
2. **`/sync/{code}` 备份**：用 Cloudflare D1 存整份进度，用「同步码」代替账号，多设备互通。

当前页面的 B 站数据改由「提示词 → AI → 粘贴 JSON」获得，同步改由 Supabase，因此这两条都不再需要。

## 2. 文件构成

| 文件 | 内容 |
| --- | --- |
| `worker/src/index.js` | 单文件 Worker，约 340 行，导出 `{ fetch }` |
| `worker/schema.sql` | D1 建表 `sync_docs` |
| `worker/wrangler.toml` | 名称、入口、兼容日期、D1 绑定、`ALLOWED_ORIGIN` |
| `worker/.gitignore` | 忽略 `.wrangler/` 本地缓存 |

`wrangler.toml` 关键字段：

```toml
name = "study-dashboard-sync"
main = "src/index.js"
compatibility_date = "2026-10-01"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "study-dashboard"
database_id = "8aacb50b-2c87-4166-af9d-a259beccee14"   # 仓库里已有的库；换账号部署时要改成自己的

[vars]
ALLOWED_ORIGIN = "https://za123-lab.github.io"
```

## 3. 路由与契约

所有响应带 CORS 头，`Access-Control-Allow-Origin` 取 `env.ALLOWED_ORIGIN`（默认 `https://za123-lab.github.io`）；`OPTIONS` 预检返回 204，`Access-Control-Max-Age: 86400`。

### 3.1 `GET /`

健康检查：

```json
200 {
  "ok": true,
  "endpoints": ["GET /bili?bvid=BVxxx", "GET /sync/{code}", "PUT /sync/{code}"]
}
```

### 3.2 `GET /bili?bvid=BVxxx`

- 校验 `bvid`：`/^BV[0-9A-Za-z]{10}$/`；
- 上游 `https://api.bilibili.com/x/web-interface/view?bvid=...`；
- 请求头带 `Referer: https://www.bilibili.com/`、桌面 Chrome UA、`Accept-Language: zh-CN`；
- `cf: { cacheTtl: 3600, cacheEverything: true }` 走边缘缓存，降低 412 概率；
- **响应体直接透传上游流**（不解析、不重组），保留上游状态码，并加 `X-Upstream-Status` 头；
- 响应 `Cache-Control: public, max-age=300`。

| 情况 | 状态码 | body |
| --- | --- | --- |
| bvid 不合法 | 400 | `{"error":"BAD_BVID"}` |
| 方法不是 GET | 405 | `{"error":"METHOD_NOT_ALLOWED"}` |
| 上游请求抛错 | 502 | `{"error":"UPSTREAM_FAILED"}` |
| 上游 412 等 | 原样 | 上游原始 JSON |

### 3.3 `GET /sync/{code}`

| 情况 | 状态码 | body |
| --- | --- | --- |
| 存在且可解析 | 200 | `{"data":{...},"updatedAt":1730000000000}` |
| 不存在 | 404 | `{"error":"NOT_FOUND"}` |
| 存储的 `data` 不是合法 JSON | 500 | `{"error":"STORED_DATA_BROKEN"}`（不回显内容） |

### 3.4 `PUT /sync/{code}`

请求：

```json
{ "data": { ...整份进度... }, "baseUpdatedAt": 1730000000000 }
```

`baseUpdatedAt` 可以是数字或 `null`：

| 输入 | SQL | 语义 |
| --- | --- | --- |
| `null` / 省略 | `INSERT OR IGNORE ...` | 仅首次插入；已有记录 → 0 行 → 409 |
| 数字 | `UPDATE ... WHERE code = ?1 AND updated_at = ?4` | 原子条件更新；版本不一致 → 0 行 → 409 |

写入时构造新版本号：`now = base === null ? Date.now() : max(Date.now(), base + 1)`，保证单调递增，同一毫秒内连续写入也不会产生相同版本。

成功：`200 {"updatedAt": <新版本号>}`。

冲突：`409`，并附带服务端当前内容，方便前端弹窗对比：

```json
{
  "error": "CONFLICT",
  "message": "云端已被其他设备更新，未写入",
  "data": { ... } | null,
  "updatedAt": 123 | null
}
```

### 3.5 错误码总表

| code | HTTP | 含义 |
| --- | --- | --- |
| `BAD_BVID` | 400 | bvid 格式错误 |
| `BAD_JSON` | 400 | 请求体不是合法 JSON |
| `BAD_BODY` | 400 | body 不是对象 / 数组 |
| `MISSING_DATA` | 400 | 缺少 `data` |
| `BAD_DATA` | 400 | `data` 不是对象或无法序列化 |
| `BAD_BASE` | 400 | `baseUpdatedAt` 既不是数字也不是 null |
| `CODE_TOO_SHORT` | 400 | 同步码 < 16 位 |
| `CODE_TOO_LONG` | 400 | 同步码 > 128 位 |
| `CODE_HAS_SPACE` | 400 | 同步码含空白 |
| `METHOD_NOT_ALLOWED` | 405 | 方法不支持 |
| `TOO_LARGE` | 413 | 序列化后 > 1 MB |
| `NOT_FOUND` | 404 | 路由或同步码不存在 |
| `STORED_DATA_BROKEN` | 500 | 云端存储损坏 |
| `UPSTREAM_FAILED` | 502 | B 站请求失败 |
| `CONFLICT` | 409 | 版本不一致 / 首次插入撞已有记录 |
| `INTERNAL` | 500 | 未捕获异常 |

## 4. 关键函数

| 函数 | 作用 |
| --- | --- |
| `corsHeaders(allowOrigin)` | 统一 CORS 头（方法、头、`Vary: Origin`） |
| `jsonResponse(payload, status, allowOrigin)` | JSON 响应 + `no-store` + CORS |
| `errorBody(code, message)` | 统一错误体 |
| `readCode(pathname)` | 从 `/sync/{code}` 提取并 `decodeURIComponent` |
| `handleGet` | 读行 → `JSON.parse(data)` → 返回 |
| `handlePut` | 校验 body → 序列化 → 体积检查 → 插入 / 条件更新 → 0 行则读回并 409 |
| `handleBili` | 校验 bvid → 带上游头 → 边缘缓存 → 流式透传 |
| `fetch(request, env)` | 路由分发、预检、健康检查、兜底 404 / 500 |

## 5. D1 表结构

```sql
CREATE TABLE IF NOT EXISTS sync_docs (
  code       TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- `code`：同步码，同时也是「口令」，没有账号体系；
- `data`：整份进度的 JSON **字符串**（客户端上传前 `JSON.stringify`，服务端读取时再解析）；
- `updated_at`：毫秒时间戳，作为乐观锁版本号。

## 6. 安全设计

| 措施 | 实现 |
| --- | --- |
| 同步码即口令 | 至少 16 位、最多 128 位、不能含空白，否则拒绝 |
| 不泄露内容 | 日志只打错误类型（`err.name`），从不打 `code` 或 `data` |
| 不泄露同步码 | 错误响应不含 code；损坏数据也只报 `STORED_DATA_BROKEN` |
| 限制体积 | 请求体序列化后 > 1 MB → 413 |
| 不静默覆盖 | 首次插入用 `INSERT OR IGNORE`；更新用 `WHERE updated_at = base`，0 行即冲突 |
| CORS 收敛 | 默认只允许 `https://za123-lab.github.io` |

已知弱点（也是它被 Supabase 取代的原因之一）：

- 同步码没有服务端强度校验之外的任何身份认证，知道码就能读写；
- 没有按用户隔离、没有审计、没有撤销机制；
- 谁先写入谁占位，无法防止恶意抢注；
- B 站代理受 Cloudflare 出口 IP 风控影响，412 不可控。

## 7. 历史部署步骤（仅作参考）

```bash
npm install -g wrangler
wrangler login
wrangler d1 create study-dashboard          # 新建库后把输出的 database_id 替换进 wrangler.toml
wrangler d1 execute study-dashboard --file=./schema.sql --remote
wrangler deploy                              # 得到 https://study-dashboard-sync.<subdomain>.workers.dev
```

本地联调：

```bash
wrangler d1 execute study-dashboard --file=./schema.sql --local
wrangler dev                                 # http://127.0.0.1:8787
```

联调时先把 `ALLOWED_ORIGIN` 临时改成 `http://127.0.0.1:8765`，测完改回线上来源。仓库里的 `database_id` 是原作者云账号下的库，**换账号部署必须替换**，否则会连不上。

## 8. 与当前架构的关系

| 能力 | 旧方案（Worker） | 当前方案（Supabase） |
| --- | --- | --- |
| 身份 | 自定义同步码（口令） | 邮箱密码 + JWT |
| 隔离 | 无 | RLS 按 `auth.uid()` 隔离 |
| 冲突 | `updatedAt` 时间戳条件更新 | `rev` 整数条件更新 |
| 实时 | 无，靠手动拉取 | Realtime WebSocket 推送 |
| B 站数据 | `/bili` 代理 | 提示词 + AI + 粘贴 JSON |
| 部署 | 需要 Cloudflare 账号 + D1 | 需要 Supabase 项目（页面内配置） |
| 页面依赖 | 可选 | 可选 |

如果未来要恢复 `/bili` 代理（例如做自动取时长），只需部署 Worker 的 `/bili` 路由，并把页面新增的 `fetch` 指向它；`/sync` 部分不建议恢复，直接复用 Supabase 的账号体系更安全。
