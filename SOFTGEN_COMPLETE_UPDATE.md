# SourcedOut AI — Complete Code Update for Softgen

This file is **fully self-contained**. Everything Softgen needs is below — no need to
pull any branch. There are two parts:

1. **Three new Supabase SQL migration files** — pasted in full, with step-by-step
   instructions for running them in Supabase.
2. **The COMPLETE edge function** (`supabase/functions/enrich-and-draft/index.ts`) — the
   entire final file is pasted in Part 4. Replace the existing file with it wholesale
   (no patching, no merging) to eliminate any chance of error.

After applying everything: redeploy the `enrich-and-draft` edge function. The deployed
version string should read `2026-06-08-audit-fixes-v41.2`.

---

## Part 0 — Deploy order (do this top to bottom)

1. Run **SQL migration 1** (lookup locks) — Part 1
2. Run **SQL migration 2** (debug-log retention) — Part 2 (verify the timestamp column first)
3. Run **SQL migration 3** (campaigns) — Part 3
4. Confirm the **`GEMINI_API_KEY`** secret is set on the edge function (enables the 4th AI model)
5. Replace the **entire `index.ts`** with Part 4
6. Redeploy: `supabase functions deploy enrich-and-draft`

### Edge function secrets the code expects

| Secret | Status |
| --- | --- |
| `ANTHROPIC_API_KEY` | existing |
| `OPENAI_API_KEY` | existing |
| `DEEPSEEK_API_KEY` | existing |
| `GEMINI_API_KEY` | **new — required for Gemini ensemble model** |
| `MYEMAILVERIFIER_API_KEY` | existing |
| `GOOGLE_API_KEY` / `GOOGLE_CX` | existing |
| `BRAVE_API_KEY` | existing |
| `FULLENRICH_API_KEY` | existing |
| `PDL_API_KEY` | no longer used (safe to leave or remove) |

### How to run the SQL migrations in Supabase

For EACH of the three SQL blocks in Parts 1–3:

**Option A — Supabase Dashboard (simplest):**
1. Open your project at https://supabase.com/dashboard
2. Left sidebar → **SQL Editor** → **New query**
3. Copy the entire SQL block for that part and paste it into the editor
4. Click **Run** (or press Cmd/Ctrl + Enter)
5. Confirm it reports success with no errors, then move to the next part

**Option B — Supabase CLI (if you keep migrations in the repo):**
1. Create the file at the exact path shown in each part heading
2. Paste the SQL into it
3. Run `supabase db push` from the project root

Run them **in order (1 → 2 → 3)**. Migration 3 must be applied **before** the function is
redeployed, because the new function code calls the `increment_campaign_count` RPC and the
campaign tables it creates. Migration 1 must also precede the redeploy (the function calls
`acquire_lookup_lock`); the call is fail-open, but deploying the SQL first is cleanest.

---

## Part 1 — SQL Migration: `supabase/migrations/20260607000001_lookup_locks.sql`

Prevents two simultaneous lookups of the same profile from each deducting a credit.
Creates the `lookup_locks` table and the `acquire_lookup_lock` / `release_lookup_lock` RPCs.
Paste the whole block into the SQL editor and Run.

```sql
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
```

---

## Part 2 — SQL Migration: `supabase/migrations/20260607000002_enrichment_debug_logs_retention.sql`

**Before running:** confirm the timestamp column on `enrichment_debug_logs` is named
`created_at`. Run this in the SQL editor first:

```sql
select column_name from information_schema.columns
 where table_name = 'enrichment_debug_logs';
```

If the column is `inserted_at` instead of `created_at`, replace every `created_at` in the
block below before running it. Then paste the whole block into the SQL editor and Run.
(Optional: uncomment the pg_cron block at the bottom to auto-purge daily.)

```sql
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
```

---

## Part 3 — SQL Migration: `supabase/migrations/20260608000003_campaigns.sql`

**Important:** the Campaign feature in the extension depends on the `campaigns` and
`campaign_candidates` tables, which were never created by any migration. This is why
Campaigns do not work. This migration creates both tables (with row-level security) and
the atomic `increment_campaign_count` RPC. Paste the whole block into the SQL editor and Run.

If these tables already exist from earlier manual setup, the `create table if not exists`
guards make re-running safe; the indexes, RLS policies, and RPC will still be created.

```sql
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
```

---

## Part 4 — COMPLETE edge function: `supabase/functions/enrich-and-draft/index.ts`

This is the **entire final file**. Delete the current contents of
`supabase/functions/enrich-and-draft/index.ts` and replace it with everything inside the
code block below. Do not merge or patch — replace the whole file, then redeploy.

NOTE: this block is fenced with FOUR backticks because the code itself contains a
three-backtick sequence (in a regex). When copying, take everything between the four-backtick
lines.

````typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// Bump this string every meaningful deploy so we can verify what's live.
const FUNCTION_VERSION = "2026-06-08-audit-fixes-v41.2"
console.log(`[enrich boot] FUNCTION_VERSION=${FUNCTION_VERSION}`)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
  'X-Function-Version': FUNCTION_VERSION,
}

