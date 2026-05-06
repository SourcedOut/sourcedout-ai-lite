# SourcedOut Chrome Extension

AI-powered outreach for recruiters and talent sourcers.

## Locked extension ID

```
oekidhmjmaknllpbdagiffepogjgkjdj
```

The `"key"` field in `manifest.json` pins this ID permanently. Don't remove it
— it's what keeps the Supabase OAuth redirect URL stable across machines and
across the Chrome Web Store transition.

## Folder layout

```
extension/
├── manifest.json          MV3 manifest (contains the locked "key")
├── background.js          Service worker
├── content.js             LinkedIn content script
├── batch.js               Bulk operations
├── popup.js               Popup logic
├── auth.html              OAuth callback landing page
├── auth-callback.js       OAuth token-exchange + session save
├── config.js              Supabase URL/key, Stripe price IDs, tier limits
├── core/
│   ├── auth.js            Sign-in / sign-out / refresh
│   ├── credits.js         Credit balance + deduction
│   └── api.js             REST wrapper with auth retry
├── ui/
│   └── popup.html         Popup markup
└── icons/                 16 / 32 / 128 px PNGs
```

## Update flow

1. Edit files in this folder via Lovable.
2. The download page (`/`) regenerates `public/sourcedout-extension.zip` on
   each release.
3. Download → unzip → drop into your existing extension folder → click
   **reload** in `chrome://extensions`.

## Publishing to the Chrome Web Store

When ready:
1. Bump `version` in `manifest.json`.
2. Zip the contents of this folder (not the folder itself).
3. Upload at https://chrome.google.com/webstore/devconsole.

Because the `"key"` field is set, the published store ID will match the
unpacked ID — users won't lose their session, and Supabase config stays valid.
