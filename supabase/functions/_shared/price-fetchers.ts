/**
 * price-fetchers.ts — Deno-compatible adaptation of Wave 1 data source modules.
 *
 * Adapted from:
 *   /lib/sources/lme.ts   — LME official prices + warehouse stocks
 *   /lib/sources/yahoo.ts — Yahoo Finance (COMEX copper, gold, silver, LME fallbacks)
 *
 * Key changes from the Node originals:
 *   - `import * as XLSX from 'xlsx'`          → npm:xlsx@0.18.5
 *   - `import YahooFinance from 'yahoo-finance2'` → npm:yahoo-finance2@3
 *   - Standalone `if (import.meta.url === ...)` entry points removed
 *   - Node `fetch` → Deno global `fetch` (identical API, no change needed)
 *   - `process.argv`, `process.exit` removed (not available / not needed in Edge Functions)
 */

// deno-lint-ignore-file no-explicit-any
import * as XLSX from 'npm:xlsx@0.18.5';
import YahooFinance from 'npm:yahoo-finance2@3';

const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

// =============================================================================
// Shared types
// =============================================================================

export type LmeMetal = 'copper' | 'aluminium' | 'zinc' | 'nickel' | 'lead' | 'tin';
export type YahooMetal = 'copper' | 'aluminium' | 'gold' | 'silver';

export interface LmePriceRow {
  metal: LmeMetal;
  contract: 'cash' | '3m';
  price: number;
  currency: 'USD';
  unit: 'tonne';
  as_of: string;
  prev_close: number | null;
  change_pct: number | null;
}

export interface LmeStockRow {
  metal: LmeMetal;
  on_warrant: number;
  cancelled_warrants: number;
  total_stock: number;
  as_of: string;  // YYYY-MM-DD
}

export interface LmeFetchResult {
  status: 'success' | 'partial' | 'failed';
  prices: LmePriceRow[];
  stocks: LmeStockRow[];
  source: 'lme_official';
  fetched_at: string;
  errors: string[];
  reason?: string;
}

export interface YahooPriceRow {
  metal: YahooMetal;
  contract: 'front_month';
  price: number;
  currency: 'USD';
  unit: 'tonne' | 'troy_oz';
  as_of: string;
  prev_close: number | null;
  change_pct: number | null;
  raw_symbol: string;
  is_fallback: boolean;
}

export interface YahooHistoricalPoint {
  date: string;   // YYYY-MM-DD
  close: number;  // USD/tonne for HG=F
}

export interface YahooFetchResult {
  status: 'success' | 'partial' | 'failed';
  prices: YahooPriceRow[];
  source: 'yahoo';
  fetched_at: string;
  errors: string[];
  reason?: string;
}

// =============================================================================
// LME module
// =============================================================================

const LME_BASE = 'https://www.lme.com';
const PRICES_GUID = '{UNVERIFIED-PRICES-GUID}';
const STOCKS_GUID = '{UNVERIFIED-STOCKS-GUID}';

const METAL_ALIASES: Record<string, LmeMetal> = {
  copper: 'copper', 'lme copper': 'copper',
  aluminium: 'aluminium', aluminum: 'aluminium',
  'lme aluminium': 'aluminium', 'primary aluminium': 'aluminium',
  zinc: 'zinc', 'lme zinc': 'zinc', 'special high grade zinc': 'zinc',
  nickel: 'nickel', 'lme nickel': 'nickel',
  lead: 'lead', 'lme lead': 'lead',
  tin: 'tin', 'lme tin': 'tin',
};

const BROWSER_UA =
  'Mozilla/5.0 (compatible; BritanniaMetalsDesk/1.0; +https://github.com/rossforrester/britannia-metals)';

