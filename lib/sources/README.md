# LME Data Source Module

`lib/sources/lme.ts` — LME (London Metal Exchange) end-of-day data fetcher.

## Overview

Fetches official daily prices and warehouse stock reports for six LME base metals:
copper, aluminium, zinc, nickel, lead, tin.

## Run standalone

```bash
npx tsx lib/sources/lme.ts
```

Prints a full `LmeFetchResult` JSON to stdout. Exits `0` on success/partial, `1` on failure.

```bash
# Pipe to file for inspection
npx tsx lib/sources/lme.ts 2>&1 | tee lme-output.json
```

---

## Architecture

The LME publishes daily XLSX download files indexed via an internal Sitecore CMS API:

```
GET https://www.lme.com/api/Lists/DownloadLinks/{GUID}?currentPage=0

Response shape:
{
  "content_items": [
    {
      "Url": "/-/media/Files/Market-data/Reports-and-data/Daily-Official-Prices/2024/04/23/daily-official-prices.xlsx",
      "Title": "Daily Official Prices 23 April 2024"
    }
  ]
}
```

`discoverDownloadUrl(guid)` hits this endpoint, extracts `content_items[0].Url`, prepends
`https://www.lme.com`, and returns the full download URL.

`fetchAndParseXlsx(url)` downloads the XLSX binary and uses the `xlsx` package to parse it
into rows. Both sheets of a multi-sheet workbook are merged.

---

## GUIDs Discovered

Cloudflare currently blocks server-side access to the LME website (see below).
The GUIDs below were identified via Wayback Machine CDX API — actual report type for each
GUID is unconfirmed because API responses were also Cloudflare-blocked at capture time.

| GUID | Source | Report Type |
|------|--------|-------------|
| `02E29CA4-5597-42E7-9A22-59BB73AE8F6B` | je-suis-tm/web-scraping Python script | Commitments of Traders (COTR) — confirmed |
| `353FB333-E30A-4C13-AC97-4FF0ED95A560` | Wayback Machine CDX, Jan 2021 capture | Unknown — likely non-ferrous metals report |
| `40FE7AB3-7357-41D9-A31B-3E0BA2803AAA` | Wayback Machine CDX, Oct 2018 (26+ pages) | Unknown — likely monthly or historical |

**To obtain the correct GUIDs for daily prices and warehouse stocks:**

1. Open Chrome DevTools → Network tab
2. Navigate to `https://www.lme.com/market-data/reports-and-data`
3. Filter network requests for `DownloadLinks`
4. Note the GUID in the URL for each report type
5. Set `PRICES_GUID` and `STOCKS_GUID` in `lme.ts`

Verify each GUID works:
```bash
# (requires a valid Cloudflare session cookie from a browser)
curl -b "cf_clearance=<VALUE>" \
  "https://www.lme.com/api/Lists/DownloadLinks/%7BGUID-HERE%7D?currentPage=0"
```

---

## XLSX Structure (expected)

Based on LME data documentation and historical report samples:

### Daily Official Prices XLSX

- Sheet: `"Official"` (or similar)
- Columns: `Metal | Cash Buyer | Cash Seller | 3M Buyer | 3M Seller`
- May also have: `Date | Commodity | Cash | 3 Month`
- All prices in **USD per metric tonne**
- One row per metal × contract type

The parser handles both consolidated (single sheet) and split (per-metal sheet) formats.
It takes the mid-price of Buyer/Seller pairs, or uses the single value if only one is present.
Skips non-cash/3M prompt dates (15-day, Dec1, Dec2, Dec3).

### Daily Warehouse Stocks XLSX

- Sheet: `"Stocks"` (or per-metal sheets)
- Columns: `Metal | On Warrant | Cancelled Warrants | Total`
- Units: **metric tonnes** (not kt — confirmed from LME documentation)
- One row per metal

---

## Cloudflare Blocking — Current Status

As of April 2026, `lme.com` uses Cloudflare's **managed challenge** (JS-execution test).
This cannot be bypassed by any server-side HTTP client (Node.js, Deno, Python requests).
All paths return a 403 + Cloudflare HTML challenge page:

| Path | Status |
|------|--------|
| `https://www.lme.com/api/Lists/DownloadLinks/*` | 403 Cloudflare |
| `https://www.lme.com/market-data/reports-and-data` | 403 Cloudflare |
| `https://www.lme.com/metals/non-ferrous/lme-*` | 403 Cloudflare |
| `https://www.lme.com/api/sitecore/search/*` | 403 Cloudflare |
| Sitemap (`sitemap.xml`) | ✅ accessible |

The module detects Cloudflare responses (HTML containing "Just a moment" / "challenges.cloudflare.com")
and returns `status: 'failed'` with a detailed reason string.

**Paths to unblock (in order of preference):**

1. **Supabase IP whitelisting**: Contact LME to whitelist Supabase Edge Function IP ranges
2. **Cloudflare session cookie injection**: Provide `cf_clearance` cookie via env var (requires periodic refresh from a real browser)
3. **LME XML feed subscription**: $2,565/year for the official next-day XML API — no Cloudflare barrier
4. **Headless browser layer**: Add a Playwright/Puppeteer step to solve the challenge and extract cookies

---

## Failure Modes

| Scenario | Module behaviour |
|----------|-----------------|
| Cloudflare blocks all LME requests | `status: 'failed'`, reason string explains cause, `errors[]` details each path |
| GUID has changed / report moved | `discoverDownloadUrl()` returns null, falls back to page-scraping |
| XLSX download succeeds but columns renamed | `parsePriceRows()` skips unrecognised metals; missing metals logged to `errors[]` |
| One metal missing from XLSX | `status: 'partial'`, metal listed in `errors[]` |
| All 6 metals parsed from both reports | `status: 'success'` |
| Network timeout | `fetchWithRetry` retries once after 2s, then returns null/throws |
| Unexpected exception in top-level | Caught, returned as `status: 'failed'` — never propagates |

---

## Session C parallel-build lane

This module is Session C in a 7-stream parallel build. It must NOT touch:
- `/supabase/**` (Session A)
- `/app/**`, `/components/**` (Session B)
- `lib/sources/yahoo.ts`, `lib/sources/rss.ts` (Sessions D, E)
- Root config files
- `lib/mock-data.ts`, `lib/metals.ts`, `lib/utils.ts`

When Session F (Wave 2) imports this module into a Supabase Edge Function, it should
call `fetchLmeData()` and check `result.status`. If `'failed'`, fall through to
`fetchYahooPrimary()` from `lib/sources/yahoo.ts`.
