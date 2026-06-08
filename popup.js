// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, signInWithMicrosoft, signInWithEmailPassword, signUpWithEmailPassword, getUser, signOut, getAccessToken, resetPassword } from './core/auth.js'
import { getCreditsData, enrichAndDraft, summarizeJob, bookmarkProfile, getSavedProfiles, checkSavedProfile, saveJob, getSavedJobs, deleteJob, openUpgradePage, parseErrorMessage, isAuthError } from './core/api.js'
import { getGmailStatus, connectGmail, disconnectGmail, getOutlookStatus, connectOutlook, disconnectOutlook, getLastChecked } from './core/reply-checker.js'

// ── State machine ─────────────────────────────────────────────────────────────
// States: IDLE | PREFILLED | SUBMITTING | ENRICHING | DRAFTING | SUCCESS | PARTIAL_SUCCESS | EMPTY_RESULT | AUTH_ERROR | GENERIC_ERROR
let _state = 'IDLE'
let _lastResult = null
let _linkedinUrl = null
let _isBookmarked = false
let _isGenerating = false  // double-submission guard
let _prefillAborted = false  // set to true while batch drawer is open
let _mainAppListenersBound = false
let _companyHintSource = null  // diagnostic: which scraper path produced companyHint
let _selectedTone = null           // null = recruiter-profile default; 'formal'|'friendly'|'brief'
let _outreachType = 'new_outreach' // 'new_outreach' | 'follow_up'

// ── Helpers ───────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id)
const qs = sel => document.querySelector(sel)
function getStorage(keys) { return new Promise(r => chrome.storage.local.get(keys, r)) }
function setStorage(obj)  { return new Promise(r => chrome.storage.local.set(obj, r)) }

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(pref) {
  const dark = pref === 'dark' || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.body.classList.toggle('dark', dark)
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === (pref || 'system')))
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setupTabs() {
  const activate = (name) => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
    document.querySelectorAll('.tab').forEach(t => {
      if (t.dataset.tab === name) t.classList.add('active')
    })
    $(`tab-${name}`)?.classList.add('active')
    const gear = $('settingsIconBtn')
    if (gear) gear.classList.toggle('active', name === 'settings')
  }
  document.querySelectorAll('.tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => activate(tab.dataset.tab))
  })
  $('settingsIconBtn')?.addEventListener('click', () => activate('settings'))
}

// ── Status message ────────────────────────────────────────────────────────────
// Accepts: 'info' | 'success' | 'warn' | 'warning' | 'error'
// Normalize 'warning' -> 'warn' so the popup CSS class actually applies.
function setStatus(msg, type = 'info') {
  const el = $('statusMessage')
  if (!el) return
  const normalized = type === 'warning' ? 'warn' : type
  el.textContent = msg
  el.className = normalized
}
function clearStatus() {
  const el = $('statusMessage')
  el.textContent = ''
  el.className = ''
  el.style.display = 'none'
}

// ── Progress dots ─────────────────────────────────────────────────────────────
function setProgress(step) {
  // step: 'enrich' | 'company' | 'draft' | 'done'
  const steps = ['enrich', 'company', 'draft']
  const idx = steps.indexOf(step)
  steps.forEach((s, i) => {
    const dot = $(`dot${s.charAt(0).toUpperCase() + s.slice(1)}`)
    const lbl = $(`lbl${s.charAt(0).toUpperCase() + s.slice(1)}`)
    if (!dot) return
    if (step === 'done') { dot.className = 'progress-dot done'; if (lbl) lbl.className = 'progress-label done' }
    else if (i < idx)   { dot.className = 'progress-dot done';  if (lbl) lbl.className = 'progress-label done' }
    else if (i === idx) { dot.className = 'progress-dot active'; if (lbl) lbl.className = 'progress-label active' }
    else                { dot.className = 'progress-dot';        if (lbl) lbl.className = 'progress-label' }
  })
}

// ── UI sections ───────────────────────────────────────────────────────────────
function showSection(id, visible = true) {
  const el = $(id)
  if (el) el.style.display = visible ? 'block' : 'none'
}

function resetToIdle() {
  showSection('progressSection', false)
  showSection('resultSummary', false)
  showSection('draftOutput', false)
  showSection('errorBox', false)
  showSection('inputSection', true)
  const csConfRow = $('csConfidenceRow')
  if (csConfRow) csConfRow.style.display = 'none'
  clearStatus()
  $('generateDraftButton').disabled = false
  $('generateDraftButton').textContent = '✨ Generate draft'
}

function showErrorBox(message, isAuth = false, allowHtml = false) {
  showSection('progressSection', false)
  showSection('resultSummary', false)
  showSection('draftOutput', false)
  const csConfRow = $('csConfidenceRow')
  if (csConfRow) csConfRow.style.display = 'none'
  const box = $('errorBox')
  box.className = isAuth ? 'auth' : ''
  box.style.display = 'block'
  if (allowHtml) $('errorMessage').innerHTML = message
  else           $('errorMessage').textContent = message
  $('authRecoveryButton').style.display = isAuth ? 'block' : 'none'
  $('generateDraftButton').disabled = false
  $('generateDraftButton').textContent = '✨ Generate draft'
}

// ── Confidence display ────────────────────────────────────────────────────────
function renderConfidence(draftConfidence) {
  const pct = Math.round(draftConfidence * 100)
  const fill = $('confFill')
  const badge = $('confBadge')
  const note = $('confNote')
  if (!fill) return
  fill.style.width = `${pct}%`
  if (pct >= 80) {
    fill.className = 'confidence-fill high'
    badge.textContent = 'High confidence'
    badge.className = 'confidence-badge high'
    if (note) note.textContent = ''
  } else if (pct >= 60) {
    fill.className = 'confidence-fill mid'
    badge.textContent = 'Medium confidence'
    badge.className = 'confidence-badge mid'
    if (note) note.textContent = 'Draft based on partial information — review before sending.'
  } else {
    fill.className = 'confidence-fill low'
    badge.textContent = 'Low confidence'
    badge.className = 'confidence-badge low'
    if (note) note.textContent = 'Limited public signals available. Edit the draft carefully before sending.'
  }
}

