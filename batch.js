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
let _filterStatus   = 'all'  // 'all' | 'needs_followup' | 'followed_up' | 'responded'
let _followupDays   = 5      // overdue threshold (days), synced from settings
let _followupAlerts = true   // amber highlighting enabled, synced from settings

const DROPZONE_DEFAULT_HTML = '<div class="batch-dropzone-icon">&#x1F4C4;</div><div>Drag &amp; drop a LinkedIn CSV here</div><div class="batch-dropzone-hint">or click and paste (Cmd+V / Ctrl+V) rows from your ATS</div>'

// ── Storage helper (chrome.storage.local) ─────────────────────────────────────
function _batchGetStorage(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r))
}

// ── Diagnostics event log (rendered in the Diagnostics tab) ───────────────────
async function _logCampaignEvent(text) {
  try {
    const { sourcedout_campaign_events } = await _batchGetStorage(['sourcedout_campaign_events'])
    const events = Array.isArray(sourcedout_campaign_events) ? sourcedout_campaign_events : []
    events.unshift({ text, timestamp: Date.now() })
    chrome.storage.local.set({ sourcedout_campaign_events: events.slice(0, 8) })
  } catch {}
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
  showHome()
  loadJobsForSelector()
}

export function closeBatchDrawer() {
  const drawer = $('batchDrawer')
  if (!drawer) return
  drawer.classList.remove('open')
  _batchRunId++
}

// ── Home (campaign list) vs single-campaign view ─────────────────────────────
function showHome() {
  _activeCampaignId = null
  _allCandidates = []
  _batchRunId++
  setBatchStatus('', '')
  const linkRow = $('batchLinkJobRow')
  if (linkRow) linkRow.style.display = 'none'
  for (const i of [3, 4]) { const el = $(`batchStep${i}`); if (el) el.style.display = 'none' }
  $('batchStepNum1')?.classList.remove('done')
  $('batchStepNum2')?.classList.remove('done')
  const back = $('batchBackToCampaigns')
  if (back) back.style.display = 'none'
  const home = $('batchHomeSection')
  if (home) home.style.display = 'block'
  resetImportForm()
  setNewCampaignSectionOpen(false)  // loadCampaignsList re-opens it when there are no campaigns
  loadCampaignsList()
}

function showCampaignView() {
  const home = $('batchHomeSection')
  if (home) home.style.display = 'none'
  const back = $('batchBackToCampaigns')
  if (back) back.style.display = 'inline-block'
}

function setNewCampaignSectionOpen(open) {
  const section = $('batchNewCampaignSection')
  if (section) section.style.display = open ? 'block' : 'none'
  const btn = $('batchNewCampaignBtn')
  if (btn) btn.textContent = open ? '× Cancel' : '＋ New campaign'
}

