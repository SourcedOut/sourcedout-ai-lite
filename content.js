chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'scrape') return false
  ;(async () => {
    const full_name = scrapeFullName()
    const { company: current_company, source: current_company_source } = await scrapeCurrentCompanyRobust()
    sendResponse({
      linkedin_url: window.location.href.split('?')[0],
      full_name,
      current_company,
      current_company_source,
      name_scrape_failed: !full_name,
    })
  })()
  return true // async sendResponse
})

// Extract the candidate's full name from the LinkedIn profile DOM.
function scrapeFullName() {
  try {
    const candidates = []
    const selectors = [
      // ─── Standard public profile (desktop & mobile) ──────────────────
      'h1.text-heading-xlarge',
      'h1.inline.t-24',
      'section.pv-top-card h1',
      'section.artdeco-card h1',
      '.ph5 h1',
      'main h1',
      // ─── Recruiter ───────────────────────────────────────────────────
      '[data-test-row-lockup-full-name]',
      '.profile-info h1',
      '.topcard__profile-name',
      '.profile-topcard-person-entity__name',
      // ─── Sales Navigator ─────────────────────────────────────────────
      '[data-anonymize="person-name"]',
      '#profile-card-section h1',
      // ─── Generic last-ditch ──────────────────────────────────────────
      'h1',
    ]
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel)
      for (const el of els) {
        const txt = sanitize(el?.textContent)
        if (isPlausibleName(txt)) candidates.push(txt)
      }
    }
    // Fallback: parse from <title> like "Jane Doe | LinkedIn"
    const t = sanitize(document.title?.split('|')[0]?.split('-')[0])
    if (isPlausibleName(t) && !/linkedin/i.test(t)) candidates.push(t)
    // Fallback: og:title meta
    const og = sanitize(document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.split('|')[0])
    if (isPlausibleName(og) && !/linkedin/i.test(og)) candidates.push(og)

    const unique = [...new Set(candidates)]
    unique.sort((a, b) => scoreNameQuality(b) - scoreNameQuality(a))
    return unique[0] || null
  } catch {}
  return null
}

function sanitize(s) {
  if (!s) return ''
  return String(s).replace(/\s+/g, ' ').trim()
}

function isPlausibleName(s) {
  if (!s || s.length < 2 || s.length > 120) return false
  if (/linkedin|sign in|join now/i.test(s)) return false
  if (!/\p{L}/u.test(s)) return false
  return true
}

function scoreNameQuality(name) {
  const text = sanitize(name)
  if (!text) return 0
  const parts = text.split(/\s+/).filter(Boolean)
  let score = text.length
  if (parts.length >= 2) score += 20
  if (parts.some((part) => /^[A-Z]\.$/.test(part) || /^[A-Za-z]\.?$/.test(part))) score -= 25
  if (/\b[A-Z]\.$/.test(text)) score -= 15
  if (/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(text)) score += 20
  return score
}

