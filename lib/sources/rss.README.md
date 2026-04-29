# rss.ts — Metals News Aggregator

Self-contained TypeScript module that fetches from 13 metals-industry sources,
deduplicates, coarse-filters, and returns clean `NewsItem` objects.

**Run standalone:**
```bash
npx tsx lib/sources/rss.ts
```

**Import from Edge Function (Session G, Wave 2):**
```typescript
import { fetchAllNews, type RssFetchResult } from '@/lib/sources/rss';
```

---

## The 13 Sources

| # | Name | Type | URL | Notes |
|---|------|------|-----|-------|
| 1 | Mining.com | RSS | `https://www.mining.com/feed/` | General mining news |
| 2 | Kitco Mining | RSS | `https://www.kitco.com/news/category/mining/rss` | Kitco's mining category |
| 3 | Northern Miner | RSS | `https://www.northernminer.com/feed/` | Canadian industry publication |
| 4 | Mining Technology | RSS | `https://www.mining-technology.com/feed` | Technology focus |
| 5 | Engineering & Mining Journal | RSS | `https://www.e-mj.com/feed/` | Technical trade press |
| 6 | Canadian Mining Journal | RSS | `https://www.canadianminingjournal.com/feed/` | Canadian focus |
| 7 | Mining Weekly | RSS | `https://www.miningweekly.com/rss` | **Fragile** — URL occasionally restructured |
| 8 | Hellenic Shipping Commodities | RSS | `https://www.hellenicshippingnews.com/category/commodities/commodity-news/feed/` | Shipping + commodities overlap |
| 9 | Google News — LME metals | RSS | `https://news.google.com/rss/search?q=LME+base+metals&...` | Google News redirect URLs; dedup by headline |
| 10 | Google News — copper market | RSS | `https://news.google.com/rss/search?q=%22copper+market%22...` | Overlaps with source 9; dedup handles it |
| 11 | MarketWatch metals | RSS | `https://feeds.content.dowjones.io/public/rss/mw_marketpulse` | Broad feed; AI classifier (Session G) filters for metals |
| 12 | LME Press Releases | HTML | `https://www.lme.com/en/News/Press-releases` | Scraped with cheerio — **fragile** |
| 13 | Kitco Base Metals | HTML | `https://www.kitco.com/news/category/base-metals` | Scraped with cheerio — **fragile** |

---

## HTML Scrape Selectors

### Source 12 — LME Press Releases

**URL:** `https://www.lme.com/en/News/Press-releases`

**Strategy (tried in priority order):**
1. `article` elements — look for `a[href*="/News/Press-releases/"]` child for the link and `h1/h2/h3/h4/.title/.headline` for the heading
2. `li` elements containing `a[href*="/News/Press-releases/"]`
3. Direct `a[href*="/News/Press-releases/"]` links

**Date extraction:** `time[datetime]` → `time` text → `.date`, `.published`, `[class*="date"]`

**Date format:** UK-style `DD Month YYYY` (e.g. `24 April 2026`), also accepts ISO 8601.

**Fragility warning:** The LME relaunched their site in 2023 and restructured it in 2024.
If these selectors break, inspect the current HTML and update accordingly. No automated
fallback will save you — log `source_stats` to see zero items from this source as an alert.

---

### Source 13 — Kitco Base Metals

**URL:** `https://www.kitco.com/news/category/base-metals`

**Strategy:**
1. `article`, `.article-card`, `.news-item`, `[class*="article"]`, `[class*="Article"]` elements
2. Fallback: `a[href*="/news/"]` links containing `h2/h3/h4/.title`

**Link extraction:** `a[href*="/news/"]` within card, or the card itself if it's an `<a>`

**Date extraction:** `time[datetime]` → `time` text → `.date`, `.timestamp`, `[class*="date"]`

**Timestamp fallback:** If no timestamp is found on an article card, `fetched_at` is used and
a warning is logged to `source_stats.errors` for that item.

**Fragility warning:** Kitco periodically redesigns their category pages. The class names used
(`.article-card`, etc.) are inferred from their design patterns. Monitor `source_stats` for
zero contributions from this source.

---

## Deduplication

Two-pass dedup applied after merging all sources:

1. **Primary — URL equality:** `normaliseUrl()` strips tracking params (`utm_*`, `fbclid`,
   `gclid`, `_ga`, etc.), lowercases hostname, removes fragments and trailing slashes.
   Items with identical normalised URLs are discarded (newest-first sort, so oldest copy kept).

2. **Secondary — Headline similarity:** Headlines are lowercased, punctuation stripped,
   whitespace collapsed, then truncated to 100 characters. If two items have identical
   normalised headlines (and both are ≥10 chars), the duplicate is discarded.
   This catches Google News duplicates where redirect URLs differ but the story is identical.

**Google News note:** Google News RSS items use redirect URLs
(`https://news.google.com/rss/articles/...`). These cannot be resolved without an
extra HTTP request per item, which would double the fetch count. Instead, headline-based
dedup is the main guard for Google News × other-source overlaps. Minor URL-level duplication
is acceptable — Session G's AI classifier tolerates it.

---

## Relevance Filter (`isObviouslyIrrelevant`)

A **coarse pre-filter only**. When in doubt, items are **kept** — the AI classifier
(Session G) does the real relevance work. The filter only removes clear noise:

**Excluded patterns (headline match):**
- `announces closing of` — junior-miner deal boilerplate
- `announces private placement` — financing PR
- `completes acquisition of` — deal PR
- `grants stock options` — governance PR
- `files NI 43-101` — Canadian regulatory filing boilerplate
- `buy gold now` / `best gold IRA` / `gold coins for sale` — retail bullion ads

**Crypto-only exclusion:**
Headlines containing `bitcoin`, `ethereum`, or `crypto` are excluded **only** if they
contain none of the metals keywords. A headline about "Bitcoin miners and copper supply"
would be kept.

**Metals keywords (any one triggers keep):**
copper, alumin(ium/um), zinc, nickel, lead, tin, cobalt, lithium, LME, COMEX, metal,
mining, smelter, refinery, ore, concentrate, warehouse stocks, Codelco, Freeport, Glencore,
BHP, Rio Tinto, Anglo American, China demand, supply chain, iron ore, steel, scrap metal,
base metal, precious metal, gold, silver, platinum, palladium.

---

## Expected Output

| Metric | Typical range |
|--------|---------------|
| Raw items (before dedup) | 150 – 300 |
| After URL + headline dedup | 100 – 200 |
| After relevance filter | 80 – 180 |
| Per-run fetch time | 3 – 8 seconds |

A `status: 'partial'` result (some sources failed, but items were returned) is normal —
feeds go down occasionally. A `status: 'failed'` result (zero items after all processing)
should trigger an alert.

---

## Architecture Notes

- **No Supabase client** in this file. Pure fetch + normalise.
- **No metal-tagging or sentiment.** `metals` and `sentiment` fields are populated by
  Session G (AI classification, Wave 2). `NewsItem` does not include those fields.
- **12-second timeout per source**, no retries. We run every ~2 hours so a single miss
  is acceptable.
- **`rss-parser`** handles both RSS 2.0 and Atom 1.0 transparently.
- **`cheerio`** is used only for the 2 HTML scrapes.
- All 13 fetches run via `Promise.allSettled` — one bad source cannot block the others.
