// ─────────────────────────────────────────────────────────────────────────────
// Britannia Metals Desk — Data Fetching Helpers (Wave 2)
// All helpers are server-side only. Each returns sensible defaults on failure.
// ─────────────────────────────────────────────────────────────────────────────

import { getSupabaseServer } from '@/lib/supabase/server';
import type {
  PriceRow,
  LmeStockRow,
  ArbHistoryRow,
  NewsRow,
  BriefRow,
  PriceSource,
} from '@/types/database';
import type { Metal, MetalConfig } from '@/lib/metals';
import { BASE_METALS as BASE_METAL_CONFIGS, PRECIOUS_METALS as PRECIOUS_METAL_CONFIGS } from '@/lib/metals';
import eventsData from '@/lib/events.json';

// Re-export DB row types for component consumption
export type { PriceRow, LmeStockRow, ArbHistoryRow, NewsRow, BriefRow };

// ── Display types ─────────────────────────────────────────────────────────────

export interface MetalDisplayData {
  id: string;
  name: string;
  symbol: string;
  cashPrice: number | null;
  threeMonthPrice: number | null;
  spreadType: 'contango' | 'backwardation' | null;
  spreadAmount: number | null;
  dayChangePercent: number | null;
  dayChangeDollar: number | null;
  stockTonnes: number | null;       // null = hide the stock row entirely
  cancelledWarrantsPercent: number | null;
  unit: 'tonne' | 'troy oz';
  source: PriceSource | null;       // for source badge
  unavailable: boolean;             // true when no price data exists for this metal
}

export interface Event {
  id: string;
  dateLabel: string;
  daysFromNow: number;
  name: string;
  impact: 'high' | 'medium' | 'low';
  relevantMetals: string[];
}

export interface PricePoint {
  day: number;
  price: number;
}

// ── Transformation helpers ────────────────────────────────────────────────────

/**
 * Build MetalDisplayData[] from raw DB rows for a given set of metal configs.
 * Call once for base metals (BASE_METAL_CONFIGS) and once for precious (PRECIOUS_METAL_CONFIGS).
 */
export function buildMetalDisplayData(
  metals: MetalConfig[],
  prices: PriceRow[],
  stocks: LmeStockRow[]
): MetalDisplayData[] {
  return metals.map((metalConfig) => {
    const cashRows = prices
      .filter((p) => p.metal === metalConfig.id && p.contract === 'cash')
      .sort((a, b) => new Date(b.as_of).getTime() - new Date(a.as_of).getTime());

    const threeMonthRows = prices
      .filter((p) => p.metal === metalConfig.id && p.contract === '3m')
      .sort((a, b) => new Date(b.as_of).getTime() - new Date(a.as_of).getTime());

    const cashRow = cashRows[0] ?? null;
    const threeMonthRow = threeMonthRows[0] ?? null;

    const stockRow =
      stocks
        .filter((s) => s.metal === metalConfig.id)
        .sort((a, b) => new Date(b.as_of).getTime() - new Date(a.as_of).getTime())[0] ?? null;

    const unit: 'tonne' | 'troy oz' = metalConfig.unit === 'troy_oz' ? 'troy oz' : 'tonne';

    if (!cashRow) {
      return {
        id: metalConfig.id,
        name: metalConfig.display_name,
        symbol: metalConfig.symbol,
        cashPrice: null,
        threeMonthPrice: null,
        spreadType: null,
        spreadAmount: null,
        dayChangePercent: null,
        dayChangeDollar: null,
        stockTonnes: null,
        cancelledWarrantsPercent: null,
        unit,
        source: null,
        unavailable: true,
      };
    }

    const cashPrice = cashRow.price;
    const threeMonthPrice = threeMonthRow?.price ?? null;

    let spreadType: 'contango' | 'backwardation' | null = null;
    let spreadAmount: number | null = null;
    if (threeMonthPrice !== null) {
      const diff = threeMonthPrice - cashPrice;
      spreadAmount = Math.abs(diff);
      spreadType = diff > 0 ? 'contango' : 'backwardation';
    }

    return {
      id: metalConfig.id,
      name: metalConfig.display_name,
      symbol: metalConfig.symbol,
      cashPrice,
      threeMonthPrice,
      spreadType,
      spreadAmount,
      dayChangePercent: cashRow.change_pct ?? null,
      dayChangeDollar:
        cashRow.prev_close !== null ? cashPrice - cashRow.prev_close : null,
      stockTonnes: stockRow?.total_stock ?? null,
      cancelledWarrantsPercent: stockRow?.cancelled_pct ?? null,
      unit,
      source: cashRow.source,
      unavailable: false,
    };
  });
}

/**
 * Build a PricePoint[] for the 30-day copper chart from arb_history rows.
 * arb_history contains lme_copper_usd_tonne for each day — ideal for the chart stub.
 */
export function buildCopperPricePoints(arbHistory: ArbHistoryRow[]): PricePoint[] {
  return arbHistory.map((row, i) => ({
    day: i + 1,
    price: row.lme_copper_usd_tonne,
  }));
}

// ── Data fetching helpers ─────────────────────────────────────────────────────

/**
 * Fetch all price rows from the last 48 hours.
 * Covers the most recent cash and 3M rows for every metal.
 */
