// ─── core/api.js ──────────────────────────────────────────────────────────────
import { CONFIG } from '../config.js'
import { getAccessToken, refreshSession } from './auth.js'

const DB = `${CONFIG.supabaseUrl}/rest/v1`

// ── Error normalization ───────────────────────────────────────────────────────
// Converts any raw error (string, JSON, object) into { code, message }
export function parseErrorMessage(raw) {
  if (!raw) return { code: 'UNKNOWN_ERROR', message: 'Something went wrong.' }
  if (typeof raw === 'object' && raw.code && raw.message) return raw
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw)
      if (j.error?.code) {
        // Forward optional structured payloads (e.g. companyCandidates) alongside the error.
        const out = { ...j.error }
        if (Array.isArray(j.companyCandidates)) out.companyCandidates = j.companyCandidates
        return out
      }
      if (j.message)     return { code: j.code || 'API_ERROR', message: j.message }
      if (j.error)       return { code: 'API_ERROR', message: j.error }
      if (j.msg)         return { code: 'API_ERROR', message: j.msg }
    } catch {}
    return { code: 'API_ERROR', message: raw }
  }
  return { code: 'UNKNOWN_ERROR', message: String(raw) }
}

export function isAuthError(err) {
  if (!err) return false
  const msg = (err.message || err.msg || String(err)).toLowerCase()
  const code = String(err.code || '').toLowerCase()
  return code === 'auth_expired' || msg.includes('invalid jwt') || msg.includes('jwt expired') ||
         msg.includes('session expired') || msg.includes('unauthorized') || err.status === 401
}

// ── Core fetch wrapper with 401 refresh-and-retry ─────────────────────────────
async function apiRequest(url, options = {}) {
  const makeRequest = async () => {
    const token = await getAccessToken()
    const headers = {
      'Content-Type': 'application/json',
      'apikey': CONFIG.supabaseKey,
      ...(options.headers || {}),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    return fetch(url, { ...options, headers })
  }

  let res = await makeRequest()

  // On 401, attempt one refresh then retry
  if (res.status === 401) {
    const session = await new Promise(r => chrome.storage.local.get('sourcedout_session', d => r(d.sourcedout_session ?? null)))
    if (session?.refresh_token) {
      const refreshed = await refreshSession(session.refresh_token)
      if (refreshed) {
        res = await makeRequest()
      } else {
        const authErr = new Error('Session expired — please sign out and sign in again.')
        authErr.code = 'AUTH_EXPIRED'
        throw authErr
      }
    } else {
      const authErr = new Error('Session expired — please sign out and sign in again.')
      authErr.code = 'AUTH_EXPIRED'
      throw authErr
    }
  }

  // Capture server function version (header or body._version) so the popup
  // diagnostics panel can show what version the extension is talking to.
  try {
    const ver = res.headers.get('x-function-version')
    if (ver) chrome.storage?.local?.set({ sourcedout_server_version: ver, sourcedout_server_version_at: Date.now() })
  } catch {}

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw parseErrorMessage(text)
  }

  const json = await res.json()
  try {
    if (json && json._version) {
      chrome.storage?.local?.set({ sourcedout_server_version: json._version, sourcedout_server_version_at: Date.now() })
    }
  } catch {}
  return json
}

// ── Main API: enrich-and-draft ────────────────────────────────────────────────
export async function enrichAndDraft({ linkedinUrl, companyHint, companyHintSource, userContext, fullNameHint, tone, outreachType }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ linkedinUrl, companyHint, companyHintSource, userContext, fullNameHint, tone, outreachType }),
  })
}

// ── Summarize raw job posting text into recruiter-friendly bullet points ──────
export async function summarizeJob({ rawText, jobTitle, company }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'summarize-job', rawText, jobTitle, company }),
  })
}

// ── Bookmark (or un-bookmark) a saved profile ─────────────────────────────────
export async function bookmarkProfile({ linkedinUrl, save = true }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'bookmark-profile', linkedinUrl, save }),
  })
}

// ── Fetch all bookmarked profiles for the current user ────────────────────────
export async function getSavedProfiles() {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'get-saved-profiles' }),
  })
}

// ── Saved jobs CRUD ───────────────────────────────────────────────────────────
export async function saveJob({ label, jobUrl, roleTitle, company, highlights }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'save-job', label, jobUrl, roleTitle, company, highlights }),
  })
}

export async function getSavedJobs() {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'get-saved-jobs' }),
  })
}

export async function deleteJob({ jobId }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'delete-job', jobId }),
  })
}

// ── Check if a LinkedIn URL is already in the saved-profiles cache ────────────
export async function checkSavedProfile({ linkedinUrl }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'check-saved-profile', linkedinUrl }),
  })
}

// ── Credits ───────────────────────────────────────────────────────────────────
export async function getCreditsData() {
  const token = await getAccessToken()
  if (!token) return null
  const res = await fetch(`${DB}/credits?select=*`, {
    headers: { 'apikey': CONFIG.supabaseKey, 'Authorization': `Bearer ${token}` }
  })
  if (!res.ok) return null
  const rows = await res.json()
  return rows?.[0] || null
}

// ── Job context (stored locally in chrome.storage) ────────────────────────────
export async function extractJob(pageText) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/extract-job`, {
    method: 'POST',
    body: JSON.stringify({ text: pageText }),
  })
}

// ── Pricing / upgrade ─────────────────────────────────────────────────────────
export function openUpgradePage() {
  chrome.tabs.create({ url: CONFIG.pricingUrl })
}

// ── Campaign automation ───────────────────────────────────────────────────────
export async function importCampaign({ campaignName, jobId, candidates }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'import-campaign', campaignName, jobId, candidates }),
  })
}

export async function getCampaigns() {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'get-campaigns' }),
  })
}

export async function getCampaignCandidates({ campaignId, status }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'get-campaign-candidates', campaignId, status }),
  })
}

export async function enrichCampaignCandidate({ candidateId }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'enrich-campaign-candidate', candidateId }),
  })
}

export async function draftCampaignCandidate({ candidateId }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'draft-campaign-candidate', candidateId }),
  })
}

export async function updateCandidateStatus({ candidateId, status }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'update-candidate-status', candidateId, status }),
  })
}

export async function linkCampaignJob({ campaignId, jobId }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'link-campaign-job', campaignId, jobId }),
  })
}

export async function deleteCampaign({ campaignId }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'delete-campaign', campaignId }),
  })
}

// ── Legacy exports (kept for backward compatibility with Job tab) ──────────────
export const createCheckout = openUpgradePage
export const lookupEmail = () => { throw new Error('Use enrichAndDraft instead') }
export const generateDraft = () => { throw new Error('Use enrichAndDraft instead') }
export const bootstrapCandidate = () => { throw new Error('Use enrichAndDraft instead') }
export const pollJob = () => { throw new Error('Use enrichAndDraft instead') }
export const getOutreachPackage = () => { throw new Error('Use enrichAndDraft instead') }
export const requirementsMatch = () => { throw new Error('Analyze Fit removed') }
