# SourcedOut — Developer Handoff Document

> **Prepared for:** Emergent (incoming dev agent)
> **Prepared by:** Michael Polec / SourcedOut
> **Last updated:** 2026-05-06
> **Source of truth:** GitHub repo `SourcedOut/sourcedout-extension` + Supabase project `szxjcitbjcpkhxtjztay`

---

## 0. Quick Reference

| Item | Value |
|---|---|
| Supabase Project ID | `szxjcitbjcpkhxtjztay` |
| Supabase Region | `us-west-2` |
| Supabase DB Host | `db.szxjcitbjcpkhxtjztay.supabase.co` |
| Postgres Version | 17.6 |
| Primary Edge Function | `enrich-and-draft` |
| Chrome Extension ID | `oekidhmjmaknllpbdagiffepogjgkjdj` (locked) |
| Extension Manifest | Manifest V3 |

---

## 1. Product Overview

SourcedOut is an AI-powered recruiter outreach tool delivered as a **Chrome Extension + Supabase backend**. It has two operating modes:

### 1.1 Single-Profile Mode (Extension)
- Recruiter opens a LinkedIn profile in Chrome.
- SourcedOut extension scrapes the visible DOM (name, company, title, headline, location, LinkedIn URL).
- Extension sends the scraped data to the `enrich-and-draft` Supabase Edge Function.
- Backend runs a multi-step enrichment waterfall to find a verified work email.
- Backend generates a personalized outreach email draft using Anthropic Claude Sonnet.
- Extension displays the email + draft to the recruiter in the popup.

### 1.2 Campaign Mode (Bulk, CSV)
- Recruiter imports a CSV of LinkedIn profiles into a Campaign.
- Each candidate goes through the same enrichment waterfall individually via the `enrich-campaign-candidate` action.
- Drafts are generated per candidate via `draft-campaign-candidate`.
- Recruiter approves, skips, or edits candidates in the Campaign UI.

### 1.3 Key Design Constraints
- **Credits system**: every fresh enrichment deducts 1 credit from the `credits` table via the `deduct_credit` RPC. Cached results (within 30 days) are free.
- **Cost-first waterfall**: cheapest providers (Haiku guess + MEV) run before expensive ones (Apollo, FullEnrich).
- **30-day profile cache**: results are stored in `saved_profiles`; a cache HIT skips the waterfall entirely.
- **Catch-all domain detection**: domains where MEV returns only `risky` results are flagged `is_catchall = true` in `company_email_patterns` and handled differently.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────┐
│             Chrome Extension (MV3)              │
│  content.js (scrape LinkedIn DOM)               │
│  popup.js   (UI + state)                        │
│  core/api.js (Supabase Edge Function calls)     │
│  auth.html  (OAuth callback)                    │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS / Bearer token
                   ▼
┌─────────────────────────────────────────────────┐
│     Supabase Edge Function: enrich-and-draft    │
│     (Deno/TypeScript, ~2,400 lines)             │
│                                                 │
│  Actions handled:                               │
│    enrich-and-draft (default)                   │
│    summarize-job                                │
│    bookmark-profile                             │
│    check-saved-profile                          │
│    get-saved-profiles                           │
│    save-job / get-saved-jobs / delete-job       │
│    import-campaign                              │
│    get-campaigns                                │
│    get-campaign-candidates                      │
│    enrich-campaign-candidate                    │
│    draft-campaign-candidate                     │
│    update-candidate-status                      │
│    link-campaign-job                            │
│    delete-campaign                              │
└──────────────────┬──────────────────────────────┘
                   │
          ┌────────┴─────────┐
          ▼                  ▼
   Supabase Postgres    External APIs
   (Postgres 17.6)      (see Section 5)
```

---

## 3. Repo File Map

### 3.1 Chrome Extension Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest. Locked extension ID. Permissions: `activeTab`, `storage`, `tabs`, `scripting`. Host permissions for `linkedin.com`, Supabase URL, FullEnrich, Gmail, Outlook. |
| `extension/config.js` | Supabase URL + anon key, Stripe live price IDs, tier config (free/sourcer/pro lookup limits), `scraperBuild` version string. |
| `extension/content.js` | Scrapes LinkedIn DOM: full name, current company, headline, location, job history, LinkedIn URL. Deliberately ignores sidebar/ads/People Also Viewed sections. |
| `extension/popup.js` | Main popup UI: step progress display, draft rendering, NEED_COMPANY chip UX, credit display, bookmark toggle. ~56 KB — large but correct. |
| `extension/core/api.js` | Thin wrapper over all Supabase Edge Function calls. Handles auth token injection, session refresh on 401, structured error parsing, `FUNCTION_VERSION` tracking. |
| `auth.html` + `auth-callback.js` | Supabase OAuth redirect page. The URL `chrome-extension://oekidhmjmaknllpbdagiffepogjgkjdj/auth.html` must be whitelisted in Supabase Auth settings. |
| `extension/ui/popup.html` | HTML shell for the popup. |