const FETCH_TIMEOUT_MS = 15_000;
const LME_METALS: LmeMetal[] = ['copper', 'aluminium', 'zinc', 'nickel', 'lead', 'tin'];

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

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
      const response = await fetch(url, { ...opts, headers, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === 0) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[lme] Request to ${url} failed (attempt 1): ${reason}. Retrying in 2000ms…`);
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`fetchWithRetry exhausted retries for ${url}`);
}

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
// XLSX + discovery helpers
// ---------------------------------------------------------------------------

async function discoverDownloadUrl(guid: string): Promise<string | null> {
  const encoded = encodeURIComponent(guid);
  const apiUrl = `${LME_BASE}/api/Lists/DownloadLinks/${encoded}?currentPage=0`;

  let response: Response;
  try {
    response = await fetchWithRetry(apiUrl, { headers: { 'Accept': 'application/json' } });
  } catch (err) {
    console.error(`[lme] Network error reaching DownloadLinks API: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const text = await response.text();
  if (!response.ok || isCloudflareBlock(text)) {
    if (isCloudflareBlock(text)) {
      console.error(`[lme] Cloudflare managed-challenge blocked DownloadLinks API. HTTP ${response.status}.`);
    } else {
      console.error(`[lme] DownloadLinks API returned HTTP ${response.status} for GUID ${guid}.`);
    }
    return null;
  }

  let json: { content_items?: Array<{ Url?: string }> };
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`[lme] DownloadLinks API response is not valid JSON for GUID ${guid}.`);
    return null;
  }

  const items = json.content_items ?? [];
  if (items.length === 0 || !items[0].Url) {
    console.warn(`[lme] DownloadLinks API returned no usable content_items for GUID ${guid}.`);
    return null;
  }

  const url = items[0].Url!;
  const fullUrl = url.startsWith('http') ? url : `${LME_BASE}${url}`;
  return fullUrl;
}

async function fetchAndParseXlsx(url: string): Promise<Record<string, unknown>[]> {
  let response: Response;
  try {
    response = await fetchWithRetry(url, {
      headers: { 'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream' },
    });
  } catch (err) {
    throw new Error(`Network error downloading XLSX: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    const text = await response.text();
    if (isCloudflareBlock(text)) throw new Error(`Cloudflare blocked XLSX download (HTTP ${response.status})`);
    throw new Error(`XLSX download returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    const text = await response.text();
    if (isCloudflareBlock(text)) throw new Error('Cloudflare blocked XLSX download (HTML challenge page returned)');
    throw new Error('Expected XLSX but got HTML response');
  }

  const arrayBuffer = await response.arrayBuffer();
  const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', cellDates: true });

  if (workbook.SheetNames.length === 0) throw new Error('XLSX workbook has no sheets');

  const allRows: Record<string, unknown>[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false });
    for (const row of rows) allRows.push({ ...row, _sheet: sheetName });
  }
  return allRows;
}

// ---------------------------------------------------------------------------
// Price / stock parsers
// ---------------------------------------------------------------------------

function normaliseMetal(raw: string): LmeMetal | null {
  return METAL_ALIASES[raw.toLowerCase().trim()] ?? null;
}

