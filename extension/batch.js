// ─── batch.js ─────────────────────────────────────────────────────────────────
import {
  getCampaigns, getCampaignCandidates, importCampaign,
  enrichCampaignCandidate, draftCampaignCandidate,
  updateCandidateStatus, linkCampaignJob, deleteCampaign,
  getSavedJobs, openUpgradePage,
} from './core/api.js'
import { checkGmailReplies, checkOutlookReplies, getGmailStatus, getOutlookStatus, saveLastChecked } from './core/reply-checker.js'

// ── State ──────────────────────────────────────────────────────────────────────
let _activeCampaignId = null
let _allCandidates = []
let _savedJobs = []
let _batchRunId = 0
let _parsedCandidates = []
let _reviewIndex = 0
let _filterStatus   = 'all'  // 'all' | 'needs_followup' | 'followed_up' | 'responded'
let _followupDays   = 5      // overdue threshold (days), synced from settings
let _followupAlerts = true   // amber highlighting enabled, synced from settings

// ── Storage helper (chrome.storage.local) ─────────────────────────────────────
function _batchGetStorage(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r))
}

// ── DOM shorthand ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

// ── Drawer open / close ────────────────────────────────────────────────────────
export async function openBatchDrawer() {
  const drawer = $('batchDrawer')
  if (!drawer) return
  const statusMsg = $('statusMessage')
  if (statusMsg) { statusMsg.textContent = ''; statusMsg.className = ''; statusMsg.style.display = 'none' }
  await loadFollowupSettings()
  drawer.classList.add('open')
  loadCampaignsList()
  loadJobsForSelector()
}

export function closeBatchDrawer() {
  const drawer = $('batchDrawer')
  if (!drawer) return
  drawer.classList.remove('open')
  _batchRunId++
}

// ── CSV parser (RFC 4180, handles quoted fields and embedded newlines) ─────────
function parseCsv(text) {
  const rows = []
  let col = '', row = [], inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { col += '"'; i++ }
        else inQuotes = false
      } else {
        col += ch
      }
    } else {
      if (ch === '"') { inQuotes = true }
      else if (ch === ',') { row.push(col); col = '' }
      else if (ch === '\n') { row.push(col); col = ''; rows.push(row); row = [] }
      else if (ch === '\r') { /* skip */ }
      else col += ch
    }
  }
  if (col || row.length) { row.push(col); rows.push(row) }
  return rows
}

function csvToObjects(rows) {
  if (rows.length < 2) return []
  const headers = rows[0].map(h => h.trim().toLowerCase())
  const get = (row, ...keys) => {
    for (const k of keys) {
      const idx = headers.indexOf(k)
      if (idx !== -1) return (row[idx] || '').trim()
    }
    return ''
  }
  return rows.slice(1).filter(r => r.some(c => c.trim())).map(row => ({
    first_name:      get(row, 'first name'),
    last_name:       get(row, 'last name'),
    headline:        get(row, 'headline'),
    location:        get(row, 'location'),
    current_title:   get(row, 'current title'),
    current_company: get(row, 'current company'),
    email:           get(row, 'email address', 'email'),
    phone:           get(row, 'phone number', 'phone'),
    linkedin_url:    get(row, 'profile url', 'linkedin url', 'linkedin'),
    active_project:  get(row, 'active project'),
    notes:           get(row, 'notes'),
    feedback:        get(row, 'feedback'),
  }))
}

// ── Load saved jobs for selectors ─────────────────────────────────────────────
async function loadJobsForSelector() {
  try {
    const { jobs } = await getSavedJobs()
    _savedJobs = jobs || []
    renderJobSelectors()
  } catch {}
}

function renderJobSelectors() {
  document.querySelectorAll('.batch-job-select').forEach(sel => {
    const current = sel.value
    sel.innerHTML = '<option value="">— Select a saved job —</option>'
    _savedJobs.forEach(j => {
      const opt = document.createElement('option')
      opt.value = j.id
      opt.textContent = j.label + (j.company ? ` — ${j.company}` : '')
      sel.appendChild(opt)
    })
    if (current) sel.value = current
  })
}

