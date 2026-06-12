# SourcedOut AI Lite — project instructions

## Supabase projects
- This repo deploys ONLY to the Lite project: `ddhdffftvujupflqggki`.
- **Never deploy functions, push migrations, or change secrets on prod (`szxjcitbjcpkhxtjztay`).** Prod belongs to the main SourcedOut repo.
- Deploy with an explicit name: `supabase functions deploy enrich-lite --project-ref ddhdffftvujupflqggki`.

## Repo map (don't confuse these)
- `SourcedOut/SourcedOut-AI` — prod product.
- `SourcedOut/sourcedout-ai-lite` — this repo: Chrome extension + `enrich-lite` edge function.
- `softgenai/sg-b3222b51-455b-4695-9089-93560faa5059-1778478619` — **the real webapp-in-progress** (dashboard, auth, campaigns pages). The `src/` + Next.js configs in this repo are an older snapshot of it. For any webapp work, start from the softgenai repo — do not build on the local `src/` copy.
- `SourcedOut/sourcedout-extension` — archived legacy extension repo; reference only.

## Architecture (lite)
- Extension is vanilla JS, Manifest v3, no build step. Reload via chrome://extensions after edits.
- Backend is one edge function (`supabase/functions/enrich-lite/index.ts`): 3-step email waterfall — emailfinder.dev first, Generect second (needs a company domain), FullEnrich last. Only LLM calls: Claude Sonnet drafts + Haiku job summaries.
- No scraping anywhere: the popup sends the active tab's LinkedIn URL; emailfinder returns email + name/title/company.
- `legacy/enrich-and-draft/` is the old 4,000-line waterfall, kept for reference — never deploy it.
- `core/reply-checker.js` uses a separate OAuth flow (`chrome.identity` + chromiumapp.org redirect) for Gmail/Outlook reply detection — that chromiumapp URI in Settings is intentional, not stale.
