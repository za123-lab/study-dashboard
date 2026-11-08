# 云同步 Worker（Cloudflare Workers + D1）· 已停用

> 页面已改用 Supabase 云同步（见 [`../supabase/README.md`](../supabase/README.md)），本目录仅作历史参考，页面不再请求此 Worker。

学业工作台的可选附加能力：把整份进度 JSON 备份到 Cloudflare D1，多设备用同一个「同步码」互通。
不部署这个 Worker 时，站点完全照常可用（localStorage 仍是本地主存储）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `src/index.js` | 单个 Worker：`/bili` 透传 B 站接口、`/sync/{code}` 读写进度 |
| `schema.sql` | D1 建表：`sync_docs(code, data, updated_at)` |
| `wrangler.toml` | Worker 入口、D1 绑定、兼容日期、允许的跨域来源 |

## 接口契约

所有响应都带 CORS 头，`Access-Control-Allow-Origin` 固定为
`https://za123-lab.github.io`（可用 `ALLOWED_ORIGIN` 环境变量覆盖）。
`OPTIONS` 预检返回 204。

### `GET /bili?bvid=BVxxx`

转发 `https://api.bilibili.com/x/web-interface/view?bvid=...`，把上游 JSON **原样透传**
（不解析、不重新序列化），并补上 CORS 头。携带 `Referer: https://www.bilibili.com/`
与常见浏览器 UA，尽量避开 B 站对 Cloudflare 出口 IP 的 412；同时按 `cf.cacheTtl`
缓存 1 小时。

- bvid 不合法 → `400 {"error":"BAD_BVID"}`
- 上游失败 → `502`
- 上游状态码（包括 412）原样返回，响应头 `X-Upstream-Status` 便于排查

### `GET /sync/{code}`

- 存在 → `200 {"data": {...}, "updatedAt": 1730000000000}`
- 不存在 → `404 {"error":"NOT_FOUND"}`
- `code` 少于 16 位 → `400 {"error":"CODE_TOO_SHORT"}`

### `PUT /sync/{code}`

请求体：`{"data": {...}, "baseUpdatedAt": <数字 | null>}`

- `baseUpdatedAt` 为 `null`：仅当云端没有记录时插入；已有记录 → `409`
- `baseUpdatedAt` 等于服务端 `updated_at`：条件更新，返回 `200 {"updatedAt": 新版本号}`
- 不相等（被别的设备改过）或记录已不存在 → `409`，body 附服务端当前内容：
  ```json
  {"error":"CONFLICT","message":"...","data":{...}|null,"updatedAt":123|null}
  ```
- 绝不静默覆盖：前端收到 409 必须让用户选择保留哪一份

`updatedAt` 是毫秒时间戳（数字），作为乐观锁版本号；每次写入都保证比旧值大。

### 安全

- `code` 就是同步口令，按 bearer secret 对待：少于 16 位直接拒绝，超过 128 位或含空白也拒绝
- 任何日志都不打印 `code` 与数据内容（只有错误类型）
- 请求体上限 1 MB，超出返回 413

## 部署步骤

1. **准备账号与工具**

   ```bash
   # 需要一个 Cloudflare 账号（免费版即可），首次使用会打开浏览器授权
   npm install -g wrangler
   wrangler login
   ```

2. **创建 D1 数据库**

   ```bash
   cd worker
   wrangler d1 create study-dashboard
   ```

   命令会输出一段 `[[d1_databases]]` 配置，把它里面的 `database_id`
   复制到本目录 `wrangler.toml` 的 `database_id` 处（替换占位符）。

3. **建表**（远程库）

   ```bash
   wrangler d1 execute study-dashboard --file=./schema.sql --remote
   ```

4. **本地自测（可选）**

   ```bash
   wrangler d1 execute study-dashboard --file=./schema.sql --local
   wrangler dev
   ```

   `wrangler dev` 默认监听 `http://127.0.0.1:8787`。本地页面联调时，
   先把 `wrangler.toml` 里 `ALLOWED_ORIGIN` 临时改成页面来源（如
   `http://127.0.0.1:8765`），测完再改回线上来源。

5. **部署**

   ```bash
   wrangler deploy
   ```

   输出形如 `https://study-dashboard-sync.<你的子域>.workers.dev`，
   把这个地址填进站点「设置 · 云同步」的「Worker 地址」。

6. **回到页面**

   打开 https://za123-lab.github.io/study-dashboard/ → 设置 · 云同步 →
   填 Worker 地址 + 至少 16 位同步码（自己定的口令，不要外传）→ 立即上传。
   另一台设备填同样的地址和同步码 → 立即拉取。

## 需要你完成的事（部署前）

- [ ] 注册/登录 Cloudflare 账号（免费计划足够）
- [ ] 本机装 wrangler 并 `wrangler login` 授权
- [ ] `wrangler d1 create study-dashboard`，把 `database_id` 填进 `wrangler.toml`
- [ ] 执行建表命令（`--remote`）
- [ ] `wrangler deploy`，把输出的 Worker 地址填进页面设置

> 本仓库没有自动部署，也不会替你调用 Cloudflare API；以上命令需要你本人在已登录的环境执行。

## 关于 B 站直连

纯静态页面直接 `fetch` `api.bilibili.com` 会被 CORS 拦（响应不带
`Access-Control-Allow-Origin`），JSONP 也无效，所以页面内不再做自动取时长。
`/bili` 是给部署了 Worker 之后备用的代理路径：浏览器请求 Worker 是同源/带 CORS 的，
不受 B 站 CORS 限制。但 Cloudflare 出口 IP 仍可能被 B 站返回 412，
是否稳定可用取决于实际部署环境；页面目前没有依赖它，导入口仍是主路径。