### 3.2 Supabase Edge Functions

| Function | Purpose |
|---|---|
| `supabase/functions/enrich-and-draft/index.ts` | **Primary function** — handles all 15 actions listed above. Contains the full enrichment waterfall, draft generation, credit logic, and step logger. |

> Note: `enrichment-pipeline` and `lookup-email` are legacy/dead functions. Do not redeploy them.

### 3.3 Migrations

- `supabase/migrations/` — all schema migrations tracked here.
- Important migration: `20260409020000_recruiterprofiles.sql` — adds the `recruiter_profiles` table required for personalized draft generation. Must be confirmed applied on production.

---

## 4. Database Schema (Production, Live)

All tables are in the `public` schema with RLS enabled unless noted.

### 4.1 `saved_profiles` (76 rows)

Caches per-user enrichment results for up to 30 days.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | auto |
| `user_id` | uuid FK → auth.users | |
| `linkedin_url` | text | unique per user |
| `full_name` | text | |
| `work_email` | text | verified work email |
| `personal_email` | text | personal/fallback |
| `title` | text | job title |
| `company` | text | |
| `title_verified` | bool | true if from a data provider |
| `email_status` | text | `found` / `uncertain` / `not_found` |
| `email_source` | text | source label |
| `raw_data` | jsonb | FullEnrich raw payload |
| `is_bookmarked` | bool | user-saved flag |
| `enriched_at` | timestamptz | used for 30-day cache window check |
| `created_at`, `updated_at` | timestamptz | |

Cache hit logic: `enriched_at >= now() - 30 days OR is_bookmarked = true`

### 4.2 `company_email_patterns` (609 rows)

Stores per-domain confirmed email patterns. This is the fastest path in the waterfall — a domain HIT skips all AI steps.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `domain` | text | e.g. `stripe.com` |
| `verified_pattern` | text | e.g. `first.last`, `flast` |
| `sample_email` | text | masked sample |
| `confidence` | float8 | default 1.0 |
| `verified_count` | int | times confirmed |
| `last_verified_at` | timestamptz | |
| `is_catchall` | bool | true = MEV always returns risky |
| `created_at` | timestamptz | |

### 4.3 `company_domain_hints` (19 rows) ⚠️ RLS DISABLED

Maps normalized company names to domains. Used in domain resolution step.

| Column | Type | Notes |
|---|---|---|
| `company_key` | text PK | normalized company name |
| `domain` | text PK | |
| `hit_count` | int | |
| `updated_at` | timestamptz | |

> **⚠️ SECURITY ISSUE**: RLS is disabled on this table. Any user with the anon key can read or write all rows. Do NOT auto-fix without adding appropriate RLS policies first. Remediation SQL: `ALTER TABLE public.company_domain_hints ENABLE ROW LEVEL SECURITY;` Reference: https://supabase.com/docs/guides/database/postgres/row-level-security

### 4.4 `company_domains` (4 rows)

Maps email domains to canonical company names. Populated by the `resolveEmployer()` function.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `domain` | text unique | |
| `canonical_company_name` | text | |
| `confidence` | numeric | |
| `created_at`, `updated_at` | timestamptz | |

### 4.5 `enrichment_debug_logs` (1,036 rows)

Step-by-step waterfall log. The Diagnostics tab in the extension reads this table.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | nullable |
| `provider` | text | step name (e.g. `haiku_email_guess`, `myemailverifier`, `apollo`) |
| `request_payload` | jsonb | includes `correlation_id`, `action` |
| `response_payload` | jsonb | includes `status`, `reason`, `meta` |
| `status_code` | int | 200=OK/HIT, 204=SKIP, 404=MISS, 500=FAIL |
| `correlation_id` | uuid | groups all steps from a single run |
| `created_at` | timestamptz | |

> **Important**: `provider` values are used by the Diagnostics UI. Do not rename step names without updating the extension display logic.

### 4.6 `credits` (3 rows)

