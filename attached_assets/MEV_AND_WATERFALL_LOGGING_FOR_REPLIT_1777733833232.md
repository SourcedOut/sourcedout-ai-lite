# MyEmailVerifier and Waterfall Logging Instructions for Replit

## Goal

Confirm and preserve two things in the new SourcedOut waterfall rewrite:

1. **MyEmailVerifier remains implemented and active**
2. **Every waterfall step remains fully logged and traceable**

The current codebase already has both of these foundations.

## Important confirmation

### MyEmailVerifier is already implemented
The current code already includes:
- the `MYEMAILVERIFIER_API_KEY` environment variable
- a working `myEmailVerifierValidate(email, key)` helper
- a live `myemailverifier` step inside `runEmailWaterfall()`

This means MyEmailVerifier is **not missing**. It is already wired up.

### Waterfall step tracking is already implemented
The current code also already includes:
- `makeStepLogger()`
- `StepStatus`
- `StepRecord`
- `records[]`
- persistence to `enrichment_debug_logs`
- console logging per step
- debug payloads returned with `correlationId`

This logging system should be preserved and extended, not replaced.

## What Replit should do

Do **not** remove MyEmailVerifier.

Do **not** remove `makeStepLogger()`.

Instead, update the waterfall so MyEmailVerifier and step logging match the new architecture.

## Required instruction 1: Keep MyEmailVerifier active

Retain the existing helper pattern:

```ts
myEmailVerifierValidate(email, myEmailVerifierKey)
```

If needed, refactor it, but do not remove it.

## Required instruction 2: Use MyEmailVerifier twice in the new waterfall

The new waterfall should use MyEmailVerifier in **two separate stages**.

### Stage A: Early verification of Haiku guesses
Run MyEmailVerifier immediately after Claude Haiku generates the top work email guesses.

Purpose:
- cheaply validate the strongest guessed candidates first
- stop early if one validates
- avoid unnecessary downstream provider calls when Haiku is correct

### Stage B: Later verification of all new email candidates
After Google, Brave, and PDL run, merge all newly discovered email candidates and run MyEmailVerifier again on those new candidates.

Purpose:
- verify search-based or enrichment-based emails before accepting them
- avoid trusting raw search snippets or PDL emails without validation

## Required instruction 3: Preserve structured logging for every step

Keep using the existing pattern:

```ts
const { step, records } = makeStepLogger(db, user.id, correlationId, action)
```

Every step in the waterfall must continue to use:

```ts
await step('step-name', async () => {
  ...
  return { status, reason, meta }
})
```

Do not replace this with raw `console.log()` calls.

## Required instruction 4: Keep the same step status model

Preserve the current status types:

```ts
type StepStatus = 'HIT' | 'OK' | 'SKIP' | 'MISS' | 'FAIL'
```

These are already working and should remain the standard for every step.

## Required instruction 5: Keep writing to enrichment_debug_logs

The step logger already writes each step into `enrichment_debug_logs`.

Keep this behavior.

Each new provider step must continue to create a log record with:
- step / provider name
- status
- duration in milliseconds
- reason
- meta fields
- correlation ID
- action name

## Required instruction 6: Extend logging to the new providers

When the new waterfall is implemented, all of these steps must be wrapped with the step logger:

1. `cache`
2. `haikuemailguess`
3. `myemailverifier_haiku`
4. `google_search`
5. `brave_search`
6. `pdl_person_enrichment`
7. `myemailverifier_search_candidates`
8. `fullenrichv2`
9. any draft-generation or fallback step after enrichment

This is important so we can debug provider order, cost, hit rate, and failures.

## Required instruction 7: Rename the MyEmailVerifier steps for clarity

In the current code there is one `myemailverifier` step.

In the rewritten waterfall, split this into two separately logged steps:

```ts
'myemailverifier_haiku'
'myemailverifier_search_candidates'
```

This will make the logs much easier to interpret.

## Required instruction 8: Return detailed meta for each step

Each step should return clear metadata.

### Example: Haiku verification meta
```ts
{
  tried: ['j***@company.com', 'jsmith@company.com'],
  accepted: 'j***@company.com'
}
```

### Example: Google search meta
```ts
{
  queriesRun: 5,
  emailsFound: 2,
  phonesFound: 1,
  topUrls: ['https://...', 'https://...']
}
```

### Example: PDL meta
```ts
{
  usedLinkedinUrl: true,
  usedCompany: true,
  workEmailsFound: 1,
  personalEmailsFound: 0,
  phonesFound: 1
}
```

### Example: search-candidate verification meta
```ts
{
  totalCandidates: 4,
  tried: ['j***@company.com', 'john@company.com'],
  accepted: 'john@company.com'
}
```

## Required instruction 9: Keep correlation IDs end-to-end

Every enrichment run should continue to generate a `correlationId` and attach it to all step logs and the final debug payload.

This is critical for tracing a single candidate through the full waterfall.

## Recommended new waterfall order

Use this order:

1. Cache
2. Claude Haiku guess
3. `myemailverifier_haiku`
4. Google Search evidence
5. Brave Search evidence
6. PDL Person Enrichment
7. `myemailverifier_search_candidates`
8. FullEnrich last resort
9. Draft generation

## Suggested implementation outline

```ts
const { step, records } = makeStepLogger(db, user.id, correlationId, action)

await step('cache', async () => { ... })
await step('haikuemailguess', async () => { ... })
await step('myemailverifier_haiku', async () => { ... })
await step('google_search', async () => { ... })
await step('brave_search', async () => { ... })
await step('pdl_person_enrichment', async () => { ... })
await step('myemailverifier_search_candidates', async () => { ... })
await step('fullenrichv2', async () => { ... })
```

## Final instruction to Replit

The current code already has the right foundations.

Do not remove them.

Instead:
- keep MyEmailVerifier fully active
- use it twice in the new waterfall
- keep `makeStepLogger()` as the logging standard
- keep writing all step records to `enrichment_debug_logs`
- add the new provider steps using the same logging pattern
- rename the MyEmailVerifier steps so logs clearly show where validation happened

The rewrite should improve the waterfall, not regress observability.
