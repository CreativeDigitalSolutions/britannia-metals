/**
 * Yahoo Finance data source module.
 *
 * Provides:
 *  - COMEX copper (HG=F) prices for the LME–COMEX arb panel
 *  - Gold (GC=F) and silver (SI=F) prices for the precious metals dashboard tiles
 *  - Fallback indicative prices for LME base metals when the LME module fails
 *
 * Zero dependencies on Supabase, the frontend, or any other session's work.
 * Importable as an ES module by a Supabase Edge Function.
 *
 * Uses yahoo-finance2 v3 — instantiate the class, pass suppressNotices in ctor.
 */

import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type YahooMetal = 'copper' | 'aluminium' | 'gold' | 'silver';

export interface YahooPriceRow {
  metal: YahooMetal;
  contract: 'front_month';
  price: number;
  currency: 'USD';
  unit: 'tonne' | 'troy_oz';
  as_of: string;         // ISO 8601 UTC
  prev_close: number | null;
  change_pct: number | null;
  raw_symbol: string;
  is_fallback: boolean;
}

export interface YahooHistoricalPoint {
  date: string;          // YYYY-MM-DD
  close: number;         // normalised to the metal's unit
}

export interface YahooFetchResult {
  status: 'success' | 'partial' | 'failed';
  prices: YahooPriceRow[];
  source: 'yahoo';
  fetched_at: string;
  errors: string[];
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const LB_PER_TONNE = 2204.62;

/** Symbols for which we have a Yahoo fallback for LME metals */
const FALLBACK_SYMBOL_MAP: Partial<Record<YahooMetal, string>> = {
  copper: 'HG=F',
  aluminium: 'ALI=F',
  // zinc, nickel, lead, tin intentionally omitted — no clean Yahoo equivalent
};

const PRIMARY_SYMBOLS: Array<{ symbol: string; metal: YahooMetal }> = [
  { symbol: 'HG=F', metal: 'copper' },
  { symbol: 'GC=F', metal: 'gold' },
  { symbol: 'SI=F', metal: 'silver' },
];

// ---------------------------------------------------------------------------
// Unit conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a raw Yahoo price (USD/lb) to USD/tonne for tonne-unit metals.
 * Gold/silver bypass this entirely — they stay in troy oz.
 */
function toUsdTonne(price: number, symbol: string): number {
  if (symbol === 'HG=F') return price * LB_PER_TONNE;
  if (symbol === 'ALI=F') return price; // already USD/tonne
  throw new Error(`toUsdTonne called with unexpected symbol: ${symbol}`);
}

function unitForSymbol(symbol: string): 'tonne' | 'troy_oz' {
  if (symbol === 'HG=F' || symbol === 'ALI=F') return 'tonne';
  return 'troy_oz';
}

function normalise(price: number, symbol: string): number {
  return unitForSymbol(symbol) === 'tonne' ? toUsdTonne(price, symbol) : price;
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Low-level quote fetcher (with one retry on transient failure)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Build a YahooPriceRow from a symbol + metal
// ---------------------------------------------------------------------------

async function buildPriceRow(
  symbol: string,
  metal: YahooMetal,
  is_fallback: boolean,
): Promise<YahooPriceRow> {
  const start = Date.now();
  const unit = unitForSymbol(symbol);

  const raw = await fetchYahooQuote(symbol);
  if (!raw) throw new Error(`fetchYahooQuote returned null for ${symbol}`);

  const price = normalise(raw.price, symbol);
  const prev_close =
    raw.prev_close != null ? normalise(raw.prev_close, symbol) : null;

  const change_pct =
    prev_close != null
      ? roundTo2(((price - prev_close) / prev_close) * 100)
      : null;

  const elapsed = Date.now() - start;

  if (unit === 'tonne') {
    console.log(
      `[yahoo] ${symbol}: $${raw.price.toFixed(4)}/lb → $${Math.round(price)}/t` +
        (prev_close != null
          ? ` (prev $${Math.round(prev_close)}, ${change_pct !== null && change_pct >= 0 ? '+' : ''}${change_pct}%)`
          : '') +
        ` in ${elapsed}ms`,
    );
  } else {
    console.log(
      `[yahoo] ${symbol}: $${price.toFixed(2)}/troy oz` +
        (prev_close != null
          ? ` (prev $${prev_close.toFixed(2)}, ${change_pct !== null && change_pct >= 0 ? '+' : ''}${change_pct}%)`
          : '') +
        ` in ${elapsed}ms`,
    );
  }

  return {
    metal,
    contract: 'front_month',
    price,
    currency: 'USD',
    unit,
    as_of: raw.as_of,
    prev_close,
    change_pct,
    raw_symbol: symbol,
    is_fallback,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
        const row = await buildPriceRow(symbol, metal, false);
        prices.push(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[yahoo] ERROR fetching ${symbol}: ${msg}`);
        errors.push(`${symbol}: ${msg}`);
      }
    }),
  );

  // Sort into predictable order: copper, gold, silver
  const order: YahooMetal[] = ['copper', 'gold', 'silver'];
  prices.sort((a, b) => order.indexOf(a.metal) - order.indexOf(b.metal));

  const status =
    errors.length === 0
      ? 'success'
      : prices.length === 0
        ? 'failed'
        : 'partial';

  return { status, prices, source: 'yahoo', fetched_at, errors };
}

/**
 * Fetches fallback-indicative prices for the requested LME metals.
 * Every returned row has is_fallback: true.
 * Silently skips metals with no Yahoo equivalent (zinc, nickel, lead, tin).
 */
export async function fetchYahooFallback(
  metals: YahooMetal[],
): Promise<YahooFetchResult> {
  const fetched_at = new Date().toISOString();
  const prices: YahooPriceRow[] = [];
  const errors: string[] = [];

  const actionable = metals.filter((m) => FALLBACK_SYMBOL_MAP[m] != null);
  const skipped = metals.filter((m) => FALLBACK_SYMBOL_MAP[m] == null);

  if (skipped.length > 0) {
    console.log(
      `[yahoo] No fallback available for: ${skipped.join(', ')} — skipping`,
    );
  }

  await Promise.all(
    actionable.map(async (metal) => {
      const symbol = FALLBACK_SYMBOL_MAP[metal]!;
      try {
        const row = await buildPriceRow(symbol, metal, true);
        prices.push(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[yahoo] ERROR fetching fallback ${symbol}: ${msg}`);
        errors.push(`${symbol}: ${msg}`);
      }
    }),
  );

  const status =
    errors.length === 0
      ? 'success'
      : prices.length === 0 && actionable.length > 0
        ? 'failed'
        : 'partial';

  return { status, prices, source: 'yahoo', fetched_at, errors };
}