// ── Result rendering ──────────────────────────────────────────────────────────
function renderResult(result) {
  const { person, confidence, draft, status } = result
  _lastResult = result

  // Show confidence bar inside candidate summary card (resultSummary card removed)
  const csConfRow = $('csConfidenceRow')
  if (csConfRow) csConfRow.style.display = 'block'
  renderConfidence(confidence.draftConfidence)

  // Status messages for partial states
  if (status === 'partial') {
    if (!person.email) {
      setStatus('No work email found — draft generated from partial info.', 'warn')
    } else if (!person.title) {
      setStatus('Company found, but title is uncertain — draft keeps it general.', 'warn')
    }
  } else if (status === 'not_enough_data') {
    setStatus('Not enough reliable info to generate a strong draft.', 'warn')
    return
  }

  // Draft
  if (draft) {
    showSection('draftOutput', true)
    const subjectEl = $('draftSubjectLine')
    if (draft.subject) {
      subjectEl.innerHTML = `<strong>Subject:</strong> ${draft.subject}`
      $('draftBody').dataset.subject = draft.subject
    }
    $('draftBody').value = draft.body || ''
  }

  // Wire compose buttons
  const to = person.email || ''
  const subject = draft?.subject || `Reaching out — ${person.fullName}`
  const body = draft?.body || ''

  $('btnOpenOutlook').onclick = () => chrome.tabs.create({
    url: `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent($('draftBody').value)}`
  })
  $('btnOpenGmail').onclick = () => chrome.tabs.create({
    url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent($('draftBody').value)}`
  })
}

// ── Candidate summary card (top of Outreach tab) ─────────────────────────────
function populateCandidateSummary(result) {
  const { person, fromCache, isBookmarked, debug } = result
  _isBookmarked = isBookmarked ?? false

  const card = $('candidateSummary')
  if (card) card.classList.add('visible')

  const cacheBadge = $('csCacheBadge')
  if (cacheBadge) cacheBadge.style.display = fromCache ? 'inline-block' : 'none'

  $('csName').textContent = person.fullName || '—'

  const metaParts = []
  if (person.title) metaParts.push(person.title)
  if (person.company) metaParts.push(person.company)
  $('csMeta').textContent = metaParts.join(' · ')

  // Client-side personal domain guard: even if the server mis-routes a gmail as work,
  // we reclassify it here so the field always shows the correct type.
  const PERSONAL_DOMAINS_CLIENT = new Set(['gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.co.in','hotmail.com','hotmail.co.uk','outlook.com','live.com','icloud.com','me.com','mac.com','protonmail.com','proton.me','fastmail.com','aol.com','msn.com'])
  function isPersonalDomainClient(addr) {
    const d = addr?.split('@')[1]?.toLowerCase()
    return d && PERSONAL_DOMAINS_CLIENT.has(d)
  }
  const rawWork     = person.workEmail     || (person.email && !person.personalEmail ? person.email : null)
  const rawPersonal = person.personalEmail || null
  // Reclassify: if rawWork is on a personal domain, move it to personal
  const workEmail     = rawWork && !isPersonalDomainClient(rawWork) ? rawWork : null
  const personalEmail = rawPersonal
    || (rawWork && isPersonalDomainClient(rawWork) ? rawWork : null)
    || (!workEmail && person.email ? person.email : null)

  // ── Separate work / personal email field rows ─────────────────────────────
  const workRow       = $('csWorkEmailRow')
  const workVal       = $('csWorkEmailVal')
  const personalRow   = $('csPersonalEmailRow')
  const personalVal   = $('csPersonalEmailVal')
  const noEmailEl     = $('csNoEmail')
  const copyWorkBtn   = $('csCopyWork')
  const copyPersonal  = $('csCopyPersonal')

  if (workRow)     workRow.style.display     = workEmail     ? 'flex' : 'none'
  if (personalRow) personalRow.style.display = personalEmail ? 'flex' : 'none'
  if (noEmailEl)   noEmailEl.style.display   = (!workEmail && !personalEmail) ? 'block' : 'none'
  if (workVal)     workVal.textContent        = workEmail     || ''
  if (personalVal) personalVal.textContent    = personalEmail || ''

  // Auto-copy work email to clipboard on find — flash '✓ Copied' on the label
  if (workEmail && navigator.clipboard) {
    navigator.clipboard.writeText(workEmail).then(() => {
      const lbl = workRow?.querySelector('.cs-email-field-label')
      if (lbl) {
        const orig = lbl.textContent
        lbl.textContent = '✓ Copied'
        setTimeout(() => { lbl.textContent = orig }, 1500)
      }
    }).catch(() => {})  // silent fail if clipboard access is denied
  }

  if (copyWorkBtn) {
    copyWorkBtn.onclick = () => {
      if (workEmail) navigator.clipboard?.writeText(workEmail).then(() => {
        copyWorkBtn.textContent = '✓'
        setTimeout(() => { copyWorkBtn.textContent = '⎘' }, 1200)
      })
    }
  }
  if (copyPersonal) {
    copyPersonal.onclick = () => {
      if (personalEmail) navigator.clipboard?.writeText(personalEmail).then(() => {
        copyPersonal.textContent = '✓'
        setTimeout(() => { copyPersonal.textContent = '⎘' }, 1200)
      })
    }
  }

  // ── Email title: full address on hover (since value is truncated with ellipsis) ──
  if (workVal && workEmail)       workVal.title = workEmail
  if (personalVal && personalEmail) personalVal.title = personalEmail

  // ── Email source trace tooltip ──
  const traceEl = $('csSourceTrace')
  if (traceEl) traceEl.style.display = 'none'
  const src = buildEmailSourceLabel(person.emailSource, debug)
  if (src) {
    const sourceTooltip = `${src.icon} via ${src.label}${src.detail ? ' (' + src.detail + ')' : ''}`
    if (workVal && workEmail)         workVal.title       = `${workEmail}\n${sourceTooltip}`
    if (personalVal && personalEmail) personalVal.title   = `${personalEmail}\n${sourceTooltip}`
  }

  // ── LinkedIn icon button (compact — just the "in" badge, no URL text) ──
  const linkEl = $('csLinkedinLink')
  if (_linkedinUrl && linkEl) {
    linkEl.href = _linkedinUrl
    linkEl.style.display = 'inline-flex'
  } else if (linkEl) {
    linkEl.style.display = 'none'
  }

  // ── Collapse / expand the summary body ──
  const toggleBtn  = $('csSummaryToggle')
  const summaryBody = $('csSummaryBody')
  if (toggleBtn && summaryBody) {
    toggleBtn.onclick = () => {
      const collapsed = summaryBody.style.display === 'none'
      summaryBody.style.display = collapsed ? '' : 'none'
      toggleBtn.textContent     = collapsed ? '▾' : '▸'
      toggleBtn.title           = collapsed ? 'Minimize' : 'Expand'
    }
  }

  updateBookmarkButton()
}

function updateBookmarkButton() {
  const btn = $('btnBookmark')
  if (!btn) return
  btn.textContent = _isBookmarked ? '✅ Saved' : '🔖 Save profile'
  btn.className = `btn btn-ghost${_isBookmarked ? ' btn-bookmark-saved' : ''}`
  btn.style.cssText = 'font-size:11px;padding:4px 9px;width:auto;'
}

// ── Profile tab: saved profiles list ─────────────────────────────────────────
async function loadSavedProfiles() {
  const listEl = $('savedProfilesList')
  if (!listEl) return
  try {
    const { profiles } = await getSavedProfiles()
    const emptyEl = $('savedProfilesEmpty')

    // Always clear stale rows first
    listEl.querySelectorAll('.saved-profile-row').forEach(el => el.remove())

    if (!profiles || profiles.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block'
      return
    }
    if (emptyEl) emptyEl.style.display = 'none'

    for (const p of profiles) {
      const row = document.createElement('div')
      row.className = 'saved-profile-row'
      const meta = p.company || p.work_email || p.personal_email || ''
      const nameSpan = document.createElement('span')
      nameSpan.className = 'saved-profile-name'
      nameSpan.textContent = p.full_name || '—'
      const metaSpan = document.createElement('span')
      metaSpan.className = 'saved-profile-meta'
      metaSpan.textContent = meta
      row.appendChild(nameSpan)
      row.appendChild(metaSpan)
      row.addEventListener('click', () => {
        _linkedinUrl = p.linkedin_url
        // Pre-fill Draft tab inputs for when user navigates there
        if ($('fullNameInput'))    $('fullNameInput').value    = p.full_name || ''
        if ($('companyHintInput')) $('companyHintInput').value = p.company   || ''
        // Update profile pill and open customize section if data is present
        updateProfilePill(p.full_name || 'LinkedIn profile detected')
        if (p.full_name || p.company) {
          const fields = $('customizeFields'); const toggle = $('customizeToggle')
          if (fields && toggle) { fields.style.display = 'block'; toggle.textContent = '▾ Customize draft' }
        }
        // Populate profile card and STAY on the Profile tab
        populateCandidateSummary({
          person: {
            fullName:      p.full_name      || '',
            email:         p.work_email || p.personal_email || null,
            workEmail:     p.work_email     || null,
            personalEmail: p.personal_email || null,
            title:         p.title          || null,
            titleVerified: p.title_verified ?? false,
            company:       p.company        || null,
            emailStatus:   p.email_status   || 'not_found',
          },
          fromCache: true,
          isBookmarked: p.is_bookmarked ?? false,
        })
      })
      listEl.appendChild(row)
    }
  } catch (e) {
    console.warn('loadSavedProfiles failed:', e)
  }
}

// ── Candidate summary + bookmark setup ───────────────────────────────────────
function setupCandidateSummary() {
  $('btnBookmark')?.addEventListener('click', async () => {
    if (!_linkedinUrl) return
    const newState = !_isBookmarked
    const btn = $('btnBookmark')
    btn.disabled = true
    try {
      await bookmarkProfile({ linkedinUrl: _linkedinUrl, save: newState })
      _isBookmarked = newState
      updateBookmarkButton()
      const statusEl = $('bookmarkStatus')
      if (statusEl) {
        statusEl.textContent = newState ? 'Profile saved to your list.' : 'Profile removed from saved list.'
        statusEl.style.color = newState ? '#16a34a' : '#9ca3af'
        setTimeout(() => { statusEl.textContent = '' }, 2500)
      }
      await loadSavedProfiles()
    } catch (e) {
      const statusEl = $('bookmarkStatus')
      if (statusEl) { statusEl.textContent = 'Could not save — try again.'; statusEl.style.color = '#dc2626' }
    } finally {
      btn.disabled = false
    }
  })

  const toggle = $('savedProfilesToggle')
  const wrap = $('savedProfilesWrap')
  if (toggle && wrap) {
    toggle.addEventListener('click', () => {
      const open = wrap.style.display !== 'none'
      wrap.style.display = open ? 'none' : 'block'
      toggle.textContent = open ? 'Saved profiles' : 'Hide saved profiles'
    })
  }

  loadSavedProfiles()
}

// ── Core flow ─────────────────────────────────────────────────────────────────
async function generateDraftFlow() {
  // Double-submission guard
  if (_isGenerating) return
  _isGenerating = true

  const companyHint    = $('companyHintInput').value.trim() || null
  const userContext    = $('userContextInput').value.trim() || null
  const fullNameHint   = $('fullNameInput').value.trim() || null

  if (!_linkedinUrl) {
    setStatus('Open a LinkedIn profile page first, then click Generate draft.', 'error')
    _isGenerating = false
    return
  }

  // Get job context for draft personalization
  const jobData = await getStorage(['job_title', 'job_company', 'job_description'])
  const contextParts = [userContext]
  if (jobData.job_title) contextParts.push(`Recruiting for: ${jobData.job_title}${jobData.job_company ? ' at ' + jobData.job_company : ''}`)
  if (jobData.job_description) contextParts.push(jobData.job_description)
  const fullContext = contextParts.filter(Boolean).join('. ') || null

  // Disable input, show progress
  _state = 'ENRICHING'
  $('generateDraftButton').disabled = true
  $('generateDraftButton').textContent = 'Working…'
  clearStatus()
  showSection('progressSection', true)
  showSection('resultSummary', false)
  showSection('draftOutput', false)
  showSection('errorBox', false)
  const _confRowGen = $('csConfidenceRow')
  if (_confRowGen) _confRowGen.style.display = 'none'
  setProgress('enrich')

  // Simulate step transitions (progress UI while async work runs)
  const companyTimer = setTimeout(() => setProgress('company'), 5000)
  const draftTimer   = setTimeout(() => setProgress('draft'), 12000)

  try {
    const result = await enrichAndDraft({
      linkedinUrl: _linkedinUrl,
      companyHint,
      companyHintSource: companyHint ? (_companyHintSource || 'manual') : null,
      userContext: fullContext,
      fullNameHint,
      tone: _selectedTone,
      outreachType: _outreachType,
    })

    clearTimeout(companyTimer)
    clearTimeout(draftTimer)
    setProgress('done')

    showSection('progressSection', false)
    _state = result.status === 'success' ? 'SUCCESS'
           : result.status === 'partial' ? 'PARTIAL_SUCCESS'
           : 'EMPTY_RESULT'

    // Populate name and company fields from FullEnrich result for recruiter reference
    if (result.person?.fullName) {
      $('fullNameInput').value = result.person.fullName
      updateProfilePill(result.person.fullName)
    }
    if (result.person?.company && !$('companyHintInput').value.trim()) {
      $('companyHintInput').value = result.person.company
    }

    renderResult(result)
    populateCandidateSummary(result)

    // Store pattern confidence data for diagnostics panel
    const patternData = extractPatternData(result.debug)
    if (patternData) await setStorage({ sourcedout_last_patterns: patternData })

    // Append to lookup history (last 5, shown in diagnostics)
    await storeLookupHistory(result)
    // Re-render diagnostics panel immediately so the new entry appears without a manual Refresh click
    renderDiagnostics()

    // Cache result by LinkedIn URL
    const cacheKey = `outreach_${_linkedinUrl.replace(/[^a-z0-9]/gi, '_').slice(-60)}`
    await setStorage({ [cacheKey]: { result, timestamp: Date.now() } })

  } catch (e) {
    clearTimeout(companyTimer)
    clearTimeout(draftTimer)
    showSection('progressSection', false)

    const err = parseErrorMessage(e)
    const auth = isAuthError(e) || isAuthError(err)

    if (auth) {
      _state = 'AUTH_ERROR'
      showErrorBox('Your session expired. Click below to sign out and sign back in.', true)
    } else if (err.code === 'NEED_FULL_NAME') {
      // Free retry — backend did NOT charge a credit. Focus the input.
      _state = 'NEED_NAME'
      updateProfilePill('⚠ Name not detected — please type it')
      showErrorBox(err.message || "Type the name above and click Lookup again — no credit charged.")
      try {
        const fields = $('customizeFields'); const toggle = $('customizeToggle')
        if (fields && toggle) { fields.style.display = 'block'; toggle.textContent = '▾ Customize draft' }
        $('fullNameInput').focus()
      } catch {}
    } else if (err.code === 'NEED_COMPANY') {
      // Free retry — backend couldn't discover company from any free source.
      _state = 'NEED_COMPANY'
      updateProfilePill('⚠ Company not detected — please type it')
      const candidates = Array.isArray(err.companyCandidates) ? err.companyCandidates : []
      const suggestionsHtml = candidates.length
        ? `<div style="margin-top:8px;font-size:12px;color:#6b7280;">Suggestions:</div>
           <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
             ${candidates.map(c => `<button type="button" class="company-suggestion" data-name="${String(c.name).replace(/"/g,'&quot;')}" style="font-size:12px;padding:4px 10px;border:1px solid #d1d5db;border-radius:999px;background:#f9fafb;cursor:pointer;">${c.name}</button>`).join('')}
           </div>`
        : ''
      showErrorBox((err.message || "Couldn't detect this person's company. Type it above and try again — no credit charged.") + suggestionsHtml, false, true)
      try {
        const fields = $('customizeFields'); const toggle = $('customizeToggle')
        if (fields && toggle) { fields.style.display = 'block'; toggle.textContent = '▾ Customize draft' }
        $('companyHintInput').focus()
        document.querySelectorAll('.company-suggestion').forEach(btn => {
          btn.addEventListener('click', () => {
            $('companyHintInput').value = btn.getAttribute('data-name') || ''
            _companyHintSource = 'suggestion'
          })
        })
      } catch {}
    } else {
      _state = 'GENERIC_ERROR'
      const MESSAGES = {
        NO_LINKEDIN_URL:         'Open a LinkedIn profile page to generate a draft.',
        ENRICHMENT_UNAVAILABLE:  'Contact lookup is temporarily unavailable. Please try again.',
        NO_EMAIL_FOUND:          'No work email was found. A draft can still be generated.',
        NOT_ENOUGH_DATA:         "There isn't enough reliable public information to generate a strong draft.",
        DRAFT_GENERATION_FAILED: 'Contact details were found, but the draft could not be generated.',
        CREDIT_LIMIT_REACHED:    'You have reached your lookup limit. Upgrade your plan for more enrichments.',
        CREDIT_ERROR:            'Could not verify your credit balance. Please try again.',
      }
      showErrorBox(MESSAGES[err.code] || err.message || 'Something went wrong.')
    }
  } finally {
    _isGenerating = false
  }
}

// ── Profile pill helper ───────────────────────────────────────────────────────
function updateProfilePill(label) {
  const pill = $('profilePill')
  const text = $('profilePillText')
  if (!pill || !text) return
  if (label) {
    text.textContent = label
    pill.style.display = 'flex'
  } else {
    pill.style.display = 'none'
  }
}

// ── Customize toggle helper ───────────────────────────────────────────────────
function setupCustomizeToggle() {
  const toggle = $('customizeToggle')
  const fields = $('customizeFields')
  if (!toggle || !fields) return
  toggle.addEventListener('click', () => {
    const open = fields.style.display !== 'none'
    fields.style.display = open ? 'none' : 'block'
    toggle.textContent = open ? '▸ Customize draft' : '▾ Customize draft'
  })
}

// ── Page prefill strategy ─────────────────────────────────────────────────────
// ms must exceed the content script's worst-case scrape time. scrapeCurrentCompanyRobust
// can poll up to ~3.6s (3s experience-section poll + 0.6s top-card re-render poll) on
// slow profiles, so the old 3000ms timeout could fire first and drop the response —
// leaving _linkedinUrl unset and surfacing "Open a LinkedIn profile page first".
function sendMessageWithTimeout(tabId, msg, ms = 6000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    new Promise(resolve => setTimeout(() => resolve(null), ms))
  ])
}

async function prefillFromPage() {
  if (_prefillAborted || $('batchDrawer')?.classList.contains('open')) return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url) return

    const isLinkedInProfile = tab.url.includes('linkedin.com/in/') ||
      tab.url.includes('linkedin.com/talent/') ||
      tab.url.includes('linkedin.com/recruiter/')

    let data = null
    try {
      data = await sendMessageWithTimeout(tab.id, { type: 'scrape' })
    } catch {}
    // Retry once if the first attempt threw OR timed out (resolved null) — the
    // content script may still be injecting, or the scrape ran long. Without this
    // a null result leaves _linkedinUrl unset ("Open a LinkedIn profile page first").
    if (!data && isLinkedInProfile) {
      await new Promise(r => setTimeout(r, 800))
      if (_prefillAborted || $('batchDrawer')?.classList.contains('open')) return
      try {
        data = await sendMessageWithTimeout(tab.id, { type: 'scrape' })
      } catch {}
    }

    if (_prefillAborted || $('batchDrawer')?.classList.contains('open')) return

    // Accept any LinkedIn profile URL: standard (/in/), Recruiter (/talent/, /recruiter/), etc.
    if (data?.linkedin_url && data.linkedin_url.includes('linkedin.com/')) {
      _linkedinUrl = data.linkedin_url
      _state = 'PREFILLED'

      // Pre-fill scraped full name so it gets passed as fullNameHint to enrichAndDraft.
      // Without this, the Step 2-6 waterfall (haiku/google_cse/myemailverifier/apollo)
      // SKIPs every step with reason: no_full_name_yet.
      if (data.full_name && !$('fullNameInput').value.trim()) {
        $('fullNameInput').value = data.full_name
        updateProfilePill(data.full_name)
      } else if (data.name_scrape_failed && !$('fullNameInput').value.trim()) {
        // Make the failure visible — otherwise user clicks Lookup, backend
        // returns NEED_FULL_NAME, and they're confused.
        updateProfilePill('⚠ Name not detected — please type it')
        setStatus("Couldn't read the name from this LinkedIn page. Type the name above to get a free, full waterfall lookup.", 'warning')
        try { $('fullNameInput').focus() } catch {}
      } else {
        updateProfilePill('LinkedIn profile detected')
      }

      // Pre-fill scraped current company so the server-side waterfall has
      // a domain to infer from. Without this, resolve_domain returns MISS
      // and every step before FullEnrich skips.
      if (data.current_company && $('companyHintInput') && !$('companyHintInput').value.trim()) {
        $('companyHintInput').value = data.current_company
      } else if (!data.current_company && $('companyHintInput') && !$('companyHintInput').value.trim()) {
        // Couldn't auto-detect — nudge the user. Same UX pattern as the name field above.
        setStatus("Couldn't auto-detect company — type it in Customize draft for best results.", 'warning')
        const fields = $('customizeFields'); const toggle = $('customizeToggle')
        if (fields && toggle) { fields.style.display = 'block'; toggle.textContent = '▾ Customize draft' }
      }
      // Stash the source so generateDraftFlow can forward it to the server logs.
      _companyHintSource = data.current_company_source || null
      try {
        await setStorage({
          sourcedout_last_scrape: {
            at: Date.now(),
            url: _linkedinUrl,
            full_name: data.full_name || null,
            current_company: data.current_company || null,
            current_company_source: data.current_company_source || null,
          },
        })
      } catch {}

      // Check saved-profile cache immediately — no credit needed
      try {
        if (_prefillAborted || $('batchDrawer')?.classList.contains('open')) return
        const check = await checkSavedProfile({ linkedinUrl: _linkedinUrl })
        if (_prefillAborted || $('batchDrawer')?.classList.contains('open')) return
        if (check.found) {
          const p = check.profile
          // Pre-fill Draft tab inputs
          if (p.fullName) $('fullNameInput').value = p.fullName
          if (p.company && !$('companyHintInput').value.trim()) $('companyHintInput').value = p.company
          // Update pill to show the cached name
          if (p.fullName) updateProfilePill(p.fullName)
          // Auto-open customize section when we have pre-filled data
          const fields = $('customizeFields')
          const toggle = $('customizeToggle')
          if (fields && toggle && (p.fullName || p.company)) {
            fields.style.display = 'block'
            toggle.textContent = '▾ Customize draft'
          }
          setStatus('Saved profile detected — draft is free.', 'success')
          populateCandidateSummary({
            person: {
              fullName: p.fullName, email: p.email,
              workEmail: p.workEmail, personalEmail: p.personalEmail,
              title: p.title, titleVerified: p.titleVerified,
              company: p.company, emailStatus: p.emailStatus,
            },
            fromCache: true,
            isBookmarked: p.isBookmarked,
          })
        } else {
          setStatus('LinkedIn profile detected — ready to generate draft.', 'info')
        }
      } catch {
        if (!_prefillAborted && !$('batchDrawer')?.classList.contains('open')) {
          setStatus('LinkedIn profile detected — ready to generate draft.', 'info')
        }
      }
    } else {
      updateProfilePill(null)
    }
  } catch {}
}

// ── Credits UI ────────────────────────────────────────────────────────────────
async function loadCreditsUI() {
  try {
    const credits = await getCreditsData()
    const tier = credits?.tier ?? 'free'
    const used = credits?.lookups_used ?? 0
    const max  = CONFIG.tiers[tier]?.lookups ?? 10

    if ($('settingsEmail') && credits?.user_id) {
      const user = await getUser()
      if (user?.email) $('settingsEmail').textContent = user.email
    }
    const badge = $('settingsPlanBadge')
    if (badge) {
      badge.textContent = CONFIG.tiers[tier]?.label ?? 'Free'
      badge.className = `plan-badge${tier === 'free' ? ' free' : ''}`
    }
    if ($('settingsLookups')) $('settingsLookups').textContent = `${used} / ${max}`
  } catch {}
}

// ── Recruiter profile API helpers ─────────────────────────────────────────────
async function fetchRecruiterProfile() {
  const token = await getAccessToken()
  if (!token) return null
  try {
    const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/recruiter_profiles?select=*&limit=1`, {
      headers: {
        'apikey':        CONFIG.supabaseKey,
        'Authorization': `Bearer ${token}`,
      },
    })
    if (!res.ok) return null
    const rows = await res.json()
    return rows?.[0] ?? null
  } catch { return null }
}