Per-user credit accounting. Tier limits enforced by `deduct_credit` RPC.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid unique FK → auth.users | |
| `tier` | text | `free` / `sourcer` / `pro` |
| `mode` | text | default `recruiter` |
| `lookups_used` | int | incremented per fresh enrichment |
| `emails_used` | int | |
| `ai_runs_used` | int | incremented by `increment_ai_run` RPC |
| `resets_at` | timestamptz | 30 days from creation |
| `stripe_customer_id` | text | |
| `stripe_subscription_id` | text | |
| `email` | text | |

Tier lookup limits (from extension config):
- `free`: 10 lookups
- `sourcer`: 50 lookups
- `pro`: 200 lookups

### 4.7 `recruiter_profiles` (0 rows — migration pending production)

Stores recruiter identity for injecting into outreach drafts.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid unique FK → auth.users | |
| `full_name` | text | |
| `company_name` | text | |
| `job_title` | text | nullable |
| `hiring_focus` | enum | `engineering`, `product`, `design`, `data`, `sales`, `marketing`, `finance`, `legal`, `hr`, `operations`, `executive`, `other` |
| `tone` | enum | `professional`, `friendly`, `direct`, `warm`, `formal` |
| `created_at`, `updated_at` | timestamptz | |

### 4.8 `outreach_runs` (85 rows)

Permanent log of every completed single-profile enrichment + draft.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | returned as `runId` in API response |
| `user_id` | uuid | |
| `full_name`, `company`, `title`, `email` | text | final resolved values |
| `email_status` | text | `found` / `uncertain` / `not_found` |
| `person_confidence`, `company_confidence`, `title_confidence`, `draft_confidence` | numeric | weighted confidence scores |
| `user_context`, `company_hint` | text | inputs from recruiter |
| `draft_subject`, `draft_body` | text | final generated draft |
| `status` | text | `success` / `partial` / `not_enough_data` |
| `sources` | jsonb | array of `{ type, label, confidence }` |
| `email_source` | text | |

### 4.9 `campaigns` (1 row) + `campaign_candidates` (25 rows)

Campaign bulk enrichment tracking.

**`campaigns`**:
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | |
| `name` | text | |
| `job_id` | uuid FK → saved_jobs | nullable |
| `status` | text | `needs_job` / `ready` / `active` / `archived` |
| `total_count`, `enriched_count`, `drafted_count`, `approved_count` | int | aggregate counters |

**`campaign_candidates`**:
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `campaign_id` | uuid FK → campaigns | |
| `user_id` | uuid | |
| `first_name`, `last_name`, `headline`, `location` | text | from CSV import |
| `current_title`, `current_company` | text | from CSV |
| `csv_email`, `phone` | text | from CSV |
| `linkedin_url` | text | required for enrichment |
| `saved_profile_id` | uuid FK → saved_profiles | set after enrichment |
| `status` | text | `imported` → `enriching` → `enriched` → `drafting` → `drafted` → `approved` / `skipped` / `failed` / `no_email` |
| `work_email`, `personal_email`, `email_status` | text | filled by enrichment |
| `enriched_title`, `enriched_company` | text | filled by enrichment |
| `draft_subject`, `draft_body`, `draft_confidence` | text/numeric | filled by draft step |
| `enriched_at`, `drafted_at`, `approved_at` | timestamptz | |

### 4.10 `saved_jobs` (1 row)

User-saved job postings used to inject job context into outreach drafts.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | |
| `label` | text | user-defined label, unique per user |
| `job_url` | text | optional |
| `role_title` | text | |
| `company` | text | |
| `highlights` | text | AI-summarized bullet points |

### 4.11 Legacy / Unused Tables

| Table | Status |
|---|---|
| `candidates` | Legacy; 0 rows; superseded by `campaign_candidates` |
| `candidate_title_sources` | Legacy; 0 rows |
| `workflow_jobs` | Legacy; 0 rows |
| `outreach_sources` | 0 rows; populated via FK from outreach_runs but not actively written |

---

## 5. External APIs & Secrets

All secrets are set as Supabase Edge Function environment variables. The function reads them via `Deno.env.get(...)`.

### 5.1 Required Secrets

| Secret Name | Provider | Used For |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic | Claude Haiku-4-5 (email guessing, title inference, company resolver, job summarizer) + Claude Sonnet-4-5 (outreach draft generation) |
| `GOOGLE_API_KEY` | Google Cloud | Google Custom Search Engine — finds publicly-referenced emails |
| `GOOGLE_CX` | Google Cloud | CSE Engine ID — paired with `GOOGLE_API_KEY` (note: code reads `GOOGLE_CX`, **not** `GOOGLE_CSE_CX`) |
| `MYEMAILVERIFIER_API_KEY` | MyEmailVerifier | Email address validation — returns `valid` / `invalid` / `risky` / `unknown` |
| `APOLLO_API_KEY` | Apollo.io | `/api/v1/people/match` — work email lookup by name + company domain |
| `FULLENRICH_API_KEY` | FullEnrich | LinkedIn URL → work email + personal email + title + company (async bulk API, last resort) |
| `SUPABASE_URL` | Supabase | Database connection (auto-injected by Supabase runtime) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Bypasses RLS for server-side writes (auto-injected) |

