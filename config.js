// ─── config.js ────────────────────────────────────────────────────────────────
export const CONFIG = {
  supabaseUrl: 'https://szxjcitbjcpkhxtjztay.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6eGpjaXRiamNwa2h4dGp6dGF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3ODc2MDgsImV4cCI6MjA4NzM2MzYwOH0.9sgQhrNY8GGeMWIHPTnNehrM8eGD0tMHM6FCKDf-k08',

  fullenrichUrl: 'https://app.fullenrich.com/api/v1',

  appName:    'SourcedOut',
  version:    '1.1.1',
  // Bump this every meaningful extension/scraper update so the popup
  // diagnostics panel can tell you exactly which local files are loaded.
  // Compare to the server's FUNCTION_VERSION (shown side-by-side).
  scraperBuild: '2026-06-08-auto-proceed-v41.3',
  pricingUrl: 'https://szxjcitbjcpkhxtjztay.supabase.co/functions/v1/create-checkout',

  stripe: {
    sourcer: {
      monthly: 'price_1T3k99HBH8to4gGBHlNU3ewA',
      yearly:  'price_1T3kAOHBH8to4gGBQvWk4fiF',
    },
    pro: {
      monthly: 'price_1T3kIDHBH8to4gGBnW3QoNBz',
      yearly:  'price_1T3kIvHBH8to4gGBV7WWfsD4',
    },
  },

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