function resetImportForm() {
  _parsedCandidates = []
  const form = $('batchImportForm')
  if (form) form.style.display = 'none'
  const preview = $('batchImportPreview')
  if (preview) preview.textContent = ''
  const nameInput = $('batchCampaignName')
  if (nameInput) nameInput.value = ''
  const dropzone = $('batchDropzone')
  if (dropzone) {
    dropzone.classList.remove('compact')
    dropzone.innerHTML = DROPZONE_DEFAULT_HTML
  }
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
  // Normalize headers so "First Name", "first_name", "FIRST-NAME" all match "first name"
  const normalizeHeader = h => h.replace(/^﻿/, '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  const headers = rows[0].map(normalizeHeader)
  const get = (row, ...keys) => {
    for (const k of keys) {
      const idx = headers.indexOf(k)
      if (idx !== -1) return (row[idx] || '').trim()
    }
    return ''
  }
  return rows.slice(1).filter(r => r.some(c => c.trim())).map(row => {
    let first = get(row, 'first name', 'firstname', 'given name')
    let last  = get(row, 'last name', 'lastname', 'surname', 'family name')
    // Fall back to splitting a single "Full Name" / "Name" column
    if (!first && !last) {
      const full = get(row, 'full name', 'fullname', 'name', 'candidate name')
      if (full) {
        const parts = full.split(/\s+/)
        first = parts[0] || ''
        last = parts.slice(1).join(' ')
      }
    }
    return {
      first_name:      first,
      last_name:       last,
      headline:        get(row, 'headline'),
      location:        get(row, 'location'),
      current_title:   get(row, 'current title', 'title', 'job title'),
      current_company: get(row, 'current company', 'company', 'company name'),
      email:           get(row, 'email address', 'email', 'work email', 'e mail'),
      phone:           get(row, 'phone number', 'phone'),
      linkedin_url:    get(row, 'profile url', 'linkedin url', 'linkedin', 'linkedin profile', 'profile link', 'public profile url'),
      active_project:  get(row, 'active project'),
      notes:           get(row, 'notes'),
      feedback:        get(row, 'feedback'),
    }
  }).filter(c => c.first_name || c.last_name || c.email || c.linkedin_url)
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
      list.innerHTML = '<div class="batch-empty">No campaigns yet — create your first below.</div>'
      setNewCampaignSectionOpen(true)
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

  const linkRow = $('batchLinkJobRow')
  if (campaignData?.status === 'needs_job') {
    setBatchStatus('This campaign has no job linked yet. Link a job before enriching or drafting.', 'warn')
    if (linkRow) linkRow.style.display = 'block'
  } else {
    setBatchStatus('', '')
    if (linkRow) linkRow.style.display = 'none'
  }

  showCampaignView()
  await loadCandidatePanel(campaignId)
  // If drafts are already waiting, surface the review queue immediately
  if (_allCandidates.some(c => c.status === 'drafted')) {
    loadReviewQueue()
    showStep(4)
  } else {
    showStep(3)
  }
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
    afterParse(file.name, rows)
  }
  reader.readAsText(file)
}

function handlePastedText(text) {
  const rows = parseCsv(text)
  _parsedCandidates = csvToObjects(rows)
  afterParse('pasted data', rows)
}

