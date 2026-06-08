# SourcedOut AI — Code Changes for Softgen

These are all the changes made to the codebase during the audit session.
Apply them in order. Two files are new SQL migrations; one file is a large TypeScript edit.

---

## File 1: `supabase/functions/enrich-and-draft/index.ts`

### Change 1 — Add `refundCredit()` helper (insert after the `maskEmail` function, around line 131)

```typescript
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
```

---

### Change 2 — Extend `StepStatus` type (find the existing type declaration)

**Find:**
```typescript
type StepStatus = 'HIT' | 'OK' | 'SKIP' | 'MISS' | 'FAIL' | 'PERSONAL_HUNTING'
```

**Replace with:**
```typescript
type StepStatus = 'HIT' | 'OK' | 'SKIP' | 'MISS' | 'FAIL' | 'PERSONAL_HUNTING' | 'CATCHALL' | 'RISKY_FALLBACK'
```

---

### Change 3 — Fix `status_code` mapping in the step logger (inside `makeStepLogger`)

**Find:**
```typescript
status_code: outcome.status === 'OK' || outcome.status === 'HIT' ? 200 : outcome.status === 'SKIP' ? 204 : outcome.status === 'MISS' ? 404 : 500,
```

**Replace with:**
```typescript
status_code:
  outcome.status === 'OK' || outcome.status === 'HIT' ? 200
  : outcome.status === 'SKIP' ? 204
  : outcome.status === 'MISS' ? 404
  // Informational / uncertain-but-usable outcomes are not failures — keep them
  // out of the 500 bucket so success/failure analytics stay meaningful.
  : outcome.status === 'CATCHALL' || outcome.status === 'RISKY_FALLBACK' || outcome.status === 'PERSONAL_HUNTING' ? 200
  : 500,
```

---

### Change 4 — Add `confirmCatchAll()` function (insert after `myEmailVerifierValidate`, before the OSINT Search helpers section)

```typescript
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
```

---

### Change 5 — Use `confirmCatchAll()` before writing catch-all to DB (inside `runEmailWaterfall`, Step 4 block)

**Find:**
```typescript
    if (r.riskyFallback && r.statuses.length > 0 && r.statuses.every(s => s === 'risky' || s === 'error')) {
      haikuRiskyFallback = r.riskyFallback
      isCatchallDomain = true
      console.log(`[myemailverifier_haiku] catch-all domain detected at Step 4 — will route to FullEnrich: ${maskEmail(r.riskyFallback)}`)
      // Write is_catchall=true to DB immediately (not at tail end)
      if (db && workingDomain) {
        await upsertEmailPattern(db, workingDomain, r.riskyFallback, fullName, true)
        console.log(`[myemailverifier_haiku] marked domain as catch-all in DB: ${workingDomain}`)
      }
      return { status: 'CATCHALL', reason: 'routing_to_fullenrich', meta: { tried: r.tried, statuses: r.statuses, accepted: null, risky_fallback: maskEmail(r.riskyFallback) } }
    }
```

**Replace with:**
```typescript
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
```

---

### Change 6 — Improve ensemble prompt (inside `runEmailEnsemble`)

**Find:**
```typescript
  const basePrompt = `You are ranking likely WORK email addresses for a single person, based ONLY on the evidence below.

Person: ${fullName}
Company: ${companyName || 'unknown'}
Known work domain: ${domain || 'unknown'}

Evidence (search snippets, patterns, domains, previous candidates):
${evidenceJson}

Return ONLY JSON in this exact shape:
{
  "candidates": [
    {"value": "email@example.com", "confidence": 0.0, "reason": "short explanation"}
  ]
}

Rules:
- Prefer work-appropriate emails (company domain) over personal, unless evidence clearly shows a personal address used for professional outreach.
- Do not invent domains that are not supported by the evidence.
- confidence: 0.0–1.0 per candidate.
- Sort candidates by confidence desc.
- 1–5 candidates only.`
```

**Replace with:**
```typescript
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
```

---

### Change 7 — Replace ensemble merge with vote aggregation (inside `runEmailEnsemble`, after `Promise.all`)