async function saveRecruiterProfile({ fullName, companyName, jobTitle, hiringFocus, tone }) {
  const token = await getAccessToken()
  if (!token) throw new Error('Not authenticated')
  const user = await getUser()
  if (!user?.id) throw new Error('No user')

  const payload = {
    user_id:      user.id,
    full_name:    fullName,
    company_name: companyName,
    job_title:    jobTitle || null,
    hiring_focus: hiringFocus || null,
    tone:         tone || null,
    updated_at:   new Date().toISOString(),
  }

  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/recruiter_profiles?on_conflict=user_id`, {
    method: 'POST',
    headers: {
      'apikey':        CONFIG.supabaseKey,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || err.hint || 'Failed to save profile')
  }
  const rows = await res.json()
  return rows?.[0] ?? null
}

// ── Onboarding ────────────────────────────────────────────────────────────────
let _onboardingStep = 1
let _onboardingData = {}

function setOnboardingStep(step) {
  _onboardingStep = step
  document.querySelectorAll('.onboarding-step').forEach(el => el.classList.remove('active'))
  $(`onboardingStep${step}`)?.classList.add('active')

  // Update step dots
  const dot1 = $('stepDot1'), dot2 = $('stepDot2')
  if (step === 1) {
    if (dot1) { dot1.className = 'step-dot active' }
    if (dot2) { dot2.className = 'step-dot' }
  } else {
    if (dot1) { dot1.className = 'step-dot done' }
    if (dot2) { dot2.className = 'step-dot active' }
  }

  const statusEl = $('onboardingStatus')
  if (statusEl) { statusEl.textContent = ''; statusEl.className = '' }
}

function showOnboardingScreen() {
  $('loginScreen').style.display = 'none'
  $('mainApp').style.display = 'none'
  $('onboardingScreen').style.display = 'block'
  setOnboardingStep(1)
}

// _onboardingComplete stores the most-recent completion callback so the
// bound (single) handlers can call it even after being set up once.
let _onboardingComplete = null

function setupOnboarding(onComplete) {
  _onboardingComplete = onComplete

  if (_onboardingListenersBound) return
  _onboardingListenersBound = true

  $('btnOnboardingNext')?.addEventListener('click', () => {
    const fullName    = $('obFullName').value.trim()
    const companyName = $('obCompanyName').value.trim()
    const statusEl    = $('onboardingStatus')

    if (!fullName || !companyName) {
      statusEl.textContent = 'Full name and company are required.'
      statusEl.className = 'error'
      return
    }

    _onboardingData = { fullName, companyName }
    setOnboardingStep(2)
  })

  async function finishOnboarding(skip = false) {
    const statusEl = $('onboardingStatus')
    statusEl.textContent = 'Saving…'
    statusEl.className = 'info'

    try {
      await saveRecruiterProfile({
        fullName:    _onboardingData.fullName,
        companyName: _onboardingData.companyName,
        jobTitle:    skip ? null : ($('obJobTitle').value.trim() || null),
        hiringFocus: skip ? null : ($('obHiringFocus').value || null),
        tone:        skip ? null : ($('obTone').value || null),
      })
      $('onboardingScreen').style.display = 'none'
      if (_onboardingComplete) _onboardingComplete()
    } catch (e) {
      statusEl.textContent = e.message || 'Could not save profile — try again.'
      statusEl.className = 'error'
    }
  }

  $('btnOnboardingFinish')?.addEventListener('click', () => finishOnboarding(false))
  $('btnOnboardingSkip')?.addEventListener('click',   () => finishOnboarding(true))
}

// ── Login / Onboarding screen listener guards ─────────────────────────────────
// Guards ensure event listeners are bound only once per popup session,
// preventing duplicate submissions if the screen is shown more than once.
let _loginListenersBound = false
let _onboardingListenersBound = false

function showLoginScreen() {
  getStorage(['pref_theme']).then(d => applyTheme(d.pref_theme || 'system'))
  $('loginScreen').style.display = 'block'
  $('onboardingScreen').style.display = 'none'
  $('mainApp').style.display = 'none'

  // Reset to options view whenever login screen is shown
  $('authOptions').style.display = 'block'
  $('emailPasswordForm').style.display = 'none'
  $('forgotPasswordForm').style.display = 'none'
  $('magicLinkForm').style.display = 'none'
  const authErrEl = $('authError')
  if (authErrEl) { authErrEl.style.display = 'none'; authErrEl.textContent = '' }

  if (_loginListenersBound) return
  _loginListenersBound = true

  // Google
  $('btnGoogleSignin').addEventListener('click', () => signInWithGoogle())

  // Microsoft
  $('btnMicrosoftSignin').addEventListener('click', () => signInWithMicrosoft())

  // Email + Password
  $('btnShowEmailPassword').addEventListener('click', () => {
    $('authOptions').style.display = 'none'
    $('emailPasswordForm').style.display = 'block'
  })

  $('backFromEmailPassword').addEventListener('click', () => {
    $('emailPasswordForm').style.display = 'none'
    $('authOptions').style.display = 'block'
    $('epStatus').textContent = ''
    $('epStatus').className = ''
    const ae = $('authError')
    if (ae) { ae.style.display = 'none'; ae.textContent = '' }
  })

  $('btnForgotPassword').addEventListener('click', () => {
    $('emailPasswordForm').style.display = 'none'
    $('forgotPasswordForm').style.display = 'block'
    const fpEmail = $('fpEmail')
    if (fpEmail) fpEmail.value = $('epEmail').value
    $('fpStatus').textContent = ''
  })

  $('backFromForgotPassword').addEventListener('click', () => {
    $('forgotPasswordForm').style.display = 'none'
    $('emailPasswordForm').style.display = 'block'
    $('fpStatus').textContent = ''
  })

  $('btnSendReset').addEventListener('click', async () => {
    const email = $('fpEmail').value.trim()
    const fpStatus = $('fpStatus')
    if (!email) {
      fpStatus.textContent = 'Enter your email address.'
      fpStatus.style.color = '#dc2626'
      return
    }
    $('btnSendReset').disabled = true
    fpStatus.textContent = 'Sending reset link…'
    fpStatus.style.color = '#6b7280'
    const { error } = await resetPassword(email)
    $('btnSendReset').disabled = false
    if (error) {
      fpStatus.textContent = error.message
      fpStatus.style.color = '#dc2626'
    } else {
      fpStatus.textContent = 'Check your email — reset link sent!'
      fpStatus.style.color = '#16a34a'
    }
  })

  let isSignUp = false
  $('toggleSignUp').addEventListener('click', () => {
    isSignUp = !isSignUp
    $('btnEmailPasswordSignin').textContent = isSignUp ? 'Create account' : 'Sign in'
    $('toggleSignUp').textContent = isSignUp ? 'Already have an account? Sign in' : 'No account? Create one'
    const fpBtn = $('btnForgotPassword')
    if (fpBtn) fpBtn.style.display = isSignUp ? 'none' : ''
    $('epStatus').textContent = ''
  })

  $('btnEmailPasswordSignin').addEventListener('click', async () => {
    const email    = $('epEmail').value.trim()
    const password = $('epPassword').value
    const statusEl = $('epStatus')

    if (!email || !password) {
      statusEl.textContent = 'Enter your email and password.'
      statusEl.style.color = '#dc2626'
      return
    }

    $('btnEmailPasswordSignin').disabled = true
    statusEl.textContent = isSignUp ? 'Creating account…' : 'Signing in…'
    statusEl.style.color = '#6b7280'

    const fn = isSignUp ? signUpWithEmailPassword : signInWithEmailPassword
    const { session, error, confirmEmail } = await fn(email, password)

    $('btnEmailPasswordSignin').disabled = false

    if (error) {
      statusEl.textContent = error.message
      statusEl.style.color = '#dc2626'
      return
    }

    if (confirmEmail) {
      statusEl.textContent = 'Check your email to confirm your account.'
      statusEl.style.color = '#0a66c2'
      return
    }

    if (session) {
      await handlePostLogin()
    }
  })

  // Magic link
  const mlStatus = $('loginStatus')
  $('btnShowMagicLink').addEventListener('click', () => {
    $('authOptions').style.display = 'none'
    $('magicLinkForm').style.display = 'block'
  })

  $('backFromMagicLink').addEventListener('click', () => {
    $('magicLinkForm').style.display = 'none'
    $('authOptions').style.display = 'block'
    if (mlStatus) { mlStatus.textContent = ''; mlStatus.className = '' }
  })

  $('btnSendMagicLink').addEventListener('click', async () => {
    const email = $('loginEmail').value.trim()
    if (!email) { mlStatus.textContent = 'Enter your email first.'; mlStatus.style.color = '#dc2626'; return }
    mlStatus.textContent = 'Sending magic link…'
    mlStatus.style.color = '#6b7280'
    const { error } = await sendMagicLink(email)
    if (error) { mlStatus.textContent = `Error: ${error.message}`; mlStatus.style.color = '#dc2626' }
    else       { mlStatus.textContent = 'Check your email — link sent!'; mlStatus.style.color = '#16a34a' }
  })
}

// ── Post-login: check onboarding status via DB function ──────────────────────
// Calls is_first_time_user() which uses auth.uid() internally — no arg needed.
async function isFirstTimeUser() {
  let token = null
  for (let i = 0; i < 6; i++) {
    token = await getAccessToken()
    if (token) break
    await new Promise(r => setTimeout(r, 500))
  }
  if (!token) throw new Error('Not authenticated — token not available after login')
  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/is_first_time_user`, {
    method: 'POST',
    headers: {
      'apikey':        CONFIG.supabaseKey,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    if (res.status === 401) {
      await signOut()
    }
    const body = await res.text()
    throw new Error(`Onboarding check failed (${res.status}): ${body}`)
  }
  const result = await res.json()
  return result === true
}

async function handlePostLogin() {
  const prefs = await getStorage(['pref_theme'])
  applyTheme(prefs.pref_theme || 'system')

  const user = await getUser()

  let needsOnboarding = false
  try {
    needsOnboarding = await isFirstTimeUser()
  } catch (e) {
    console.error('Onboarding check error:', e.message)
    if (e.message.includes('401') || e.message.includes('Not authenticated')) {
      showLoginScreen()
      const errEl = $('authError')
      if (errEl) {
        errEl.textContent = 'Could not verify your account status — please try signing in again.'
        errEl.style.display = 'block'
      }
      return
    }
    needsOnboarding = false
  }

  if (needsOnboarding) {
    showOnboardingScreen()
    setupOnboarding(() => showMainApp(user))
  } else {
    await showMainApp(user)
  }
}

// ── Main app ──────────────────────────────────────────────────────────────────
async function showMainApp(user) {
  const prefs = await getStorage(['pref_theme'])
  applyTheme(prefs.pref_theme || 'system')
  $('loginScreen').style.display = 'none'
  $('onboardingScreen').style.display = 'none'
  $('mainApp').style.display = 'block'

  setupTabs()
  setupCustomizeToggle()
  await loadCreditsUI()

  // Load persisted outreach type preference
  const storedPrefs = await getStorage(['sourcedout_outreach_type'])
  _outreachType = storedPrefs.sourcedout_outreach_type || 'new_outreach'
  $('btnOutreachNew')?.classList.toggle('active', _outreachType === 'new_outreach')
  $('btnOutreachFollowUp')?.classList.toggle('active', _outreachType === 'follow_up')
  if (_outreachType === 'follow_up') {
    const gb = $('generateDraftButton')
    if (gb) gb.innerHTML = '&#x21BA; Generate follow-up'
  }

  await prefillFromPage()

  if (!_mainAppListenersBound) {
    _mainAppListenersBound = true

    $('generateDraftButton').addEventListener('click', () => generateDraftFlow())

    $('fullNameInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); generateDraftFlow() }
    })

    $('clearButton').addEventListener('click', async () => {
      $('fullNameInput').value = ''
      $('companyHintInput').value = ''
      $('userContextInput').value = ''
      _linkedinUrl = null
      updateProfilePill(null)
      const fields = $('customizeFields'); const toggle = $('customizeToggle')
      if (fields && toggle) { fields.style.display = 'none'; toggle.textContent = '▸ Customize draft' }
      resetToIdle()
      await prefillFromPage()
    })

    $('retryButton')?.addEventListener('click', () => generateDraftFlow())
    $('retryButton2')?.addEventListener('click', () => {
      showSection('errorBox', false)
      $('authRecoveryButton').style.display = 'none'
      generateDraftFlow()
    })

    $('authRecoveryButton')?.addEventListener('click', async () => {
      await signOut()
      showLoginScreen()
    })

    $('btnCopyDraft')?.addEventListener('click', () => {
      const text = $('draftBody').value
      if (!text) return
      navigator.clipboard.writeText(text).then(() => {
        const btn = $('btnCopyDraft')
        btn.textContent = '✓ Copied'
        setTimeout(() => { btn.textContent = '📋 Copy draft' }, 2000)
      })
    })

    // ── Tone pills (Formal / Friendly / Brief) ─────────────────────────────────
    document.querySelectorAll('.tone-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const tone = btn.dataset.tone
        if (_selectedTone === tone) {
          // Click again to deselect — revert to recruiter-profile default
          _selectedTone = null
          document.querySelectorAll('.tone-pill').forEach(b => b.classList.remove('active'))
        } else {
          _selectedTone = tone
          document.querySelectorAll('.tone-pill').forEach(b => b.classList.remove('active'))
          btn.classList.add('active')
        }
      })
    })

    // ── Outreach type toggle (New Outreach / Follow-Up) ────────────────────────
    const applyOutreachType = (type) => {
      _outreachType = type
      $('btnOutreachNew')?.classList.toggle('active', type === 'new_outreach')
      $('btnOutreachFollowUp')?.classList.toggle('active', type === 'follow_up')
      const gb = $('generateDraftButton')
      if (gb) gb.innerHTML = type === 'follow_up' ? '&#x21BA; Generate follow-up' : '&#x2728; Generate draft'
      setStorage({ sourcedout_outreach_type: type }).catch(() => {})
    }
    $('btnOutreachNew')?.addEventListener('click',      () => applyOutreachType('new_outreach'))
    $('btnOutreachFollowUp')?.addEventListener('click', () => applyOutreachType('follow_up'))

    await setupSettingsTab(user)
    setupJobTab()
    setupCandidateSummary()

    $('batchDrawerClose')?.addEventListener('click', () => {
      _prefillAborted = false
      prefillFromPage()
    })

    const campaignsTab = $('campaignsTab')
    if (campaignsTab) {
      let _batchModule = null
      campaignsTab.addEventListener('click', async () => {
        _prefillAborted = true
        if (!_batchModule) {
          _batchModule = await import('./batch.js')
          _batchModule.initBatch()
        }
        _batchModule.openBatchDrawer()
      })
    }
  }
}

