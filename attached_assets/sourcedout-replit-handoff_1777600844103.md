# SourcedOut AI — Replit Handoff Document
**Date:** April 30, 2026
**Migrating from:** Lovable (Bolt/Vite)
**Repo:** SourcedOut-Lovable (now connected to Replit)

---

## What This Product Is

SourcedOut AI is a **Chrome Extension + Web App** for recruiters. It sits on top of LinkedIn and automates the two most time-consuming parts of outbound recruiting:

1. **Email discovery** — finds a candidate's verified work email from their LinkedIn profile using a multi-source waterfall (no manual searching)
2. **AI draft generation** — writes a personalized outreach email using Claude (Anthropic) based on the candidate's name, title, company, and recruiter context

The target user is an independent recruiter or talent acquisition team that does high-volume LinkedIn outreach and wants to skip the copy-paste-research loop.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend (Web App) | React + Vite + TypeScript + Tailwind + shadcn/ui |
| Chrome Extension | Manifest V3, content script + popup |
| Backend / API | Supabase Edge Function (Deno/TypeScript) |
| Database | Supabase Postgres |
| Auth | Supabase Auth (email/password) |
| AI | Anthropic Claude (Haiku for enrichment tasks, Sonnet for drafts) |
| Email Discovery | FullEnrich v2, Apollo, MyEmailVerifier, Google Custom Search |
| Payments | Stripe (wired but not fully active) |

---

## Repository Structure

```
/
├── src/                        # React web app (Vite)
│   ├── components/             # UI components
│   ├── pages/                  # Route pages
│   └── integrations/supabase/  # Supabase client + types
├── supabase/
│   └── functions/
│       └── enrich-and-draft/
│           └── index.ts        # ⭐ THE ENTIRE BACKEND (1 edge function)
├── extension/                  # Chrome Extension source
│   ├── manifest.json
│   ├── popup.html / popup.js
│   └── content.js              # LinkedIn DOM scraper
└── public/
```

---

## The Core Edge Function (`enrich-and-draft/index.ts`)

**Everything runs through one Supabase Edge Function.** It handles all actions via a `body.action` switch. Current version deployed: `2026-04-30-anthropic-error-logging-v13` (version 53).

> ⚠️ **URGENT — The last deploy was a broken test deploy that stripped the function down to a stub.** The full function code is in the repo at `supabase/functions/enrich-and-draft/index.ts`. The first thing Replit must do is redeploy the full function from the repo. The correct version is tagged `2026-04-30-person-scoped-discovery-v12` in the repo history.

### Actions handled by the function

| Action | What it does |
|---|---|
| `enrich-and-draft` | Main single-profile flow from Chrome Extension |
| `enrich-campaign-candidate` | Bulk enrichment for campaign candidates |
| `draft-campaign-candidate` | Generate AI email draft for a candidate |
| `summarize-job` | Summarize a job posting into bullet points |
| `bookmark-profile` | Save/unsave a LinkedIn profile |
| `check-saved-profile` | Check if profile is cached (30-day window) |
| `import-campaign` | Bulk CSV import of candidates into a campaign |
| `get-campaigns` / `get-campaign-candidates` | Fetch campaign data |
| `save-job` / `get-saved-jobs` / `delete-job` | Manage saved job postings |
| `update-candidate-status` | Approve/skip/reset candidate |
| `link-campaign-job` | Attach a job to a campaign |
| `delete-campaign` | Remove a campaign |

### Email Discovery Waterfall (in order)

1. **Cache check** — 30-day saved profile cache, no credit charged
2. **Company discovery** — finds current employer from scrape, cache, Google CSE snippets
3. **Domain resolution** — MX record validation via Cloudflare DNS-over-HTTPS
4. **Google CSE** — searches public web for a matching email address
5. **Catch-all detection** — probes domain with a fake address before permuting
6. **Permutator + MyEmailVerifier** — generates 15 standard email patterns, verifies in parallel
7. **Claude Haiku email guess** — LLM infers likely pattern based on company size priors
8. **Haiku verify** — verifies Haiku's candidates against MyEmailVerifier
9. **Apollo people/match** — last cheap-API attempt
10. **FullEnrich v2** — LinkedIn URL → email (costs a credit, runs last)
11. **Post-FullEnrich retry waterfall** — re-runs steps 3–9 with newly resolved name/domain

---

## Environment Variables (Supabase Secrets)