// Robust scraper: waits for LinkedIn's lazy-loaded experience section,
// tries multiple selectors, and reports which source produced the value.
async function scrapeCurrentCompanyRobust() {
  // 1. JSON-LD first — present on most LinkedIn profiles, most reliable.
  const fromJsonLd = scrapeFromJsonLd()
  if (fromJsonLd) return { company: fromJsonLd, source: 'json-ld', confidence: 0.90 }

  // 2. Try synchronous DOM selectors (top card may already be there).
  const sync = scrapeCurrentCompanySync()
  if (sync.company) return sync

  // 3. Trigger lazy-load: scroll #experience into view and yield frames.
  try {
    const exp = document.querySelector('#experience') ||
                document.querySelector('section[id*="experience" i]')
    if (exp && typeof exp.scrollIntoView === 'function') {
      exp.scrollIntoView({ block: 'center', behavior: 'instant' })
    }
  } catch {}

  // 4. Poll up to 3000ms for any company signal to appear.
  // Checks BOTH top-card signals AND the experience section li — recruiter/executive
  // profiles often have no company link in the top card (keyword-heavy headlines
  // with no "at Company"), so the experience section is the primary source for them.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150))
    const ready =
      document.querySelector('button[aria-label^="Current company:" i]') ||
      document.querySelector('#experience li .t-bold span[aria-hidden="true"]') ||
      document.querySelector('#experience li a[href*="/company/"]') ||
      document.querySelector('a[href*="/company/"][data-field="experience_company_logo"]') ||
      document.querySelector('.pv-top-card--experience-list a[href*="/company/"]') ||
      document.querySelector('[data-view-name="profile-component-entity"] a[href*="/company/"]')
    if (ready) break
  }

  // 5. Scroll back to top so top-card company links are in DOM.
  try { window.scrollTo({ top: 0, behavior: 'instant' }) } catch {}
  // Poll up to 600ms for the top-card to re-render rather than sleeping a flat
  // 100ms — on slow connections the old fixed wait fired before the top-card DOM
  // had repopulated, so the re-check missed the company and fell through to the
  // (less reliable) experience-section selectors.
  {
    const topDeadline = Date.now() + 600
    while (Date.now() < topDeadline) {
      await new Promise(r => setTimeout(r, 100))
      if (document.querySelector('button[aria-label^="Current company:" i]') ||
          document.querySelector('a[href*="/company/"][data-field="experience_company_logo"]') ||
          document.querySelector('.pv-top-card--experience-list a[href*="/company/"]')) {
        break
      }
    }
  }

  // 6. Re-run sync scraper after waiting.
  const after = scrapeCurrentCompanySync()
  if (after.company) return after

  // 7. Last-ditch JSON-LD recheck (LinkedIn sometimes injects it late).
  const lateJsonLd = scrapeFromJsonLd()
  if (lateJsonLd) return { company: lateJsonLd, source: 'json-ld-late', confidence: 0.90 }

  // 8. Broad fallback: any /company/ link anywhere on the page (first plausible one).
  const broadFallback = scrapeBroadCompanyLink()
  if (broadFallback) return { company: broadFallback, source: 'broad-link', confidence: 0.50 }

  return { company: null, source: null, confidence: 0 }
}

function scrapeFromJsonLd() {
  try {
    const blocks = document.querySelectorAll('script[type="application/ld+json"]')
    for (const b of blocks) {
      let json
      try { json = JSON.parse(b.textContent || '') } catch { continue }
      const items = Array.isArray(json) ? json : (json['@graph'] || [json])
      for (const item of items) {
        // Person.worksFor.name
        const wf = item?.worksFor
        if (wf) {
          const arr = Array.isArray(wf) ? wf : [wf]
          for (const w of arr) {
            const name = sanitize(w?.name)
            if (isPlausibleCompany(name)) return name
          }
        }
        // Nested member/author
        const member = item?.member || item?.author
        if (member?.worksFor?.name) {
          const name = sanitize(member.worksFor.name)
          if (isPlausibleCompany(name)) return name
        }
        // alumniOf / affiliation intentionally NOT used as a company fallback:
        // alumniOf is the person's *university*, not their employer. Returning it
        // here sent the waterfall hunting at a school domain (wasting the cheap
        // steps and falling through to the paid FullEnrich call). Current employer
        // must come from worksFor only.
      }
    }
  } catch {}
  return null
}

