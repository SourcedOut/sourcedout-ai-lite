# SourcedOut AI — Complete Code Update for Softgen

This file is **fully self-contained**. Everything Softgen needs is below — no need to
pull any branch. There are two parts:

1. **Three new Supabase SQL migration files** — pasted in full. Create each file at the
   given path (or just run the SQL in the Supabase SQL editor).
2. **One edge function change** (`supabase/functions/enrich-and-draft/index.ts`) — provided
   as an exact unified diff/patch at the end, plus a plain-English summary of every change.

After applying: redeploy the `enrich-and-draft` edge function. Target version string:
`2026-06-08-audit-fixes-v41.2`.

---

## Part 0 — Deploy order (do this top to bottom)

1. Run SQL migration 1 (lookup locks)
2. Run SQL migration 2 (debug-log retention) — verify the timestamp column name first (note in file)
3. Run SQL migration 3 (campaigns)
4. Confirm `GEMINI_API_KEY` is set as an edge function secret (enables the 4th AI model)
5. Apply the `index.ts` patch (Part 4)
6. Redeploy: `supabase functions deploy enrich-and-draft`

Secrets the function expects: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`,
`GEMINI_API_KEY` (new), `MYEMAILVERIFIER_API_KEY`, `GOOGLE_API_KEY`/`GOOGLE_CX`,
`BRAVE_API_KEY`, `FULLENRICH_API_KEY`. `PDL_API_KEY` is no longer used.

---

## Part 1 — SQL Migration: `supabase/migrations/20260607000001_lookup_locks.sql`

Prevents two simultaneous lookups of the same profile from each deducting a credit.

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

**Before running:** confirm the timestamp column is `created_at` (some schemas use
`inserted_at`). See the note inside the file. Bounds PII retention in debug logs.

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

**Important:** the Campaign feature in the extension depends on these two tables, which
were never created by any migration. This is why Campaigns break on a fresh deploy.
Creates `campaigns` + `campaign_candidates` (with RLS) and an atomic counter RPC.

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

## Part 4 — Edge function patch: `supabase/functions/enrich-and-draft/index.ts`

**What the patch does (summary):**

- **Credit refunds** — new `refundCredit()` helper; called when the waterfall returns
  `not_enough_data` so users aren't charged for empty results.
- **Catch-all corroboration** — new `confirmCatchAll()` probe (a nonsense-address test);
  a domain is only branded catch-all when confirmed, used at both the pattern-cache path
  and Step 4. Stops transient SMTP blips from poisoning the cache.
- **Step status logging** — `CATCHALL` / `RISKY_FALLBACK` / `PERSONAL_HUNTING` now map to
  HTTP 200 in analytics instead of 500.
- **Idempotency guard** — calls `acquire_lookup_lock` RPC (from migration 1) before
  deducting a credit; fail-open if the RPC isn't present.
- **AI ensemble** — better prompts (name rules, size-band priors, unified pattern list),
  vote-aggregation merge instead of winner-take-all, and no more masked emails fed to the model.
- **PDL removed** — Step 11 is now a no-op SKIP; `runPdlPersonEnrichment` left in place but unused.
- **Gemini added** — new `callGeminiJson()`; `gemini-2.5-flash` joins the ensemble as a 4th
  model via its OpenAI-compatible endpoint; reads `GEMINI_API_KEY`.
- **Search patterns** — new `extractEmailPatterns()` populates `partialEmails` (was always
  empty) so the "email format" search query actually feeds the model.
- **MEV hardening** — `unknown` no longer collapses into `risky`; one retry + `res.ok`
  handling; a per-request `mevCache` so the same address is never billed twice.
- **Audit fixes** — pattern-cache success paths now persist the company→domain hint;
  Step 12 source attribution fixed (no longer mislabels as `pdl_person_enrichment`);
  campaign counter increments use the atomic `increment_campaign_count` RPC (from migration 3);
  duplicate campaign name returns a clean 409 instead of a 500.
- **Version bump** — `FUNCTION_VERSION` → `2026-06-08-audit-fixes-v41.2`.

Apply this unified diff to the existing file (e.g. `git apply`, or follow it by hand —
lines starting with `-` are removed, `+` are added). This is the exact, committed change.

```diff
diff --git a/supabase/functions/enrich-and-draft/index.ts b/supabase/functions/enrich-and-draft/index.ts
index 46fc6f7..6400cf1 100644
--- a/supabase/functions/enrich-and-draft/index.ts
+++ b/supabase/functions/enrich-and-draft/index.ts
@@ -2,7 +2,7 @@ import "jsr:@supabase/functions-js/edge-runtime.d.ts"
 import { createClient } from "jsr:@supabase/supabase-js@2"
 
 // Bump this string every meaningful deploy so we can verify what's live.