function json(data: unknown, status = 200) {
  // Stamp version into every JSON response so a single curl confirms the deploy.
  const payload = (data && typeof data === 'object' && !Array.isArray(data))
    ? { ...(data as Record<string, unknown>), _version: FUNCTION_VERSION }
    : { data, _version: FUNCTION_VERSION }
  return new Response(JSON.stringify(payload), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

async function callAnthropic(key: string, model: string, maxTokens: number, prompt: string): Promise<string> {
  const maxAttempts = 3
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) {
      const errBody = await res.text()
      console.error(`[callAnthropic] attempt ${attempt}/${maxAttempts} HTTP ${res.status} (model=${model}): ${errBody}`)
      lastErr = new Error(`Anthropic API error ${res.status}: ${errBody}`)
      if (res.status === 429 && attempt < maxAttempts) {
        const delay = attempt * 1500
        console.log(`[callAnthropic] rate-limited, retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw lastErr
    }
    const d = await res.json()
    return d.content?.[0]?.text?.trim() || '{}'
  }
  throw lastErr!
}

function parseJson(s: string): any {
  try { return JSON.parse(s.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()) } catch { return {} }
}

// ── OpenAI and DeepSeek JSON helpers (v40) ───────────────────────────────────
async function callOpenAIJson(
  key: string,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<any | null> {
  if (!key) return null
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  const txt = data?.choices?.[0]?.message?.content?.trim() || ''
  return txt ? parseJson(txt) : null
}

async function callDeepSeekJson(
  key: string,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<any | null> {
  if (!key) return null
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  const txt = data?.choices?.[0]?.message?.content?.trim() || ''
  return txt ? parseJson(txt) : null
}

// Gemini via its OpenAI-compatible endpoint — same wire format as OpenAI/DeepSeek,
// so it slots straight into the ensemble. Uses GEMINI_API_KEY (set in Supabase).
async function callGeminiJson(
  key: string,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<any | null> {
  if (!key) return null
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  const txt = data?.choices?.[0]?.message?.content?.trim() || ''
  return txt ? parseJson(txt) : null
}

// ── PII helpers ───────────────────────────────────────────────────────────────
// Known personal/free email domains — emails at these domains are never work addresses.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.co.in',
  'hotmail.com','hotmail.co.uk','outlook.com','live.com','msn.com',
  'icloud.com','me.com','mac.com','aol.com','protonmail.com','proton.me',
  'pm.me','tutanota.com','zoho.com','yandex.com','yandex.ru',
  'mail.com','inbox.com','gmx.com','gmx.net',
])
function isPersonalEmailDomain(email: string | null | undefined): boolean {
  if (!email) return false
  const domain = email.split('@')[1]?.toLowerCase()
  return !!domain && PERSONAL_EMAIL_DOMAINS.has(domain)
}

function maskEmail(e: string | null | undefined): string {
  if (!e || typeof e !== 'string' || !e.includes('@')) return String(e || '')
  const [u, d] = e.split('@')
  const head = u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***'
  return `${head}@${d}`
}

// ── Credit refund ───────────────────────────────────────────────────────────────
// Returns a lookup credit that was deducted up-front when a run ultimately produces
// nothing usable (NOT_ENOUGH_DATA). Best-effort and non-fatal: prefers an atomic
// refund_credit RPC if one exists, otherwise decrements credits.lookups_used directly
// (guarded so it never goes negative).
async function refundCredit(db: any, userId: string | null | undefined, reason: string): Promise<void> {
  if (!db || !userId) return
  try {
    const { error } = await db.rpc('refund_credit', { p_user_id: userId })
    if (!error) { console.log(`[refundCredit] refunded via RPC (reason=${reason})`); return }
  } catch { /* RPC may not exist — fall back to direct decrement */ }
  try {
    const { data: c } = await db.from('credits').select('lookups_used').eq('user_id', userId).maybeSingle()
    const used = typeof c?.lookups_used === 'number' ? c.lookups_used : 0
    if (used > 0) {
      await db.from('credits').update({ lookups_used: used - 1 }).eq('user_id', userId)
      console.log(`[refundCredit] refunded via table decrement (reason=${reason})`)
    }
  } catch (e) { console.warn('[refundCredit] non-fatal:', e) }
}

// ── Step logger ────────────────────────────────────────────────────────────────
type StepStatus = 'HIT' | 'OK' | 'SKIP' | 'MISS' | 'FAIL' | 'PERSONAL_HUNTING' | 'CATCHALL' | 'RISKY_FALLBACK'
interface StepRecord {
  step: string
  status: StepStatus
  ms: number
  reason?: string
  meta?: Record<string, unknown>
}

function makeStepLogger(db: any, userId: string | null, correlationId: string, action: string) {
  const records: StepRecord[] = []
  async function step<T>(
    name: string,
    fn: () => Promise<{ status: StepStatus; result?: T; reason?: string; meta?: Record<string, unknown> }>
  ): Promise<{ status: StepStatus; result?: T; reason?: string; meta?: Record<string, unknown> }> {
    const t0 = Date.now()
    let outcome: { status: StepStatus; result?: T; reason?: string; meta?: Record<string, unknown> }
    try {
      outcome = await fn()
    } catch (e: any) {
      outcome = { status: 'FAIL', reason: String(e?.message || e) }
    }
    const ms = Date.now() - t0
    const rec: StepRecord = { step: name, status: outcome.status, ms, reason: outcome.reason, meta: outcome.meta }
    records.push(rec)
    const metaStr = rec.meta ? ' ' + Object.entries(rec.meta).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ') : ''
    console.log(`[enrich ${correlationId}] ${name} → ${outcome.status} (${ms}ms)${rec.reason ? ' reason=' + rec.reason : ''}${metaStr}`)
    // Best-effort persistence (non-fatal)
    try {
      await db.from('enrichment_debug_logs').insert({
        user_id: userId,
        provider: name,
        request_payload: { correlation_id: correlationId, action },
        response_payload: { status: outcome.status, reason: outcome.reason || null, meta: rec.meta || null },
        status_code:
          outcome.status === 'OK' || outcome.status === 'HIT' ? 200
          : outcome.status === 'SKIP' ? 204
          : outcome.status === 'MISS' ? 404
          // Informational / uncertain-but-usable outcomes are not failures — keep them
          // out of the 500 bucket so success/failure analytics stay meaningful.
          : outcome.status === 'CATCHALL' || outcome.status === 'RISKY_FALLBACK' || outcome.status === 'PERSONAL_HUNTING' ? 200
          : 500,
      })
    } catch {}
    return outcome
  }
  return { step, records }
}

// ── FullEnrich v2: LinkedIn URL → work email, personal email, name, title, company ──
async function enrichWithLinkedInV2(linkedinUrl: string, key: string): Promise<{
  full_name: string | null
  work_email: string | null
  personal_email: string | null
  title: string | null
  company: string | null
  company_domain: string | null
  raw: any
}> {
  const empty = { full_name: null, work_email: null, personal_email: null, title: null, company: null, company_domain: null, raw: null }

  const startRes = await fetch('https://app.fullenrich.com/api/v2/contact/enrich/bulk', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      name: `OutreachAI-${Date.now()}`,
      data: [{ linkedin_url: linkedinUrl, enrich_fields: ['contact.emails'] }],
    }),
  })

  const startData = await startRes.json()
  if (!startRes.ok) throw new Error(`FullEnrich start error ${startRes.status}: ${JSON.stringify(startData)}`)

  const enrichmentId = startData.enrichment_id
  if (!enrichmentId) throw new Error('FullEnrich did not return enrichment_id')

  await new Promise(r => setTimeout(r, 3000))
  for (let i = 0; i < 22; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 5000))

    const pollRes = await fetch(`https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`, {
      headers: { 'Authorization': `Bearer ${key}` },
    })
    const pollData = await pollRes.json()

    if (pollData.status === 'FINISHED') {
      const results = pollData.datas ?? pollData.data ?? []
      const row = results[0]
      if (!row) return { ...empty, raw: pollData }

      const contactInfo = row.contact_info ?? row.contact?.contact_info ?? null
      const profile     = row.profile ?? row.contact?.profile ?? {}
      const current     = profile.employment?.current

      const workEmail = contactInfo?.most_probable_work_email?.email
        ?? contactInfo?.work_emails?.[0]?.email
        ?? row.contact?.most_probable_email
        ?? null
      const personalEmail = contactInfo?.most_probable_personal_email?.email
        ?? contactInfo?.personal_emails?.[0]?.email
        ?? null

      return {
        full_name:      profile.full_name || null,
        work_email:     workEmail,
        personal_email: personalEmail,
        title:          current?.title || null,
        company:        current?.company?.name || null,
        company_domain: current?.company?.domain || null,
        raw:            pollData,
      }
    }

    if (pollData.status === 'FAILED') throw new Error('FullEnrich enrichment failed')
  }

  throw new Error('FullEnrich timeout — enrichment did not complete within 55s')
}

// ── Employer resolution from email domain ──
async function resolveEmployer(domain: string, db: any, anthropicKey: string): Promise<{ company: string; confidence: number }> {
  const { data: cached } = await db.from('company_domains').select('canonical_company_name,confidence').eq('domain', domain).single()
  if (cached) return { company: cached.canonical_company_name, confidence: cached.confidence }

  const known: Record<string, string> = {
    'google.com': 'Google', 'microsoft.com': 'Microsoft', 'apple.com': 'Apple',
    'amazon.com': 'Amazon', 'meta.com': 'Meta', 'salesforce.com': 'Salesforce',
    'bms.com': 'Bristol Myers Squibb', 'pfizer.com': 'Pfizer', 'jnj.com': 'Johnson & Johnson',
    'ibm.com': 'IBM', 'oracle.com': 'Oracle', 'adobe.com': 'Adobe', 'stripe.com': 'Stripe',
    'openai.com': 'OpenAI', 'anthropic.com': 'Anthropic', 'goodparty.org': 'Good Party',
  }
  if (known[domain]) {
    await db.from('company_domains').upsert({ domain, canonical_company_name: known[domain], confidence: 0.99 })
    return { company: known[domain], confidence: 0.99 }
  }

  if (!anthropicKey) return { company: domain, confidence: 0.3 }

  const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 100,
    `What company uses email domain "${domain}"? Reply ONLY JSON: {"company_name":"...","confidence":0.0-1.0}`)
  const p = parseJson(raw)
  const company = p.company_name || domain
  const confidence = typeof p.confidence === 'number' ? p.confidence : 0.4
  await db.from('company_domains').upsert({ domain, canonical_company_name: company, confidence })
  return { company, confidence }
}

// ── Title fallback ──
async function inferTitleFallback(fullName: string, company: string, anthropicKey: string): Promise<{
  title: string | null
  confidence: number
}> {
  if (!anthropicKey) return { title: null, confidence: 0 }

  const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 200, `
You are inferring a person's current job title from your training data only.
Do NOT use LinkedIn or any LinkedIn-adjacent source.
Use only: company websites, press releases, conference bios, SEC filings, Crunchbase, ZoomInfo-type public records.
If you have no reliable non-LinkedIn evidence, return title: null and confidence: 0.

Person: "${fullName}" at "${company}"

Return ONLY JSON: {"title": "job title or null", "confidence": 0.0}`)

  const p = parseJson(raw)
  const confidence = typeof p.confidence === 'number' ? Math.min(p.confidence, 0.6) : 0
  return {
    title: confidence >= 0.25 ? (p.title || null) : null,
    confidence,
  }
}

// ── Company name → domain hint cache ─────────────────────────────────────────
// Stores confirmed company_name → email_domain mappings so resolve_domain
// can skip the MX-validation guessing loop on repeat lookups.

function normalizeCompanyKey(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 80)
}

async function upsertCompanyDomainHint(
  db: any,
  companyName: string | null,
  domain: string | null,
): Promise<void> {
  if (!db || !companyName || !domain) return
  const key = normalizeCompanyKey(companyName)
  if (key.length < 3) return
  try {
    await db.rpc('upsert_company_domain_hint', { p_company_key: key, p_domain: domain })
    console.log(`[upsertCompanyDomainHint] ${key} → ${domain}`)
  } catch (e) { console.warn('[upsertCompanyDomainHint] non-fatal:', e) }
}

// ── Email pattern helpers ─────────────────────────────────────────────────────
function normalizeNameParts(fullName: string): string[] {
  const drop = new Set([
    'mr', 'mrs', 'ms', 'mx', 'dr', 'prof',
    'jr', 'sr', 'ii', 'iii', 'iv', 'v',
    'mba', 'mba.', 'phd', 'ph.d', 'md', 'm.d', 'esq', 'cpa'
  ])

  return (fullName || '')
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/^[^a-z0-9]+|[^a-z0-9-]+$/gi, '').toLowerCase())
    .filter((part) => part && !drop.has(part))
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = normalizeNameParts(fullName)
  if (parts.length === 0) return { first: '', last: '' }
  if (parts.length === 1) return { first: parts[0].toLowerCase(), last: '' }
  return { first: parts[0].toLowerCase(), last: parts[parts.length - 1].toLowerCase() }
}

function hasUsableWaterfallName(fullName: string | null | undefined): boolean {
  const { first, last } = splitName(fullName || '')
  return sanitizeLocal(first).length >= 2 && sanitizeLocal(last).length >= 2
}

function sanitizeLocal(s: string): string {
  return s.normalize('NFKD').replace(/[^\w]/g, '').toLowerCase()
}

function sanitizeDomain(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^@/, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
  if (!cleaned || !cleaned.includes('.')) return null
  return cleaned.replace(/[^a-z0-9.-]/g, '') || null
}

function inferDomainFromCompanyName(companyName: string | null): string | null {
  return inferDomainCandidates(companyName)[0] || null
}

function inferDomainCandidates(companyName: string | null): string[] {
  if (!companyName) return []
  const suffixes = new Set([
    'inc', 'inc.', 'llc', 'l.l.c.', 'ltd', 'ltd.', 'limited', 'corp', 'corp.', 'corporation',
    'company', 'co', 'co.', 'holdings', 'group', 'partners', 'ventures', 'capital', 'labs',
    'lab', 'systems', 'solutions', 'technologies', 'technology', 'tech', 'international',
    'global', 'usa', 'us', 'plc', 'gmbh', 'ag', 'sa', 'bv', 'pty', 'lp', 'llp'
  ])
  const stopwords = new Set(['the', 'and'])

  const normalized = companyName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return []

  const rawTokens = normalized.split(' ').filter(Boolean)
  const filteredTokens = rawTokens.filter((token) => !suffixes.has(token) && !stopwords.has(token))
  const bestTokens = (filteredTokens.length > 0 ? filteredTokens : rawTokens).map((token) => token.replace(/-/g, ''))
  const joined = bestTokens.join('')

  if (joined.length < 3) return []
  if (/^(unknown|selfemployed|stealth|confidential)$/.test(joined)) return []

  const candidates = new Set<string>([`${joined}.com`])

  const regionPhrases: Array<{ phrase: string[]; abbreviation: string }> = [
    { phrase: ['north', 'america'], abbreviation: 'na' },
    { phrase: ['south', 'america'], abbreviation: 'sa' },
    { phrase: ['latin', 'america'], abbreviation: 'latam' },
    { phrase: ['asia', 'pacific'], abbreviation: 'apac' },
    { phrase: ['united', 'states'], abbreviation: 'us' },
  ]

  for (const { phrase, abbreviation } of regionPhrases) {
    if (bestTokens.length > phrase.length && phrase.every((token, idx) => bestTokens[bestTokens.length - phrase.length + idx] === token)) {
      const base = bestTokens.slice(0, -phrase.length).join('')
      if (base.length >= 3) candidates.add(`${base}${abbreviation}.com`)
    }
  }

  if (bestTokens.length >= 2) {
    const lastTwo = bestTokens.slice(-2)
    const initialTail = lastTwo.every((token) => token.length > 0) ? lastTwo.map((token) => token[0]).join('') : ''
    const base = bestTokens.slice(0, -2).join('')
    if (base.length >= 3 && initialTail.length === 2) candidates.add(`${base}${initialTail}.com`)
  }

  return Array.from(candidates).map((value) => sanitizeDomain(value)).filter((value): value is string => !!value)
}

function defaultPatterns(fullName: string, domain: string): string[] {
  const { first, last } = splitName(fullName)
  const f = sanitizeLocal(first)
  const l = sanitizeLocal(last)
  if (!f || !domain) return []
  const out: string[] = []
  if (f && l) out.push(`${f}.${l}@${domain}`)
  if (f && l) out.push(`${f[0]}${l}@${domain}`)
  out.push(`${f}@${domain}`)
  if (f && l) out.push(`${f}${l}@${domain}`)
  return Array.from(new Set(out)).slice(0, 3)
}

//── Phone helpers ─────────────────────────────────────────────────────────────
function extractPhones(text: string): string[] {
  const patterns = [
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    /(\+\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,
    /ext\.?\s*\d{2,6}\b/gi,
    /x\d{2,6}\b/gi,
  ]
  const found: string[] = []
  for (const pattern of patterns) {
    const matches = text.match(pattern) || []
    found.push(...matches)
  }
  return Array.from(new Set(found.map(p => p.trim())))
}

function normalizePhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '')
  if (digits.length >= 10 && digits.length <= 15) {
    return digits
  }
  return null
}

// ── Standard 15-permutation set used by every open-source email finder ────────
// Pattern names mirror Hunter / Clearbit / Apify Waterfall conventions.
function standardPermutations(fullName: string, domain: string): Array<{ email: string; pattern: string }> {
  const { first, last } = splitName(fullName)
  const f = sanitizeLocal(first)
  const l = sanitizeLocal(last)
  if (!f || !domain) return []
  const fi = f[0] || ''
  const li = l[0] || ''
  const set = new Map<string, string>() // email -> pattern label
  const add = (local: string, pattern: string) => {
    if (!local) return
    const email = `${local}@${domain}`.toLowerCase()
    if (!set.has(email)) set.set(email, pattern)
  }
  // High-priority business patterns (cover >90% of corporate domains)
  if (l) add(`${f}.${l}`,  'first.last')
  if (l) add(`${fi}${l}`,  'flast')
  add(f,                   'first')
  if (l) add(`${f}${l}`,   'firstlast')
  if (l) add(`${f}_${l}`,  'first_last')
  if (l) add(`${f}-${l}`,  'first-last')
  if (l) add(`${f}${li}`,  'firstl')
  if (l) add(`${fi}.${l}`, 'f.last')
  if (l) add(`${l}.${f}`,  'last.first')
  if (l) add(`${l}${fi}`,  'lastf')
  if (l) add(l,            'last')
  if (l) add(`${l}.${fi}`, 'last.f')
  if (l) add(`${l}_${f}`,  'last_first')
  if (l) add(`${l}-${f}`,  'last-first')
  if (l) add(`${fi}_${l}`, 'f_last')
  return Array.from(set.entries()).map(([email, pattern]) => ({ email, pattern }))
}

const COMMON_PATTERN_RANK: Record<string, number> = {
  'first.last': 100, 'flast': 95, 'first': 80, 'firstlast': 70, 'f.last': 60,
  'first_last': 55, 'first-last': 50, 'firstl': 45, 'last.first': 30, 'lastf': 25,
  'last': 20, 'last.f': 15, 'last_first': 10, 'last-first': 8, 'f_last': 5,
}

// ── DNS-over-HTTPS MX lookup (Cloudflare 1.1.1.1) ─────────────────────────────
// Workers/Edge runtimes don't support native DNS; DoH is the standard substitute.
async function hasMxRecord(domain: string): Promise<boolean> {
  if (!domain) return false
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { 'Accept': 'application/dns-json' },
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => null) as any
    const answers = Array.isArray(data?.Answer) ? data.Answer : []
    return answers.some((a: any) => a?.type === 15 && typeof a?.data === 'string' && a.data.length > 0)
  } catch { return false }
}

async function pickMxValidatedDomain(candidates: string[]): Promise<string | null> {
  for (const d of candidates) {
    if (!d) continue
    if (await hasMxRecord(d)) return d
  }
  return null
}

// ── Email pattern detection & caching helpers ─────────────────────────────────

function detectPattern(email: string, fullName: string): string | null {
  const { first, last } = splitName(fullName)
  const f = sanitizeLocal(first)
  const l = sanitizeLocal(last)
  if (!f || !l || !email.includes('@')) return null
  const local = email.split('@')[0].toLowerCase()
  if (local === `${f}.${l}`)    return 'first.last'
  if (local === `${f[0]}${l}`)  return 'flast'
  if (local === f)              return 'first'
  if (local === `${f}${l}`)     return 'firstlast'
  if (local === `${l}.${f}`)    return 'last.first'
  if (local === `${f}_${l}`)    return 'first_last'
  if (local === `${f[0]}.${l}`) return 'f.last'
  if (local === `${l}${f[0]}`)  return 'lastf'
  if (local === `${f}${l[0]}`)  return 'firstl'
  return null
}

function applyPattern(pattern: string, fullName: string, domain: string): string | null {
  const { first, last } = splitName(fullName)
  const f = sanitizeLocal(first)
  const l = sanitizeLocal(last)
  if (!f || !l) return null
  const locals: Record<string, string> = {
    'first.last': `${f}.${l}`,
    'flast':      `${f[0]}${l}`,
    'first':      f,
    'firstlast':  `${f}${l}`,
    'last.first': `${l}.${f}`,
    'first_last': `${f}_${l}`,
    'f.last':     `${f[0]}.${l}`,
    'lastf':      `${l}${f[0]}`,
    'firstl':     `${f}${l[0]}`,
  }
  const local = locals[pattern]
  return local ? `${local}@${domain}` : null
}

async function upsertEmailPattern(db: any, domain: string, email: string, fullName: string, isCatchall = false): Promise<void> {
  const pattern = detectPattern(email, fullName)
  if (!pattern) return
  try {
    // Uses the upsert_email_pattern SQL function which increments verified_count
    // on (domain, verified_pattern) conflict — supports multiple patterns per domain.
    await db.rpc('upsert_email_pattern', {
      p_domain:       domain,
      p_pattern:      pattern,
      p_sample_email: maskEmail(email),
      p_is_catchall:  isCatchall,
    })
    console.log(`[upsertEmailPattern] ${domain} pattern=${pattern} catchall=${isCatchall}`)
  } catch (e) {
    console.warn('[upsertEmailPattern] non-fatal:', e)
  }
}

// ── Haiku pattern picker — for catch-all domains with multiple verified patterns ─
// Called when we have N≥2 patterns per domain and can't use MEV to distinguish.
// Haiku weighs observed frequency + name characteristics to pick the best email.
async function haikuPickPattern(
  fullName: string,
  domain: string,
  patterns: CachedPattern[],
  anthropicKey: string,
): Promise<string | null> {
  // Build option list: apply each pattern to the name
  const options = patterns
    .map(p => ({ pattern: p.pattern, email: applyPattern(p.pattern, fullName, domain), count: p.count }))
    .filter((o): o is { pattern: string; email: string; count: number } => !!o.email)
  if (options.length === 0) return null
  if (options.length === 1 || !anthropicKey) return options[0].email   // most-frequent, zero AI cost

  const patternList = options
    .map((o, i) => `${i + 1}. ${o.pattern} → ${o.email} (${o.count} verified employee${o.count !== 1 ? 's' : ''})`)
    .join('\n')

  const prompt = `Pick the most likely work email for a person at a company whose mail server is catch-all (email verification cannot confirm individual addresses).

Domain: ${domain}
Person: ${fullName}

Verified patterns ranked by frequency of observed employees:
${patternList}

Rules:
- The highest-frequency pattern is usually correct.
- Only choose a lower-frequency pattern if there is a very strong name-based reason (e.g. the person shares a first name with many others and the company likely uses first.last for disambiguation).
- Return ONLY JSON: {"pick":"<full email address>","reasoning":"<one sentence>"}`

  try {
    const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 120, prompt)
    const parsed = parseJson(raw)
    if (typeof parsed?.pick === 'string' && parsed.pick.includes('@')) {
      const pick = parsed.pick.toLowerCase().trim()
      if (options.some(o => o.email === pick)) {
        console.log(`[haikuPickPattern] picked ${maskEmail(pick)} — ${parsed.reasoning || ''}`)
        return pick
      }
    }
  } catch (e) {
    console.warn('[haikuPickPattern] failed, using most-frequent fallback:', e)
  }
  return options[0].email  // fallback: most-verified pattern
}

// ── Step 2: Claude Haiku email pattern guess ──────────────────────────────────
// Pattern priors by company size (Interseller study, millions of domains):
//   1-10:    {first} 71%, {f}{last} 13%, {first}.{last} 10%
//   11-50:   {first} 42%, {f}{last} 27%, {first}.{last} 23%
//   51-200:  {f}{last} 42%, {first}.{last} 30%, {first} 17%
//   201-1k:  {f}{last} 43%, {first}.{last} 38%, {first} 6%
//   1k+:     {first}.{last} 48-56%, {f}{last} 22-35%, {first} 4-7%
async function haikuEmailGuess(
  fullName: string,
  companyName: string | null,
  domain: string | null,
  anthropicKey: string,
  companySize: number | null = null
): Promise<{ candidates: string[]; confidence: number; domain: string | null }> {
  const deterministicDomain = sanitizeDomain(domain) || inferDomainFromCompanyName(companyName)
  if (!anthropicKey || !fullName) {
    return {
      candidates: deterministicDomain ? defaultPatterns(fullName, deterministicDomain) : [],
      confidence: deterministicDomain ? 0.25 : 0,
      domain: deterministicDomain,
    }
  }

  // Translate company size into a prior hint for the model.
  let sizeBand = 'unknown (assume 50-500 employees)'
  let priorHint = '{f}{last} ~40%, {first}.{last} ~30%, {first} ~15%'
  if (companySize !== null && companySize > 0) {
    if (companySize <= 10)        { sizeBand = `${companySize} employees (micro)`;  priorHint = '{first} ~70%, {f}{last} ~13%, {first}.{last} ~10%' }
    else if (companySize <= 50)   { sizeBand = `${companySize} employees (small)`;  priorHint = '{first} ~42%, {f}{last} ~27%, {first}.{last} ~23%' }
    else if (companySize <= 200)  { sizeBand = `${companySize} employees (mid)`;    priorHint = '{f}{last} ~42%, {first}.{last} ~30%, {first} ~17%' }
    else if (companySize <= 1000) { sizeBand = `${companySize} employees (large)`;  priorHint = '{f}{last} ~43%, {first}.{last} ~38%, {first} ~6%' }
    else                          { sizeBand = `${companySize} employees (enterprise)`; priorHint = '{first}.{last} ~52%, {f}{last} ~28%, {first} ~5%' }
  }

  const prompt = `You are guessing a person's most likely WORK email address. Order matters: a downstream verifier tries candidates in order and stops at the first valid one.

Person: "${fullName}"
Company: "${companyName || 'unknown'}"
Company size hint: ${sizeBand}
Known company email domain (if any): "${domain || 'unknown'}"
Deterministic best-guess domain from company name (use unless you know better): "${deterministicDomain || 'unknown'}"

DOMAIN INFERENCE:
- If the domain is unknown, infer it from the company name. Strip suffixes (Inc, LLC, Corp, Co, Ltd, Group, The, Holdings, Partners) and spaces.
  Examples: "Forage Evolution Inc" → forageevolution.com; "Acme Robotics" → acmerobotics.com; "OpenAI" → openai.com.
- For tech-sounding companies, .io / .ai / .co are also common; for nonprofits .org.
- Return domain: null ONLY when the company name is empty, generic ("unknown", "self-employed", "stealth"), or truly unguessable.

PATTERN PRIORS for this size band: ${priorHint}
Use these probabilities to ORDER candidates. Most-likely pattern first.

NAME-HANDLING RULES:
- Strip diacritics (José → jose, Müller → muller).
- Hyphenated last names: try both hyphen-kept and hyphen-collapsed (mary-jane → maryjane).
- Particles (van, von, de, der, di, la): try both collapsed (vanderberg) and stripped (berg).
- Single-name (mononym) people: only patterns based on that one name.
- Suffixes (Jr, Sr, II, III, PhD, MD): drop them.

ALLOWED PATTERNS (use lowercase, no spaces): {first}.{last}, {f}{last}, {first}, {first}{last}, {first}{l}, {f}.{last}, {first}-{last}, {first}_{last}, {last}.{first}, {last}{f}.

Return ONLY JSON in this exact shape:
{"domain":"example.com or null","candidates":["a@example.com","b@example.com","c@example.com","d@example.com","e@example.com"],"confidence":0.0}

Rules:
- Provide 4–5 candidates ordered most-likely first per the size-band priors above.
- All candidates MUST be at the same domain (the one in "domain").
- Local-parts must be lowercase ASCII, no spaces.
- confidence: 0.0–1.0. Use 0.6+ when domain is well-known, 0.3–0.5 when you inferred it from the name, <0.3 when the company itself is uncertain.`

  const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 400, prompt)
  const p = parseJson(raw)
  let candidates: string[] = Array.isArray(p.candidates) ? p.candidates.filter((x: any) => typeof x === 'string' && x.includes('@')) : []
  candidates = candidates.map(c => c.toLowerCase().trim())

  // Resolve domain in priority order:
  //   1. Haiku's explicit domain field
  //   2. Deterministic guess from company name (e.g. "Evry1" → evry1.com)
  //   3. Domain extracted from Haiku's own candidates (recovers when model returns
  //      candidates but forgets/nulls the domain field)
  //   4. Last-resort slug of company name (lowercase + alnum + .com)
  let inferredDomain: string | null =
    sanitizeDomain(typeof p.domain === 'string' ? p.domain : null) || deterministicDomain
  if (!inferredDomain && candidates.length > 0) {
    const fromCandidate = sanitizeDomain(candidates[0].split('@')[1] || null)
    if (fromCandidate) inferredDomain = fromCandidate
  }
  if (!inferredDomain && companyName) {
    const slug = companyName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')
    if (slug.length >= 3) inferredDomain = sanitizeDomain(`${slug}.com`)
  }

  // Enforce domain consistency on candidates we keep (don't filter to zero —
  // if none match, we'll regenerate from defaultPatterns below).
  if (inferredDomain) {
    const matching = candidates.filter(c => c.endsWith('@' + inferredDomain))
    if (matching.length > 0) candidates = matching
    else candidates = []
  }
  // Dedupe while preserving order
  candidates = Array.from(new Set(candidates))
  // Fallback to deterministic patterns if Haiku didn't return usable candidates
  if (candidates.length === 0 && inferredDomain) {
    candidates = defaultPatterns(fullName, inferredDomain)
  }
  const confidence = typeof p.confidence === 'number' ? p.confidence : (inferredDomain ? (sanitizeDomain(typeof p.domain === 'string' ? p.domain : null) ? 0.4 : 0.25) : 0)
  const finalCandidates = candidates.slice(0, 5)
  console.log('[haiku candidates]', {
    companyName, domain: inferredDomain, deterministicDomain,
    haikuReturnedDomain: typeof p.domain === 'string' ? p.domain : null,
    sizeBand, n: finalCandidates.length, masked: finalCandidates.map(maskEmail),
  })
  return { candidates: finalCandidates, confidence, domain: inferredDomain }
}

// ── Step 3: Google CSE — find a publicly-referenced email ────────────────────
// Runs up to 4 progressively broader queries, stopping at the first that yields a
// domain-matching email. Mirrors how Hunter / RocketReach surface emails: site-scoped
// first, then public profile sites, then documents (PDF/DOC), then deobfuscated open web.
async function googleCseFindEmail(
  fullName: string, companyName: string | null, domain: string | null,
  apiKey: string, cx: string
): Promise<{ email: string | null; rawCount: number }> {
  if (!apiKey || !cx || !fullName) return { email: null, rawCount: 0 }
  const domainCandidates = Array.from(new Set([
    sanitizeDomain(domain),
    ...inferDomainCandidates(companyName),
  ].filter((value): value is string => !!value)))
  const normalizedDomain = domainCandidates[0] || null
  const company = (companyName || '').trim()
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

  // Replace common obfuscations so the regex can pick up emails like "name [at] domain".
  function deobfuscate(text: string): string {
    return text
      .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
      .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
      .replace(/\s+at\s+(?=[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi, '@')
      .replace(/\s*\[\s*dot\s*\]\s*/gi, '.')
      .replace(/\s*\(\s*dot\s*\)\s*/gi, '.')
  }

  // Build up to 4 query variants; stop early on first domain-matching email.
  const queries: string[] = []
  for (const candidateDomain of domainCandidates) {
    queries.push(`"${fullName}" site:${candidateDomain}`)
  }
  if (company) {
    queries.push(`"${fullName}" "${company}" (site:linkedin.com OR site:zoominfo.com OR site:rocketreach.co OR site:crunchbase.com)`)
    queries.push(`"${fullName}" "${company}" (filetype:pdf OR filetype:doc OR filetype:docx) "@"`)
  }
  for (const candidateDomain of domainCandidates) {
    queries.push(`"${fullName}" ("@${candidateDomain}" OR "[at] ${candidateDomain}" OR "(at) ${candidateDomain}")`)
  }
  if (domainCandidates.length === 0 && company) {
    queries.push(`"${fullName}" "${company}" email`)
  }

  let totalFound = 0
  let bestOffDomain: string | null = null
  const seen = new Set<string>()

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]
    if (seen.has(q)) continue
    seen.add(q)
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=10`
    let data: any
    try {
      const res = await fetch(url)
      if (!res.ok) {
        console.log('[google query]', { n: i + 1, q, status: res.status, error: true })
        continue
      }
      data = await res.json()
    } catch (e: any) {
      console.log('[google query]', { n: i + 1, q, error: String(e?.message || e) })
      continue
    }
    const items = Array.isArray(data.items) ? data.items : []
    const haystack = deobfuscate(items.map((it: any) => `${it.title || ''} ${it.snippet || ''} ${it.link || ''}`).join(' \n '))
    const all = (haystack.match(emailRe) || []).map(e => e.toLowerCase())
    totalFound += all.length

    let domainMatch: string | null = null
    if (domainCandidates.length > 0) {
      domainMatch = all.find(e => domainCandidates.some((candidateDomain) => e.endsWith('@' + candidateDomain))) || null
    }
    console.log('[google query]', { n: i + 1, q, items: items.length, emails_found: all.length, domain_match: domainMatch ? maskEmail(domainMatch) : null })

    if (domainMatch) {
      return { email: domainMatch, rawCount: totalFound }
    }
    if (!normalizedDomain && !bestOffDomain && all.length > 0) {
      // Only accept off-domain emails when no domain is known.
      bestOffDomain = all[0]
    }
  }

  return { email: bestOffDomain, rawCount: totalFound }
}

async function googleCseFindCompanyDomain(
  companyName: string | null,
  apiKey: string,
  cx: string,
): Promise<string | null> {
  if (!companyName || !apiKey || !cx) return null

  const blockedHosts = new Set([
    'linkedin.com', 'zoominfo.com', 'rocketreach.co', 'crunchbase.com', 'apollo.io',
    'pitchbook.com', 'theorg.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
    'bloomberg.com', 'youtube.com', 'glassdoor.com'
  ])

  const queries = [`"${companyName}" official website`, `"${companyName}"`]
  for (const q of queries) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=5`
      const res = await fetch(url)
      if (!res.ok) continue
      const data = await res.json().catch(() => null) as any
      const items = Array.isArray(data?.items) ? data.items : []

      for (const item of items) {
        const rawUrl = typeof item?.link === 'string' ? item.link : null
        if (!rawUrl) continue

        let host: string | null = null
        try {
          host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
        } catch {
          continue
        }

        if (!host || !host.includes('.')) continue
        if ([...blockedHosts].some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) continue

        const domain = sanitizeDomain(host)
        if (domain) return domain
      }
    } catch {}
  }

  return null
}

// ── Company discovery: ranked candidate companies from free sources ──────────
// Returns up to N candidates so the cheap waterfall can try the top employer
// AND known contractor/vendor patterns (e.g. "via Magnit") without burning
// a FullEnrich credit when the LinkedIn DOM scrape misses.
interface CompanyCandidate {
  name: string
  source: string        // 'manual' | 'scrape' | 'cache' | 'raw_employment' | 'google_snippet' | 'contractor_vendor'
  confidence: number    // 0..1
  scope?: 'person' | 'global'
}

// Minimum confidence required for a discovered candidate to be trusted enough
// to spend a credit on. Anything below this triggers NEED_COMPANY so the user
// can confirm before we charge or run a wrong-company waterfall.
const MIN_COMPANY_CONFIDENCE = 0.60

// Extract likely current employers from a previously-cached raw enrichment
// payload (FullEnrich `profile.employment.*`). This is person-scoped — it only
// gets called for the same linkedin_url, so it cannot leak another candidate's
// company across profiles.
function extractCompaniesFromRawProfile(raw: any): Array<{ name: string; domain: string | null }> {
  if (!raw || typeof raw !== 'object') return []
  const out: Array<{ name: string; domain: string | null }> = []
  const seen = new Set<string>()
  const push = (name: any, domain: any) => {
    if (!name || typeof name !== 'string') return
    const trimmed = name.trim()
    if (trimmed.length < 2) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ name: trimmed, domain: typeof domain === 'string' && domain ? domain : null })
  }
  try {
    // FullEnrich shape: data[0].profile.employment.{current, all[]}
    const profile = raw?.profile
      || (Array.isArray(raw?.data) ? raw.data[0]?.profile : null)
      || raw
    const emp = profile?.employment
    if (emp) {
      const cur = emp.current
      if (cur?.company?.name) push(cur.company.name, cur.company.domain)
      const all = Array.isArray(emp.all) ? emp.all : []
      // Prefer entries explicitly marked is_current.
      for (const e of all) {
        if (e?.is_current && e?.company?.name) push(e.company.name, e.company.domain)
      }
      // Then any with no end_at (still ongoing).
      for (const e of all) {
        if (!e?.end_at && e?.company?.name) push(e.company.name, e.company.domain)
      }
    }
  } catch {}
  return out
}

function extractCompaniesFromSnippet(text: string): Array<{ name: string; source: string }> {
  if (!text) return []
  const out: Array<{ name: string; source: string }> = []
  const clean = text.replace(/\s+/g, ' ').trim()

  // Contractor / vendor patterns: "at Waymo via Magnit", "contracting for Waymo"
  const viaMatch = clean.match(/\bat\s+([A-Z][\w&.\- ]{1,60}?)\s+(?:via|through|c\/o|on behalf of)\s+([A-Z][\w&.\- ]{1,60})/i)
  if (viaMatch) {
    out.push({ name: viaMatch[1].trim(), source: 'contractor_end_employer' })
    out.push({ name: viaMatch[2].trim(), source: 'contractor_vendor' })
  }
  const contractingMatch = clean.match(/\bcontract(?:ing|or)\s+(?:for|at)\s+([A-Z][\w&.\- ]{1,60})/i)
  if (contractingMatch) out.push({ name: contractingMatch[1].trim(), source: 'contractor_end_employer' })

  // "Title at Company" — common LinkedIn snippet shape.
  const atMatch = clean.match(/\s+at\s+([A-Z][\w&.\-' ]{1,80}?)(?:\s+[·.|]|\s*$)/)
  if (atMatch) out.push({ name: atMatch[1].trim(), source: 'snippet_at' })

  // "Company · Title" inverse shape.
  const dotMatch = clean.match(/^([A-Z][\w&.\-' ]{1,80})\s*[·|]\s*[A-Z]/)
  if (dotMatch) out.push({ name: dotMatch[1].trim(), source: 'snippet_dot' })

  return out.filter(c => c.name && c.name.length >= 2 && !/^linkedin$/i.test(c.name))
}

async function googleCseFindCompaniesFromLinkedIn(
  linkedinUrl: string | null, fullName: string | null,
  apiKey: string, cx: string,
): Promise<Array<{ name: string; source: string }>> {
  if (!apiKey || !cx) return []
  const queries: string[] = []
  if (linkedinUrl) queries.push(`site:linkedin.com/in "${linkedinUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}"`)
  if (fullName) queries.push(`"${fullName}" site:linkedin.com/in`)
  const seen: Array<{ name: string; source: string }> = []
  for (const q of queries) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=5`
      const res = await fetch(url)
      if (!res.ok) continue
      const data: any = await res.json().catch(() => null)
      const items = Array.isArray(data?.items) ? data.items : []
      for (const it of items) {
        const text = `${it.title || ''} ${it.snippet || ''} ${it.htmlSnippet || ''}`
        for (const c of extractCompaniesFromSnippet(text)) {
          if (!seen.some(s => s.name.toLowerCase() === c.name.toLowerCase())) seen.push(c)
        }
      }
      if (seen.length > 0) break
    } catch {}
  }
  return seen
}

async function discoverCompanyCandidates(opts: {
  manual: string | null
  scraped: string | null
  cached: string | null
  rawEmployment?: Array<{ name: string; domain: string | null }>
  csvEmailDomain?: string | null
  linkedinUrl: string | null
  fullName: string | null
  googleKey: string
  googleCx: string
}): Promise<CompanyCandidate[]> {
  const out: CompanyCandidate[] = []
  const push = (name: string | null | undefined, source: string, confidence: number, scope: 'person' | 'global' = 'person') => {
    if (!name) return
    const trimmed = String(name).trim()
    if (trimmed.length < 2) return
    if (out.some(c => c.name.toLowerCase() === trimmed.toLowerCase())) return
    out.push({ name: trimmed, source, confidence, scope })
  }

  // Person-scoped, high-trust sources first.
  push(opts.manual,  'manual', 0.95)
  push(opts.scraped, 'scrape', 0.80)
  push(opts.cached,  'cache',  0.75)

  // Person-scoped, medium-trust: pulled from this profile's own cached raw payload.
  if (Array.isArray(opts.rawEmployment)) {
    for (const e of opts.rawEmployment) push(e.name, 'raw_employment', 0.70)
  }

  // Free Google snippet discovery — only if we still don't have a strong candidate.
  if (out.length === 0 || out[0].confidence < 0.75) {
    if (opts.googleKey && opts.googleCx) {
      try {
        const found = await googleCseFindCompaniesFromLinkedIn(
          opts.linkedinUrl, opts.fullName, opts.googleKey, opts.googleCx,
        )
        for (const f of found) {
          const conf = f.source === 'contractor_end_employer' ? 0.72
                     : f.source === 'contractor_vendor'       ? 0.45
                     : f.source === 'snippet_at'              ? 0.65
                     : f.source === 'snippet_dot'             ? 0.55
                     : 0.40
          push(f.name, `google_${f.source}`, conf)
        }
      } catch (e) { console.warn('[discoverCompanyCandidates] google snippet failed:', e) }
    }
  }

  // Sort by confidence, cap at 4 candidates.
  out.sort((a, b) => b.confidence - a.confidence)
  return out.slice(0, 4)
}

// ── Step 4: MyEmailVerifier — validate a single email ─────────────────────────
async function myEmailVerifierValidate(
  email: string, key: string
): Promise<{ status: 'valid' | 'invalid' | 'risky' | 'unknown'; raw: any }> {
  if (!key || !email) return { status: 'unknown', raw: null }
  const url = `https://client.myemailverifier.com/verifier/validate_single/${encodeURIComponent(email)}/${encodeURIComponent(key)}`
  const maxAttempts = 2
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      const text = await res.text()
      if (!res.ok) {
        // Non-2xx is almost always transient (rate-limit / 5xx) or an auth problem.
        // Retry once, then report 'unknown' (inconclusive) — never let it masquerade as
        // a definitive verdict that could flip a domain to catch-all.
        console.warn(`[mev] HTTP ${res.status} for ${maskEmail(email)} (attempt ${attempt}/${maxAttempts})`)
        if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, attempt * 800)); continue }
        return { status: 'unknown', raw: text }
      }
      let raw: any = text
      try { raw = JSON.parse(text) } catch {}
      const statusStr: string = (raw?.Status || raw?.status || '').toString().toLowerCase()
      // Keep these buckets distinct. In particular 'unknown' (transient/inconclusive) must
      // NOT collapse into 'risky', because 'risky' is treated as catch-all evidence downstream.
      let status: 'valid' | 'invalid' | 'risky' | 'unknown' = 'unknown'
      if (statusStr.includes('valid') && !statusStr.includes('invalid')) status = 'valid'
      else if (statusStr.includes('invalid')) status = 'invalid'
      else if (statusStr.includes('catch') || statusStr.includes('risky')) status = 'risky'
      else status = 'unknown'   // 'unknown', empty, or any unrecognized verdict
      return { status, raw }
    } catch (e) {
      lastErr = e
      console.warn(`[mev] network error for ${maskEmail(email)} (attempt ${attempt}/${maxAttempts}): ${String((e as any)?.message || e)}`)
      if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, attempt * 800)); continue }
      throw lastErr
    }
  }
  return { status: 'unknown', raw: null }  // unreachable, satisfies the type checker
}