function scrapeCurrentCompanySync() {
  try {
    // 1. Top-card "Current company:" aria-label button (HIGHEST PRIORITY — hard-return if found)
    const currentBtn = document.querySelector('button[aria-label^="Current company:" i]')
    if (currentBtn) {
      const m = currentBtn.getAttribute('aria-label').match(/Current company:\s*(.+)/i)
      if (m && m[1]) {
        const co = sanitize(m[1])
        if (isPlausibleCompany(co)) return { company: co, source: 'aria-label', confidence: 0.95 }
      }
      const txt = sanitize(currentBtn.textContent)
      if (isPlausibleCompany(txt)) return { company: txt, source: 'aria-label-text', confidence: 0.95 }
      // Hard-return: if button exists but extraction failed, don't fall through to weaker selectors
      // that may pick up past employers from the experience section.
      return { company: null, source: 'aria-label-failed', confidence: 0 }
    }

    // 2. Top-card company logo link with data-field attribute (classic layout)
    const logoLink = document.querySelector('a[href*="/company/"][data-field="experience_company_logo"]') ||
                     document.querySelector('section.pv-top-card a[href*="/company/"]')
    if (logoLink) {
      const aria = sanitize(logoLink.getAttribute('aria-label') || '')
      if (isPlausibleCompany(aria)) return { company: aria, source: 'topcard-logo', confidence: 0.85 }
      const visible = sanitize(logoLink.textContent)
      if (isPlausibleCompany(visible)) return { company: visible, source: 'topcard-logo-text', confidence: 0.85 }
    }

    // 3. 2024/2025 LinkedIn top-card experience list (right panel with company logos)
    const topCardExpSelectors = [
      '.pv-top-card--experience-list a[href*="/company/"]',
      '.pv-top-card-v2-ctas a[href*="/company/"]',
      '.pv-top-card--experience-list-item a[href*="/company/"]',
      '.ph5 .mt2 a[href*="/company/"]',
      '.pv-text-details__right-panel a[href*="/company/"]',
      // 2025 unified layout — queried individually to check activity section
      '[data-view-name="profile-component-entity"] a[href*="/company/"]',
      '.pvs-entity a[href*="/company/"]',
      // Top-intro section
      '.pv-top-card--about-the-profile a[href*="/company/"]',
    ]
    for (const sel of topCardExpSelectors) {
      // For broad selectors that can match activity cards, check ALL matches and
      // take the first one that is NOT inside an activity/feed section.
      const els = document.querySelectorAll(sel)
      let el = null
      for (const candidate of els) {
        // Skip activity/feed cards AND the Education section — these broad
        // selectors also match education entities, which would return the
        // person's university as their employer.
        if (!isInActivitySection(candidate) && !isInEducationSection(candidate)) { el = candidate; break }
      }
      if (!el) continue
      const aria = sanitize(el.getAttribute('aria-label') || '')
      if (isPlausibleCompany(aria)) return { company: aria, source: 'topcard-2025', confidence: 0.80 }
      // Get text from child span (LinkedIn often hides text in aria-hidden spans)
      const span = el.querySelector('span[aria-hidden="true"]') || el.querySelector('span')
      const spanTxt = sanitize(span?.textContent)
      if (isPlausibleCompany(spanTxt)) return { company: spanTxt, source: 'topcard-2025-span', confidence: 0.80 }
      // Derive name from URL slug — layout-stable even when DOM text is garbled
      const slugName = companyFromHref(el.getAttribute('href') || el.href || '')
      if (isPlausibleCompany(slugName)) return { company: slugName, source: 'topcard-2025-slug', confidence: 0.80 }
      const txt = sanitize(el.textContent)
      if (isPlausibleCompany(txt)) return { company: txt, source: 'topcard-2025-text', confidence: 0.80 }
    }

    // 4. Experience section — first list item (most recent role)
    const expSection = document.querySelector('#experience')?.closest('section') ||
                       document.querySelector('section[data-view-name*="experience" i]')
    if (expSection) {
      const firstItem = expSection.querySelector('li')
      if (firstItem) {
        // Try company link inside the first experience item
        const expLink = firstItem.querySelector('a[href*="/company/"]')
        if (expLink) {
          const aria = sanitize(expLink.getAttribute('aria-label') || '')
          if (isPlausibleCompany(aria)) return { company: aria, source: 'experience-link', confidence: 0.85 }
          const span = expLink.querySelector('span[aria-hidden="true"]') || expLink.querySelector('span')
          const spanTxt = sanitize(span?.textContent)
          if (isPlausibleCompany(spanTxt)) return { company: spanTxt, source: 'experience-link-span', confidence: 0.85 }
          // Slug fallback — always clean regardless of DOM changes
          const slugName = companyFromHref(expLink.getAttribute('href') || expLink.href || '')
          if (isPlausibleCompany(slugName)) return { company: slugName, source: 'experience-link-slug', confidence: 0.85 }
        }
        const subtitle = firstItem.querySelector('.t-14.t-normal span[aria-hidden="true"]')
        if (subtitle) {
          const co = sanitize(subtitle.textContent).split('·')[0].trim()
          if (isPlausibleCompany(co)) return { company: co, source: 'experience-subtitle', confidence: 0.85 }
        }
        const bold = firstItem.querySelector('.t-bold span[aria-hidden="true"]')
        if (bold) {
          const co = sanitize(bold.textContent)
          if (isPlausibleCompany(co)) return { company: co, source: 'experience-bold', confidence: 0.85 }
        }
      }
    }

    // 5. og:description meta — "Title at Company. Location..."
    const og = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || ''
    const atMatch = og.match(/(?:\s+at\s+|[@]\s*)([^.|·@]+?)(?:\.|·|\||$)/i)
    if (atMatch && atMatch[1]) {
      const co = sanitize(atMatch[1])
      if (isPlausibleCompany(co)) return { company: co, source: 'og-description', confidence: 0.75 }
    }

    // 6. Top-card subtitle "Title at Company" (headline field)
    const subtitleSelectors = [
      '.text-body-medium.break-words',
      '.pv-top-card--list.pv-top-card--list-bullet .t-16',
      '.ph5 .text-body-medium',
    ]
    for (const sel of subtitleSelectors) {
      const el = document.querySelector(sel)
      if (!el) continue
      const m = sanitize(el.textContent).match(/(?:\bat\s+|[@]\s*)(.+)$/i)
      if (m && m[1]) {
        const co = sanitize(m[1]).split('|')[0].split('·')[0].replace(/[@].*$/, '').trim()
        if (isPlausibleCompany(co)) return { company: co, source: 'topcard-subtitle', confidence: 0.70 }
      }
    }

    // 7a. <meta name="description"> — LinkedIn populates this separately from
    // og:description and often lists the employer even when the headline is
    // a keyword-branding line with no "at Company" (common for recruiters and
    // executives). Try both "at Company" and a parenthetical "(Company)" pattern.
    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || ''
    if (metaDesc) {
      const metaAt = metaDesc.match(/(?:\s+at\s+|[@]\s*)([^.|·@\n]+?)(?:\.|·|\||$)/i)
      if (metaAt && metaAt[1]) {
        const co = sanitize(metaAt[1])
        if (isPlausibleCompany(co)) return { company: co, source: 'meta-description', confidence: 0.70 }
      }
    }

    // 7. Any visible company name text adjacent to current role badge
    const badgeCandidates = [
      ...Array.from(document.querySelectorAll('[aria-label*="current" i] ~ * a[href*="/company/"]')),
      ...Array.from(document.querySelectorAll('.pv-entity__secondary-title a[href*="/company/"]')),
    ]
    for (const currentRoleBadge of badgeCandidates) {
      if (isInActivitySection(currentRoleBadge)) continue
      const txt = sanitize(currentRoleBadge.textContent)
      if (isPlausibleCompany(txt)) return { company: txt, source: 'current-role-badge', confidence: 0.75 }
    }

  } catch {}
  return { company: null, source: null, confidence: 0 }
}