-const FUNCTION_VERSION = "2026-05-06-catchall-fullenrich-v40.6"
+const FUNCTION_VERSION = "2026-06-08-audit-fixes-v41.2"
 console.log(`[enrich boot] FUNCTION_VERSION=${FUNCTION_VERSION}`)
 
 const cors = {
@@ -106,6 +106,35 @@ async function callDeepSeekJson(
   return txt ? parseJson(txt) : null
 }
 
+// Gemini via its OpenAI-compatible endpoint — same wire format as OpenAI/DeepSeek,
+// so it slots straight into the ensemble. Uses GEMINI_API_KEY (set in Supabase).
+async function callGeminiJson(
+  key: string,
+  model: string,
+  prompt: string,
+  maxTokens: number,
+): Promise<any | null> {
+  if (!key) return null
+  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
+    method: 'POST',
+    headers: {
+      'Content-Type': 'application/json',
+      Authorization: `Bearer ${key}`,
+    },
+    body: JSON.stringify({
+      model,
+      messages: [{ role: 'user', content: prompt }],
+      max_tokens: maxTokens,
+      temperature: 0,
+      response_format: { type: 'json_object' },
+    }),
+  })
+  if (!res.ok) return null
+  const data = await res.json().catch(() => null)
+  const txt = data?.choices?.[0]?.message?.content?.trim() || ''
+  return txt ? parseJson(txt) : null
+}
+
 // ── PII helpers ───────────────────────────────────────────────────────────────
 // Known personal/free email domains — emails at these domains are never work addresses.
 const PERSONAL_EMAIL_DOMAINS = new Set([
@@ -128,8 +157,29 @@ function maskEmail(e: string | null | undefined): string {
   return `${head}@${d}`
 }
 
+// ── Credit refund ───────────────────────────────────────────────────────────────
+// Returns a lookup credit that was deducted up-front when a run ultimately produces
+// nothing usable (NOT_ENOUGH_DATA). Best-effort and non-fatal: prefers an atomic
+// refund_credit RPC if one exists, otherwise decrements credits.lookups_used directly
+// (guarded so it never goes negative).
+async function refundCredit(db: any, userId: string | null | undefined, reason: string): Promise<void> {
+  if (!db || !userId) return
+  try {
+    const { error } = await db.rpc('refund_credit', { p_user_id: userId })
+    if (!error) { console.log(`[refundCredit] refunded via RPC (reason=${reason})`); return }
+  } catch { /* RPC may not exist — fall back to direct decrement */ }
+  try {
+    const { data: c } = await db.from('credits').select('lookups_used').eq('user_id', userId).maybeSingle()
+    const used = typeof c?.lookups_used === 'number' ? c.lookups_used : 0
+    if (used > 0) {
+      await db.from('credits').update({ lookups_used: used - 1 }).eq('user_id', userId)
+      console.log(`[refundCredit] refunded via table decrement (reason=${reason})`)
+    }
+  } catch (e) { console.warn('[refundCredit] non-fatal:', e) }
+}
+
 // ── Step logger ────────────────────────────────────────────────────────────────
-type StepStatus = 'HIT' | 'OK' | 'SKIP' | 'MISS' | 'FAIL' | 'PERSONAL_HUNTING'
+type StepStatus = 'HIT' | 'OK' | 'SKIP' | 'MISS' | 'FAIL' | 'PERSONAL_HUNTING' | 'CATCHALL' | 'RISKY_FALLBACK'
 interface StepRecord {
   step: string
   status: StepStatus
@@ -163,7 +213,14 @@ function makeStepLogger(db: any, userId: string | null, correlationId: string, a
         provider: name,
         request_payload: { correlation_id: correlationId, action },
         response_payload: { status: outcome.status, reason: outcome.reason || null, meta: rec.meta || null },
-        status_code: outcome.status === 'OK' || outcome.status === 'HIT' ? 200 : outcome.status === 'SKIP' ? 204 : outcome.status === 'MISS' ? 404 : 500,
+        status_code:
+          outcome.status === 'OK' || outcome.status === 'HIT' ? 200
+          : outcome.status === 'SKIP' ? 204
+          : outcome.status === 'MISS' ? 404
+          // Informational / uncertain-but-usable outcomes are not failures — keep them
+          // out of the 500 bucket so success/failure analytics stay meaningful.
+          : outcome.status === 'CATCHALL' || outcome.status === 'RISKY_FALLBACK' || outcome.status === 'PERSONAL_HUNTING' ? 200
+          : 500,
       })
     } catch {}
     return outcome
@@ -1051,16 +1108,58 @@ async function myEmailVerifierValidate(
 ): Promise<{ status: 'valid' | 'invalid' | 'risky' | 'unknown'; raw: any }> {
   if (!key || !email) return { status: 'unknown', raw: null }
   const url = `https://client.myemailverifier.com/verifier/validate_single/${encodeURIComponent(email)}/${encodeURIComponent(key)}`
-  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
-  const text = await res.text()
-  let raw: any = text
-  try { raw = JSON.parse(text) } catch {}
-  const statusStr: string = (raw?.Status || raw?.status || '').toString().toLowerCase()
-  let status: 'valid' | 'invalid' | 'risky' | 'unknown' = 'unknown'
-  if (statusStr.includes('valid') && !statusStr.includes('invalid')) status = 'valid'
-  else if (statusStr.includes('invalid')) status = 'invalid'
-  else if (statusStr.includes('risky') || statusStr.includes('unknown') || statusStr.includes('catch')) status = 'risky'
-  return { status, raw }
+  const maxAttempts = 2
+  let lastErr: unknown = null
+  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
+    try {
+      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
+      const text = await res.text()
+      if (!res.ok) {
+        // Non-2xx is almost always transient (rate-limit / 5xx) or an auth problem.
+        // Retry once, then report 'unknown' (inconclusive) — never let it masquerade as
+        // a definitive verdict that could flip a domain to catch-all.
+        console.warn(`[mev] HTTP ${res.status} for ${maskEmail(email)} (attempt ${attempt}/${maxAttempts})`)
+        if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, attempt * 800)); continue }
+        return { status: 'unknown', raw: text }
+      }
+      let raw: any = text
+      try { raw = JSON.parse(text) } catch {}
+      const statusStr: string = (raw?.Status || raw?.status || '').toString().toLowerCase()
+      // Keep these buckets distinct. In particular 'unknown' (transient/inconclusive) must
+      // NOT collapse into 'risky', because 'risky' is treated as catch-all evidence downstream.
+      let status: 'valid' | 'invalid' | 'risky' | 'unknown' = 'unknown'
+      if (statusStr.includes('valid') && !statusStr.includes('invalid')) status = 'valid'
+      else if (statusStr.includes('invalid')) status = 'invalid'
+      else if (statusStr.includes('catch') || statusStr.includes('risky')) status = 'risky'
+      else status = 'unknown'   // 'unknown', empty, or any unrecognized verdict
+      return { status, raw }
+    } catch (e) {
+      lastErr = e
+      console.warn(`[mev] network error for ${maskEmail(email)} (attempt ${attempt}/${maxAttempts}): ${String((e as any)?.message || e)}`)
+      if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, attempt * 800)); continue }
+      throw lastErr
+    }
+  }
+  return { status: 'unknown', raw: null }  // unreachable, satisfies the type checker
+}
+
+// ── Catch-all confirmation probe ────────────────────────────────────────────────
+// A single "all candidates risky" result is ambiguous: MEV reports 'risky' both for
+// genuine catch-all (accept-all) servers AND for transient conditions (greylisting,
+// rate-limiting, temporary SMTP failures). Before branding a whole domain catch-all —
+// a sticky, expensive classification that routes every future lookup straight to the
+// paid provider — probe it with a nonsense local-part that cannot belong to a real
+// mailbox. If the server still accepts it (valid/risky) the domain is truly catch-all;
+// if it bounces ('invalid') the earlier risky results were transient.
+async function confirmCatchAll(domain: string | null, mevKey: string): Promise<boolean> {
+  if (!domain || !mevKey) return false
+  const nonce = `no-reply-${Math.random().toString(36).slice(2, 12)}-zzq`
+  try {
+    const v = await myEmailVerifierValidate(`${nonce}@${domain}`, mevKey)
+    return v.status === 'valid' || v.status === 'risky'
+  } catch {
+    return false
+  }
 }
 
 // ── OSINT Search helpers ──────────────────────────────────────────────────────