// ── Catch-all confirmation probe ────────────────────────────────────────────────
// A single "all candidates risky" result is ambiguous: MEV reports 'risky' both for
// genuine catch-all (accept-all) servers AND for transient conditions (greylisting,
// rate-limiting, temporary SMTP failures). Before branding a whole domain catch-all —
// a sticky, expensive classification that routes every future lookup straight to the
// paid provider — probe it with a nonsense local-part that cannot belong to a real
// mailbox. If the server still accepts it (valid/risky) the domain is truly catch-all;
// if it bounces ('invalid') the earlier risky results were transient.
async function confirmCatchAll(domain: string | null, mevKey: string): Promise<boolean> {
  if (!domain || !mevKey) return false
  const nonce = `no-reply-${Math.random().toString(36).slice(2, 12)}-zzq`
  try {
    const v = await myEmailVerifierValidate(`${nonce}@${domain}`, mevKey)
    return v.status === 'valid' || v.status === 'risky'
  } catch {
    return false
  }
}

// ── OSINT Search helpers ──────────────────────────────────────────────────────
type SearchEvidence = {
  provider: 'google' | 'brave'
  queries: string[]
  exactEmails: string[]
  phones: string[]
  partialEmails: string[]
  snippets: string[]
  urls: string[]
  domains: string[]
}

type PdlPersonEnrichmentResult = {
  provider: 'pdl_person_enrichment'
  workEmails: string[]
  personalEmails: string[]
  mobilePhones: string[]
  socials: string[]
  title: string | null
  company: string | null
  companyDomain: string | null
  confidence?: number
  raw?: unknown
}

// Timeout wrapper — rejects after `ms` milliseconds
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

function buildSearchQueries(fullName: string, company: string | null, domain: string | null): string[] {
  const queries = new Set<string>()
  queries.add(`"${fullName}" ("email" OR "contact" OR "reach me at")`)
  queries.add(`"${fullName}" (site:linktr.ee OR site:github.com OR site:twitter.com OR site:x.com)`)
  if (domain) {
    queries.add(`"${fullName}" "@${domain}"`)
    // Pattern-discovery query: surfaces LeadIQ/Hunter pages listing company email formats.
    // Results like "FLast@domain.com" get picked up by extractContactInfo as example emails,
    // then haiku_refine_candidates uses them to construct the correct candidate for this person.
    queries.add(`"${domain}" ("email format" OR "email address format")`)
  } else if (company) {
    queries.add(`"${fullName}" "${company}" ("email" OR "phone")`)
    queries.add(`"${company}" ("email format" OR "email address format")`)
  } else {
    queries.add(`"${fullName}" ("resume" OR "cv" OR "portfolio")`)
  }
  return Array.from(queries).filter(Boolean).slice(0, 4)
}

// Email-format patterns that aggregator pages (Hunter, RocketReach, LeadIQ, SignalHire)
// publish in words, e.g. "Acme uses the first.last format" or "jdoe@acme.com". These are
// NOT full emails for the target person, so extractContactInfo misses them — but they tell
// the model exactly how to build the right local-part. Captured into SearchEvidence.partialEmails,
// which haiku_refine_candidates and the ensemble already consume.
const FORMAT_PATTERN_TOKENS = [
  'first.last', 'first_last', 'first-last', 'firstlast',
  'flast', 'f.last', 'f_last', 'firstl', 'first.l',
  'last.first', 'last_first', 'lastfirst', 'lastf', 'last.f',
]
function extractEmailPatterns(text: string): string[] {
  const lower = text.toLowerCase()
  // Only mine snippets that are actually talking about email format, to avoid noise.
  if (!/format|pattern|email|@/.test(lower)) return []
  const found = new Set<string>()
  for (const tok of FORMAT_PATTERN_TOKENS) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
    // Token must be a standalone word or directly precede "@" (e.g. "flast@acme.com").
    if (new RegExp(`(^|[^a-z0-9])${esc}(@|[^a-z0-9]|$)`).test(lower)) found.add(tok)
  }
  return Array.from(found)
}

function extractContactInfo(text: string): { emails: string[]; phones: string[] } {
  const emailMatches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
  const rawPhones = extractPhones(text)
  const normalizedPhones = rawPhones.map(normalizePhone).filter((p): p is string => p !== null)
  return {
    emails: Array.from(new Set(emailMatches.map((v) => v.toLowerCase()))),
    phones: Array.from(new Set(normalizedPhones)),
  }
}

function mergeCandidateSets(...groups: Array<string[] | null | undefined>): string[] {
  return Array.from(new Set(groups.flatMap((g) => g || []).map((v) => v.toLowerCase())))
}

async function runGoogleSearchEvidence(
  fullName: string, company: string | null, domain: string | null,
  googleKey: string, googleCx: string,
): Promise<SearchEvidence> {
  const queries = buildSearchQueries(fullName, company, domain)
  const exactEmails = new Set<string>()
  const phones = new Set<string>()
  const partials = new Set<string>()
  const snippets: string[] = []
  const urls: string[] = []
  console.log(`[google_search] running ${queries.length} queries for "${fullName}"`)
  for (const q of queries) {
    try {
      const url = new URL('https://www.googleapis.com/customsearch/v1')
      url.searchParams.set('key', googleKey)
      url.searchParams.set('cx', googleCx)
      url.searchParams.set('q', q)
      url.searchParams.set('num', '5')
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) })
      const data = await res.json()
      if (!res.ok) {
        console.warn(`[google_search] query error ${res.status}:`, JSON.stringify(data))
        continue
      }
      const items = data.items || []
      const qEmails: string[] = []
      const qPhones: string[] = []
      for (const item of items) {
        const blob = `${item.title || ''} ${item.snippet || ''}`
        const ex = extractContactInfo(blob)
        ex.emails.forEach((e) => { exactEmails.add(e); qEmails.push(e) })
        ex.phones.forEach((p) => { phones.add(p); qPhones.push(p) })
        extractEmailPatterns(blob).forEach((p) => partials.add(p))
        snippets.push(blob)
        if (item.link) urls.push(item.link)
      }
      console.log(`[google_search] query results=${items.length} emails=${qEmails.length} phones=${qPhones.length} urls=${items.map((i: any) => i.link).filter(Boolean).join(', ')}`)
    } catch (e) { console.warn('[google_search] query threw:', e) }
  }
  const result: SearchEvidence = {
    provider: 'google',
    queries,
    exactEmails: Array.from(exactEmails),
    phones: Array.from(phones),
    partialEmails: Array.from(partials),
    snippets,
    urls,
    domains: domain ? [domain] : [],
  }
  console.log(`[google_search] total emails=${result.exactEmails.length} phones=${result.phones.length} snippets=${result.snippets.length}`)
  return result
}

