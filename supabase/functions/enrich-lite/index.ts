import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// SourcedOut AI Lite — API-driven enrichment.
// Email finding is a 2-step waterfall: emailfinder.dev first, FullEnrich last.
// The only LLM calls are draft generation (Sonnet) and job summarization (Haiku).

// Bump this string every meaningful deploy so we can verify what's live.
const FUNCTION_VERSION = "2026-06-11-lite-v1.1"
console.log(`[enrich-lite boot] FUNCTION_VERSION=${FUNCTION_VERSION}`)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
  'X-Function-Version': FUNCTION_VERSION,
}

function json(data: unknown, status = 200) {
  // Stamp version into every JSON response so a single curl confirms the deploy.
  const payload = (data && typeof data === 'object' && !Array.isArray(data))
    ? { ...(data as Record<string, unknown>), _version: FUNCTION_VERSION }
    : { data, _version: FUNCTION_VERSION }
  return new Response(JSON.stringify(payload), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

async function callAnthropic(key: string, model: string, maxTokens: number, prompt: string): Promise<string> {
  const maxAttempts = 3
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) {
      const errBody = await res.text()
      console.error(`[callAnthropic] attempt ${attempt}/${maxAttempts} HTTP ${res.status} (model=${model}): ${errBody}`)
      lastErr = new Error(`Anthropic API error ${res.status}: ${errBody}`)
      if (res.status === 429 && attempt < maxAttempts) {
        const delay = attempt * 1500
        console.log(`[callAnthropic] rate-limited, retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw lastErr
    }
    const d = await res.json()
    return d.content?.[0]?.text?.trim() || '{}'
  }
  throw lastErr!
}

function parseJson(s: string): any {
  try { return JSON.parse(s.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()) } catch { return {} }
}

// ── PII helpers ───────────────────────────────────────────────────────────────
// Known personal/free email domains — emails at these domains are never work addresses.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.co.in',
  'hotmail.com','hotmail.co.uk','outlook.com','live.com','msn.com',
  'icloud.com','me.com','mac.com','aol.com','protonmail.com','proton.me',
  'pm.me','tutanota.com','zoho.com','yandex.com','yandex.ru',
  'mail.com','inbox.com','gmx.com','gmx.net',
])
function isPersonalEmailDomain(email: string | null | undefined): boolean {
  if (!email) return false
  const domain = email.split('@')[1]?.toLowerCase()
  return !!domain && PERSONAL_EMAIL_DOMAINS.has(domain)
}

function maskEmail(e: string | null | undefined): string {
  if (!e || typeof e !== 'string' || !e.includes('@')) return String(e || '')
  const [u, d] = e.split('@')
  const head = u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***'
  return `${head}@${d}`
}

// ── Credit refund ───────────────────────────────────────────────────────────────
// Returns a lookup credit that was deducted up-front when a run ultimately produces
// nothing usable (NOT_ENOUGH_DATA). Best-effort and non-fatal: prefers an atomic
// refund_credit RPC if one exists, otherwise decrements credits.lookups_used directly
// (guarded so it never goes negative).
async function refundCredit(db: any, userId: string | null | undefined, reason: string): Promise<void> {
  if (!db || !userId) return
  try {
    const { error } = await db.rpc('refund_credit', { p_user_id: userId })
    if (!error) { console.log(`[refundCredit] refunded via RPC (reason=${reason})`); return }
  } catch { /* RPC may not exist — fall back to direct decrement */ }
  try {
    const { data: c } = await db.from('credits').select('lookups_used').eq('user_id', userId).maybeSingle()
    const used = typeof c?.lookups_used === 'number' ? c.lookups_used : 0
    if (used > 0) {
      await db.from('credits').update({ lookups_used: used - 1 }).eq('user_id', userId)
      console.log(`[refundCredit] refunded via table decrement (reason=${reason})`)
    }
  } catch (e) { console.warn('[refundCredit] non-fatal:', e) }
}

// ── Step logger ────────────────────────────────────────────────────────────────
type StepStatus = 'HIT' | 'OK' | 'SKIP' | 'MISS' | 'FAIL'
interface StepRecord {
  step: string
  status: StepStatus
  ms: number
  reason?: string
  meta?: Record<string, unknown>
}

function makeStepLogger(db: any, userId: string | null, correlationId: string, action: string) {
  const records: StepRecord[] = []
  async function step<T>(
    name: string,
    fn: () => Promise<{ status: StepStatus; result?: T; reason?: string; meta?: Record<string, unknown> }>
  ): Promise<{ status: StepStatus; result?: T; reason?: string; meta?: Record<string, unknown> }> {
    const t0 = Date.now()
    let outcome: { status: StepStatus; result?: T; reason?: string; meta?: Record<string, unknown> }
    try {
      outcome = await fn()
    } catch (e: any) {
      outcome = { status: 'FAIL', reason: String(e?.message || e) }
    }
    const ms = Date.now() - t0
    const rec: StepRecord = { step: name, status: outcome.status, ms, reason: outcome.reason, meta: outcome.meta }
    records.push(rec)
    const metaStr = rec.meta ? ' ' + Object.entries(rec.meta).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ') : ''
    console.log(`[enrich ${correlationId}] ${name} → ${outcome.status} (${ms}ms)${rec.reason ? ' reason=' + rec.reason : ''}${metaStr}`)
    // Best-effort persistence (non-fatal)
    try {
      await db.from('enrichment_debug_logs').insert({
        user_id: userId,
        provider: name,
        request_payload: { correlation_id: correlationId, action },
        response_payload: { status: outcome.status, reason: outcome.reason || null, meta: rec.meta || null },
        status_code:
          outcome.status === 'OK' || outcome.status === 'HIT' ? 200
          : outcome.status === 'SKIP' ? 204
          : outcome.status === 'MISS' ? 404
          : 500,
      })
    } catch {}
    return outcome
  }
  return { step, records }
}

// ── emailfinder.dev: real-time SMTP-verified email discovery ──────────────────
// Credits are charged on their side only when a verified email is returned.
const EMAILFINDER_BASE = 'https://www.emailfinder.dev'
const EMAILFINDER_TIMEOUT_MS = 60_000 // live SMTP verification can be slow

async function emailFinderByLinkedIn(linkedinUrl: string, key: string): Promise<{
  email: string | null
  full_name: string | null
  title: string | null
  company: string | null
  raw: any
}> {
  const url = `${EMAILFINDER_BASE}/api/find-email/linkedin?linkedin_url=${encodeURIComponent(linkedinUrl)}`
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${key}` },
    signal: AbortSignal.timeout(EMAILFINDER_TIMEOUT_MS),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`emailfinder linkedin error ${res.status}: ${JSON.stringify(data)}`)
  return {
    email:     data?.valid_email        || null,
    full_name: data?.person_full_name   || null,
    title:     data?.person_job_title   || null,
    company:   data?.person_company_name || null,
    raw:       data,
  }
}

async function emailFinderByPerson(
  fullName: string,
  opts: { domain?: string | null; companyName?: string | null },
  key: string,
): Promise<{ email: string | null; raw: any }> {
  const params = new URLSearchParams({ full_name: fullName })
  if (opts.domain) params.set('domain', opts.domain)
  else if (opts.companyName) params.set('company_name', opts.companyName)
  const res = await fetch(`${EMAILFINDER_BASE}/api/find-email/person?${params.toString()}`, {
    headers: { 'Authorization': `Bearer ${key}` },
    signal: AbortSignal.timeout(EMAILFINDER_TIMEOUT_MS),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`emailfinder person error ${res.status}: ${JSON.stringify(data)}`)
  return { email: data?.valid_email || null, raw: data }
}

// ── FullEnrich v2: LinkedIn URL → work email, personal email, name, title, company ──
async function enrichWithLinkedInV2(linkedinUrl: string, key: string): Promise<{
  full_name: string | null
  work_email: string | null
  personal_email: string | null
  title: string | null
  company: string | null
  company_domain: string | null
  raw: any
}> {
  const empty = { full_name: null, work_email: null, personal_email: null, title: null, company: null, company_domain: null, raw: null }

  const startRes = await fetch('https://app.fullenrich.com/api/v2/contact/enrich/bulk', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      name: `OutreachAI-${Date.now()}`,
      data: [{ linkedin_url: linkedinUrl, enrich_fields: ['contact.emails'] }],
    }),
  })

  const startData = await startRes.json()
  if (!startRes.ok) throw new Error(`FullEnrich start error ${startRes.status}: ${JSON.stringify(startData)}`)

  const enrichmentId = startData.enrichment_id
  if (!enrichmentId) throw new Error('FullEnrich did not return enrichment_id')

  await new Promise(r => setTimeout(r, 3000))
  for (let i = 0; i < 22; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 5000))

    const pollRes = await fetch(`https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`, {
      headers: { 'Authorization': `Bearer ${key}` },
    })
    const pollData = await pollRes.json()

    if (pollData.status === 'FINISHED') {
      const results = pollData.datas ?? pollData.data ?? []
      const row = results[0]
      if (!row) return { ...empty, raw: pollData }

      const contactInfo = row.contact_info ?? row.contact?.contact_info ?? null
      const profile     = row.profile ?? row.contact?.profile ?? {}
      const current     = profile.employment?.current

      const workEmail = contactInfo?.most_probable_work_email?.email
        ?? contactInfo?.work_emails?.[0]?.email
        ?? row.contact?.most_probable_email
        ?? null
      const personalEmail = contactInfo?.most_probable_personal_email?.email
        ?? contactInfo?.personal_emails?.[0]?.email
        ?? null

      return {
        full_name:      profile.full_name || null,
        work_email:     workEmail,
        personal_email: personalEmail,
        title:          current?.title || null,
        company:        current?.company?.name || null,
        company_domain: current?.company?.domain || null,
        raw:            pollData,
      }
    }

    if (pollData.status === 'FAILED') throw new Error('FullEnrich enrichment failed')
  }

  throw new Error('FullEnrich timeout — enrichment did not complete')
}

