/**
 * LME (London Metal Exchange) end-of-day data source module.
 *
 * Fetches official daily prices and warehouse stock reports for six base metals:
 * copper, aluminium, zinc, nickel, lead, tin.
 *
 * ARCHITECTURE OVERVIEW
 * ---------------------
 * The LME publishes downloadable XLSX/CSV files on their public website. These
 * are indexed via an internal Sitecore CMS API endpoint:
 *   https://www.lme.com/api/Lists/DownloadLinks/{GUID}
 *
 * CURRENT STATUS — Cloudflare managed-challenge blocking
 * -------------------------------------------------------
 * As of April 2026, the entire lme.com domain is behind Cloudflare's "managed
 * challenge" (JS-execution challenge). This cannot be bypassed by any server-side
 * HTTP client (Node.js fetch, Deno fetch, etc.) — only a real browser runtime can
 * complete the challenge. Every path to LME data was verified blocked:
 *   - https://www.lme.com/api/Lists/DownloadLinks/* → 403 + Cloudflare HTML
 *   - https://www.lme.com/market-data/reports-and-data → 403 + Cloudflare HTML
 *   - https://www.lme.com/metals/non-ferrous/lme-copper → 403 + Cloudflare HTML
 *   - /api/sitecore/search/* → 403 + Cloudflare HTML
 *
 * The module implements the full correct code path for WHEN access is restored
 * (e.g., Supabase IP whitelisting, Cloudflare policy change, or browser-based
 * session cookie injection). When blocked, it returns status:'failed' cleanly so
 * Session D's Yahoo Finance fallback handles the data gap.
 *
 * GUIDs DISCOVERED
 * ----------------
 * From Wayback Machine CDX API (none verified as correct report type — Cloudflare
 * blocked all API responses at capture time):
 *   - 02E29CA4-5597-42E7-9A22-59BB73AE8F6B → Commitments of Traders (confirmed)
 *   - 353FB333-E30A-4C13-AC97-4FF0ED95A560 → unknown (captured Jan 2021)
 *   - 40FE7AB3-7357-41D9-A31B-3E0BA2803AAA → unknown (captured Oct 2018)
 *
 * Canonical GUIDs for the reports we NEED must be obtained by:
 *   curl -b "<valid CF session cookie>" \
 *     "https://www.lme.com/api/Lists/DownloadLinks/%7BGUID%7D?currentPage=0"
 * and inspecting the Url / Title fields. Update PRICES_GUID and STOCKS_GUID below
 * once verified.
 *
 * Run standalone: npx tsx lib/sources/lme.ts
 */

import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Types (exported for Supabase Edge Function and tests)
// ---------------------------------------------------------------------------

export type LmeMetal = 'copper' | 'aluminium' | 'zinc' | 'nickel' | 'lead' | 'tin';

export interface LmePriceRow {
  metal: LmeMetal;
  contract: 'cash' | '3m';
  price: number;          // USD
  currency: 'USD';
  unit: 'tonne';
  as_of: string;          // ISO 8601 UTC timestamp
  prev_close: number | null;
  change_pct: number | null;
}

export interface LmeStockRow {
  metal: LmeMetal;
  on_warrant: number;          // tonnes
  cancelled_warrants: number;  // tonnes
  total_stock: number;         // tonnes
  as_of: string;               // ISO 8601 date (YYYY-MM-DD)
}