// Returns true if `el` is nested inside LinkedIn's activity/feed/post sections.
// Used by multiple scrapers to avoid picking up companies mentioned in reposts or articles.
function isInActivitySection(el) {
  const activitySelectors = [
    '.feed-shared-update-v2',
    '[data-id^="urn:li:activity"]',
    '.social-details-social-activity',
    '#recent-activity-top-card',
    '[data-view-name="main-feed-activity"]',
    '.profile-creator-shared-feed-update__container',
    '.pv-recent-activity-section',
    '[data-view-name="profile-component-entity-activity"]',
    '.artdeco-list .update-components-actor',
    // The "Recent Activity" panel and its individual post cards:
    '.pv-recent-activity-section-v2',
    '[data-view-name="profile-component-entity"][class*="activity"]',
    '.profile-creator-shared-content-update__container',
    // v40.3: Add Featured section (where posts/media are showcased)
    '[data-view-name="profile-component-entity-featured"]',
    '.pv-featured-entity',
    '.profile-creator-shared-feed-update',
    // Activity tab and posts
    '.scaffold-finite-scroll',
    '[data-view-name*="activity"]',
    '[data-view-name*="post"]',
  ]
  return activitySelectors.some(sel => el.closest(sel))
}

// Returns true if `el` is nested inside the profile's Education section.
// Used so broad entity selectors don't return a university as the employer.
function isInEducationSection(el) {
  const eduSection = document.querySelector('#education')?.closest('section') ||
                     document.querySelector('section[data-view-name*="education" i]')
  return !!(eduSection && eduSection.contains(el))
}