// ── Previous campaigns list (collapsed) ──────────────────────────────────────
async function loadCampaignsList() {
  const list = $('batchCampaignList')
  if (!list) return
  list.innerHTML = '<div class="batch-loading">Loading campaigns…</div>'
  try {
    const { campaigns } = await getCampaigns()
    list.innerHTML = ''
    if (!campaigns || campaigns.length === 0) {
      list.innerHTML = '<div class="batch-empty">No campaigns yet.</div>'
      return
    }
    campaigns.forEach(c => {
      const row = document.createElement('div')
      row.className = 'batch-campaign-row'
      const job = c.saved_jobs
      const jobLabel = job ? `${job.label}${job.company ? ' — ' + job.company : ''}` : null
      const statusBadge = c.status === 'needs_job'
        ? '<span class="batch-badge warn">Needs job</span>'
        : `<span class="batch-badge ok">${c.status}</span>`
      const sentTotal  = c.sent_count || 0
      const respondedN = c.responded_count || 0
      const respPct    = sentTotal > 0 ? Math.round(respondedN / sentTotal * 100) : null
      const respClass  = respPct === null ? '' : respPct >= 40 ? 'ok' : respPct >= 15 ? 'mid' : 'low'
      const respStat   = sentTotal > 0
        ? `<div class="batch-resp-rate ${respClass}">${respondedN}/${sentTotal} responded (${respPct}%)</div>`
        : ''
      row.innerHTML = `
        <div class="batch-campaign-info">
          <div class="batch-campaign-name">${_esc(c.name)}</div>
          <div class="batch-campaign-meta">
            ${jobLabel ? `<span class="batch-campaign-job">${_esc(jobLabel)}</span>` : '<span class="batch-campaign-job warn-text">No job linked</span>'}
            ${statusBadge}
          </div>
          <div class="batch-campaign-counts">
            ${c.enriched_count}/${c.total_count} enriched · ${c.drafted_count} drafted · ${sentTotal} sent
          </div>
          ${respStat}
        </div>
        <div class="batch-campaign-actions">
          <button class="batch-btn batch-btn-sm" data-open="${c.id}">Open</button>
          <button class="batch-btn batch-btn-sm batch-btn-danger" data-delete="${c.id}">✕</button>
        </div>`
      row.querySelector('[data-open]').addEventListener('click', () => openCampaign(c.id, c))
      row.querySelector('[data-delete]').addEventListener('click', async e => {
        e.stopPropagation()
        if (!confirm(`Delete campaign "${c.name}" and all its candidates?`)) return
        try {
          await deleteCampaign({ campaignId: c.id })
          await loadCampaignsList()
        } catch { alert('Could not delete campaign.') }
      })
      list.appendChild(row)
    })
  } catch (e) {
    list.innerHTML = '<div class="batch-empty">Could not load campaigns.</div>'
  }
}

async function openCampaign(campaignId, campaignData) {
  _activeCampaignId = campaignId
  // Reset filter to "All" whenever a campaign is (re-)opened
  _filterStatus = 'all'
  document.querySelectorAll('#batchFilterBar .batch-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === 'all')
  })

  if (campaignData?.status === 'needs_job') {
    setBatchStatus('This campaign has no job linked yet. Link a job before enriching or drafting.', 'warn')
    const linkRow = $('batchLinkJobRow')
    if (linkRow) linkRow.style.display = 'block'
  }

  await loadCandidatePanel(campaignId)
  showStep(3)
}

// ── Progressive disclosure: show/hide steps ─────────────────────────────────
function showStep(num) {
  for (let i = 3; i <= 4; i++) {
    const el = $(`batchStep${i}`)
    if (el) el.style.display = i <= num ? 'block' : 'none'
  }
  if (num >= 3) {
    const n1 = $('batchStepNum1')
    const n2 = $('batchStepNum2')
    if (n1) n1.classList.add('done')
    if (n2) n2.classList.add('done')
  }
}

// ── Dropzone: drag-drop + paste + click-to-browse ───────────────────────────
function setupDropzone() {
  const dropzone = $('batchDropzone')
  if (!dropzone) return

  let _fileInput = null

  dropzone.addEventListener('dragover', e => {
    e.preventDefault()
    dropzone.classList.add('dragover')
  })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'))
  dropzone.addEventListener('drop', e => {
    e.preventDefault()
    dropzone.classList.remove('dragover')
    const file = e.dataTransfer.files?.[0]
    if (file) readCsvFile(file)
  })

  dropzone.addEventListener('click', () => {
    if (!_fileInput) {
      _fileInput = document.createElement('input')
      _fileInput.type = 'file'
      _fileInput.accept = '.csv'
      _fileInput.addEventListener('change', () => {
        const file = _fileInput.files?.[0]
        if (file) readCsvFile(file)
      })
    }
    _fileInput.click()
  })

  dropzone.addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text')
    if (text) handlePastedText(text)
  })

  dropzone.addEventListener('keydown', e => {
    if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
      // paste will fire naturally
    }
  })
}

function readCsvFile(file) {
  const reader = new FileReader()
  reader.onload = e => {
    const rows = parseCsv(e.target.result)
    _parsedCandidates = csvToObjects(rows)
    afterParse(file.name)
  }
  reader.readAsText(file)
}

function handlePastedText(text) {
  const rows = parseCsv(text)
  _parsedCandidates = csvToObjects(rows)
  afterParse('pasted data')
}