// ── 2-step contact waterfall: emailfinder.dev → FullEnrich ────────────────────
// Shared by the single-profile flow and the campaign batch flow.
interface ContactResult {
  full_name: string | null
  work_email: string | null
  personal_email: string | null
  title: string | null
  title_verified: boolean
  company: string | null
  email_status: 'found' | 'uncertain' | 'not_found'
  source: 'emailfinder' | 'fullenrich_v2' | 'none'
  raw_data: any
}

async function enrichContact(
  inputs: {
    linkedinUrl: string | null
    fullName: string | null
    companyName: string | null
    companyDomain: string | null
  },
  keys: { emailfinderKey: string; fullenrichKey: string },
  step: ReturnType<typeof makeStepLogger>['step'],
): Promise<ContactResult> {
  const out: ContactResult = {
    full_name: inputs.fullName, work_email: null, personal_email: null,
    title: null, title_verified: false, company: inputs.companyName,
    email_status: 'not_found', source: 'none', raw_data: {},
  }

  const classify = (email: string | null) => {
    if (!email) return
    if (isPersonalEmailDomain(email)) {
      out.personal_email = email
      if (out.email_status === 'not_found') out.email_status = 'uncertain'
    } else {
      out.work_email = email
      out.email_status = 'found'
    }
  }

  // Step 1 — emailfinder.dev. The LinkedIn endpoint also returns name/title/company,
  // which fully replaces the old DOM scraper. CSV rows without a URL use the
  // person endpoint (name + company/domain).
  await step('emailfinder', async () => {
    if (!keys.emailfinderKey) return { status: 'SKIP', reason: 'no_emailfinder_key' }
    if (inputs.linkedinUrl) {
      const r = await emailFinderByLinkedIn(inputs.linkedinUrl, keys.emailfinderKey)
      out.full_name = r.full_name || out.full_name
      if (r.title) { out.title = r.title; out.title_verified = true }
      out.company = r.company || out.company
      classify(r.email)
      out.raw_data.emailfinder = r.raw
      if (r.email) {
        out.source = 'emailfinder'
        return { status: 'OK', meta: { endpoint: 'linkedin', email: maskEmail(r.email) } }
      }
      return { status: 'MISS', reason: 'no_valid_email', meta: { endpoint: 'linkedin' } }
    }
    if (inputs.fullName && (inputs.companyDomain || inputs.companyName)) {
      const r = await emailFinderByPerson(inputs.fullName, { domain: inputs.companyDomain, companyName: inputs.companyName }, keys.emailfinderKey)
      classify(r.email)
      out.raw_data.emailfinder = r.raw
      if (r.email) {
        out.source = 'emailfinder'
        return { status: 'OK', meta: { endpoint: 'person', email: maskEmail(r.email) } }
      }
      return { status: 'MISS', reason: 'no_valid_email', meta: { endpoint: 'person' } }
    }
    return { status: 'SKIP', reason: 'no_linkedin_url_or_name_company' }
  })

  // Step 2 — FullEnrich, only when emailfinder found nothing and we have a URL.
  if (!out.work_email && !out.personal_email && inputs.linkedinUrl) {
    await step('fullenrich_v2', async () => {
      if (!keys.fullenrichKey) return { status: 'SKIP', reason: 'no_fullenrich_key' }
      const r = await enrichWithLinkedInV2(inputs.linkedinUrl!, keys.fullenrichKey)
      out.full_name = r.full_name || out.full_name
      if (r.title && !out.title) { out.title = r.title; out.title_verified = true }
      out.company = r.company || out.company
      if (r.work_email) { out.work_email = r.work_email; out.email_status = 'found' }
      if (r.personal_email) {
        out.personal_email = r.personal_email
        if (out.email_status === 'not_found') out.email_status = 'uncertain'
      }
      out.raw_data.fullenrich = r.raw
      if (r.work_email || r.personal_email) {
        out.source = 'fullenrich_v2'
        return { status: 'OK', meta: { email: maskEmail(r.work_email || r.personal_email) } }
      }
      return { status: 'MISS', reason: 'no_email' }
    })
  } else if (out.work_email || out.personal_email) {
    await step('fullenrich_v2', async () => ({ status: 'SKIP', reason: 'email_found_via_emailfinder' }))
  }

  out.raw_data.waterfall_source = out.source
  return out
}

// ── Recruiter profile ──────────────────────────────────────────────────────────
interface RecruiterProfile {
  full_name:    string
  company_name: string
  job_title:    string | null
  hiring_focus: string | null
  tone:         string | null
}

