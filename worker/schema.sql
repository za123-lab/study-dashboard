-- 学习进度手账 · 云同步（Cloudflare D1）
-- 每个同步码只存一行，data 是整份进度 JSON 文档（字符串）
-- updated_at 是毫秒时间戳，用作乐观锁版本号

CREATE TABLE IF NOT EXISTS sync_docs (
  code       TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
