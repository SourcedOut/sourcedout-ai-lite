# SourcedOut Search-First Waterfall Plan

## Summary

This plan reverts SourcedOut to a cheaper, search-first enrichment waterfall and removes Apollo from the active path entirely. 

The intended order is now:
1. Cache
2. Claude Haiku guess
3. MyEmailVerifier on top Haiku candidates only
4. Google Search API (OSINT Boolean Queries)
5. Brave Search API (OSINT Boolean Queries)
6. People Data Labs (PDL - Structured Enrichment)
7. MyEmailVerifier on any new candidates
8. FullEnrich last resort
9. Claude Sonnet draft

## Search Strategy & Prompts

### Search Engines (Google & Brave)
Search engines require **OSINT (Open Source Intelligence) Boolean strings** to bypass marketing fluff and find raw contact data. 
- **Resume/PDF query:** Targets resumes and CVs which often contain personal emails and cell phones.
- **Contact Proximity query:** Targets personal blogs and portfolios using footprint phrases like "reach me at".
- **Social/Linktree query:** Scrapes snippets from GitHub, Linktree, and Twitter bios.
- **Exact Domain Pattern:** Forces the search engine to find the exact work email format.
- **Company Directory:** Uses `site:company.com` to find team pages and desk phones.

### People Data Labs (PDL)
Unlike search engines, PDL does **not** use Boolean strings. It uses a structured REST API that relies on **match keys**. To get the best data (personal emails and mobile phones) out of PDL, you must pass the highest-fidelity identifiers you have:
1. **Tier 1 (Deterministic):** LinkedIn URL (`profile`). If you pass a LinkedIn URL, PDL will almost always find the exact person.
2. **Tier 2 (Probabilistic):** Name + Company. 
3. **Tier 3 (Fallback):** Name + Location.
The code below ensures we pass `profile` (LinkedIn URL) whenever available, falling back to name and company.

---

## Replit-ready implementation notes

- Remove Apollo from the live path entirely.
- Keep FullEnrich strictly last.
- Add Brave Search API and PDL as new providers.
- Implement the `buildSearchQueries` function exactly as written to use advanced OSINT Boolean strings.
- Implement the `extractContactInfo` function with the provided Regex to capture BOTH emails and phone numbers from search snippets.
- Use the `profile` (LinkedIn URL) as the primary match key for PDL.
- Log every provider step into `enrichment_debug_logs`.
- Bump `FUNCTION_VERSION` after the rewrite.

---

## Suggested Code

