# Google Search Fix Instructions for Replit

## Goal

Keep the existing Google secrets setup, but rewrite the Google search logic so it actually supports the new SourcedOut waterfall.

The current Google setup in Supabase is structurally correct:
- `GOOGLE_API_KEY`
- `GOOGLE_CX`

Both of these are required and should remain in place.

## Important clarification

Google Search in this system uses **two separate values**:

1. `GOOGLE_API_KEY`
   - This is the credential used to call Google Custom Search.

2. `GOOGLE_CX`
   - This is the Custom Search Engine / Programmable Search Engine ID.
   - It tells Google which search engine configuration to use.

Do not remove or rename either of these secrets.

## What is wrong in the current code

The current Google helper is too weak for the new waterfall.

Right now, the code does this:
- builds one generic query using `fullName + companyName + domain + email`
- sends one request to Google CSE
- extracts email-looking strings only
- returns a single chosen email

That is not enough for the new search-first strategy.

## What Replit must change

Replace the current Google helper with a new evidence-based helper.

### Remove this old behavior
Do not keep a helper that:
- runs only one generic query
- only extracts emails
- returns one chosen email immediately

### Replace it with this new behavior
Create a helper called:

```ts
runGoogleSearchEvidence(fullName, company, domain, googleApiKey, googleCx)
```

This helper must:
- run multiple OSINT/Boolean queries for the same person
- extract emails
- extract phone numbers
- return snippets and URLs as evidence
- return all candidates, not just one final email

## Required Google query set

The Google helper must use this exact query strategy.

### 1. Resume / PDF query
Best for personal emails and mobile phone numbers.

```ts
`"${fullName}" ("resume" OR "cv" OR "portfolio") (filetype:pdf OR filetype:doc OR filetype:docx)`
```

### 2. Contact proximity query
Best for personal websites, blogs, portfolios, speaker pages.

```ts
`"${fullName}" ("email" OR "contact" OR "reach me at" OR "cell" OR "mobile")`
```

### 3. Social / Linktree query
Best for GitHub bio emails, Linktree links, and public social snippets.

```ts
`"${fullName}" (site:linktr.ee OR site:github.com OR site:twitter.com OR site:x.com)`
```

### 4. Exact company domain query
Best for finding public work email references.

Only run this if a company domain exists.

```ts
`"${fullName}" "@${domain}"`
```

### 5. Company directory query
Best for company team pages and public contact pages.

Only run this if a company domain exists.

```ts
`site:${domain} "${fullName}" ("email" OR "phone" OR "contact")`
```

### 6. Company fallback query
Use this only if there is no domain but there is a company name.

```ts
`"${fullName}" "${company}" ("email" OR "phone")`
```

## What the new Google helper must return

Create a normalized return shape like this:

```ts
type GoogleSearchEvidence = {
  provider: 'google'
  queries: string[]
  exactEmails: string[]
  phones: string[]
  partialEmails: string[]
  snippets: string[]
  urls: string[]
  domains: string[]
}
```

This function should return **all evidence**, not a single winner.

## Add a contact extraction helper

Create a helper called:

```ts
extractContactInfo(text)
```

This helper must extract both:
- emails
- phone numbers

Suggested implementation:

```ts
function extractContactInfo(text: string): { emails: string[]; phones: string[] } {
  const emailMatches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
  const phoneMatches = text.match(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || []

  return {
    emails: Array.from(new Set(emailMatches.map((v) => v.toLowerCase()))),
    phones: Array.from(new Set(phoneMatches.map((v) => v.replace(/[^\d+]/g, '')))),
  }
}
```

## Suggested implementation sketch

```ts
async function runGoogleSearchEvidence(
  fullName: string,
  company: string | null,
  domain: string | null,
  googleApiKey: string,
  googleCx: string,
): Promise<GoogleSearchEvidence> {
  const queries = new Set<string>()

  queries.add(`"${fullName}" ("resume" OR "cv" OR "portfolio") (filetype:pdf OR filetype:doc OR filetype:docx)`)
  queries.add(`"${fullName}" ("email" OR "contact" OR "reach me at" OR "cell" OR "mobile")`)
  queries.add(`"${fullName}" (site:linktr.ee OR site:github.com OR site:twitter.com OR site:x.com)`)

  if (domain) {
    queries.add(`"${fullName}" "@${domain}"`)
    queries.add(`site:${domain} "${fullName}" ("email" OR "phone" OR "contact")`)
  } else if (company) {
    queries.add(`"${fullName}" "${company}" ("email" OR "phone")`)
  }

  const exactEmails = new Set<string>()
  const phones = new Set<string>()
  const snippets: string[] = []
  const urls: string[] = []

  for (const q of Array.from(queries).slice(0, 5)) {
    const url = new URL('https://www.googleapis.com/customsearch/v1')
    url.searchParams.set('key', googleApiKey)
    url.searchParams.set('cx', googleCx)
    url.searchParams.set('q', q)
    url.searchParams.set('num', '5')

    const res = await fetch(url.toString())
    const data = await res.json()
    if (!res.ok) {
      throw new Error(`Google Search error ${res.status}: ${JSON.stringify(data)}`)
    }

    for (const item of data.items || []) {
      const blob = `${item.title || ''} ${item.snippet || ''}`
      const extracted = extractContactInfo(blob)
      extracted.emails.forEach((e) => exactEmails.add(e))
      extracted.phones.forEach((p) => phones.add(p))

      snippets.push(blob)
      if (item.link) urls.push(item.link)
    }
  }

  return {
    provider: 'google',
    queries: Array.from(queries).slice(0, 5),
    exactEmails: Array.from(exactEmails),
    phones: Array.from(phones),
    partialEmails: [],
    snippets,
    urls,
    domains: domain ? [domain] : [],
  }
}
```

## Where Google sits in the new waterfall

The updated flow should be:

1. Cache
2. Claude Haiku guess
3. MyEmailVerifier on top Haiku candidates only
4. **Google Search evidence step**
5. Brave Search evidence step
6. PDL Person Enrichment API
7. MyEmailVerifier on any new email candidates from Google, Brave, or PDL
8. FullEnrich last resort
9. Claude Sonnet draft

Google should no longer sit in the older one-query model.

## Logging requirements

The Google step must log:
- which queries ran
- how many results came back
- how many emails were extracted
- how many phones were extracted
- the top URLs found

These logs should go into the existing enrichment debug logging flow.

## Final instruction to Replit

Keep the secrets exactly as they are:
- `GOOGLE_API_KEY`
- `GOOGLE_CX`

Do not change the secret names.

But completely replace the current Google search helper with a multi-query evidence-based Google search step that supports the new search-first SourcedOut waterfall.