async function runBraveSearch(
  fullName: string, company: string | null, domain: string | null,
  braveKey: string,
): Promise<SearchEvidence> {
  const queries = buildSearchQueries(fullName, company, domain)
  const exactEmails = new Set<string>()
  const phones = new Set<string>()
  const partials = new Set<string>()
  const snippets: string[] = []
  const urls: string[] = []
  for (const q of queries) {
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5&extra_snippets=true`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey },
        signal: AbortSignal.timeout(8000)
      })
      const data = await res.json()
      if (!res.ok) { console.warn(`[brave_search] query error ${res.status}:`, JSON.stringify(data)); continue }
      for (const item of data.web?.results || []) {
        const extras = Array.isArray(item.extra_snippets) ? item.extra_snippets.join(' ') : ''
        const blob = `${item.title || ''} ${item.description || ''} ${extras}`
        const ex = extractContactInfo(blob)
        ex.emails.forEach((e) => exactEmails.add(e))
        ex.phones.forEach((p) => phones.add(p))
        extractEmailPatterns(blob).forEach((p) => partials.add(p))
        snippets.push(blob.trim())
        if (item.url) urls.push(item.url)
      }
    } catch (e) { console.warn('[brave_search] query threw:', e) }
  }
  return { provider: 'brave', queries, exactEmails: Array.from(exactEmails), phones: Array.from(phones), partialEmails: Array.from(partials), snippets, urls, domains: domain ? [domain] : [] }
}

async function runPdlPersonEnrichment(
  fullName: string,
  company: string | null,
  companyDomain: string | null,
  linkedinUrl: string | null,
  location: string | null,
  pdlKey: string,
): Promise<PdlPersonEnrichmentResult> {
  const payload: Record<string, unknown> = {}
  // Priority order per spec: LinkedIn URL > full name + company > name + domain > name + location
  if (linkedinUrl)    payload.profile        = linkedinUrl
  if (fullName)       payload.name           = fullName
  if (company)        payload.company        = company
  if (companyDomain)  payload.company_domain = companyDomain
  if (location)       payload.location       = location

  const usedIdentifiers = [
    linkedinUrl   && 'linkedin_url',
    company       && 'company',
    companyDomain && 'company_domain',
    location      && 'location',
  ].filter(Boolean)
  console.log(`[pdl_person_enrichment] calling with identifiers: name + ${usedIdentifiers.join(', ') || 'name_only'}`)

  const res = await fetch('https://api.peopledatalabs.com/v5/person/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': pdlKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`PDL Person Enrichment error ${res.status}: ${JSON.stringify(data)}`)

  const emails   = Array.isArray(data?.data?.emails)        ? data.data.emails        : []
  const phns     = Array.isArray(data?.data?.phone_numbers) ? data.data.phone_numbers : []
  const profiles = Array.isArray(data?.data?.profiles)      ? data.data.profiles      : []

  const workEmails     = emails.filter((e: any) => e?.type === 'work'     && e?.address).map((e: any) => String(e.address).toLowerCase())
  const personalEmails = emails.filter((e: any) => e?.type === 'personal' && e?.address).map((e: any) => String(e.address).toLowerCase())
  const mobilePhones   = phns.filter((p: any) => (p?.type === 'mobile' || p?.line_type === 'mobile') && p?.number).map((p: any) => String(p.number))
  const socials        = profiles.map((p: any) => p?.url || p?.profile_url).filter(Boolean)

  const result: PdlPersonEnrichmentResult = {
    provider:      'pdl_person_enrichment',
    workEmails:    Array.from(new Set(workEmails)),
    personalEmails:Array.from(new Set(personalEmails)),
    mobilePhones:  Array.from(new Set(mobilePhones)),
    socials:       Array.from(new Set(socials)),
    title:         data?.data?.job_title         || null,
    company:       data?.data?.job_company_name  || company || null,
    companyDomain: data?.data?.job_company_website || companyDomain || null,
    confidence:    typeof data?.data?.likelihood === 'number' ? data.data.likelihood : undefined,
    raw:           data,
  }
  console.log(`[pdl_person_enrichment] returned work_emails=${result.workEmails.length} personal_emails=${result.personalEmails.length} phones=${result.mobilePhones.length} socials=${result.socials.length} confidence=${result.confidence ?? 'n/a'}`)
  return result
}

// ── Ensemble interfaces (v40) ─────────────────────────────────────────────────
interface EnsembleCandidate {
  value: string
  source: 'anthropic' | 'openai' | 'deepseek' | 'gemini'
  confidence: number
  reason?: string
}

interface EnsembleResult {
  candidates: EnsembleCandidate[]
  usedModels: string[]
}

// ── runEmailEnsemble: OpenAI + DeepSeek + Haiku ensemble (v40) ───────────────
async function runEmailEnsemble(
  fullName: string,
  companyName: string | null,
  domain: string | null,
  evidenceJson: string,
  anthropicKey: string,
  openaiKey: string,
  deepseekKey: string,
  geminiKey: string,
): Promise<EnsembleResult> {
  const usedModels: string[] = []
  const out: EnsembleCandidate[] = []

  if (!fullName) return { candidates: [], usedModels }

  const basePrompt = `You are generating likely WORK email addresses for a single person. Use both the evidence below AND your general knowledge of how companies format employee email addresses.

Person: ${fullName}
Company: ${companyName || 'unknown'}
Known work domain: ${domain || 'unknown'}

Evidence (search snippets, patterns, domains, previous candidates):
${evidenceJson}

DOMAIN: If the domain above is unknown, infer it from the company name (strip Inc/LLC/Corp/Ltd/Group/Holdings/Partners; try .com first, then .io/.ai/.co for tech, .org for nonprofits).

NAME-HANDLING:
- Strip diacritics (José → jose, Müller → muller).
- Hyphenated last names: try both hyphen-kept and hyphen-collapsed.
- Particles (van, von, de, di, la): try both collapsed and stripped.
- Drop suffixes (Jr, Sr, II, III, PhD, MD).

PATTERN PRIORS (use to order candidates):
- Enterprise (1000+): first.last ~52%, flast ~28%, first ~5%
- Large (201-1000): flast ~43%, first.last ~38%, first ~6%
- Mid (51-200): flast ~42%, first.last ~30%, first ~17%
- Small (11-50): first ~42%, flast ~27%, first.last ~23%
- Micro (1-10): first ~70%, flast ~13%, first.last ~10%
- Default if size unknown: flast ~40%, first.last ~30%, first ~15%

ALLOWED LOCAL-PART PATTERNS: first.last, flast, first, firstlast, f.last, firstl, first-last, first_last, last.first, lastf

Return ONLY JSON in this exact shape:
{
  "candidates": [
    {"value": "email@example.com", "confidence": 0.0, "reason": "short explanation"}
  ]
}

Rules:
- Provide 4–5 candidates, most-likely first.
- Prefer the company domain. Do not use personal domains (gmail, yahoo, hotmail, outlook.com) unless the evidence explicitly shows that address used for professional outreach.
- confidence: 0.0–1.0. Use 0.7+ when domain is known and pattern matches evidence; 0.4–0.6 for inferred domain; <0.4 when guessing.
- All candidates at the same domain.
- Local-parts lowercase ASCII only.`

  const tasks: Promise<void>[] = []

  if (anthropicKey) {
    usedModels.push('anthropic_haiku')
    tasks.push((async () => {
      try {
        const raw = await callAnthropic(
          anthropicKey,
          'claude-haiku-4-5',
          550,
          basePrompt,
        )
        const p = parseJson(raw)
        const cs: any[] = Array.isArray(p.candidates) ? p.candidates : []
        for (const c of cs) {
          if (!c?.value) continue
          out.push({
            value: String(c.value),
            source: 'anthropic',
            confidence: typeof c.confidence === 'number' ? c.confidence : 0.4,
            reason: typeof c.reason === 'string' ? c.reason : undefined,
          })
        }
      } catch (e) {
        console.error('ensemble anthropic error', e)
      }
    })())
  }

  if (openaiKey) {
    usedModels.push('openai_gpt5_4_mini')
    tasks.push((async () => {
      try {
        const p = await callOpenAIJson(
          openaiKey,
          'gpt-5.4-mini',
          basePrompt,
          550,
        )
        const cs: any[] = Array.isArray(p?.candidates) ? p.candidates : []
        for (const c of cs) {
          if (!c?.value) continue
          out.push({
            value: String(c.value),
            source: 'openai',
            confidence: typeof c.confidence === 'number' ? c.confidence : 0.4,
            reason: typeof c.reason === 'string' ? c.reason : undefined,
          })
        }
      } catch (e) {
        console.error('ensemble openai error', e)
      }
    })())
  }

  if (deepseekKey) {
    usedModels.push('deepseek_v4_flash')
    tasks.push((async () => {
      try {
        const p = await callDeepSeekJson(
          deepseekKey,
          'deepseek-v4-flash',
          basePrompt,
          550,
        )
        const cs: any[] = Array.isArray(p?.candidates) ? p.candidates : []
        for (const c of cs) {
          if (!c?.value) continue
          out.push({
            value: String(c.value),
            source: 'deepseek',
            confidence: typeof c.confidence === 'number' ? c.confidence : 0.4,
            reason: typeof c.reason === 'string' ? c.reason : undefined,
          })
        }
      } catch (e) {
        console.error('ensemble deepseek error', e)
      }
    })())
  }

  if (geminiKey) {
    usedModels.push('gemini_2_5_flash')
    tasks.push((async () => {
      try {
        const p = await callGeminiJson(
          geminiKey,
          'gemini-2.5-flash',
          basePrompt,
          550,
        )
        const cs: any[] = Array.isArray(p?.candidates) ? p.candidates : []
        for (const c of cs) {
          if (!c?.value) continue
          out.push({
            value: String(c.value),
            source: 'gemini',
            confidence: typeof c.confidence === 'number' ? c.confidence : 0.4,
            reason: typeof c.reason === 'string' ? c.reason : undefined,
          })
        }
      } catch (e) {
        console.error('ensemble gemini error', e)
      }
    })())
  }

  if (!tasks.length) return { candidates: [], usedModels: [] }

  await Promise.all(tasks)

  // Vote aggregation: score = sum of confidences across all models that nominated this address.
  // A consensus pick (two or three models agreeing) outranks a single high-confidence model.
  const byValue = new Map<string, { totalConf: number; votes: number; best: EnsembleCandidate }>()
  for (const c of out) {
    const key = c.value.toLowerCase()
    const existing = byValue.get(key)
    if (!existing) {
      byValue.set(key, { totalConf: c.confidence, votes: 1, best: c })
    } else {
      existing.totalConf += c.confidence
      existing.votes += 1
      if (c.confidence > existing.best.confidence) existing.best = c
    }
  }

  const merged = Array.from(byValue.values())
    .sort((a, b) => b.totalConf - a.totalConf)
    .map(v => ({ ...v.best, confidence: v.totalConf / Math.max(usedModels.length, 1) }))

  return { candidates: merged.slice(0, 10), usedModels }
}

// ── Email Waterfall (search-first) ───────────────────────────────────────────
interface WaterfallResult {
  email: string | null
  personalEmail?: string | null   // personal-domain email found during search (gmail, yahoo, etc.)
  phones?: string[]               // normalized phone numbers collected across all waterfall steps
  emailStatus: 'found' | 'uncertain' | 'not_found'
  source: 'haiku+verifier' | 'haiku_pattern_cache' | 'google_search' | 'brave_search' | 'pdl_person_enrichment' | 'haiku_refine' | 'ensemble+mev' | 'fullenrich_v2' | 'none'
  title: string | null
  domain: string | null
}

// One verified email pattern for a domain (from company_email_patterns table)
interface CachedPattern {
  pattern: string
  count: number
  isCatchall: boolean
  confidence: number   // 0.0 = seeded/unverified; 1.0 = real MEV-confirmed hit
}

// Shared MEV verification loop: tries candidates in order, returns first WORK email found.
// Personal-domain emails (gmail, yahoo, etc.) are stored as personalFallback and skipped —
// the waterfall keeps hunting for a corporate address.
// Also tracks the first 'risky' result as a fallback for catch-all domains.
async function runMevLoop(
  candidates: string[],
  limit: number,
  myEmailVerifierKey: string,
  labelFn: (c: string) => string,
  logTag: string,
  mevCache?: Map<string, 'valid' | 'invalid' | 'risky' | 'unknown'>,
): Promise<{ email: string | null; riskyFallback: string | null; personalFallback: string | null; tried: string[]; statuses: string[]; lastError: string | null }> {
  const tried: string[] = []
  const statuses: string[] = []
  let lastError: string | null = null
  let riskyFallback: string | null = null
  let personalFallback: string | null = null
  for (const c of candidates.slice(0, limit)) {
    tried.push(maskEmail(c))
    try {
      // Reuse a definitive verdict for this exact address if an earlier step already paid
      // for it. Only 'valid'/'invalid' are cached (they're stable); 'risky'/'unknown' may be
      // transient, so those are always re-checked.
      const cached = mevCache?.get(c)
      let v: { status: 'valid' | 'invalid' | 'risky' | 'unknown' }
      if (cached === 'valid' || cached === 'invalid') {
        v = { status: cached }
        console.log(`[${logTag}] ${maskEmail(c)} → ${cached} (cached)`)
      } else {
        v = await myEmailVerifierValidate(c, myEmailVerifierKey)
        if (mevCache && (v.status === 'valid' || v.status === 'invalid')) mevCache.set(c, v.status)
        console.log(`[${logTag}] ${maskEmail(c)} → ${v.status}`)
      }
      statuses.push(v.status)
      if (v.status === 'valid') {
        // Personal domain (gmail, yahoo, etc.) — keep as fallback, keep searching for work email
        if (isPersonalEmailDomain(c)) {
          if (!personalFallback) personalFallback = c
          console.log(`[${logTag}] ${maskEmail(c)} is personal domain — storing as fallback, continuing work search`)
          continue
        }
        return { email: c, riskyFallback: null, personalFallback, tried, statuses, lastError: null }
      }
      if (v.status === 'risky' && !riskyFallback) riskyFallback = c
      if (v.status === 'invalid') continue  // definitively wrong, skip
    } catch (e: any) {
      lastError = String(e?.message || e)
      statuses.push('error')
      console.warn(`[${logTag}] error on ${maskEmail(c)}: ${lastError}`)
    }
  }
  return { email: null, riskyFallback, personalFallback, tried, statuses, lastError }
}

async function runEmailWaterfall(opts: {
  fullName: string
  companyName: string | null
  knownDomain: string | null
  companySize?: number | null
  linkedinUrl?: string | null
  anthropicKey: string
  googleKey: string
  googleCx: string
  myEmailVerifierKey: string
  braveKey: string
  pdlKey: string
  openaiKey?: string
  deepseekKey?: string
  geminiKey?: string
  db?: any
  step: ReturnType<typeof makeStepLogger>['step']
}): Promise<WaterfallResult> {
  const { fullName, companyName, knownDomain, companySize = null, linkedinUrl = null,
    anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey, openaiKey = '', deepseekKey = '', geminiKey = '', db = null, step } = opts

  const summary: Record<string, any> = {
    event: 'waterfall_summary',
    name: fullName, company: companyName, known_domain: knownDomain,
    resolved_domain: null, mx_ok: false, final_source: 'none', final_email: null,
  }
  // Accumulated personal-domain email found anywhere in the waterfall.
  // MEV loops skip personal-domain emails as work candidates and store them here instead,
  // so the waterfall keeps searching for a corporate address.
  let personalEmailFallback: string | null = null
  const foundPhones = new Set<string>()
  // Per-request memo of definitive MEV verdicts (valid/invalid) so the same address is
  // never billed to MyEmailVerifier twice across the waterfall's multiple verification rounds.
  const mevCache = new Map<string, 'valid' | 'invalid' | 'risky' | 'unknown'>()
  const finish = (result: WaterfallResult): WaterfallResult => {
    summary.final_source = result.source
    summary.final_email = maskEmail(result.email)
    if (personalEmailFallback) summary.personal_email_fallback = maskEmail(personalEmailFallback)
    if (foundPhones.size > 0) summary.phones_found = foundPhones.size
    console.log(JSON.stringify(summary))
    return { ...result, personalEmail: result.personalEmail ?? personalEmailFallback, phones: Array.from(foundPhones) }
  }

  // ── STEP 1: Resolve domain ────────────────────────────────────────────────
  let workingDomain: string | null = null
  await step<{ domain: string | null }>('resolve_domain', async () => {
    // Fast-path: check company_domain_hints for a previously-confirmed mapping.
    // This fires on repeat lookups for the same company even when the scraped
    // display name differs from the email domain (e.g. "Verilyhealth" → "verily.com").
    if (db && companyName) {
      try {
        const key = normalizeCompanyKey(companyName)
        const { data: hint } = await db
          .from('company_domain_hints')
          .select('domain, hit_count')
          .eq('company_key', key)
          .order('hit_count', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (hint?.domain) {
          workingDomain = hint.domain
          summary.resolved_domain = hint.domain
          summary.mx_ok = true
          return { status: 'OK', meta: { domain: hint.domain, via: 'company_domain_hints', hit_count: hint.hit_count } }
        }
      } catch {}
    }

    const candidates = Array.from(new Set([
      sanitizeDomain(knownDomain),
      ...inferDomainCandidates(companyName),
    ].filter((v): v is string => !!v)))
    if (candidates.length === 0) {
      if (googleKey && googleCx && companyName) {
        const discovered = await googleCseFindCompanyDomain(companyName, googleKey, googleCx)
        if (discovered) {
          workingDomain = discovered
          summary.resolved_domain = discovered
          summary.mx_ok = await hasMxRecord(discovered)
          return { status: 'OK', meta: { domain: discovered, discovered_via: 'google_cse_company_domain' } }
        }
      }
      return { status: 'MISS', reason: 'no_candidates' }
    }
    const picked = await pickMxValidatedDomain(candidates)
    if (!picked) {
      workingDomain = candidates[0]
      summary.resolved_domain = workingDomain
      return { status: 'MISS', reason: 'no_mx', meta: { tried: candidates, fallback: workingDomain } }
    }
    workingDomain = picked
    summary.resolved_domain = picked
    summary.mx_ok = true
    return { status: 'OK', meta: { domain: picked, tried: candidates.length } }
  })

  // ── STEP 2: Pattern cache — all known patterns for this domain, most-verified first
  let cachedPatterns: CachedPattern[] = []
  await step('haiku_pattern_cache', async () => {
    if (!db || !workingDomain) return { status: 'SKIP', reason: !db ? 'no_db' : 'no_domain' }
    try {
      const { data } = await db
        .from('company_email_patterns')
        .select('verified_pattern, verified_count, is_catchall, confidence')
        .eq('domain', workingDomain)
        .order('verified_count', { ascending: false })
      if (data && data.length > 0) {
        cachedPatterns = data.map((r: any) => ({
          pattern:    r.verified_pattern,
          count:      r.verified_count,
          isCatchall: !!r.is_catchall,
          confidence: typeof r.confidence === 'number' ? r.confidence : 0,
        }))
        const top = cachedPatterns[0]
        const maxConf = Math.max(...cachedPatterns.map(p => p.confidence))
        return {
          status: 'HIT',
          meta: {
            patterns:    cachedPatterns.length,
            top_pattern: top.pattern,
            top_count:   top.count,
            max_confidence: maxConf,
            seeded_only: maxConf === 0,
            is_catchall: cachedPatterns.some(p => p.isCatchall),
            all: cachedPatterns.map(p => `${p.pattern}×${p.count}@${p.confidence.toFixed(1)}`).join(', '),
          },
        }
      }
      return { status: 'MISS' }
    } catch (e: any) {
      return { status: 'FAIL', reason: String(e?.message || e) }
    }
  })

  // ── Pattern cache HIT: multi-pattern-aware resolution ────────────────────────
  if (cachedPatterns.length > 0 && workingDomain) {
    const domainIsCatchall = cachedPatterns.some(p => p.isCatchall)
    // Seeded rows have confidence=0.0; real MEV-confirmed hits promote to confidence=1.0.
    // We treat patterns as "seeded-only" when no pattern has been real-verified yet.
    const maxPatternConfidence = Math.max(...cachedPatterns.map(p => p.confidence))
    const allPatternsSeeded = maxPatternConfidence === 0

    if (domainIsCatchall && !allPatternsSeeded) {
      // Catch-all domain confirmed by real verification: MEV can't distinguish valid from invalid.
      // With a single known pattern → apply mechanically (zero AI cost).
      // With multiple patterns → ask Haiku to weigh frequency + name signals.
      let pickedEmail: string | null = null
      if (cachedPatterns.length === 1) {
        pickedEmail = applyPattern(cachedPatterns[0].pattern, fullName, workingDomain)
        await step('myemailverifier_haiku', async () => ({
          status: 'SKIP',
          reason: 'catchall_single_pattern',
          meta: { email: maskEmail(pickedEmail), via: 'pattern_cache_catchall_mechanical' },
        }))
      } else {
        // Multiple patterns: Haiku picks based on frequency + name characteristics
        pickedEmail = await haikuPickPattern(fullName, workingDomain, cachedPatterns, anthropicKey)
        await step('myemailverifier_haiku', async () => ({
          status: 'SKIP',
          reason: 'catchall_multi_pattern_haiku',
          meta: {
            email: maskEmail(pickedEmail),
            via: 'haiku_pattern_pick',
            patterns_considered: cachedPatterns.length,
            all: cachedPatterns.map(p => `${p.pattern}×${p.count}`).join(', '),
          },
        }))
      }
      if (pickedEmail) {
        console.log(`[waterfall] catch-all (real-verified) + ${cachedPatterns.length} pattern(s) → ${maskEmail(pickedEmail)}`)
        return finish({ email: pickedEmail, emailStatus: 'uncertain', source: 'haiku_pattern_cache', title: null, domain: workingDomain })
      }

    } else {
      // Non-catch-all OR seeded-only patterns: always run MEV to verify the candidate.
      //
      // Key rule for seeded patterns (confidence=0.0):
      //   - 'valid' MEV hit → promote confidence to 1.0 in DB, return as confirmed find ✅
      //   - 'invalid' → pattern wrong, fall through to full waterfall ✅
      //   - all 'risky' → do NOT mark as catch-all (risky just means "couldn't confirm this
      //     specific guess"). Fall through to full waterfall so Google/Brave/PDL can find the
      //     real email, which will then write back the correct pattern at confidence=1.0 ✅
      //
      // For real-verified non-catch-all patterns (confidence>0):
      //   - all 'risky' → domain must actually be catch-all; mark it and return uncertain ✅
      const patternEmails = cachedPatterns
        .map(p => applyPattern(p.pattern, fullName, workingDomain!))
        .filter((e): e is string => !!e)
      let cachedVerified: string | null = null
      let cachedRisky:    string | null = null
      await step('myemailverifier_haiku', async () => {
        if (!myEmailVerifierKey) return { status: 'SKIP', reason: 'no_mev_key' }
        if (patternEmails.length === 0) return { status: 'SKIP', reason: 'no_pattern_emails' }
        try {
          const r = await runMevLoop(patternEmails, patternEmails.length, myEmailVerifierKey, maskEmail, 'myemailverifier_haiku', mevCache)
          if (r.email) {
            cachedVerified = r.email
            return { status: 'OK', meta: { tried: r.tried, statuses: r.statuses, accepted: maskEmail(r.email), via: allPatternsSeeded ? 'seeded_pattern_mev_confirmed' : 'pattern_cache_multi' } }
          }
          if (r.riskyFallback && r.statuses.length > 0 && r.statuses.every(s => s === 'risky' || s === 'error')) {
            if (!allPatternsSeeded) {
              // Real-verified patterns all returned risky → likely catch-all. Corroborate with
              // the same nonsense-local probe Step 4 uses before flipping a previously-good
              // domain to catch-all, so a transient SMTP blip can't poison the pattern cache.
              const reallyCatchAll = await confirmCatchAll(workingDomain, myEmailVerifierKey)
              if (!reallyCatchAll) {
                return { status: 'MISS', meta: { tried: r.tried, statuses: r.statuses, note: 'all_risky_probe_negative_transient', probe: 'negative' } }
              }
              cachedRisky = r.riskyFallback
              return { status: 'RISKY_FALLBACK', meta: { tried: r.tried, statuses: r.statuses, risky_fallback: maskEmail(r.riskyFallback), via: 'pattern_cache_multi', probe: 'positive' } }
            }
            // Seeded patterns all returned risky → could be wrong pattern, not necessarily catch-all.
            // Fall through to full waterfall (Google / Brave / PDL) to find the real email.
            return { status: 'MISS', meta: { tried: r.tried, statuses: r.statuses, note: 'seeded_all_risky_fall_through' } }
          }
          return { status: 'MISS', meta: { tried: r.tried, statuses: r.statuses, accepted: null } }
        } catch (e: any) {
          return { status: 'FAIL', reason: String(e?.message || e) }
        }
      })
      if (cachedVerified) {
        await upsertEmailPattern(db, workingDomain, cachedVerified, fullName, false)
        await upsertCompanyDomainHint(db, companyName, workingDomain)
        return finish({ email: cachedVerified, emailStatus: 'found', source: 'haiku_pattern_cache', title: null, domain: workingDomain })
      }
      if (cachedRisky) {
        console.log(`[waterfall] pattern_cache all-risky (real-verified) — marking catch-all: ${maskEmail(cachedRisky)}`)
        await upsertEmailPattern(db, workingDomain, cachedRisky, fullName, true)
        await upsertCompanyDomainHint(db, companyName, workingDomain)
        return finish({ email: cachedRisky, emailStatus: 'uncertain', source: 'haiku_pattern_cache', title: null, domain: workingDomain })
      }
      // All pattern candidates failed MEV (invalid or seeded-risky) — fall through to full waterfall
    }
  }

  // ── STEP 3: Haiku email guess ────────────────────────────────────────────
  let haikuCandidates: string[] = []
  await step<{ candidates: string[]; domain: string | null }>('haiku_email_guess', async () => {
    if (!anthropicKey || !fullName) return { status: 'SKIP', reason: 'no_input' }
    const r = await haikuEmailGuess(fullName, companyName, workingDomain, anthropicKey, companySize)
    if (r.domain && r.domain !== workingDomain && (await hasMxRecord(r.domain))) {
      workingDomain = r.domain
      summary.resolved_domain = r.domain
    }
    haikuCandidates = r.candidates.filter(c => !workingDomain || c.endsWith('@' + workingDomain))
    if (haikuCandidates.length === 0) return { status: 'MISS', reason: 'no_candidates' }
    return { status: 'OK', meta: { n: haikuCandidates.length } }
  })

  // ── STEP 4: MEV on Haiku candidates (early exit) ─────────────────────────
  let verifiedHaiku: string | null = null
  let haikuRiskyFallback: string | null = null
  let isCatchallDomain = false  // v40.5: Track catch-all detection
  await step<{ tried: string[]; statuses: string[]; accepted: string | null; risky_fallback: string | null }>('myemailverifier_haiku', async () => {
    if (!myEmailVerifierKey) return { status: 'SKIP', reason: 'no_mev_key' }
    if (haikuCandidates.length === 0) return { status: 'SKIP', reason: 'no_candidates' }
    const r = await runMevLoop(haikuCandidates, 5, myEmailVerifierKey, maskEmail, 'myemailverifier_haiku', mevCache)
    if (r.personalFallback && !personalEmailFallback) personalEmailFallback = r.personalFallback
    if (r.email) {
      verifiedHaiku = r.email
      return { status: 'OK', meta: { tried: r.tried, statuses: r.statuses, accepted: maskEmail(r.email), risky_fallback: null, personal_stored: r.personalFallback ? maskEmail(r.personalFallback) : undefined } }
    }
    // v40.5: Catch-all domain detection at Step 4 — route directly to FullEnrich
    // All results were 'risky' (never 'invalid') → domain is catch-all (SMTP-level issue, not data).
    // Write is_catchall=true immediately and skip steps 5-12 (Google, Brave, ensemble, PDL).
    // Jump to FullEnrich (authoritative source) to avoid wasting ~80% of API calls.
    if (r.riskyFallback && r.statuses.length > 0 && r.statuses.every(s => s === 'risky' || s === 'error')) {
      // Corroborate before branding the domain catch-all (see confirmCatchAll). A
      // nonsense-local probe must also be accepted; if it bounces, the risky results
      // were transient and we should keep working the normal waterfall.
      const reallyCatchAll = await confirmCatchAll(workingDomain, myEmailVerifierKey)
      if (!reallyCatchAll) {
        console.log(`[myemailverifier_haiku] all-risky but catch-all probe was negative — treating as transient, continuing waterfall`)
        return { status: 'MISS', reason: 'risky_unconfirmed_catchall', meta: { tried: r.tried, statuses: r.statuses, accepted: null, probe: 'negative' } }
      }
      haikuRiskyFallback = r.riskyFallback
      isCatchallDomain = true
      console.log(`[myemailverifier_haiku] catch-all confirmed by probe at Step 4 — will route to FullEnrich: ${maskEmail(r.riskyFallback)}`)
      // Write is_catchall=true to DB immediately (not at tail end)
      if (db && workingDomain) {
        await upsertEmailPattern(db, workingDomain, r.riskyFallback, fullName, true)
        console.log(`[myemailverifier_haiku] marked domain as catch-all in DB: ${workingDomain}`)
      }
      return { status: 'CATCHALL', reason: 'routing_to_fullenrich', meta: { tried: r.tried, statuses: r.statuses, accepted: null, risky_fallback: maskEmail(r.riskyFallback), probe: 'positive' } }
    }
    if (r.lastError && r.tried.length === 1) return { status: 'FAIL', reason: r.lastError }
    return { status: 'MISS', reason: 'no_valid', meta: { tried: r.tried, statuses: r.statuses, accepted: null, risky_fallback: null } }
  })
  if (verifiedHaiku) {
    if (db && workingDomain) await upsertEmailPattern(db, workingDomain, verifiedHaiku, fullName)
    await upsertCompanyDomainHint(db, companyName, workingDomain)
    return finish({ email: verifiedHaiku, emailStatus: 'found', source: 'haiku+verifier', title: null, domain: workingDomain })
  }

  // v40.5: If catch-all detected at Step 4, skip steps 5-12 and jump to FullEnrich
  let skipToFullEnrich = false
  if (isCatchallDomain) {
    console.log(`[waterfall] catch-all detected at Step 4 — will skip steps 5-12 and route to FullEnrich`)
    skipToFullEnrich = true
  }

  // ── STEPS 5+6: Google + Brave run IN PARALLEL ────────────────────────────
  let googleCandidates: string[] = []
  let googleEvidence: SearchEvidence | null = null
  let braveCandidates: string[] = []
  let braveEvidence: SearchEvidence | null = null

  if (!skipToFullEnrich) {
    await Promise.all([
      // Google
      step<{ queriesRun: number; emailsFound: number; phonesFound: number; topUrls: string[] }>('google_search', async () => {
        if (!googleKey || !googleCx) return { status: 'SKIP', reason: 'no_google_keys' }
      if (!fullName) return { status: 'SKIP', reason: 'no_full_name' }
      try {
        const ev = await withTimeout(
          runGoogleSearchEvidence(fullName, companyName, workingDomain, googleKey, googleCx),
          20000, 'google_search_total'
        )
        googleEvidence = ev
        googleCandidates = mergeCandidateSets(ev.exactEmails)
        if (googleCandidates.length === 0 && ev.phones.length === 0)
          return { status: 'MISS', reason: 'no_contacts_found', meta: { queriesRun: ev.queries.length, emailsFound: 0, phonesFound: 0, topUrls: [] } }
        return { status: 'OK', meta: { queriesRun: ev.queries.length, emailsFound: googleCandidates.length, phonesFound: ev.phones.length, topUrls: ev.urls.slice(0, 3) } }
      } catch (e: any) {
        return { status: 'FAIL', reason: String(e?.message || e) }
      }
    }),
    // Brave — runs at the same time as Google
    step<{ queriesRun: number; emailsFound: number; phonesFound: number; topUrls: string[] }>('brave_search', async () => {
      if (!braveKey) return { status: 'SKIP', reason: 'no_brave_key' }
      if (!fullName) return { status: 'SKIP', reason: 'no_full_name' }
      try {
        const ev = await withTimeout(
          runBraveSearch(fullName, companyName, workingDomain, braveKey),
          20000, 'brave_search_total'
        )
        braveEvidence = ev
        braveCandidates = mergeCandidateSets(ev.exactEmails)
        if (braveCandidates.length === 0 && ev.phones.length === 0)
          return { status: 'MISS', reason: 'no_contacts_found', meta: { queriesRun: ev.queries.length, emailsFound: 0, phonesFound: 0, topUrls: [] } }
        return { status: 'OK', meta: { queriesRun: ev.queries.length, emailsFound: braveCandidates.length, phonesFound: ev.phones.length, topUrls: ev.urls.slice(0, 3) } }
      } catch (e: any) {
        return { status: 'FAIL', reason: String(e?.message || e) }
      }
    }),
  ])
  } else {
    // v40.5: Skip Google/Brave for catch-all domains
    await step('google_search', async () => ({ status: 'SKIP', reason: 'catchall_skip_to_fullenrich' }))
    await step('brave_search', async () => ({ status: 'SKIP', reason: 'catchall_skip_to_fullenrich' }))
  }

  // Accumulate phones from search evidence into the shared set for finish()
  googleEvidence?.phones.forEach(p => foundPhones.add(p))
  braveEvidence?.phones.forEach(p => foundPhones.add(p))

  // ── STEP 7: Haiku refine candidates from search evidence ─────────────────
  // Synthesizes partial emails, domain variants, and snippets from Google+Brave
  // into a ranked candidate list before paying for PDL.
  let refinedCandidates: string[] = []
  if (!skipToFullEnrich) {
    await step('haiku_refine_candidates', async () => {
      if (!anthropicKey) return { status: 'SKIP', reason: 'no_anthropic_key' }
    const allPartials = [
      ...(googleEvidence?.partialEmails || []),
      ...(braveEvidence?.partialEmails  || []),
    ]
    const allDomains  = [
      ...(googleEvidence?.domains || []),
      ...(braveEvidence?.domains  || []),
      workingDomain,
    ].filter(Boolean)
    const mergedSoFar = mergeCandidateSets(googleCandidates, braveCandidates)
    if (mergedSoFar.length === 0 && allPartials.length === 0 && !workingDomain) {
      return { status: 'SKIP', reason: 'no_signal' }
    }
    const prompt = `You are refining work email candidates from search evidence. Use the evidence AND your knowledge of common corporate email conventions.

Person: ${fullName}
Company: ${companyName ?? 'unknown'}
Domain: ${workingDomain ?? 'unknown'}

Evidence:
- Emails found in web search: ${mergedSoFar.slice(0, 6).join(', ') || 'none'}
- Partial emails/patterns in snippets: ${allPartials.slice(0, 5).join(', ') || 'none'}
- Domains seen in snippets: ${Array.from(new Set(allDomains)).slice(0, 5).join(', ') || 'none'}

NAME-HANDLING: strip diacritics, drop suffixes (Jr/Sr/II/III/PhD), try both collapsed and kept forms for hyphenated last names and particles (van, de, di).

ALLOWED PATTERNS: first.last, flast, first, firstlast, f.last, firstl, first-last, first_last, last.first, lastf

Task:
1. If domain is unknown, infer it from company name or evidence domains.
2. Produce 4–5 most likely work email candidates, ordered by confidence (most likely first).
3. Use the exact emails from evidence as anchors when present — apply the same pattern to this person's name.

Return ONLY JSON:
{
  "domain": "example.com or null",
  "candidates": ["a@example.com", "b@example.com"],
  "confidence": 0.0,
  "reasoning": "one short sentence"
}`
    try {
      const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 350, prompt)
      const p = parseJson(raw)
      const rawCandidates: string[] = Array.isArray(p.candidates)
        ? p.candidates.filter((x: any) => typeof x === 'string' && x.includes('@'))
        : []
      // If Haiku resolved a new domain, update workingDomain
      if (p.domain && !workingDomain) {
        const refined = sanitizeDomain(p.domain)
        if (refined && await hasMxRecord(refined)) {
          workingDomain = refined
          summary.resolved_domain = refined
        }
      }
      // Filter to workingDomain if known; otherwise keep all
      refinedCandidates = workingDomain
        ? rawCandidates.filter(c => c.endsWith('@' + workingDomain))
        : rawCandidates.map(c => c.toLowerCase())
      refinedCandidates = Array.from(new Set(refinedCandidates))
      return {
        status: refinedCandidates.length > 0 ? 'OK' : 'MISS',
        meta: { n: refinedCandidates.length, domain: p.domain, confidence: p.confidence, reasoning: p.reasoning },
      }
    } catch (e: any) {
      return { status: 'FAIL', reason: String(e?.message || e) }
    }
  })
  } else {
    // v40.5: Skip Haiku refine for catch-all domains
    await step('haiku_refine_candidates', async () => ({ status: 'SKIP', reason: 'catchall_skip_to_fullenrich' }))
  }

  // ── STEP 8: MEV on Haiku-refined candidates (before PDL) ─────────────────
  const googleSet = new Set(googleCandidates)
  const braveSet  = new Set(braveCandidates)
  let verifiedPrePdl: string | null = null
  let verifiedPrePdlSource: WaterfallResult['source'] = 'none'
  if (!skipToFullEnrich) {
    await step<{ totalCandidates: number; tried: string[]; statuses: string[]; accepted: string | null }>('myemailverifier_search_round1', async () => {
    if (!myEmailVerifierKey) return { status: 'SKIP', reason: 'no_mev_key' }
    // Round 1: Haiku-refined + direct Google/Brave hits (no PDL yet)
    const round1 = mergeCandidateSets(refinedCandidates, googleCandidates, braveCandidates)
    if (round1.length === 0) return { status: 'SKIP', reason: 'no_candidates' }
    const r = await runMevLoop(round1, 6, myEmailVerifierKey, maskEmail, 'myemailverifier_search_round1', mevCache)
    if (r.personalFallback && !personalEmailFallback) personalEmailFallback = r.personalFallback
    if (r.email) {
      verifiedPrePdl = r.email
      verifiedPrePdlSource = googleSet.has(r.email) ? 'google_search'
        : braveSet.has(r.email)  ? 'brave_search'
        : 'haiku_refine'
      return { status: 'OK', meta: { totalCandidates: round1.length, tried: r.tried, statuses: r.statuses, accepted: maskEmail(r.email), personal_stored: r.personalFallback ? maskEmail(r.personalFallback) : undefined } }
    }
    if (r.lastError && r.tried.length === 1) return { status: 'FAIL', reason: r.lastError }
    return { status: 'MISS', reason: 'no_valid', meta: { totalCandidates: round1.length, tried: r.tried, statuses: r.statuses, accepted: null } }
  })
  if (verifiedPrePdl) {
    if (db && workingDomain) await upsertEmailPattern(db, workingDomain, verifiedPrePdl, fullName)
    await upsertCompanyDomainHint(db, companyName, workingDomain)
    return finish({ email: verifiedPrePdl, emailStatus: 'found', source: verifiedPrePdlSource, title: null, domain: workingDomain })
  }
  } else {
    // v40.5: Skip MEV search round 1 for catch-all domains
    await step('myemailverifier_search_round1', async () => ({ status: 'SKIP', reason: 'catchall_skip_to_fullenrich' }))
  }

  // ── STEP 9 (v40): Ensemble refine candidates (OpenAI + DeepSeek + Haiku) ────
  // Runs only after early steps (pattern cache, Haiku guess, Haiku refine, search round 1) have failed.
  // Uses multiple LLM providers to generate candidates from search evidence before escalating to PDL/FullEnrich.
  let ensembleCandidates: string[] = []
  if (!skipToFullEnrich) {
    await step<{ n: number; models: string[] }>('ensemble_refine_candidates', async () => {
    // Only run if at least one LLM key is present
    if (!anthropicKey && !openaiKey && !deepseekKey && !geminiKey) {
      return { status: 'SKIP', reason: 'no_llm_keys' }
    }
    if (!fullName) return { status: 'SKIP', reason: 'no_full_name' }

    // Build evidence from search results
    const searchEvidence: any[] = []
    if (googleEvidence) {
      searchEvidence.push({
        source: 'google_search',
        emails: googleCandidates,
        partials: googleEvidence.partialEmails,
        domains: googleEvidence.domains,
        snippets: googleEvidence.snippets?.slice(0, 3),
      })
    }
    if (braveEvidence) {
      searchEvidence.push({
        source: 'brave_search',
        emails: braveCandidates,
        partials: braveEvidence.partialEmails,
        domains: braveEvidence.domains,
        snippets: braveEvidence.snippets?.slice(0, 3),
      })
    }
    if (refinedCandidates.length > 0) {
      searchEvidence.push({
        source: 'haiku_refine',
        candidates: refinedCandidates,
      })
    }
    if (cachedPatterns.length > 0) {
      searchEvidence.push({
        source: 'pattern_cache',
        patterns: cachedPatterns.map(p => p.pattern),
      })
    }

    if (!searchEvidence || searchEvidence.length === 0) {
      return { status: 'SKIP', reason: 'no_evidence' }
    }

    const evidenceJson = JSON.stringify(searchEvidence.slice(0, 20), null, 2)

    const ensemble = await runEmailEnsemble(
      fullName,
      companyName,
      workingDomain,
      evidenceJson,
      anthropicKey,
      openaiKey,
      deepseekKey,
      geminiKey,
    )

    if (!ensemble.candidates.length) {
      return {
        status: 'MISS',
        reason: 'no_candidates',
        meta: { models: ensemble.usedModels },
      }
    }

    ensembleCandidates = ensemble.candidates.map(c => c.value)

    return {
      status: 'OK',
      meta: {
        n: ensembleCandidates.length,
        models: ensemble.usedModels,
      },
    }
  })
  } else {
    // v40.5: Skip ensemble for catch-all domains
    await step('ensemble_refine_candidates', async () => ({ status: 'SKIP', reason: 'catchall_skip_to_fullenrich' }))
  }

  // ── STEP 10 (v40): MEV on ensemble candidates ────────────────────────────────
  // Verifies ensemble candidates. If successful, short-circuits PDL and FullEnrich.
  let verifiedEnsemble: string | null = null
  if (!skipToFullEnrich) {
    await step<{ email: string | null }>('myemailverifier_ensemble', async () => {
    if (!myEmailVerifierKey) return { status: 'SKIP', reason: 'no_mev_key' }
    if (!ensembleCandidates.length) return { status: 'SKIP', reason: 'no_candidates' }

    const { email, tried, lastError } = await runMevLoop(
      ensembleCandidates,
      5, // try up to 5 ensemble candidates
      myEmailVerifierKey,
      maskEmail,
      'myemailverifier_ensemble',
      mevCache,
    )

    if (lastError && !email) {
      return { status: 'FAIL', reason: lastError, meta: { tried } }
    }

    if (!email) {
      return { status: 'MISS', reason: 'no_valid_candidate', meta: { tried } }
    }

    verifiedEnsemble = email

    // Update pattern cache if we know the domain
    if (workingDomain && db) {
      try {
        await upsertEmailPattern(db, workingDomain, email, fullName)
      } catch (e) {
        console.error('upsertEmailPattern (ensemble) failed', e)
      }
    }

    return {
      status: 'OK',
      meta: { email: maskEmail(email), tried },
    }
  })
  if (verifiedEnsemble) {
    await upsertCompanyDomainHint(db, companyName, workingDomain)
    return finish({ email: verifiedEnsemble, emailStatus: 'found', source: 'ensemble+mev', title: null, domain: workingDomain })
  }
  } else {
    // v40.5: Skip MEV ensemble for catch-all domains
    await step('myemailverifier_ensemble', async () => ({ status: 'SKIP', reason: 'catchall_skip_to_fullenrich' }))
  }

  // ── STEP 11: (removed) PDL Person Enrichment ─────────────────────────────────
  // PDL has been removed from the waterfall. Email discovery now relies on the
  // pattern cache, Haiku guess, Google/Brave search, the LLM ensemble (Anthropic +
  // OpenAI + DeepSeek + Gemini), and FullEnrich as the authoritative last resort.
  // The step name is preserved as a no-op so the diagnostics panel and step sequence
  // stay stable; re-enabling is a one-line restore of the runPdlPersonEnrichment call.
  if (!skipToFullEnrich) {
  const pdlCandidates: string[] = []
  const pdlTitle: string | null = null
  await step('pdl_person_enrichment', async () => ({ status: 'SKIP', reason: 'pdl_disabled' }))

  // ── STEP 12: MEV on any remaining candidates ─────────────────────────────────
  // With PDL removed, the search/refine/ensemble candidates are already verified by
  // earlier rounds, so this normally finds nothing new and SKIPs. Retained as the
  // safety-net slot (and stable step name) for candidates beyond round 1's limit.
  let verifiedSearch: string | null = null
  let verifiedSource: WaterfallResult['source'] = 'none'
  let verifiedTitle: string | null = null
  await step<{ totalCandidates: number; tried: string[]; statuses: string[]; accepted: string | null }>('myemailverifier_search_candidates', async () => {
    if (!myEmailVerifierKey) return { status: 'SKIP', reason: 'no_mev_key' }
    const round1Already = new Set(mergeCandidateSets(refinedCandidates, googleCandidates, braveCandidates))
    const newPdlWork = pdlCandidates.filter(c => !round1Already.has(c))
    const allRemaining = mergeCandidateSets(newPdlWork, pdlCandidates)
    if (allRemaining.length === 0) return { status: 'SKIP', reason: 'no_candidates' }
    const r = await runMevLoop(allRemaining, 8, myEmailVerifierKey, maskEmail, 'myemailverifier_search_candidates', mevCache)
    if (r.personalFallback && !personalEmailFallback) personalEmailFallback = r.personalFallback
    if (r.email) {
      verifiedSearch = r.email
      verifiedSource = googleSet.has(r.email) ? 'google_search' : braveSet.has(r.email) ? 'brave_search' : 'haiku_refine'
      verifiedTitle  = null  // PDL removed; no title source in this path
      return { status: 'OK', meta: { totalCandidates: allRemaining.length, tried: r.tried, statuses: r.statuses, accepted: maskEmail(r.email), personal_stored: r.personalFallback ? maskEmail(r.personalFallback) : undefined } }
    }
    if (r.lastError && r.tried.length === 1) return { status: 'FAIL', reason: r.lastError }
    return { status: 'MISS', reason: 'no_valid', meta: { totalCandidates: allRemaining.length, tried: r.tried, statuses: r.statuses, accepted: null } }
  })
  if (verifiedSearch) {
    if (db && workingDomain) await upsertEmailPattern(db, workingDomain, verifiedSearch, fullName)
    await upsertCompanyDomainHint(db, companyName, workingDomain)
    return finish({ email: verifiedSearch, emailStatus: 'found', source: verifiedSource, title: verifiedTitle, domain: workingDomain })
  }
  } else {
    // v40.5: Skip PDL and MEV search candidates for catch-all domains
    await step('pdl_person_enrichment', async () => ({ status: 'SKIP', reason: 'catchall_skip_to_fullenrich' }))
    await step('myemailverifier_search_candidates', async () => ({ status: 'SKIP', reason: 'catchall_skip_to_fullenrich' }))
  }

  // ── Personal email event marker ──────────────────────────────────────────
  // If a personal-domain email was found anywhere during the waterfall but no corporate
  // address was found, log a trail step so the diagnostics panel shows the event.
  if (personalEmailFallback && !verifiedHaiku && !verifiedPrePdl && !verifiedSearch) {
    await step('personal_email_found', async () => ({
      status: 'PERSONAL_HUNTING',
      meta: {
        email: maskEmail(personalEmailFallback),
        note: 'personal email found — still hunting for work address',
      },
    }))
  }

  // ── Risky fallback (catch-all domain safety net) ──────────────────────────
  // If the entire waterfall found only 'risky' results (never 'invalid'), the domain is
  // almost certainly catch-all.  Accept the Haiku risky candidate as 'uncertain' instead
  // of escalating to FullEnrich, which costs ~$0.50 and would return the same email.
  // Also persist is_catchall=true so future lookups skip MEV entirely.
  // v40.6 FIX: Bypass this safety net for catch-all domains detected at Step 4 to allow FullEnrich (authoritative).
  if (haikuRiskyFallback && !isCatchallDomain) {
    console.log(`[waterfall] risky_fallback accepted — skipping FullEnrich, marking catch-all: ${maskEmail(haikuRiskyFallback)}`)
    if (db && workingDomain) await upsertEmailPattern(db, workingDomain, haikuRiskyFallback, fullName, true)
    return finish({ email: haikuRiskyFallback, emailStatus: 'uncertain', source: 'haiku+verifier', title: null, domain: workingDomain })
  }

  return finish({ email: null, emailStatus: 'not_found', source: 'none', title: null, domain: workingDomain })
}

// ── Multi-company waterfall: try cheap waterfall against top N candidates ────
async function runMultiCompanyWaterfall(opts: {
  fullName: string
  companies: CompanyCandidate[]
  knownDomain: string | null
  companySize?: number | null
  linkedinUrl?: string | null
  anthropicKey: string
  googleKey: string
  googleCx: string
  myEmailVerifierKey: string
  braveKey: string
  pdlKey: string
  openaiKey?: string
  deepseekKey?: string
  geminiKey?: string
  db?: any
  step: ReturnType<typeof makeStepLogger>['step']
}): Promise<{ result: WaterfallResult; winner: CompanyCandidate | null }> {
  const { companies, step } = opts
  const list: Array<CompanyCandidate | null> = companies.length > 0 ? companies.slice(0, 3) : [null]
  let last: WaterfallResult = { email: null, emailStatus: 'not_found', source: 'none', title: null, domain: opts.knownDomain, phones: [] }
  let bestPersonal: { result: WaterfallResult; winner: CompanyCandidate | null } | null = null
  for (let i = 0; i < list.length; i++) {
    const cand = list[i]
    await step(`waterfall_candidate_${i + 1}`, async () => ({
      status: 'OK',
      meta: cand ? { company: cand.name, source: cand.source, confidence: cand.confidence } : { company: null },
    }))
    const w = await runEmailWaterfall({
      fullName: opts.fullName,
      companyName: cand ? cand.name : null,
      knownDomain: opts.knownDomain,
      companySize: opts.companySize ?? null,
      linkedinUrl: opts.linkedinUrl ?? null,
      anthropicKey: opts.anthropicKey,
      googleKey: opts.googleKey,
      googleCx: opts.googleCx,
      myEmailVerifierKey: opts.myEmailVerifierKey,
      braveKey: opts.braveKey,
      pdlKey: opts.pdlKey,
      openaiKey: opts.openaiKey,
      deepseekKey: opts.deepseekKey,
      geminiKey: opts.geminiKey,
      db: opts.db ?? null,
      step,
    })
    last = w
    if (w.email) return { result: w, winner: cand }
    // Personal email found but no work email — save it and try next company candidate
    if (w.personalEmail && !bestPersonal) bestPersonal = { result: w, winner: cand }
  }
  // No work email found — return best personal email if any, otherwise last result
  return bestPersonal || { result: last, winner: null }
}


// ── Recruiter profile type ────────────────────────────────────────────────────
interface RecruiterProfile {
  full_name:    string
  company_name: string
  job_title:    string | null
  hiring_focus: string | null
  tone:         string | null
}

// ── Draft generation ──────────────────────────────────────────────────────────
async function generateDraft(
  fullName: string, company: string | null, title: string | null,
  titleVerified: boolean, email: string | null, userContext: string | null,
  draftConf: number, anthropicKey: string,
  recruiter: RecruiterProfile | null,
  outreachType?: string | null,   // 'new_outreach' (default) | 'follow_up'
  sessionTone?: string | null,    // per-request tone override (beats recruiter-profile tone)
): Promise<{ subject: string; body: string } | null> {
  if (!anthropicKey) return null

  const titleInstruction = title
    ? (titleVerified
        ? `Candidate's current role: ${title} (confirmed from data provider — reference it naturally).`
        : `Candidate's likely role: ${title} (inferred — reference it cautiously without claiming certainty).`)
    : `Candidate's role is unknown — do NOT claim any specific title. Write using name and company only.`

  const recruiterName    = recruiter?.full_name    || null
  const recruiterCompany = recruiter?.company_name || null
  const recruiterTitle   = recruiter?.job_title    || null
  const hiringFocus      = recruiter?.hiring_focus || null
  const tone = sessionTone || recruiter?.tone || null   // session pill beats recruiter profile

  let signOff = 'Best,'
  if (recruiterName) {
    signOff = `Best,\n${recruiterName}`
    if (recruiterTitle && recruiterCompany) signOff += `\n${recruiterTitle} at ${recruiterCompany}`
  }

  const toneInstruction = tone
    ? `Tone: ${tone}, professional, peer-to-peer.`
    : 'Tone: professional, modern, peer-to-peer.'

  const hiringFocusInstruction = hiringFocus
    ? `Recruiter specializes in: ${hiringFocus} hiring.`
    : 'Recruiter specializes in general talent acquisition.'

  const recruiterBlock = recruiterName
    ? `Recruiter sending this email: ${recruiterName}${recruiterTitle ? `, ${recruiterTitle}` : ''}${recruiterCompany ? ` at ${recruiterCompany}` : ''}`
    : ''

  const isFollowUp = outreachType === 'follow_up'
  const prompt = isFollowUp
    ? `Write a brief recruiter follow-up email (40–70 words). The recruiter previously reached out to this candidate but received no response. Be warm, acknowledge the prior outreach in one sentence, and stay non-pushy. End with one soft question. Use ONLY the supplied information. Do not invent facts.

Candidate: ${fullName}
${company ? `Company: ${company}` : ''}
${titleInstruction}
${email ? `Email: ${email}` : 'No email — generate body only.'}
${userContext ? `Recruiter context: ${userContext}` : ''}
${recruiterBlock}
${hiringFocusInstruction}

Rules:
- No mention of "I saw your profile", "I noticed you", or LinkedIn.
- No exclamation marks.
- No invented achievements.
- ${toneInstruction}
- Must be noticeably shorter than a cold outreach — 40–70 words max.
- End the email body with exactly this sign-off (include it verbatim in the body field):
${signOff}

Return ONLY JSON: {"subject": "...", "body": "..."}`
    : `Write a concise recruiter outreach email (60–120 words). Use ONLY the supplied information. Do not invent facts.

Candidate: ${fullName}
${company ? `Company: ${company}` : ''}
${titleInstruction}
${email ? `Email: ${email}` : 'No email — generate body only.'}
${userContext ? `Recruiter context: ${userContext}` : ''}
${recruiterBlock}
${hiringFocusInstruction}
Confidence level: ${draftConf >= 0.65 ? 'normal — personalize where evidence exists' : 'low — be warm but generic, no specific claims'}

Rules:
- No mention of "I saw your profile", "I noticed you", or LinkedIn.
- No exclamation marks.
- No invented achievements.
- ${toneInstruction}
- One soft CTA.
- End the email body with exactly this sign-off (include it verbatim in the body field):
${signOff}

Return ONLY JSON: {"subject": "...", "body": "..."}`

  const raw = await callAnthropic(anthropicKey, 'claude-sonnet-4-5', 500, prompt)
  const p = parseJson(raw)
  if (!p.body) return null

  const bodyLines = p.body.trimEnd().split('\n')
  let trimIdx = bodyLines.length
  for (let i = bodyLines.length - 1; i >= 0; i--) {
    const line = bodyLines[i].trim()
    if (line === '' || line.startsWith('Best')) { trimIdx = i; continue }
    break
  }
  const bodyWithoutSignOff = bodyLines.slice(0, trimIdx).join('\n').trimEnd()
  const finalBody = bodyWithoutSignOff ? `${bodyWithoutSignOff}\n\n${signOff}` : signOff

  return { subject: p.subject || `Reaching out — ${fullName}`, body: finalBody }
}

