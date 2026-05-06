# Anthropic-First Haiku Improvements for SourcedOut Waterfall

## Goal

Make Claude Haiku the **primary reasoning engine** in the enrichment waterfall.
Haiku is cheap (~$0.0001–0.0003 per call). The more work Haiku can do correctly,
the less you spend on Google, Brave, PDL, and FullEnrich.

The improvements below are ordered by impact and implementation complexity.

---

## Current Haiku behavior (baseline)

The current `haikuEmailGuess()` function does two things in one prompt:
1. Infers the likely corporate email domain if one is not known
2. Returns 2–3 likely work email candidates at that domain

It then falls through to `myemailverifier_haiku`, and if that misses, the
waterfall immediately escalates to Google, Brave, and PDL.

This is a solid start but does not fully exploit how much reasoning Haiku can do
before touching paid search or enrichment providers.

---

## Improvement 1: Split domain inference from email pattern inference

### Why
Mixing two reasoning problems in one prompt lowers Haiku's accuracy on both.
Separating them produces cleaner outputs, caches better, and is easier to debug.

### What to do

Replace `haikuEmailGuess()` with two functions:

#### `haikuResolveDomain(fullName, companyName, linkedinUrl)`

```ts
const prompt = `
You are inferring the primary corporate email domain for a company.
Person: ${fullName}
Company: ${companyName ?? 'unknown'}
LinkedIn URL hint: ${linkedinUrl ?? 'none'}

Rules:
- Return the main company website domain only (e.g. stripe.com, not mail.stripe.com)
- Do NOT return a marketing subdomain or regional variant
- If you cannot determine with reasonable confidence, return domain: null
- Return ONLY JSON: { "domain": "example.com" or null, "confidence": 0.0–1.0 }
`
```

Model: `claude-haiku-4-5`
Max tokens: `80`

#### `haikuRankEmailCandidates(fullName, domain)`

```ts
const prompt = `
You are ranking the most likely work email patterns for a person at a specific company domain.
Person: ${fullName}
Domain: ${domain}

Choose from this ranked candidate universe in order of most likely first:
- first.last@domain
- flast@domain
- first@domain
- firstlast@domain
- last.first@domain
- first_last@domain
- f.last@domain
- lastf@domain
- firstl@domain

Rules:
- Return 5 candidates maximum, most likely first
- All candidates MUST use the exact domain provided
- Use common corporate email conventions based on company size and industry
- Include a pattern label for each candidate
- Return ONLY JSON:
{
  "candidates": [
    { "email": "john.smith@example.com", "pattern": "first.last", "confidence": 0.0–1.0 },
    ...
  ],
  "confidence": 0.0–1.0
}
`
```

Model: `claude-haiku-4-5`
Max tokens: `300`

### Benefits
- Domain inference can be **cached by company name** — never infer the same domain twice
- Email pattern ranking can be **cached by domain** — reuse pattern knowledge across candidates
- Each step is smaller, faster, and cheaper than the combined prompt
- Easier to log and debug separately in `enrichment_debug_logs`

### Step names in waterfall
```
haiku_resolve_domain      ← replaces part of haiku_email_guess
haiku_rank_candidates     ← replaces part of haiku_email_guess
myemailverifier_haiku     ← unchanged, now verifies up to 5 candidates instead of 3
```

---

## Improvement 2: Expand from top 3 to top 5 candidates

### Why
The current prompt explicitly limits Haiku to 2–3 candidates. Many companies use
less common patterns that get excluded. Since MEV is the cost driver (not Haiku),
expanding to 5 candidates adds almost zero cost to the Haiku step itself.

### What to do
- Change the prompt instruction from "Provide 2–3 candidates" to "Provide 5 candidates"
- Update the `.slice(0, 3)` limit in code to `.slice(0, 5)`
- Update `myemailverifier_haiku` to loop over up to 5 candidates (it already loops, just change the limit)

### Pattern universe to give Haiku
Always supply this full ordered list so Haiku ranks from known patterns instead of
improvising:

```
first.last       → john.smith@domain.com
flast            → jsmith@domain.com
first            → john@domain.com
firstlast        → johnsmith@domain.com
last.first       → smith.john@domain.com
first_last       → john_smith@domain.com
f.last           → j.smith@domain.com
lastf            → smithj@domain.com
firstl           → johns@domain.com
```

---

## Improvement 3: Domain pattern memory (company-level cache)

### Why
Every time you successfully verify a work email, you know the email pattern that
company uses. That is extremely valuable signal for future candidates at the same company.

Currently this knowledge is lost after each enrichment run.

### What to do

#### Step A: Create a `company_email_patterns` table in Supabase

```sql
create table company_email_patterns (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique,
  verified_pattern text not null,       -- e.g. 'first.last'
  sample_email text,                    -- masked e.g. 'j***@company.com'
  confidence float default 1.0,
  verified_count int default 1,
  last_verified_at timestamptz default now(),
  created_at timestamptz default now()
);
```

