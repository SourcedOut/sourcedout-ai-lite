-- Snapshot of the migration applied to the SourcedOut Lite project
-- (ddhdffftvujupflqggki) on 2026-06-10 as "initial_schema_from_prod".
-- Schema copied from prod SourcedOut (szxjcitbjcpkhxtjztay), lite subset:
-- user tables + credits lifecycle + lookup locks + debug logs.
-- Excludes waterfall-only tables (company_email_patterns, company_domain_hints)
-- and legacy tables (candidates, outreach_runs, profiles, workflow_jobs, ...).

create extension if not exists "uuid-ossp";

-- Enums
create type hiring_focus_enum as enum ('engineering','product','design','data','sales','marketing','finance','legal','hr','operations','executive','other');
create type tone_enum as enum ('professional','friendly','direct','warm','formal');

-- Tables
create table credits (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid unique references auth.users(id) on delete cascade,
  tier text default 'free',
  mode text default 'recruiter',
  lookups_used integer default 0,
  emails_used integer default 0,
  resets_at timestamptz default (now() + interval '30 days'),
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz default now(),
  email text,
  updated_at timestamptz default now(),
  ai_runs_used integer not null default 0
);

create table recruiter_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null,
  company_name text not null,
  job_title text,
  hiring_focus hiring_focus_enum,
  tone tone_enum,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table saved_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  linkedin_url text not null,
  full_name text,
  work_email text,
  personal_email text,
  title text,
  company text,
  title_verified boolean default false,
  email_status text default 'not_found',
  enriched_at timestamptz not null default now(),
  is_bookmarked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  raw_data jsonb,
  email_source text,
  unique (user_id, linkedin_url)
);

create table saved_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  job_url text,
  role_title text,
  company text,
  highlights text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, label)
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  job_id uuid references saved_jobs(id) on delete set null,
  status text not null default 'needs_job' check (status in ('needs_job','ready','active','archived')),
  total_count integer not null default 0,
  enriched_count integer not null default 0,
  drafted_count integer not null default 0,
  approved_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table campaign_candidates (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  first_name text,
  last_name text,
  headline text,
  location text,
  current_title text,
  current_company text,
  csv_email text,
  phone text,
  linkedin_url text,
  notes text,
  feedback text,
  saved_profile_id uuid references saved_profiles(id) on delete set null,
  status text not null default 'imported' check (status in ('imported','enriching','enriched','no_email','drafting','drafted','approved','skipped','failed')),
  work_email text,
  personal_email text,
  email_status text,
  enriched_title text,
  enriched_company text,
  draft_subject text,
  draft_body text,
  draft_confidence numeric,
  enriched_at timestamptz,
  drafted_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table enrichment_debug_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  provider text not null,
  request_payload jsonb,
  response_payload jsonb,
  status_code integer,
  created_at timestamptz not null default now(),
  correlation_id uuid
);

create table lookup_locks (
  user_id uuid not null,
  linkedin_url text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, linkedin_url)
);

-- Indexes
create index saved_profiles_user_id_idx on saved_profiles (user_id);
create index saved_profiles_bookmarked_idx on saved_profiles (user_id, is_bookmarked) where is_bookmarked = true;
create index saved_jobs_user_id_idx on saved_jobs (user_id);
create index idx_campaigns_user_id on campaigns (user_id);
create index idx_campaign_candidates_campaign_id on campaign_candidates (campaign_id);
create index idx_campaign_candidates_user_status on campaign_candidates (user_id, status);
create index enrichment_debug_logs_created_at_idx on enrichment_debug_logs (created_at);
create index enrichment_debug_logs_user_created_idx on enrichment_debug_logs (user_id, created_at desc);
create index enrichment_debug_logs_correlation_id_idx on enrichment_debug_logs (correlation_id);

-- RLS
alter table credits enable row level security;
alter table recruiter_profiles enable row level security;
alter table saved_profiles enable row level security;
alter table saved_jobs enable row level security;
alter table campaigns enable row level security;
alter table campaign_candidates enable row level security;
-- system tables: RLS on, no policies → service role only
alter table enrichment_debug_logs enable row level security;
alter table lookup_locks enable row level security;

create policy "Users can read own credits" on credits for select using ((select auth.uid()) = user_id);
create policy "Users can update own credits" on credits for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Users can view their own recruiter profile" on recruiter_profiles for select using (auth.uid() = user_id);
create policy "Users can insert their own recruiter profile" on recruiter_profiles for insert with check (auth.uid() = user_id);
create policy "Users can update their own recruiter profile" on recruiter_profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users can view their own saved profiles" on saved_profiles for select using (auth.uid() = user_id);
create policy "Users can insert their own saved profiles" on saved_profiles for insert with check (auth.uid() = user_id);
create policy "Users can update their own saved profiles" on saved_profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their own saved profiles" on saved_profiles for delete using (auth.uid() = user_id);