/**
 * Fetches HG=F daily closes for the last N calendar days, converted to USD/tonne.
 * Used for the LME–COMEX arb sparkline.
 */
export async function fetchCopperHistorical(
  days: number,
): Promise<YahooHistoricalPoint[]> {
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - days * 24 * 60 * 60 * 1000);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const candles = await yahooFinance.historical('HG=F', {
        period1,
        period2,
        interval: '1d',
      });

      const points: YahooHistoricalPoint[] = candles
        .filter((c): c is typeof c & { close: number } => c.close != null)
        .map((c) => ({
          date: c.date.toISOString().slice(0, 10),
          close: roundTo2(toUsdTonne(c.close, 'HG=F')),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      console.log(
        `[yahoo] HG=F historical: ${points.length} sessions over last ${days} calendar days`,
      );
      return points;
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      console.error(
        `[yahoo] ERROR fetching HG=F historical: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Standalone entry point — run with: npx tsx lib/sources/yahoo.ts
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const primary = await fetchYahooPrimary();
    const fallback = await fetchYahooFallback(['copper', 'aluminium']);
    const hist = await fetchCopperHistorical(30);
    console.log(
      JSON.stringify(
        { primary, fallback, historical_sample: hist.slice(-5) },
        null,
        2,
      ),
    );
    process.exit(primary.status === 'failed' ? 1 : 0);
  })();
}
