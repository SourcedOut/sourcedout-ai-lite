// ─── reply-checker.js ────────────────────────────────────────────────────────
// Automatic inbox reply detection for Gmail and Outlook.
// Uses chrome.identity.launchWebAuthFlow — OAuth client IDs are stored in
// extension local storage (entered once via Settings).

const GMAIL_SCOPE   = 'https://www.googleapis.com/auth/gmail.readonly'
const GOOGLE_AUTH   = 'https://accounts.google.com/o/oauth2/v2/auth'
const MS_AUTH_BASE  = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const MS_SCOPES     = 'https://graph.microsoft.com/Mail.Read openid'
const MS_GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

const REDIRECT_URI = () => `https://${chrome.runtime.id}.chromiumapp.org/`

function _store(keys) { return new Promise(r => chrome.storage.local.get(keys, r)) }
function _save(obj)   { return new Promise(r => chrome.storage.local.set(obj, r)) }

// ── Gmail ─────────────────────────────────────────────────────────────────────

export async function getGmailStatus() {
  const { sourcedout_gmail_connected, sourcedout_gmail_client_id } =
    await _store(['sourcedout_gmail_connected', 'sourcedout_gmail_client_id'])
  return { connected: !!sourcedout_gmail_connected, clientId: sourcedout_gmail_client_id || '' }
}

export async function connectGmail(clientId) {
  if (!clientId?.trim()) throw new Error('SETUP_REQUIRED')
  const token = await _googleAuthFlow(clientId.trim(), true)
  await _save({
    sourcedout_gmail_connected: true,
    sourcedout_gmail_token:     token,
    sourcedout_gmail_token_exp: _parseJwtExp(token),
    sourcedout_gmail_client_id: clientId.trim(),
  })
  return token
}

export async function disconnectGmail() {
  const { sourcedout_gmail_token } = await _store(['sourcedout_gmail_token'])
  if (sourcedout_gmail_token) {
    fetch(`https://accounts.google.com/o/oauth2/revoke?token=${sourcedout_gmail_token}`).catch(() => {})
  }
  await _save({ sourcedout_gmail_connected: false, sourcedout_gmail_token: null })
}

async function _getGmailToken() {
  const { sourcedout_gmail_token, sourcedout_gmail_token_exp, sourcedout_gmail_client_id } =
    await _store(['sourcedout_gmail_token', 'sourcedout_gmail_token_exp', 'sourcedout_gmail_client_id'])
  if (!sourcedout_gmail_token) throw new Error('Not connected')
  if (sourcedout_gmail_token_exp && Date.now() > sourcedout_gmail_token_exp - 300_000) {
    if (sourcedout_gmail_client_id) {
      try {
        const fresh = await _googleAuthFlow(sourcedout_gmail_client_id, false)
        await _save({ sourcedout_gmail_token: fresh, sourcedout_gmail_token_exp: _parseJwtExp(fresh) })
        return fresh
      } catch {}
    }
    await _save({ sourcedout_gmail_connected: false })
    throw new Error('TOKEN_EXPIRED')
  }
  return sourcedout_gmail_token
}

function _googleAuthFlow(clientId, interactive) {
  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'token',
    redirect_uri:  REDIRECT_URI(),
    scope:         GMAIL_SCOPE,
    prompt:        interactive ? 'select_account' : 'none',
  })
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: `${GOOGLE_AUTH}?${params}`, interactive },
      responseUrl => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message || 'Gmail auth failed or was cancelled'))
          return
        }
        const p     = new URLSearchParams((responseUrl.split('#')[1] || ''))
        const token = p.get('access_token')
        if (!token) { reject(new Error('No access token in Google response')); return }
        resolve(token)
      }
    )
  })
}