create policy "Users can view their own saved jobs" on saved_jobs for select using (auth.uid() = user_id);
create policy "Users can insert their own saved jobs" on saved_jobs for insert with check (auth.uid() = user_id);
create policy "Users can update their own saved jobs" on saved_jobs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their own saved jobs" on saved_jobs for delete using (auth.uid() = user_id);

create policy "campaigns_select" on campaigns for select using (auth.uid() = user_id);
create policy "campaigns_insert" on campaigns for insert with check (auth.uid() = user_id);
create policy "campaigns_update" on campaigns for update using (auth.uid() = user_id);
create policy "campaigns_delete" on campaigns for delete using (auth.uid() = user_id);

create policy "campaign_candidates_select" on campaign_candidates for select using (auth.uid() = user_id);
create policy "campaign_candidates_insert" on campaign_candidates for insert with check (auth.uid() = user_id);
create policy "campaign_candidates_update" on campaign_candidates for update using (auth.uid() = user_id);
create policy "campaign_candidates_delete" on campaign_candidates for delete using (auth.uid() = user_id);

-- Functions (copied from prod)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to ''
as $$ begin insert into public.credits (user_id, email) values (new.id, new.email); return new; end; $$;

create or replace function public.update_updated_at()
returns trigger language plpgsql set search_path to ''
as $$ begin new.updated_at = now(); return new; end; $$;

create or replace function public.update_recruiter_profiles_updated_at()
returns trigger language plpgsql
as $$ begin new.updated_at = now(); return new; end; $$;

create or replace function public.update_campaigns_updated_at()
returns trigger language plpgsql
as $$ begin new.updated_at = now(); return new; end; $$;

create or replace function public.update_campaign_candidates_updated_at()
returns trigger language plpgsql
as $$ begin new.updated_at = now(); return new; end; $$;

create or replace function public.is_first_time_user()
returns boolean language sql stable
as $$ select not exists (select 1 from recruiter_profiles where user_id = auth.uid()); $$;

create or replace function public.check_and_reset_credits(p_user_id uuid)
returns void language plpgsql security definer set search_path to ''
as $$ begin update public.credits set lookups_used = 0, emails_used = 0, resets_at = now() + interval '30 days' where user_id = p_user_id and resets_at < now(); end; $$;

create or replace function public.check_credits(p_user_id uuid)
returns boolean language plpgsql security definer set search_path to 'public'
as $$
declare v_tier text; v_used integer; v_limit integer;
begin
  insert into credits (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select tier, lookups_used into v_tier, v_used from credits where user_id = p_user_id;
  v_limit := case v_tier when 'pro' then 100 when 'team' then 500 else 10 end;
  return v_used < v_limit;
end; $$;

create or replace function public.deduct_credit(p_user_id uuid)
returns boolean language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tier text;
  v_used integer;
  v_limit integer;
begin
  select tier, lookups_used into v_tier, v_used
  from public.credits where user_id = p_user_id;
  if not found then
    return false;
  end if;
  v_limit := case v_tier
    when 'free' then 10
    when 'sourcer' then 50
    when 'pro' then 200
    else 10
  end;
  if v_used >= v_limit then
    return false;
  end if;
  update public.credits set lookups_used = lookups_used + 1 where user_id = p_user_id;
  return true;
end; $$;

create or replace function public.increment_campaign_count(p_campaign_id uuid, p_field text)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if p_field not in ('enriched_count', 'drafted_count', 'approved_count', 'total_count') then
    raise exception 'increment_campaign_count: unknown field %', p_field;
  end if;
  execute format(
    'update public.campaigns set %I = %I + 1, updated_at = now() where id = $1',
    p_field, p_field
  ) using p_campaign_id;
end; $$;

create or replace function public.acquire_lookup_lock(p_user_id uuid, p_linkedin_url text, p_ttl_seconds integer default 90)
returns boolean language plpgsql security definer set search_path to 'public'
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
    return false;
end; $$;

create or replace function public.release_lookup_lock(p_user_id uuid, p_linkedin_url text)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  delete from public.lookup_locks
   where user_id = p_user_id and linkedin_url = p_linkedin_url;
end; $$;

create or replace function public.purge_old_enrichment_debug_logs(p_retention_days integer default 30)
returns integer language plpgsql security definer set search_path to 'public'
as $$
declare
  v_deleted integer;
begin
  delete from public.enrichment_debug_logs
   where created_at < now() - make_interval(days => p_retention_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end; $$;

-- Triggers
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
create trigger credits_updated_at before update on credits
  for each row execute function update_updated_at();
create trigger recruiter_profiles_updated_at before update on recruiter_profiles
  for each row execute function update_recruiter_profiles_updated_at();
create trigger trg_campaigns_updated_at before update on campaigns
  for each row execute function update_campaigns_updated_at();
create trigger trg_campaign_candidates_updated_at before update on campaign_candidates
  for each row execute function update_campaign_candidates_updated_at();