export async function getLatestPrices(): Promise<PriceRow[]> {
  try {
    const supabase = getSupabaseServer();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('prices')
      .select('*')
      .gte('as_of', cutoff)
      .order('as_of', { ascending: false });

    if (error) {
      console.error('[getLatestPrices]', error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    console.error('[getLatestPrices] unexpected error:', err);
    return [];
  }
}

/**
 * Fetch most recent lme_stocks rows.
 * NOTE: This table is expected to be empty — LME is Cloudflare-blocked.
 * Returns [] gracefully.
 */
export async function getLatestStocks(): Promise<LmeStockRow[]> {
  try {
    const supabase = getSupabaseServer();
    const { data, error } = await supabase
      .from('lme_stocks')
      .select('*')
      .order('as_of', { ascending: false })
      .limit(20);

    if (error) {
      console.error('[getLatestStocks]', error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    console.error('[getLatestStocks] unexpected error:', err);
    return [];
  }
}

/**
 * Fetch the most recent arb_history row for the current ArbPanel values.
 */
export async function getLatestArb(): Promise<ArbHistoryRow | null> {
  try {
    const supabase = getSupabaseServer();
    const { data, error } = await supabase
      .from('arb_history')
      .select('*')
      .order('as_of', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code !== 'PGRST116') {
        // PGRST116 = no rows found — expected when DB is empty
        console.error('[getLatestArb]', error.message);
      }
      return null;
    }
    return data;
  } catch (err) {
    console.error('[getLatestArb] unexpected error:', err);
    return null;
  }
}

/**
 * Fetch arb_history rows for the last N days, ordered ascending (for sparkline).
 */
export async function getArbHistory(days: number): Promise<ArbHistoryRow[]> {
  try {
    const supabase = getSupabaseServer();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]; // YYYY-MM-DD — arb_history uses date, not timestamp

    const { data, error } = await supabase
      .from('arb_history')
      .select('*')
      .gte('as_of', cutoff)
      .order('as_of', { ascending: true });

    if (error) {
      console.error('[getArbHistory]', error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    console.error('[getArbHistory] unexpected error:', err);
    return [];
  }
}

/**
 * Fetch recent news items ordered newest-first.
 * Classification fields (sentiment, metals) will be null until Session I (Wave 3) runs.
 */
export async function getRecentNews(limit: number): Promise<NewsRow[]> {
  try {
    const supabase = getSupabaseServer();
    const { data, error } = await supabase
      .from('news')
      .select('*')
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[getRecentNews]', error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    console.error('[getRecentNews] unexpected error:', err);
    return [];
  }
}

/**
 * Fetch today's morning brief.
 * Returns null until Session J (Wave 3) generates the first brief.
 */
export async function getTodaysBrief(): Promise<BriefRow | null> {
  try {
    const supabase = getSupabaseServer();
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const { data, error } = await supabase
      .from('briefs')
      .select('*')
      .eq('for_date', today)
      .order('generated_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code !== 'PGRST116') {
        console.error('[getTodaysBrief]', error.message);
      }
      return null;
    }
    return data;
  } catch (err) {
    console.error('[getTodaysBrief] unexpected error:', err);
    return null;
  }
}

interface RawEvent {
  date: string;
  time: string | null;
  event: string;
  category: string;
  impact: 'high' | 'medium' | 'low';
  metals: string[];
}

/**
 * Read events.json, filter to upcoming dates, return next 8 events.
 * No DB call — this is static seed data.
 */
export async function getUpcomingEvents(): Promise<Event[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const raw = eventsData as RawEvent[];
  const msPerDay = 24 * 60 * 60 * 1000;

  const upcoming = raw
    .filter((e) => new Date(e.date) >= today)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 8);

  return upcoming.map((e, i) => {
    const eventDate = new Date(e.date);
    const daysFromNow = Math.round(
      (eventDate.getTime() - today.getTime()) / msPerDay
    );

    const timeStr = e.time ? ` · ${e.time}` : '';
    let dateLabel: string;
    if (daysFromNow === 0) {
      dateLabel = `Today${timeStr}`;
    } else if (daysFromNow === 1) {
      dateLabel = `Tomorrow${timeStr}`;
    } else {
      const formatted = eventDate.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      dateLabel = `${formatted}${timeStr}`;
    }

    const relevantMetals =
      e.metals.length === 0
        ? []
        : e.metals.map((m) => m.charAt(0).toUpperCase() + m.slice(1));

    return {
      id: `${e.date}-${i}`,
      dateLabel,
      daysFromNow,
      name: e.event,
      impact: e.impact,
      relevantMetals,
    };
  });
}

/**
 * Fetch 30-day price history for a given metal, ordered ascending (for charts).
 * Pulls 'cash' rows for base metals, 'front_month' rows for precious.
 * Returns [] on any error or when LME feed is blocked for that metal.
 */
export async function getPriceHistory(metal: Metal, days: number): Promise<PriceRow[]> {
  try {
    const supabase = getSupabaseServer();
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const { data, error } = await supabase
      .from('prices')
      .select('*')
      .eq('metal', metal)
      .in('contract', ['cash', 'front_month'])
      .gte('as_of', since)
      .order('as_of', { ascending: true });

    if (error) {
      console.error('[getPriceHistory]', error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    console.error('[getPriceHistory] unexpected error:', err);
    return [];
  }
}

// Convenience re-exports so page.tsx has a single import point
export { BASE_METAL_CONFIGS, PRECIOUS_METAL_CONFIGS };
