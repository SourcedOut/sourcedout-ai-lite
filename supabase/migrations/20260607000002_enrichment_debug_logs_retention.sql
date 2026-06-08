-- ============================================================================
-- P1 #5 — Retention policy for enrichment_debug_logs (bounds PII at rest)
-- ============================================================================
--
-- enrichment_debug_logs stores per-step diagnostics, including raw provider
-- payloads that can contain candidate PII (names, emails, phone numbers). These
-- logs are intentional and useful for debugging the waterfall, so we do NOT scrub
-- their contents — instead we bound how long they live.
--
-- This migration adds a purge function and (optionally) schedules it daily via
-- pg_cron. Creating the function deletes nothing on its own; rows are only removed
-- when the function runs.
--
-- NOTE: adjust the timestamp column name below if your table does not use
-- `created_at` (some schemas use `inserted_at`). Verify with:
--     select column_name from information_schema.columns
--      where table_name = 'enrichment_debug_logs';
--
-- Deploy with:  supabase db push        (or paste into the Supabase SQL editor)
-- ============================================================================

-- Speed up the time-range delete.
create index if not exists enrichment_debug_logs_created_at_idx
  on public.enrichment_debug_logs (created_at);

-- Delete debug rows older than the retention window (default 30 days).
-- Returns the number of rows removed.
create or replace function public.purge_old_enrichment_debug_logs(
  p_retention_days int default 30
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.enrichment_debug_logs
   where created_at < now() - make_interval(days => p_retention_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ----------------------------------------------------------------------------
-- Optional: schedule a daily purge at 03:15 UTC via pg_cron.
-- Requires the pg_cron extension. Uncomment to enable, or run the function
-- manually / from your own scheduler instead.
-- ----------------------------------------------------------------------------
-- create extension if not exists pg_cron;
-- select cron.schedule(
--   'purge-enrichment-debug-logs',
--   '15 3 * * *',
--   $$ select public.purge_old_enrichment_debug_logs(30); $$
-- );