**Find:**
```typescript
  // Deduplicate by value (case-insensitive), keep max confidence per email
  const byValue = new Map<string, EnsembleCandidate>()
  for (const c of out) {
    const key = c.value.toLowerCase()
    const existing = byValue.get(key)
    if (!existing || c.confidence > existing.confidence) {
      byValue.set(key, c)
    }
  }

  const merged = Array.from(byValue.values()).sort(
    (a, b) => b.confidence - a.confidence,
  )

  return { candidates: merged.slice(0, 10), usedModels }
```

**Replace with:**
```typescript
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
```

---

### Change 8 — Improve `haiku_refine_candidates` prompt (inside the `haiku_refine_candidates` step block in `runEmailWaterfall`)

**Find:**
```typescript
    const prompt = `You are refining a list of likely work email candidates based on research evidence.

Person: ${fullName}
Company: ${companyName ?? 'unknown'}
Domain: ${workingDomain ?? 'unknown'}

Evidence collected so far:
- Exact emails found in web search: ${mergedSoFar.slice(0, 6).map(maskEmail).join(', ') || 'none'}
- Partial emails/patterns in snippets: ${allPartials.slice(0, 5).join(', ') || 'none'}
- Domains seen in snippets: ${Array.from(new Set(allDomains)).slice(0, 5).join(', ') || 'none'}

Task:
1. If domain is still unclear, infer the most likely one from evidence
2. Produce the top 5 most likely work email candidates using evidence + common patterns
3. Order by confidence, most likely first
4. Use these pattern priors (most common first): first.last, flast, first, firstlast, f.last

Return ONLY JSON:
{
  "domain": "example.com or null",
  "candidates": ["a@example.com", "b@example.com"],
  "confidence": 0.0,
  "reasoning": "one short sentence"
}`
```

**Replace with:**
```typescript
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
```

---

### Change 9 — Add idempotency lock guard before `deduct_credit` (inside the main request handler)

Find the block that contains `companyCandidates = trustedCandidates` followed immediately by the `deduct_credit` RPC call. Insert the following block between them:

```typescript
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
```

---

### Change 10 — Refund credit when no name found (find the early-exit `!fullName` check near the bottom of the handler)

**Find:**
```typescript
    if (!fullName) return json({ error: { code: 'NOT_ENOUGH_DATA', message: 'Could not identify this person. Try again or check the LinkedIn profile URL.' }, debug: { correlationId, records } }, 422)
```

**Replace with:**
```typescript
    if (!fullName) {
      // Credit was deducted up-front but we could not identify the person — refund it.
      await refundCredit(db, user.id, 'not_enough_data_no_name')
      return json({ error: { code: 'NOT_ENOUGH_DATA', message: 'Could not identify this person. Try again or check the LinkedIn profile URL. No lookup credit was charged.' }, debug: { correlationId, records } }, 422)
    }
```

---

### Change 11 — Refund credit when waterfall returns nothing usable (find the `status` assignment block near the bottom of the handler)

Find the lines that compute `status` (something like `if (!selectedEmail && !company) status = 'not_enough_data'`). Immediately after those lines, insert:

```typescript
    // The credit was deducted up-front (before the waterfall). If the run produced
    // neither an email nor a company, the user got nothing usable — refund it.
    if (status === 'not_enough_data') {
      await refundCredit(db, user.id, 'not_enough_data_result')
    }
```

---

## File 2: `supabase/migrations/20260607000001_lookup_locks.sql` *(new file)*

Create this file at that exact path with the following content:

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

## File 3: `supabase/migrations/20260607000002_enrichment_debug_logs_retention.sql` *(new file)*

Create this file at that exact path with the following content:

> **Before applying:** run `select column_name from information_schema.columns where table_name = 'enrichment_debug_logs';` in your Supabase SQL editor to confirm the timestamp column is called `created_at`. If it is `inserted_at`, replace every occurrence of `created_at` in this file with `inserted_at`.

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

## Deploy order

1. Apply SQL migration `20260607000001_lookup_locks.sql` (Supabase SQL editor or `supabase db push`)
2. Apply SQL migration `20260607000002_enrichment_debug_logs_retention.sql` (verify column name first — see note above)
3. Redeploy the edge function: `supabase functions deploy enrich-and-draft`
