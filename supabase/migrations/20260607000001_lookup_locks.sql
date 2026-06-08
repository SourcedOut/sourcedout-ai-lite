-- ============================================================================
-- P1 #4 — Idempotency guard for profile lookups (prevents concurrent double-charge)
-- ============================================================================
--
-- The enrich-and-draft function deducts a lookup credit up-front. Repeat lookups
-- AFTER a run completes are already free (served from the saved_profiles cache),
-- but two *simultaneous* in-flight requests for the same (user, linkedin_url) can
-- each pass the cache check and each deduct a credit. This migration adds a short
-- TTL lock so only the first concurrent request proceeds; the others get a 409
-- (LOOKUP_IN_PROGRESS) and can retry — by which time the first has populated the
-- cache, so the retry is free.
--
-- The edge function calls acquire_lookup_lock() defensively (fail-open): until this
-- migration is deployed, the RPC simply doesn't exist, the call errors, and the
-- function behaves exactly as it did before. Deploying this file is all that's
-- needed to switch the protection on.
--
-- Deploy with:  supabase db push        (or paste into the Supabase SQL editor)
-- ============================================================================

create table if not exists public.lookup_locks (
  user_id      uuid        not null,
  linkedin_url text        not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, linkedin_url)
);

alter table public.lookup_locks enable row level security;
-- No policies are granted: only the service role (used by the edge function) can
-- touch this table. RLS-on with no policy denies all anon/authenticated access.

-- Atomically acquire a lock. Stale locks (older than the TTL — e.g. from a crashed
-- request) are cleared first so a profile can never be permanently blocked.
-- Returns true if the caller acquired the lock, false if another request holds it.
create or replace function public.acquire_lookup_lock(
  p_user_id      uuid,
  p_linkedin_url text,
  p_ttl_seconds  int default 90
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.lookup_locks
   where user_id = p_user_id
     and linkedin_url = p_linkedin_url
     and created_at < now() - make_interval(secs => p_ttl_seconds);

  insert into public.lookup_locks (user_id, linkedin_url)
  values (p_user_id, p_linkedin_url);

  return true;
exception
  when unique_violation then
    return false;  -- a fresh lock already exists → another request is in flight
end;
$$;

-- Optional explicit release. The edge function does NOT call this (it relies on the
-- TTL above, because the cache short-circuits repeat lookups), but it is provided so
-- you can release manually or wire it into a finally block later if you prefer.
create or replace function public.release_lookup_lock(
  p_user_id      uuid,
  p_linkedin_url text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.lookup_locks
   where user_id = p_user_id and linkedin_url = p_linkedin_url;
end;
$$;