// ── Job tab: saved jobs list ───────────────────────────────────────────────────
// Activate a saved-job row and populate fields (shared by auto-restore and row click)
function _activateSavedJobRow(row, j, allRows, showStatus = false) {
  allRows.forEach(r => r.classList.remove('active'))
  row.classList.add('active')
  if ($('jobTitle'))       $('jobTitle').value       = j.role_title || ''
  if ($('jobCompany'))     $('jobCompany').value     = j.company    || ''
  if ($('jobDescription')) $('jobDescription').value = j.highlights || ''
  if ($('jobUrl'))         $('jobUrl').value         = j.job_url    || ''
  if ($('jobLabel'))       $('jobLabel').value       = j.label
  if (showStatus) {
    const statusEl = $('jobStatus')
    if (statusEl) {
      statusEl.textContent = `"${j.label}" loaded.`
      statusEl.style.color = '#16a34a'
      setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = '' }, 2000)
    }
  }
}

async function loadSavedJobs() {
  const listEl = $('savedJobsList')
  if (!listEl) return
  try {
    const [{ jobs }, stored] = await Promise.all([
      getSavedJobs(),
      getStorage(['saved_job_last_id']),
    ])
    const lastId = stored.saved_job_last_id || null
    const emptyEl = $('savedJobsEmpty')

    // Clear stale rows
    listEl.querySelectorAll('.saved-job-row').forEach(el => el.remove())

    if (!jobs || jobs.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block'
      return
    }
    if (emptyEl) emptyEl.style.display = 'none'

    const renderedRows = []

    for (const j of jobs) {
      const row = document.createElement('div')
      row.className = 'saved-job-row'
      row.dataset.jobId = j.id

      const labelSpan = document.createElement('span')
      labelSpan.className = 'saved-job-label'
      labelSpan.textContent = j.label

      const companySpan = document.createElement('span')
      companySpan.className = 'saved-job-company'
      companySpan.textContent = j.company || ''

      const delBtn = document.createElement('button')
      delBtn.className = 'saved-job-delete'
      delBtn.title = 'Delete this saved job'
      delBtn.textContent = '✕'
      delBtn.addEventListener('click', async e => {
        e.stopPropagation()
        delBtn.disabled = true
        try {
          await deleteJob({ jobId: j.id })
          // Re-read current last-used ID at delete time (not stale captured value)
          const cur = await getStorage(['saved_job_last_id'])
          if (cur.saved_job_last_id === j.id) await setStorage({ saved_job_last_id: null })
          await loadSavedJobs()
        } catch {
          delBtn.disabled = false
        }
      })

      row.appendChild(labelSpan)
      row.appendChild(companySpan)
      row.appendChild(delBtn)

      row.addEventListener('click', async () => {
        _activateSavedJobRow(row, j, renderedRows, true)
        await setStorage({
          job_title:         j.role_title || '',
          job_company:       j.company    || '',
          job_description:   j.highlights || '',
          job_url:           j.job_url    || '',
          saved_job_last_id: j.id,
        })
      })

      listEl.appendChild(row)
      renderedRows.push(row)
    }

    // Auto-restore: if we have a last-used ID that matches a fetched job, activate it silently
    // Also re-write job_* to local storage to guard against stale state across devices/sessions
    if (lastId) {
      const idx = jobs.findIndex(j => j.id === lastId)
      if (idx !== -1) {
        const j = jobs[idx]
        _activateSavedJobRow(renderedRows[idx], j, renderedRows, false)
        await setStorage({
          job_title:         j.role_title || '',
          job_company:       j.company    || '',
          job_description:   j.highlights || '',
          job_url:           j.job_url    || '',
        })
      }
    }
  } catch (e) {
    console.warn('loadSavedJobs failed:', e)
  }
}