// Last-resort: scan all /company/ links on the page, score by position proximity
// to top of page and text plausibility, return the best candidate.
// Excludes links inside the activity/feed section to avoid grabbing companies
// mentioned in posts (e.g. "[EX: Amazon]" profiles with Meta mentions in their feed).
function scrapeBroadCompanyLink() {
  try {
    const links = Array.from(document.querySelectorAll('a[href*="/company/"]'))
    const candidates = []
    
    // Identify the first experience list item to avoid picking up past employers
    const expSection = document.querySelector('#experience')?.closest('section') ||
                       document.querySelector('section[data-view-name*="experience" i]')
    const firstExpItem = expSection?.querySelector('li')
    
    // v40.3: STRICT FILTERING - Only consider links from trusted locations
    // v40.3.1: Added more trusted selectors to cover legitimate company locations
    const trustedSelectors = [
      '.pv-top-card',                    // Top card area
      '#experience',                      // Experience section
      '[data-view-name="profile-component-entity"]', // Entity components
      '.pv-text-details',                // Profile text details (where headline lives)
      'section.artdeco-card',            // LinkedIn card sections (not activity)
      '.ph5',                            // Main profile column
    ]
    
    for (const link of links) {
      const href = link.getAttribute('href') || ''
      // Skip navigation/footer links
      if (href.includes('/company/add') || href.includes('/company/create')) continue
      
      // v41.3: HARD filter — a link must live inside a trusted profile region.
      // Previously this was only a score bonus, so a /company/ link from the
      // right-rail ("More profiles", "Explore Premium profiles", "People also
      // viewed") or an ad could still win when no trusted link was found, picking
      // a company the person doesn't work at (e.g. "Ted Conferences"). A WRONG
      // company poisons the whole waterfall (wrong domain → false/low-confidence
      // emails, wasted API spend), so it is strictly worse than returning none.
      // Reject any link outside a trusted section outright.
      let isInTrustedSection = trustedSelectors.some(selector => {
        const containers = document.querySelectorAll(selector)
        return Array.from(containers).some(c => c.contains(link))
      })
      if (!isInTrustedSection) {
        console.log('[scrapeBroadCompanyLink] Skipping link outside trusted section:', link.textContent?.slice(0, 30))
        continue
      }

      // Skip links inside activity/feed sections — these refer to companies in posts
      if (isInActivitySection(link)) {
        console.log('[scrapeBroadCompanyLink] Skipping link in activity section:', link.textContent?.slice(0, 30))
        continue
      }
      
      // Skip any /company/ link inside #experience that is NOT the first <li>
      if (expSection && link.closest('li') && link.closest('li') !== firstExpItem) {
        continue
      }
      
      const aria = sanitize(link.getAttribute('aria-label') || '')
      // Prefer aria-hidden spans (contain just the company name, not job metadata)
      const span = link.querySelector('span[aria-hidden="true"]')
      const spanTxt = sanitize(span?.textContent || '')
      // Slug from href — layout-stable; use when aria and span are both absent
      // (2025 LinkedIn dropped aria-labels and aria-hidden spans on company links)
      const slugName = (!aria && !spanTxt) ? companyFromHref(href) : null
      // Raw text fallback — clean off job-type suffixes before using
      const rawTxt = sanitize(link.textContent)
      const cleanedTxt = cleanCompanyText(rawTxt)
      // Priority: aria → aria-hidden span → URL slug → cleaned text
      const txt = aria || spanTxt || slugName || cleanedTxt
      if (!isPlausibleCompany(txt)) continue
      
      // Score by: trusted section bonus + has aria-label + aria-hidden span + slug + DOM position
      const rect = link.getBoundingClientRect()
      const trustedBonus = isInTrustedSection ? 200 : 0  // v40.3.1: Bonus for trusted sections
      const score = trustedBonus + (aria ? 100 : 0) + (spanTxt ? 50 : 0) + (slugName ? 40 : 0) + Math.max(0, 500 - rect.top)
      candidates.push({ txt, score })
    }
    if (!candidates.length) return null
    candidates.sort((a, b) => b.score - a.score)
    return candidates[0].txt
  } catch {}
  return null
}

