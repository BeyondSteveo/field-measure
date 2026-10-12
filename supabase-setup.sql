-- Field Measure — database setup
-- Run this once in the Supabase SQL Editor for the "BuildWrite Projects" project.
-- Safe to re-run: every statement checks for what already exists.

-- One row per signed-in person. The row holds that person's whole Field Measure
-- state as JSON, which is the same shape the app already saved to the artifact
-- store, so the app code barely changes.
create table if not exists public.field_measure_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  payload    jsonb       not null,
  updated    bigint      not null default 0,
  updated_at timestamptz not null default now()
);

-- Row Level Security: no row is readable or writable unless a policy below
-- allows it. The automatic-RLS trigger should already have switched this on;
-- this line makes sure of it either way.
alter table public.field_measure_state enable row level security;

-- Each person can see and change their own row, and nobody else's.
-- auth.uid() is the id of whoever is signed in on the phone right now.
drop policy if exists "own row: read"   on public.field_measure_state;
drop policy if exists "own row: insert" on public.field_measure_state;
drop policy if exists "own row: update" on public.field_measure_state;

create policy "own row: read"
  on public.field_measure_state for select
  using (auth.uid() = user_id);

create policy "own row: insert"
  on public.field_measure_state for insert
  with check (auth.uid() = user_id);

create policy "own row: update"
  on public.field_measure_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Note: no delete policy on purpose. Nothing in the app deletes your whole
-- state, so the database refuses it outright. Deleting a single job happens
-- inside the payload, which is an update.

-- Keep updated_at honest without the app having to remember to set it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists field_measure_touch on public.field_measure_state;
create trigger field_measure_touch
  before update on public.field_measure_state
  for each row execute function public.touch_updated_at();