#### Step B: After any successful `myemailverifier_*` step, upsert the pattern

```ts
// After MEV returns a verified email
const pattern = detectPattern(verifiedEmail, fullName)
if (pattern) {
  await db.from('company_email_patterns').upsert({
    domain: workingDomain,
    verified_pattern: pattern,
    sample_email: maskEmail(verifiedEmail),
    verified_count: db.raw('verified_count + 1'),
    last_verified_at: new Date().toISOString()
  }, { onConflict: 'domain' })
}
```

#### Step C: Add a `haiku_pattern_cache` step before `haiku_rank_candidates`

```ts
await step('haiku_pattern_cache', async () => {
  const { data } = await db
    .from('company_email_patterns')
    .select('verified_pattern, confidence, verified_count')
    .eq('domain', workingDomain)
    .maybeSingle()

  if (data) {
    // We already know this company's pattern — skip Haiku, go straight to MEV
    cachedPattern = data.verified_pattern
    return { status: 'HIT', meta: { pattern: data.verified_pattern, count: data.verified_count } }
  }
  return { status: 'MISS' }
})
```

If pattern cache hits, generate the candidate from the known pattern and skip
`haiku_rank_candidates` entirely. This is the cheapest possible win.

#### Helper: `detectPattern(email, fullName)`

```ts
function detectPattern(email: string, fullName: string): string | null {
  const { first, last } = splitName(fullName)
  const f = sanitizeLocal(first)
  const l = sanitizeLocal(last)
  const local = email.split('@')[0].toLowerCase()

  if (local === `${f}.${l}`) return 'first.last'
  if (local === `${f[0]}${l}`) return 'flast'
  if (local === f) return 'first'
  if (local === `${f}${l}`) return 'firstlast'
  if (local === `${l}.${f}`) return 'last.first'
  if (local === `${f}_${l}`) return 'first_last'
  if (local === `${f[0]}.${l}`) return 'f.last'
  if (local === `${l}${f[0]}`) return 'lastf'
  if (local === `${f}${l[0]}`) return 'firstl'
  return null
}
```

### Benefits
- Over time, cached patterns will short-circuit Haiku calls for repeat companies
- For large campaigns (many candidates at same company), this is a massive cost and speed win
- Patterns persist across campaigns, users, and enrichment runs
- Step logs will show `haiku_pattern_cache HIT` vs `MISS` clearly

---

## Improvement 4: Haiku refinement round after Google/Brave evidence

### Why
Right now, after Google and Brave gather snippets, partial emails, and domains,
that evidence is used directly for MEV verification. But Haiku could act as a
cheap reasoning layer on top of that evidence to produce better-ranked candidates
before paying for PDL.

### What to do

Add a new step `haiku_refine_candidates` between `brave_search` and
`pdl_person_enrichment`:

```ts
await step('haiku_refine_candidates', async () => {
  if (!anthropicKey) return { status: 'SKIP', reason: 'noanthropickey' }
  if (mergedCandidates.length === 0 && !workingDomain) return { status: 'SKIP', reason: 'nosignal' }

  const prompt = `
You are refining a list of likely work email candidates based on research evidence.

Person: ${fullName}
Company: ${companyName ?? 'unknown'}
Domain: ${workingDomain ?? 'unknown'}

Evidence collected so far:
- Partial emails found in web search: ${partialEmails.join(', ') || 'none'}
- Domains seen in snippets: ${domainsFromSearch.join(', ') || 'none'}
- Existing candidates to re-rank: ${mergedCandidates.slice(0, 6).join(', ') || 'none'}

Task:
1. If a domain is unclear, infer the most likely one from evidence
2. Produce the top 5 most likely work email candidates using evidence + common patterns
3. Order by confidence, most likely first

Return ONLY JSON:
{
  "domain": "example.com" or null,
  "candidates": ["a@example.com", "b@example.com", ...],
  "confidence": 0.0–1.0,
  "reasoning": "one short sentence"
}
`
  const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 350, prompt)
  const p = parseJson(raw)
  // Merge Haiku refinements at front of candidate queue
  refinedCandidates = p.candidates ?? []
  return {
    status: refinedCandidates.length > 0 ? 'OK' : 'MISS',
    meta: { n: refinedCandidates.length, domain: p.domain, confidence: p.confidence }
  }
})
```

Then run `myemailverifier_search_candidates` on the merged set:
`[...refinedCandidates, ...pdlWorkEmails, ...googleEmails, ...braveEmails, ...pdlPersonalEmails]`

### Benefits
- Haiku adds a reasoning layer on top of raw OSINT evidence
- Synthesizes partial emails, domain variants, and pattern guesses into ranked candidates
- Runs before PDL, potentially avoiding a PDL call entirely
- Costs ~$0.0002 per run

---

## Improvement 5: Haiku title inference for better draft personalization