> **Note**: The previous handoff listed `BRAVE_API_KEY`, `PDL_API_KEY`, `GOOGLE_CSE_KEY`, and `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`. **These are NOT present in the current live `index.ts`.** The waterfall was refactored to use Haiku + Google CSE + MyEmailVerifier + Apollo + FullEnrich. Brave Search, PDL, LeadMagic, OpenAI, and DeepSeek were used in a prior version but are not wired in the current code. Do not add them back without explicit instruction.

### 5.2 API Integration Details

#### Anthropic Claude
- **Base URL**: `https://api.anthropic.com/v1/messages`
- **Models used**:
  - `claude-haiku-4-5` — all intermediate steps (cheap, fast): email guessing, company resolution, title inference, job summarization
  - `claude-sonnet-4-5` — final outreach draft generation (more capable)
- **Auth header**: `x-api-key: {ANTHROPIC_API_KEY}` + `anthropic-version: 2023-06-01`
- **Max tokens**: 100–500 depending on step
- **Response parsing**: all prompts ask for raw JSON; parsed via `parseJson()` which strips markdown code fences before `JSON.parse()`

#### Google Custom Search Engine (CSE)
- **Endpoint**: `https://www.googleapis.com/customsearch/v1`
- **Auth**: `key={GOOGLE_API_KEY}&cx={GOOGLE_CX}` as query params
- **Query pattern**: `"Full Name" CompanyName "@domain.com"` — seeks publicly-visible email addresses in search snippets
- **Result count**: `num=5` (known gap — could be bumped to `num=10` for more signal)
- **Email extraction**: regex `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` across all title+snippet+link fields
- **Priority**: domain-matching emails preferred; non-domain emails only returned if no domain is known

#### MyEmailVerifier (MEV)
- **Endpoint**: `https://client.myemailverifier.com/verifier/validate_single/{email}/{key}`
- **Method**: GET (email and key are path params, URL-encoded)
- **Response**: JSON with `Status` field
- **Status mapping**:
  - Contains `valid` (and not `invalid`) → `valid` ✅
  - Contains `invalid` → `invalid` ❌
  - Contains `risky`, `unknown`, or `catch` → `risky` ⚠️
  - Anything else → `unknown`
- **Usage pattern**: candidates are verified sequentially; first `valid` result exits the step

#### Apollo `/people/match`
- **Endpoint**: `https://api.apollo.io/api/v1/people/match`
- **Method**: POST JSON
- **Auth**: `X-Api-Key: {APOLLO_API_KEY}` header
- **Payload**: `{ first_name, last_name, domain, organization_name, reveal_personal_emails: false }`
- **Response**: `data.person.email` — filtered to exclude `email_not_unlocked` and `domain_catch_all` sentinel values
- **Returns**: work email + job title (title backfills if not already found)

#### FullEnrich (Async Bulk API)
- **Start endpoint**: `POST https://app.fullenrich.com/api/v2/contact/enrich/bulk`
- **Auth**: `Authorization: Bearer {FULLENRICH_API_KEY}`
- **Payload**: `{ name: "OutreachAI-{timestamp}", data: [{ linkedin_url, enrich_fields: ["contact.emails"] }] }`
- **Returns**: `enrichment_id` for polling
- **Poll endpoint**: `GET https://app.fullenrich.com/api/v2/contact/enrich/bulk/{enrichment_id}`
- **Poll strategy**: wait 3s, then poll every 5s, max 22 retries (55s total timeout)
- **Poll response states**: `FINISHED`, `FAILED`, or in-progress (keep polling)
- **Data extraction**:
  - Work email: `contact_info.most_probable_work_email.email` → `contact_info.work_emails[0].email` → `contact.most_probable_email`
  - Personal email: `contact_info.most_probable_personal_email.email` → `contact_info.personal_emails[0].email`
  - Title/company: from `profile.employment.current`
- **Cost**: this is the most expensive provider; only called if all prior steps fail

---

## 6. Email Enrichment Waterfall (Detailed)

