-- ==========================================================
-- 学习进度手账 · Supabase 表结构与 RLS
-- 用法：Supabase Dashboard → SQL Editor → 整段粘贴执行（可重复执行）
-- ==========================================================

-- 整份进度存一行 JSON：
-- 客户端始终整份读、整份写，单行更新天然是原子的；
-- rev 由客户端在条件更新时 +1，作为乐观锁版本号。
create table if not exists public.study_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  rev        bigint not null default 1 check (rev > 0),
  updated_at timestamptz not null default now(),
  constraint study_state_data_is_object check (jsonb_typeof(data) = 'object'),
  constraint study_state_data_size check (octet_length(data::text) <= 1000000)
);

comment on table public.study_state is '学习进度手账：每个用户一行，data 为整份进度 JSON';

-- 开启行级安全：默认谁也不能读写
alter table public.study_state enable row level security;

-- 只允许读写自己 auth.uid() 对应的那一行
drop policy if exists "study_state_select_own" on public.study_state;
create policy "study_state_select_own"
  on public.study_state for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "study_state_insert_own" on public.study_state;
create policy "study_state_insert_own"
  on public.study_state for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "study_state_update_own" on public.study_state;
create policy "study_state_update_own"
  on public.study_state for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "study_state_delete_own" on public.study_state;
create policy "study_state_delete_own"
  on public.study_state for delete
  to authenticated
  using (auth.uid() = user_id);

-- updated_at 只由数据库维护，客户端 PATCH 时不需要也不应该写它
create or replace function public.study_state_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists study_state_touch on public.study_state;
create trigger study_state_touch
  before update on public.study_state
  for each row execute function public.study_state_touch();

-- 表权限：登录用户可以读写，匿名用户完全拿不到
grant select, insert, update, delete on public.study_state to authenticated;
revoke all on public.study_state from anon;

-- 可选：执行完在 SQL Editor 里跑这两句做自检
-- 期望 authenticated 返回 200 且只能看到自己那一行；anon 返回 401/空
-- select * from public.study_state;
