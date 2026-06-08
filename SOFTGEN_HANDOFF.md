# SourcedOut AI — Softgen Handoff (Master)

**This is the single source of truth for the current round of work.**
All code is already committed to branch **`claude/beautiful-brahmagupta-JU4O0`**.
You do not need to re-type any code — pull the branch, review, and deploy.

- Branch: `claude/beautiful-brahmagupta-JU4O0`
- Base: `main` (untouched)
- Edge function version after deploy: `2026-06-08-audit-fixes-v41.2`

> Note: `SOFTGEN_CHANGES.md` (older file) contains the find/replace diff for the
> very first P1 round only. **This file supersedes it** and covers everything.

---

## TL;DR — what to deploy

There are exactly **2 things to ship**: a set of **SQL migrations** and the **edge function**.

1. Run these SQL migrations (in order) in Supabase (SQL editor or `supabase db push`):
   - `supabase/migrations/20260607000001_lookup_locks.sql`
   - `supabase/migrations/20260607000002_enrichment_debug_logs_retention.sql`
   - `supabase/migrations/20260608000003_campaigns.sql`
2. Confirm the `GEMINI_API_KEY` secret is set on the edge function (you said it's already on Supabase).
3. Redeploy the edge function: `supabase functions deploy enrich-and-draft`

Detailed order and verification are at the bottom.

---

## What changed and why

The work falls into five rounds. All are committed.

### Round 1 — P1 waterfall bug fixes (`ef42efd`, `5c30d6a`)
- **Credit refunds:** users were charged a lookup credit even when the waterfall
  returned nothing usable (`not_enough_data`). Added `refundCredit()` and call it
  on both no-result exits.
- **False catch-all detection:** MyEmailVerifier returns `risky` for both genuine
  catch-all domains and transient SMTP issues. Added `confirmCatchAll()` — a
  nonsense-address probe — so a domain is only branded catch-all when confirmed.
- **Step status logging:** `CATCHALL` / `RISKY_FALLBACK` / `PERSONAL_HUNTING` were
  logged as HTTP 500 in analytics. Added them to the status map as 200.
- **Idempotency guard (fail-open):** two simultaneous lookups of the same profile
  could each deduct a credit. Added a DB lock (`acquire_lookup_lock`) — dormant
  until its migration is deployed, so behaviour is unchanged until you ship it.
- **Debug-log retention:** `enrichment_debug_logs` stores PII with no expiry. Added
  a `purge_old_enrichment_debug_logs(days)` function (30-day default).

### Round 2 — AI ensemble accuracy (`1cdb64b`)
- Removed the "use ONLY the evidence" restriction so models can apply their
  knowledge of corporate email conventions.
- Added name-handling rules + size-band pattern priors to all AI email prompts.
- Replaced max-confidence "winner takes all" merge with **vote aggregation**
  (a candidate two models agree on beats one model's lone high-confidence pick).
- Stopped feeding the model masked emails (`j***@x.com`) in `haiku_refine`.

### Round 3 — Waterfall v41 (`191746b`)
- **Removed People Data Labs (PDL)** from the waterfall. Step 11 is now a no-op
  SKIP; the step name is preserved so diagnostics stay stable.
- **Added Gemini (`gemini-2.5-flash`)** as a 4th member of the LLM ensemble via its
  OpenAI-compatible endpoint. Reads `GEMINI_API_KEY`. The vote-merge already
  handles any number of models.
- **Search optimization:** `SearchEvidence.partialEmails` was always `[]`, so the
  dedicated "email format" Google/Brave query was wasted. Added
  `extractEmailPatterns()` to mine format tokens (`first.last`, `flast`, …) from
  snippets and feed them to the refine + ensemble steps.

### Round 4 — MEV hardening (`e5c4d01`)
- `unknown` (transient/inconclusive) is no longer collapsed into `risky`, so a
  transient blip can't masquerade as catch-all evidence.
- Added one retry + `res.ok` handling to `myEmailVerifierValidate`.
- Added a per-request **`mevCache`** shared across all 5 verification rounds so the
  same address is never billed to MyEmailVerifier twice (definitive verdicts only).
- The pattern-cache catch-all path now also runs the `confirmCatchAll` probe.

### Round 5 — Audit fixes + Campaigns schema (`4398ca8`)
- **Pattern-cache self-learning fix:** both pattern-cache success exits now persist
  the company→domain hint (was only happening on later steps).
- **Stale source attribution fix:** Step 12 no longer mislabels results as
  `pdl_person_enrichment` (PDL is gone) — now `haiku_refine`.
- **Campaigns tables were missing entirely from migrations.** The extension's
  Campaign feature reads/writes `campaigns` and `campaign_candidates`, but no
  migration created them — so it breaks on a fresh deploy. Added
  `20260608000003_campaigns.sql` with both tables, indexes, RLS, and an atomic
  `increment_campaign_count()` RPC.
- **Campaign counter race fix:** counter increments now use the atomic RPC instead
  of a read-modify-write that could lose counts under concurrency.
- **Duplicate campaign name:** now returns a clean 409 `DUPLICATE_CAMPAIGN` message
  instead of a generic 500.

---

## Files changed (all on the branch)

| File | Change |
|------|--------|
| `supabase/functions/enrich-and-draft/index.ts` | All edge-function logic above |
| `supabase/migrations/20260607000001_lookup_locks.sql` | NEW — idempotency lock + RPC |
| `supabase/migrations/20260607000002_enrichment_debug_logs_retention.sql` | NEW — PII purge function |
| `supabase/migrations/20260608000003_campaigns.sql` | NEW — campaigns tables + RLS + counter RPC |

---

## Deploy runbook

**Order matters.** Do the SQL first, then the function.

1. **Migration 1 — lookup locks**
   Run `20260607000001_lookup_locks.sql`. Activates the concurrent double-charge guard.

2. **Migration 2 — debug-log retention**
   Before running, confirm the timestamp column name:
   ```sql
   select column_name from information_schema.columns
    where table_name = 'enrichment_debug_logs';
   ```
   The migration assumes `created_at`. If yours is `inserted_at`, swap it in the file,
   then run `20260607000002_enrichment_debug_logs_retention.sql`.
   (Optional: uncomment the pg_cron block to auto-purge daily at 03:15 UTC.)

3. **Migration 3 — campaigns**
   Run `20260608000003_campaigns.sql`. Creates `campaigns` + `campaign_candidates`
   with RLS, and the `increment_campaign_count` RPC.
   - If these tables already exist in your project (created manually earlier), the
     `create table if not exists` guards make this safe, **but** verify the column
     set matches — see the file. The RPC and indexes will still be created.

4. **Secrets** — confirm on the edge function:
   - `GEMINI_API_KEY` (new — enables the 4th ensemble model)
   - Existing: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`,
     `MYEMAILVERIFIER_API_KEY`, `GOOGLE_API_KEY`/`GOOGLE_CX`, `BRAVE_API_KEY`,
     `FULLENRICH_API_KEY`
   - `PDL_API_KEY` is no longer used (safe to leave or remove).

5. **Type-check** locally (optional but recommended):
   ```
   deno check supabase/functions/enrich-and-draft/index.ts
   ```

6. **Deploy the function:**
   ```
   supabase functions deploy enrich-and-draft
   ```

---

## How to verify after deploy

- **Function version:** the response header `x-function-version` should read
  `2026-06-08-audit-fixes-v41.2`.
- **Gemini active:** the function's startup log line `[enrich env]` should show
  `has_gemini_key: true`. A waterfall that reaches the ensemble step should list
  `gemini_2_5_flash` in the step's `models` metadata.
- **No false 500s:** catch-all / risky outcomes in `enrichment_debug_logs` should now
  have `status_code` 200, not 500.
- **Campaigns:** import a small CSV in the extension → a `campaigns` row and
  `campaign_candidates` rows should appear; enrich one and confirm `enriched_count`
  increments by exactly 1.
- **MEV cost:** repeated candidates across steps should show `(cached)` in logs
  instead of re-billing.

---

## Known follow-ups (NOT in this branch — for later)

These were found during the audit but intentionally left out of scope:

- **Campaign CSV validation:** rows missing first/last name import silently and fail
  enrichment as `no_email`. Add a pre-import check in `batch.js`.
- **Reply detection debounce:** runs on every campaign open with no cooldown; add a
  ~5-minute throttle.
- **No web dashboard for campaigns:** the feature is extension-only; there's no
  `/campaigns` route in the Next.js app.
- **FullEnrich phone capture:** phones returned by FullEnrich aren't added to the
  result set (only Google/Brave phones are).
- **Minor cleanup:** dead `pdlKey` plumbing and the unused `runPdlPersonEnrichment`
  function remain (kept so re-enabling PDL is trivial); `runMevLoop`'s `labelFn`
  param is unused.