// Check Gmail for replies from the given email addresses.
// Returns Set<string> of email addresses that have sent at least one message to this inbox.
export async function checkGmailReplies(emailAddresses) {
  if (!emailAddresses.length) return new Set()
  const repliedEmails = new Set()
  try {
    const token = await _getGmailToken()
    for (let i = 0; i < emailAddresses.length; i += 15) {
      const batch = emailAddresses.slice(i, i + 15)
      const q     = batch.map(e => `from:${e}`).join(' OR ')
      const res   = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=50`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) continue
      const data = await res.json()
      if (!data.messages?.length) continue
      // Fetch the From header for each matched message (parallel, cap 20/batch)
      await Promise.all(data.messages.slice(0, 20).map(async msg => {
        try {
          const mRes = await fetch(
            `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From`,
            { headers: { Authorization: `Bearer ${token}` } }
          )
          if (!mRes.ok) return
          const mData   = await mRes.json()
          const fromVal = mData.payload?.headers?.find(h => h.name === 'From')?.value || ''
          const match   = fromVal.match(/<([^>]+)>/)
          const email   = (match?.[1] || fromVal).toLowerCase().trim()
          if (batch.some(e => e.toLowerCase() === email)) repliedEmails.add(email)
        } catch {}
      }))
    }
  } catch (e) {
    if (!['Not connected', 'TOKEN_EXPIRED'].includes(e.message)) {
      console.warn('[SourcedOut] Gmail reply check error:', e.message)
    }
  }
  return repliedEmails
}

// ── Outlook ───────────────────────────────────────────────────────────────────

export async function getOutlookStatus() {
  const { sourcedout_outlook_connected, sourcedout_outlook_client_id } =
    await _store(['sourcedout_outlook_connected', 'sourcedout_outlook_client_id'])
  return { connected: !!sourcedout_outlook_connected, clientId: sourcedout_outlook_client_id || '' }
}

export async function connectOutlook(clientId) {
  if (!clientId?.trim()) throw new Error('SETUP_REQUIRED')
  const token = await _outlookAuthFlow(clientId.trim(), true)
  await _save({
    sourcedout_outlook_connected: true,
    sourcedout_outlook_token:     token,
    sourcedout_outlook_token_exp: _parseJwtExp(token),
    sourcedout_outlook_client_id: clientId.trim(),
  })
  return token
}

export async function disconnectOutlook() {
  await _save({ sourcedout_outlook_connected: false, sourcedout_outlook_token: null })
}

async function _getOutlookToken() {
  const { sourcedout_outlook_token, sourcedout_outlook_token_exp, sourcedout_outlook_client_id } =
    await _store(['sourcedout_outlook_token', 'sourcedout_outlook_token_exp', 'sourcedout_outlook_client_id'])
  if (!sourcedout_outlook_token) throw new Error('Not connected')
  if (sourcedout_outlook_token_exp && Date.now() > sourcedout_outlook_token_exp - 300_000) {
    if (sourcedout_outlook_client_id) {
      try {
        const fresh = await _outlookAuthFlow(sourcedout_outlook_client_id, false)
        await _save({ sourcedout_outlook_token: fresh, sourcedout_outlook_token_exp: _parseJwtExp(fresh) })
        return fresh
      } catch {}
    }
    await _save({ sourcedout_outlook_connected: false })
    throw new Error('TOKEN_EXPIRED')
  }
  return sourcedout_outlook_token
}

function _outlookAuthFlow(clientId, interactive) {
  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'token',
    redirect_uri:  REDIRECT_URI(),
    scope:         MS_SCOPES,
    response_mode: 'fragment',
  })
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: `${MS_AUTH_BASE}/authorize?${params}`, interactive },
      responseUrl => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message || 'Outlook auth cancelled'))
          return
        }
        const p     = new URLSearchParams((responseUrl.split('#')[1] || ''))
        const token = p.get('access_token')
        if (!token) { reject(new Error('No access token in Outlook response')); return }
        resolve(token)
      }
    )
  })
}

// Check Outlook inbox for replies from the given email addresses.
// Returns Set<string> of email addresses that have sent at least one message.
export async function checkOutlookReplies(emailAddresses) {
  if (!emailAddresses.length) return new Set()
  const repliedEmails = new Set()
  try {
    const token = await _getOutlookToken()
    for (let i = 0; i < emailAddresses.length; i += 10) {
      const batch  = emailAddresses.slice(i, i + 10)
      const filter = batch.map(e => `from/emailAddress/address eq '${e.replace(/'/g, "''")}'`).join(' or ')
      const res    = await fetch(
        `${MS_GRAPH_BASE}/me/messages?$filter=${encodeURIComponent(filter)}&$select=from&$top=50`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      )
      if (!res.ok) {
        if (res.status === 401) await _save({ sourcedout_outlook_connected: false })
        continue
      }
      const data = await res.json()
      for (const msg of (data.value || [])) {
        const fromEmail = msg.from?.emailAddress?.address?.toLowerCase()
        if (fromEmail && batch.some(e => e.toLowerCase() === fromEmail)) repliedEmails.add(fromEmail)
      }
    }
  } catch (e) {
    if (!['Not connected', 'TOKEN_EXPIRED'].includes(e.message)) {
      console.warn('[SourcedOut] Outlook reply check error:', e.message)
    }
  }
  return repliedEmails
}

// ── Last-checked timestamp ────────────────────────────────────────────────────

export async function saveLastChecked() {
  await _save({ sourcedout_reply_last_checked: Date.now() })
}

export async function getLastChecked() {
  const { sourcedout_reply_last_checked } = await _store(['sourcedout_reply_last_checked'])
  return sourcedout_reply_last_checked || null
}

// ── Shared util ───────────────────────────────────────────────────────────────

function _parseJwtExp(token) {
  try {
    const part    = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(part))
    return payload.exp ? payload.exp * 1000 : Date.now() + 3_600_000
  } catch { return Date.now() + 3_600_000 }
}