The waterfall runs inside `runEmailWaterfall()` for Steps 2–5, then FullEnrich is called directly afterward in the main handler. All steps are logged via `makeStepLogger()` into `enrichment_debug_logs`.

### 6.1 Step Logger Behavior

```typescript
function makeStepLogger(db, userId, correlationId, action)
// Returns: { step(name, fn), records[] }
```

Every step wraps its logic in `step(name, async () => { return { status, result?, reason?, meta? } })`.

Status values and their HTTP codes logged:
- `HIT` → 200 (cache hit)
- `OK` → 200 (found something)
- `SKIP` → 204 (precondition not met, not an error)
- `MISS` → 404 (ran but found nothing)
- `FAIL` → 500 (threw or errored)

### 6.2 Waterfall State Object (`WaterfallResult`)

```typescript
interface WaterfallResult {
  email: string | null
  emailStatus: 'found' | 'uncertain' | 'not_found'
  source: 'haiku+verifier' | 'google_cse' | 'apollo' | 'none'
  title: string | null   // Apollo may return a title
  domain: string | null
}
```

### 6.3 Full Waterfall Sequence

---

#### STEP 0 — Cache Check
**Step name**: `cache`
**Table**: `saved_profiles`
**Logic**:
- Query: `WHERE user_id = $user AND linkedin_url = $url AND (is_bookmarked = true OR enriched_at >= now() - 30 days)`
- If a row exists with `full_name` set → return cached result immediately; skip all enrichment steps; no credit deducted.
- Result populates: `work_email`, `personal_email`, `title`, `company`, `title_verified`, `email_status`.
- Draft is still generated fresh (Sonnet call) on cache hit unless status is `not_enough_data`.

**Exit condition**: HIT → return full response with `fromCache: true`

---

#### STEP 1 — Credit Gate
**Not a logged step** — runs immediately after cache MISS.
- Calls `db.rpc('deduct_credit', { p_user_id: user.id })`
- Returns `true` (credit deducted) or `false` (limit reached)
- On `false`: return HTTP 402 `CREDIT_LIMIT_REACHED`
- On RPC error: return HTTP 500 `CREDIT_ERROR`

---

#### STEP 2 — Haiku Email Guess
**Step name**: `haiku_email_guess`
**Function**: `haikuEmailGuess(fullName, companyName, domain, anthropicKey)`
**Model**: `claude-haiku-4-5`, max 250 tokens

**Prompt structure**:
- Asks Claude to guess the person's work email domain (if not already known) and generate 2–3 candidate email addresses.
- Returns JSON: `{ domain: "example.com", candidates: ["a@example.com", ...], confidence: 0.0–1.0 }`
- Common patterns guessed: `firstname.lastname`, `flastname`, `firstname`

**Candidate filtering**:
- All candidates must end with `@{inferredDomain}` — non-matching candidates are dropped.
- If Haiku returns 0 usable candidates, `defaultPatterns()` generates deterministic fallbacks:
  - `first.last@domain`
  - `f + last@domain`
  - `first@domain`

**Output**: sets `workingDomain` and `haikuCandidates[]`

**Skip conditions**: no `ANTHROPIC_API_KEY`, no `fullName`

---

#### STEP 3 — Google CSE Email Search
**Step name**: `google_cse`
**Function**: `googleCseFindEmail(fullName, companyName, domain, googleKey, googleCx)`

**Query**: `"Full Name" CompanyName "@domain.com"`
**Results**: 5 results (`num=5`)
**Extraction**: regex across all title + snippet + link text
**Priority**: domain-matching email preferred; returns immediately if found (does NOT verify via MEV)

**Exit condition**: if `cseEmail` is found → return `WaterfallResult` with `source: 'google_cse'`, `emailStatus: 'found'`

> **Known gap**: `num=5` is lower than the domain-finder call; bumping to `num=10` would surface more signal. Also, the regex does not deobfuscate `[at]`/`(at)` patterns from contact pages.

**Skip conditions**: no `GOOGLE_API_KEY`, no `GOOGLE_CX`, no `fullName`

---

#### STEP 4 — MyEmailVerifier on Haiku Candidates
**Step name**: `myemailverifier`
**Function**: `myEmailVerifierValidate(email, key)`

**Logic**: iterates `haikuCandidates[]` sequentially; calls MEV on each one.
- If `valid` → exit immediately with that email; source = `haiku+verifier`
- If `invalid` → continue to next candidate
- If `risky` or `unknown` → continue to next candidate (these may indicate catch-all domain)
- If all candidates exhausted → MISS