function afterParse(fileName, rows = []) {
  if (_parsedCandidates.length === 0) {
    const dataRows = rows.slice(1).filter(r => r.some(c => c.trim())).length
    if (dataRows === 0) {
      setBatchStatus('The file has no candidate rows — only headers. Re-export the CSV from your LinkedIn project and try again.', 'warn')
    } else {
      setBatchStatus(`Found ${dataRows} row${dataRows !== 1 ? 's' : ''} but no usable columns. The CSV needs a name (First/Last or Full Name), email, or LinkedIn profile URL column.`, 'warn')
    }
    return
  }

  setBatchStatus('', '')  // clear any stale parse warning from a previous file

  const count = _parsedCandidates.length
  const label = `${count} candidate${count !== 1 ? 's' : ''}`
  const dropzone = $('batchDropzone')
  if (dropzone) {
    dropzone.innerHTML = `<span class="file-pill">📄 ${_esc(fileName)} — ${label}</span>`
    dropzone.classList.add('compact')
  }

  const preview = $('batchImportPreview')
  if (preview) preview.textContent = `${label} detected`

  const form = $('batchImportForm')
  if (form) form.style.display = 'block'

  // Prefill campaign name: Active Project column, else the CSV filename
  const firstProject = _parsedCandidates.find(c => c.active_project)?.active_project || ''
  const fromFile = fileName !== 'pasted data'
    ? fileName.replace(/\.csv$/i, '').replace(/[_-]+/g, ' ').trim()
    : ''
  const nameInput = $('batchCampaignName')
  if (nameInput && !nameInput.value.trim()) nameInput.value = firstProject || fromFile

  checkImportReady()
  $('batchCampaignName')?.focus()
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

  const importedCount = _parsedCandidates.length
  try {
    const result = await importCampaign({
      campaignName: name,
      jobId,
      candidates: _parsedCandidates,
    })

    if (result.creditWarning) {
      showCreditWarning(result.creditWarning.message)
    }

    _logCampaignEvent(`Imported ${importedCount} candidate${importedCount !== 1 ? 's' : ''} into "${name}"`)
    resetImportForm()
    setNewCampaignSectionOpen(false)
    if (importBtn) { importBtn.disabled = true; importBtn.textContent = 'Import candidates' }

    if (result.campaign?.id) {
      await openCampaign(result.campaign.id, result.campaign)
    } else {
      await loadCampaignsList()
    }
  } catch (e) {
    const msg = _batchErrorMessage(e, 'Import failed. Try again.')
    setBatchStatus(msg, 'error')
    _logCampaignEvent(`Import of "${name}" failed: ${msg}`)
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
      _logCampaignEvent(`Inbox check: ${newlyResponded} repl${newlyResponded > 1 ? 'ies' : 'y'} detected, marked as responded`)
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
      await runSingleEnrich(c.id)
    })
    row.querySelector('[data-draft]')?.addEventListener('click', async e => {
      e.stopPropagation()
      await runSingleDraft(c.id)
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
  const processBtn   = $('batchProcessAllBtn')
  const enrichOnlyBtn = $('batchEnrichAllBtn')
  if (processBtn) {
    if (needsEnrich > 0) {
      processBtn.disabled = false
      processBtn.textContent = `⚡ Process ${needsEnrich + needsDraft} candidate${needsEnrich + needsDraft !== 1 ? 's' : ''} — find emails & draft`
    } else if (needsDraft > 0) {
      processBtn.disabled = false
      processBtn.textContent = `✨ Draft ${needsDraft} candidate${needsDraft !== 1 ? 's' : ''}`
    } else {
      processBtn.disabled = true
      processBtn.textContent = '✓ All candidates processed'
    }
  }
  if (enrichOnlyBtn) enrichOnlyBtn.style.display = needsEnrich > 0 ? 'inline-block' : 'none'
}

// ── One-click pipeline: enrich everything, then draft everything ─────────────
async function runProcessAll() {
  if (!_activeCampaignId) return
  const processBtn = $('batchProcessAllBtn')
  if (processBtn) { processBtn.disabled = true; processBtn.textContent = '⚡ Processing…' }
  try {
    await runEnrichAll()
    await runDraftAll()
  } finally {
    updateBatchActionButtons()
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
// Note: the list is re-rendered as soon as the interim status is set, so the
// "enriching"/"drafting" badge is the progress indicator (row elements are
// rebuilt by renderCandidateList and can't be styled directly here).
async function runSingleEnrich(candidateId) {
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
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
  } catch (e) {
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'failed'
    renderCandidateList(_allCandidates)
    if (e.code === 'CREDIT_LIMIT_REACHED') {
      showCreditWarning('Credit limit reached. Upgrade to continue enriching.')
    }
  }
}

async function runSingleDraft(candidateId) {
  const idx0 = _allCandidates.findIndex(c => c.id === candidateId)
  if (idx0 !== -1) _allCandidates[idx0].status = 'drafting'
  renderCandidateList(_allCandidates)
  try {
    const result = await draftCampaignCandidate({ candidateId })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) {
      _allCandidates[idx].status = 'drafted'
      _allCandidates[idx].draft_subject = result.draft?.subject || ''
      _allCandidates[idx].draft_body = result.draft?.body || ''
      _allCandidates[idx].draft_confidence = result.draft?.confidence || 0
    }
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
    loadReviewQueue()
    showStep(4)
  } catch {
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'enriched'
    renderCandidateList(_allCandidates)
    setBatchStatus('Draft failed — please try again.', 'error')
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

  let done = 0, creditStop = false
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
        showCreditWarning('Credit limit reached. Upgrade to continue enriching.')
        creditStop = true
        break
      }
    }
    done++
    renderCandidateList(_allCandidates)
  }

  if (progressEl) progressEl.textContent = `${done} / ${toEnrich.length} checked`
  updateBatchActionButtons()
  if (enrichBtn) { enrichBtn.disabled = false; enrichBtn.textContent = '🔍 Find emails only' }
  setTimeout(() => { if (progressEl) progressEl.textContent = '' }, 3000)

  const ids = new Set(toEnrich.map(c => c.id))
  const found   = _allCandidates.filter(c => ids.has(c.id) && ['enriched','drafted'].includes(c.status)).length
  const noEmail = _allCandidates.filter(c => ids.has(c.id) && c.status === 'no_email').length
  const failed  = _allCandidates.filter(c => ids.has(c.id) && c.status === 'failed').length
  _logCampaignEvent(creditStop
    ? `Email search stopped — credit limit reached (${found} found before stopping)`
    : `Email search: ${found} found, ${noEmail} no email, ${failed} failed`)
}