// ── Weighted confidence formula ────────────────────────────────────────────────
function computeDraftConfidence(
  personConf: number, companyConf: number, titleConf: number,
  emailStatus: string, userContextLength: number
): number {
  const emailConf   = emailStatus === 'found' ? 1 : emailStatus === 'uncertain' ? 0.5 : 0
  const contextConf = Math.min(1, userContextLength / 100)
  return Math.round((
    personConf  * 0.35 +
    companyConf * 0.20 +
    titleConf   * 0.20 +
    emailConf   * 0.15 +
    contextConf * 0.10
  ) * 100) / 100
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const supabaseUrl       = Deno.env.get('SUPABASE_URL')!
  const serviceKey        = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anthropicKey      = Deno.env.get('ANTHROPIC_API_KEY')        || ''
  const fullenrichKey     = Deno.env.get('FULLENRICH_API_KEY')       || ''
  const googleKey         = Deno.env.get('GOOGLE_API_KEY')   || Deno.env.get('GOOGLE_CSE_KEY') || ''
  const googleCx          = Deno.env.get('GOOGLE_CX')        || Deno.env.get('GOOGLE_CSE_CX')  || ''
  const myEmailVerifierKey = Deno.env.get('MYEMAILVERIFIER_API_KEY') || ''
  const braveKey          = Deno.env.get('BRAVE_API_KEY')            || ''
  const pdlKey            = Deno.env.get('PDL_API_KEY')              || ''
  const openaiKey         = Deno.env.get('OPENAI_API_KEY')           || ''
  const mistralKey        = Deno.env.get('MISTRAL_API_KEY')          || '' // reserved for future
  const deepseekKey       = Deno.env.get('DEEPSEEK_API_KEY')         || ''
  const geminiKey         = Deno.env.get('GEMINI_API_KEY')           || ''
  const db = createClient(supabaseUrl, serviceKey)

  console.log('[enrich env]', JSON.stringify({
    version: FUNCTION_VERSION,
    has_anthropic_key: !!anthropicKey,
    has_google_key: !!googleKey,
    has_google_cx: !!googleCx,
    has_mev_key: !!myEmailVerifierKey,
    has_brave_key: !!braveKey,
    has_pdl_key: !!pdlKey,
    has_fullenrich_key: !!fullenrichKey,
    has_openai_key: !!openaiKey,
    has_deepseek_key: !!deepseekKey,
    has_gemini_key: !!geminiKey,
  }))

  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return json({ error: { code: 'AUTH_EXPIRED', message: 'Session expired — please sign in again.' } }, 401)
  const { data: { user }, error: authErr } = await db.auth.getUser(token)
  if (authErr || !user) return json({ error: { code: 'AUTH_EXPIRED', message: 'Session expired — please sign in again.' } }, 401)

  try {
    const body   = await req.json()
    const action = body.action || 'enrich-and-draft'

    // ── Summarize-job action ───────────────────────────────────────────────────
    if (action === 'summarize-job') {
      const rawText  = (body.rawText  || '').slice(0, 3000)
      const jobTitle = (body.jobTitle || '').trim()
      const company  = (body.company  || '').trim()
      if (!rawText && !jobTitle) return json({ error: { code: 'MISSING_INPUT', message: 'No job text provided.' } }, 400)
      if (!anthropicKey)         return json({ error: { code: 'NO_API_KEY',    message: 'AI not configured.'     } }, 500)

      const prompt = `You are helping a recruiter understand a job posting so they can write personalized outreach emails.

Job title: ${jobTitle || 'not specified'}
Company: ${company || 'not specified'}

Raw job posting text:
${rawText}

Extract the 3–5 most useful selling points a recruiter would reference in an outreach email. Focus on:
- What the role actually does day-to-day (skip generic boilerplate)
- The seniority level and key skills required
- Anything distinctive: compensation range, tech stack, team size, company stage, notable impact
- Why a strong candidate would find this role interesting

Format as short bullet points starting with "•", max 15 words each.
Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.`

      const summary = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 400, prompt)
      if (!summary || summary === '{}') return json({ error: { code: 'SUMMARY_FAILED', message: 'Could not summarize job posting.' } }, 500)
      return json({ summary })
    }

    // ── Bookmark-profile action ────────────────────────────────────────────────
    if (action === 'bookmark-profile') {
      const linkedinUrl = (body.linkedinUrl || '').trim()
      const save        = body.save !== false
      if (!linkedinUrl) return json({ error: { code: 'MISSING_INPUT', message: 'linkedinUrl is required.' } }, 400)

      const { error: updateErr, count } = await db.from('saved_profiles')
        .update({ is_bookmarked: save, updated_at: new Date().toISOString() }, { count: 'exact' })
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)

      if (updateErr) {
        console.error('bookmark-profile update failed:', updateErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not update bookmark.' } }, 500)
      }
      if (count === 0) {
        const { error: insertErr } = await db.from('saved_profiles')
          .insert({ user_id: user.id, linkedin_url: linkedinUrl, is_bookmarked: save })
        if (insertErr) {
          console.error('bookmark-profile insert failed:', insertErr)
          return json({ error: { code: 'DB_ERROR', message: 'Could not create bookmark.' } }, 500)
        }
      }
      return json({ bookmarked: save })
    }

    // ── Check-saved-profile action ─────────────────────────────────────────────
    if (action === 'check-saved-profile') {
      const linkedinUrl = (body.linkedinUrl || '').trim()
      if (!linkedinUrl) return json({ found: false })

      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data: cached } = await db.from('saved_profiles')
        .select('full_name, work_email, personal_email, title, company, title_verified, email_status, is_bookmarked, enriched_at')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .or(`is_bookmarked.eq.true,enriched_at.gte.${cacheWindow}`)
        .limit(1)
        .maybeSingle()

      if (!cached || !cached.full_name) return json({ found: false })

      return json({
        found: true,
        profile: {
          fullName:      cached.full_name,
          workEmail:     cached.work_email     || null,
          personalEmail: cached.personal_email || null,
          email:         cached.work_email || cached.personal_email || null,
          title:         cached.title          || null,
          titleVerified: cached.title_verified ?? false,
          company:       cached.company        || null,
          emailStatus:   cached.email_status   || 'not_found',
          isBookmarked:  cached.is_bookmarked  ?? false,
        },
      })
    }

    // ── Save-job action ────────────────────────────────────────────────────────
    if (action === 'save-job') {
      const label      = (body.label      || '').trim()
      const jobUrl     = (body.jobUrl     || '').trim() || null
      const roleTitle  = (body.roleTitle  || '').trim() || null
      const jobCompany = (body.company    || '').trim() || null
      const highlights = (body.highlights || '').trim() || null
      if (!label) return json({ error: { code: 'MISSING_INPUT', message: 'A job label is required.' } }, 400)

      const { data: job, error: upsertErr } = await db.from('saved_jobs')
        .upsert({
          user_id: user.id, label, job_url: jobUrl, role_title: roleTitle,
          company: jobCompany, highlights, updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,label' })
        .select('id, label, job_url, role_title, company, highlights')
        .single()

      if (upsertErr) {
        console.error('save-job upsert failed:', upsertErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not save job.' } }, 500)
      }
      return json({ job })
    }

    // ── Get-saved-jobs action ──────────────────────────────────────────────────
    if (action === 'get-saved-jobs') {
      const { data: jobs, error: fetchErr } = await db.from('saved_jobs')
        .select('id, label, job_url, role_title, company, highlights, updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(30)

      if (fetchErr) {
        console.error('get-saved-jobs failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load saved jobs.' } }, 500)
      }
      return json({ jobs: jobs || [] })
    }

    // ── Delete-job action ──────────────────────────────────────────────────────
    if (action === 'delete-job') {
      const jobId = (body.jobId || '').trim()
      if (!jobId) return json({ error: { code: 'MISSING_INPUT', message: 'jobId is required.' } }, 400)

      const { error: deleteErr } = await db.from('saved_jobs')
        .delete()
        .eq('id', jobId)
        .eq('user_id', user.id)

      if (deleteErr) {
        console.error('delete-job failed:', deleteErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not delete job.' } }, 500)
      }
      return json({ deleted: true })
    }

    // ── Get-saved-profiles action ──────────────────────────────────────────────
    if (action === 'get-saved-profiles') {
      const { data: profiles, error: fetchErr } = await db.from('saved_profiles')
        .select('id, linkedin_url, full_name, work_email, personal_email, title, company, title_verified, email_status, enriched_at, is_bookmarked')
        .eq('user_id', user.id)
        .eq('is_bookmarked', true)
        .order('updated_at', { ascending: false })
        .limit(20)

      if (fetchErr) {
        console.error('get-saved-profiles fetch failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load saved profiles.' } }, 500)
      }
      return json({ profiles: profiles || [] })
    }

    // ── Import-campaign action ─────────────────────────────────────────────────
    if (action === 'import-campaign') {
      const campaignName = (body.campaignName || '').trim()
      const jobId        = (body.jobId || '').trim() || null
      const candidates   = Array.isArray(body.candidates) ? body.candidates : []

      if (!campaignName) return json({ error: { code: 'MISSING_INPUT', message: 'Campaign name is required.' } }, 400)
      if (candidates.length === 0) return json({ error: { code: 'MISSING_INPUT', message: 'No candidates provided.' } }, 400)

      const linkedinUrls = candidates.map((c: any) => c.linkedin_url).filter(Boolean)
      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      let cachedCount = 0
      if (linkedinUrls.length > 0) {
        const { data: cachedProfiles } = await db.from('saved_profiles')
          .select('linkedin_url')
          .eq('user_id', user.id)
          .in('linkedin_url', linkedinUrls)
          .gte('enriched_at', cacheWindow)
        cachedCount = cachedProfiles?.length || 0
      }
      const freshNeeded = candidates.length - cachedCount

      const { data: credits } = await db.from('credits')
        .select('tier, lookups_used, period_end')
        .eq('user_id', user.id)
        .maybeSingle()

      let creditsRemaining = 10
      if (credits) {
        const tierLimits: Record<string, number> = { free: 10, sourcer: 50, pro: 200 }
        const max = tierLimits[credits.tier] || 10
        creditsRemaining = Math.max(0, max - (credits.lookups_used || 0))
      }

      const creditWarning = freshNeeded > creditsRemaining ? {
        needed: freshNeeded,
        available: creditsRemaining,
        message: `You have ${creditsRemaining} lookup${creditsRemaining !== 1 ? 's' : ''} remaining. Only ${creditsRemaining} of ${freshNeeded} candidates needing enrichment can be processed. Upgrade to enrich the full pipeline.`,
      } : null

      const campaignStatus = jobId ? 'ready' : 'needs_job'
      const { data: campaign, error: campaignErr } = await db.from('campaigns')
        .insert({
          user_id: user.id,
          name: campaignName,
          job_id: jobId,
          status: campaignStatus,
          total_count: candidates.length,
        })
        .select('id, name, job_id, status, total_count')
        .single()

      if (campaignErr || !campaign) {
        console.error('import-campaign insert failed:', campaignErr)
        if (campaignErr?.code === '23505') {
          return json({ error: { code: 'DUPLICATE_CAMPAIGN', message: 'A campaign with this name already exists. Rename it and try again.' } }, 409)
        }
        return json({ error: { code: 'DB_ERROR', message: 'Could not create campaign.' } }, 500)
      }

      const candidateRows = candidates.map((c: any) => ({
        campaign_id:     campaign.id,
        user_id:         user.id,
        first_name:      c.first_name || null,
        last_name:       c.last_name  || null,
        headline:        c.headline   || null,
        location:        c.location   || null,
        current_title:   c.current_title   || null,
        current_company: c.current_company || null,
        csv_email:       c.email      || null,
        phone:           c.phone      || null,
        linkedin_url:    c.linkedin_url || null,
        notes:           c.notes      || null,
        feedback:        c.feedback   || null,
        status:          'imported',
      }))

      const { error: candidatesErr } = await db.from('campaign_candidates').insert(candidateRows)
      if (candidatesErr) {
        console.error('import-campaign candidates insert failed:', candidatesErr)
        await db.from('campaigns').delete().eq('id', campaign.id)
        return json({ error: { code: 'DB_ERROR', message: 'Could not import candidates.' } }, 500)
      }

      return json({ campaign, totalCount: candidates.length, creditWarning })
    }

    // ── Get-campaigns action ───────────────────────────────────────────────────
    if (action === 'get-campaigns') {
      const { data: campaigns, error: fetchErr } = await db.from('campaigns')
        .select('id, name, job_id, status, total_count, enriched_count, drafted_count, approved_count, created_at, saved_jobs(label, company, job_url)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50)

      if (fetchErr) {
        console.error('get-campaigns failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load campaigns.' } }, 500)
      }

      // Compute live sent / responded / followed_up counts from candidate rows (single query)
      const campaignIds = (campaigns || []).map((c: any) => c.id)
      const statusCounts: Record<string, { approved: number; followed_up: number; responded: number }> = {}
      if (campaignIds.length > 0) {
        const { data: statusRows } = await db.from('campaign_candidates')
          .select('campaign_id, status')
          .eq('user_id', user.id)
          .in('campaign_id', campaignIds)
          .in('status', ['approved', 'followed_up', 'responded'])
        ;(statusRows || []).forEach((r: any) => {
          if (!statusCounts[r.campaign_id]) statusCounts[r.campaign_id] = { approved: 0, followed_up: 0, responded: 0 }
          const k = r.status as 'approved' | 'followed_up' | 'responded'
          statusCounts[r.campaign_id][k]++
        })
      }

      const withRates = (campaigns || []).map((c: any) => {
        const sc = statusCounts[c.id] || { approved: 0, followed_up: 0, responded: 0 }
        return {
          ...c,
          sent_count:        sc.approved + sc.followed_up + sc.responded,
          responded_count:   sc.responded,
          followed_up_count: sc.followed_up,
        }
      })
      return json({ campaigns: withRates })
    }

    // ── Get-campaign-candidates action ─────────────────────────────────────────
    if (action === 'get-campaign-candidates') {
      const campaignId = (body.campaignId || '').trim()
      const statusFilter = body.status || null
      if (!campaignId) return json({ error: { code: 'MISSING_INPUT', message: 'campaignId is required.' } }, 400)

      let query = db.from('campaign_candidates')
        .select('*, saved_profiles ( raw_data )')
        .eq('campaign_id', campaignId)
        .eq('user_id', user.id)
        .order('created_at', { ascending: true })
        .limit(200)

      if (statusFilter) query = query.eq('status', statusFilter)

      const { data: candidates, error: fetchErr } = await query
      if (fetchErr) {
        console.error('get-campaign-candidates failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load candidates.' } }, 500)
      }
      // Surface the waterfall source on each candidate so the UI can show a
      // "Source" badge (haiku, google_search, brave_search, pdl, fullenrich) at a glance.
      const enriched = (candidates || []).map((c: any) => {
        const raw = c.saved_profiles?.raw_data || {}
        const src = raw.post_fullenrich_retry_source || raw.waterfall_source || null
        delete c.saved_profiles
        return { ...c, enrichment_source: src }
      })
      return json({ candidates: enriched })
    }

    // ── Enrich-campaign-candidate action ──────────────────────────────────────
    if (action === 'enrich-campaign-candidate') {
      const candidateId = (body.candidateId || '').trim()
      if (!candidateId) return json({ error: { code: 'MISSING_INPUT', message: 'candidateId is required.' } }, 400)

      const correlationId = crypto.randomUUID().slice(0, 8)
      const { step, records } = makeStepLogger(db, user.id, correlationId, 'enrich-campaign-candidate')

      const { data: candidate, error: fetchErr } = await db.from('campaign_candidates')
        .select('*')
        .eq('id', candidateId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (fetchErr || !candidate) return json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } }, 404)
      if (!candidate.linkedin_url) {
        await db.from('campaign_candidates').update({ status: 'no_email', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ status: 'no_email', reason: 'No LinkedIn URL available for enrichment.', debug: { correlationId, records } })
      }

      await db.from('campaign_candidates').update({ status: 'enriching', updated_at: new Date().toISOString() }).eq('id', candidateId)

      // Step 1 — Cache
      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      let cached: any = null
      await step('cache', async () => {
        const { data } = await db.from('saved_profiles')
          .select('id, full_name, work_email, personal_email, title, company, title_verified, email_status, enriched_at')
          .eq('user_id', user.id)
          .eq('linkedin_url', candidate.linkedin_url)
          .gte('enriched_at', cacheWindow)
          .maybeSingle()
        if (data && data.full_name) {
          cached = data
          return { status: 'HIT', meta: { has_email: !!(data.work_email || data.personal_email) } }
        }
        return { status: 'MISS' }
      })

      if (cached) {
        const email = cached.work_email || cached.personal_email || null
        const newStatus = email ? 'enriched' : 'no_email'
        await db.from('campaign_candidates').update({
          status:           newStatus,
          work_email:       cached.work_email || null,
          personal_email:   cached.personal_email || null,
          email_status:     cached.email_status || 'not_found',
          enriched_title:   cached.title || null,
          enriched_company: cached.company || null,
          saved_profile_id: cached.id,
          enriched_at:      new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        }).eq('id', candidateId)

        await _incrementCampaignCount(db, candidate.campaign_id, 'enriched_count')

        return json({ status: newStatus, fromCache: true, email, debug: { correlationId, records } })
      }

      // Deduct credit for fresh enrichment
      const { data: creditAllowed, error: creditErr } = await db.rpc('deduct_credit', { p_user_id: user.id })
      if (creditErr) {
        await db.from('campaign_candidates').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ error: { code: 'CREDIT_ERROR', message: 'Could not verify credit balance.' }, debug: { correlationId, records } }, 500)
      }
      if (creditAllowed === false) {
        await db.from('campaign_candidates').update({ status: 'imported', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ error: { code: 'CREDIT_LIMIT_REACHED', message: 'Credit limit reached. Upgrade to continue enriching.' }, debug: { correlationId, records } }, 402)
      }

      // ── Heavy work runs in the background; we return 202 immediately so the
      //    edge function does not exceed its compute budget on hard misses
      //    (Haiku → Google → Brave → PDL → MEV → FullEnrich → retry waterfall).
      const runEnrichmentJob = async () => {
        try {
          const fullName = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || null
          const candidateCompanySize = typeof candidate.company_size === 'number'
            ? candidate.company_size
            : typeof candidate.employee_count === 'number'
              ? candidate.employee_count
              : null
          const initialNameWasIncomplete = !hasUsableWaterfallName(fullName)
          const csvEmailDomain = (candidate.csv_email && candidate.csv_email.includes('@'))
            ? candidate.csv_email.split('@')[1].toLowerCase()
            : null

          // Build a company hint that falls back through every available source
          // so resolve_domain has something to work with even when CSV import
          // didn't populate current_company.
          const companyHint =
            (candidate.current_company && String(candidate.current_company).trim()) ||
            (candidate.enriched_company && String(candidate.enriched_company).trim()) ||
            null
          console.log('[campaign-enrich inputs]', {
            candidateId, fullName, companyHint,
            csvEmailDomain, current_company: candidate.current_company,
          })

          // Steps 2–5 multi-company waterfall (cheap; FullEnrich stays last)
          let waterfall: WaterfallResult = { email: null, emailStatus: 'not_found', source: 'none', title: null, domain: csvEmailDomain }
          let batchCandidates: CompanyCandidate[] = []
          if (fullName) {
            // Look up same-profile cache so batch can use prior raw enrichment data
            // (FullEnrich employment list) without re-charging.
            let batchCachedCompany: string | null = null
            let batchRawEmployment: Array<{ name: string; domain: string | null }> = []
            if (candidate.linkedin_url) {
              try {
                const { data: sp } = await db.from('saved_profiles')
                  .select('company, raw_data')
                  .eq('user_id', user.id)
                  .eq('linkedin_url', candidate.linkedin_url)
                  .maybeSingle()
                batchCachedCompany = sp?.company || null
                batchRawEmployment = extractCompaniesFromRawProfile(sp?.raw_data)
              } catch {}
            }
            batchCandidates = await discoverCompanyCandidates({
              manual:        null,
              scraped:       companyHint,
              cached:        batchCachedCompany,
              rawEmployment: batchRawEmployment,
              csvEmailDomain,
              linkedinUrl:   candidate.linkedin_url,
              fullName,
              googleKey, googleCx,
            })
            const trustedBatch = batchCandidates.filter(c => c.confidence >= MIN_COMPANY_CONFIDENCE)
            await step('company_discovery', async () => ({
              status: trustedBatch.length > 0 ? 'OK' : (batchCandidates.length > 0 ? 'MISS' : 'MISS'),
              meta: {
                count: batchCandidates.length,
                trusted: trustedBatch.length,
                min_confidence: MIN_COMPANY_CONFIDENCE,
                candidates: batchCandidates.map(c => ({ name: c.name, source: c.source, confidence: c.confidence, trusted: c.confidence >= MIN_COMPANY_CONFIDENCE })),
              },
            }))
            const r = await runMultiCompanyWaterfall({
              fullName,
              companies: trustedBatch,
              knownDomain: csvEmailDomain,
              companySize: candidateCompanySize,
              linkedinUrl: candidate.linkedin_url || null,
              anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey,
              openaiKey, deepseekKey, geminiKey,
              db,
              step,
            })
            waterfall = r.result
          } else {
            await step('haiku_pattern_cache',              async () => ({ status: 'SKIP', reason: 'no_full_name' }))
            await step('haiku_email_guess',               async () => ({ status: 'SKIP', reason: 'no_full_name' }))
            await step('myemailverifier_haiku',            async () => ({ status: 'SKIP', reason: 'no_full_name' }))
            await step('google_search',                    async () => ({ status: 'SKIP', reason: 'no_full_name' }))
            await step('brave_search',                     async () => ({ status: 'SKIP', reason: 'no_full_name' }))
            await step('haiku_refine_candidates',          async () => ({ status: 'SKIP', reason: 'no_full_name' }))
            await step('myemailverifier_search_round1',    async () => ({ status: 'SKIP', reason: 'no_full_name' }))
            await step('pdl_person_enrichment',            async () => ({ status: 'SKIP', reason: 'no_full_name' }))
            await step('myemailverifier_search_candidates',async () => ({ status: 'SKIP', reason: 'no_full_name' }))
          }

          let finalEmail: string | null = waterfall.email
          let finalEmailStatus: 'found' | 'uncertain' | 'not_found' = waterfall.emailStatus
          let finalTitle: string | null = waterfall.title || candidate.current_title || null
          let finalCompany: string | null = companyHint
          let finalCompanyDomain: string | null = csvEmailDomain
          let finalFullName: string | null = fullName
          let finalPersonalEmail: string | null = null
          let rawData: any = { waterfall_source: waterfall.source }

          // If the waterfall found a personal-domain email (e.g. gmail), reclassify it:
          // store it as personal_email — do NOT trigger FullEnrich just to upgrade to a work email.
          // FullEnrich is reserved for the case where we have NO email at all.
          // If the company scraper is correct, the pattern cache will find the work email anyway.
          if (finalEmail && isPersonalEmailDomain(finalEmail)) {
            console.log(`[enrich-bg] waterfall found personal email — keeping as personal, skipping FullEnrich: ${maskEmail(finalEmail)}`)
            finalPersonalEmail = finalEmail
            finalEmail = null
            finalEmailStatus = 'not_found'
          }

          // Step 6 — FullEnrich: only when we have NO email signal at all (neither work nor personal).
          if (!finalEmail && !finalPersonalEmail) {
            // Snapshot what we know before FullEnrich so the retry guard can detect new signal
            const nameBeforeFullenrich   = finalFullName
            const domainBeforeFullenrich = finalCompanyDomain
            let fullenrichReturnedEmail = false

            await step('fullenrich_v2', async () => {
              if (!fullenrichKey) return { status: 'SKIP', reason: 'no_fullenrich_key' }
              try {
                const r = await enrichWithLinkedInV2(candidate.linkedin_url, fullenrichKey)
                finalFullName = r.full_name || finalFullName
                finalEmail = r.work_email || r.personal_email || finalEmail
                fullenrichReturnedEmail = !!(r.work_email || r.personal_email)
                // Preserve any personal email already found by the waterfall (e.g. gmail from PDL)
                finalPersonalEmail = r.personal_email || finalPersonalEmail
                finalEmailStatus = r.work_email ? 'found' : r.personal_email ? 'uncertain' : finalEmailStatus
                finalTitle = r.title || finalTitle
                
                // NEW FIX (v40): If FullEnrich returns a different company, log warning and prefer it
                const companyHintForCandidate = (candidate.current_company && String(candidate.current_company).trim()) ||
                                                 (candidate.enriched_company && String(candidate.enriched_company).trim()) ||
                                                 null
                if (r.company && companyHintForCandidate && 
                    r.company.toLowerCase() !== companyHintForCandidate.toLowerCase()) {
                  console.warn(`[fullenrich_v2 batch] Company mismatch detected:`, {
                    candidate_id: candidateId,
                    scraped_company: companyHintForCandidate,
                    fullenrich_company: r.company,
                    linkedin_url: candidate.linkedin_url,
                  })
                  // Prefer FullEnrich's company
                  finalCompany = r.company
                  finalCompanyDomain = sanitizeDomain(r.company_domain) || finalCompanyDomain
                  // Write to company_domain_hints for future lookups
                  if (r.company_domain) {
                    await upsertCompanyDomainHint(db, r.company, sanitizeDomain(r.company_domain))
                  }
                } else {
                  finalCompany = r.company || finalCompany
                  finalCompanyDomain = sanitizeDomain(r.company_domain) || finalCompanyDomain
                }
                
                rawData = { ...rawData, fullenrich: r.raw, waterfall_source: r.work_email || r.personal_email ? 'fullenrich_v2' : rawData.waterfall_source }
                return { status: r.work_email || r.personal_email ? 'OK' : 'MISS', meta: { email: maskEmail(finalEmail) } }
              } catch (e: any) {
                return { status: 'FAIL', reason: String(e?.message || e) }
              }
            })

            // Only retry if:
            // 1. Still no email (FullEnrich didn't solve it directly), AND
            // 2. FullEnrich returned genuinely new signal: a different name or domain
            //    that the waterfall couldn't have used on the first pass.
            const fullenrichGaveNewName   = !!(finalFullName   && finalFullName   !== nameBeforeFullenrich)
            const fullenrichGaveNewDomain = !!(finalCompanyDomain && finalCompanyDomain !== domainBeforeFullenrich)
            const shouldRetry = !finalEmail && !fullenrichReturnedEmail
              && finalFullName && hasUsableWaterfallName(finalFullName)
              && (fullenrichGaveNewName || fullenrichGaveNewDomain)

            if (shouldRetry) {
              await step('post_fullenrich_retry', async () => {
                console.log(`[post_fullenrich_retry] retrying with name="${finalFullName}" domain="${finalCompanyDomain}" (new_name=${fullenrichGaveNewName} new_domain=${fullenrichGaveNewDomain})`)
                // Use a prefixed step wrapper so retry steps are distinguishable in logs
                const retryStep: typeof step = async (name, fn) => step(`retry_${name}`, fn)
                const retry = await runEmailWaterfall({
                  fullName: finalFullName!,
                  companyName: finalCompany,
                  knownDomain: finalCompanyDomain,
                  companySize: candidateCompanySize,
                  linkedinUrl: candidate.linkedin_url || null,
                  anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey,
                  openaiKey, deepseekKey, geminiKey,
                  db,
                  step: retryStep,
                })
                if (!retry.email) return { status: 'MISS', reason: 'no_email', meta: { source: retry.source, new_name: fullenrichGaveNewName, new_domain: fullenrichGaveNewDomain } }
                finalEmail = retry.email
                finalEmailStatus = retry.emailStatus
                finalTitle = retry.title || finalTitle
                rawData = { ...rawData, waterfall_source: retry.source, post_fullenrich_retry_source: retry.source }
                return { status: 'OK', meta: { email: maskEmail(retry.email), source: retry.source } }
              })
            }
          } else {
            // Skip FullEnrich: either we have a work email, or a personal email is enough to stop here.
            const skipReason = finalEmail
              ? `work_email_found_via_${waterfall.source}`
              : `personal_email_found_skipping_fullenrich`
            await step('fullenrich_v2', async () => ({ status: 'SKIP', reason: skipReason }))
          }

          // ── Seed pattern cache from FullEnrich-discovered work emails ─────────
          // Without this, every employee at the same company burns FullEnrich credit
          // because the waterfall never got a chance to store the pattern.
          if (finalEmail && !isPersonalEmailDomain(finalEmail) && finalEmailStatus === 'found' && db) {
            const emailDomain = finalEmail.split('@')[1]
            if (emailDomain) {
              await upsertEmailPattern(db, emailDomain, finalEmail, finalFullName || '', false)
              console.log(`[enrich-bg] seeded pattern cache from FullEnrich: ${emailDomain}`)
            }
          }

          // An enrichment is considered successful if we have either a work OR personal email.
          const newStatus = (finalEmail || finalPersonalEmail) ? 'enriched' : 'no_email'

          // Route emails: work emails go to work_email (status=found), personal to personal_email.
          // finalPersonalEmail collects any personal-domain address found at any stage.
          const workEmailToSave     = finalEmailStatus === 'found' ? finalEmail : null
          const personalEmailToSave = finalPersonalEmail ?? (finalEmailStatus === 'uncertain' ? finalEmail : null)

          const { data: savedProfile } = await db.from('saved_profiles').upsert({
            user_id:        user.id,
            linkedin_url:   candidate.linkedin_url,
            full_name:      finalFullName,
            work_email:     workEmailToSave,
            personal_email: personalEmailToSave,
            title:          finalTitle,
            company:        finalCompany,
            title_verified: !!waterfall.title || !!candidate.enriched_title,
            email_status:   finalEmailStatus,
            raw_data:       rawData,
            enriched_at:    new Date().toISOString(),
            updated_at:     new Date().toISOString(),
          }, { onConflict: 'user_id,linkedin_url', ignoreDuplicates: false })
            .select('id')
            .maybeSingle()

          await db.from('campaign_candidates').update({
            status:           newStatus,
            work_email:       workEmailToSave,
            personal_email:   personalEmailToSave,
            email_status:     finalEmailStatus,
            enriched_title:   finalTitle,
            enriched_company: finalCompany,
            saved_profile_id: savedProfile?.id || null,
            enriched_at:      new Date().toISOString(),
            updated_at:       new Date().toISOString(),
          }).eq('id', candidateId)

          await _incrementCampaignCount(db, candidate.campaign_id, 'enriched_count')
          console.log(`[enrich-bg ${correlationId}] done status=${newStatus} source=${rawData.waterfall_source}`)
        } catch (e: any) {
          console.error(`[enrich-bg ${correlationId}] failed:`, e)
          try {
            await db.from('campaign_candidates').update({
              status: 'failed',
              updated_at: new Date().toISOString(),
            }).eq('id', candidateId)
          } catch {}
        }
      }

      // Kick off background job. EdgeRuntime.waitUntil keeps the worker alive
      // after the response is sent. Fall back to fire-and-forget if unavailable.
      // @ts-ignore — EdgeRuntime is provided by Supabase's Deno runtime
      if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime.waitUntil === 'function') {
        // @ts-ignore
        EdgeRuntime.waitUntil(runEnrichmentJob())
      } else {
        runEnrichmentJob().catch(() => {})
      }

      return json({
        status: 'enriching',
        candidateId,
        message: 'Enrichment started. Poll get-campaign-candidates for updates.',
        debug: { correlationId, records },
      }, 202)
    }

    // ── Draft-campaign-candidate action ───────────────────────────────────────
    if (action === 'draft-campaign-candidate') {
      const candidateId = (body.candidateId || '').trim()
      if (!candidateId) return json({ error: { code: 'MISSING_INPUT', message: 'candidateId is required.' } }, 400)

      const { data: candidate, error: fetchErr } = await db.from('campaign_candidates')
        .select('*')
        .eq('id', candidateId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (fetchErr || !candidate) return json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } }, 404)

      const { data: campaign } = await db.from('campaigns')
        .select('job_id')
        .eq('id', candidate.campaign_id)
        .maybeSingle()

      let jobContext: string | null = null
      if (campaign?.job_id) {
        const { data: job } = await db.from('saved_jobs')
          .select('role_title, company, highlights')
          .eq('id', campaign.job_id)
          .maybeSingle()
        if (job) {
          const parts = []
          if (job.role_title) parts.push(`Recruiting for: ${job.role_title}${job.company ? ' at ' + job.company : ''}`)
          if (job.highlights) parts.push(job.highlights)
          jobContext = parts.join('. ') || null
        }
      }

      let recruiterProfile: RecruiterProfile | null = null
      try {
        const { data: rp } = await db.from('recruiter_profiles')
          .select('full_name, company_name, job_title, hiring_focus, tone')
          .eq('user_id', user.id)
          .maybeSingle()
        if (rp) recruiterProfile = rp as RecruiterProfile
      } catch {}

      const email = candidate.work_email || candidate.personal_email || candidate.csv_email || null
      const fullName = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || 'this candidate'
      const company = candidate.enriched_company || candidate.current_company || null
      const title = candidate.enriched_title || candidate.current_title || null

      await db.from('campaign_candidates').update({ status: 'drafting', updated_at: new Date().toISOString() }).eq('id', candidateId)

      const personConf  = 0.8
      const companyConf = company ? 0.85 : 0.3
      const titleConf   = title ? 0.7 : 0
      const emailStatus = email ? (candidate.work_email ? 'found' : 'uncertain') : 'not_found'
      const draftConf = computeDraftConfidence(personConf, companyConf, titleConf, emailStatus, (jobContext || '').length)

      try {
        const draft = await generateDraft(
          fullName, company, title, !!candidate.enriched_title,
          email, jobContext,
          draftConf, anthropicKey,
          recruiterProfile
        )

        if (!draft) {
          await db.from('campaign_candidates').update({ status: 'enriched', updated_at: new Date().toISOString() }).eq('id', candidateId)
          return json({ error: { code: 'DRAFT_FAILED', message: 'Could not generate draft.' } }, 500)
        }

        await db.from('campaign_candidates').update({
          status:           'drafted',
          draft_subject:    draft.subject,
          draft_body:       draft.body,
          draft_confidence: draftConf,
          drafted_at:       new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        }).eq('id', candidateId)

        await _incrementCampaignCount(db, candidate.campaign_id, 'drafted_count')

        try { await db.rpc('increment_ai_run', { p_user_id: user.id }) } catch {}

        return json({ status: 'drafted', draft, draftConfidence: draftConf })
      } catch (e: any) {
        console.error('draft-campaign-candidate failed:', e)
        await db.from('campaign_candidates').update({ status: 'enriched', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ error: { code: 'DRAFT_FAILED', message: e.message || 'Draft generation failed.' } }, 500)
      }
    }

    // ── Update-candidate-status action ─────────────────────────────────────────
    if (action === 'update-candidate-status') {
      const candidateId = (body.candidateId || '').trim()
      const newStatus   = (body.status || '').trim()
      const allowed     = ['approved', 'skipped', 'imported', 'enriched', 'drafted', 'followed_up', 'responded']
      if (!candidateId) return json({ error: { code: 'MISSING_INPUT', message: 'candidateId is required.' } }, 400)
      if (!allowed.includes(newStatus)) return json({ error: { code: 'INVALID_STATUS', message: 'Invalid status value.' } }, 400)

      const updateData: any = { status: newStatus, updated_at: new Date().toISOString() }
      if (newStatus === 'approved')     updateData.approved_at     = new Date().toISOString()
      if (newStatus === 'followed_up')  updateData.followed_up_at  = new Date().toISOString()

      const { data: updated, error: updateErr } = await db.from('campaign_candidates')
        .update(updateData)
        .eq('id', candidateId)
        .eq('user_id', user.id)
        .select('id, campaign_id, status')
        .maybeSingle()

      if (updateErr) return json({ error: { code: 'DB_ERROR', message: 'Could not update status.' } }, 500)

      if (newStatus === 'approved' && updated?.campaign_id) {
        await _incrementCampaignCount(db, updated.campaign_id, 'approved_count')
      }

      return json({ updated: true, status: newStatus })
    }

    // ── Link-campaign-job action ───────────────────────────────────────────────
    if (action === 'link-campaign-job') {
      const campaignId = (body.campaignId || '').trim()
      const jobId      = (body.jobId || '').trim()
      if (!campaignId || !jobId) return json({ error: { code: 'MISSING_INPUT', message: 'campaignId and jobId are required.' } }, 400)

      const { error: updateErr } = await db.from('campaigns')
        .update({ job_id: jobId, status: 'ready', updated_at: new Date().toISOString() })
        .eq('id', campaignId)
        .eq('user_id', user.id)

      if (updateErr) return json({ error: { code: 'DB_ERROR', message: 'Could not link job.' } }, 500)
      return json({ linked: true })
    }

    // ── Delete-campaign action ─────────────────────────────────────────────────
    if (action === 'delete-campaign') {
      const campaignId = (body.campaignId || '').trim()
      if (!campaignId) return json({ error: { code: 'MISSING_INPUT', message: 'campaignId is required.' } }, 400)

      const { error: deleteErr } = await db.from('campaigns')
        .delete()
        .eq('id', campaignId)
        .eq('user_id', user.id)

      if (deleteErr) return json({ error: { code: 'DB_ERROR', message: 'Could not delete campaign.' } }, 500)
      return json({ deleted: true })
    }

    // ── Guard: reject unknown actions before falling through to default flow ──
    const KNOWN_ACTIONS = [
      'enrich-and-draft', 'summarize-job', 'bookmark-profile', 'check-saved-profile',
      'get-saved-profiles', 'save-job', 'get-saved-jobs', 'delete-job',
      'import-campaign', 'get-campaigns', 'get-campaign-candidates',
      'enrich-campaign-candidate', 'draft-campaign-candidate',
      'update-candidate-status', 'link-campaign-job', 'delete-campaign',
    ]
    if (!KNOWN_ACTIONS.includes(action)) {
      return json({ error: { code: 'UNKNOWN_ACTION', message: `Unknown action: ${action}` } }, 400)
    }

    // ── Enrich-and-draft action (default single-profile flow) ─────────────────
    const linkedinUrl        = body.linkedinUrl?.trim() || null
    const companyHint        = body.companyHint?.trim() || null
    const companyHintSource  = body.companyHintSource?.trim() || null
    const userContext        = body.userContext?.trim() || null
    const fullNameHint       = body.fullNameHint?.trim() || null
    const sessionTone        = body.tone?.trim()         || null   // per-request tone pill override
    const outreachType       = body.outreachType?.trim() || null   // 'new_outreach' | 'follow_up'

    console.log('[outreach-enrich inputs]', {
      linkedinUrl, fullNameHint, companyHint, companyHintSource,
    })

    if (!linkedinUrl) return json({ error: { code: 'NO_LINKEDIN_URL', message: 'Open a LinkedIn profile to generate a draft.' } }, 400)

    const correlationId = crypto.randomUUID().slice(0, 8)
    const { step, records } = makeStepLogger(db, user.id, correlationId, 'enrich-and-draft')

    let recruiterProfile: RecruiterProfile | null = null
    try {
      const { data: rp } = await db.from('recruiter_profiles')
        .select('full_name, company_name, job_title, hiring_focus, tone')
        .eq('user_id', user.id)
        .maybeSingle()
      if (rp) recruiterProfile = rp as RecruiterProfile
    } catch (e) { console.warn('recruiter_profiles fetch failed (non-fatal):', e) }

    // Step 1 — Cache
    const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    let cached: any = null
    await step('cache', async () => {
      const { data } = await db.from('saved_profiles')
        .select('full_name, work_email, personal_email, title, company, title_verified, email_status, is_bookmarked, enriched_at')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .or(`is_bookmarked.eq.true,enriched_at.gte.${cacheWindow}`)
        .limit(1)
        .maybeSingle()
      if (data && data.full_name) {
        cached = data
        return { status: 'HIT', meta: { has_email: !!(data.work_email || data.personal_email) } }
      }
      return { status: 'MISS' }
    })

    if (cached) {
      const fullName     = cached.full_name
      const work_email   = cached.work_email || null
      const personal_email = cached.personal_email || null
      const selectedEmail  = work_email || personal_email || null
      const company        = companyHint || cached.company || null
      const title          = cached.title || null
      const titleVerified  = cached.title_verified ?? false
      const emailStatus    = (cached.email_status as 'found' | 'not_found' | 'uncertain') || 'not_found'

      const personConfidence  = 0.95
      const companyConfidence = company ? 0.90 : 0.3
      const titleConfidence   = title ? (titleVerified ? 0.90 : 0.40) : 0

      const draftConfidence = computeDraftConfidence(
        personConfidence, companyConfidence, titleConfidence,
        emailStatus, (userContext || '').length
      )

      let status: 'success' | 'partial' | 'not_enough_data' = 'success'
      if (!selectedEmail && !company) status = 'not_enough_data'
      else if (!selectedEmail || titleConfidence < 0.3) status = 'partial'

      let draft: { subject: string; body: string } | null = null
      if (status !== 'not_enough_data' && anthropicKey) {
        try {
          draft = await step('sonnet_draft', async () => {
            const d = await generateDraft(
              fullName, company, title, titleVerified,
              selectedEmail, userContext,
              draftConfidence, anthropicKey,
              recruiterProfile,
              outreachType,
              sessionTone,
            )
            return { status: d ? 'OK' : 'MISS', result: d, meta: { confidence: draftConfidence } }
          }).then(r => r.result || null)
        } catch (e) { console.error('Draft generation (cache) failed:', e) }
      }

      if (!draft && status !== 'not_enough_data') {
        return json({ error: { code: 'DRAFT_GENERATION_FAILED', message: 'Contact details were found, but the draft could not be generated.' }, debug: { correlationId, records } }, 500)
      }

      return json({
        status,
        fromCache: true,
        isBookmarked: cached.is_bookmarked ?? false,
        person: {
          fullName, company, title, titleVerified,
          email: selectedEmail, workEmail: work_email,
          personalEmail: personal_email, emailStatus,
          emailSource: 'saved_profile',
        },
        confidence: { personConfidence, companyConfidence, titleConfidence, draftConfidence },
        sources: [{ type: 'saved_profile', label: 'From saved profile (cached)', confidence: 0.95 }],
        draft: draft || null,
        debug: { correlationId, records },
      })
    }

    // ── Guard: require a full name BEFORE charging a credit ──────────────────
    // If the extension couldn't scrape the name from the LinkedIn DOM, we'd
    // otherwise skip the cheap waterfall and burn a FullEnrich credit immediately.
    // Instead, ask the user to type the name — no credit charged.
    if (!fullNameHint || !fullNameHint.trim()) {
      return json({
        error: {
          code: 'NEED_FULL_NAME',
          message: "We couldn't read the name from this LinkedIn page. Type the name above and click Lookup again — no credit will be charged.",
        },
        debug: { correlationId, records },
      }, 422)
    }

    // ── Guard: discover company candidates BEFORE charging a credit ──────────
    // The cheap waterfall is useless without a company name (resolve_domain
    // returns no_candidates and FullEnrich becomes the only path). So we
    // assemble candidates from manual / scrape / cache / prior runs / Google
    // snippet — and if NONE exist, ask the user to type one. No credit charged.
    const acceptedCompanyHint = (companyHint && companyHint.trim().length >= 2) ? companyHint.trim() : null

    let cachedCompany: string | null = null
    let cachedRawEmployment: Array<{ name: string; domain: string | null }> = []
    try {
      const { data: sp } = await db.from('saved_profiles')
        .select('company, raw_data')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .maybeSingle()
      cachedCompany = sp?.company || null
      cachedRawEmployment = extractCompaniesFromRawProfile(sp?.raw_data)
    } catch {}

    let companyCandidates: CompanyCandidate[] = []
    let trustedCandidates: CompanyCandidate[] = []
    await step('company_discovery', async () => {
      companyCandidates = await discoverCompanyCandidates({
        manual:        acceptedCompanyHint,
        scraped:       companyHintSource === 'manual' ? null : acceptedCompanyHint,
        cached:        cachedCompany,
        rawEmployment: cachedRawEmployment,
        linkedinUrl,
        fullName:      fullNameHint,
        googleKey, googleCx,
      })
      trustedCandidates = companyCandidates.filter(c => c.confidence >= MIN_COMPANY_CONFIDENCE)
      
      // v40.2: Log warning if top candidate has low confidence
      if (companyCandidates.length > 0 && companyCandidates[0].confidence < 0.70) {
        console.warn('[company_discovery] Low confidence company detected:', {
          company: companyCandidates[0].name,
          source: companyCandidates[0].source,
          confidence: companyCandidates[0].confidence,
          linkedin_url: linkedinUrl,
          correlation_id: correlationId,
          warning: 'This company may be incorrectly scraped. Waterfall may fail at wrong domain.',
        })
      }
      
      return {
        status: trustedCandidates.length > 0 ? 'OK' : 'MISS',
        meta: {
          count: companyCandidates.length,
          trusted: trustedCandidates.length,
          min_confidence: MIN_COMPANY_CONFIDENCE,
          candidates: companyCandidates.map(c => ({ name: c.name, source: c.source, confidence: c.confidence, trusted: c.confidence >= MIN_COMPANY_CONFIDENCE })),
          guard: trustedCandidates.length > 0 ? 'pass' : (companyCandidates.length > 0 ? 'rejected_low_confidence' : 'no_candidates'),
        },
      }
    })

    if (trustedCandidates.length === 0) {
      // Surface low-confidence guesses to the popup as suggestion chips.
      const suggestions = companyCandidates.map(c => ({ name: c.name, source: c.source, confidence: c.confidence }))
      return json({
        error: {
          code: 'NEED_COMPANY',
          message: companyCandidates.length > 0
            ? "We couldn't confirm this person's current company. Pick a suggestion or type the correct company above — no credit will be charged."
            : "We couldn't detect this person's company from LinkedIn or public sources. Type the company name above and try again — no credit will be charged.",
        },
        companyCandidates: suggestions,
        debug: { correlationId, records },
      }, 422)
    }
    // Use only trusted candidates for the waterfall.
    companyCandidates = trustedCandidates

    // Idempotency guard (fail-open): stop two simultaneous in-flight lookups of the
    // same profile from each deducting a credit. Requires the acquire_lookup_lock RPC
    // (see supabase/migrations) — if it isn't deployed, the call errors and we proceed
    // exactly as before. Repeat lookups *after* completion are already served free by
    // the cache step above, so we rely on the lock's TTL rather than an explicit release.
    try {
      const { data: lockOk, error: lockErr } = await db.rpc('acquire_lookup_lock', { p_user_id: user.id, p_linkedin_url: linkedinUrl })
      if (!lockErr && lockOk === false) {
        return json({ error: { code: 'LOOKUP_IN_PROGRESS', message: 'This profile is already being looked up. Give it a moment and try again — no extra credit will be charged.' }, debug: { correlationId, records } }, 409)
      }
    } catch { /* RPC not deployed — fail open, behave exactly as before */ }

    const { data: creditAllowed, error: creditErr } = await db.rpc('deduct_credit', { p_user_id: user.id })
    if (creditErr) {
      console.error('deduct_credit RPC error:', creditErr)
      return json({ error: { code: 'CREDIT_ERROR', message: 'Could not verify your credit balance. Please try again.' }, debug: { correlationId, records } }, 500)
    }
    if (creditAllowed === false) {
      return json({ error: { code: 'CREDIT_LIMIT_REACHED', message: 'You have reached your lookup limit. Upgrade your plan for more enrichments.' }, debug: { correlationId, records } }, 402)
    }

    const sources: any[] = []
    let personConfidence = fullNameHint ? 0.7 : 0.5

    let fullName: string = fullNameHint || ''
    const initialNameWasIncomplete = !hasUsableWaterfallName(fullName)
    let work_email: string | null = null
    let personal_email: string | null = null
    let selectedEmail: string | null = null
    let company: string | null = companyHint || null
    let companyDomain: string | null = null
    let providerTitle: string | null = null
    let emailStatus: 'found' | 'not_found' | 'uncertain' = 'not_found'
    let emailDomain: string | null = null
    let companyConfidence = companyHint ? 0.7 : 0.3
    let titleVerified = false
    let rawDataPayload: any = null

    // Steps 2–5 — Multi-company email waterfall (cheap; FullEnrich stays last)
    let waterfallSource: WaterfallResult['source'] = 'none'
    let waterfallPhones: string[] = []
    if (fullName) {
      const { result: w, winner } = await runMultiCompanyWaterfall({
        fullName,
        companies: companyCandidates,
        knownDomain: null,
        companySize: null,
        linkedinUrl: linkedinUrl || null,
        anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey,
        openaiKey, deepseekKey, geminiKey,
        db,
        step,
      })
      waterfallSource = w.source
      waterfallPhones = w.phones || []
      if (winner) {
        company = winner.name
        companyConfidence = Math.max(companyConfidence, winner.confidence)
      }
      if (w.email) {
        work_email = w.email
        selectedEmail = w.email
        emailStatus = 'found'
        emailDomain = w.email.split('@')[1] || null
        if (w.title) { providerTitle = w.title; titleVerified = true }
        sources.push({ type: w.source, label: `Email via ${w.source}${winner ? ` (${winner.name})` : ''}`, confidence: 0.85 })
      }
      // Personal-domain email (gmail, yahoo, etc.) found during work-email search.
      // Store it separately — do NOT treat as work email, do NOT trigger FullEnrich.
      if (w.personalEmail && !personal_email) {
        personal_email = w.personalEmail
        if (!selectedEmail) {
          selectedEmail = w.personalEmail  // prevents FullEnrich since we have signal
          emailStatus = 'uncertain'
          emailDomain = w.personalEmail.split('@')[1] || null
        }
        sources.push({ type: w.source, label: `Personal email via ${w.source}`, confidence: 0.7 })
      }
    } else {
      await step('haiku_pattern_cache',              async () => ({ status: 'SKIP', reason: 'no_full_name_yet' }))
      await step('haiku_email_guess',               async () => ({ status: 'SKIP', reason: 'no_full_name_yet' }))
      await step('myemailverifier_haiku',            async () => ({ status: 'SKIP', reason: 'no_full_name_yet' }))
      await step('google_search',                    async () => ({ status: 'SKIP', reason: 'no_full_name_yet' }))
      await step('brave_search',                     async () => ({ status: 'SKIP', reason: 'no_full_name_yet' }))
      await step('haiku_refine_candidates',          async () => ({ status: 'SKIP', reason: 'no_full_name_yet' }))
      await step('myemailverifier_search_round1',    async () => ({ status: 'SKIP', reason: 'no_full_name_yet' }))
      await step('pdl_person_enrichment',            async () => ({ status: 'SKIP', reason: 'no_full_name_yet' }))
      await step('myemailverifier_search_candidates',async () => ({ status: 'SKIP', reason: 'no_full_name_yet' }))
    }

    // Step 6 — FullEnrich (last resort, also fills name/title/company gaps)
    if (!selectedEmail || !fullName) {
      // Snapshot before FullEnrich so the retry guard can detect genuinely new signal
      const nameBeforeFullenrich   = fullName
      const domainBeforeFullenrich = companyDomain || emailDomain
      let fullenrichReturnedEmail  = false

      await step('fullenrich_v2', async () => {
        if (!fullenrichKey) return { status: 'SKIP', reason: 'no_fullenrich_key' }
        let enrichRaw: any = null
        let enrichStatus = 0
        try {
          const enrichResult = await enrichWithLinkedInV2(linkedinUrl, fullenrichKey)
          enrichRaw       = enrichResult.raw
          rawDataPayload  = enrichResult.raw
          enrichStatus = 200

          if (enrichResult.full_name) { fullName = enrichResult.full_name; personConfidence = 0.95 }

          if (!selectedEmail) {
            work_email     = enrichResult.work_email
            personal_email = enrichResult.personal_email
            selectedEmail  = work_email || personal_email || null
            fullenrichReturnedEmail = !!(work_email || personal_email)
            emailStatus    = work_email ? 'found' : personal_email ? 'uncertain' : emailStatus
            if (work_email) emailDomain = work_email.split('@')[1] || null
            else if (personal_email) emailDomain = personal_email.split('@')[1] || null
            if (fullenrichReturnedEmail) waterfallSource = 'fullenrich_v2'
            // Store company → domain hint so repeat lookups skip FullEnrich entirely
            if (fullenrichReturnedEmail && emailDomain) {
              await upsertCompanyDomainHint(db, companyHint, emailDomain)
            }
          }

          if (enrichResult.company) {
            // NEW FIX (v40): If FullEnrich returns a different company than what was scraped,
            // log a warning and prefer FullEnrich's company for future lookups.
            if (companyHint && enrichResult.company.toLowerCase() !== companyHint.toLowerCase()) {
              console.warn(`[fullenrich_v2] Company mismatch detected:`, {
                scraped_company: companyHint,
                fullenrich_company: enrichResult.company,
                linkedin_url: linkedinUrl,
                correlation_id: correlationId,
              })
              // Prefer FullEnrich's company — it's authoritative from profile data
              company = enrichResult.company
              companyDomain = enrichResult.company_domain
              companyConfidence = 0.95
              // Write FullEnrich's company to company_domain_hints so future lookups use it
              if (enrichResult.company_domain) {
                await upsertCompanyDomainHint(db, enrichResult.company, enrichResult.company_domain)
              }
            } else {
              company = enrichResult.company
              companyDomain = enrichResult.company_domain
              companyConfidence = 0.95
            }
          } else if (enrichResult.company_domain) {
            companyDomain = enrichResult.company_domain
          }

          if (enrichResult.title) { providerTitle = enrichResult.title; titleVerified = true }

          try {
            const earlyEmailStatus = enrichResult.work_email ? 'found' : enrichResult.personal_email ? 'uncertain' : 'not_found'
            await db.from('saved_profiles').upsert({
              user_id: user.id, linkedin_url: linkedinUrl,
              full_name: enrichResult.full_name || fullName || null,
              work_email: enrichResult.work_email || null,
              personal_email: enrichResult.personal_email || null,
              title: enrichResult.title || null,
              company: enrichResult.company || companyHint || null,
              title_verified: !!enrichResult.title,
              email_status: earlyEmailStatus,
              raw_data: enrichResult.raw,
              enriched_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id,linkedin_url', ignoreDuplicates: false })
          } catch (e) { console.error('early upsert failed (non-fatal):', e) }

          sources.push({ type: 'fullenrich_v2', label: 'LinkedIn URL enrichment', confidence: 0.95 })
          return { status: enrichResult.full_name || enrichResult.work_email || enrichResult.personal_email ? 'OK' : 'MISS', meta: { email: maskEmail(selectedEmail) } }
        } catch (e: any) {
          enrichRaw    = { error: String(e?.message || e) }
          enrichStatus = 500
          sources.push({ type: 'fullenrich_v2', label: 'Enrichment unavailable', confidence: 0 })
          return { status: 'FAIL', reason: String(e?.message || e) }
        } finally {
          try {
            await db.from('enrichment_debug_logs').insert({
              user_id: user.id, provider: 'fullenrich_v2',
              request_payload: { linkedin_url: linkedinUrl, company_hint: companyHint, correlation_id: correlationId },
              response_payload: enrichRaw,
              status_code: enrichStatus,
            })
          } catch {}
        }
      })

      // Only retry if FullEnrich gave us genuinely new signal it didn't have before:
      // a different name or domain. If FullEnrich already returned an email, no retry needed.
      const currentDomain = companyDomain || emailDomain
      const fullenrichGaveNewName   = !!(fullName   && fullName   !== nameBeforeFullenrich)
      const fullenrichGaveNewDomain = !!(currentDomain && currentDomain !== domainBeforeFullenrich)
      const shouldRetry = !work_email && !fullenrichReturnedEmail
        && fullName && hasUsableWaterfallName(fullName)
        && (fullenrichGaveNewName || fullenrichGaveNewDomain)

      if (shouldRetry) {
        await step('post_fullenrich_retry', async () => {
          console.log(`[post_fullenrich_retry] retrying with name="${fullName}" domain="${currentDomain}" (new_name=${fullenrichGaveNewName} new_domain=${fullenrichGaveNewDomain})`)
          // Prefix all inner step names with retry_ so they're distinguishable in logs
          const retryStep: typeof step = async (name, fn) => step(`retry_${name}`, fn)
          const retry = await runEmailWaterfall({
            fullName,
            companyName: company,
            knownDomain: currentDomain,
            companySize: null,
            linkedinUrl: linkedinUrl || null,
            anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey,
            openaiKey, deepseekKey, geminiKey,
            db,
            step: retryStep,
          })
          if (!retry.email) return { status: 'MISS', reason: 'no_email', meta: { source: retry.source, new_name: fullenrichGaveNewName, new_domain: fullenrichGaveNewDomain } }
          work_email = retry.email
          personal_email = null
          selectedEmail = retry.email
          emailStatus = retry.emailStatus
          emailDomain = retry.domain || retry.email.split('@')[1] || null
          waterfallSource = retry.source
          if (retry.title) { providerTitle = retry.title; titleVerified = true }
          sources.push({ type: retry.source, label: `Email via ${retry.source} after name resolution`, confidence: 0.9 })
          return { status: 'OK', meta: { email: maskEmail(retry.email), source: retry.source } }
        })
      }
    } else {
      await step('fullenrich_v2', async () => ({ status: 'SKIP', reason: `email_found_via_${waterfallSource}` }))
    }

    if (!fullName) {
      // Credit was deducted up-front but we could not identify the person — refund it.
      await refundCredit(db, user.id, 'not_enough_data_no_name')
      return json({ error: { code: 'NOT_ENOUGH_DATA', message: 'Could not identify this person. Try again or check the LinkedIn profile URL. No lookup credit was charged.' }, debug: { correlationId, records } }, 422)
    }

    if (emailDomain && !company) {
      try {
        const emp = await resolveEmployer(emailDomain, db, anthropicKey)
        company = emp.company; companyConfidence = emp.confidence
        sources.push({ type: 'domain_lookup', label: 'Company from email domain', confidence: emp.confidence })
      } catch (e) { console.error('Employer resolution failed:', e) }
    }

    if (companyDomain && !company) {
      try {
        const emp = await resolveEmployer(companyDomain, db, anthropicKey)
        company = emp.company; companyConfidence = emp.confidence
        sources.push({ type: 'domain_lookup', label: 'Company from profile domain', confidence: emp.confidence })
      } catch (e) { console.error('Company domain resolution failed:', e) }
    }

    let title: string | null = providerTitle
    let titleConfidence = providerTitle ? 0.90 : 0

    if (!title && company && anthropicKey) {
      try {
        const fbResult = await step('title_infer', async () => {
          const f = await inferTitleFallback(fullName, company!, anthropicKey)
          return { status: f.title ? 'OK' : 'MISS', result: f, meta: { confidence: f.confidence } }
        })
        const fallback = fbResult.result as { title: string | null; confidence: number } | undefined
        if (fallback?.title && fallback.confidence >= 0.25) {
          title = fallback.title; titleConfidence = fallback.confidence; titleVerified = false
          sources.push({ type: 'claude_inference', label: 'Title inferred (unverified)', confidence: fallback.confidence })
        }
      } catch (e) { console.error('Title fallback failed:', e) }
    }

    const draftConfidence = computeDraftConfidence(
      personConfidence, companyConfidence, titleConfidence,
      emailStatus, (userContext || '').length
    )

    let status: 'success' | 'partial' | 'not_enough_data' = 'success'
    if (!selectedEmail && !company) status = 'not_enough_data'
    else if (!selectedEmail || titleConfidence < 0.3) status = 'partial'

    // The credit was deducted up-front (before the waterfall). If the run produced
    // neither an email nor a company, the user got nothing usable — refund it.
    if (status === 'not_enough_data') {
      await refundCredit(db, user.id, 'not_enough_data_result')
    }

    let draft: { subject: string; body: string } | null = null
    if (status !== 'not_enough_data' && anthropicKey) {
      try {
        const r = await step('sonnet_draft', async () => {
          const d = await generateDraft(
            fullName, company, title, titleVerified,
            selectedEmail, userContext,
            draftConfidence, anthropicKey,
            recruiterProfile,
            outreachType,
            sessionTone,
          )
          return { status: d ? 'OK' : 'MISS', result: d, meta: { confidence: draftConfidence } }
        })
        draft = (r.result as any) || null
      } catch (e) { console.error('Draft generation failed:', e) }
    }

    if (!draft && status !== 'not_enough_data') {
      return json({ error: { code: 'DRAFT_GENERATION_FAILED', message: 'Contact details were found, but the draft could not be generated.' }, debug: { correlationId, records } }, 500)
    }

    try { await db.rpc('increment_ai_run', { p_user_id: user.id }) } catch (e) { console.error('increment_ai_run RPC failed (non-fatal):', e) }

    let runId: string | null = null
    try {
      const { data: run } = await db.from('outreach_runs').insert({
        user_id: user.id, full_name: fullName, company: company || null,
        title: title || null, email: work_email || null, email_status: emailStatus,
        person_confidence: personConfidence, company_confidence: companyConfidence,
        title_confidence: titleConfidence, draft_confidence: draftConfidence,
        user_context: userContext, company_hint: companyHint,
        draft_subject: draft?.subject || null, draft_body: draft?.body || null,
        status, sources,
      }).select('id').single()
      runId = run?.id ?? null
    } catch (e) { console.error('outreach_runs insert failed (non-fatal):', e) }

    let isBookmarked = false
    try {
      await db.from('saved_profiles').upsert({
        user_id: user.id, linkedin_url: linkedinUrl, full_name: fullName,
        work_email: work_email || null, personal_email: personal_email || null,
        title: title || null, company: company || null, title_verified: titleVerified,
        email_status: emailStatus, enriched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), raw_data: rawDataPayload || null,
      }, { onConflict: 'user_id,linkedin_url', ignoreDuplicates: false })

      const { data: savedRow } = await db.from('saved_profiles')
        .select('is_bookmarked')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .maybeSingle()
      isBookmarked = savedRow?.is_bookmarked ?? false
    } catch (e) { console.error('saved_profiles upsert failed (non-fatal):', e) }

    // ── End-of-run summary (one-line diagnostic) ────────────────────────────────
    try {
      const keysMissing = [
        !googleKey          && 'google',
        !googleCx           && 'google_cx',
        !myEmailVerifierKey && 'mev',
        !braveKey           && 'brave',
        !pdlKey             && 'pdl',
        !fullenrichKey      && 'fullenrich',
        !anthropicKey       && 'anthropic',
      ].filter(Boolean)
      const usedFullenrich = sources.some((s: any) => s?.type === 'fullenrich_v2')
      const reason = !fullName
        ? 'no_full_name_to_run_waterfall'
        : waterfallSource === 'none' && usedFullenrich
          ? 'waterfall_ran_but_no_verified_email'
          : waterfallSource !== 'none'
            ? `waterfall_hit_${waterfallSource}`
            : 'unknown'
      console.log('[enrich summary]', JSON.stringify({
        correlationId,
        version: FUNCTION_VERSION,
        had_full_name_hint: !!fullNameHint,
        had_full_name_at_waterfall: !!fullName,
        waterfall_source: waterfallSource,
        used_fullenrich: usedFullenrich,
        email_status: emailStatus,
        keys_missing: keysMissing,
        reason,
      }))
    } catch (e) { console.error('[enrich summary] log failed (non-fatal):', e) }

    return json({
      status, fromCache: false, isBookmarked, runId,
      person: {
        fullName, company: company || null, title: title || null, titleVerified,
        email: selectedEmail || null, workEmail: work_email || null,
        personalEmail: personal_email || null, emailStatus,
        emailSource: waterfallSource,
        phones: waterfallPhones,
      },
      confidence: { personConfidence, companyConfidence, titleConfidence, draftConfidence },
      sources,
      draft: draft || null,
      debug: { correlationId, records },
    })

  } catch (e: any) {
    console.error('enrich-and-draft error:', String(e?.message || e), e?.stack || '')
    return json({ error: { code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' } }, 500)
  }
})

// ── Helper: increment a campaign aggregate count ──────────────────────────────
async function _incrementCampaignCount(db: any, campaignId: string, field: string) {
  // Use an RPC for an atomic increment so concurrent enrichments don't race.
  // Falls back to a read-modify-write if the RPC is not deployed yet (fail-open).
  try {
    const { error } = await db.rpc('increment_campaign_count', { p_campaign_id: campaignId, p_field: field })
    if (!error) return
    // RPC not available or failed — fall back to non-atomic increment with a warning.
    console.warn(`[_incrementCampaignCount] RPC failed (${error.message}), falling back to read-modify-write`)
    const { data: camp } = await db.from('campaigns').select(field).eq('id', campaignId).maybeSingle()
    if (camp) {
      await db.from('campaigns').update({
        [field]: (camp[field] || 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq('id', campaignId)
    }
  } catch (e) { console.error(`_incrementCampaignCount(${field}) failed:`, e) }
}
````
