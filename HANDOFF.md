# SourcedOut AI — Waterfall Audit Handoff

**Branch:** `claude/beautiful-brahmagupta-JU4O0`  
**Date:** 2026-06-07  
**Scope:** `supabase/functions/enrich-and-draft/index.ts` + two new SQL migrations

---

## Commits on this branch

| Hash | Description |
|------|-------------|
| `ef42efd` | P1: credit refunds, catch-all corroboration, step-status logging |
| `5c30d6a` | P1: idempotency lock guard + debug-log retention migration |
| `1cdb64b` | P2: AI ensemble accuracy — prompt quality, vote merge, unmasked evidence |

---

## What was fixed

### P1 #1 — Credit refunds on no-result paths
**Problem:** Users were charged a lookup credit even when the waterfall returned `not_enough_data` (no name, or completely empty result). Credits were deducted up-front and never returned.  
**Fix:** Added `refundCredit()` helper (after `maskEmail()`, ~line 131). Called in two places at the bottom of the request handler (~lines 3675 and 3724) when `status === 'not_enough_data'`. The helper tries a `refund_credit` RPC first (atomic), falls back to a direct table decrement.  
**Caveat:** The fallback decrement is non-atomic (no DB-level RPC yet). Works correctly in practice but a future `refund_credit` RPC would be cleaner.

### P1 #2 — False catch-all detection
**Problem:** MyEmailVerifier returns `risky` for both genuine catch-all domains AND transient SMTP issues. The waterfall was trusting the first `risky` verdict and permanently classifying a domain as catch-all, poisoning the pattern cache and skipping to FullEnrich unnecessarily.  
**Fix:** Added `confirmCatchAll()` function (~line 1082). After a `risky` verdict, it probes the domain with a nonsense address (e.g. `no-reply-abc123zzq@domain.com`). Only if *that* also returns `valid`/`risky` does the domain get flagged as catch-all and written to the DB. A negative probe returns `MISS` with `probe: 'negative'` instead.

### P1 #3 — Step status logging corruption
**Problem:** `StepStatus` type was missing `CATCHALL`, `RISKY_FALLBACK`, and `PERSONAL_HUNTING` variants. The `status_code` map fell through to the default `500`, making analytics dashboards show these normal outcomes as errors.  
**Fix:** Extended the `StepStatus` union (~line 132) and updated the `status_code` mapping (~line 187) to return `200` for all three new statuses.

### P1 #4 — Concurrent double-charge (idempotency guard)
**Problem:** Two simultaneous in-flight requests for the same `(user, linkedin_url)` could both pass the saved-profiles cache check and both deduct a credit.  
**Fix:** Fail-open lock guard added before `deduct_credit` (~line 3453). Calls `acquire_lookup_lock(user_id, linkedin_url)` RPC; returns `409 LOOKUP_IN_PROGRESS` if another request holds the lock. The guard is dormant (no-op) until the SQL migration is deployed — existing behaviour is unchanged until then.  
**Requires:** Deploy `supabase/migrations/20260607000001_lookup_locks.sql`.

### P1 #5 — PII retention on debug logs
**Problem:** `enrichment_debug_logs` stores raw provider payloads that can contain candidate PII (names, emails, phones) with no expiry.  
**Fix:** New migration adds an index and `purge_old_enrichment_debug_logs(p_retention_days int = 30)` function. Rows are only deleted when the function runs — deploy the migration and then either call it manually or uncomment the pg_cron schedule (03:15 UTC daily).  
**Requires:** Deploy `supabase/migrations/20260607000002_enrichment_debug_logs_retention.sql`.

### P2 — AI ensemble accuracy
**Problem (3 sub-issues):**
1. Ensemble prompt said "based ONLY on the evidence below" — prevented models from applying their training knowledge of corporate email conventions.
2. Merge logic kept max-confidence from any single model; a consensus nomination by two models was ignored in favour of one model's high-confidence solo pick.
3. `haiku_refine_candidates` fed masked emails (`j***@company.com`) to the model, hiding the exact local-part pattern the model needed to learn and apply.