// ── Batch draft all ────────────────────────────────────────────────────────────
async function runDraftAll() {
  if (!_activeCampaignId) return
  const toDraft = _allCandidates.filter(c => c.status === 'enriched')
  if (toDraft.length === 0) return
  const myRunId = ++_batchRunId

  const progressEl = $('batchDraftProgress')

  let done = 0, drafted = 0
  for (const candidate of toDraft) {
    if (_batchRunId !== myRunId) break
    if (progressEl) progressEl.textContent = `${done} / ${toDraft.length} drafted…`
    const idx0 = _allCandidates.findIndex(c => c.id === candidate.id)
    if (idx0 !== -1) { _allCandidates[idx0].status = 'drafting'; renderCandidateList(_allCandidates) }
    try {
      const result = await draftCampaignCandidate({ candidateId: candidate.id })
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (idx !== -1) {
        _allCandidates[idx].status = 'drafted'
        _allCandidates[idx].draft_subject = result.draft?.subject || ''
        _allCandidates[idx].draft_body = result.draft?.body || ''
        _allCandidates[idx].draft_confidence = result.draft?.confidence || 0
      }
      drafted++
    } catch {
      // skip failed drafts — revert so the candidate can be retried
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (idx !== -1) _allCandidates[idx].status = 'enriched'
    }
    done++
    renderCandidateList(_allCandidates)
  }

  if (progressEl) progressEl.textContent = `${done} / ${toDraft.length} drafted`
  updateBatchActionButtons()
  setTimeout(() => { if (progressEl) progressEl.textContent = '' }, 3000)
  _logCampaignEvent(`Drafted ${drafted} of ${toDraft.length} candidate${toDraft.length !== 1 ? 's' : ''}`)

  if (drafted > 0) {
    loadReviewQueue()
    showStep(4)
  }
}

// ── Review queue (one-at-a-time, Step 4) ─────────────────────────────────────
// Every review action (Gmail/Outlook/Skip) moves the candidate out of 'drafted',
// so the queue always shows the first remaining draft. (Indexing into the
// shrinking filtered list used to skip every other candidate.)
function loadReviewQueue() {
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

  const c = drafted[0]
  if (counter) counter.textContent = `${drafted.length} draft${drafted.length !== 1 ? 's' : ''} left to review`

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
  renderCurrentReview()
  renderCandidateList(_allCandidates)
  updateBatchActionButtons()
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
    'emailfinder':   ['info-sm', 'EmailFinder'],
    'generect':      ['info-sm', 'Generect'],
    'fullenrich_v2': ['warn-sm', 'FullEnrich'],
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

let _creditWarnTimer = null
function showCreditWarning(message) {
  const el = $('batchCreditWarning')
  const msgEl = $('batchCreditWarningMsg')
  if (!el || !msgEl) return
  msgEl.textContent = message
  el.style.display = 'block'
  // Upgrade button is wired once in initBatch; re-showing must not stack
  // listeners, and an old hide-timer must not dismiss this fresh warning early.
  clearTimeout(_creditWarnTimer)
  _creditWarnTimer = setTimeout(() => { el.style.display = 'none' }, 12000)
}

// ── Init ───────────────────────────────────────────────────────────────────────
export function initBatch() {
  $('batchDrawerClose')?.addEventListener('click', closeBatchDrawer)
  $('batchBackToCampaigns')?.addEventListener('click', showHome)
  $('batchCreditUpgradeBtn')?.addEventListener('click', () => openUpgradePage())

  $('batchNewCampaignBtn')?.addEventListener('click', () => {
    const section = $('batchNewCampaignSection')
    const open = section && section.style.display !== 'none'
    setNewCampaignSectionOpen(!open)
    if (!open) section?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })

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

  $('batchProcessAllBtn')?.addEventListener('click', async () => {
    if (!_activeCampaignId) { setBatchStatus('Select a campaign first.', 'warn'); return }
    await runProcessAll()
  })

  $('batchEnrichAllBtn')?.addEventListener('click', async () => {
    if (!_activeCampaignId) { setBatchStatus('Select a campaign first.', 'warn'); return }
    await runEnrichAll()
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