```ts
type SearchEvidence = {
  provider: 'google' | 'brave'
  queries: string[]
  exactEmails: string[]
  phones: string[]
  partialEmails: string[]
  domains: string[]
  snippets: string[]
  urls: string[]
}

type PdlEvidence = {
  provider: 'pdl'
  workEmails: string[]
  personalEmails: string[]
  mobilePhones: string[]
  confidence?: number
  raw?: unknown
}

function buildSearchQueries(fullName: string, company: string | null, domain: string | null): string[] {
  const queries = new Set<string>()
  
  // 1. The Resume/PDF query (Best for personal email & mobile phone)
  queries.add(`"${fullName}" ("resume" OR "cv" OR "portfolio") (filetype:pdf OR filetype:doc OR filetype:docx)`)

  // 2. The Contact Proximity query (Best for personal sites/blogs)
  queries.add(`"${fullName}" ("email" OR "contact" OR "reach me at" OR "cell" OR "mobile")`)

  // 3. The Social/Linktree query (Best for Github/Twitter bio emails)
  queries.add(`"${fullName}" (site:linktr.ee OR site:github.com OR site:twitter.com OR site:x.com)`)

  if (domain) {
    // 4. The Exact Domain Pattern query (Best for finding exact work email format)
    queries.add(`"${fullName}" "@${domain}"`)
    
    // 5. The Company Directory query (Best for team pages & desk phones)
    queries.add(`site:${domain} "${fullName}" ("email" OR "phone" OR "contact")`)
  } else if (company) {
    queries.add(`"${fullName}" "${company}" ("email" OR "phone")`)
  }

  return Array.from(queries).filter(Boolean).slice(0, 5)
}

function extractContactInfo(text: string): { emails: string[], phones: string[] } {
  // Extract standard emails
  const emailMatches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
  
  // Extract North American and International phone numbers (basic OSINT regex)
  const phoneMatches = text.match(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || []

  return {
    emails: Array.from(new Set(emailMatches.map((v) => v.toLowerCase()))),
    phones: Array.from(new Set(phoneMatches.map((v) => v.replace(/[^\d+]/g, ''))))
  }
}

function mergeCandidateSets(...groups: Array<string[] | null | undefined>): string[] {
  return Array.from(new Set(groups.flatMap((g) => g || []).map((v) => v.toLowerCase())))
}

async function runGoogleSearch(
  fullName: string,
  company: string | null,
  domain: string | null,
  googleKey: string,
  googleCx: string,
): Promise<SearchEvidence> {
  const queries = buildSearchQueries(fullName, company, domain)
  const exactEmails = new Set<string>()
  const exactPhones = new Set<string>()
  const snippets: string[] = []
  const urls: string[] = []

  for (const q of queries) {
    const url = new URL('https://www.googleapis.com/customsearch/v1')
    url.searchParams.set('key', googleKey)
    url.searchParams.set('cx', googleCx)
    url.searchParams.set('q', q)
    url.searchParams.set('num', '5')

    const res = await fetch(url.toString())
    const data = await res.json()
    if (!res.ok) throw new Error(`Google Search error ${res.status}: ${JSON.stringify(data)}`)

    for (const item of data.items || []) {
      const blob = `${item.title || ''} ${item.snippet || ''}`
      const extracted = extractContactInfo(blob)
      extracted.emails.forEach((e) => exactEmails.add(e))
      extracted.phones.forEach((p) => exactPhones.add(p))
      
      snippets.push(blob)
      if (item.link) urls.push(item.link)
    }
  }

  return {
    provider: 'google',
    queries,
    exactEmails: Array.from(exactEmails),
    phones: Array.from(exactPhones),
    partialEmails: [],
    domains: domain ? [domain] : [],
    snippets,
    urls,
  }
}

async function runBraveSearch(
  fullName: string,
  company: string | null,
  domain: string | null,
  braveKey: string,
): Promise<SearchEvidence> {
  const queries = buildSearchQueries(fullName, company, domain)
  const exactEmails = new Set<string>()
  const exactPhones = new Set<string>()
  const snippets: string[] = []
  const urls: string[] = []

  for (const q of queries) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': braveKey,
      },
    })
    const data = await res.json()
    if (!res.ok) throw new Error(`Brave Search error ${res.status}: ${JSON.stringify(data)}`)

    for (const item of data.web?.results || []) {
      const blob = `${item.title || ''} ${item.description || ''}`
      const extracted = extractContactInfo(blob)
      extracted.emails.forEach((e) => exactEmails.add(e))
      extracted.phones.forEach((p) => exactPhones.add(p))
      
      snippets.push(blob)
      if (item.url) urls.push(item.url)
    }
  }

  return {
    provider: 'brave',
    queries,
    exactEmails: Array.from(exactEmails),
    phones: Array.from(exactPhones),
    partialEmails: [],
    domains: domain ? [domain] : [],
    snippets,
    urls,
  }
}

async function runPdlEnrichment(
  fullName: string,
  company: string | null,
  linkedinUrl: string | null,
  pdlKey: string,
): Promise<PdlEvidence> {
  const payload: Record<string, unknown> = {}
  
  // PDL uses structured match keys, not search strings.
  // LinkedIn URL is the most deterministic match key.
  if (linkedinUrl) payload.profile = linkedinUrl
  if (fullName) payload.name = fullName
  if (company) payload.company = company

  const res = await fetch('https://api.peopledatalabs.com/v5/person/enrich', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': pdlKey,
    },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(`PDL error ${res.status}: ${JSON.stringify(data)}`)

  const emails = Array.isArray(data?.data?.emails) ? data.data.emails : []
  const phones = Array.isArray(data?.data?.phone_numbers) ? data.data.phone_numbers : []

  const workEmails = emails
    .filter((e: any) => e?.type === 'work' && e?.address)
    .map((e: any) => String(e.address).toLowerCase())

  const personalEmails = emails
    .filter((e: any) => e?.type === 'personal' && e?.address)
    .map((e: any) => String(e.address).toLowerCase())

  const mobilePhones = phones
    .filter((p: any) => (p?.type === 'mobile' || p?.line_type === 'mobile') && p?.number)
    .map((p: any) => String(p.number))

  return {
    provider: 'pdl',
    workEmails: Array.from(new Set(workEmails)),
    personalEmails: Array.from(new Set(personalEmails)),
    mobilePhones: Array.from(new Set(mobilePhones)),
    confidence: typeof data?.data?.likelihood === 'number' ? data.data.likelihood : undefined,
    raw: data,
  }
}

async function verifySearchCandidates(
  candidates: string[],
  myEmailVerifierKey: string,
  step: any,
): Promise<string | null> {
  for (const email of candidates.slice(0, 5)) {
    const result = await step('myemailverifier', async () => {
      const verdict = await verifySingleEmail(email, myEmailVerifierKey)
      return {
        status: verdict.ok ? 'OK' : 'MISS',
        meta: { email: maskEmail(email), verdict: verdict.status },
      }
    })

    if (result.status === 'OK') return email
  }

  return null
}
```
