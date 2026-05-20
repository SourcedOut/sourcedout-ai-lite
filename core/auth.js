// ─── core/auth.js ─────────────────────────────────────────────────────────────
import { CONFIG } from '../config.js'

const BASE = `${CONFIG.supabaseUrl}/auth/v1`
const HEADERS = {
  'Content-Type': 'application/json',
  'apikey':       CONFIG.supabaseKey,
}

// Extension-native redirect: lives inside the extension, always available.
// No external GitHub Pages required.
function getRedirectUrl() {
  return chrome.runtime.getURL('auth.html')
}

function saveSession(session) {
  return new Promise(r => chrome.storage.local.set({ sourcedout_session: session }, r))
}
function loadSession() {
  return new Promise(r => chrome.storage.local.get('sourcedout_session', d => r(d.sourcedout_session ?? null)))
}
function clearSession() {
  return new Promise(r => chrome.storage.local.remove('sourcedout_session', r))
}

export async function isLoggedIn() {
  const session = await loadSession()
  if (!session?.access_token) return false
  // Refresh if expired (or within 5 min of expiry)
  if ((Date.now() / 1000) + 300 > (session.expires_at ?? 0)) {
    if (!session.refresh_token) return false
    const refreshed = await refreshSession(session.refresh_token)
    return !!refreshed
  }
  return true
}

export async function getUser() {
  const session = await loadSession()
  return session?.user ?? null
}

export async function getAccessToken() {
  const session = await loadSession()
  if (!session?.access_token) return null
  // Refresh proactively if within 5 min of expiry
  if ((Date.now() / 1000) + 300 > (session.expires_at ?? 0)) {
    if (!session.refresh_token) return null
    const refreshed = await refreshSession(session.refresh_token)
    if (!refreshed) return null
    const updated = await loadSession()
    return updated?.access_token ?? null
  }
  return session.access_token
}

let _refreshPromise = null

export function refreshSession(refreshToken) {
  if (!refreshToken) return Promise.resolve(null)
  if (_refreshPromise) return _refreshPromise
  _refreshPromise = (async () => {
    try {
      const res  = await fetch(`${BASE}/token?grant_type=refresh_token`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      const data = await res.json()
      if (data.access_token) {
        const session = {
          access_token:  data.access_token,
          refresh_token: data.refresh_token ?? refreshToken,
          expires_at:    Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
          user:          data.user,
        }
        await saveSession(session)
        return session
      }
      if (res.status === 400 || res.status === 401) await clearSession()
      return null
    } catch { return null }
    finally { _refreshPromise = null }
  })()
  return _refreshPromise
}

export async function sendMagicLink(email) {
  try {
    const res = await fetch(`${BASE}/otp`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({
        email,
        options: { emailRedirectTo: getRedirectUrl() }
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return { error: { message: err.msg ?? err.message ?? 'Failed to send magic link' } }
    }
    return { error: null }
  } catch (e) { return { error: { message: e.message } } }
}

export async function signInWithGoogle() {
  const redirectTo = encodeURIComponent(getRedirectUrl())
  await chrome.tabs.create({
    url: `${BASE}/authorize?provider=google&redirect_to=${redirectTo}`
  })
}

export async function signInWithMicrosoft() {
  const redirectTo = encodeURIComponent(getRedirectUrl())
  await chrome.tabs.create({
    url: `${BASE}/authorize?provider=azure&redirect_to=${redirectTo}`
  })
}

export async function signInWithEmailPassword(email, password) {
  try {
    const res = await fetch(`${BASE}/token?grant_type=password`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) {
      return { error: { message: data.error_description ?? data.msg ?? data.message ?? 'Sign-in failed' } }
    }
    if (data.access_token) {
      const session = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_at:    Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
        user:          data.user,
      }
      await saveSession(session)
      return { session, error: null }
    }
    return { error: { message: 'Sign-in failed — no token returned' } }
  } catch (e) { return { error: { message: e.message } } }
}

export async function signUpWithEmailPassword(email, password) {
  try {
    const res = await fetch(`${BASE}/signup`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) {
      return { error: { message: data.msg ?? data.message ?? 'Sign-up failed' } }
    }
    if (data.access_token) {
      const session = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_at:    Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
        user:          data.user,
      }
      await saveSession(session)
      return { session, error: null }
    }
    // Email confirmation required
    return { session: null, error: null, confirmEmail: true }
  } catch (e) { return { error: { message: e.message } } }
}

export async function signOut() {
  const session = await loadSession()
  if (session?.access_token) {
    await fetch(`${BASE}/logout`, {
      method: 'POST',
      headers: { ...HEADERS, 'Authorization': `Bearer ${session.access_token}` },
    }).catch(() => {})
  }
  await clearSession()
}

export async function resetPassword(email) {
  try {
    const res = await fetch(`${BASE}/recover`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ email }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return { error: { message: err.msg ?? err.message ?? 'Failed to send reset email' } }
    }
    return { error: null }
  } catch (e) { return { error: { message: e.message } } }
}