### Why
The current `inferTitleFallback()` already uses Haiku for title inference, but it
is capped at 0.6 confidence and only used when no title was found by other means.
[file:145]

This is the right behavior. One enhancement: pass the Haiku-inferred title to the
draft generation prompt with a `caution` flag so Sonnet knows not to assert the
title as fact.

### What to confirm with Replit
Confirm the existing `inferTitleFallback()` output is passed to `generateDraft()`
with `titleVerified: false` so the Sonnet prompt uses the appropriate caution
instruction (`reference it cautiously without claiming certainty`).

This already appears to be in the code but worth verifying the confidence threshold
and `titleVerified` flag are being applied correctly.

---

## Recommended new Haiku-first waterfall order

```
STEP 1:  cache                          → HIT = done immediately
STEP 2:  haiku_pattern_cache            → HIT = known company pattern, skip Haiku
STEP 3:  haiku_resolve_domain           → cheap domain inference
STEP 4:  haiku_rank_candidates          → 5 ranked candidates from known pattern universe
STEP 5:  myemailverifier_haiku          → early exit if any candidate validates
                                          (cheapest possible win: 2 Haiku calls + MEV)

         ── if no win above ──

STEP 6:  google_search                  → 5 OSINT queries, collect emails/domains
STEP 7:  brave_search                   → 5 OSINT queries, extra_snippets=true
STEP 8:  haiku_refine_candidates        → synthesize evidence → 5 refined candidates
STEP 9:  myemailverifier_search_round1  → verify Haiku-refined candidates

         ── if no win above ──

STEP 10: pdl_person_enrichment          → structured API
STEP 11: myemailverifier_search_round2  → verify all merged candidates (PDL + search)

         ── if no win above ──

STEP 12: fullenrich_v2                  → last resort
STEP 13: post_fullenrich_retry          → conditional, only if new name/domain returned

STEP 14: sonnet_draft                   → always runs if enrichment succeeded
```

### Anthropic calls in this flow
| Step | Model | ~Cost per call |
|---|---|---|
| haiku_resolve_domain | claude-haiku-4-5 | ~$0.00005 |
| haiku_rank_candidates | claude-haiku-4-5 | ~$0.00015 |
| haiku_refine_candidates | claude-haiku-4-5 | ~$0.00020 |
| inferTitleFallback | claude-haiku-4-5 | ~$0.00010 |
| sonnet_draft | claude-sonnet-4-5 | ~$0.00150 |
| **Total Anthropic (full run)** | | **~$0.00200** |

Compared to:
- PDL: ~$0.01 per enrichment
- FullEnrich: ~$0.50 per enrichment
- Google CSE: ~$0.005 per query × 5 = $0.025
- Brave: ~$0.005 per query × 5 = $0.025

**Anthropic is 5–250× cheaper per step than any other provider.**
Maximizing Haiku coverage before escalating to search/enrichment providers is
the single highest-leverage cost optimization available.

---

## Summary of changes to ask Replit to implement

### Priority 1 (high impact, low complexity)
- [ ] Expand Haiku candidates from top 3 to top 5
- [ ] Supply a fixed pattern universe to rank from (list above)
- [ ] Update `myemailverifier_haiku` to loop over up to 5 candidates

### Priority 2 (high impact, medium complexity)
- [ ] Split `haikuEmailGuess` into `haiku_resolve_domain` + `haiku_rank_candidates`
- [ ] Add `haiku_refine_candidates` step between `brave_search` and `pdl_person_enrichment`
- [ ] Run `myemailverifier` on refined candidates before PDL

### Priority 3 (high long-term impact, requires schema change)
- [ ] Create `company_email_patterns` table in Supabase
- [ ] Add `detectPattern()` helper
- [ ] Add `haiku_pattern_cache` step at top of waterfall
- [ ] Upsert verified patterns after any successful MEV verification

### Do not change
- [ ] `callAnthropic()` retry logic (429, 3 attempts, 1.5s/3s backoff) — keep as-is
- [ ] `inferTitleFallback()` — keep as-is, just verify `titleVerified` flag flows correctly
- [ ] `generateDraft()` Sonnet call — keep as-is
- [ ] `makeStepLogger()` — all new Haiku steps must use it, same as existing steps
- [ ] `correlationId` — must span all new Haiku steps

---

## Final note to Replit

Haiku is the most cost-efficient tool in the stack. The current implementation
uses it as a thin first-pass guesser. The goal is to use it as a full reasoning
layer — doing domain inference, pattern ranking, evidence synthesis, and title
inference — before escalating to any paid search or enrichment provider.

Every time Haiku + MEV finds a verified email, you save:
- ~$0.025 in Google/Brave search costs
- ~$0.01 in PDL costs
- ~$0.50 in FullEnrich costs

The pattern cache improvement compounds over time — as more campaigns run,
the hit rate on `haiku_pattern_cache` grows and the average cost per
enrichment drops.