// ── Job tab ───────────────────────────────────────────────────────────────────
function setupJobTab() {
  getStorage(['job_title','job_company','job_description','job_url']).then(d => {
    if (d.job_title)       $('jobTitle').value       = d.job_title
    if (d.job_company)     $('jobCompany').value     = d.job_company
    if (d.job_description) $('jobDescription').value = d.job_description
    if (d.job_url)         $('jobUrl').value         = d.job_url
  })

  // Load saved jobs list on init
  loadSavedJobs()

  $('btnExtractJob').addEventListener('click', async () => {
    const url = $('jobUrl').value.trim()
    const statusEl = $('extractStatus')
    if (!url || !url.startsWith('http')) { statusEl.textContent = 'Enter a valid URL.'; return }
    const btn = $('btnExtractJob')
    btn.disabled = true
    statusEl.textContent = 'Fetching job details…'
    statusEl.style.color = '#6b7280'
    // Hide any previous expired warning
    const expiredWarn = $('jobExpiredWarning')
    if (expiredWarn) expiredWarn.style.display = 'none'

    const DIRECTS = { 'google.com': 'Google', 'amazon.jobs': 'Amazon', 'microsoft.com': 'Microsoft', 'apple.com': 'Apple', 'meta.com': 'Meta', 'netflix.com': 'Netflix', 'stripe.com': 'Stripe', 'openai.com': 'OpenAI' }
    const BOARDS  = ['greenhouse.io','lever.co','workday.com','myworkdayjobs.com','jobvite.com','smartrecruiters.com','ashbyhq.com','linkedin.com']
    const GENERIC = /^(job details?|job description|apply( now)?|about this role|overview|open role|career opportunity|careers|current opening|job posting|view job|find your dream job)$/i

    // ── Step 1: Instant pre-fill from URL slug & hostname ─────────────────────
    let preTitle = '', preCompany = ''
    try {
      const parsedHost = new URL(url).hostname.replace(/^www\./, '')
      for (const [d, n] of Object.entries(DIRECTS)) { if (parsedHost.includes(d)) { preCompany = n; break } }
      const slugPart = [...url.split('/')].reverse().find(p => /[a-zA-Z]/.test(p) && p.includes('-'))
      if (slugPart) preTitle = slugPart.replace(/^\d+-/, '').replace(/[-_]/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase())
    } catch {}
    if (preTitle)   $('jobTitle').value   = preTitle
    if (preCompany) $('jobCompany').value = preCompany

    // ── Step 2: Fetch HTML via background service worker (MV3 CSP compliant) ──
    try {
      const response = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'FETCH_URL', url }, resolve)
      )
      if (!response?.ok) throw new Error(response?.error || 'Fetch failed')
      const html = response.html
      const doc = new DOMParser().parseFromString(html, 'text/html')

      // JSON-LD (best source — Google Careers, Greenhouse, Lever, Ashby all include this)
      let ldTitle = '', ldCompany = '', ldDescription = ''
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let data; try { data = JSON.parse(s.textContent) } catch { continue }
        const nodes = data?.['@graph'] ? data['@graph'] : [data]
        const job = nodes.find(n => n?.['@type'] === 'JobPosting')
        if (job) {
          ldTitle   = (job.title || '').trim()
          ldCompany = (job.hiringOrganization?.name || '').trim()
          const tmp = document.createElement('div')
          tmp.innerHTML = job.description || ''
          ldDescription = (tmp.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600)
          break
        }
      }

      // Meta tag fallbacks
      const ogTitle   = doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || ''
      const ogSite    = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() || ''
      const pageTitle = doc.title?.trim() || ''

      // Body text fallback (for description only)
      const mainEl = doc.querySelector('main, article, [role="main"], #main-content') || doc.body
      const NAV = /^(home|menu|skip|search|sign in|sign up|login|log in|careers|jobs|apply|share|back|next|prev|navigation|cookie|privacy|terms|©|\d{4})$/i
      const bodyLines = (mainEl?.textContent || '').split('\n').map(l => l.trim()).filter(l => l.length > 40 && !NAV.test(l))
      const bodyText  = bodyLines.join(' ')
      const anchor    = bodyText.search(/minimum qualifications|about the job|about this role|responsibilities|what you.ll do|job summary/i)
      const bodyDesc  = (anchor > -1 ? bodyText.slice(anchor) : bodyText).slice(0, 600)

      // ── Detect expired / unavailable job postings ──────────────────────────
      // Check page title + body for common "job gone" signals
      const EXPIRED_TITLE = /^(jobs? search|job not found|page not found|404|no longer available|position filled|job closed|expired|error)$/i
      const EXPIRED_BODY  = /this (job|position|role|posting|listing) (is |has been )?(no longer available|closed|filled|expired|removed|taken down)|job (not found|has expired)|this page (could not|can.t) be found|no longer accepting applications/i
      const titleToCheck  = ldTitle || ogTitle || pageTitle
      const isExpired = EXPIRED_TITLE.test(titleToCheck.trim()) || EXPIRED_BODY.test(bodyText.slice(0, 1000))

      if (isExpired) {
        $('jobTitle').value = ''
        $('jobCompany').value = preCompany || ''
        $('jobDescription').value = ''
        statusEl.textContent = ''
        statusEl.style.color = ''
        // Show a warning banner instead
        const warn = $('jobExpiredWarning')
        if (warn) warn.style.display = 'block'
        btn.disabled = false
        return
      }

      // Hide expired warning if previously shown
      const warn = $('jobExpiredWarning')
      if (warn) warn.style.display = 'none'

      // Strip trailing " | Site" or " — Site" but NOT hyphens within the title (e.g. "Fixed-Term")
      const stripSuffix = s => s.replace(/\s+[|–—]\s+[^|–—]+$/, '').replace(/\s+-\s+\S.*$/, '').trim()

      // ── Resolve best title ─────────────────────────────────────────────────
      let bestTitle = ''
      if (ldTitle && !GENERIC.test(ldTitle)) bestTitle = ldTitle
      if (!bestTitle && ogTitle) bestTitle = stripSuffix(ogTitle)
      if (!bestTitle && pageTitle) bestTitle = stripSuffix(pageTitle)
      if (bestTitle && !GENERIC.test(bestTitle)) $('jobTitle').value = bestTitle

      // ── Resolve best company ───────────────────────────────────────────────
      if (ldCompany) $('jobCompany').value = ldCompany
      else if (ogSite && !BOARDS.some(b => url.includes(b))) $('jobCompany').value = ogSite

      // ── Description: set raw first, then summarize via Claude ────────────
      const rawDesc = ldDescription || bodyDesc
      $('jobDescription').value = rawDesc

      const titleForSummary   = $('jobTitle').value.trim()
      const companyForSummary = $('jobCompany').value.trim()

      statusEl.textContent = 'Details extracted — review and save.'
      btn.disabled = false

      // Kick off summarization in background — don't block the UI
      if (rawDesc || titleForSummary) {
        statusEl.textContent = 'Summarizing highlights…'
        try {
          const { summary } = await summarizeJob({
            rawText:  rawDesc,
            jobTitle: titleForSummary,
            company:  companyForSummary,
          })
          if (summary) $('jobDescription').value = summary
          statusEl.textContent = 'Details extracted — review and save.'
        } catch {
          statusEl.textContent = 'Details extracted — review and save.'
        }
      }

      return  // btn already re-enabled above
    } catch (e) {
      // Friendly message for fetch timeout (AbortController fired)
      const isTimeout = e?.name === 'AbortError' || e?.message?.includes('aborted') || e?.message?.includes('signal')
      const timeoutMsg = 'Request timed out — the page took too long to load. Try a direct job board link.'
      statusEl.textContent = isTimeout ? timeoutMsg : (preTitle ? 'Details extracted from URL — review and save.' : `Could not load the page. Try a different URL.`)
    }
    btn.disabled = false
  })

  $('btnSaveJob').addEventListener('click', async () => {
    const title      = $('jobTitle').value.trim()
    const company    = $('jobCompany').value.trim()
    const highlights = $('jobDescription').value.trim()
    const jobUrl     = $('jobUrl').value.trim()
    const label      = $('jobLabel').value.trim() || (title ? `${title}${company ? ' — ' + company : ''}` : '')

    if (!label) { $('jobStatus').textContent = 'Add a role title or label first.'; $('jobStatus').style.color = '#dc2626'; return }

    const btn = $('btnSaveJob')
    btn.disabled = true
    $('jobStatus').textContent = 'Saving…'
    $('jobStatus').style.color = '#6b7280'

    try {
      const { job } = await saveJob({ label, jobUrl: jobUrl || null, roleTitle: title || null, company: company || null, highlights: highlights || null })

      // Persist locally so draft flow picks it up, and mark as last-used
      await setStorage({
        job_title:           title,
        job_company:         company,
        job_description:     highlights,
        job_url:             jobUrl,
        saved_job_last_id:   job?.id || null,
      })

      $('jobStatus').textContent = 'Job saved!'
      $('jobStatus').style.color = '#16a34a'
      setTimeout(() => { $('jobStatus').textContent = ''; $('jobStatus').style.color = '' }, 2500)
      await loadSavedJobs()
    } catch (e) {
      $('jobStatus').textContent = 'Could not save — try again.'
      $('jobStatus').style.color = '#dc2626'
    } finally {
      btn.disabled = false
    }
  })
}