**Fix (all in `runEmailEnsemble` and the inline `haiku_refine_candidates` prompt):**
- Ensemble prompt now gives models full name-handling rules (diacritics, particles, hyphenated names, suffixes), size-band pattern priors, and a unified 10-form pattern vocabulary.
- Merge is now vote aggregation: score = sum of confidences across all models that nominated the address. Two-model consensus outranks a single-model high-confidence pick.
- `haiku_refine_candidates` prompt now passes raw emails (not masked), adds the same name-handling rules and pattern vocabulary.

---

## How to deploy

**Order matters.** Do steps 1–2 before redeploying the function.

1. **Deploy SQL migrations** (Supabase dashboard → SQL editor, or `supabase db push`):
   ```
   supabase/migrations/20260607000001_lookup_locks.sql
   supabase/migrations/20260607000002_enrichment_debug_logs_retention.sql
   ```

2. **Verify column name** in `enrichment_debug_logs` before deploying migration #2:
   ```sql
   select column_name from information_schema.columns
    where table_name = 'enrichment_debug_logs';
   ```
   The migration assumes `created_at`. If your schema uses `inserted_at`, update the migration before running it.

3. **Type-check the edge function** locally (requires Deno):
   ```
   deno check supabase/functions/enrich-and-draft/index.ts
   ```

4. **Redeploy the edge function:**
   ```
   supabase functions deploy enrich-and-draft
   ```

5. **Activate daily log purge** (optional): uncomment the `cron.schedule` block at the bottom of migration #2 and re-run, or schedule it via your own job runner.

---

## What still needs doing

### P3 — Latency & observability (medium priority)
- FullEnrich poll duration is ~108 s but error messages say "55 s" — fix the message or the timeout math.
- Self-learning DB writes (`upsertEmailPattern`, `upsertCompanyDomainHint`) are wrapped in silent `catch {}` — add at least a `console.warn` so failures are visible in edge function logs.
- `parseJson()` returns the same fallback for a JSON parse failure as for an empty result — distinguish the two cases for better step-level diagnostics.
- Three or more waterfall paths all log as `myemailverifier_haiku` — give each a unique step name so logs are interpretable.

### P4 — Dead code cleanup (low priority)
- `standardPermutations` and `COMMON_PATTERN_RANK` are defined but never called — wire them or delete them.
- `partialEmails` is hardcoded to `[]` in the search evidence builder — wire the actual parsed partials or remove the unused DB queries that depend on it.
- Pattern vocabulary is inconsistent: 10 patterns in generation, 9 in detection, 15 in cache — unify to one canonical list.
- Company size is always passed as `null` to the single-lookup waterfall path — thread it through from the request payload.

### Gemini API (deferred — add after P2 is validated)
- Gemini Flash is not in the codebase. Recommended model: `gemini-2.5-flash`.
- Add a `callGeminiJson()` function modelled on `callOpenAIJson` (same OpenAI-compatible wire format, just swap base URL and auth header).
- Add as a fourth parallel task in `runEmailEnsemble` — the vote aggregation merge already handles any number of models.
- Confirm `GEMINI_API_KEY` is wired into the edge function's Supabase secrets before deploying.

---

## Known caveats

| Item | Detail |
|------|--------|
| Model IDs | `gpt-5.4-mini` (OpenAI) and `deepseek-v4-flash` (DeepSeek) are both confirmed valid as of 2026-06-07. DeepSeek will deprecate `deepseek-chat` alias on 2026-07-24 — the codebase already uses the V4 name directly, no migration needed. |
| Refund fallback | `refundCredit()` falls back to a direct table decrement which is non-atomic. A concurrent second refund for the same user could over-decrement. Acceptable for now; adding a `refund_credit` DB function would make it atomic. |
| Deno check | No Deno runtime in the cloud container — type-check locally before deploying. |
| Lock TTL | `acquire_lookup_lock` default TTL is 90 s. If FullEnrich polling ever exceeds that, a second request for the same profile could proceed. Tune via the `p_ttl_seconds` parameter if needed. |
