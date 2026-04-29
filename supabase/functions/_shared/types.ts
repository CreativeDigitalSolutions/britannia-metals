/**
 * Shared database types for Britannia Metals Edge Functions.
 * Mirrors /types/database.ts — if they drift, that is a bug.
 */

export type Metal = 'copper' | 'aluminium' | 'zinc' | 'nickel' | 'lead' | 'tin' | 'gold' | 'silver';
export type Sentiment = 'bullish' | 'bearish' | 'neutral';
export type PriceSource = 'lme_official' | 'yahoo' | 'yahoo_fallback';
export type PriceContract = 'cash' | '3m' | 'front_month';
export type PriceUnit = 'tonne' | 'troy_oz' | 'lb';
export type CronStatus = 'success' | 'partial' | 'failed';

export interface NewsRow {
  id: string;
  source: string;
  headline: string;
  url: string;
  summary: string | null;
  published_at: string;          // ISO 8601 timestamptz
  metals: Metal[] | null;
  sentiment: Sentiment | null;
  sentiment_rationale: string | null;
  relevant: boolean | null;      // null = unclassified
  created_at: string;
}

export interface PriceInsert {
  metal: Metal;
  source: PriceSource;
  contract: PriceContract;
  price: number;
  currency: 'USD';
  unit: PriceUnit;
  as_of: string;           // ISO 8601 timestamptz
  prev_close: number | null;
  change_pct: number | null;
}

export interface LmeStockInsert {
  metal: Metal;
  on_warrant: number;
  cancelled_warrants: number;
  total_stock: number;
  as_of: string;           // YYYY-MM-DD
}

export interface ArbHistoryInsert {
  as_of: string;           // YYYY-MM-DD
  lme_copper_usd_tonne: number;
  comex_copper_usd_tonne: number;
  // spread_usd and spread_pct are generated columns — do NOT include in inserts
}

export interface CronLogInsert {
  job: string;
  status: CronStatus;
  message: string;
}