**Exit condition**: first `valid` result → return `WaterfallResult` with `source: 'haiku+verifier'`

**Skip conditions**: no `MYEMAILVERIFIER_API_KEY`, `haikuCandidates` is empty

---

#### STEP 5 — Apollo People Match
**Step name**: `apollo`
**Function**: `apolloPeopleMatch(fullName, companyName, domain, apolloKey)`
**Endpoint**: `POST https://api.apollo.io/api/v1/people/match`

**Payload**:
```json
{
  "first_name": "...",
  "last_name": "...",
  "domain": "...",
  "organization_name": "...",
  "reveal_personal_emails": false
}
```

**Response handling**: `data.person.email` — sentinel values `email_not_unlocked` and `domain_catch_all` are filtered out and treated as null.
**Bonus**: Apollo also returns `person.title` which backfills `providerTitle` if not already set from earlier steps.

**Exit condition**: non-null, non-sentinel email → return `WaterfallResult` with `source: 'apollo'`

**Skip conditions**: no `APOLLO_API_KEY`, no `fullName`

---

#### STEP 6 — FullEnrich (Last Resort)
**Step name**: `fullenrich_v2`
**Function**: `enrichWithLinkedInV2(linkedinUrl, fullenrichKey)`

**Triggered only if**: `selectedEmail` is still null OR `fullName` is still empty after Steps 2–5.
**Input**: LinkedIn URL (the most authoritative identifier)
**Polling**: 3s initial wait, then 5s intervals, max 22 polls (55s total). Throws `FullEnrich timeout` if not complete.

**Data extracted**:
- `work_email`, `personal_email`
- `full_name` (backfills if unknown)
- `title`, `company`, `company_domain`

**Email status**:
- `work_email` present → `emailStatus = 'found'`
- Only `personal_email` → `emailStatus = 'uncertain'`
- Neither → `emailStatus = 'not_found'`