// ── Email source label builder ─────────────────────────────────────────────────
function buildEmailSourceLabel(emailSource, debug) {
  if (!emailSource || emailSource === 'none') return null

  const SOURCE_MAP = {
    'haiku_pattern_cache':    { icon: '🗄️', label: 'pattern cache' },
    'haiku+verifier':         { icon: '🤖', label: 'Haiku + MEV verified' },
    'google_search':          { icon: '🔍', label: 'Google search + MEV' },
    'brave_search':           { icon: '🔍', label: 'Brave search + MEV' },
    'pdl_person_enrichment':  { icon: '📋', label: 'PDL enrichment' },
    'haiku_refine':           { icon: '🤖', label: 'Haiku refinement' },
    'fullenrich_v2':          { icon: '⚡', label: 'FullEnrich' },
    'saved_profile':          { icon: '💾', label: 'saved profile' },
  }

  const entry = SOURCE_MAP[emailSource]
  if (!entry) return null

  let detail = null
  if (emailSource === 'haiku_pattern_cache' && debug?.records) {
    const rec = debug.records.find(r => r.step === 'haiku_pattern_cache' && r.status === 'HIT')
    if (rec?.meta?.top_pattern && rec?.meta?.top_count != null) {
      detail = `${rec.meta.top_pattern} ×${rec.meta.top_count}`
    }
    // If Haiku picked between multiple patterns, annotate that
    const haikuRec = debug.records.find(r =>
      r.step === 'myemailverifier_haiku' && r.meta?.via === 'haiku_pattern_pick'
    )
    if (haikuRec && !detail) {
      detail = `Haiku picked from ${haikuRec.meta?.patterns_considered ?? '?'} patterns`
    } else if (haikuRec && detail) {
      detail += ' (Haiku)'
    }
  }

  return { icon: entry.icon, label: entry.label, detail }
}

// ── Lookup history storage ─────────────────────────────────────────────────────
async function storeLookupHistory(result) {
  try {
    // Detect the furthest waterfall step that actually ran (status !== SKIP),
    // so the diagnostics history can show "FullEnrich → miss" even when no email was found.
    let lastStep = null
    const records = result.debug?.records
    if (Array.isArray(records)) {
      const ran = records.filter(r => r.status && r.status !== 'SKIP')
      if (ran.length > 0) lastStep = ran[ran.length - 1].step
    }
    const entry = {
      name:        result.person?.fullName || '—',
      company:     result.person?.company  || null,
      emailSource: result.person?.emailSource || null,
      hasEmail:    !!(result.person?.workEmail || result.person?.personalEmail || result.person?.email),
      lastStep,
      timestamp:   Date.now(),
    }
    const stored = await getStorage(['sourcedout_lookup_history', 'sourcedout_last_scrape'])
    const scraperSource = stored.sourcedout_last_scrape?.current_company_source || null
    entry.scraperSource = scraperSource
    const history = Array.isArray(stored.sourcedout_lookup_history) ? stored.sourcedout_lookup_history : []
    history.unshift(entry)
    // Build the full debug trace for the "Copy debug" button
    const debugTrace = {
      timestamp:   entry.timestamp,
      person: {
        name:        entry.name,
        company:     entry.company,
        email:       result.person?.workEmail || result.person?.personalEmail || result.person?.email || null,
        emailSource: entry.emailSource,
        hasEmail:    entry.hasEmail,
      },
      scraper:   stored.sourcedout_last_scrape || null,
      waterfall: Array.isArray(result.debug?.records) ? result.debug.records : [],
      meta:      result.debug?.meta || null,
    }
    await setStorage({
      sourcedout_lookup_history:    history.slice(0, 5),
      sourcedout_last_debug_trace:  debugTrace,
    })
  } catch (e) { console.warn('storeLookupHistory failed:', e) }
}

// ── Pattern data extraction helper ────────────────────────────────────────────
function extractPatternData(debug) {
  if (!debug?.records) return null
  const rec = debug.records.find(r => r.step === 'haiku_pattern_cache' && r.status === 'HIT')
  if (!rec?.meta?.all) return null
  return {
    all:         rec.meta.all,
    top_pattern: rec.meta.top_pattern || null,
    is_catchall: !!rec.meta.is_catchall,
  }
}

// ── Scraper path trail renderer ───────────────────────────────────────────────
// Renders a visual pipeline of scraper steps tried (grey) → hit (coloured).
// source: the value stored in current_company_source by content.js
// container: the DOM element to render into
const SCRAPER_STEPS = [
  { key: 'json-ld',               label: 'JSON-LD',       quality: 'excellent' },
  { key: 'json-ld-late',          label: 'JSON-LD(late)', quality: 'excellent' },
  { key: 'aria-label',            label: 'aria-btn',      quality: 'excellent' },
  { key: 'aria-label-text',       label: 'aria-btn',      quality: 'excellent' },
  { key: 'topcard-logo',          label: 'logo',           quality: 'excellent' },
  { key: 'topcard-logo-text',     label: 'logo-txt',       quality: 'excellent' },
  { key: 'topcard-2025',          label: 'top-card',       quality: 'excellent' },
  { key: 'topcard-2025-span',     label: 'top-card-span',  quality: 'excellent' },
  { key: 'topcard-2025-slug',     label: 'top-card-slug',  quality: 'excellent' },
  { key: 'topcard-2025-text',     label: 'top-card-txt',   quality: 'good' },
  { key: 'experience-link',       label: 'exp-link',       quality: 'good' },
  { key: 'experience-link-span',  label: 'exp-span',       quality: 'good' },
  { key: 'experience-link-slug',  label: 'exp-slug',       quality: 'good' },
  { key: 'experience-subtitle',   label: 'exp-subtitle',   quality: 'good' },
  { key: 'experience-bold',       label: 'exp-bold',       quality: 'good' },
  { key: 'og-description',        label: 'OG meta',        quality: 'good' },
  { key: 'topcard-subtitle',      label: 'subtitle',       quality: 'good' },
  { key: 'current-role-badge',    label: 'role badge',     quality: 'good' },
  { key: 'broad-link',            label: 'broad-link',     quality: 'fallback' },
]
const SCRAPER_QUALITY = Object.fromEntries(SCRAPER_STEPS.map(s => [s.key, s.quality]))
const QUALITY_DOT = { excellent: '🟢', good: '🔵', fallback: '🟠' }

const WATERFALL_STEPS = [
  { key: 'haiku_pattern_cache',              label: 'Pattern Cache', quality: 'excellent' },
  { key: 'haiku_email_guess',                label: 'Haiku Guess',   quality: 'good' },
  { key: 'myemailverifier_haiku',            label: 'MEV',           quality: 'good' },
  { key: 'google_search',                    label: 'Google',        quality: 'good' },
  { key: 'brave_search',                     label: 'Brave',         quality: 'good' },
  { key: 'haiku_refine_candidates',          label: 'Haiku Refine',  quality: 'good' },
  { key: 'myemailverifier_search_round1',    label: 'MEV rd1',       quality: 'good' },
  { key: 'pdl_person_enrichment',            label: 'PDL',           quality: 'good' },
  { key: 'myemailverifier_search_candidates', label: 'MEV rd2',      quality: 'good' },
  { key: 'personal_email_found',             label: 'Personal ⚡',   quality: 'event' },
  { key: 'fullenrich_v2',                    label: 'FullEnrich',    quality: 'fallback' },
]
const WATERFALL_WIN_STATUS = new Set(['OK', 'HIT', 'RISKY_FALLBACK'])

function renderWaterfallPath(records, container) {
  if (!container) return
  container.innerHTML = ''
  if (!Array.isArray(records) || records.length === 0) {
    const blank = document.createElement('span')
    blank.className = 'field-value'
    blank.style.color = '#d1d5db'
    blank.textContent = '— (no lookup yet)'
    container.appendChild(blank)
    return
  }
  const recMap = {}
  records.forEach(r => { if (r.step) recMap[r.step] = r })
  const trail = document.createElement('div')
  trail.className = 'scraper-trail'
  let first = true
  let hitReached = false
  for (const s of WATERFALL_STEPS) {
    if (hitReached) break
    const rec = recMap[s.key]
    if (!rec || rec.status === 'SKIP') continue
    if (!first) {
      const arrow = document.createElement('span')
      arrow.className = 'scraper-step arrow'
      arrow.textContent = '›'
      trail.appendChild(arrow)
    }
    first = false
    const chip = document.createElement('span')
    // ── Event chip: personal email found — still hunting for work ────────────
    if (s.quality === 'event' && rec.status === 'PERSONAL_HUNTING') {
      chip.className = 'scraper-step hit-event'
      chip.textContent = s.label
      chip.title = rec.meta?.note || 'personal email found — still hunting for work address'
      if (rec.meta?.email) chip.title += ` (${rec.meta.email})`
      trail.appendChild(chip)
      continue  // event chip: don't set hitReached, keep rendering subsequent steps
    }
    const isWin = WATERFALL_WIN_STATUS.has(rec.status)
    if (isWin) {
      chip.className = `scraper-step hit-${s.quality}`
      chip.textContent = s.quality === 'fallback' ? `${s.label} ⚠` : `${s.label} ✓`
      // Tooltip: show match info; if personal was also stored, call that out too
      let tipText = rec.meta ? JSON.stringify(rec.meta).slice(0, 140) : `${s.label}: matched`
      if (rec.meta?.personal_stored) {
        tipText = `work email found — personal email also stored: ${rec.meta.personal_stored} | ${tipText}`
      }
      chip.title = tipText
      hitReached = true
    } else {
      chip.className = 'scraper-step miss'
      chip.textContent = s.label
      chip.title = `${s.label}: ${rec.status}${rec.reason ? ' — ' + rec.reason : ''}`
    }
    trail.appendChild(chip)
  }
  if (first) {
    const blank = document.createElement('span')
    blank.className = 'field-value'
    blank.style.color = '#d1d5db'
    blank.textContent = '— (all skipped)'
    container.appendChild(blank)
    return
  }
  container.appendChild(trail)
}

function renderScraperPath(source, container) {
  if (!container) return
  container.innerHTML = ''
  if (!source) {
    const blank = document.createElement('span')
    blank.className = 'field-value'
    blank.style.color = '#d1d5db'
    blank.textContent = '— (no scrape yet)'
    container.appendChild(blank)
    return
  }
  const hitIdx = SCRAPER_STEPS.findIndex(s => s.key === source)
  if (hitIdx === -1) {
    const raw = document.createElement('span')
    raw.className = 'field-value'
    raw.textContent = source
    container.appendChild(raw)
    return
  }
  const trail = document.createElement('div')
  trail.className = 'scraper-trail'
  for (let i = 0; i <= hitIdx; i++) {
    const step = SCRAPER_STEPS[i]
    if (i > 0) {
      const arrow = document.createElement('span')
      arrow.className = 'scraper-step arrow'
      arrow.textContent = '›'
      trail.appendChild(arrow)
    }
    const chip = document.createElement('span')
    if (i < hitIdx) {
      chip.className = 'scraper-step miss'
      chip.textContent = step.label
      chip.title = `${step.label}: tried, no result`
    } else {
      chip.className = `scraper-step hit-${step.quality}`
      chip.textContent = step.quality === 'fallback' ? `${step.label} ⚠` : `${step.label} ✓`
      chip.title = step.quality === 'fallback'
        ? `${step.label}: fallback — result may need verification`
        : `${step.label}: matched successfully`
    }
    trail.appendChild(chip)
  }
  container.appendChild(trail)
}

