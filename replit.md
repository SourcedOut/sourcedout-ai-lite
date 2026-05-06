# SourcedOut

AI-powered outreach tool for recruiters and talent sourcers. Provides a web dashboard/landing page for downloading a Chrome Extension that integrates with LinkedIn.

## Architecture

- **Frontend**: React 19 + TypeScript + TanStack Start (TanStack Router)
- **Styling**: Tailwind CSS v4 + Radix UI (via shadcn/ui)
- **Build tool**: Vite 7 (with `@lovable.dev/vite-tanstack-config`)
- **Server functions**: TanStack Start `createServerFn` for server-side ZIP generation
- **Chrome Extension**: Vanilla JS (Manifest V3) in `/extension` directory
- **Backend**: Supabase Edge Function (`enrich-and-draft`) — Deno TypeScript

## Project Structure

```
/src
  /routes         - TanStack file-based routes
  /functions      - Server functions (createServerFn, importable from client)
  /components/ui  - shadcn/ui components
  /hooks          - useAuth, useRecruiterProfile
  /components     - AuthModal, RecruiterOnboarding, ClientOnly
  /lib/supabase.ts - Supabase JS client
  /styles.css     - Global styles
/extension        - Chrome extension source files
/supabase
  /functions/enrich-and-draft/index.ts - Main edge function (v16)
/public           - Static assets
```

## Edge Function: enrich-and-draft

**Current version**: `2026-05-02-haiku-first-waterfall-v16`

### Haiku-First Waterfall Order (v16)
1. **Cache** — 30-day `saved_profiles` cache check
2. **haiku_pattern_cache** — DB lookup of `company_email_patterns` table; HIT = single MEV call and done
3. **haiku_email_guess** (`claude-haiku-4-5`) — domain + up to 5 ranked candidates
4. **myemailverifier_haiku** — MEV verify on Haiku candidates (early exit); upserts verified pattern
5. **google_search** — 5 OSINT queries, collect candidates (no early verify)
6. **brave_search** — 5 OSINT queries with extra_snippets (no early verify)
7. **haiku_refine_candidates** (`claude-haiku-4-5`) — synthesize search evidence into 5 refined candidates
8. **myemailverifier_search_round1** — MEV verify on Haiku-refined + Google/Brave candidates (before PDL)
9. **pdl_person_enrichment** — People Data Labs structured enrichment (LinkedIn URL priority)
10. **myemailverifier_search_candidates** — MEV verify on remaining PDL candidates (up to 8)
11. **fullenrich_v2** — LinkedIn URL enrichment (last resort, ~$0.50/call)
12. **post_fullenrich_retry** — conditional: only fires if FullEnrich returned genuinely new name/domain
13. **sonnet_draft** (`claude-sonnet-4-5`) — email draft generation (always runs if email found)

### Company pattern cache (`company_email_patterns` table)
- Created automatically on first verified email per domain
- Pattern detected via `detectPattern()`, stored as e.g. `first.last`, `flast`, `firstlast`
- Future requests for same company domain: `haiku_pattern_cache HIT` → single MEV call → done
- Grows more valuable over time as campaigns run across same companies

### MEV shared helper
- `runMevLoop()` is the shared MEV verification loop used by all three MEV steps
- All three MEV steps call `upsertEmailPattern()` on success to populate the cache

### Anthropic cost breakdown per full run
| Step | Model | ~Cost |
|------|-------|-------|
| haiku_email_guess | claude-haiku-4-5 | ~$0.00015 |
| haiku_refine_candidates | claude-haiku-4-5 | ~$0.00020 |
| inferTitleFallback | claude-haiku-4-5 | ~$0.00010 |
| sonnet_draft | claude-sonnet-4-5 | ~$0.00150 |
| **Total** | | **~$0.00195** |

### post_fullenrich_retry guard
Only fires when ALL of: no email found, FullEnrich did NOT return an email itself, AND FullEnrich returned a genuinely different name or domain than what the first waterfall pass already had.

### Removed from waterfall
- Apollo (`/people/match`) — fully deleted (was dead code)
- Old single-step `myemailverifier_search_candidates` consolidated into two rounds

### Required Supabase Function Secrets
| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Haiku (email guess) + Sonnet (drafts) |
| `GOOGLE_API_KEY` / `GOOGLE_CSE_KEY` | Google Custom Search |
| `GOOGLE_CX` / `GOOGLE_CSE_CX` | Google CSE ID |
| `MYEMAILVERIFIER_API_KEY` | Email verification (MEV) |
| `BRAVE_API_KEY` | Brave Search OSINT (**new in v15**) |
| `PDL_API_KEY` | People Data Labs enrichment (**new in v15**) |
| `FULLENRICH_API_KEY` | FullEnrich last-resort enrichment |
| `SUPABASE_URL` | Auto-injected |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected |

### Anthropic Retry Logic (v14+)
`callAnthropic` retries on HTTP 429 (rate limit) with 1.5s and 3s backoff before throwing.

## Supabase Project
- **Ref**: `szxjcitbjcpkhxtjztay`
- **URL**: `https://szxjcitbjcpkhxtjztay.supabase.co`

## Frontend Auth
- `AuthProvider` in `__root.tsx` — wraps entire app
- `useAuth` hook — session management
- `AuthModal` — sign in / sign up
- `ClientOnly` wrapper — prevents SSR hydration mismatches
- `RecruiterOnboarding` — auto-triggers after first login; Settings button re-opens it; upserts to `recruiter_profiles`

## Outstanding / To Do

- **Outlook reply detection (Azure setup incomplete)**: The Outlook Graph API integration is built and ready in the extension (`extension/core/reply-checker.js`). The user needs to create a Microsoft Azure app registration to get a client ID. They couldn't complete this because Azure Portal wouldn't accept their `admin@sourcedout.ai` login. Resolution: create a free personal Microsoft account at account.microsoft.com, use that to sign into portal.azure.com, register the app with "Multitenant + personal accounts" support, add redirect URI `https://oekidhmjmaknllpbdagiffepogjgkjdj.chromiumapp.org/`, add Mail.Read delegated permission, then paste the client ID into SourcedOut Settings → Connect Outlook.

## Key Notes

- **Server functions live in `/src/functions/`**, NOT `/src/server/` — TanStack Start blocks client imports from `**/server/**` paths
- The `*.server.ts` files in `/src/functions/` are server-only implementations (node:fs usage)
- The `*.functions.ts` files wrap server logic with `createServerFn` for client-callable RPCs
- Dev server runs on port 5000, host 0.0.0.0 (required for Replit preview)
- `__SUPABASE_ANON_KEY__` is injected by `vite.config.ts` from the `SUPABASE_ANON_KEY` Replit secret
- The `@lovable.dev/vite-tanstack-config` package defaults to port 8080/`::` — overridden in `vite.config.ts`

## Running

```bash
npm run dev    # Development server on port 5000
npm run build  # Production build
npm run preview # Serve production build
```

## Workflows

- **Start application**: `npm run dev` on port 5000 (webview)