function afterParse(fileName) {
  if (_parsedCandidates.length === 0) {
    setBatchStatus('No candidates found in the data. Ensure the CSV has "First Name" and "Last Name" columns.', 'warn')
    return
  }

  const count = _parsedCandidates.length
  const label = `${count} candidate${count !== 1 ? 's' : ''}`
  const dropzone = $('batchDropzone')
  if (dropzone) {
    dropzone.innerHTML = `<span class="file-pill">📄 ${fileName} — ${label}</span>`
    dropzone.classList.add('compact')
  }

  const preview = $('batchImportPreview')
  if (preview) preview.textContent = `${label} detected`

  const form = $('batchImportForm')
  if (form) form.style.display = 'block'

  const firstProject = _parsedCandidates.find(c => c.active_project)?.active_project || ''
  const nameInput = $('batchCampaignName')
  if (nameInput && !nameInput.value.trim() && firstProject) nameInput.value = firstProject

  checkImportReady()
}

function checkImportReady() {
  const importBtn = $('batchImportBtn')
  if (!importBtn) return
  const hasName = ($('batchCampaignName')?.value || '').trim().length > 0
  const hasCandidates = _parsedCandidates.length > 0
  const hasJob = !!$('batchJobSelect')?.value
  importBtn.disabled = !(hasName && hasCandidates && hasJob)
}

// ── Import candidates ────────────────────────────────────────────────────────
async function doImport() {
  const nameInput = $('batchCampaignName')
  const name = (nameInput?.value || '').trim()
  if (!name || _parsedCandidates.length === 0) return

  const jobId = $('batchJobSelect')?.value || null
  if (!jobId) {
    setBatchStatus('Please select a saved job first.', 'error')
    return
  }

  const importBtn = $('batchImportBtn')
  if (importBtn) { importBtn.disabled = true; importBtn.textContent = 'Importing…' }
  setBatchStatus('', '')

  try {
    const result = await importCampaign({
      campaignName: name,
      jobId,
      candidates: _parsedCandidates,
    })

    if (result.creditWarning) {
      showCreditWarning(result.creditWarning.message, result.creditWarning.available)
    }

    _parsedCandidates = []
    if (nameInput) nameInput.value = ''
    const preview = $('batchImportPreview')
    if (preview) preview.textContent = ''
    const form = $('batchImportForm')
    if (form) form.style.display = 'none'
    const dropzone = $('batchDropzone')
    if (dropzone) {
      dropzone.classList.remove('compact')
      dropzone.innerHTML = '<div class="batch-dropzone-icon">📄</div><div>Drag & drop a LinkedIn CSV here</div><div class="batch-dropzone-hint">or click and paste (Cmd+V / Ctrl+V) rows from your ATS</div>'
    }

    await loadCampaignsList()
    if (result.campaign?.id) {
      await openCampaign(result.campaign.id, result.campaign)
    }
  } catch (e) {
    setBatchStatus(_batchErrorMessage(e, 'Import failed. Try again.'), 'error')
    if (importBtn) { importBtn.disabled = false; importBtn.textContent = 'Import candidates' }
  }
}

// ── Candidates panel (Step 3) ───────────────────────────────────────────────
async function loadCandidatePanel(campaignId) {
  if (!campaignId) return
  const list = $('batchCandidateList')
  if (!list) return
  list.innerHTML = '<div class="batch-loading">Loading candidates…</div>'

  try {
    const { candidates } = await getCampaignCandidates({ campaignId })
    _allCandidates = candidates || []
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
    _checkForReplies()  // non-blocking background inbox check
  } catch {
    list.innerHTML = '<div class="batch-empty">Could not load candidates.</div>'
  }
}