// ── Diagnostics panel ─────────────────────────────────────────────────────────
function renderDiscovery(waterfall, emailSource, fieldEl, el) {
  if (!fieldEl || !el) return
  if (!Array.isArray(waterfall) || !waterfall.length) { fieldEl.style.display = 'none'; return }

  const STEP_LABELS = {
    'haiku_pattern_cache':              { label: 'Pattern cache',   icon: '🗄️' },
    'haiku_email_guess':                { label: 'Haiku guess',     icon: '🤖' },
    'myemailverifier_haiku':            { label: 'MEV verify',      icon: '✅' },
    'google_search':                    { label: 'Google search',   icon: '🔍' },
    'brave_search':                     { label: 'Brave search',    icon: '🔍' },
    'haiku_refine_candidates':          { label: 'Haiku refine',    icon: '🤖' },
    'myemailverifier_search_round1':    { label: 'MEV verify ①',   icon: '✅' },
    'myemailverifier_search_candidates':{ label: 'MEV verify ②',   icon: '✅' },
    'pdl_person_enrichment':            { label: 'PDL lookup',      icon: '📋' },
    'fullenrich_v2':                    { label: 'FullEnrich',      icon: '⚡' },
    'post_fullenrich_retry':            { label: 'Retry',           icon: '🔄' },
    'resolve_domain':                   { label: 'Domain resolve',  icon: '🌐' },
    'sonnet_draft':                     { label: 'Draft (Sonnet)',  icon: '✍️' },
    'saved_profile':                    { label: 'Cache hit',       icon: '💾' },
  }

  // Only show steps that actually ran (not SKIP), except sonnet_draft
  const active = waterfall.filter(r => r.status !== 'SKIP' && r.step !== 'sonnet_draft')
  if (!active.length) { fieldEl.style.display = 'none'; return }

  fieldEl.style.display = 'block'
  el.innerHTML = ''

  // Build step chips
  const steps = document.createElement('div')
  steps.className = 'disc-steps'

  active.forEach((rec, i) => {
    if (i > 0) {
      const arrow = document.createElement('span')
      arrow.className = 'disc-arrow'
      arrow.textContent = '›'
      steps.appendChild(arrow)
    }

    const info  = STEP_LABELS[rec.step] || { label: rec.step, icon: '⚙️' }
    const chip  = document.createElement('span')
    const st    = (rec.status || '').toUpperCase()
    chip.className = `disc-step ${st === 'HIT' ? 'hit' : st === 'MISS' || st === 'ERROR' ? 'miss' : st === 'SKIP' ? 'skip' : 'ok'}`

    // Build label with useful meta
    let label = `${info.icon} ${info.label}`
    if (rec.step === 'haiku_pattern_cache' && st === 'HIT' && rec.meta?.top_pattern) {
      label += ` · ${rec.meta.top_pattern}${rec.meta.top_count ? ' ×' + rec.meta.top_count : ''}`
    } else if ((rec.step === 'myemailverifier_haiku' || rec.step === 'myemailverifier_search_round1' || rec.step === 'myemailverifier_search_candidates') && rec.meta?.verified != null) {
      label += ` · ${rec.meta.verified} verified`
    } else if (rec.step === 'haiku_email_guess' && rec.meta?.candidates != null) {
      label += ` · ${rec.meta.candidates} candidates`
    } else if (rec.step === 'pdl_person_enrichment' && rec.meta?.email) {
      label += ' · found'
    }
    if (st === 'HIT')  label += ' ✓'
    if (st === 'MISS') label += ' ✗'

    chip.textContent = label
    chip.title = `Status: ${rec.status}${rec.meta ? '\n' + JSON.stringify(rec.meta, null, 2) : ''}`
    steps.appendChild(chip)
  })

  el.appendChild(steps)

  // Outcome summary line
  const outcome = document.createElement('div')
  const mevHit  = active.find(r => r.step?.startsWith('myemailverifier') && (r.meta?.verified || 0) > 0)
  const pdlHit  = active.find(r => r.step === 'pdl_person_enrichment' && r.meta?.email)
  const feHit   = active.find(r => r.step === 'fullenrich_v2' && r.status !== 'MISS')
  const cacheHit= active.find(r => r.step === 'haiku_pattern_cache' && r.status === 'HIT')

  if (mevHit) {
    const count = mevHit.meta.verified
    const via   = cacheHit ? `company pattern (${cacheHit.meta?.top_pattern || 'first.last'})` : 'search + Haiku refinement'
    outcome.className = 'disc-outcome'
    outcome.textContent = `${count} email${count > 1 ? 's' : ''} verified via ${via}`
  } else if (pdlHit) {
    outcome.className = 'disc-outcome'
    outcome.textContent = 'Email sourced from People Data Labs'
  } else if (feHit) {
    outcome.className = 'disc-outcome'
    outcome.textContent = 'Email sourced from FullEnrich'
  } else {
    outcome.className = 'disc-outcome none'
    outcome.textContent = 'No verified email found on this run'
  }
  el.appendChild(outcome)
}

async function renderDiagnostics() {
  try {
    const manifest = chrome?.runtime?.getManifest?.() || {}
    const ext = manifest.version || CONFIG.version || '—'
    const scraperBuild = CONFIG.scraperBuild || '—'
    const stored = await getStorage([
      'sourcedout_server_version',
      'sourcedout_server_version_at',
      'sourcedout_last_scrape',
      'sourcedout_last_patterns',
      'sourcedout_lookup_history',
      'sourcedout_last_debug_trace',
    ])
    const serverVersion = stored.sourcedout_server_version || '—'
    const last          = stored.sourcedout_last_scrape || null
    const patternData   = stored.sourcedout_last_patterns || null
    const history       = Array.isArray(stored.sourcedout_lookup_history) ? stored.sourcedout_lookup_history : []
    const lastTrace     = stored.sourcedout_last_debug_trace || null

    if ($('diagExtVersion')) $('diagExtVersion').textContent = ext
    if ($('diagScraperBuild')) $('diagScraperBuild').textContent = scraperBuild
    if ($('diagServerVersion')) {
      const ago = stored.sourcedout_server_version_at
        ? ` (${Math.max(1, Math.round((Date.now() - stored.sourcedout_server_version_at) / 60000))} min ago)`
        : ''
      $('diagServerVersion').textContent = serverVersion === '—' ? '— (run a draft to detect)' : `${serverVersion}${ago}`
    }
    if ($('diagLastCompany')) $('diagLastCompany').textContent = last?.current_company || '— (no scrape yet)'
    renderScraperPath(last?.current_company_source || null, $('diagScraperPath'))
    renderWaterfallPath(lastTrace?.waterfall || null, $('diagWaterfallPath'))
    renderDiscovery(lastTrace?.waterfall || null, lastTrace?.emailSource || null, $('diagDiscoveryField'), $('diagDiscovery'))

    const patternsField = $('diagPatternsField')
    const patternsEl    = $('diagPatterns')
    if (patternsField && patternsEl) {
      if (patternData?.all) {
        patternsField.style.display = 'block'
        patternsEl.innerHTML = ''
        const parts = patternData.all.split(',').map(s => s.trim()).filter(Boolean)
        parts.forEach((part, i) => {
          const chip = document.createElement('span')
          const isTop = i === 0
          chip.className = `diag-pattern-chip ${isTop ? 'top' : 'alt'}${patternData.is_catchall ? ' catchall' : ''}`
          chip.textContent = part.replace('×', ' ×')
          chip.title = isTop ? 'Top pattern (highest verified count)' : 'Alternate pattern'
          patternsEl.appendChild(chip)
        })
        if (patternData.is_catchall) {
          const warnChip = document.createElement('span')
          warnChip.className = 'diag-pattern-chip warn'
          warnChip.textContent = '⚠ catch-all domain'
          warnChip.title = 'MX catch-all — email existence cannot be verified; Haiku picks best pattern'
          patternsEl.appendChild(warnChip)
        }
      } else {
        patternsField.style.display = 'none'
      }
    }

    // ── Lookup history ────────────────────────────────────────────────────────
    const histSection = $('diagHistorySection')
    const histEl      = $('diagHistory')
    if (histSection && histEl) {
      if (history.length > 0) {
        histSection.style.display = 'block'
        histEl.innerHTML = ''
        const SOURCE_ICONS = {
          'haiku_pattern_cache':   '🗄️',
          'haiku+verifier':        '🤖',
          'google_search':         '🔍',
          'brave_search':          '🔍',
          'pdl_person_enrichment': '📋',
          'haiku_refine':          '🤖',
          'fullenrich_v2':         '⚡',
          'saved_profile':         '💾',
        }
        const SOURCE_SHORT = {
          'haiku_pattern_cache':   'pattern cache',
          'haiku+verifier':        'Haiku+MEV',
          'google_search':         'Google+MEV',
          'brave_search':          'Brave+MEV',
          'pdl_person_enrichment': 'PDL',
          'haiku_refine':          'Haiku refine',
          'fullenrich_v2':         'FullEnrich',
          'saved_profile':         'saved profile',
        }
        const STEP_SHORT = {
          'fullenrich_v2':                      'FullEnrich',
          'post_fullenrich_retry':              'retry',
          'pdl_person_enrichment':              'PDL',
          'myemailverifier_search_candidates':  'MEV rd2',
          'myemailverifier_search_round1':      'MEV rd1',
          'haiku_refine_candidates':            'Haiku refine',
          'brave_search':                       'Brave',
          'google_search':                      'Google',
          'myemailverifier_haiku':              'MEV+Haiku',
          'haiku_email_guess':                  'Haiku guess',
          'haiku_pattern_cache':                'pattern cache',
          'resolve_domain':                     'domain resolve',
        }
        history.forEach(entry => {
          const row = document.createElement('div')
          row.className = 'diag-history-row'

          const icon = document.createElement('span')
          icon.className = 'diag-history-icon'
          icon.textContent = (entry.hasEmail ? (SOURCE_ICONS[entry.emailSource] || '📧') : '—')

          const name = document.createElement('span')
          name.className = 'diag-history-name'
          name.textContent = entry.name + (entry.company ? ` · ${entry.company}` : '')
          name.title = name.textContent

          const src = document.createElement('span')
          src.className = 'diag-history-source'
          if (entry.hasEmail) {
            src.textContent = SOURCE_SHORT[entry.emailSource] || entry.emailSource || 'found'
          } else {
            const stepLabel = entry.lastStep ? (STEP_SHORT[entry.lastStep] || entry.lastStep) : null
            src.textContent = stepLabel ? `${stepLabel} → miss` : 'no email'
          }

          const ago = document.createElement('span')
          ago.className = 'diag-history-time'
          const mins = Math.max(0, Math.round((Date.now() - entry.timestamp) / 60000))
          ago.textContent = mins === 0 ? 'just now' : `${mins}m ago`

          row.appendChild(icon)
          row.appendChild(name)
          // Scraper quality dot: 🟢 excellent / 🔵 good / 🟠 fallback
          if (entry.scraperSource) {
            const q = SCRAPER_QUALITY[entry.scraperSource]
            if (q) {
              const dot = document.createElement('span')
              dot.className = 'diag-scraper-dot'
              dot.textContent = QUALITY_DOT[q]
              dot.title = `Scraper: ${entry.scraperSource} (${q})`
              row.appendChild(dot)
            }
          }
          row.appendChild(src)
          row.appendChild(ago)
          histEl.appendChild(row)
        })
      } else {
        histSection.style.display = 'none'
      }
    }

    const mismatchEl = $('diagMismatch')
    if (mismatchEl) {
      const mismatch = serverVersion !== '—' && scraperBuild !== '—' && serverVersion !== scraperBuild
      if (mismatch) {
        mismatchEl.style.display = 'block'
        mismatchEl.textContent = `Heads up: extension build (${scraperBuild}) does not match server (${serverVersion}). Pull latest files and reload the extension in chrome://extensions.`
      } else {
        mismatchEl.style.display = 'none'
      }
    }
  } catch (e) { console.warn('renderDiagnostics failed:', e) }
}

// ── Clear diagnostics history ──────────────────────────────────────────────────
async function clearLookupHistory() {
  await setStorage({ sourcedout_lookup_history: [] })
  renderDiagnostics()
}