// Derive a clean company name from a /company/slug/ URL.
// "/company/verily/" → "Verily"  "/company/verily-life-sciences/" → "Verily Life Sciences"
// This is the most layout-stable signal: LinkedIn has used /company/<slug>/ for years.
function companyFromHref(href) {
  if (!href) return null
  const m = href.match(/\/company\/([a-z0-9][a-z0-9-]{0,60}[a-z0-9])(?:\/|$)/i)
  if (!m) return null
  const slug = m[1]
  if (/^(add|create|setup|view|edit|login|home)$/i.test(slug)) return null
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// Strip LinkedIn job-metadata suffixes that bleed into anchor text:
// "NexHealthFull-time · 5 yrs 2 mos" → "NexHealth"
// "Technical Recruiter at VerilyVerilyJun 2024 – Present" → "Verily"
function cleanCompanyText(s) {
  if (!s) return ''
  return s
    .split(/\s*·\s*/)[0]           // drop "· 5 yrs 2 mos" etc.
    .replace(/\s*(Full-time|Part-time|Contract|Freelance|Self-employed|Internship|Temporary|Volunteer|Apprenticeship)\b.*/i, '')
    .replace(/\s*\d+\s*(yr|mo|year|month)s?.*/i, '')  // drop "5 yrs 2 mos" (no space before digit)
    .replace(/\s*\|.*$/, '')                           // drop "| tagline / ex-company" suffixes
    .replace(/\s*\d[\d,]*\s*(followers?|connections?|employees?).*/i, '')  // drop "10,416 followers2w •"
    .replace(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}.*/gi, '')  // drop "Jun 2024 – Present" (with or without leading space)
    .replace(/^.+?\bat\s+/i, '')   // drop "Title at " prefix — "Technical Recruiter at " → ""
    .replace(/([A-Za-z]{3,})\1/g, '$1')  // deduplicate "VerilyVerily" → "Verily" (DOM span concatenation artifact)
    .trim()
}

function isPlausibleCompany(s) {
  if (!s || s.length < 2 || s.length > 200) return false
  // Exact-match blocklist (whole string).
  if (/^(linkedin|self[\s-]?employed|freelance|freelancer|unemployed|independent|independent contractor|n\/?a|none)$/i.test(s)) return false
  // Word-boundary blocklist — catches slug-derived variants that the exact match
  // misses, e.g. companyFromHref('/company/self-employed-1234/') → "Self Employed 1234".
  if (/\b(self[\s-]?employed|freelancer?|unemployed)\b/i.test(s)) return false
  if (!/\p{L}/u.test(s)) return false
  return true
}