// ── Draft generation ──────────────────────────────────────────────────────────
async function generateDraft(
  fullName: string, company: string | null, title: string | null,
  titleVerified: boolean, email: string | null, userContext: string | null,
  draftConf: number, anthropicKey: string,
  recruiter: RecruiterProfile | null,
  outreachType?: string | null,   // 'new_outreach' (default) | 'follow_up'
  sessionTone?: string | null,    // per-request tone override (beats recruiter-profile tone)
): Promise<{ subject: string; body: string } | null> {
  if (!anthropicKey) return null

  const titleInstruction = title
    ? (titleVerified
        ? `Candidate's current role: ${title} (confirmed from data provider — reference it naturally).`
        : `Candidate's likely role: ${title} (inferred — reference it cautiously without claiming certainty).`)
    : `Candidate's role is unknown — do NOT claim any specific title. Write using name and company only.`

  const recruiterName    = recruiter?.full_name    || null
  const recruiterCompany = recruiter?.company_name || null
  const recruiterTitle   = recruiter?.job_title    || null
  const hiringFocus      = recruiter?.hiring_focus || null
  const tone = sessionTone || recruiter?.tone || null   // session pill beats recruiter profile

  let signOff = 'Best,'
  if (recruiterName) {
    signOff = `Best,\n${recruiterName}`
    if (recruiterTitle && recruiterCompany) signOff += `\n${recruiterTitle} at ${recruiterCompany}`
  }

  const toneInstruction = tone
    ? `Tone: ${tone}, professional, peer-to-peer.`
    : 'Tone: professional, modern, peer-to-peer.'

  const hiringFocusInstruction = hiringFocus
    ? `Recruiter specializes in: ${hiringFocus} hiring.`
    : 'Recruiter specializes in general talent acquisition.'

  const recruiterBlock = recruiterName
    ? `Recruiter sending this email: ${recruiterName}${recruiterTitle ? `, ${recruiterTitle}` : ''}${recruiterCompany ? ` at ${recruiterCompany}` : ''}`
    : ''

  const isFollowUp = outreachType === 'follow_up'
  const prompt = isFollowUp
    ? `Write a brief recruiter follow-up email (40–70 words). The recruiter previously reached out to this candidate but received no response. Be warm, acknowledge the prior outreach in one sentence, and stay non-pushy. End with one soft question. Use ONLY the supplied information. Do not invent facts.

Candidate: ${fullName}
${company ? `Company: ${company}` : ''}
${titleInstruction}
${email ? `Email: ${email}` : 'No email — generate body only.'}
${userContext ? `Recruiter context: ${userContext}` : ''}
${recruiterBlock}
${hiringFocusInstruction}

Rules:
- No mention of "I saw your profile", "I noticed you", or LinkedIn.
- No exclamation marks.
- No invented achievements.
- ${toneInstruction}
- Must be noticeably shorter than a cold outreach — 40–70 words max.
- End the email body with exactly this sign-off (include it verbatim in the body field):
${signOff}

Return ONLY JSON: {"subject": "...", "body": "..."}`
    : `Write a concise recruiter outreach email (60–120 words). Use ONLY the supplied information. Do not invent facts.

Candidate: ${fullName}
${company ? `Company: ${company}` : ''}
${titleInstruction}
${email ? `Email: ${email}` : 'No email — generate body only.'}
${userContext ? `Recruiter context: ${userContext}` : ''}
${recruiterBlock}
${hiringFocusInstruction}
Confidence level: ${draftConf >= 0.65 ? 'normal — personalize where evidence exists' : 'low — be warm but generic, no specific claims'}

Rules:
- No mention of "I saw your profile", "I noticed you", or LinkedIn.
- No exclamation marks.
- No invented achievements.
- ${toneInstruction}
- One soft CTA.
- End the email body with exactly this sign-off (include it verbatim in the body field):
${signOff}

Return ONLY JSON: {"subject": "...", "body": "..."}`

  const raw = await callAnthropic(anthropicKey, 'claude-sonnet-4-5', 500, prompt)
  const p = parseJson(raw)
  if (!p.body) return null

  const bodyLines = p.body.trimEnd().split('\n')
  let trimIdx = bodyLines.length
  for (let i = bodyLines.length - 1; i >= 0; i--) {
    const line = bodyLines[i].trim()
    if (line === '' || line.startsWith('Best')) { trimIdx = i; continue }
    break
  }
  const bodyWithoutSignOff = bodyLines.slice(0, trimIdx).join('\n').trimEnd()
  const finalBody = bodyWithoutSignOff ? `${bodyWithoutSignOff}\n\n${signOff}` : signOff

  return { subject: p.subject || `Reaching out — ${fullName}`, body: finalBody }
}

