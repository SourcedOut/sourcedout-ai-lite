// ─── background.js ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_URL') {
    fetch(msg.url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
      .then(r => r.text())
      .then(html => sendResponse({ ok: true, html }))
      .catch(err => sendResponse({ ok: false, error: err.message }))
    return true
  }
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url        = tab.url ?? ''
  const authPageUrl = chrome.runtime.getURL('auth.html')

  if (!url.startsWith(authPageUrl)) return
  if (changeInfo.status !== 'complete') return

  console.log('[SourcedOut] Auth tab detected — auth-callback.js will handle token.')

  setTimeout(() => {
    chrome.tabs.get(tabId, t => {
      if (chrome.runtime.lastError) return
      if (t && t.url?.startsWith(authPageUrl)) {
        chrome.tabs.remove(tabId).catch(() => {})
      }
    })
  }, 5000)
})