**Side effect**: immediately upserts a partial result to `saved_profiles` (so if the function times out later, the data isn't lost).

**Skip condition**: `FULLENRICH_API_KEY` not set, or email already found in Steps 2–5.

---

#### POST-WATERFALL — Company & Title Resolution

After all waterfall steps:

1. **Employer resolution from email domain** (`resolveEmployer()`):
   - If email was found but `company` is still null, extracts domain from email and looks up `company_domains` table.
   - Cache hit: returns immediately.
   - Hardcoded map includes: Google, Microsoft, Apple, Amazon, Meta, Salesforce, IBM, Oracle, Adobe, Stripe, OpenAI, Anthropic, etc.
   - Cache miss: calls Haiku to infer company from domain. Stores result in `company_domains`.

2. **Title inference fallback** (`inferTitleFallback()`):
   - Called only if `title` is still null and `company` is known.
   - Uses Haiku with explicit instruction to use only non-LinkedIn sources (press releases, SEC filings, Crunchbase, conference bios).
   - Confidence capped at 0.6; only used if confidence ≥ 0.25.
   - Sets `titleVerified = false` (shown in UI as "inferred, not confirmed").

---

#### FINAL — Draft Generation
**Step name**: `sonnet_draft`
**Function**: `generateDraft(fullName, company, title, titleVerified, email, userContext, draftConf, anthropicKey, recruiterProfile)`
**Model**: `claude-sonnet-4-5`, max 500 tokens

**Prompt injects**:
- Candidate: name, company, title (with verified vs. inferred flag)
- Recruiter profile (from `recruiter_profiles` table): name, company, title, hiring_focus, tone
- Email (if found)
- User context (free-text recruiter notes)
- Draft confidence level (changes tone — low confidence = more generic)

**Hard rules in prompt**:
- No mention of "I saw your profile" or LinkedIn
- No exclamation marks
- No invented achievements
- Exactly one soft CTA
- Sign-off format: `Best,
{recruiter_name}
{title} at {company}`

**Draft confidence formula**:
```
draftConfidence = (personConf × 0.35) + (companyConf × 0.20) + (titleConf × 0.20) + (emailConf × 0.15) + (contextConf × 0.10)
```
Where:
- `emailConf` = 1.0 (found), 0.5 (uncertain), 0 (not_found)
- `contextConf` = min(1, userContextLength / 100)

**Output status**:
- `success` — email + company found
- `partial` — missing email OR title confidence < 0.30
- `not_enough_data` — no email AND no company (draft not attempted)

---

## 7. All Edge Function Actions

| Action | Description |
|---|---|
| `enrich-and-draft` | Default. Single LinkedIn profile enrichment + outreach draft. |
| `summarize-job` | Takes raw job posting text; returns 3–5 bullet highlights via Haiku. |
| `bookmark-profile` | Sets `is_bookmarked = true/false` on `saved_profiles`. |
| `check-saved-profile` | Returns cached profile data if within 30-day window or bookmarked. |
| `get-saved-profiles` | Returns all bookmarked profiles for the current user (max 20). |
| `save-job` | Upserts a job into `saved_jobs` by `user_id + label`. |
| `get-saved-jobs` | Returns all saved jobs for current user (max 30, ordered by updated_at). |
| `delete-job` | Deletes a saved job by ID (scoped to user). |
| `import-campaign` | Creates a campaign + bulk inserts candidate rows from CSV data. Checks credit balance and warns if insufficient for all candidates. |
| `get-campaigns` | Returns all campaigns for user with joined `saved_jobs` data (max 50). |
| `get-campaign-candidates` | Returns candidates for a campaign, optionally filtered by status (max 200). |
| `enrich-campaign-candidate` | Runs the full waterfall on a single campaign candidate. Deducts 1 credit. Uses cache if available. |
| `draft-campaign-candidate` | Generates a Sonnet draft for an already-enriched campaign candidate. Uses job context from linked saved_job. |
| `update-candidate-status` | Sets candidate status to `approved`, `skipped`, `imported`, `enriched`, or `drafted`. |
| `link-campaign-job` | Associates a `saved_job` with a campaign; sets campaign status to `ready`. |
| `delete-campaign` | Deletes a campaign (candidates cascade-deleted via FK). |

---

## 8. Auth & Security

- **Auth method**: Supabase Auth with Google OAuth.
- **Token flow**: Extension sends `Authorization: Bearer {session.access_token}` on every Edge Function call. Backend calls `db.auth.getUser(token)` to validate. Returns 401 `AUTH_EXPIRED` if invalid.
- **Session refresh**: `core/api.js` handles 401 by calling `supabase.auth.refreshSession()` and retrying once.
- **OAuth redirect URL**: `chrome-extension://oekidhmjmaknllpbdagiffepogjgkjdj/auth.html` — must be in Supabase Auth → URL Configuration → Redirect URLs.
- **RLS**: All tables have RLS enabled except `company_domain_hints` (see Section 4.3 for security warning).
- **Service role key**: used only server-side in the Edge Function. Never exposed to the extension.

---

## 9. Credits & Billing

### Credit Flow
1. Extension calls `enrich-and-draft` or `enrich-campaign-candidate`.
2. Backend checks `saved_profiles` cache first (free).
3. On cache MISS: calls `db.rpc('deduct_credit', { p_user_id })`.
4. RPC returns `true` (deducted) or `false` (limit reached).
5. On limit reached: HTTP 402 returned; extension shows upgrade paywall.

### Tier Limits (from extension config)
| Tier | Lookups |
|---|---|
| free | 10 |
| sourcer | 50 |
| pro | 200 |

### Stripe Integration
- Stripe customer + subscription IDs stored in `credits` table.
- `create-checkout` function handles Stripe Checkout session creation.
- Live Stripe price IDs are hardcoded in `extension/config.js` — do not change without instruction.

---

## 10. Known Issues & Active Blockers

### 10.1 ⚠️ RLS Disabled on `company_domain_hints`
**Status**: Open security gap
**Impact**: Any authenticated (or anon-key) user can read/write all domain hint records.
**Fix**: Enable RLS and add appropriate policies. Do not auto-apply — need to define whether this table should be public-read or user-scoped.

### 10.2 Google CSE Returns Only 5 Results
**Status**: Known optimization gap
**Impact**: Lower email discovery rate from OSINT search step.
**Fix**: Change `num=5` to `num=10` in `googleCseFindEmail()`. One-line change.

### 10.3 Google CSE Does Not Deobfuscate `[at]` Patterns
**Status**: Known gap
**Impact**: Emails written as `name [at] company dot com` on contact pages are not extracted.
**Fix**: Add a pre-processing step in `googleCseFindEmail()` that converts `[at]` → `@` and `(dot)` → `.` before running the regex.

### 10.4 `recruiter_profiles` Table Has 0 Rows
**Status**: Migration applied but no UI onboarding to populate it yet.
**Impact**: Draft generation runs without recruiter context (no personalized sign-off, no tone, no hiring focus).
**Fix**: Build recruiter onboarding flow in the extension popup to collect and save recruiter profile data.

### 10.5 `company_domain_hints` RLS Not Enabled
**Status**: See 10.1 above. This table also has no user scoping — it is a global shared lookup table by design, but should still have RLS to prevent unauthorized writes.

### 10.6 Apollo GOOGLE_CSE_KEY vs GOOGLE_CX Variable Name
**Status**: Minor naming inconsistency
**Detail**: The code reads `Deno.env.get('GOOGLE_CX')`. Earlier documentation and prior handoffs referred to this as `GOOGLE_CSE_KEY` or `GOOGLE_CSE_CX`. The correct secret name in production must be `GOOGLE_CX`.

### 10.7 FullEnrich 55-Second Polling Timeout
**Status**: Architectural constraint
**Impact**: Supabase Edge Functions have a maximum execution time. If FullEnrich takes longer than 55s to respond, the function throws and the enrichment is lost. The early partial upsert to `saved_profiles` mitigates data loss but the user gets an error.
**Mitigation in place**: Early `saved_profiles` upsert after FullEnrich start (before polling completes) is not yet implemented — the upsert only runs after a successful FINISHED poll.

---

## 11. Deployment

### 11.1 Deploy Edge Function
```bash
supabase functions deploy enrich-and-draft --project-ref szxjcitbjcpkhxtjztay
```

### 11.2 Set Secrets
```bash
supabase secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  GOOGLE_API_KEY=AIza... \
  GOOGLE_CX=... \
  MYEMAILVERIFIER_API_KEY=... \
  APOLLO_API_KEY=... \
  FULLENRICH_API_KEY=... \
  --project-ref szxjcitbjcpkhxtjztay
```

> `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the Supabase runtime.

### 11.3 Run Migrations
```bash
supabase db push --project-ref szxjcitbjcpkhxtjztay
```

### 11.4 Load Extension in Chrome (Dev)
1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked"
4. Select the repo root (where `manifest.json` lives)
5. Confirm Extension ID is `oekidhmjmaknllpbdagiffepogjgkjdj`

---

## 12. Response Shape Reference

### 12.1 Successful `enrich-and-draft` Response
```json
{
  "status": "success | partial | not_enough_data",
  "fromCache": false,
  "isBookmarked": false,
  "runId": "uuid",
  "person": {
    "fullName": "Jane Smith",
    "company": "Acme Corp",
    "title": "VP Engineering",
    "titleVerified": true,
    "email": "jane.smith@acme.com",
    "workEmail": "jane.smith@acme.com",
    "personalEmail": null,
    "emailStatus": "found"
  },
  "confidence": {
    "personConfidence": 0.95,
    "companyConfidence": 0.9,
    "titleConfidence": 0.9,
    "draftConfidence": 0.89
  },
  "sources": [
    { "type": "haiku+verifier", "label": "Email via haiku+verifier", "confidence": 0.85 }
  ],
  "draft": {
    "subject": "Reaching out — Jane Smith",
    "body": "Hi Jane, ..."
  },
  "debug": {
    "correlationId": "a1b2c3d4",
    "records": [
      { "step": "cache", "status": "MISS", "ms": 45 },
      { "step": "haiku_email_guess", "status": "OK", "ms": 820 },
      { "step": "google_cse", "status": "MISS", "ms": 310 },
      { "step": "myemailverifier", "status": "OK", "ms": 1200 },
      { "step": "apollo", "status": "SKIP", "ms": 0 },
      { "step": "fullenrich_v2", "status": "SKIP", "ms": 0 },
      { "step": "sonnet_draft", "status": "OK", "ms": 2100 }
    ]
  }
}
```

### 12.2 Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `AUTH_EXPIRED` | 401 | Invalid or missing Bearer token |
| `CREDIT_LIMIT_REACHED` | 402 | User has hit their tier lookup limit |
| `MISSING_INPUT` | 400 | Required field missing in request body |
| `NO_LINKEDIN_URL` | 400 | `enrich-and-draft` called without `linkedinUrl` |
| `NOT_ENOUGH_DATA` | 422 | Could not identify the person (no name resolved) |
| `CREDIT_ERROR` | 500 | `deduct_credit` RPC failed |
| `DRAFT_GENERATION_FAILED` | 500 | Enrichment succeeded but Sonnet draft returned null |
| `UNKNOWN_ACTION` | 400 | Unrecognized `action` value in request body |
| `UNKNOWN_ERROR` | 500 | Unhandled exception in main handler |
| `DB_ERROR` | 500 | Database write failed |
| `NOT_FOUND` | 404 | Campaign candidate not found or not owned by user |

---

*End of handoff document.*