These are set in Supabase project secrets — **do not commit to repo:**

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
FULLENRICH_API_KEY
GOOGLE_API_KEY  (also checked as GOOGLE_CSE_KEY)
GOOGLE_CX       (also checked as GOOGLE_CSE_CX)
MYEMAILVERIFIER_API_KEY
APOLLO_API_KEY
```

---

## Database Schema (Supabase Postgres)

All tables have RLS enabled. All are user-scoped via `user_id → auth.users.id`.

| Table | Purpose | Key columns |
|---|---|---|
| `credits` | Per-user credit balance and tier | `tier` (free/sourcer/pro), `lookups_used`, `resets_at` |
| `saved_profiles` | 30-day enrichment cache per LinkedIn URL | `linkedin_url`, `work_email`, `personal_email`, `email_status`, `raw_data` |
| `campaigns` | Outreach campaign containers | `name`, `job_id`, `status`, `total/enriched/drafted/approved_count` |
| `campaign_candidates` | Individual candidates in a campaign | `status` (imported→enriching→enriched→drafted→approved), `work_email`, `draft_body` |
| `saved_jobs` | Job postings attached to campaigns | `label`, `role_title`, `highlights` |
| `recruiter_profiles` | Recruiter's own name/company/tone for drafts | `full_name`, `company_name`, `tone`, `hiring_focus` |
| `outreach_runs` | Log of all single-profile enrichment runs | `full_name`, `email_status`, `draft_subject`, `sources` |
| `enrichment_debug_logs` | Step-by-step enrichment debug log | `provider`, `request_payload`, `response_payload`, `status_code` |
| `company_domains` | Cached domain → company name lookups | `domain`, `canonical_company_name`, `confidence` |

### Key RPCs (Postgres functions)

- `deduct_credit(p_user_id)` — atomically checks and deducts a lookup credit, returns `false` if limit reached
- `increment_ai_run(p_user_id)` — increments `ai_runs_used` counter

---

## Credit Tiers

| Tier | Monthly Lookups |
|---|---|
| `free` | 10 |
| `sourcer` | 50 |
| `pro` | 200 |

Credits reset monthly. Stripe customer/subscription IDs are stored in the `credits` table but Stripe webhooks are not fully wired yet.

---

## Chrome Extension Flow

1. User opens a LinkedIn profile
2. `content.js` scrapes: name, company, LinkedIn URL from the DOM
3. User clicks the extension popup
4. Popup calls `enrich-and-draft` edge function with `action: 'enrich-and-draft'`
5. Function returns email + AI draft
6. Popup displays draft, user copies and sends

The extension also supports a **Campaign mode** — users import a CSV of LinkedIn URLs and batch-enrich + draft all candidates.

---

## Known Issues / What Was Being Fixed at Migration

1. **⭐ CRITICAL: Edge function is currently a stub** — the last deploy accidentally replaced the full ~2,000-line function with a test stub. Redeploy from repo immediately.
2. **Anthropic silent failures** — `callAnthropic()` was not checking `res.ok` before parsing JSON, so API errors (wrong model name, quota exceeded, etc.) silently returned `'{}'` instead of throwing. The fix is in the repo: check `res.ok`, log `res.status` + body, throw a real error.
3. **`haiku_verify` always returning SKIP/MISS** — 13 SKIP + 4 MISS across all runs, zero successes. Root cause is likely the silent Anthropic failure above (Haiku returns `'{}'` → no candidates → SKIP). Fix #2 above should expose the real error.
4. **Apollo returning 403** — Apollo API key is on a free plan that blocks the `/people/match` endpoint. Either upgrade the plan or remove Apollo from the waterfall temporarily.
5. **`recruiter_profiles` table is empty** — the onboarding flow to collect recruiter name/company/tone has not been built yet. Drafts currently generate without a personalized sign-off.

---

## What to Build Next (Priority Order)

1. **Redeploy the full edge function** with the Anthropic fix applied
2. **Debug Haiku email guess** — after fix #1, check logs for real Anthropic error messages
3. **Recruiter onboarding screen** — collect `full_name`, `company_name`, `job_title`, `tone`, `hiring_focus` and save to `recruiter_profiles`
4. **Stripe webhook** — wire up subscription upgrades to update `credits.tier`
5. **Campaign UI polish** — the bulk campaign flow exists in the DB but the UI needs work
6. **Extension UX** — show enrichment source badge (where did the email come from?)

---

## Supabase Project

- **Project ID:** `szxjcitbjcpkhxtjztay`
- **Region:** us-east-1
- **Dashboard:** https://supabase.com/dashboard/project/szxjcitbjcpkhxtjztay

---

*Good luck — the architecture is solid. The main thing is getting the edge function redeployed correctly and then the Anthropic error logging will tell you exactly what's failing in the waterfall.*
