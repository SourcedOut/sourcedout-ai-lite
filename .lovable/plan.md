## What I found
I inspected your latest debug CSV and the current backend code. The failure is now specific and identifiable:

- For correlation `ea733140`, the backend logged:
  - `company_discovery` → candidate = `Waymo`
  - source = `prior_run`
  - then `resolve_domain` → `waymo.com`
- But the same run later called FullEnrich for `https://www.linkedin.com/in/darrensnelson/` and FullEnrich returned a profile whose current companies included **Recruits Lab / BioJobs Lab**, not Waymo.

So the system is no longer failing because "company is null".
It is now failing because it is injecting the **wrong company**.

## Root cause
The current single-profile discovery logic reads the **most recent company from `outreach_runs` for the user**, with no match to the LinkedIn URL or person:

- `supabase/functions/enrich-and-draft/index.ts`
  - current code selects the latest `outreach_runs.company`
  - then feeds that into `discoverCompanyCandidates()` as `priorRun`

That means if your last successful lookup was someone at Waymo, the next completely different person can inherit `Waymo` as their candidate company.

That causes 3 bad outcomes:
1. The `NEED_COMPANY` guard does **not** trigger, because a fake candidate exists.
2. The cheap waterfall runs against the wrong domain.
3. A credit can still be spent before the system learns the real employer from FullEnrich.

## Secondary gap I found
Batch/CSV was not fully fixed the way we intended.

In the current batch path:
- `discoverCompanyCandidates()` is called with:
  - `cached: null`
  - `priorRun: null`
- so batch is still mostly limited to:
  - CSV `current_company`
  - `enriched_company`
  - optional Google snippet discovery

That means the batch path is **not yet using saved-profile history or person-specific prior knowledge** the way the approved plan said it would.

## What I will change specifically

### 1) Remove the unsafe global prior-run fallback
**File:** `supabase/functions/enrich-and-draft/index.ts`

I will delete the current behavior that uses the user's latest `outreach_runs.company` as a generic fallback for unrelated profiles.

Instead:
- single-profile discovery will only use company sources tied to the same person/profile
- no cross-profile company inheritance

This is the main bug fix.

### 2) Replace it with person-scoped discovery only
**File:** `supabase/functions/enrich-and-draft/index.ts`

I will add a safer candidate builder that only accepts sources with a real link to the current profile:
- manual company entered by the user
- company scraped from the current LinkedIn page
- `saved_profiles.company` for the **same `linkedin_url`**
- company extracted from `saved_profiles.raw_data.employment` for the **same `linkedin_url`**
- batch row fields (`current_company`, `enriched_company`, CSV email domain)
- Google snippet discovery, when keys exist

I will not use a generic “last company you looked up” fallback anymore.

### 3) Add confidence rules so weak guesses cannot bypass the guard
**File:** `supabase/functions/enrich-and-draft/index.ts`

Right now any discovered candidate can unblock the run.
I will add a minimum-confidence rule:

- high-confidence sources: manual, scrape, same-profile cache
- medium-confidence: same-profile raw employment, domain-mapped company
- low-confidence: weak snippet extraction

If only weak candidates exist, the backend will return `NEED_COMPANY` instead of silently picking one.

That prevents:
- wrong-company waterfall attempts
- credit spend on weak guesses

### 4) Make batch/CSV use the same safe discovery inputs
**File:** `supabase/functions/enrich-and-draft/index.ts`

I will finish the batch fix so `runEnrichmentJob` actually uses:
- candidate `current_company`
- candidate `enriched_company`
- company inferred from `csv_email` domain
- same-profile `saved_profiles.company`
- same-profile `saved_profiles.raw_data.employment`
- optional Google snippet discovery

This closes the gap between the approved plan and the current implementation.

### 5) Add a person-safe company extractor from cached raw profile data
**File:** `supabase/functions/enrich-and-draft/index.ts`

The code already stores raw enrichment payloads in `saved_profiles.raw_data`.
I will add a helper that extracts likely current employers from:
- `employment.current`
- current entries in `employment.all`
- company names + domains when present

This gives us a free, profile-specific discovery source that is much safer than `prior_run`.

### 6) Tighten logging so the next CSV makes the problem obvious
**File:** `supabase/functions/enrich-and-draft/index.ts`

I will expand the log metadata for `company_discovery` and each waterfall candidate to include:
- source type
- whether the source is person-scoped or global
- whether it passed the minimum-confidence threshold
- why `NEED_COMPANY` fired or did not fire

So next time we will be able to distinguish:
- no company found
- weak company guess rejected
- strong company candidate accepted
- wrong candidate came from which source

## Expected behavior after this fix
For Darren Nelson-like cases:
- the system will **not** reuse `Waymo` from a previous lookup
- if it has no person-specific company, it will ask for company instead of guessing
- if cached raw data for that same LinkedIn URL exists, it will use that safely
- FullEnrich remains last

For CSV/batch:
- the job will use the row’s own data plus same-profile cache data
- it will stop relying on thin or missing company fields alone

## Technical details

### Files to update
- `supabase/functions/enrich-and-draft/index.ts`

### Main code changes
- remove generic `outreach_runs` latest-company fallback
- add person-scoped company extraction from `saved_profiles.raw_data`
- add candidate confidence threshold / guard
- complete batch discovery wiring
- enrich logging

### What I will not change
- FullEnrich ordering — it stays last
- popup UX unless needed for a new weak-candidate message

## Acceptance criteria
- A profile can no longer inherit another candidate’s company from the last run
- `NEED_COMPANY` triggers when only weak/untrusted company guesses exist
- Single-profile enrichment only uses person-scoped company sources
- Batch enrichment uses cached same-profile company sources too
- Logs clearly show why a company was accepted or rejected

If you approve, I’ll implement this exact fix next.