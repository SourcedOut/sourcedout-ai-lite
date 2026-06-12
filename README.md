# SourcedOut AI Lite

A simplified, API-driven version of SourcedOut: a Chrome extension for recruiters that finds a candidate's verified work email from their LinkedIn profile and drafts a personalized outreach email.

Unlike the original SourcedOut (LinkedIn DOM scraping + a 13-step email-guessing waterfall across multiple LLMs and search engines), Lite uses three purpose-built APIs and keeps exactly one LLM feature:

```
LinkedIn URL ──► emailfinder.dev ──► (miss?) Generect ──► (miss?) FullEnrich ──► Claude Sonnet draft
                 (email + name +        (fallback              (outreach email)
                  title + company)       enrichment)
```

## What's in this repo

| Path | What it is |
|---|---|
| `manifest.json`, `popup.js`, `batch.js`, `background.js`, `ui/`, `core/`, `icons/`, `auth.html`, `auth-callback.js`, `config.js` | The Chrome extension (vanilla JS, Manifest v3, no build step) |
| `supabase/functions/enrich-lite/` | The entire backend: one Supabase edge function with 16 actions (enrich+draft, saved jobs/profiles, campaigns/CSV bulk flow, job summarization) |
| `supabase/migrations/` | Schema snapshot of the Lite database |
| `src/`, `package.json`, Next.js configs | Older snapshot of the webapp starter. **The real webapp-in-progress lives in the `softgenai/sg-b3222b51-...` repo** (dashboard, auth, campaigns pages already built) — work there, not here |
| `legacy/enrich-and-draft/` | Reference copy of the original 4,000-line waterfall function (not deployed) |

## Supabase projects — important

- **Lite (this repo deploys here):** `ddhdffftvujupflqggki`
- **Prod SourcedOut (never touch from this repo):** `szxjcitbjcpkhxtjztay`

Never run `supabase db push` or `supabase functions deploy` against the prod ref from this repo.

## Setup

1. **Extension:** `chrome://extensions` → Developer mode → Load unpacked → this folder. Reload (↺) after code changes.
2. **Auth:** the extension's redirect page is `chrome-extension://<extension-id>/auth.html`. Whitelist it in the Lite project under Authentication → URL Configuration, and add `https://ddhdffftvujupflqggki.supabase.co/auth/v1/callback` to the Google OAuth client's authorized redirect URIs.
3. **Edge function secrets** (Lite project → Edge Functions → Secrets): `EMAILFINDER_API_KEY`, `GENERECT_API_KEY`, `FULLENRICH_API_KEY`, `ANTHROPIC_API_KEY`.
4. **Deploy the function:** `supabase functions deploy enrich-lite --project-ref ddhdffftvujupflqggki` (or via the Supabase MCP `deploy_edge_function`).

## Architecture notes

- The extension does **no scraping** — it sends the active tab's LinkedIn URL to the edge function; emailfinder.dev's LinkedIn endpoint returns the verified email plus name/title/company in one call.
- Enriched profiles are cached in `saved_profiles` for 30 days; repeat lookups are free.
- Credits are deducted up-front and refunded if a lookup produces nothing usable; `lookup_locks` prevents double-charging on concurrent lookups of the same profile.
- Campaign (CSV bulk) enrichment runs in the background via `EdgeRuntime.waitUntil`; the client polls `get-campaign-candidates`.
- Billing/Stripe is not wired up in Lite — everyone is on the free tier.
