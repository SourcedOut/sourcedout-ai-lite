-- ============================================================================
-- Campaigns feature — tables, indexes, RLS policies, and atomic counter RPC
-- ============================================================================
--
-- Establishes the two tables the campaign workflow depends on:
--   campaigns            — one row per named outreach campaign
--   campaign_candidates  — one row per candidate in a campaign
--
-- Also adds increment_campaign_count(uuid, text) so counter increments from
-- the edge function are atomic (avoids read-modify-write races on concurrent
-- enrichments/drafts for the same campaign).
--
-- Deploy with:  supabase db push   (or paste into the Supabase SQL editor)
-- ============================================================================

-- ── campaigns ────────────────────────────────────────────────────────────────

create table if not exists public.campaigns (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users(id) on delete cascade,
  name           text        not null,
  job_id         uuid        references public.saved_jobs(id) on delete set null,
  status         text        not null default 'needs_job',  -- needs_job | ready | active | archived
  total_count    int         not null default 0,
  enriched_count int         not null default 0,
  drafted_count  int         not null default 0,
  approved_count int         not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, name)
);

create index if not exists idx_campaigns_user_id on public.campaigns (user_id);

alter table public.campaigns enable row level security;

create policy campaigns_select on public.campaigns
  for select using (auth.uid() = user_id);

create policy campaigns_insert on public.campaigns
  for insert with check (auth.uid() = user_id);

create policy campaigns_update on public.campaigns
  for update using (auth.uid() = user_id);

create policy campaigns_delete on public.campaigns
  for delete using (auth.uid() = user_id);

-- ── campaign_candidates ───────────────────────────────────────────────────────

create table if not exists public.campaign_candidates (
  id                uuid        primary key default gen_random_uuid(),
  campaign_id       uuid        not null references public.campaigns(id) on delete cascade,
  user_id           uuid        not null references auth.users(id) on delete cascade,

  -- Identity (from CSV)
  first_name        text,
  last_name         text,
  headline          text,
  location          text,
  current_title     text,
  current_company   text,
  linkedin_url      text,
  csv_email         text,   -- email the recruiter supplied in the CSV (may be personal or empty)
  phone             text,
  notes             text,
  feedback          text,
  active_project    text,

  -- Linked Supabase profile (set after enrichment matches a saved_profiles row)
  saved_profile_id  uuid        references public.saved_profiles(id) on delete set null,

  -- Workflow status
  -- imported → enriching → enriched | no_email | failed
  -- enriched → drafting  → drafted
  -- drafted  → approved
  -- approved → followed_up → responded
  status            text        not null default 'imported',

  -- Enrichment results
  work_email        text,
  personal_email    text,
  email_status      text,   -- found | uncertain | not_found
  enriched_title    text,
  enriched_company  text,

  -- Draft
  draft_subject     text,
  draft_body        text,
  draft_confidence  numeric,

  -- Timestamps
  enriched_at       timestamptz,
  drafted_at        timestamptz,
  approved_at       timestamptz,
  followed_up_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_campaign_candidates_campaign_id
  on public.campaign_candidates (campaign_id);

create index if not exists idx_campaign_candidates_user_status
  on public.campaign_candidates (user_id, status);

alter table public.campaign_candidates enable row level security;

create policy campaign_candidates_select on public.campaign_candidates
  for select using (auth.uid() = user_id);

create policy campaign_candidates_insert on public.campaign_candidates
  for insert with check (auth.uid() = user_id);

create policy campaign_candidates_update on public.campaign_candidates
  for update using (auth.uid() = user_id);

create policy campaign_candidates_delete on public.campaign_candidates
  for delete using (auth.uid() = user_id);

-- ── Atomic counter increment ──────────────────────────────────────────────────
-- Called by the edge function so concurrent enrichments / drafts never race on
-- the same campaign counter. Uses UPDATE ... SET field = field + 1.
-- Only the fields used by the edge function are allowed.

create or replace function public.increment_campaign_count(
  p_campaign_id uuid,
  p_field       text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_field not in ('enriched_count', 'drafted_count', 'approved_count', 'total_count') then
    raise exception 'increment_campaign_count: unknown field %', p_field;
  end if;
  execute format(
    'update public.campaigns set %I = %I + 1, updated_at = now() where id = $1',
    p_field, p_field
  ) using p_campaign_id;
end;
$$;