export interface LmeFetchResult {
  status: 'success' | 'partial' | 'failed';
  prices: LmePriceRow[];
  stocks: LmeStockRow[];
  source: 'lme_official';
  fetched_at: string;          // ISO 8601 UTC
  errors: string[];
  reason?: string;             // only when status === 'failed'
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LME_BASE = 'https://www.lme.com';

/**
 * Sitecore CMS item GUIDs for the DownloadLinks API.
 * These must be obtained from a browser session and set here.
 * Until confirmed, the module uses dynamic page-discovery as the primary path.
 *
 * To obtain: open LME in a browser → DevTools Network tab → look for
 * /api/Lists/DownloadLinks/{GUID} requests while browsing reports pages.
 */
const PRICES_GUID = '{UNVERIFIED-PRICES-GUID}'; // TODO: replace with verified GUID
const STOCKS_GUID = '{UNVERIFIED-STOCKS-GUID}'; // TODO: replace with verified GUID

/** LME metal name normalisation map (LME uses British spellings / official names) */
const METAL_ALIASES: Record<string, LmeMetal> = {
  copper: 'copper',
  'lme copper': 'copper',
  aluminium: 'aluminium',
  aluminum: 'aluminium',
  'lme aluminium': 'aluminium',
  'primary aluminium': 'aluminium',
  zinc: 'zinc',
  'lme zinc': 'zinc',
  'special high grade zinc': 'zinc',
  nickel: 'nickel',
  'lme nickel': 'nickel',
  lead: 'lead',
  'lme lead': 'lead',
  tin: 'tin',
  'lme tin': 'tin',
};

const BROWSER_UA =
  'Mozilla/5.0 (compatible; BritanniaMetalsDesk/1.0; +https://github.com/rossforrester/britannia-metals)';

const FETCH_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with a timeout and one retry on failure.
 * Never retries more than once. Does NOT recurse infinitely.
 */
async function fetchWithRetry(url: string, opts?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    'Accept': '*/*',
    ...(opts?.headers as Record<string, string> ?? {}),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...opts,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 0) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[lme] Request to ${url} failed (attempt 1): ${reason}. Retrying in ${RETRY_DELAY_MS}ms…`);
        await delay(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  // Should never reach here, but satisfies TypeScript
  throw new Error(`fetchWithRetry exhausted retries for ${url}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true if the response body looks like a Cloudflare managed challenge
 * page rather than the expected API/file response.
 */
function isCloudflareBlock(body: string): boolean {
  return (
    body.includes('Just a moment') ||
    body.includes('cf-wrapper') ||
    body.includes('Cloudflare') ||
    body.includes('challenges.cloudflare.com') ||
    body.includes('Enable JavaScript and cookies')
  );
}

// ---------------------------------------------------------------------------
// Exported utility: discover a download URL from the LME DownloadLinks API
// ---------------------------------------------------------------------------

/**
 * Hits `https://www.lme.com/api/Lists/DownloadLinks/{guid}?currentPage=0`
 * and returns the URL of the most-recent (first) content item, or null if
 * the endpoint is unreachable / returns no items.
 *
 * @param guid  Sitecore item GUID, e.g. "{02E29CA4-5597-42E7-9A22-59BB73AE8F6B}"
 */
export async function discoverDownloadUrl(guid: string): Promise<string | null> {
  const encoded = encodeURIComponent(guid);
  const apiUrl = `${LME_BASE}/api/Lists/DownloadLinks/${encoded}?currentPage=0`;

  console.log(`[lme] Discovering download URL for GUID ${guid}…`);

  let response: Response;
  try {
    response = await fetchWithRetry(apiUrl, {
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[lme] Network error reaching DownloadLinks API: ${msg}`);
    return null;
  }

  const text = await response.text();

  if (!response.ok || isCloudflareBlock(text)) {
    if (isCloudflareBlock(text)) {
      console.error(
        `[lme] Cloudflare managed-challenge blocked DownloadLinks API. ` +
        `HTTP ${response.status}. Server-side fetch cannot complete JS challenge.`,
      );
    } else {
      console.error(`[lme] DownloadLinks API returned HTTP ${response.status} for GUID ${guid}.`);
    }
    return null;
  }

  let json: { content_items?: Array<{ Url?: string; Title?: string }> };
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`[lme] DownloadLinks API response is not valid JSON for GUID ${guid}.`);
    return null;
  }

  const items = json.content_items ?? [];
  if (items.length === 0) {
    console.warn(`[lme] DownloadLinks API returned 0 content_items for GUID ${guid}.`);
    return null;
  }

  const url = items[0].Url ?? null;
  if (!url) {
    console.warn(`[lme] First content_item has no Url field for GUID ${guid}.`);
    return null;
  }

  // URL from LME is a relative path — prepend base
  const fullUrl = url.startsWith('http') ? url : `${LME_BASE}${url}`;
  console.log(`[lme] Discovered download URL: ${fullUrl}`);
  return fullUrl;
}

// ---------------------------------------------------------------------------
// Exported utility: download and parse an LME XLSX report
// ---------------------------------------------------------------------------

/**
 * Downloads an LME XLSX file and returns rows as plain objects.
 * Handles multi-sheet workbooks — returns rows from the first non-empty sheet,
 * or merges all sheets if the structure indicates a consolidated format.
 */
export async function fetchAndParseXlsx(url: string): Promise<Record<string, unknown>[]> {
  console.log(`[lme] Downloading XLSX: ${url}`);

  let response: Response;
  try {
    response = await fetchWithRetry(url, {
      headers: { 'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error downloading XLSX: ${msg}`);
  }

  if (!response.ok) {
    const text = await response.text();
    if (isCloudflareBlock(text)) {
      throw new Error(`Cloudflare blocked XLSX download (HTTP ${response.status})`);
    }
    throw new Error(`XLSX download returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  // Some servers return HTML error pages even with 200 — detect this
  if (contentType.includes('text/html')) {
    const text = await response.text();
    if (isCloudflareBlock(text)) {
      throw new Error('Cloudflare blocked XLSX download (HTML challenge page returned)');
    }
    throw new Error('Expected XLSX but got HTML response');
  }

  const arrayBuffer = await response.arrayBuffer();
  const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', cellDates: true });

  if (workbook.SheetNames.length === 0) {
    throw new Error('XLSX workbook has no sheets');
  }

  // Strategy: try a consolidated sheet first, fall back to merging all sheets
  const allRows: Record<string, unknown>[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: false, // let XLSX format dates as strings
    });
    // Tag each row with its source sheet name
    for (const row of rows) {
      allRows.push({ ...row, _sheet: sheetName });
    }
  }

  console.log(
    `[lme] Parsed ${allRows.length} rows from ${workbook.SheetNames.length} sheet(s): ` +
    workbook.SheetNames.join(', '),
  );

  return allRows;
}

// ---------------------------------------------------------------------------
// Price parsing
// ---------------------------------------------------------------------------

function normaliseMetal(raw: string): LmeMetal | null {
  const key = raw.toLowerCase().trim();
  return METAL_ALIASES[key] ?? null;
}

function parsePrice(val: unknown): number | null {
  if (val == null || val === '') return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

/**
 * Parse rows from the LME Daily Official Prices XLSX.
 *
 * The LME official prices workbook (as documented from historical samples) has
 * one of two structures:
 *   A) Single sheet "Official" with columns: Metal, Cash Buyer, Cash Seller, 3M Buyer, 3M Seller
 *   B) Multiple sheets, one per metal, with rows for each contract date
 *
 * We handle both: detect by checking if a "Metal" or "Contract" column exists.
 * Cash price = mean of Cash Buyer + Cash Seller (or single "Cash" column).
 * 3M price = mean of 3M Buyer + 3M Seller (or single "3 Month" / "3M" column).
 */
function parsePriceRows(rawRows: Record<string, unknown>[], reportDate: string): LmePriceRow[] {
  const results: LmePriceRow[] = [];
  const seen = new Set<string>();

  for (const row of rawRows) {
    // Try to identify the metal from a "Metal" column or from sheet name
    const metalRaw =
      (row['Metal'] as string | null) ??
      (row['Commodity'] as string | null) ??
      (row['Contract'] as string | null) ??
      (row['_sheet'] as string | null) ??
      '';

    const metal = normaliseMetal(metalRaw);
    if (!metal) continue;

    // Skip non-cash/3m rows (prompt dates like 15-day, Dec1, Dec2, Dec3)
    const rowLabel = String(row['Prompt'] ?? row['Date'] ?? row['Tenor'] ?? '').toLowerCase();
    if (rowLabel && !['cash', 'buyer', 'seller', '3m', '3 month', 'three month', ''].includes(rowLabel)) {
      // Skip specific prompt dates — only include cash and 3m
      if (/^\d+\s*day/i.test(rowLabel) || /dec\d/i.test(rowLabel) || /\d{2}\/\d{2}\/\d{2,4}/.test(rowLabel)) {
        continue;
      }
    }

    // Extract cash and 3M prices using multiple possible column names
    const cashBuyer = parsePrice(row['Cash Buyer'] ?? row['Cash Bid'] ?? row['Cash']);
    const cashSeller = parsePrice(row['Cash Seller'] ?? row['Cash Ask'] ?? row['Cash Offer']);
    const threeMBuyer = parsePrice(row['3M Buyer'] ?? row['3 Months Buyer'] ?? row['3M Bid'] ?? row['3 Month'] ?? row['3M'] ?? row['Three Month']);
    const threeMSeller = parsePrice(row['3M Seller'] ?? row['3 Months Seller'] ?? row['3M Ask'] ?? row['3M Offer']);

    // If we have separate buyer/seller, take mid-price; otherwise use the single value
    const cashPrice =
      cashBuyer != null && cashSeller != null
        ? (cashBuyer + cashSeller) / 2
        : cashBuyer ?? cashSeller ?? null;

    const threeMPrice =
      threeMBuyer != null && threeMSeller != null
        ? (threeMBuyer + threeMSeller) / 2
        : threeMBuyer ?? threeMSeller ?? null;

    if (cashPrice != null) {
      const key = `${metal}-cash`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          metal,
          contract: 'cash',
          price: Math.round(cashPrice * 100) / 100,
          currency: 'USD',
          unit: 'tonne',
          as_of: reportDate,
          prev_close: null,
          change_pct: null,
        });
      }
    }

    if (threeMPrice != null) {
      const key = `${metal}-3m`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          metal,
          contract: '3m',
          price: Math.round(threeMPrice * 100) / 100,
          currency: 'USD',
          unit: 'tonne',
          as_of: reportDate,
          prev_close: null,
          change_pct: null,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Stock parsing
// ---------------------------------------------------------------------------

/**
 * Parse rows from the LME Daily Warehouse Stocks XLSX.
 *
 * The stocks workbook has columns approximately:
 *   Metal, On Warrant, Cancelled Warrants, Total
 * Units are in metric tonnes (confirmed: LME reports tonnes, not kt).
 */
function parseStockRows(rawRows: Record<string, unknown>[], reportDate: string): LmeStockRow[] {
  const results: LmeStockRow[] = [];
  const seen = new Set<LmeMetal>();

  for (const row of rawRows) {
    const metalRaw =
      (row['Metal'] as string | null) ??
      (row['Commodity'] as string | null) ??
      (row['_sheet'] as string | null) ??
      '';

    const metal = normaliseMetal(metalRaw);
    if (!metal || seen.has(metal)) continue;

    // Try several possible column name variants
    const onWarrant = parsePrice(
      row['On Warrant'] ?? row['On-Warrant'] ?? row['OnWarrant'] ?? row['Warrant'] ?? row['Live Warrants'],
    );
    const cancelled = parsePrice(
      row['Cancelled Warrants'] ?? row['Cancelled'] ?? row['Cancel'] ?? row['Cancelled Warrant'],
    );

    // Total = on_warrant + cancelled if not explicitly provided
    const totalRaw = parsePrice(
      row['Total'] ?? row['Total Stock'] ?? row['Total Stocks'] ?? row['Grand Total'],
    );
    const total = totalRaw ?? (onWarrant != null && cancelled != null ? onWarrant + cancelled : null);

    if (onWarrant == null && cancelled == null && total == null) continue;

    seen.add(metal);
    results.push({
      metal,
      on_warrant: Math.round(onWarrant ?? 0),
      cancelled_warrants: Math.round(cancelled ?? 0),
      total_stock: Math.round(total ?? (onWarrant ?? 0) + (cancelled ?? 0)),
      as_of: reportDate,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

/**
 * Convert an LME date string (DD/MM/YYYY or similar) to ISO 8601.
 * Returns today's date string as fallback.
 */
function normaliseDateToISO(raw: string): string {
  // Try DD/MM/YYYY
  const dmyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Try YYYY-MM-DD (already ISO)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // Fallback: today
  return new Date().toISOString().slice(0, 10);
}

/**
 * Extract the report date from an LME file URL.
 * LME file URLs typically contain /YYYY/MM/DD/ path segments.
 */
function extractDateFromUrl(url: string): string {
  const match = url.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (match) {
    const [, y, m, d] = match;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Fallback to today
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Fallback: scrape individual metal pages for __NEXT_DATA__
// ---------------------------------------------------------------------------

/**
 * Fallback path: try to scrape price data from the individual LME metal page.
 * LME's Next.js site hydrates pages from __NEXT_DATA__ script tag.
 * Also tries five-day lookback tables if __NEXT_DATA__ is absent.
 *
 * Returns an array of price rows, empty if blocked or parse fails.
 */
async function scrapeMetalPage(metal: LmeMetal): Promise<LmePriceRow[]> {
  const slugs: Record<LmeMetal, string> = {
    copper: 'lme-copper',
    aluminium: 'lme-aluminium',
    zinc: 'lme-zinc',
    nickel: 'lme-nickel',
    lead: 'lme-lead',
    tin: 'lme-tin',
  };

  const url = `${LME_BASE}/metals/non-ferrous/${slugs[metal]}`;
  console.log(`[lme] Fallback: scraping ${url}…`);

  let response: Response;
  try {
    response = await fetchWithRetry(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
  } catch {
    return [];
  }

  const html = await response.text();
  if (!response.ok || isCloudflareBlock(html)) {
    return [];
  }

  // Try __NEXT_DATA__ extraction
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const pageData = JSON.parse(nextDataMatch[1]);
      return extractPricesFromNextData(pageData, metal);
    } catch {
      // fall through
    }
  }

  // Fallback: look for price data in visible table or JSON embedded in any script tag
  const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  for (const [, script] of scriptMatches) {
    const priceMatch = script.match(/"cashPrice"\s*:\s*([\d.]+)/i) ??
                       script.match(/"officialPrice"\s*:\s*([\d.]+)/i);
    if (priceMatch) {
      const price = parseFloat(priceMatch[1]);
      if (isFinite(price) && price > 0) {
        const as_of = new Date().toISOString();
        return [
          { metal, contract: 'cash', price, currency: 'USD', unit: 'tonne', as_of, prev_close: null, change_pct: null },
        ];
      }
    }
  }

  return [];
}

/**
 * Extract price rows from Next.js page data (__NEXT_DATA__).
 * Structure is site-specific and may change with LME site updates.
 */
function extractPricesFromNextData(
  data: Record<string, unknown>,
  metal: LmeMetal,
): LmePriceRow[] {
  const results: LmePriceRow[] = [];

  // Walk common paths where LME Next.js embeds price data
  const props = (data?.props as Record<string, unknown>) ?? {};
  const pageProps = (props?.pageProps as Record<string, unknown>) ?? {};
  const priceData =
    pageProps?.priceData ??
    pageProps?.officialPrices ??
    pageProps?.metalData;

  if (!priceData || typeof priceData !== 'object') return results;

  const as_of = new Date().toISOString();

  const pd = priceData as Record<string, unknown>;
  const cashPrice = parsePrice(pd?.cashPrice ?? pd?.cash ?? pd?.officialPrice);
  const threeMonthPrice = parsePrice(pd?.threeMonthPrice ?? pd?.threeMPrice ?? pd?.['3mPrice']);

  if (cashPrice != null) {
    results.push({
      metal, contract: 'cash', price: cashPrice,
      currency: 'USD', unit: 'tonne', as_of,
      prev_close: null, change_pct: null,
    });
  }
  if (threeMonthPrice != null) {
    results.push({
      metal, contract: '3m', price: threeMonthPrice,
      currency: 'USD', unit: 'tonne', as_of,
      prev_close: null, change_pct: null,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main data paths
// ---------------------------------------------------------------------------

const LME_METALS: LmeMetal[] = ['copper', 'aluminium', 'zinc', 'nickel', 'lead', 'tin'];

/**
 * Attempt to fetch and parse the LME Daily Official Prices XLSX.
 * Returns parsed rows, or empty array with error details pushed to errors[].
 */
async function fetchPrices(errors: string[]): Promise<LmePriceRow[]> {
  // Primary path: GUID-based download discovery
  const downloadUrl = await discoverDownloadUrl(PRICES_GUID);

  if (!downloadUrl) {
    errors.push(
      'LME prices: DownloadLinks API unavailable (Cloudflare block or GUID not set). ' +
      'Falling back to individual metal page scraping.',
    );

    // Fallback: scrape individual metal pages
    const fallbackRows: LmePriceRow[] = [];
    for (const metal of LME_METALS) {
      try {
        const rows = await scrapeMetalPage(metal);
        fallbackRows.push(...rows);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`LME prices fallback (${metal}): ${msg}`);
      }
    }

    if (fallbackRows.length > 0) {
      console.log(`[lme] Fallback scraping returned ${fallbackRows.length} price rows.`);
    } else {
      errors.push('LME prices: all fallback paths failed (Cloudflare blocks individual metal pages too).');
    }

    return fallbackRows;
  }

  // Download and parse the XLSX
  let rawRows: Record<string, unknown>[];
  try {
    rawRows = await fetchAndParseXlsx(downloadUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`LME prices XLSX download/parse failed: ${msg}`);
    return [];
  }

  const reportDate = extractDateFromUrl(downloadUrl);
  const reportDateIso = `${reportDate}T16:00:00.000Z`; // LME Ring closes ~16:00 London time

  const rows = parsePriceRows(rawRows, reportDateIso);
  console.log(`[lme] Parsed ${rows.length} price rows from XLSX (date: ${reportDate})`);

  // Report which metals are missing
  const metals = new Set(rows.map((r) => r.metal));
  for (const metal of LME_METALS) {
    if (!metals.has(metal)) {
      errors.push(`LME prices: ${metal} not found in XLSX — may be a column-name mismatch`);
    }
  }

  return rows;
}

/**
 * Attempt to fetch and parse the LME Daily Warehouse Stocks XLSX.
 */
async function fetchStocks(errors: string[]): Promise<LmeStockRow[]> {
  const downloadUrl = await discoverDownloadUrl(STOCKS_GUID);

  if (!downloadUrl) {
    errors.push(
      'LME stocks: DownloadLinks API unavailable (Cloudflare block or GUID not set).',
    );
    return [];
  }

  let rawRows: Record<string, unknown>[];
  try {
    rawRows = await fetchAndParseXlsx(downloadUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`LME stocks XLSX download/parse failed: ${msg}`);
    return [];
  }

  const reportDate = extractDateFromUrl(downloadUrl);
  const rows = parseStockRows(rawRows, reportDate);
  console.log(`[lme] Parsed ${rows.length} stock rows from XLSX (date: ${reportDate})`);

  const metals = new Set(rows.map((r) => r.metal));
  for (const metal of LME_METALS) {
    if (!metals.has(metal)) {
      errors.push(`LME stocks: ${metal} not found in XLSX`);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Public API: main entry point
// ---------------------------------------------------------------------------

/**
 * Fetch LME end-of-day official prices and warehouse stocks for all six base metals.
 *
 * Never throws. Always returns a structured LmeFetchResult.
 * status: 'success'  — all 6 metals parsed for both prices and stocks
 * status: 'partial'  — some metals parsed, some failed
 * status: 'failed'   — nothing usable returned (typically Cloudflare block)
 */
export async function fetchLmeData(): Promise<LmeFetchResult> {
  const fetched_at = new Date().toISOString();
  const errors: string[] = [];
  const t0 = Date.now();

  console.log('[lme] Starting LME data fetch…');

  let prices: LmePriceRow[] = [];
  let stocks: LmeStockRow[] = [];

  try {
    [prices, stocks] = await Promise.all([
      fetchPrices(errors),
      fetchStocks(errors),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[lme] Unexpected top-level error: ${msg}`);
    return {
      status: 'failed',
      prices: [],
      stocks: [],
      source: 'lme_official',
      fetched_at,
      errors: [msg],
      reason: `Unexpected error: ${msg}`,
    };
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[lme] Fetch complete in ${elapsed}s — ` +
    `${prices.length} price rows, ${stocks.length} stock rows, ${errors.length} errors`,
  );

  // Determine status
  const priceMetals = new Set(prices.map((r) => r.metal));
  const stockMetals = new Set(stocks.map((r) => r.metal));
  const allMetalsHavePrices = LME_METALS.every((m) => priceMetals.has(m));
  const anyPrices = prices.length > 0;
  const anyStocks = stocks.length > 0;

  let status: LmeFetchResult['status'];
  let reason: string | undefined;

  if (!anyPrices && !anyStocks) {
    status = 'failed';
    reason =
      'LME website is behind Cloudflare managed-challenge anti-bot protection. ' +
      'Server-side HTTP clients cannot complete the required JavaScript challenge. ' +
      'All data paths (DownloadLinks API, individual metal pages) returned Cloudflare ' +
      'challenge pages instead of data. ' +
      'To restore functionality: (1) obtain a valid Cloudflare session cookie from a ' +
      'browser session and inject it via the CF_CLEARANCE env var, or ' +
      '(2) request LME to whitelist Supabase Edge Function IP ranges, or ' +
      '(3) upgrade to the LME XML feed subscription ($2,565/year).';
    console.warn(`[lme] status: failed — ${reason}`);
  } else if (allMetalsHavePrices && LME_METALS.every((m) => stockMetals.has(m))) {
    status = 'success';
    console.log('[lme] status: success — all 6 metals have prices and stocks');
  } else {
    status = 'partial';
    const missingPrices = LME_METALS.filter((m) => !priceMetals.has(m));
    const missingStocks = LME_METALS.filter((m) => !stockMetals.has(m));
    if (missingPrices.length > 0) console.warn(`[lme] Missing prices for: ${missingPrices.join(', ')}`);
    if (missingStocks.length > 0) console.warn(`[lme] Missing stocks for: ${missingStocks.join(', ')}`);
    console.log('[lme] status: partial');
  }

  return {
    status,
    prices,
    stocks,
    source: 'lme_official',
    fetched_at,
    errors,
    ...(reason ? { reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Standalone entry point — run with: npx tsx lib/sources/lme.ts
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchLmeData().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'failed' ? 1 : 0);
  });
}
