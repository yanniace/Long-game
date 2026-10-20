-- Run in the Supabase SQL editor. Safe to re-run.
create table if not exists public.tlg_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);

alter table public.tlg_state enable row level security;

revoke all on table public.tlg_state from anon;
grant select, insert, update, delete on table public.tlg_state to authenticated;

drop policy if exists "Users can read their own TLG state" on public.tlg_state;
create policy "Users can read their own TLG state"
on public.tlg_state for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own TLG state" on public.tlg_state;
create policy "Users can insert their own TLG state"
on public.tlg_state for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own TLG state" on public.tlg_state;
create policy "Users can update their own TLG state"
on public.tlg_state for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own TLG state" on public.tlg_state;
create policy "Users can delete their own TLG state"
on public.tlg_state for delete
to authenticated
using ((select auth.uid()) = user_id);