// ── Automatic inbox reply detection ─────────────────────────────────────────
async function _checkForReplies() {
  // Only check candidates that were sent a message and still have an actionable status
  const toCheck = _allCandidates.filter(c =>
    ['approved', 'followed_up'].includes(c.status) &&
    (c.work_email || c.personal_email || c.csv_email)
  )
  if (!toCheck.length) return

  // Bail out immediately if neither provider is connected (avoids storage round-trips on every open)
  const [gmailSt, outlookSt] = await Promise.all([getGmailStatus(), getOutlookStatus()])
  if (!gmailSt.connected && !outlookSt.connected) return

  // Build email → candidateId lookup
  const emailToId = {}
  toCheck.forEach(c => {
    const email = (c.work_email || c.personal_email || c.csv_email)?.toLowerCase()
    if (email) emailToId[email] = c.id
  })
  const emailAddresses = Object.keys(emailToId)
  if (!emailAddresses.length) return

  // Show "Checking…" indicator
  const indicator = $('batchReplyCheckStatus')
  if (indicator) indicator.style.display = 'block'

  try {
    const repliedEmails = new Set()
    const checks = []
    if (gmailSt.connected)   checks.push(checkGmailReplies(emailAddresses).then(r   => r.forEach(e => repliedEmails.add(e))))
    if (outlookSt.connected) checks.push(checkOutlookReplies(emailAddresses).then(r => r.forEach(e => repliedEmails.add(e))))
    await Promise.all(checks)

    if (!repliedEmails.size) return

    // Auto-mark matched candidates as responded
    let newlyResponded = 0
    for (const [email, candidateId] of Object.entries(emailToId)) {
      if (!repliedEmails.has(email)) continue
      const idx = _allCandidates.findIndex(c => c.id === candidateId)
      if (idx === -1 || _allCandidates[idx].status === 'responded') continue
      try {
        await updateCandidateStatus({ candidateId, status: 'responded' })
        _allCandidates[idx].status = 'responded'
        newlyResponded++
      } catch {}
    }

    if (newlyResponded > 0) {
      renderCandidateList(_allCandidates)
      updateBatchActionButtons()
      setBatchStatus(`${newlyResponded} candidate${newlyResponded > 1 ? 's' : ''} auto-marked as responded.`, 'success')
      setTimeout(() => setBatchStatus('', ''), 4000)
    }
  } finally {
    if (indicator) indicator.style.display = 'none'
    saveLastChecked().catch(() => {})
  }
}

