// ─── config.js ────────────────────────────────────────────────────────────────
export const CONFIG = {
  // SourcedOut AI Lite project (separate from prod SourcedOut)
  supabaseUrl: 'https://ddhdffftvujupflqggki.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkaGRmZmZ0dnVqdXBmbHFnZ2tpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNzYyNjUsImV4cCI6MjA5NjY1MjI2NX0.Z1JQ9WoC2cd1yhaHzbghVlmxP6cFnx2VXTtQR6ln93U',

  appName: 'SourcedOut Lite',
  version: '2.0.0',

  // Billing is not wired up in lite (the Stripe checkout function lives in the
  // prod project) — everyone is on the free tier. pricingUrl is null so the
  // upgrade CTA stays hidden.
  pricingUrl: null,

  tiers: {
    free:    { lookups: 10,  ai_runs: 20,  emails: 10,   label: 'Free'    },
    sourcer: { lookups: 50,  ai_runs: 200, emails: 100,  label: 'Sourcer' },
    pro:     { lookups: 200, ai_runs: 999, emails: 9999, label: 'Pro'     },
  },

  bonusActivities: {
    verifyEmail:        3,
    generateFirstDraft: 5,
    rateExtension:      10,
  },

  features: {
    phoneNumberLookup: false,
    bulkExport:        false,
    crmIntegration:    false,
    teamAccounts:      false,
    emailSequences:    false,
  },
}