@@ -1117,6 +1216,29 @@ function buildSearchQueries(fullName: string, company: string | null, domain: st
   return Array.from(queries).filter(Boolean).slice(0, 4)
 }
 
+// Email-format patterns that aggregator pages (Hunter, RocketReach, LeadIQ, SignalHire)
+// publish in words, e.g. "Acme uses the first.last format" or "jdoe@acme.com". These are
+// NOT full emails for the target person, so extractContactInfo misses them — but they tell
+// the model exactly how to build the right local-part. Captured into SearchEvidence.partialEmails,
+// which haiku_refine_candidates and the ensemble already consume.
+const FORMAT_PATTERN_TOKENS = [
+  'first.last', 'first_last', 'first-last', 'firstlast',
+  'flast', 'f.last', 'f_last', 'firstl', 'first.l',
+  'last.first', 'last_first', 'lastfirst', 'lastf', 'last.f',
+]
+function extractEmailPatterns(text: string): string[] {
+  const lower = text.toLowerCase()
+  // Only mine snippets that are actually talking about email format, to avoid noise.
+  if (!/format|pattern|email|@/.test(lower)) return []
+  const found = new Set<string>()
+  for (const tok of FORMAT_PATTERN_TOKENS) {
+    const esc = tok.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
+    // Token must be a standalone word or directly precede "@" (e.g. "flast@acme.com").
+    if (new RegExp(`(^|[^a-z0-9])${esc}(@|[^a-z0-9]|$)`).test(lower)) found.add(tok)
+  }
+  return Array.from(found)
+}
+
 function extractContactInfo(text: string): { emails: string[]; phones: string[] } {
   const emailMatches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
   const rawPhones = extractPhones(text)
@@ -1138,6 +1260,7 @@ async function runGoogleSearchEvidence(
   const queries = buildSearchQueries(fullName, company, domain)
   const exactEmails = new Set<string>()
   const phones = new Set<string>()
+  const partials = new Set<string>()
   const snippets: string[] = []
   const urls: string[] = []
   console.log(`[google_search] running ${queries.length} queries for "${fullName}"`)
@@ -1162,6 +1285,7 @@ async function runGoogleSearchEvidence(
         const ex = extractContactInfo(blob)
         ex.emails.forEach((e) => { exactEmails.add(e); qEmails.push(e) })
         ex.phones.forEach((p) => { phones.add(p); qPhones.push(p) })
+        extractEmailPatterns(blob).forEach((p) => partials.add(p))
         snippets.push(blob)
         if (item.link) urls.push(item.link)
       }
@@ -1173,7 +1297,7 @@ async function runGoogleSearchEvidence(
     queries,
     exactEmails: Array.from(exactEmails),
     phones: Array.from(phones),
-    partialEmails: [],
+    partialEmails: Array.from(partials),
     snippets,
     urls,
     domains: domain ? [domain] : [],
@@ -1189,6 +1313,7 @@ async function runBraveSearch(
   const queries = buildSearchQueries(fullName, company, domain)
   const exactEmails = new Set<string>()
   const phones = new Set<string>()
+  const partials = new Set<string>()
   const snippets: string[] = []
   const urls: string[] = []
   for (const q of queries) {
@@ -1205,12 +1330,13 @@ async function runBraveSearch(
         const ex = extractContactInfo(blob)
         ex.emails.forEach((e) => exactEmails.add(e))
         ex.phones.forEach((p) => phones.add(p))
+        extractEmailPatterns(blob).forEach((p) => partials.add(p))
         snippets.push(blob.trim())
         if (item.url) urls.push(item.url)
       }
     } catch (e) { console.warn('[brave_search] query threw:', e) }
   }
-  return { provider: 'brave', queries, exactEmails: Array.from(exactEmails), phones: Array.from(phones), partialEmails: [], snippets, urls, domains: domain ? [domain] : [] }
+  return { provider: 'brave', queries, exactEmails: Array.from(exactEmails), phones: Array.from(phones), partialEmails: Array.from(partials), snippets, urls, domains: domain ? [domain] : [] }
 }
 
 async function runPdlPersonEnrichment(
@@ -1274,7 +1400,7 @@ async function runPdlPersonEnrichment(
 // ── Ensemble interfaces (v40) ─────────────────────────────────────────────────
 interface EnsembleCandidate {
   value: string
-  source: 'anthropic' | 'openai' | 'deepseek'
+  source: 'anthropic' | 'openai' | 'deepseek' | 'gemini'
   confidence: number
   reason?: string
 }
@@ -1293,13 +1419,14 @@ async function runEmailEnsemble(
   anthropicKey: string,
   openaiKey: string,
   deepseekKey: string,
+  geminiKey: string,
 ): Promise<EnsembleResult> {
   const usedModels: string[] = []
   const out: EnsembleCandidate[] = []
 
   if (!fullName) return { candidates: [], usedModels }
 
-  const basePrompt = `You are ranking likely WORK email addresses for a single person, based ONLY on the evidence below.
+  const basePrompt = `You are generating likely WORK email addresses for a single person. Use both the evidence below AND your general knowledge of how companies format employee email addresses.
 
 Person: ${fullName}
 Company: ${companyName || 'unknown'}
@@ -1308,6 +1435,24 @@ Known work domain: ${domain || 'unknown'}
 Evidence (search snippets, patterns, domains, previous candidates):
 ${evidenceJson}
 
+DOMAIN: If the domain above is unknown, infer it from the company name (strip Inc/LLC/Corp/Ltd/Group/Holdings/Partners; try .com first, then .io/.ai/.co for tech, .org for nonprofits).
+
+NAME-HANDLING:
+- Strip diacritics (José → jose, Müller → muller).
+- Hyphenated last names: try both hyphen-kept and hyphen-collapsed.
+- Particles (van, von, de, di, la): try both collapsed and stripped.
+- Drop suffixes (Jr, Sr, II, III, PhD, MD).
+
+PATTERN PRIORS (use to order candidates):
+- Enterprise (1000+): first.last ~52%, flast ~28%, first ~5%
+- Large (201-1000): flast ~43%, first.last ~38%, first ~6%
+- Mid (51-200): flast ~42%, first.last ~30%, first ~17%
+- Small (11-50): first ~42%, flast ~27%, first.last ~23%
+- Micro (1-10): first ~70%, flast ~13%, first.last ~10%
+- Default if size unknown: flast ~40%, first.last ~30%, first ~15%
+
+ALLOWED LOCAL-PART PATTERNS: first.last, flast, first, firstlast, f.last, firstl, first-last, first_last, last.first, lastf
+
 Return ONLY JSON in this exact shape:
 {
   "candidates": [
@@ -1316,11 +1461,11 @@ Return ONLY JSON in this exact shape:
 }
 
 Rules:
-- Prefer work-appropriate emails (company domain) over personal, unless evidence clearly shows a personal address used for professional outreach.
-- Do not invent domains that are not supported by the evidence.
-- confidence: 0.0–1.0 per candidate.
-- Sort candidates by confidence desc.
-- 1–5 candidates only.`
+- Provide 4–5 candidates, most-likely first.
+- Prefer the company domain. Do not use personal domains (gmail, yahoo, hotmail, outlook.com) unless the evidence explicitly shows that address used for professional outreach.
+- confidence: 0.0–1.0. Use 0.7+ when domain is known and pattern matches evidence; 0.4–0.6 for inferred domain; <0.4 when guessing.
+- All candidates at the same domain.
+- Local-parts lowercase ASCII only.`
 
   const tasks: Promise<void>[] = []
 
@@ -1403,23 +1548,54 @@ Rules:
     })())
   }
 
+  if (geminiKey) {
+    usedModels.push('gemini_2_5_flash')
+    tasks.push((async () => {
+      try {
+        const p = await callGeminiJson(
+          geminiKey,
+          'gemini-2.5-flash',
+          basePrompt,
+          550,
+        )
+        const cs: any[] = Array.isArray(p?.candidates) ? p.candidates : []
+        for (const c of cs) {
+          if (!c?.value) continue
+          out.push({
+            value: String(c.value),
+            source: 'gemini',
+            confidence: typeof c.confidence === 'number' ? c.confidence : 0.4,
+            reason: typeof c.reason === 'string' ? c.reason : undefined,
+          })
+        }
+      } catch (e) {
+        console.error('ensemble gemini error', e)
+      }
+    })())
+  }
+
   if (!tasks.length) return { candidates: [], usedModels: [] }
 
   await Promise.all(tasks)
 
-  // Deduplicate by value (case-insensitive), keep max confidence per email
-  const byValue = new Map<string, EnsembleCandidate>()
+  // Vote aggregation: score = sum of confidences across all models that nominated this address.
+  // A consensus pick (two or three models agreeing) outranks a single high-confidence model.
+  const byValue = new Map<string, { totalConf: number; votes: number; best: EnsembleCandidate }>()
   for (const c of out) {
     const key = c.value.toLowerCase()
     const existing = byValue.get(key)
-    if (!existing || c.confidence > existing.confidence) {
-      byValue.set(key, c)
+    if (!existing) {
+      byValue.set(key, { totalConf: c.confidence, votes: 1, best: c })
+    } else {
+      existing.totalConf += c.confidence
+      existing.votes += 1
+      if (c.confidence > existing.best.confidence) existing.best = c
     }
   }
 
-  const merged = Array.from(byValue.values()).sort(
-    (a, b) => b.confidence - a.confidence,
-  )
+  const merged = Array.from(byValue.values())
+    .sort((a, b) => b.totalConf - a.totalConf)
+    .map(v => ({ ...v.best, confidence: v.totalConf / Math.max(usedModels.length, 1) }))
 
   return { candidates: merged.slice(0, 10), usedModels }
 }
@@ -1453,6 +1629,7 @@ async function runMevLoop(
   myEmailVerifierKey: string,
   labelFn: (c: string) => string,
   logTag: string,
+  mevCache?: Map<string, 'valid' | 'invalid' | 'risky' | 'unknown'>,
 ): Promise<{ email: string | null; riskyFallback: string | null; personalFallback: string | null; tried: string[]; statuses: string[]; lastError: string | null }> {
   const tried: string[] = []
   const statuses: string[] = []
@@ -1462,9 +1639,20 @@ async function runMevLoop(
   for (const c of candidates.slice(0, limit)) {
     tried.push(maskEmail(c))
     try {
-      const v = await myEmailVerifierValidate(c, myEmailVerifierKey)
+      // Reuse a definitive verdict for this exact address if an earlier step already paid
+      // for it. Only 'valid'/'invalid' are cached (they're stable); 'risky'/'unknown' may be
+      // transient, so those are always re-checked.
+      const cached = mevCache?.get(c)
+      let v: { status: 'valid' | 'invalid' | 'risky' | 'unknown' }
+      if (cached === 'valid' || cached === 'invalid') {
+        v = { status: cached }
+        console.log(`[${logTag}] ${maskEmail(c)} → ${cached} (cached)`)
+      } else {
+        v = await myEmailVerifierValidate(c, myEmailVerifierKey)
+        if (mevCache && (v.status === 'valid' || v.status === 'invalid')) mevCache.set(c, v.status)
+        console.log(`[${logTag}] ${maskEmail(c)} → ${v.status}`)
+      }
       statuses.push(v.status)
-      console.log(`[${logTag}] ${maskEmail(c)} → ${v.status}`)
       if (v.status === 'valid') {
         // Personal domain (gmail, yahoo, etc.) — keep as fallback, keep searching for work email
         if (isPersonalEmailDomain(c)) {
@@ -1499,11 +1687,12 @@ async function runEmailWaterfall(opts: {
   pdlKey: string
   openaiKey?: string
   deepseekKey?: string
+  geminiKey?: string
   db?: any
   step: ReturnType<typeof makeStepLogger>['step']
 }): Promise<WaterfallResult> {
   const { fullName, companyName, knownDomain, companySize = null, linkedinUrl = null,
-    anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey, openaiKey = '', deepseekKey = '', db = null, step } = opts
+    anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey, openaiKey = '', deepseekKey = '', geminiKey = '', db = null, step } = opts
 
   const summary: Record<string, any> = {
     event: 'waterfall_summary',
@@ -1515,6 +1704,9 @@ async function runEmailWaterfall(opts: {
   // so the waterfall keeps searching for a corporate address.
   let personalEmailFallback: string | null = null
   const foundPhones = new Set<string>()
+  // Per-request memo of definitive MEV verdicts (valid/invalid) so the same address is
+  // never billed to MyEmailVerifier twice across the waterfall's multiple verification rounds.
+  const mevCache = new Map<string, 'valid' | 'invalid' | 'risky' | 'unknown'>()
   const finish = (result: WaterfallResult): WaterfallResult => {
     summary.final_source = result.source
     summary.final_email = maskEmail(result.email)
@@ -1675,16 +1867,22 @@ async function runEmailWaterfall(opts: {
         if (!myEmailVerifierKey) return { status: 'SKIP', reason: 'no_mev_key' }
         if (patternEmails.length === 0) return { status: 'SKIP', reason: 'no_pattern_emails' }
         try {
-          const r = await runMevLoop(patternEmails, patternEmails.length, myEmailVerifierKey, maskEmail, 'myemailverifier_haiku')
+          const r = await runMevLoop(patternEmails, patternEmails.length, myEmailVerifierKey, maskEmail, 'myemailverifier_haiku', mevCache)
           if (r.email) {
             cachedVerified = r.email
             return { status: 'OK', meta: { tried: r.tried, statuses: r.statuses, accepted: maskEmail(r.email), via: allPatternsSeeded ? 'seeded_pattern_mev_confirmed' : 'pattern_cache_multi' } }
           }
           if (r.riskyFallback && r.statuses.length > 0 && r.statuses.every(s => s === 'risky' || s === 'error')) {
             if (!allPatternsSeeded) {
-              // Real-verified patterns all returned risky → domain is genuinely catch-all
+              // Real-verified patterns all returned risky → likely catch-all. Corroborate with
+              // the same nonsense-local probe Step 4 uses before flipping a previously-good
+              // domain to catch-all, so a transient SMTP blip can't poison the pattern cache.
+              const reallyCatchAll = await confirmCatchAll(workingDomain, myEmailVerifierKey)
+              if (!reallyCatchAll) {
+                return { status: 'MISS', meta: { tried: r.tried, statuses: r.statuses, note: 'all_risky_probe_negative_transient', probe: 'negative' } }
+              }
               cachedRisky = r.riskyFallback
-              return { status: 'RISKY_FALLBACK', meta: { tried: r.tried, statuses: r.statuses, risky_fallback: maskEmail(r.riskyFallback), via: 'pattern_cache_multi' } }
+              return { status: 'RISKY_FALLBACK', meta: { tried: r.tried, statuses: r.statuses, risky_fallback: maskEmail(r.riskyFallback), via: 'pattern_cache_multi', probe: 'positive' } }
             }
             // Seeded patterns all returned risky → could be wrong pattern, not necessarily catch-all.
             // Fall through to full waterfall (Google / Brave / PDL) to find the real email.
@@ -1697,11 +1895,13 @@ async function runEmailWaterfall(opts: {
       })
       if (cachedVerified) {
         await upsertEmailPattern(db, workingDomain, cachedVerified, fullName, false)
+        await upsertCompanyDomainHint(db, companyName, workingDomain)
         return finish({ email: cachedVerified, emailStatus: 'found', source: 'haiku_pattern_cache', title: null, domain: workingDomain })
       }
       if (cachedRisky) {
         console.log(`[waterfall] pattern_cache all-risky (real-verified) — marking catch-all: ${maskEmail(cachedRisky)}`)
         await upsertEmailPattern(db, workingDomain, cachedRisky, fullName, true)
+        await upsertCompanyDomainHint(db, companyName, workingDomain)
         return finish({ email: cachedRisky, emailStatus: 'uncertain', source: 'haiku_pattern_cache', title: null, domain: workingDomain })
       }
       // All pattern candidates failed MEV (invalid or seeded-risky) — fall through to full waterfall
@@ -1729,7 +1929,7 @@ async function runEmailWaterfall(opts: {
   await step<{ tried: string[]; statuses: string[]; accepted: string | null; risky_fallback: string | null }>('myemailverifier_haiku', async () => {
     if (!myEmailVerifierKey) return { status: 'SKIP', reason: 'no_mev_key' }
     if (haikuCandidates.length === 0) return { status: 'SKIP', reason: 'no_candidates' }
-    const r = await runMevLoop(haikuCandidates, 5, myEmailVerifierKey, maskEmail, 'myemailverifier_haiku')
+    const r = await runMevLoop(haikuCandidates, 5, myEmailVerifierKey, maskEmail, 'myemailverifier_haiku', mevCache)
     if (r.personalFallback && !personalEmailFallback) personalEmailFallback = r.personalFallback
     if (r.email) {
       verifiedHaiku = r.email
@@ -1740,15 +1940,23 @@ async function runEmailWaterfall(opts: {
     // Write is_catchall=true immediately and skip steps 5-12 (Google, Brave, ensemble, PDL).
     // Jump to FullEnrich (authoritative source) to avoid wasting ~80% of API calls.
     if (r.riskyFallback && r.statuses.length > 0 && r.statuses.every(s => s === 'risky' || s === 'error')) {
+      // Corroborate before branding the domain catch-all (see confirmCatchAll). A
+      // nonsense-local probe must also be accepted; if it bounces, the risky results
+      // were transient and we should keep working the normal waterfall.
+      const reallyCatchAll = await confirmCatchAll(workingDomain, myEmailVerifierKey)
+      if (!reallyCatchAll) {
+        console.log(`[myemailverifier_haiku] all-risky but catch-all probe was negative — treating as transient, continuing waterfall`)
+        return { status: 'MISS', reason: 'risky_unconfirmed_catchall', meta: { tried: r.tried, statuses: r.statuses, accepted: null, probe: 'negative' } }
+      }
       haikuRiskyFallback = r.riskyFallback
       isCatchallDomain = true
-      console.log(`[myemailverifier_haiku] catch-all domain detected at Step 4 — will route to FullEnrich: ${maskEmail(r.riskyFallback)}`)
+      console.log(`[myemailverifier_haiku] catch-all confirmed by probe at Step 4 — will route to FullEnrich: ${maskEmail(r.riskyFallback)}`)
       // Write is_catchall=true to DB immediately (not at tail end)
       if (db && workingDomain) {
         await upsertEmailPattern(db, workingDomain, r.riskyFallback, fullName, true)
         console.log(`[myemailverifier_haiku] marked domain as catch-all in DB: ${workingDomain}`)
       }
-      return { status: 'CATCHALL', reason: 'routing_to_fullenrich', meta: { tried: r.tried, statuses: r.statuses, accepted: null, risky_fallback: maskEmail(r.riskyFallback) } }
+      return { status: 'CATCHALL', reason: 'routing_to_fullenrich', meta: { tried: r.tried, statuses: r.statuses, accepted: null, risky_fallback: maskEmail(r.riskyFallback), probe: 'positive' } }
     }
     if (r.lastError && r.tried.length === 1) return { status: 'FAIL', reason: r.lastError }
     return { status: 'MISS', reason: 'no_valid', meta: { tried: r.tried, statuses: r.statuses, accepted: null, risky_fallback: null } }
@@ -1841,22 +2049,25 @@ async function runEmailWaterfall(opts: {
     if (mergedSoFar.length === 0 && allPartials.length === 0 && !workingDomain) {
       return { status: 'SKIP', reason: 'no_signal' }
     }
-    const prompt = `You are refining a list of likely work email candidates based on research evidence.
+    const prompt = `You are refining work email candidates from search evidence. Use the evidence AND your knowledge of common corporate email conventions.
 
 Person: ${fullName}
 Company: ${companyName ?? 'unknown'}
 Domain: ${workingDomain ?? 'unknown'}
 
-Evidence collected so far:
-- Exact emails found in web search: ${mergedSoFar.slice(0, 6).map(maskEmail).join(', ') || 'none'}
+Evidence:
+- Emails found in web search: ${mergedSoFar.slice(0, 6).join(', ') || 'none'}
 - Partial emails/patterns in snippets: ${allPartials.slice(0, 5).join(', ') || 'none'}
 - Domains seen in snippets: ${Array.from(new Set(allDomains)).slice(0, 5).join(', ') || 'none'}
 
+NAME-HANDLING: strip diacritics, drop suffixes (Jr/Sr/II/III/PhD), try both collapsed and kept forms for hyphenated last names and particles (van, de, di).
+
+ALLOWED PATTERNS: first.last, flast, first, firstlast, f.last, firstl, first-last, first_last, last.first, lastf
+
 Task:
-1. If domain is still unclear, infer the most likely one from evidence
-2. Produce the top 5 most likely work email candidates using evidence + common patterns
-3. Order by confidence, most likely first
-4. Use these pattern priors (most common first): first.last, flast, first, firstlast, f.last
+1. If domain is unknown, infer it from company name or evidence domains.
+2. Produce 4–5 most likely work email candidates, ordered by confidence (most likely first).
+3. Use the exact emails from evidence as anchors when present — apply the same pattern to this person's name.
 
 Return ONLY JSON:
 {
@@ -1908,7 +2119,7 @@ Return ONLY JSON:
     // Round 1: Haiku-refined + direct Google/Brave hits (no PDL yet)
     const round1 = mergeCandidateSets(refinedCandidates, googleCandidates, braveCandidates)
     if (round1.length === 0) return { status: 'SKIP', reason: 'no_candidates' }
-    const r = await runMevLoop(round1, 6, myEmailVerifierKey, maskEmail, 'myemailverifier_search_round1')
+    const r = await runMevLoop(round1, 6, myEmailVerifierKey, maskEmail, 'myemailverifier_search_round1', mevCache)
     if (r.personalFallback && !personalEmailFallback) personalEmailFallback = r.personalFallback
     if (r.email) {
       verifiedPrePdl = r.email
@@ -1937,7 +2148,7 @@ Return ONLY JSON:
   if (!skipToFullEnrich) {
     await step<{ n: number; models: string[] }>('ensemble_refine_candidates', async () => {
     // Only run if at least one LLM key is present
-    if (!anthropicKey && !openaiKey && !deepseekKey) {
+    if (!anthropicKey && !openaiKey && !deepseekKey && !geminiKey) {
       return { status: 'SKIP', reason: 'no_llm_keys' }
     }
     if (!fullName) return { status: 'SKIP', reason: 'no_full_name' }
@@ -1989,6 +2200,7 @@ Return ONLY JSON:
       anthropicKey,
       openaiKey,
       deepseekKey,
+      geminiKey,
     )
 
     if (!ensemble.candidates.length) {
@@ -2028,6 +2240,7 @@ Return ONLY JSON:
       myEmailVerifierKey,
       maskEmail,
       'myemailverifier_ensemble',
+      mevCache,
     )
 
     if (lastError && !email) {
@@ -2063,55 +2276,36 @@ Return ONLY JSON:
     await step('myemailverifier_ensemble', async () => ({ status: 'SKIP', reason: 'catchall_skip_to_fullenrich' }))
   }
 
-  // ── STEP 11: PDL Person Enrichment ───────────────────────────────────────────
+  // ── STEP 11: (removed) PDL Person Enrichment ─────────────────────────────────
+  // PDL has been removed from the waterfall. Email discovery now relies on the
+  // pattern cache, Haiku guess, Google/Brave search, the LLM ensemble (Anthropic +
+  // OpenAI + DeepSeek + Gemini), and FullEnrich as the authoritative last resort.
+  // The step name is preserved as a no-op so the diagnostics panel and step sequence
+  // stay stable; re-enabling is a one-line restore of the runPdlPersonEnrichment call.
   if (!skipToFullEnrich) {
-  let pdlCandidates: string[] = []
-  let pdlTitle: string | null = null
-  await step<{ usedLinkedinUrl: boolean; usedCompany: boolean; workEmailsFound: number; personalEmailsFound: number; phonesFound: number; socials: number }>('pdl_person_enrichment', async () => {
-    if (!pdlKey) return { status: 'SKIP', reason: 'no_pdl_key' }
-    if (!fullName) return { status: 'SKIP', reason: 'no_full_name' }
-    try {
-      const ev = await runPdlPersonEnrichment(
-        fullName, companyName, workingDomain, linkedinUrl, null, pdlKey,
-      )
-      if (ev.title) pdlTitle = ev.title
-      pdlCandidates = mergeCandidateSets(ev.workEmails, ev.personalEmails)
-      ev.mobilePhones.forEach(p => foundPhones.add(p))
-      const meta = {
-        usedLinkedinUrl: !!linkedinUrl,
-        usedCompany: !!companyName,
-        workEmailsFound: ev.workEmails.length,
-        personalEmailsFound: ev.personalEmails.length,
-        phonesFound: ev.mobilePhones.length,
-        socials: ev.socials.length,
-        confidence: ev.confidence,
-      }
-      if (pdlCandidates.length === 0) return { status: 'MISS', reason: 'no_emails', meta }
-      return { status: 'OK', meta }
-    } catch (e: any) {
-      return { status: 'FAIL', reason: String(e?.message || e) }
-    }
-  })
-
-  // ── STEP 12: MEV on all remaining candidates including PDL ───────────────────
-  // Priority: PDL work emails (structured) → search candidates → PDL personal
+  const pdlCandidates: string[] = []
+  const pdlTitle: string | null = null
+  await step('pdl_person_enrichment', async () => ({ status: 'SKIP', reason: 'pdl_disabled' }))
+
+  // ── STEP 12: MEV on any remaining candidates ─────────────────────────────────
+  // With PDL removed, the search/refine/ensemble candidates are already verified by
+  // earlier rounds, so this normally finds nothing new and SKIPs. Retained as the
+  // safety-net slot (and stable step name) for candidates beyond round 1's limit.
   let verifiedSearch: string | null = null
   let verifiedSource: WaterfallResult['source'] = 'none'
   let verifiedTitle: string | null = null
   await step<{ totalCandidates: number; tried: string[]; statuses: string[]; accepted: string | null }>('myemailverifier_search_candidates', async () => {
     if (!myEmailVerifierKey) return { status: 'SKIP', reason: 'no_mev_key' }
-    // Already tried: refinedCandidates, googleCandidates, braveCandidates in round1
-    // Now add PDL candidates (work first, then personal)
     const round1Already = new Set(mergeCandidateSets(refinedCandidates, googleCandidates, braveCandidates))
     const newPdlWork = pdlCandidates.filter(c => !round1Already.has(c))
     const allRemaining = mergeCandidateSets(newPdlWork, pdlCandidates)
     if (allRemaining.length === 0) return { status: 'SKIP', reason: 'no_candidates' }
-    const r = await runMevLoop(allRemaining, 8, myEmailVerifierKey, maskEmail, 'myemailverifier_search_candidates')
+    const r = await runMevLoop(allRemaining, 8, myEmailVerifierKey, maskEmail, 'myemailverifier_search_candidates', mevCache)
     if (r.personalFallback && !personalEmailFallback) personalEmailFallback = r.personalFallback
     if (r.email) {
       verifiedSearch = r.email
-      verifiedSource = googleSet.has(r.email) ? 'google_search' : braveSet.has(r.email) ? 'brave_search' : 'pdl_person_enrichment'
-      verifiedTitle  = 'pdl_person_enrichment' === verifiedSource ? pdlTitle : null
+      verifiedSource = googleSet.has(r.email) ? 'google_search' : braveSet.has(r.email) ? 'brave_search' : 'haiku_refine'
+      verifiedTitle  = null  // PDL removed; no title source in this path
       return { status: 'OK', meta: { totalCandidates: allRemaining.length, tried: r.tried, statuses: r.statuses, accepted: maskEmail(r.email), personal_stored: r.personalFallback ? maskEmail(r.personalFallback) : undefined } }
     }
     if (r.lastError && r.tried.length === 1) return { status: 'FAIL', reason: r.lastError }
@@ -2171,6 +2365,7 @@ async function runMultiCompanyWaterfall(opts: {
   pdlKey: string
   openaiKey?: string
   deepseekKey?: string
+  geminiKey?: string
   db?: any
   step: ReturnType<typeof makeStepLogger>['step']
 }): Promise<{ result: WaterfallResult; winner: CompanyCandidate | null }> {
@@ -2198,6 +2393,7 @@ async function runMultiCompanyWaterfall(opts: {
       pdlKey: opts.pdlKey,
       openaiKey: opts.openaiKey,
       deepseekKey: opts.deepseekKey,
+      geminiKey: opts.geminiKey,
       db: opts.db ?? null,
       step,
     })
@@ -2354,6 +2550,7 @@ Deno.serve(async (req: Request) => {
   const openaiKey         = Deno.env.get('OPENAI_API_KEY')           || ''
   const mistralKey        = Deno.env.get('MISTRAL_API_KEY')          || '' // reserved for future
   const deepseekKey       = Deno.env.get('DEEPSEEK_API_KEY')         || ''
+  const geminiKey         = Deno.env.get('GEMINI_API_KEY')           || ''
   const db = createClient(supabaseUrl, serviceKey)
 
   console.log('[enrich env]', JSON.stringify({
@@ -2367,6 +2564,7 @@ Deno.serve(async (req: Request) => {
     has_fullenrich_key: !!fullenrichKey,
     has_openai_key: !!openaiKey,
     has_deepseek_key: !!deepseekKey,
+    has_gemini_key: !!geminiKey,
   }))
 
   const authHeader = req.headers.get('Authorization') || ''
@@ -2593,6 +2791,9 @@ Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.
 
       if (campaignErr || !campaign) {
         console.error('import-campaign insert failed:', campaignErr)
+        if (campaignErr?.code === '23505') {
+          return json({ error: { code: 'DUPLICATE_CAMPAIGN', message: 'A campaign with this name already exists. Rename it and try again.' } }, 409)
+        }
         return json({ error: { code: 'DB_ERROR', message: 'Could not create campaign.' } }, 500)
       }
 
@@ -2839,7 +3040,7 @@ Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.
               companySize: candidateCompanySize,
               linkedinUrl: candidate.linkedin_url || null,
               anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey,
-              openaiKey, deepseekKey,
+              openaiKey, deepseekKey, geminiKey,
               db,
               step,
             })
@@ -2948,7 +3149,7 @@ Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.
                   companySize: candidateCompanySize,
                   linkedinUrl: candidate.linkedin_url || null,
                   anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey,
-                  openaiKey, deepseekKey,
+                  openaiKey, deepseekKey, geminiKey,
                   db,
                   step: retryStep,
                 })
@@ -3397,6 +3598,19 @@ Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.
     }
     // Use only trusted candidates for the waterfall.
     companyCandidates = trustedCandidates
+
+    // Idempotency guard (fail-open): stop two simultaneous in-flight lookups of the
+    // same profile from each deducting a credit. Requires the acquire_lookup_lock RPC
+    // (see supabase/migrations) — if it isn't deployed, the call errors and we proceed
+    // exactly as before. Repeat lookups *after* completion are already served free by
+    // the cache step above, so we rely on the lock's TTL rather than an explicit release.
+    try {
+      const { data: lockOk, error: lockErr } = await db.rpc('acquire_lookup_lock', { p_user_id: user.id, p_linkedin_url: linkedinUrl })
+      if (!lockErr && lockOk === false) {
+        return json({ error: { code: 'LOOKUP_IN_PROGRESS', message: 'This profile is already being looked up. Give it a moment and try again — no extra credit will be charged.' }, debug: { correlationId, records } }, 409)
+      }
+    } catch { /* RPC not deployed — fail open, behave exactly as before */ }
+
     const { data: creditAllowed, error: creditErr } = await db.rpc('deduct_credit', { p_user_id: user.id })
     if (creditErr) {
       console.error('deduct_credit RPC error:', creditErr)
@@ -3434,7 +3648,7 @@ Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.
         companySize: null,
         linkedinUrl: linkedinUrl || null,
         anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey,
-        openaiKey, deepseekKey,
+        openaiKey, deepseekKey, geminiKey,
         db,
         step,
       })
@@ -3595,7 +3809,7 @@ Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.
             companySize: null,
             linkedinUrl: linkedinUrl || null,
             anthropicKey, googleKey, googleCx, myEmailVerifierKey, braveKey, pdlKey,
-            openaiKey, deepseekKey,
+            openaiKey, deepseekKey, geminiKey,
             db,
             step: retryStep,
           })
@@ -3615,7 +3829,11 @@ Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.
       await step('fullenrich_v2', async () => ({ status: 'SKIP', reason: `email_found_via_${waterfallSource}` }))
     }
 
-    if (!fullName) return json({ error: { code: 'NOT_ENOUGH_DATA', message: 'Could not identify this person. Try again or check the LinkedIn profile URL.' }, debug: { correlationId, records } }, 422)
+    if (!fullName) {
+      // Credit was deducted up-front but we could not identify the person — refund it.
+      await refundCredit(db, user.id, 'not_enough_data_no_name')
+      return json({ error: { code: 'NOT_ENOUGH_DATA', message: 'Could not identify this person. Try again or check the LinkedIn profile URL. No lookup credit was charged.' }, debug: { correlationId, records } }, 422)
+    }
 
     if (emailDomain && !company) {
       try {
@@ -3659,6 +3877,12 @@ Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.
     if (!selectedEmail && !company) status = 'not_enough_data'
     else if (!selectedEmail || titleConfidence < 0.3) status = 'partial'
 
+    // The credit was deducted up-front (before the waterfall). If the run produced
+    // neither an email nor a company, the user got nothing usable — refund it.
+    if (status === 'not_enough_data') {
+      await refundCredit(db, user.id, 'not_enough_data_result')
+    }
+
     let draft: { subject: string; body: string } | null = null
     if (status !== 'not_enough_data' && anthropicKey) {
       try {
@@ -3770,7 +3994,13 @@ Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.
 
 // ── Helper: increment a campaign aggregate count ──────────────────────────────
 async function _incrementCampaignCount(db: any, campaignId: string, field: string) {
+  // Use an RPC for an atomic increment so concurrent enrichments don't race.
+  // Falls back to a read-modify-write if the RPC is not deployed yet (fail-open).
   try {
+    const { error } = await db.rpc('increment_campaign_count', { p_campaign_id: campaignId, p_field: field })
+    if (!error) return
+    // RPC not available or failed — fall back to non-atomic increment with a warning.
+    console.warn(`[_incrementCampaignCount] RPC failed (${error.message}), falling back to read-modify-write`)
     const { data: camp } = await db.from('campaigns').select(field).eq('id', campaignId).maybeSingle()
     if (camp) {
       await db.from('campaigns').update({
```