// ── Weighted confidence formula ────────────────────────────────────────────────
function computeDraftConfidence(
  personConf: number, companyConf: number, titleConf: number,
  emailStatus: string, userContextLength: number
): number {
  const emailConf   = emailStatus === 'found' ? 1 : emailStatus === 'uncertain' ? 0.5 : 0
  const contextConf = Math.min(1, userContextLength / 100)
  return Math.round((
    personConf  * 0.35 +
    companyConf * 0.20 +
    titleConf   * 0.20 +
    emailConf   * 0.15 +
    contextConf * 0.10
  ) * 100) / 100
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceKey     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anthropicKey   = Deno.env.get('ANTHROPIC_API_KEY')   || ''
  const fullenrichKey  = Deno.env.get('FULLENRICH_API_KEY')  || ''
  const emailfinderKey = Deno.env.get('EMAILFINDER_API_KEY') || ''
  const db = createClient(supabaseUrl, serviceKey)

  console.log('[enrich-lite env]', JSON.stringify({
    version: FUNCTION_VERSION,
    has_anthropic_key: !!anthropicKey,
    has_fullenrich_key: !!fullenrichKey,
    has_emailfinder_key: !!emailfinderKey,
  }))

  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return json({ error: { code: 'AUTH_EXPIRED', message: 'Session expired — please sign in again.' } }, 401)
  const { data: { user }, error: authErr } = await db.auth.getUser(token)
  if (authErr || !user) return json({ error: { code: 'AUTH_EXPIRED', message: 'Session expired — please sign in again.' } }, 401)

  try {
    const body   = await req.json()
    const action = body.action || 'enrich-and-draft'

    // ── Summarize-job action ───────────────────────────────────────────────────
    if (action === 'summarize-job') {
      const rawText  = (body.rawText  || '').slice(0, 3000)
      const jobTitle = (body.jobTitle || '').trim()
      const company  = (body.company  || '').trim()
      if (!rawText && !jobTitle) return json({ error: { code: 'MISSING_INPUT', message: 'No job text provided.' } }, 400)
      if (!anthropicKey)         return json({ error: { code: 'NO_API_KEY',    message: 'AI not configured.'     } }, 500)

      const prompt = `You are helping a recruiter understand a job posting so they can write personalized outreach emails.

Job title: ${jobTitle || 'not specified'}
Company: ${company || 'not specified'}

Raw job posting text:
${rawText}

Extract the 3–5 most useful selling points a recruiter would reference in an outreach email. Focus on:
- What the role actually does day-to-day (skip generic boilerplate)
- The seniority level and key skills required
- Anything distinctive: compensation range, tech stack, team size, company stage, notable impact
- Why a strong candidate would find this role interesting

Format as short bullet points starting with "•", max 15 words each.
Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.`

      const summary = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 400, prompt)
      if (!summary || summary === '{}') return json({ error: { code: 'SUMMARY_FAILED', message: 'Could not summarize job posting.' } }, 500)
      return json({ summary })
    }

    // ── Bookmark-profile action ────────────────────────────────────────────────
    if (action === 'bookmark-profile') {
      const linkedinUrl = (body.linkedinUrl || '').trim()
      const save        = body.save !== false
      if (!linkedinUrl) return json({ error: { code: 'MISSING_INPUT', message: 'linkedinUrl is required.' } }, 400)

      const { error: updateErr, count } = await db.from('saved_profiles')
        .update({ is_bookmarked: save, updated_at: new Date().toISOString() }, { count: 'exact' })
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)

      if (updateErr) {
        console.error('bookmark-profile update failed:', updateErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not update bookmark.' } }, 500)
      }
      if (count === 0) {
        const { error: insertErr } = await db.from('saved_profiles')
          .insert({ user_id: user.id, linkedin_url: linkedinUrl, is_bookmarked: save })
        if (insertErr) {
          console.error('bookmark-profile insert failed:', insertErr)
          return json({ error: { code: 'DB_ERROR', message: 'Could not create bookmark.' } }, 500)
        }
      }
      return json({ bookmarked: save })
    }

    // ── Check-saved-profile action ─────────────────────────────────────────────
    if (action === 'check-saved-profile') {
      const linkedinUrl = (body.linkedinUrl || '').trim()
      if (!linkedinUrl) return json({ found: false })

      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data: cached } = await db.from('saved_profiles')
        .select('full_name, work_email, personal_email, title, company, title_verified, email_status, is_bookmarked, enriched_at')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .or(`is_bookmarked.eq.true,enriched_at.gte.${cacheWindow}`)
        .limit(1)
        .maybeSingle()

      if (!cached || !cached.full_name) return json({ found: false })

      return json({
        found: true,
        profile: {
          fullName:      cached.full_name,
          workEmail:     cached.work_email     || null,
          personalEmail: cached.personal_email || null,
          email:         cached.work_email || cached.personal_email || null,
          title:         cached.title          || null,
          titleVerified: cached.title_verified ?? false,
          company:       cached.company        || null,
          emailStatus:   cached.email_status   || 'not_found',
          isBookmarked:  cached.is_bookmarked  ?? false,
        },
      })
    }

    // ── Save-job action ────────────────────────────────────────────────────────
    if (action === 'save-job') {
      const label      = (body.label      || '').trim()
      const jobUrl     = (body.jobUrl     || '').trim() || null
      const roleTitle  = (body.roleTitle  || '').trim() || null
      const jobCompany = (body.company    || '').trim() || null
      const highlights = (body.highlights || '').trim() || null
      if (!label) return json({ error: { code: 'MISSING_INPUT', message: 'A job label is required.' } }, 400)

      const { data: job, error: upsertErr } = await db.from('saved_jobs')
        .upsert({
          user_id: user.id, label, job_url: jobUrl, role_title: roleTitle,
          company: jobCompany, highlights, updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,label' })
        .select('id, label, job_url, role_title, company, highlights')
        .single()

      if (upsertErr) {
        console.error('save-job upsert failed:', upsertErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not save job.' } }, 500)
      }
      return json({ job })
    }

    // ── Get-saved-jobs action ──────────────────────────────────────────────────
    if (action === 'get-saved-jobs') {
      const { data: jobs, error: fetchErr } = await db.from('saved_jobs')
        .select('id, label, job_url, role_title, company, highlights, updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(30)

      if (fetchErr) {
        console.error('get-saved-jobs failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load saved jobs.' } }, 500)
      }
      return json({ jobs: jobs || [] })
    }

    // ── Delete-job action ──────────────────────────────────────────────────────
    if (action === 'delete-job') {
      const jobId = (body.jobId || '').trim()
      if (!jobId) return json({ error: { code: 'MISSING_INPUT', message: 'jobId is required.' } }, 400)

      const { error: deleteErr } = await db.from('saved_jobs')
        .delete()
        .eq('id', jobId)
        .eq('user_id', user.id)

      if (deleteErr) {
        console.error('delete-job failed:', deleteErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not delete job.' } }, 500)
      }
      return json({ deleted: true })
    }

    // ── Get-saved-profiles action ──────────────────────────────────────────────
    if (action === 'get-saved-profiles') {
      const { data: profiles, error: fetchErr } = await db.from('saved_profiles')
        .select('id, linkedin_url, full_name, work_email, personal_email, title, company, title_verified, email_status, enriched_at, is_bookmarked')
        .eq('user_id', user.id)
        .eq('is_bookmarked', true)
        .order('updated_at', { ascending: false })
        .limit(20)

      if (fetchErr) {
        console.error('get-saved-profiles fetch failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load saved profiles.' } }, 500)
      }
      return json({ profiles: profiles || [] })
    }

    // ── Import-campaign action ─────────────────────────────────────────────────
    if (action === 'import-campaign') {
      const campaignName = (body.campaignName || '').trim()
      const jobId        = (body.jobId || '').trim() || null
      const candidates   = Array.isArray(body.candidates) ? body.candidates : []

      if (!campaignName) return json({ error: { code: 'MISSING_INPUT', message: 'Campaign name is required.' } }, 400)
      if (candidates.length === 0) return json({ error: { code: 'MISSING_INPUT', message: 'No candidates provided.' } }, 400)

      const linkedinUrls = candidates.map((c: any) => c.linkedin_url).filter(Boolean)
      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      let cachedCount = 0
      if (linkedinUrls.length > 0) {
        const { data: cachedProfiles } = await db.from('saved_profiles')
          .select('linkedin_url')
          .eq('user_id', user.id)
          .in('linkedin_url', linkedinUrls)
          .gte('enriched_at', cacheWindow)
        cachedCount = cachedProfiles?.length || 0
      }
      const freshNeeded = candidates.length - cachedCount

      const { data: credits } = await db.from('credits')
        .select('tier, lookups_used')
        .eq('user_id', user.id)
        .maybeSingle()

      let creditsRemaining = 10
      if (credits) {
        const tierLimits: Record<string, number> = { free: 10, sourcer: 50, pro: 200 }
        const max = tierLimits[credits.tier] || 10
        creditsRemaining = Math.max(0, max - (credits.lookups_used || 0))
      }

      const creditWarning = freshNeeded > creditsRemaining ? {
        needed: freshNeeded,
        available: creditsRemaining,
        message: `You have ${creditsRemaining} lookup${creditsRemaining !== 1 ? 's' : ''} remaining. Only ${creditsRemaining} of ${freshNeeded} candidates needing enrichment can be processed. Upgrade to enrich the full pipeline.`,
      } : null

      const campaignStatus = jobId ? 'ready' : 'needs_job'
      const { data: campaign, error: campaignErr } = await db.from('campaigns')
        .insert({
          user_id: user.id,
          name: campaignName,
          job_id: jobId,
          status: campaignStatus,
          total_count: candidates.length,
        })
        .select('id, name, job_id, status, total_count')
        .single()

      if (campaignErr || !campaign) {
        console.error('import-campaign insert failed:', campaignErr)
        if (campaignErr?.code === '23505') {
          return json({ error: { code: 'DUPLICATE_CAMPAIGN', message: 'A campaign with this name already exists. Rename it and try again.' } }, 409)
        }
        return json({ error: { code: 'DB_ERROR', message: 'Could not create campaign.' } }, 500)
      }

      const candidateRows = candidates.map((c: any) => ({
        campaign_id:     campaign.id,
        user_id:         user.id,
        first_name:      c.first_name || null,
        last_name:       c.last_name  || null,
        headline:        c.headline   || null,
        location:        c.location   || null,
        current_title:   c.current_title   || null,
        current_company: c.current_company || null,
        csv_email:       c.email      || null,
        phone:           c.phone      || null,
        linkedin_url:    c.linkedin_url || null,
        notes:           c.notes      || null,
        feedback:        c.feedback   || null,
        status:          'imported',
      }))

      const { error: candidatesErr } = await db.from('campaign_candidates').insert(candidateRows)
      if (candidatesErr) {
        console.error('import-campaign candidates insert failed:', candidatesErr)
        await db.from('campaigns').delete().eq('id', campaign.id)
        return json({ error: { code: 'DB_ERROR', message: 'Could not import candidates.' } }, 500)
      }

      return json({ campaign, totalCount: candidates.length, creditWarning })
    }

    // ── Get-campaigns action ───────────────────────────────────────────────────
    if (action === 'get-campaigns') {
      const { data: campaigns, error: fetchErr } = await db.from('campaigns')
        .select('id, name, job_id, status, total_count, enriched_count, drafted_count, approved_count, created_at, saved_jobs(label, company, job_url)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50)

      if (fetchErr) {
        console.error('get-campaigns failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load campaigns.' } }, 500)
      }

      // Compute live sent / responded / followed_up counts from candidate rows (single query)
      const campaignIds = (campaigns || []).map((c: any) => c.id)
      const statusCounts: Record<string, { approved: number; followed_up: number; responded: number }> = {}
      if (campaignIds.length > 0) {
        const { data: statusRows } = await db.from('campaign_candidates')
          .select('campaign_id, status')
          .eq('user_id', user.id)
          .in('campaign_id', campaignIds)
          .in('status', ['approved', 'followed_up', 'responded'])
        ;(statusRows || []).forEach((r: any) => {
          if (!statusCounts[r.campaign_id]) statusCounts[r.campaign_id] = { approved: 0, followed_up: 0, responded: 0 }
          const k = r.status as 'approved' | 'followed_up' | 'responded'
          statusCounts[r.campaign_id][k]++
        })
      }

      const withRates = (campaigns || []).map((c: any) => {
        const sc = statusCounts[c.id] || { approved: 0, followed_up: 0, responded: 0 }
        return {
          ...c,
          sent_count:        sc.approved + sc.followed_up + sc.responded,
          responded_count:   sc.responded,
          followed_up_count: sc.followed_up,
        }
      })
      return json({ campaigns: withRates })
    }

    // ── Get-campaign-candidates action ─────────────────────────────────────────
    if (action === 'get-campaign-candidates') {
      const campaignId = (body.campaignId || '').trim()
      const statusFilter = body.status || null
      if (!campaignId) return json({ error: { code: 'MISSING_INPUT', message: 'campaignId is required.' } }, 400)

      let query = db.from('campaign_candidates')
        .select('*, saved_profiles ( raw_data )')
        .eq('campaign_id', campaignId)
        .eq('user_id', user.id)
        .order('created_at', { ascending: true })
        .limit(200)

      if (statusFilter) query = query.eq('status', statusFilter)

      const { data: candidates, error: fetchErr } = await query
      if (fetchErr) {
        console.error('get-campaign-candidates failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load candidates.' } }, 500)
      }
      // Surface the waterfall source on each candidate so the UI can show a
      // "Source" badge (emailfinder, fullenrich_v2) at a glance.
      const enriched = (candidates || []).map((c: any) => {
        const raw = c.saved_profiles?.raw_data || {}
        const src = raw.waterfall_source || null
        delete c.saved_profiles
        return { ...c, enrichment_source: src }
      })
      return json({ candidates: enriched })
    }

    // ── Enrich-campaign-candidate action ──────────────────────────────────────
    if (action === 'enrich-campaign-candidate') {
      const candidateId = (body.candidateId || '').trim()
      if (!candidateId) return json({ error: { code: 'MISSING_INPUT', message: 'candidateId is required.' } }, 400)

      const correlationId = crypto.randomUUID().slice(0, 8)
      const { step, records } = makeStepLogger(db, user.id, correlationId, 'enrich-campaign-candidate')

      const { data: candidate, error: fetchErr } = await db.from('campaign_candidates')
        .select('*')
        .eq('id', candidateId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (fetchErr || !candidate) return json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } }, 404)

      const fullName = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || null
      const companyHint =
        (candidate.current_company && String(candidate.current_company).trim()) ||
        (candidate.enriched_company && String(candidate.enriched_company).trim()) ||
        null
      const csvRawDomain = (candidate.csv_email && candidate.csv_email.includes('@'))
        ? candidate.csv_email.split('@')[1].toLowerCase()
        : null
      // A personal CSV email (gmail etc.) says nothing about the employer's
      // domain — using it would make emailfinder hunt for a work email at gmail.com.
      const csvEmailDomain = (csvRawDomain && !PERSONAL_EMAIL_DOMAINS.has(csvRawDomain)) ? csvRawDomain : null

      // Without a LinkedIn URL the person endpoint still works if we have a
      // name plus a company or email domain. Otherwise there is nothing to go on.
      if (!candidate.linkedin_url && !(fullName && (companyHint || csvEmailDomain))) {
        await db.from('campaign_candidates').update({ status: 'no_email', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ status: 'no_email', reason: 'No LinkedIn URL or name+company available for enrichment.', debug: { correlationId, records } })
      }

      await db.from('campaign_candidates').update({ status: 'enriching', updated_at: new Date().toISOString() }).eq('id', candidateId)

      // Step 1 — Cache (keyed by LinkedIn URL)
      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      let cached: any = null
      if (candidate.linkedin_url) {
        await step('cache', async () => {
          const { data } = await db.from('saved_profiles')
            .select('id, full_name, work_email, personal_email, title, company, title_verified, email_status, enriched_at')
            .eq('user_id', user.id)
            .eq('linkedin_url', candidate.linkedin_url)
            .gte('enriched_at', cacheWindow)
            .maybeSingle()
          if (data && data.full_name) {
            cached = data
            return { status: 'HIT', meta: { has_email: !!(data.work_email || data.personal_email) } }
          }
          return { status: 'MISS' }
        })
      }

      if (cached) {
        const email = cached.work_email || cached.personal_email || null
        const newStatus = email ? 'enriched' : 'no_email'
        await db.from('campaign_candidates').update({
          status:           newStatus,
          work_email:       cached.work_email || null,
          personal_email:   cached.personal_email || null,
          email_status:     cached.email_status || 'not_found',
          enriched_title:   cached.title || null,
          enriched_company: cached.company || null,
          saved_profile_id: cached.id,
          enriched_at:      new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        }).eq('id', candidateId)

        await _incrementCampaignCount(db, candidate.campaign_id, 'enriched_count')

        return json({ status: newStatus, fromCache: true, email, debug: { correlationId, records } })
      }

      // Deduct credit for fresh enrichment
      const { data: creditAllowed, error: creditErr } = await db.rpc('deduct_credit', { p_user_id: user.id })
      if (creditErr) {
        await db.from('campaign_candidates').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ error: { code: 'CREDIT_ERROR', message: 'Could not verify credit balance.' }, debug: { correlationId, records } }, 500)
      }
      if (creditAllowed === false) {
        await db.from('campaign_candidates').update({ status: 'imported', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ error: { code: 'CREDIT_LIMIT_REACHED', message: 'Credit limit reached. Upgrade to continue enriching.' }, debug: { correlationId, records } }, 402)
      }

      // ── Heavy work runs in the background; we return 202 immediately because
      //    the FullEnrich fallback can poll for up to ~110s.
      const runEnrichmentJob = async () => {
        try {
          const contact = await enrichContact(
            {
              linkedinUrl: candidate.linkedin_url || null,
              fullName,
              companyName: companyHint,
              companyDomain: csvEmailDomain,
            },
            { emailfinderKey, fullenrichKey },
            step,
          )

          const newStatus = (contact.work_email || contact.personal_email) ? 'enriched' : 'no_email'

          let savedProfileId: string | null = null
          if (candidate.linkedin_url) {
            const { data: savedProfile } = await db.from('saved_profiles').upsert({
              user_id:        user.id,
              linkedin_url:   candidate.linkedin_url,
              full_name:      contact.full_name || fullName,
              work_email:     contact.work_email,
              personal_email: contact.personal_email,
              title:          contact.title || candidate.current_title || null,
              company:        contact.company,
              title_verified: contact.title_verified,
              email_status:   contact.email_status,
              raw_data:       contact.raw_data,
              enriched_at:    new Date().toISOString(),
              updated_at:     new Date().toISOString(),
            }, { onConflict: 'user_id,linkedin_url', ignoreDuplicates: false })
              .select('id')
              .maybeSingle()
            savedProfileId = savedProfile?.id || null
          }

          await db.from('campaign_candidates').update({
            status:           newStatus,
            work_email:       contact.work_email,
            personal_email:   contact.personal_email,
            email_status:     contact.email_status,
            enriched_title:   contact.title || candidate.current_title || null,
            enriched_company: contact.company,
            saved_profile_id: savedProfileId,
            enriched_at:      new Date().toISOString(),
            updated_at:       new Date().toISOString(),
          }).eq('id', candidateId)

          await _incrementCampaignCount(db, candidate.campaign_id, 'enriched_count')
          console.log(`[enrich-bg ${correlationId}] done status=${newStatus} source=${contact.source}`)
        } catch (e: any) {
          console.error(`[enrich-bg ${correlationId}] failed:`, e)
          try {
            await db.from('campaign_candidates').update({
              status: 'failed',
              updated_at: new Date().toISOString(),
            }).eq('id', candidateId)
          } catch {}
        }
      }

      // Kick off background job. EdgeRuntime.waitUntil keeps the worker alive
      // after the response is sent. Fall back to fire-and-forget if unavailable.
      // @ts-ignore — EdgeRuntime is provided by Supabase's Deno runtime
      if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime.waitUntil === 'function') {
        // @ts-ignore
        EdgeRuntime.waitUntil(runEnrichmentJob())
      } else {
        runEnrichmentJob().catch(() => {})
      }

      return json({
        status: 'enriching',
        candidateId,
        message: 'Enrichment started. Poll get-campaign-candidates for updates.',
        debug: { correlationId, records },
      }, 202)
    }

    // ── Draft-campaign-candidate action ───────────────────────────────────────
    if (action === 'draft-campaign-candidate') {
      const candidateId = (body.candidateId || '').trim()
      if (!candidateId) return json({ error: { code: 'MISSING_INPUT', message: 'candidateId is required.' } }, 400)

      const { data: candidate, error: fetchErr } = await db.from('campaign_candidates')
        .select('*')
        .eq('id', candidateId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (fetchErr || !candidate) return json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } }, 404)

      const { data: campaign } = await db.from('campaigns')
        .select('job_id')
        .eq('id', candidate.campaign_id)
        .maybeSingle()

      let jobContext: string | null = null
      if (campaign?.job_id) {
        const { data: job } = await db.from('saved_jobs')
          .select('role_title, company, highlights')
          .eq('id', campaign.job_id)
          .maybeSingle()
        if (job) {
          const parts = []
          if (job.role_title) parts.push(`Recruiting for: ${job.role_title}${job.company ? ' at ' + job.company : ''}`)
          if (job.highlights) parts.push(job.highlights)
          jobContext = parts.join('. ') || null
        }
      }

      let recruiterProfile: RecruiterProfile | null = null
      try {
        const { data: rp } = await db.from('recruiter_profiles')
          .select('full_name, company_name, job_title, hiring_focus, tone')
          .eq('user_id', user.id)
          .maybeSingle()
        if (rp) recruiterProfile = rp as RecruiterProfile
      } catch {}

      const email = candidate.work_email || candidate.personal_email || candidate.csv_email || null
      const fullName = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || 'this candidate'
      const company = candidate.enriched_company || candidate.current_company || null
      const title = candidate.enriched_title || candidate.current_title || null

      await db.from('campaign_candidates').update({ status: 'drafting', updated_at: new Date().toISOString() }).eq('id', candidateId)

      const personConf  = 0.8
      const companyConf = company ? 0.85 : 0.3
      const titleConf   = title ? 0.7 : 0
      const emailStatus = email ? (candidate.work_email ? 'found' : 'uncertain') : 'not_found'
      const draftConf = computeDraftConfidence(personConf, companyConf, titleConf, emailStatus, (jobContext || '').length)

      try {
        const draft = await generateDraft(
          fullName, company, title, !!candidate.enriched_title,
          email, jobContext,
          draftConf, anthropicKey,
          recruiterProfile
        )

        if (!draft) {
          await db.from('campaign_candidates').update({ status: 'enriched', updated_at: new Date().toISOString() }).eq('id', candidateId)
          return json({ error: { code: 'DRAFT_FAILED', message: 'Could not generate draft.' } }, 500)
        }

        await db.from('campaign_candidates').update({
          status:           'drafted',
          draft_subject:    draft.subject,
          draft_body:       draft.body,
          draft_confidence: draftConf,
          drafted_at:       new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        }).eq('id', candidateId)

        await _incrementCampaignCount(db, candidate.campaign_id, 'drafted_count')

        try { await db.rpc('increment_ai_run', { p_user_id: user.id }) } catch {}

        return json({ status: 'drafted', draft, draftConfidence: draftConf })
      } catch (e: any) {
        console.error('draft-campaign-candidate failed:', e)
        await db.from('campaign_candidates').update({ status: 'enriched', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ error: { code: 'DRAFT_FAILED', message: e.message || 'Draft generation failed.' } }, 500)
      }
    }

    // ── Update-candidate-status action ─────────────────────────────────────────
    if (action === 'update-candidate-status') {
      const candidateId = (body.candidateId || '').trim()
      const newStatus   = (body.status || '').trim()
      const allowed     = ['approved', 'skipped', 'imported', 'enriched', 'drafted', 'followed_up', 'responded']
      if (!candidateId) return json({ error: { code: 'MISSING_INPUT', message: 'candidateId is required.' } }, 400)
      if (!allowed.includes(newStatus)) return json({ error: { code: 'INVALID_STATUS', message: 'Invalid status value.' } }, 400)

      const updateData: any = { status: newStatus, updated_at: new Date().toISOString() }
      if (newStatus === 'approved')     updateData.approved_at     = new Date().toISOString()
      if (newStatus === 'followed_up')  updateData.followed_up_at  = new Date().toISOString()

      const { data: updated, error: updateErr } = await db.from('campaign_candidates')
        .update(updateData)
        .eq('id', candidateId)
        .eq('user_id', user.id)
        .select('id, campaign_id, status')
        .maybeSingle()

      if (updateErr) return json({ error: { code: 'DB_ERROR', message: 'Could not update status.' } }, 500)

      if (newStatus === 'approved' && updated?.campaign_id) {
        await _incrementCampaignCount(db, updated.campaign_id, 'approved_count')
      }

      return json({ updated: true, status: newStatus })
    }

    // ── Link-campaign-job action ───────────────────────────────────────────────
    if (action === 'link-campaign-job') {
      const campaignId = (body.campaignId || '').trim()
      const jobId      = (body.jobId || '').trim()
      if (!campaignId || !jobId) return json({ error: { code: 'MISSING_INPUT', message: 'campaignId and jobId are required.' } }, 400)

      const { error: updateErr } = await db.from('campaigns')
        .update({ job_id: jobId, status: 'ready', updated_at: new Date().toISOString() })
        .eq('id', campaignId)
        .eq('user_id', user.id)

      if (updateErr) return json({ error: { code: 'DB_ERROR', message: 'Could not link job.' } }, 500)
      return json({ linked: true })
    }

    // ── Delete-campaign action ─────────────────────────────────────────────────
    if (action === 'delete-campaign') {
      const campaignId = (body.campaignId || '').trim()
      if (!campaignId) return json({ error: { code: 'MISSING_INPUT', message: 'campaignId is required.' } }, 400)

      const { error: deleteErr } = await db.from('campaigns')
        .delete()
        .eq('id', campaignId)
        .eq('user_id', user.id)

      if (deleteErr) return json({ error: { code: 'DB_ERROR', message: 'Could not delete campaign.' } }, 500)
      return json({ deleted: true })
    }

    // ── Guard: reject unknown actions before falling through to default flow ──
    const KNOWN_ACTIONS = [
      'enrich-and-draft', 'summarize-job', 'bookmark-profile', 'check-saved-profile',
      'get-saved-profiles', 'save-job', 'get-saved-jobs', 'delete-job',
      'import-campaign', 'get-campaigns', 'get-campaign-candidates',
      'enrich-campaign-candidate', 'draft-campaign-candidate',
      'update-candidate-status', 'link-campaign-job', 'delete-campaign',
    ]
    if (!KNOWN_ACTIONS.includes(action)) {
      return json({ error: { code: 'UNKNOWN_ACTION', message: `Unknown action: ${action}` } }, 400)
    }

    // ── Enrich-and-draft action (default single-profile flow) ─────────────────
    const linkedinUrl  = body.linkedinUrl?.trim()  || null
    const companyHint  = body.companyHint?.trim()  || null
    const userContext  = body.userContext?.trim()  || null
    const fullNameHint = body.fullNameHint?.trim() || null
    const sessionTone  = body.tone?.trim()         || null   // per-request tone pill override
    const outreachType = body.outreachType?.trim() || null   // 'new_outreach' | 'follow_up'

    console.log('[outreach-enrich inputs]', { linkedinUrl, fullNameHint, companyHint })

    if (!linkedinUrl) return json({ error: { code: 'NO_LINKEDIN_URL', message: 'Open a LinkedIn profile to generate a draft.' } }, 400)

    const correlationId = crypto.randomUUID().slice(0, 8)
    const { step, records } = makeStepLogger(db, user.id, correlationId, 'enrich-and-draft')

    let recruiterProfile: RecruiterProfile | null = null
    try {
      const { data: rp } = await db.from('recruiter_profiles')
        .select('full_name, company_name, job_title, hiring_focus, tone')
        .eq('user_id', user.id)
        .maybeSingle()
      if (rp) recruiterProfile = rp as RecruiterProfile
    } catch (e) { console.warn('recruiter_profiles fetch failed (non-fatal):', e) }

    // Step 1 — Cache
    const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    let cached: any = null
    await step('cache', async () => {
      const { data } = await db.from('saved_profiles')
        .select('full_name, work_email, personal_email, title, company, title_verified, email_status, is_bookmarked, enriched_at')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .or(`is_bookmarked.eq.true,enriched_at.gte.${cacheWindow}`)
        .limit(1)
        .maybeSingle()
      if (data && data.full_name) {
        cached = data
        return { status: 'HIT', meta: { has_email: !!(data.work_email || data.personal_email) } }
      }
      return { status: 'MISS' }
    })

    if (cached) {
      const fullName       = cached.full_name
      const work_email     = cached.work_email || null
      const personal_email = cached.personal_email || null
      const selectedEmail  = work_email || personal_email || null
      const company        = companyHint || cached.company || null
      const title          = cached.title || null
      const titleVerified  = cached.title_verified ?? false
      const emailStatus    = (cached.email_status as 'found' | 'not_found' | 'uncertain') || 'not_found'

      const personConfidence  = 0.95
      const companyConfidence = company ? 0.90 : 0.3
      const titleConfidence   = title ? (titleVerified ? 0.90 : 0.40) : 0

      const draftConfidence = computeDraftConfidence(
        personConfidence, companyConfidence, titleConfidence,
        emailStatus, (userContext || '').length
      )

      let status: 'success' | 'partial' | 'not_enough_data' = 'success'
      if (!selectedEmail && !company) status = 'not_enough_data'
      else if (!selectedEmail || titleConfidence < 0.3) status = 'partial'

      let draft: { subject: string; body: string } | null = null
      if (status !== 'not_enough_data' && anthropicKey) {
        try {
          draft = await step('sonnet_draft', async () => {
            const d = await generateDraft(
              fullName, company, title, titleVerified,
              selectedEmail, userContext,
              draftConfidence, anthropicKey,
              recruiterProfile,
              outreachType,
              sessionTone,
            )
            return { status: d ? 'OK' : 'MISS', result: d, meta: { confidence: draftConfidence } }
          }).then(r => r.result || null)
        } catch (e) { console.error('Draft generation (cache) failed:', e) }
      }

      if (!draft && status !== 'not_enough_data') {
        return json({ error: { code: 'DRAFT_GENERATION_FAILED', message: 'Contact details were found, but the draft could not be generated.' }, debug: { correlationId, records } }, 500)
      }

      return json({
        status,
        fromCache: true,
        isBookmarked: cached.is_bookmarked ?? false,
        person: {
          fullName, company, title, titleVerified,
          email: selectedEmail, workEmail: work_email,
          personalEmail: personal_email, emailStatus,
          emailSource: 'saved_profile',
        },
        confidence: { personConfidence, companyConfidence, titleConfidence, draftConfidence },
        sources: [{ type: 'saved_profile', label: 'From saved profile (cached)', confidence: 0.95 }],
        draft: draft || null,
        debug: { correlationId, records },
      })
    }

    // Idempotency guard (fail-open): stop two simultaneous in-flight lookups of the
    // same profile from each deducting a credit. Repeat lookups *after* completion
    // are served free by the cache step above; the lock is released explicitly at
    // the end of the run and expires via TTL if the worker dies mid-flight.
    try {
      // TTL must outlast the worst-case waterfall (emailfinder 60s + FullEnrich ~113s)
      const { data: lockOk, error: lockErr } = await db.rpc('acquire_lookup_lock', { p_user_id: user.id, p_linkedin_url: linkedinUrl, p_ttl_seconds: 240 })
      if (!lockErr && lockOk === false) {
        return json({ error: { code: 'LOOKUP_IN_PROGRESS', message: 'This profile is already being looked up. Give it a moment and try again — no extra credit will be charged.' }, debug: { correlationId, records } }, 409)
      }
    } catch { /* RPC not deployed — fail open */ }
    const releaseLock = async () => {
      try { await db.rpc('release_lookup_lock', { p_user_id: user.id, p_linkedin_url: linkedinUrl }) } catch {}
    }

    const { data: creditAllowed, error: creditErr } = await db.rpc('deduct_credit', { p_user_id: user.id })
    if (creditErr) {
      console.error('deduct_credit RPC error:', creditErr)
      await releaseLock()
      return json({ error: { code: 'CREDIT_ERROR', message: 'Could not verify your credit balance. Please try again.' }, debug: { correlationId, records } }, 500)
    }
    if (creditAllowed === false) {
      await releaseLock()
      return json({ error: { code: 'CREDIT_LIMIT_REACHED', message: 'You have reached your lookup limit. Upgrade your plan for more enrichments.' }, debug: { correlationId, records } }, 402)
    }

    // ── 2-step waterfall: emailfinder.dev → FullEnrich ────────────────────────
    const contact = await enrichContact(
      { linkedinUrl, fullName: fullNameHint, companyName: companyHint, companyDomain: null },
      { emailfinderKey, fullenrichKey },
      step,
    )
    await releaseLock()

    const fullName       = contact.full_name || ''
    const work_email     = contact.work_email
    const personal_email = contact.personal_email
    const selectedEmail  = work_email || personal_email || null
    const company        = contact.company
    const title          = contact.title
    const titleVerified  = contact.title_verified
    const emailStatus    = contact.email_status

    if (!fullName) {
      // Credit was deducted up-front but we could not identify the person — refund it.
      await refundCredit(db, user.id, 'not_enough_data_no_name')
      return json({ error: { code: 'NOT_ENOUGH_DATA', message: 'Could not identify this person. Try again or check the LinkedIn profile URL. No lookup credit was charged.' }, debug: { correlationId, records } }, 422)
    }

    const sources: any[] = []
    const personConfidence  = contact.full_name && contact.full_name !== fullNameHint ? 0.95 : (fullNameHint ? 0.7 : 0.5)
    const companyConfidence = contact.source !== 'none' && company ? 0.90 : (company ? 0.7 : 0.3)
    const titleConfidence   = title ? (titleVerified ? 0.90 : 0.40) : 0
    if (work_email) {
      sources.push({ type: contact.source, label: `Email via ${contact.source}`, confidence: 0.9 })
    } else if (personal_email) {
      sources.push({ type: contact.source, label: `Personal email via ${contact.source}`, confidence: 0.7 })
    }

    const draftConfidence = computeDraftConfidence(
      personConfidence, companyConfidence, titleConfidence,
      emailStatus, (userContext || '').length
    )

    let status: 'success' | 'partial' | 'not_enough_data' = 'success'
    if (!selectedEmail && !company) status = 'not_enough_data'
    else if (!selectedEmail || titleConfidence < 0.3) status = 'partial'

    // The credit was deducted up-front. If the run produced neither an email
    // nor a company, the user got nothing usable — refund it.
    if (status === 'not_enough_data') {
      await refundCredit(db, user.id, 'not_enough_data_result')
    }

    let draft: { subject: string; body: string } | null = null
    if (status !== 'not_enough_data' && anthropicKey) {
      try {
        const r = await step('sonnet_draft', async () => {
          const d = await generateDraft(
            fullName, company, title, titleVerified,
            selectedEmail, userContext,
            draftConfidence, anthropicKey,
            recruiterProfile,
            outreachType,
            sessionTone,
          )
          return { status: d ? 'OK' : 'MISS', result: d, meta: { confidence: draftConfidence } }
        })
        draft = (r.result as any) || null
      } catch (e) { console.error('Draft generation failed:', e) }
    }

    if (!draft && status !== 'not_enough_data') {
      return json({ error: { code: 'DRAFT_GENERATION_FAILED', message: 'Contact details were found, but the draft could not be generated.' }, debug: { correlationId, records } }, 500)
    }

    try { await db.rpc('increment_ai_run', { p_user_id: user.id }) } catch (e) { console.error('increment_ai_run RPC failed (non-fatal):', e) }

    let isBookmarked = false
    try {
      await db.from('saved_profiles').upsert({
        user_id: user.id, linkedin_url: linkedinUrl, full_name: fullName,
        work_email: work_email || null, personal_email: personal_email || null,
        title: title || null, company: company || null, title_verified: titleVerified,
        email_status: emailStatus, enriched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), raw_data: contact.raw_data || null,
      }, { onConflict: 'user_id,linkedin_url', ignoreDuplicates: false })

      const { data: savedRow } = await db.from('saved_profiles')
        .select('is_bookmarked')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .maybeSingle()
      isBookmarked = savedRow?.is_bookmarked ?? false
    } catch (e) { console.error('saved_profiles upsert failed (non-fatal):', e) }

    console.log('[enrich summary]', JSON.stringify({
      correlationId,
      version: FUNCTION_VERSION,
      source: contact.source,
      email_status: emailStatus,
      keys_missing: [!emailfinderKey && 'emailfinder', !fullenrichKey && 'fullenrich', !anthropicKey && 'anthropic'].filter(Boolean),
    }))

    return json({
      status, fromCache: false, isBookmarked, runId: null,
      person: {
        fullName, company: company || null, title: title || null, titleVerified,
        email: selectedEmail || null, workEmail: work_email || null,
        personalEmail: personal_email || null, emailStatus,
        emailSource: contact.source,
      },
      confidence: { personConfidence, companyConfidence, titleConfidence, draftConfidence },
      sources,
      draft: draft || null,
      debug: { correlationId, records },
    })

  } catch (e: any) {
    console.error('enrich-lite error:', String(e?.message || e), e?.stack || '')
    return json({ error: { code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' } }, 500)
  }
})

// ── Helper: increment a campaign aggregate count ──────────────────────────────
async function _incrementCampaignCount(db: any, campaignId: string, field: string) {
  // Use an RPC for an atomic increment so concurrent enrichments don't race.
  // Falls back to a read-modify-write if the RPC is not deployed yet (fail-open).
  try {
    const { error } = await db.rpc('increment_campaign_count', { p_campaign_id: campaignId, p_field: field })
    if (!error) return
    console.warn(`[_incrementCampaignCount] RPC failed (${error.message}), falling back to read-modify-write`)
    const { data: camp } = await db.from('campaigns').select(field).eq('id', campaignId).maybeSingle()
    if (camp) {
      await db.from('campaigns').update({
        [field]: (camp[field] || 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq('id', campaignId)
    }
  } catch (e) { console.error(`_incrementCampaignCount(${field}) failed:`, e) }
}