function renderCandidateList(candidates) {
  const list = $('batchCandidateList')
  if (!list) return

  // Show filter bar once any candidate has been sent, followed up, or responded
  const filterBar = $('batchFilterBar')
  const hasSent = candidates.some(c => ['approved', 'followed_up', 'responded'].includes(c.status))
  if (filterBar) filterBar.style.display = hasSent ? 'flex' : 'none'

  // Apply active filter
  let displayed = candidates
  if      (_filterStatus === 'needs_followup') displayed = candidates.filter(c => c.status === 'approved')
  else if (_filterStatus === 'followed_up')    displayed = candidates.filter(c => c.status === 'followed_up')
  else if (_filterStatus === 'responded')      displayed = candidates.filter(c => c.status === 'responded')

  list.innerHTML = ''

  if (displayed.length === 0) {
    const msg = _filterStatus === 'needs_followup' ? 'No candidates awaiting follow-up.'
              : _filterStatus === 'followed_up'    ? 'No candidates marked as followed up yet.'
              : _filterStatus === 'responded'      ? 'No candidates have responded yet.'
              : 'No candidates imported yet.'
    list.innerHTML = `<div class="batch-empty">${msg}</div>`
    _updateOverdueBadge(candidates)
    return
  }

  displayed.forEach(c => {
    const row = document.createElement('div')
    row.className = 'batch-candidate-row'
    row.dataset.id = c.id
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—'
    const titleLine = [c.enriched_title || c.current_title, c.enriched_company || c.current_company].filter(Boolean).join(' · ')
    const email = c.work_email || c.personal_email || c.csv_email || null
    const emailBadge = email
      ? `<span class="batch-badge ok-sm">${_esc(email)}</span>`
      : `<span class="batch-badge gray-sm">No email</span>`
    const sourceBadge = email ? _sourceBadge(c.enrichment_source) : ''

    // Days-since-sent badge (approved and followed_up only — not responded, which is terminal)
    const showDays  = ['approved', 'followed_up'].includes(c.status) && c.approved_at
    const days      = showDays ? daysSince(c.approved_at) : null
    const isOverdue = _followupAlerts && days !== null && days >= _followupDays && c.status === 'approved'
    const daysBadge = days !== null
      ? `<span class="batch-days-badge${isOverdue ? ' overdue' : ''}" title="Sent ${days} day${days !== 1 ? 's' : ''} ago">${days}d ago</span>`
      : ''

    row.innerHTML = `
      <div class="batch-candidate-info">
        <div class="batch-candidate-name">${_esc(name)}</div>
        <div class="batch-candidate-meta">${_esc(titleLine)}${daysBadge}</div>
        <div class="batch-candidate-email">${emailBadge} ${sourceBadge} ${_statusBadge(c.status)}</div>
      </div>
      <div class="batch-candidate-actions">
        ${c.linkedin_url ? `<a href="${_esc(c.linkedin_url)}" target="_blank" class="batch-link-btn" title="Open LinkedIn">↗</a>` : ''}
        ${['imported','failed'].includes(c.status) ? `<button class="batch-btn batch-btn-xs" data-enrich="${c.id}">Enrich</button>` : ''}
        ${c.status === 'enriched' ? `<button class="batch-btn batch-btn-xs" data-draft="${c.id}">Draft</button>` : ''}
        ${c.status === 'approved' ? `<button class="batch-btn batch-btn-xs batch-followup-btn" data-followup="${c.id}" title="Mark as followed up">↺ Follow Up</button>` : ''}
        ${['approved', 'followed_up'].includes(c.status) ? `<button class="batch-btn batch-btn-xs batch-responded-btn" data-responded="${c.id}" title="Candidate replied">&#x2713; Responded</button>` : ''}
      </div>`

    row.querySelector('[data-enrich]')?.addEventListener('click', async e => {
      e.stopPropagation()
      await runSingleEnrich(c.id, row)
    })
    row.querySelector('[data-draft]')?.addEventListener('click', async e => {
      e.stopPropagation()
      await runSingleDraft(c.id, row)
    })
    row.querySelector('[data-followup]')?.addEventListener('click', async e => {
      e.stopPropagation()
      await markFollowedUp(c.id)
    })
    row.querySelector('[data-responded]')?.addEventListener('click', async e => {
      e.stopPropagation()
      await markResponded(c.id)
    })

    list.appendChild(row)
  })

  _updateOverdueBadge(candidates)
}

function updateBatchActionButtons() {
  const needsEnrich = _allCandidates.filter(c => ['imported','failed'].includes(c.status)).length
  const needsDraft  = _allCandidates.filter(c => c.status === 'enriched').length
  const enrichBtn = $('batchEnrichAllBtn')
  const draftBtn  = $('batchDraftAllBtn')
  if (enrichBtn) {
    enrichBtn.disabled = needsEnrich === 0
    enrichBtn.textContent = needsEnrich > 0 ? `🔍 Find ${needsEnrich} emails` : '🔍 All emails found'
  }
  if (draftBtn) {
    draftBtn.disabled = needsDraft === 0
    draftBtn.textContent = needsDraft > 0 ? `✨ Draft ${needsDraft} candidates` : '✨ All drafted'
  }
}

// ── Poll for async enrichment completion ──────────────────────────────────────
// Server returns 202 + status='enriching' immediately, then finishes the
// waterfall + FullEnrich in the background. We poll the candidate row until
// status is terminal or we hit the timeout.
async function pollCandidateUntilDone(candidateId, { timeoutMs = 180000, intervalMs = 4000 } = {}) {
  const terminal = new Set(['enriched', 'no_email', 'failed', 'drafted', 'approved', 'skipped', 'followed_up', 'responded'])
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, intervalMs))
    if (!_activeCampaignId) return null
    try {
      const { candidates } = await getCampaignCandidates({ campaignId: _activeCampaignId })
      const fresh = (candidates || []).find(c => c.id === candidateId)
      if (fresh && terminal.has(fresh.status)) return fresh
      // Refresh row in UI so user sees "Finding email…" spinner state
      const idx = _allCandidates.findIndex(c => c.id === candidateId)
      if (idx !== -1 && fresh) _allCandidates[idx] = { ..._allCandidates[idx], ...fresh }
    } catch {
      // transient — keep polling
    }
  }
  return null // timed out
}

// ── Single enrich/draft ────────────────────────────────────────────────────────
async function runSingleEnrich(candidateId, rowEl) {
  if (rowEl) rowEl.classList.add('batch-row-processing')
  const idx0 = _allCandidates.findIndex(c => c.id === candidateId)
  if (idx0 !== -1) _allCandidates[idx0].status = 'enriching'
  renderCandidateList(_allCandidates)
  try {
    const result = await enrichCampaignCandidate({ candidateId })
    // Cache hit returns terminal status synchronously; async path returns 'enriching'
    if (result.status && result.status !== 'enriching') {
      const idx = _allCandidates.findIndex(c => c.id === candidateId)
      if (idx !== -1) {
        _allCandidates[idx].status = result.status
        _allCandidates[idx].work_email = result.email || _allCandidates[idx].work_email
      }
    } else {
      const fresh = await pollCandidateUntilDone(candidateId)
      const idx = _allCandidates.findIndex(c => c.id === candidateId)
      if (idx !== -1) {
        if (fresh) {
          _allCandidates[idx] = { ..._allCandidates[idx], ...fresh }
        } else {
          _allCandidates[idx].status = 'failed'
        }
      }
    }
    if (rowEl) rowEl.classList.remove('batch-row-processing')
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
  } catch (e) {
    if (rowEl) rowEl.classList.remove('batch-row-processing')
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'failed'
    renderCandidateList(_allCandidates)
    if (e.code === 'CREDIT_LIMIT_REACHED') {
      showCreditWarning('Credit limit reached. Upgrade to continue enriching.', 0)
    }
  }
}

async function runSingleDraft(candidateId, rowEl) {
  if (rowEl) rowEl.classList.add('batch-row-processing')
  try {
    const result = await draftCampaignCandidate({ candidateId })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) {
      _allCandidates[idx].status = 'drafted'
      _allCandidates[idx].draft_subject = result.draft?.subject || ''
      _allCandidates[idx].draft_body = result.draft?.body || ''
      _allCandidates[idx].draft_confidence = result.draft?.confidence || 0
    }
    if (rowEl) rowEl.classList.remove('batch-row-processing')
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
  } catch {
    if (rowEl) rowEl.classList.remove('batch-row-processing')
  }
}

// ── Batch enrich all ──────────────────────────────────────────────────────────
async function runEnrichAll() {
  if (!_activeCampaignId) return
  const toEnrich = _allCandidates.filter(c => ['imported','failed'].includes(c.status))
  if (toEnrich.length === 0) return
  const myRunId = ++_batchRunId

  const enrichBtn = $('batchEnrichAllBtn')
  const progressEl = $('batchEnrichProgress')
  if (enrichBtn) { enrichBtn.disabled = true; enrichBtn.textContent = 'Finding emails…' }

  let done = 0
  for (const candidate of toEnrich) {
    if (_batchRunId !== myRunId) break
    if (progressEl) progressEl.textContent = `${done} / ${toEnrich.length} checked…`
    try {
      const result = await enrichCampaignCandidate({ candidateId: candidate.id })
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (result.status && result.status !== 'enriching') {
        if (idx !== -1) {
          _allCandidates[idx].status = result.status
          _allCandidates[idx].work_email = result.email || _allCandidates[idx].work_email
        }
      } else {
        if (idx !== -1) _allCandidates[idx].status = 'enriching'
        renderCandidateList(_allCandidates)
        const fresh = await pollCandidateUntilDone(candidate.id)
        const idx2 = _allCandidates.findIndex(c => c.id === candidate.id)
        if (idx2 !== -1) {
          if (fresh) _allCandidates[idx2] = { ..._allCandidates[idx2], ...fresh }
          else       _allCandidates[idx2].status = 'failed'
        }
      }
    } catch (e) {
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (idx !== -1) _allCandidates[idx].status = 'failed'
      if (e.code === 'CREDIT_LIMIT_REACHED') {
        showCreditWarning('Credit limit reached. Upgrade to continue enriching.', 0)
        break
      }
    }
    done++
    renderCandidateList(_allCandidates)
  }

  if (progressEl) progressEl.textContent = `${done} / ${toEnrich.length} checked`
  updateBatchActionButtons()
  if (enrichBtn) enrichBtn.disabled = false
  setTimeout(() => { if (progressEl) progressEl.textContent = '' }, 3000)
}

// ── Batch draft all ────────────────────────────────────────────────────────────
async function runDraftAll() {
  if (!_activeCampaignId) return
  const toDraft = _allCandidates.filter(c => c.status === 'enriched')
  if (toDraft.length === 0) return
  const myRunId = ++_batchRunId

  const draftBtn = $('batchDraftAllBtn')
  const progressEl = $('batchDraftProgress')
  if (draftBtn) { draftBtn.disabled = true; draftBtn.textContent = 'Generating drafts…' }

  let done = 0
  for (const candidate of toDraft) {
    if (_batchRunId !== myRunId) break
    if (progressEl) progressEl.textContent = `${done} / ${toDraft.length} drafted…`
    try {
      const result = await draftCampaignCandidate({ candidateId: candidate.id })
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (idx !== -1) {
        _allCandidates[idx].status = 'drafted'
        _allCandidates[idx].draft_subject = result.draft?.subject || ''
        _allCandidates[idx].draft_body = result.draft?.body || ''
        _allCandidates[idx].draft_confidence = result.draft?.confidence || 0
      }
    } catch {
      // skip failed drafts
    }
    done++
    renderCandidateList(_allCandidates)
  }

  if (progressEl) progressEl.textContent = `${done} / ${toDraft.length} drafted`
  updateBatchActionButtons()
  if (draftBtn) draftBtn.disabled = false
  setTimeout(() => { if (progressEl) progressEl.textContent = '' }, 3000)

  if (done > 0) {
    loadReviewQueue()
    showStep(4)
  }
}

// ── Review queue (one-at-a-time, Step 4) ─────────────────────────────────────
function loadReviewQueue() {
  _reviewIndex = 0
  renderCurrentReview()
}

function renderCurrentReview() {
  const drafted = _allCandidates.filter(c => c.status === 'drafted')
  const queue = $('batchReviewQueue')
  const counter = $('batchReviewCounter')
  if (!queue) return

  if (drafted.length === 0) {
    queue.innerHTML = '<div class="batch-review-done">All drafts reviewed!</div>'
    if (counter) counter.textContent = ''
    return
  }

  if (_reviewIndex >= drafted.length) {
    queue.innerHTML = '<div class="batch-review-done">All drafts reviewed!</div>'
    if (counter) counter.textContent = ''
    return
  }

  const c = drafted[_reviewIndex]
  if (counter) counter.textContent = `${_reviewIndex + 1} of ${drafted.length}`

  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—'
  const email = c.work_email || c.personal_email || c.csv_email || ''
  const confPct = Math.round((c.draft_confidence || 0) * 100)

  queue.innerHTML = ''
  const card = document.createElement('div')
  card.className = 'batch-review-card'
  card.innerHTML = `
    <div class="batch-review-header">
      <div>
        <div class="batch-review-name">${_esc(name)}</div>
        <div class="batch-review-meta">${_esc(email)} ${confPct > 0 ? `<span class="batch-conf-badge ${confPct >= 80 ? 'high' : confPct >= 60 ? 'mid' : 'low'}">${confPct}%</span>` : ''}</div>
      </div>
    </div>
    <div class="batch-review-subject">${_esc(c.draft_subject || '')}</div>
    <textarea class="batch-review-body">${_esc(c.draft_body || '')}</textarea>
    <div class="batch-review-actions">
      <button class="batch-btn batch-btn-gmail" id="batchReviewGmail">Gmail</button>
      <button class="batch-btn batch-btn-outlook" id="batchReviewOutlook">Outlook</button>
      <button class="batch-btn batch-btn-sm" id="batchReviewSkip">Skip</button>
    </div>`

  queue.appendChild(card)

  const bodyEl = card.querySelector('.batch-review-body')
  const subject = c.draft_subject || `Reaching out — ${name}`

  $('batchReviewGmail')?.addEventListener('click', async () => {
    const body = bodyEl?.value || c.draft_body || ''
    await approveCandidate(c.id)
    chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` })
    advanceReview()
  })

  $('batchReviewOutlook')?.addEventListener('click', async () => {
    const body = bodyEl?.value || c.draft_body || ''
    await approveCandidate(c.id)
    chrome.tabs.create({ url: `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(email)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` })
    advanceReview()
  })

  $('batchReviewSkip')?.addEventListener('click', async () => {
    await skipCandidate(c.id)
    advanceReview()
  })
}

