# PDL Instructions for Replit

## Goal

Use **People Data Labs Person Enrichment API** as the only PDL endpoint for the first version of the new SourcedOut enrichment waterfall.

Do **not** use:
- Person Search API
- Person Identify API
- Company Enrichment API

Those can be added later if needed, but they are not part of the first implementation.

## Why

SourcedOut is doing **single-person targeted enrichment**, not broad dataset search.

That means the correct PDL product for this use case is:
- **Person Enrichment API** = best for one person when we already have likely identifying information.

It should be treated as a structured enrichment step, not as a search engine replacement.

## Where PDL sits in the waterfall

The waterfall order should be:

1. Cache
2. Claude Haiku guess
3. MyEmailVerifier on top Haiku candidates only
4. Google Search API using OSINT Boolean queries
5. Brave Search API using OSINT Boolean queries
6. **PDL Person Enrichment API**
7. MyEmailVerifier on any new email candidates returned by Google, Brave, or PDL
8. FullEnrich last resort
9. Claude Sonnet draft

## How Replit should implement PDL

### Rule 1
Use **PDL Person Enrichment API only**.

### Rule 2
PDL should run **after** Google and Brave, not before them.

### Rule 3
PDL should use the strongest available person identifiers in this priority order:

1. LinkedIn URL / profile URL
2. Full name + company
3. Full name + company domain
4. Full name + location

If LinkedIn URL exists, it should be included in the request as the highest-priority identifier.

### Rule 4
PDL is allowed to return:
- work email
- personal email
- mobile phone
- socials
- title
- company
- company domain

### Rule 5
If PDL returns one or more email addresses, those emails must go through **MyEmailVerifier** before any email is accepted as final.

### Rule 6
If PDL returns phone numbers or socials, store them directly. They do not need MyEmailVerifier.

### Rule 7
If PDL returns no useful data, continue to FullEnrich. Do not stop the waterfall early.

## What code Replit should add

Create a dedicated helper called:

```ts
runPdlPersonEnrichment(fullName, company, companyDomain, linkedinUrl, location, pdlApiKey)
```

This helper should:
- build the PDL request payload from the strongest available identifiers
- call the Person Enrichment endpoint
- parse work emails
- parse personal emails
- parse mobile phones
- parse socials
- parse title
- parse company
- parse company domain
- return a normalized object

## Expected normalized return shape

```ts
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
```

## Suggested implementation notes

- Use clear logging so we know exactly when PDL ran and what it returned.
- Log whether the request used LinkedIn URL, company, domain, or location.
- Do not silently swallow PDL errors.
- If PDL returns emails, merge them with Google and Brave email candidates before verification.
- If PDL returns phone numbers, keep them in a separate field from emails.
- If PDL returns socials, preserve them in a structured array.

## Suggested code sketch

```ts
async function runPdlPersonEnrichment(
  fullName: string,
  company: string | null,
  companyDomain: string | null,
  linkedinUrl: string | null,
  location: string | null,
  pdlApiKey: string,
): Promise<PdlPersonEnrichmentResult> {
  const payload: Record<string, unknown> = {}

  if (linkedinUrl) payload.profile = linkedinUrl
  if (fullName) payload.name = fullName
  if (company) payload.company = company
  if (companyDomain) payload.company_domain = companyDomain
  if (location) payload.location = location

  const res = await fetch('https://api.peopledatalabs.com/v5/person/enrich', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': pdlApiKey,
    },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  if (!res.ok) {
    throw new Error(`PDL Person Enrichment error ${res.status}: ${JSON.stringify(data)}`)
  }

  const emails = Array.isArray(data?.data?.emails) ? data.data.emails : []
  const phones = Array.isArray(data?.data?.phone_numbers) ? data.data.phone_numbers : []
  const profiles = Array.isArray(data?.data?.profiles) ? data.data.profiles : []

  const workEmails = emails
    .filter((e: any) => e?.type === 'work' && e?.address)
    .map((e: any) => String(e.address).toLowerCase())

  const personalEmails = emails
    .filter((e: any) => e?.type === 'personal' && e?.address)
    .map((e: any) => String(e.address).toLowerCase())

  const mobilePhones = phones
    .filter((p: any) => (p?.type === 'mobile' || p?.line_type === 'mobile') && p?.number)
    .map((p: any) => String(p.number))

  const socials = profiles
    .map((p: any) => p?.url || p?.profile_url)
    .filter(Boolean)

  return {
    provider: 'pdl_person_enrichment',
    workEmails: Array.from(new Set(workEmails)),
    personalEmails: Array.from(new Set(personalEmails)),
    mobilePhones: Array.from(new Set(mobilePhones)),
    socials: Array.from(new Set(socials)),
    title: data?.data?.job_title || null,
    company: data?.data?.job_company_name || company || null,
    companyDomain: data?.data?.job_company_website || companyDomain || null,
    confidence: typeof data?.data?.likelihood === 'number' ? data.data.likelihood : undefined,
    raw: data,
  }
}
```

## Final instruction to Replit

Implement **PDL Person Enrichment API only** in the first version.

Do not wire up Person Search, Person Identify, or Company Enrichment yet.

PDL should be a structured enrichment layer after Google and Brave, and any emails it returns must still pass through MyEmailVerifier before being accepted.
