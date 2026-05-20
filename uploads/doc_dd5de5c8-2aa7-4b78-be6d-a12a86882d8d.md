<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# Should I say anything else with the code to make sure it makes the changes properly?

Yes — give Softgen this prompt along with the code:

***

**Prompt to paste into Softgen:**

> Replace the entire contents of `extension/ui/popup.html` with the code I'm providing. Do not merge, diff, or partially apply — do a full file replacement. Specific changes that were made:
>

```
> 1. **Branding** — Every instance of "OutreachAI" has been renamed to "SourcedOut AI" (title tag, login screen `<h2>`, and main app `<h1>`)
```

> 2. **Header structure** — The header is now split into two rows: `header-row-1` contains the logo + icon buttons (gear + magnifier), and `header-row-2` contains only the three tabs (Outreach / Job / Campaigns). Do not collapse these back into a single row.
> 3. **Theme toggle removed from main view** — There is no light/dark toggle anywhere on the main tab. It lives exclusively inside the **Settings panel** under the "Appearance" section, which is opened via the gear icon.
> 4. **Do not add any new elements** not present in this file — no extra buttons, no theme toggle in the header, no reorganization of tabs.

```
> 5. The `popup.js` script reference at the bottom (`<script src="../popup.js" type="module"></script>`) must be preserved exactly as-is.
```


***

That instruction set prevents Softgen from "helpfully" re-adding the theme toggle to the header, collapsing the two-row header back to one, or doing a partial merge that misses the branding rename.