function advanceReview() {
  _reviewIndex++
  renderCurrentReview()
}

async function approveCandidate(candidateId) {
  try {
    await updateCandidateStatus({ candidateId, status: 'approved' })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'approved'
  } catch {}
}

async function skipCandidate(candidateId) {
  try {
    await updateCandidateStatus({ candidateId, status: 'skipped' })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'skipped'
  } catch {}
}

// ── Mark candidate as responded ────────────────────────────────────────────────
async function markResponded(candidateId) {
  try {
    await updateCandidateStatus({ candidateId, status: 'responded' })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'responded'
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
    setBatchStatus('Marked as responded.', 'success')
    setTimeout(() => setBatchStatus('', ''), 2500)
  } catch {
    setBatchStatus('Could not update status — please try again.', 'error')
  }
}

// ── Mark candidate as followed up ─────────────────────────────────────────────
async function markFollowedUp(candidateId) {
  try {
    await updateCandidateStatus({ candidateId, status: 'followed_up' })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'followed_up'
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
    setBatchStatus('Marked as followed up.', 'success')
    setTimeout(() => setBatchStatus('', ''), 2500)
  } catch {
    setBatchStatus('Could not update status — please try again.', 'error')
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
// ── Follow-up settings loader ──────────────────────────────────────────────────
async function loadFollowupSettings() {
  try {
    const stored = await _batchGetStorage(['sourcedout_followup_days', 'sourcedout_followup_alerts'])
    _followupDays   = Math.max(1, parseInt(stored.sourcedout_followup_days) || 5)
    _followupAlerts = stored.sourcedout_followup_alerts !== false  // default true
  } catch {}
}

// ── Days since a date string ────────────────────────────────────────────────────
function daysSince(dateStr) {
  if (!dateStr) return null
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24))
}

