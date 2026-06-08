# SourcedOut AI — Emergent Handoff

A set of backend fixes is ready on GitHub. This doc tells you exactly what to
deploy, in order. Keep it simple — there are only two things to ship: **SQL**
and **one edge function**.

- Repo: `sourcedout/sourcedout-ai`
- Branch with the changes: `claude/beautiful-brahmagupta-JU4O0`
- Edge function version after deploy: `2026-06-08-audit-fixes-v41.2`

---

## What this update does (plain English)

- Stops charging users a credit when no email is found (adds refunds).
- Fixes false "catch-all domain" detection (was rejecting good emails).
- Removes the old PDL service and adds **Gemini** as a 4th AI model.
- Makes the AI email-finding smarter (models agree by voting).
- Cuts wasted spend on the email-verification service (caching).
- **Fixes the Campaigns feature** — its database tables were never created,
  which is why it was broken. This adds them.

---

## Step-by-step deploy

### Step 1 — Pull the branch
Connect to `sourcedout/sourcedout-ai` and check out the branch:
`claude/beautiful-brahmagupta-JU4O0`

### Step 2 — Run the 3 SQL migrations (in this order)
Run these in Supabase (you're already connected). **Order matters.**

1. `supabase/migrations/20260607000001_lookup_locks.sql`
2. `supabase/migrations/20260607000002_enrichment_debug_logs_retention.sql`
   - Before running, confirm the timestamp column name:
     ```sql
     select column_name from information_schema.columns
      where table_name = 'enrichment_debug_logs';
     ```
   - If it shows `created_at`, run as-is. If `inserted_at`, swap that name in the file.
3. `supabase/migrations/20260608000003_campaigns.sql`

> These are incremental migrations. They assume the existing base tables
> (`saved_jobs`, `enrichment_debug_logs`, `saved_profiles`, `profiles`) already
> exist in the database — they do in production.

### Step 3 — Confirm the Gemini secret
On the `enrich-and-draft` edge function, make sure this secret is set:
- `GEMINI_API_KEY`  (enables the new 4th AI model)

These should already exist: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`DEEPSEEK_API_KEY`, `MYEMAILVERIFIER_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CX`,
`BRAVE_API_KEY`, `FULLENRICH_API_KEY`.
(`PDL_API_KEY` is no longer used — safe to leave or remove.)

### Step 4 — Deploy the edge function
Deploy `enrich-and-draft` from the branch. It's a single self-contained file:
`supabase/functions/enrich-and-draft/index.ts` (no other files to deploy).

**Important:** run the SQL (Step 2) BEFORE deploying — the new code reads tables
and calls functions that the migrations create.

---

## How to verify it worked

- **Version:** any response from the function has header
  `X-Function-Version: 2026-06-08-audit-fixes-v41.2`.
- **Gemini on:** the function's startup log shows `has_gemini_key: true`.
- **Campaigns fixed:** import a small CSV in the extension → a row appears in the
  `campaigns` table and rows in `campaign_candidates`. Enrich one and confirm
  `enriched_count` goes up by 1.
- **No false errors:** catch-all/risky outcomes log as `status_code` 200, not 500.

---

## Known follow-ups (NOT done — for later, your call)

- **Campaign CSV validation:** rows missing first/last name import silently and
  then fail enrichment. Add a pre-import check in the extension's `batch.js`.
- **Reply-detection throttle:** runs on every campaign open; add a ~5-min cooldown.
- **No web dashboard for campaigns:** feature is extension-only today.
- **FullEnrich phone numbers** aren't saved to results (only Google/Brave phones are).

---

## Files changed on the branch

| File | What |
|------|------|
| `supabase/functions/enrich-and-draft/index.ts` | All edge-function fixes |
| `supabase/migrations/20260607000001_lookup_locks.sql` | NEW |
| `supabase/migrations/20260607000002_enrichment_debug_logs_retention.sql` | NEW |
| `supabase/migrations/20260608000003_campaigns.sql` | NEW — fixes Campaigns |