function parsePrice(val: unknown): number | null {
  if (val == null || val === '') return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

function parsePriceRows(rawRows: Record<string, unknown>[], reportDate: string): LmePriceRow[] {
  const results: LmePriceRow[] = [];
  const seen = new Set<string>();

  for (const row of rawRows) {
    const metalRaw =
      (row['Metal'] as string | null) ?? (row['Commodity'] as string | null) ??
      (row['Contract'] as string | null) ?? (row['_sheet'] as string | null) ?? '';
    const metal = normaliseMetal(metalRaw);
    if (!metal) continue;

    const rowLabel = String(row['Prompt'] ?? row['Date'] ?? row['Tenor'] ?? '').toLowerCase();
    if (rowLabel && /^\d+\s*day/i.test(rowLabel) || /dec\d/i.test(rowLabel) || /\d{2}\/\d{2}\/\d{2,4}/.test(rowLabel)) {
      continue;
    }

    const cashBuyer = parsePrice(row['Cash Buyer'] ?? row['Cash Bid'] ?? row['Cash']);
    const cashSeller = parsePrice(row['Cash Seller'] ?? row['Cash Ask'] ?? row['Cash Offer']);
    const threeMBuyer = parsePrice(row['3M Buyer'] ?? row['3 Months Buyer'] ?? row['3M Bid'] ?? row['3 Month'] ?? row['3M'] ?? row['Three Month']);
    const threeMSeller = parsePrice(row['3M Seller'] ?? row['3 Months Seller'] ?? row['3M Ask'] ?? row['3M Offer']);

    const cashPrice = cashBuyer != null && cashSeller != null
      ? (cashBuyer + cashSeller) / 2 : cashBuyer ?? cashSeller ?? null;
    const threeMPrice = threeMBuyer != null && threeMSeller != null
      ? (threeMBuyer + threeMSeller) / 2 : threeMBuyer ?? threeMSeller ?? null;

    if (cashPrice != null && !seen.has(`${metal}-cash`)) {
      seen.add(`${metal}-cash`);
      results.push({ metal, contract: 'cash', price: Math.round(cashPrice * 100) / 100, currency: 'USD', unit: 'tonne', as_of: reportDate, prev_close: null, change_pct: null });
    }
    if (threeMPrice != null && !seen.has(`${metal}-3m`)) {
      seen.add(`${metal}-3m`);
      results.push({ metal, contract: '3m', price: Math.round(threeMPrice * 100) / 100, currency: 'USD', unit: 'tonne', as_of: reportDate, prev_close: null, change_pct: null });
    }
  }
  return results;
}

function parseStockRows(rawRows: Record<string, unknown>[], reportDate: string): LmeStockRow[] {
  const results: LmeStockRow[] = [];
  const seen = new Set<LmeMetal>();

  for (const row of rawRows) {
    const metalRaw =
      (row['Metal'] as string | null) ?? (row['Commodity'] as string | null) ??
      (row['_sheet'] as string | null) ?? '';
    const metal = normaliseMetal(metalRaw);
    if (!metal || seen.has(metal)) continue;

    const onWarrant = parsePrice(row['On Warrant'] ?? row['On-Warrant'] ?? row['OnWarrant'] ?? row['Warrant'] ?? row['Live Warrants']);
    const cancelled = parsePrice(row['Cancelled Warrants'] ?? row['Cancelled'] ?? row['Cancel'] ?? row['Cancelled Warrant']);
    const totalRaw = parsePrice(row['Total'] ?? row['Total Stock'] ?? row['Total Stocks'] ?? row['Grand Total']);
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

function extractDateFromUrl(url: string): string {
  const match = url.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
  if (match) {
    const [, y, m, d] = match;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Individual metal page scraper (LME fallback path)
// ---------------------------------------------------------------------------

async function scrapeMetalPage(metal: LmeMetal): Promise<LmePriceRow[]> {
  const slugs: Record<LmeMetal, string> = {
    copper: 'lme-copper', aluminium: 'lme-aluminium', zinc: 'lme-zinc',
    nickel: 'lme-nickel', lead: 'lme-lead', tin: 'lme-tin',
  };
  const url = `${LME_BASE}/metals/non-ferrous/${slugs[metal]}`;
  let response: Response;
  try {
    response = await fetchWithRetry(url, { headers: { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' } });
  } catch {
    return [];
  }
  const html = await response.text();
  if (!response.ok || isCloudflareBlock(html)) return [];

  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const pageData = JSON.parse(nextDataMatch[1]);
      const props = (pageData?.props as any) ?? {};
      const pageProps = (props?.pageProps as any) ?? {};
      const pd = pageProps?.priceData ?? pageProps?.officialPrices ?? pageProps?.metalData;
      if (pd && typeof pd === 'object') {
        const as_of = new Date().toISOString();
        const results: LmePriceRow[] = [];
        const cashPrice = parsePrice((pd as any)?.cashPrice ?? (pd as any)?.cash);
        const threeMPrice = parsePrice((pd as any)?.threeMonthPrice ?? (pd as any)?.threeMPrice);
        if (cashPrice != null) results.push({ metal, contract: 'cash', price: cashPrice, currency: 'USD', unit: 'tonne', as_of, prev_close: null, change_pct: null });
        if (threeMPrice != null) results.push({ metal, contract: '3m', price: threeMPrice, currency: 'USD', unit: 'tonne', as_of, prev_close: null, change_pct: null });
        return results;
      }
    } catch { /* fall through */ }
  }
  return [];
}

// ---------------------------------------------------------------------------
// LME fetch orchestration
// ---------------------------------------------------------------------------

async function fetchLmePrices(errors: string[]): Promise<LmePriceRow[]> {
  const downloadUrl = await discoverDownloadUrl(PRICES_GUID);
  if (!downloadUrl) {
    errors.push('LME prices: DownloadLinks API unavailable (Cloudflare block). Trying individual metal pages.');
    const fallbackRows: LmePriceRow[] = [];
    for (const metal of LME_METALS) {
      try {
        fallbackRows.push(...await scrapeMetalPage(metal));
      } catch (err) {
        errors.push(`LME prices fallback (${metal}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (fallbackRows.length === 0) {
      errors.push('LME prices: all fallback paths failed (Cloudflare blocks individual pages too).');
    }
    return fallbackRows;
  }

  let rawRows: Record<string, unknown>[];
  try {
    rawRows = await fetchAndParseXlsx(downloadUrl);
  } catch (err) {
    errors.push(`LME prices XLSX download/parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const reportDate = extractDateFromUrl(downloadUrl);
  return parsePriceRows(rawRows, `${reportDate}T16:00:00.000Z`);
}

async function fetchLmeStocks(errors: string[]): Promise<LmeStockRow[]> {
  const downloadUrl = await discoverDownloadUrl(STOCKS_GUID);
  if (!downloadUrl) {
    errors.push('LME stocks: DownloadLinks API unavailable (Cloudflare block).');
    return [];
  }
  let rawRows: Record<string, unknown>[];
  try {
    rawRows = await fetchAndParseXlsx(downloadUrl);
  } catch (err) {
    errors.push(`LME stocks XLSX download/parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const reportDate = extractDateFromUrl(downloadUrl);
  return parseStockRows(rawRows, reportDate);
}

/**
 * Fetch LME end-of-day official prices and warehouse stocks.
 * Never throws. Returns LmeFetchResult with status 'failed' when Cloudflare blocks.
 */
export async function fetchLmeData(): Promise<LmeFetchResult> {
  const fetched_at = new Date().toISOString();
  const errors: string[] = [];

  let prices: LmePriceRow[] = [];
  let stocks: LmeStockRow[] = [];

  try {
    [prices, stocks] = await Promise.all([
      fetchLmePrices(errors),
      fetchLmeStocks(errors),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', prices: [], stocks: [], source: 'lme_official', fetched_at, errors: [msg], reason: `Unexpected error: ${msg}` };
  }

  const priceMetals = new Set(prices.map((r) => r.metal));
  const stockMetals = new Set(stocks.map((r) => r.metal));

  if (prices.length === 0 && stocks.length === 0) {
    const reason =
      'LME website is behind Cloudflare managed-challenge anti-bot protection. ' +
      'Server-side HTTP clients cannot complete the required JavaScript challenge. ' +
      'All data paths (DownloadLinks API, individual metal pages) returned Cloudflare ' +
      'challenge pages instead of data.';
    console.warn(`[lme] status: failed — ${reason}`);
    return { status: 'failed', prices: [], stocks: [], source: 'lme_official', fetched_at, errors, reason };
  }

  const allMetalsHavePrices = LME_METALS.every((m) => priceMetals.has(m));
  const allMetalsHaveStocks = LME_METALS.every((m) => stockMetals.has(m));

  const status = allMetalsHavePrices && allMetalsHaveStocks ? 'success' : 'partial';
  return { status, prices, stocks, source: 'lme_official', fetched_at, errors };
}

// =============================================================================
// Yahoo Finance module
// =============================================================================

const LB_PER_TONNE = 2204.62;

const FALLBACK_SYMBOL_MAP: Partial<Record<YahooMetal, string>> = {
  copper: 'HG=F',
  aluminium: 'ALI=F',
  // zinc, nickel, lead, tin — no clean Yahoo equivalent
};

const PRIMARY_SYMBOLS: Array<{ symbol: string; metal: YahooMetal }> = [
  { symbol: 'HG=F', metal: 'copper' },
  { symbol: 'GC=F', metal: 'gold' },
  { symbol: 'SI=F', metal: 'silver' },
];

function toUsdTonne(price: number, symbol: string): number {
  if (symbol === 'HG=F') return price * LB_PER_TONNE;
  if (symbol === 'ALI=F') return price;
  throw new Error(`toUsdTonne called with unexpected symbol: ${symbol}`);
}

function unitForSymbol(symbol: string): 'tonne' | 'troy_oz' {
  return symbol === 'HG=F' || symbol === 'ALI=F' ? 'tonne' : 'troy_oz';
}

function normalise(price: number, symbol: string): number {
  return unitForSymbol(symbol) === 'tonne' ? toUsdTonne(price, symbol) : price;
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function fetchYahooQuote(
  symbol: string,
): Promise<{ price: number; prev_close: number | null; as_of: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const q = await yahooFinance.quote(symbol);
      const price = q.regularMarketPrice;
      if (price == null) return null;
      const prev_close = q.regularMarketPreviousClose ?? null;
      const as_of = q.regularMarketTime
        ? new Date(q.regularMarketTime).toISOString()
        : new Date().toISOString();
      return { price, prev_close, as_of };
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
  return null;
}

async function buildPriceRow(
  symbol: string,
  metal: YahooMetal,
  is_fallback: boolean,
): Promise<YahooPriceRow> {
  const unit = unitForSymbol(symbol);
  const raw = await fetchYahooQuote(symbol);
  if (!raw) throw new Error(`fetchYahooQuote returned null for ${symbol}`);

  const price = normalise(raw.price, symbol);
  const prev_close = raw.prev_close != null ? normalise(raw.prev_close, symbol) : null;
  const change_pct = prev_close != null
    ? roundTo2(((price - prev_close) / prev_close) * 100)
    : null;

  return { metal, contract: 'front_month', price, currency: 'USD', unit, as_of: raw.as_of, prev_close, change_pct, raw_symbol: symbol, is_fallback };
}

/**
 * Fetches COMEX copper (HG=F), gold (GC=F), and silver (SI=F).
 * These are the canonical Yahoo responsibilities — never marked as fallback.
 */
export async function fetchYahooPrimary(): Promise<YahooFetchResult> {
  const fetched_at = new Date().toISOString();
  const prices: YahooPriceRow[] = [];
  const errors: string[] = [];

  await Promise.all(
    PRIMARY_SYMBOLS.map(async ({ symbol, metal }) => {
      try {
        prices.push(await buildPriceRow(symbol, metal, false));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[yahoo] ERROR fetching ${symbol}: ${msg}`);
        errors.push(`${symbol}: ${msg}`);
      }
    }),
  );

  const order: YahooMetal[] = ['copper', 'gold', 'silver'];
  prices.sort((a, b) => order.indexOf(a.metal) - order.indexOf(b.metal));

  const status = errors.length === 0 ? 'success' : prices.length === 0 ? 'failed' : 'partial';
  return { status, prices, source: 'yahoo', fetched_at, errors };
}

/**
 * Fetches fallback-indicative prices for the requested LME metals.
 * Every returned row has is_fallback: true.
 * Silently skips metals with no Yahoo equivalent (zinc, nickel, lead, tin).
 */
export async function fetchYahooFallback(metals: YahooMetal[]): Promise<YahooFetchResult> {
  const fetched_at = new Date().toISOString();
  const prices: YahooPriceRow[] = [];
  const errors: string[] = [];

  const actionable = metals.filter((m) => FALLBACK_SYMBOL_MAP[m] != null);
  const skipped = metals.filter((m) => FALLBACK_SYMBOL_MAP[m] == null);
  if (skipped.length > 0) {
    console.log(`[yahoo] No fallback available for: ${skipped.join(', ')} — skipping`);
  }

  await Promise.all(
    actionable.map(async (metal) => {
      const symbol = FALLBACK_SYMBOL_MAP[metal]!;
      try {
        prices.push(await buildPriceRow(symbol, metal, true));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[yahoo] ERROR fetching fallback ${symbol}: ${msg}`);
        errors.push(`${symbol}: ${msg}`);
      }
    }),
  );

  const status = errors.length === 0 ? 'success' : prices.length === 0 && actionable.length > 0 ? 'failed' : 'partial';
  return { status, prices, source: 'yahoo', fetched_at, errors };
}

/**
 * Fetches HG=F daily closes for the last N calendar days, converted to USD/tonne.
 * Used for the LME–COMEX arb sparkline.
 */
export async function fetchCopperHistorical(days: number): Promise<YahooHistoricalPoint[]> {
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - days * 24 * 60 * 60 * 1000);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const candles = await yahooFinance.historical('HG=F', { period1, period2, interval: '1d' });
      return candles
        .filter((c: any): c is typeof c & { close: number } => c.close != null)
        .map((c: any) => ({
          date: new Date(c.date).toISOString().slice(0, 10),
          close: roundTo2(toUsdTonne(c.close, 'HG=F')),
        }))
        .sort((a: YahooHistoricalPoint, b: YahooHistoricalPoint) => a.date.localeCompare(b.date));
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      console.error(`[yahoo] ERROR fetching HG=F historical: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  return [];
}