// ── Update overdue count badge on Campaigns tab ────────────────────────────────
function _updateOverdueBadge(candidates) {
  const count = _followupAlerts ? candidates.filter(c => {
    if (c.status !== 'approved' || !c.approved_at) return false
    return daysSince(c.approved_at) >= _followupDays
  }).length : 0
  const badge = document.getElementById('campaignsOverdueBadge')
  if (!badge) return
  badge.textContent = count
  badge.style.display = count > 0 ? 'inline-block' : 'none'
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function _statusBadge(status) {
  const map = {
    imported:    ['gray-sm',   'Pending'],
    enriching:   ['info-sm',   'Finding email…'],
    enriched:    ['ok-sm',     'Email found'],
    no_email:    ['warn-sm',   'No email'],
    drafting:    ['info-sm',   'Writing draft…'],
    drafted:     ['ok-sm',     'Draft ready'],
    approved:    ['green-sm',  'Sent'],
    skipped:     ['gray-sm',   'Skipped'],
    failed:      ['err-sm',    'Failed'],
    followed_up: ['purple-sm', 'Followed Up'],
    responded:   ['teal-sm',   'Responded'],
  }
  const [cls, label] = map[status] || ['gray-sm', status]
  return `<span class="batch-badge ${cls}">${label}</span>`
}

function _sourceBadge(source) {
  if (!source) return ''
  const map = {
    'haiku+verifier':         ['info-sm', 'Haiku'],
    'google_cse':             ['info-sm', 'Google'],
    'permutator+verifier':    ['info-sm', 'MEV'],
    'apollo':                 ['info-sm', 'Apollo'],
    'fullenrich_v2':          ['warn-sm', 'FullEnrich'],
  }
  const [cls, label] = map[source] || ['gray-sm', source]
  return `<span class="batch-badge ${cls}" title="Email source: ${source}">${label}</span>`
}

const _MISLEADING_CODES = ['NO_LINKEDIN_URL', 'UNKNOWN_ACTION']
function _batchErrorMessage(e, fallback) {
  if (e && _MISLEADING_CODES.includes(e.code)) return fallback
  return e?.message || fallback
}

function setBatchStatus(msg, type) {
  const el = $('batchStatus')
  if (!el) return
  el.textContent = msg
  el.className = `batch-status-bar${msg ? ' ' + type : ''}`
}

function showCreditWarning(message, available) {
  const el = $('batchCreditWarning')
  const msgEl = $('batchCreditWarningMsg')
  if (!el || !msgEl) return
  msgEl.textContent = message
  el.style.display = 'block'
  $('batchCreditUpgradeBtn')?.addEventListener('click', () => openUpgradePage(), { once: true })
  setTimeout(() => { el.style.display = 'none' }, 12000)
}

// ── Init ───────────────────────────────────────────────────────────────────────
export function initBatch() {
  $('batchDrawerClose')?.addEventListener('click', closeBatchDrawer)

  const prevToggle = $('batchPrevToggle')
  const prevList = $('batchPrevCampaigns')
  if (prevToggle && prevList) {
    prevToggle.addEventListener('click', () => {
      const open = prevList.style.display !== 'none'
      prevList.style.display = open ? 'none' : 'block'
      prevToggle.textContent = open ? 'Previous campaigns' : 'Hide previous campaigns'
    })
  }

  const jobSel = $('batchJobSelect')
  if (jobSel) {
    jobSel.addEventListener('change', () => {
      const confirm = $('batchJobConfirm')
      if (confirm) {
        const opt = jobSel.options[jobSel.selectedIndex]
        confirm.style.display = jobSel.value ? 'block' : 'none'
        confirm.textContent = jobSel.value ? `Job: ${opt.textContent}` : ''
      }
      checkImportReady()
    })
  }

  setupDropzone()

  $('batchCampaignName')?.addEventListener('input', checkImportReady)
  $('batchImportBtn')?.addEventListener('click', doImport)

  $('batchEnrichAllBtn')?.addEventListener('click', async () => {
    if (!_activeCampaignId) { setBatchStatus('Select a campaign first.', 'warn'); return }
    await runEnrichAll()
  })

  $('batchDraftAllBtn')?.addEventListener('click', async () => {
    if (!_activeCampaignId) { setBatchStatus('Select a campaign first.', 'warn'); return }
    await runDraftAll()
  })

  // ── Follow-Up filter bar ────────────────────────────────────────────────────
  $('batchFilterBar')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]')
    if (!btn) return
    _filterStatus = btn.dataset.filter
    document.querySelectorAll('#batchFilterBar .batch-filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === _filterStatus)
    })
    renderCandidateList(_allCandidates)
  })

  const linkJobSel = $('batchLinkJobSelect')
  const linkJobBtn = $('batchLinkJobBtn')
  if (linkJobSel && linkJobBtn) {
    linkJobBtn.addEventListener('click', async () => {
      const jobId = linkJobSel.value
      if (!jobId || !_activeCampaignId) return
      try {
        await linkCampaignJob({ campaignId: _activeCampaignId, jobId })
        setBatchStatus('Job linked. You can now enrich and draft candidates.', 'success')
        linkJobSel.value = ''
        $('batchLinkJobRow').style.display = 'none'
        await loadCandidatePanel(_activeCampaignId)
      } catch { setBatchStatus('Could not link job.', 'error') }
    })
  }
}
