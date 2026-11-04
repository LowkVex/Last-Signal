-- ============================================================
-- THE LAST SIGNAL — Supabase schema for online co-op (6 players)
-- Project: https://nmgrpmpmhsapcbbnwver.supabase.co
-- ------------------------------------------------------------
-- Run this ONCE in the Supabase Dashboard -> SQL Editor
-- (New query -> paste entire file -> Run).
-- It is idempotent: safe to re-run.
--
-- Contents:
--   * profiles          — username, display color, settings, last seen
--   * player_progress   — chapter unlocks, completions, endings, lifetime stats
--   * lobbies           — room metadata / public room listings
--   * RPC functions     — claim_username(), merge_progress(), touch_last_seen()
--   * trigger           — auto-create profile+progress rows on signup
--   * Row Level Security— players can ONLY touch their own rows;
--                         lobbies readable by signed-in players,
--                         writable only by their host.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- profiles
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text,
  display_color integer not null default 0,
  settings      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- case-insensitive unique usernames
create unique index if not exists profiles_username_key
  on public.profiles (lower(username))
  where username is not null;

drop policy if exists "profiles are readable by signed-in players" on public.profiles;
create policy "profiles are readable by signed-in players"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "players insert their own profile" on public.profiles;
create policy "players insert their own profile"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "players update their own profile" on public.profiles;
create policy "players update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ------------------------------------------------------------
-- player_progress  (saved chapter progression, endings, stats)
-- ------------------------------------------------------------
create table if not exists public.player_progress (
  player_id  uuid primary key references auth.users (id) on delete cascade,
  unlocked   integer not null default 1 check (unlocked between 1 and 8),
  completed  jsonb not null default '{}'::jsonb,   -- { "1": true, "3": true }
  endings    jsonb not null default '{}'::jsonb,   -- { "A": true, "C": true }
  stats      jsonb not null default '{"games":0,"deaths":0,"escapes":0,"chapters":0,"playtime_s":0}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.player_progress enable row level security;

drop policy if exists "players read their own progress" on public.player_progress;
create policy "players read their own progress"
  on public.player_progress for select
  to authenticated
  using (auth.uid() = player_id);

drop policy if exists "players insert their own progress" on public.player_progress;
create policy "players insert their own progress"
  on public.player_progress for insert
  to authenticated
  with check (auth.uid() = player_id);

drop policy if exists "players update their own progress" on public.player_progress;
create policy "players update their own progress"
  on public.player_progress for update
  to authenticated
  using (auth.uid() = player_id)
  with check (auth.uid() = player_id);

-- ------------------------------------------------------------
-- lobbies  (room metadata & public room listings — NOT gameplay)
-- Live gameplay state lives ONLY in the game server's memory.
-- ------------------------------------------------------------
create table if not exists public.lobbies (
  code         text primary key,
  host_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null default 'SIGNAL ROOM',
  campaign     integer not null default 1 check (campaign between 1 and 8),
  player_count integer not null default 1 check (player_count between 0 and 6),
  max_players  integer not null default 6 check (max_players = 6),
  is_public    boolean not null default true,
  status       text not null default 'lobby' check (status in ('lobby','playing','ended')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.lobbies enable row level security;

drop policy if exists "signed-in players can browse lobbies" on public.lobbies;
create policy "signed-in players can browse lobbies"
  on public.lobbies for select
  to authenticated
  using (true);

drop policy if exists "hosts create their own lobby" on public.lobbies;
create policy "hosts create their own lobby"
  on public.lobbies for insert
  to authenticated
  with check (auth.uid() = host_id);

drop policy if exists "hosts update their own lobby" on public.lobbies;
create policy "hosts update their own lobby"
  on public.lobbies for update
  to authenticated
  using (auth.uid() = host_id)
  with check (auth.uid() = host_id);

drop policy if exists "hosts delete their own lobby" on public.lobbies;
create policy "hosts delete their own lobby"
  on public.lobbies for delete
  to authenticated
  using (auth.uid() = host_id);

-- keep updated_at fresh
create or replace function public.lobbies_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists lobbies_touch on public.lobbies;
create trigger lobbies_touch before update on public.lobbies
  for each row execute function public.lobbies_touch_updated_at();

-- ------------------------------------------------------------
-- auto-provision profile + progress on signup
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  base_name text;
  final_name text;
  i integer := 0;
begin
  base_name := coalesce(
    new.raw_user_meta_data ->> 'username',
    split_part(coalesce(new.email, 'signal'), '@', 1),
    'signal'
  );
  base_name := substr(regexp_replace(base_name, '[^A-Za-z0-9_\-\. ]', '', 'g'), 1, 20);
  if base_name = '' then base_name := 'signal'; end if;
  final_name := upper(base_name);

  loop
    if not exists (select 1 from public.profiles p where lower(p.username) = lower(final_name)) then
      exit;
    end if;
    i := i + 1;
    final_name := upper(base_name) || '-' || i::text;
    if i > 500 then
      final_name := 'SIGNAL-' || substr(new.id::text, 1, 6);
      exit;
    end if;
  end loop;

  insert into public.profiles (id, username, display_color)
  values (new.id, final_name, (abs(hashtext(new.id::text)) % 6))
  on conflict (id) do nothing;

  insert into public.player_progress (player_id)
  values (new.id)
  on conflict (player_id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- RPC: claim / change username (uniqueness handled server-side)
-- ------------------------------------------------------------
create or replace function public.claim_username(p_username text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  clean text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  clean := substr(regexp_replace(coalesce(p_username, ''), '[^A-Za-z0-9_\-\. ]', '', 'g'), 1, 20);
  if length(trim(clean)) < 3 then
    return jsonb_build_object('ok', false, 'error', 'too_short');
  end if;
  begin
    update public.profiles set username = upper(trim(clean)) where id = auth.uid();
    if not found then
      insert into public.profiles (id, username) values (auth.uid(), upper(trim(clean)));
    end if;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'taken');
  end;
  return jsonb_build_object('ok', true, 'username', upper(trim(clean)));
end $$;

revoke all on function public.claim_username(text) from anon;
grant execute on function public.claim_username(text) to authenticated;

-- ------------------------------------------------------------
-- RPC: merge_progress — atomic milestone saving.
-- Callable by a player for their OWN row, or by the game server
-- (service role / secret key) for any row after a validated
-- multiplayer milestone. Never used for per-tick movement.
-- ------------------------------------------------------------
create or replace function public.merge_progress(
  p_player    uuid,
  p_unlocked  integer default null,
  p_completed jsonb   default null,
  p_endings   jsonb   default null,
  p_stats     jsonb   default null,
  p_campaign  integer default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  is_owner boolean;
  cur public.player_progress%rowtype;
  new_stats jsonb;
begin
  is_owner := (auth.uid() = p_player);
  -- owner OR service role (the game server with the secret key)
  if not is_owner and coalesce(auth.role(), '') not in ('service_role') then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  insert into public.player_progress (player_id)
  values (p_player)
  on conflict (player_id) do nothing;

  select * into cur from public.player_progress where player_id = p_player;

  new_stats := cur.stats;
  if p_stats is not null then
    new_stats := jsonb_build_object(
      'games',      coalesce((cur.stats->>'games')::int, 0)      + coalesce((p_stats->>'games')::int, 0),
      'deaths',     coalesce((cur.stats->>'deaths')::int, 0)     + coalesce((p_stats->>'deaths')::int, 0),
      'escapes',    coalesce((cur.stats->>'escapes')::int, 0)    + coalesce((p_stats->>'escapes')::int, 0),
      'chapters',   coalesce((cur.stats->>'chapters')::int, 0)   + coalesce((p_stats->>'chapters')::int, 0),
      'playtime_s', coalesce((cur.stats->>'playtime_s')::int, 0) + coalesce((p_stats->>'playtime_s')::int, 0)
    );
  end if;

  update public.player_progress set
    unlocked   = greatest(unlocked, coalesce(p_unlocked, unlocked)),
    completed  = case when p_completed is null then completed else completed || p_completed end,
    endings    = case when p_endings   is null then endings   else endings   || p_endings   end,
    stats      = new_stats,
    updated_at = now()
  where player_id = p_player;

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.merge_progress(uuid, integer, jsonb, jsonb, jsonb, integer) from anon;
grant execute on function public.merge_progress(uuid, integer, jsonb, jsonb, jsonb, integer) to authenticated, service_role;

-- ------------------------------------------------------------
-- RPC: touch_last_seen (called on sign-in / room join)
-- ------------------------------------------------------------
create or replace function public.touch_last_seen()
returns void
language sql security definer set search_path = public
as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;

revoke all on function public.touch_last_seen() from anon;
grant execute on function public.touch_last_seen() to authenticated;

-- ------------------------------------------------------------
-- housekeeping: stale lobby rows (older than 24h) can be pruned.
-- The game server deletes rows when rooms close; this is a safety net.
-- ------------------------------------------------------------
delete from public.lobbies where updated_at < now() - interval '24 hours';
