// ─── core/credits.js ──────────────────────────────────────────────────────────
import { CONFIG } from '../config.js'
import { getAccessToken, getUser } from './auth.js'

const DB = `${CONFIG.supabaseUrl}/rest/v1`

async function getHeaders() {
  const token = await getAccessToken()
  return {
    'Content-Type':  'application/json',
    'apikey':        CONFIG.supabaseKey,
    'Authorization': `Bearer ${token}`,
    'Prefer':        'return=representation',
  }
}

export async function getCredits() {
  try {
    const user = await getUser()
    if (!user) return null
    const headers = await getHeaders()

    // Check and reset credits if the billing period has expired
    await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/check_and_reset_credits`, {
      method: 'POST', headers,
      body: JSON.stringify({ p_user_id: user.id }),
    }).catch(() => {}) // non-blocking — if it fails, credits just won't reset yet

    const res = await fetch(`${DB}/credits?user_id=eq.${user.id}&limit=1`, { headers })
    if (!res.ok) return null
    const rows = await res.json()
    return rows?.[0] ?? null
  } catch { return null }
}

export async function deductCredit() {
  try {
    const user = await getUser()
    if (!user) return false
    const credits = await getCredits()
    if (!credits) return false
    const tier  = credits.tier ?? 'free'
    const limit = CONFIG.tiers[tier]?.lookups ?? 10
    const used  = credits.lookups_used ?? 0
    if (used >= limit) return false
    const headers = await getHeaders()
    await fetch(`${DB}/credits?user_id=eq.${user.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ lookups_used: used + 1 }),
    })
    return true
  } catch { return false }
}

export async function deductAiRun() {
  try {
    const user = await getUser()
    if (!user) return false
    const credits = await getCredits()
    if (!credits) return false
    const tier  = credits.tier ?? 'free'
    const limit = CONFIG.tiers[tier]?.ai_runs ?? 20
    const used  = credits.ai_runs_used ?? 0
    if (used >= limit) return false
    const headers = await getHeaders()
    await fetch(`${DB}/credits?user_id=eq.${user.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ ai_runs_used: used + 1 }),
    })
    return true
  } catch { return false }
}

export async function completeBonusActivity(activity) {
  try {
    const user = await getUser()
    if (!user) return false
    const bonus = CONFIG.bonusActivities?.[activity] ?? 0
    if (!bonus) return false
    const credits = await getCredits()
    if (!credits) return false
    const headers = await getHeaders()
    await fetch(`${DB}/credits?user_id=eq.${user.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ lookups_used: Math.max(0, (credits.lookups_used ?? 0) - bonus) }),
    })
    return true
  } catch { return false }
}