// ── Copy debug trace to clipboard ─────────────────────────────────────────────
async function copyDebugTrace() {
  const stored = await getStorage(['sourcedout_last_debug_trace'])
  const trace = stored.sourcedout_last_debug_trace
  const btn = $('diagCopyDebug')
  const reset = (label, color) => { if (btn) { btn.textContent = label; btn.style.color = color } }
  if (!trace) {
    reset('⎘ No trace yet', '#9ca3af')
    setTimeout(() => reset('⎘ Copy debug', ''), 2000)
    return
  }
  const text = JSON.stringify(trace, null, 2)
  try {
    await navigator.clipboard.writeText(text)
    reset('✓ Copied!', '#166534')
    setTimeout(() => reset('⎘ Copy debug', ''), 1800)
  } catch {
    // Clipboard API blocked — textarea fallback
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    try { document.execCommand('copy'); reset('✓ Copied!', '#166534') } catch { reset('✗ Copy failed', '#ef4444') }
    document.body.removeChild(ta)
    setTimeout(() => reset('⎘ Copy debug', ''), 1800)
  }
}

// ── Settings tab ──────────────────────────────────────────────────────────────
async function setupSettingsTab(user) {
  if (user?.email) $('settingsEmail').textContent = user.email

  $('btnUpgrade').addEventListener('click', () => openUpgradePage())
  $('btnSignOut').addEventListener('click', async () => { await signOut(); showLoginScreen() })

  const prefs = await getStorage(['pref_theme'])
  applyTheme(prefs.pref_theme || 'system')

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => { await setStorage({ pref_theme: btn.dataset.theme }); applyTheme(btn.dataset.theme) })
  })

  // Diagnostics panel — populate + wire refresh
  await renderDiagnostics()
  $('diagRefresh')?.addEventListener('click', () => renderDiagnostics())
  $('diagClearHistory')?.addEventListener('click', () => clearLookupHistory())
  $('diagCopyDebug')?.addEventListener('click', () => copyDebugTrace())
  
  // v40.4: Diagnostics icon button - open diagnostics tab
  const diagIconBtn = $('diagnosticsIconBtn')
  if (diagIconBtn) {
    diagIconBtn.addEventListener('click', () => {
      // Show diagnostics tab and activate it
      const diagTab = document.querySelector('[data-tab="diagnostics"]')
      if (diagTab) {
        diagTab.style.display = 'block'
        diagTab.click() // Activate the tab
      }
    })
  }

  // ── Automatic reply detection ─────────────────────────────────────────────
  // Show the extension redirect URI so the user can copy it for OAuth setup
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`
  const uriEl = $('extensionRedirectUri')
  if (uriEl) uriEl.textContent = redirectUri

  // Helper: update Connect/Disconnect UI for a provider
  function _applyReplyProviderStatus(provider, connected, clientId) {
    const statusEl  = $(provider === 'gmail' ? 'gmailConnectStatus'   : 'outlookConnectStatus')
    const setupArea = $(provider === 'gmail' ? 'gmailSetupArea'        : 'outlookSetupArea')
    const discArea  = $(provider === 'gmail' ? 'gmailDisconnectArea'   : 'outlookDisconnectArea')
    const inputEl   = $(provider === 'gmail' ? 'gmailClientIdInput'    : 'outlookClientIdInput')
    if (statusEl)  { statusEl.textContent = connected ? '● Connected' : '○ Not connected'; statusEl.className = `reply-provider-status ${connected ? 'connected' : 'disconnected'}` }
    if (setupArea) setupArea.style.display = connected ? 'none' : 'block'
    if (discArea)  discArea.style.display  = connected ? 'block' : 'none'
    if (inputEl && clientId && !connected) inputEl.value = clientId
  }

  // Load current status for both providers
  const [gmailSt, outlookSt] = await Promise.all([getGmailStatus(), getOutlookStatus()])
  _applyReplyProviderStatus('gmail',   gmailSt.connected,   gmailSt.clientId)
  _applyReplyProviderStatus('outlook', outlookSt.connected, outlookSt.clientId)

  // Connect Gmail
  $('btnConnectGmail')?.addEventListener('click', async () => {
    const clientId = $('gmailClientIdInput')?.value.trim()
    const statusEl = $('replyDetectionStatus')
    if (!clientId) { if (statusEl) { statusEl.textContent = 'Paste your Google OAuth Client ID first.'; statusEl.style.color = '#dc2626' } return }
    const btn = $('btnConnectGmail'); if (btn) { btn.disabled = true; btn.textContent = 'Connecting…' }
    try {
      await connectGmail(clientId)
      _applyReplyProviderStatus('gmail', true, clientId)
      if (statusEl) { statusEl.textContent = 'Gmail connected! Replies will be auto-detected when you open Campaigns.'; statusEl.style.color = '#16a34a' }
      setTimeout(() => { if (statusEl) statusEl.textContent = '' }, 5000)
    } catch (e) {
      if (statusEl) { statusEl.textContent = e.message === 'SETUP_REQUIRED' ? 'Enter your Client ID first.' : (e.message || 'Gmail connection failed.'); statusEl.style.color = '#dc2626' }
    } finally { if (btn) { btn.disabled = false; btn.textContent = 'Connect Gmail' } }
  })

  // Disconnect Gmail
  $('btnDisconnectGmail')?.addEventListener('click', async () => {
    await disconnectGmail()
    _applyReplyProviderStatus('gmail', false, '')
  })

  // Connect Outlook
  $('btnConnectOutlook')?.addEventListener('click', async () => {
    const clientId = $('outlookClientIdInput')?.value.trim()
    const statusEl = $('replyDetectionStatus')
    if (!clientId) { if (statusEl) { statusEl.textContent = 'Paste your Microsoft App Client ID first.'; statusEl.style.color = '#dc2626' } return }
    const btn = $('btnConnectOutlook'); if (btn) { btn.disabled = true; btn.textContent = 'Connecting…' }
    try {
      await connectOutlook(clientId)
      _applyReplyProviderStatus('outlook', true, clientId)
      if (statusEl) { statusEl.textContent = 'Outlook connected! Replies will be auto-detected when you open Campaigns.'; statusEl.style.color = '#16a34a' }
      setTimeout(() => { if (statusEl) statusEl.textContent = '' }, 5000)
    } catch (e) {
      if (statusEl) { statusEl.textContent = e.message === 'SETUP_REQUIRED' ? 'Enter your Client ID first.' : (e.message || 'Outlook connection failed.'); statusEl.style.color = '#dc2626' }
    } finally { if (btn) { btn.disabled = false; btn.textContent = 'Connect Outlook' } }
  })

  // Disconnect Outlook
  $('btnDisconnectOutlook')?.addEventListener('click', async () => {
    await disconnectOutlook()
    _applyReplyProviderStatus('outlook', false, '')
  })

  // Last-checked timestamp
  function _fmtTimeAgo(ts) {
    if (!ts) return null
    const secs = Math.floor((Date.now() - ts) / 1000)
    if (secs < 60)   return 'just now'
    if (secs < 3600) return `${Math.floor(secs / 60)} min ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)} hr ago`
    return `${Math.floor(secs / 86400)} days ago`
  }

  async function _refreshLastChecked() {
    const ts = await getLastChecked()
    const el = $('replyLastChecked')
    if (!el) return
    if (ts) {
      el.textContent = `Last checked: ${_fmtTimeAgo(ts)}`
    } else {
      const anyConnected = (await Promise.all([getGmailStatus(), getOutlookStatus()])).some(s => s.connected)
      el.textContent = anyConnected ? 'Not yet checked — open a campaign to trigger the first scan.' : ''
    }
  }
  await _refreshLastChecked()

  // Show "Check now" button if at least one provider is connected
  if (gmailSt.connected || outlookSt.connected) {
    const checkNowBtn = $('btnCheckNow')
    if (checkNowBtn) checkNowBtn.style.display = 'block'
    checkNowBtn?.addEventListener('click', async () => {
      const statusEl = $('replyDetectionStatus')
      if (statusEl) { statusEl.textContent = 'Checking inbox… open your Campaigns tab to see results.'; statusEl.style.color = '#6b7280' }
      await _refreshLastChecked()
      setTimeout(() => { if (statusEl) statusEl.textContent = '' }, 4000)
    })
  }

  // Load follow-up notification settings
  const followupPrefs = await getStorage(['sourcedout_followup_days', 'sourcedout_followup_alerts'])
  const followupAlerts = followupPrefs.sourcedout_followup_alerts !== false  // default true
  const followupDays   = Math.max(1, parseInt(followupPrefs.sourcedout_followup_days) || 5)
  if ($('prefFollowupAlerts')) $('prefFollowupAlerts').checked = followupAlerts
  if ($('prefFollowupDays'))   $('prefFollowupDays').value    = followupDays

  $('btnSaveFollowupSettings')?.addEventListener('click', async () => {
    const alerts   = $('prefFollowupAlerts')?.checked ?? true
    const days     = Math.max(1, parseInt($('prefFollowupDays')?.value) || 5)
    const statusEl = $('followupSettingsSaveStatus')
    try {
      await setStorage({ sourcedout_followup_days: days, sourcedout_followup_alerts: alerts })
      if (statusEl) { statusEl.textContent = 'Saved!'; statusEl.style.color = '#16a34a' }
      setTimeout(() => { if (statusEl) { statusEl.textContent = ''; statusEl.style.color = '' } }, 2000)
    } catch {
      if (statusEl) { statusEl.textContent = 'Could not save.'; statusEl.style.color = '#dc2626' }
    }
  })

  // ── Recruiter Profile collapse toggle (persisted) ──
  const rpToggleBtn = $('btnRecruiterProfileToggle')
  const rpBody      = $('recruiterProfileBody')
  if (rpToggleBtn && rpBody) {
    const { recruiterProfileCollapsed } = await chrome.storage.local.get('recruiterProfileCollapsed')
    if (recruiterProfileCollapsed) {
      rpBody.style.display    = 'none'
      rpToggleBtn.textContent = '▸'
      rpToggleBtn.title       = 'Expand'
    }
    rpToggleBtn.addEventListener('click', async () => {
      const nowCollapsed = rpBody.style.display === 'none'
      rpBody.style.display    = nowCollapsed ? '' : 'none'
      rpToggleBtn.textContent = nowCollapsed ? '▾' : '▸'
      rpToggleBtn.title       = nowCollapsed ? 'Minimize' : 'Expand'
      await chrome.storage.local.set({ recruiterProfileCollapsed: !nowCollapsed })
    })
  }

  // Load recruiter profile into settings fields
  const profile = await fetchRecruiterProfile()
  if (profile) {
    if ($('prefFullName'))    $('prefFullName').value    = profile.full_name    || ''
    if ($('prefCompanyName')) $('prefCompanyName').value = profile.company_name || ''
    if ($('prefJobTitle'))    $('prefJobTitle').value    = profile.job_title    || ''
    if ($('prefHiringFocus')) $('prefHiringFocus').value = profile.hiring_focus || ''
    if ($('prefTone'))        $('prefTone').value        = profile.tone         || ''
  }

  $('btnSaveProfile').addEventListener('click', async () => {
    const fullName    = $('prefFullName').value.trim()
    const companyName = $('prefCompanyName').value.trim()
    const statusEl    = $('profileSaveStatus')

    if (!fullName || !companyName) {
      statusEl.textContent = 'Full name and company name are required.'
      statusEl.style.color = '#dc2626'
      return
    }

    const btn = $('btnSaveProfile')
    btn.disabled = true
    statusEl.textContent = 'Saving…'
    statusEl.style.color = '#6b7280'

    try {
      await saveRecruiterProfile({
        fullName,
        companyName,
        jobTitle:    $('prefJobTitle').value.trim()    || null,
        hiringFocus: $('prefHiringFocus').value        || null,
        tone:        $('prefTone').value               || null,
      })
      statusEl.textContent = 'Profile saved!'
      statusEl.style.color = '#16a34a'
      setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = '' }, 2500)
    } catch (e) {
      statusEl.textContent = e.message || 'Could not save — try again.'
      statusEl.style.color = '#dc2626'
    } finally {
      btn.disabled = false
    }
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const loggedIn = await isLoggedIn()
  if (!loggedIn) { showLoginScreen(); return }
  await handlePostLogin()
}
init()
