// Database types — mirrors the Supabase schema in /supabase/migrations/0001_initial_schema.sql
// If this file and that migration drift, it is a bug.

import type { Metal } from '@/lib/metals';

export type PriceSource = 'lme_official' | 'yahoo' | 'yahoo_fallback';
export type PriceContract = 'cash' | '3m' | 'front_month';
export type PriceUnit = 'tonne' | 'troy_oz' | 'lb';
export type Currency = 'USD';

export type Sentiment = 'bullish' | 'bearish' | 'neutral';

export type CronStatus = 'success' | 'partial' | 'failed';

export interface PriceRow {
  id: string;
  metal: Metal;
  source: PriceSource;
  contract: PriceContract;
  price: number;
  currency: Currency;
  unit: PriceUnit;
  as_of: string;              // ISO 8601 timestamp
  prev_close: number | null;
  change_pct: number | null;
  created_at: string;
}

export interface LmeStockRow {
  id: string;
  metal: Metal;
  on_warrant: number | null;
  cancelled_warrants: number | null;
  total_stock: number | null;
  cancelled_pct: number;       // generated column; always present
  as_of: string;              // YYYY-MM-DD
  created_at: string;
}

export interface NewsRow {
  id: string;
  source: string;
  headline: string;
  url: string;
  summary: string | null;
  published_at: string;       // ISO 8601 timestamp
  metals: Metal[] | null;
  sentiment: Sentiment | null;
  sentiment_rationale: string | null;
  relevant: boolean | null;
  created_at: string;
}

export interface BriefRow {
  id: string;
  content: string;
  generated_at: string;
  for_date: string;           // YYYY-MM-DD
}

export interface ArbHistoryRow {
  id: string;
  as_of: string;              // YYYY-MM-DD
  lme_copper_usd_tonne: number;
  comex_copper_usd_tonne: number;
  spread_usd: number;         // generated column
  spread_pct: number;         // generated column
}

export interface CronLogRow {
  id: string;
  job: string;
  status: CronStatus;
  message: string | null;
  ran_at: string;
}

// Convenience — Supabase client Database interface
export interface Database {
  public: {
    Tables: {
      prices:       { Row: PriceRow;       Insert: Omit<PriceRow, 'id' | 'created_at'>;       Update: Partial<PriceRow>; };
      lme_stocks:   { Row: LmeStockRow;    Insert: Omit<LmeStockRow, 'id' | 'created_at' | 'cancelled_pct'>; Update: Partial<LmeStockRow>; };
      news:         { Row: NewsRow;        Insert: Omit<NewsRow, 'id' | 'created_at'>;        Update: Partial<NewsRow>; };
      briefs:       { Row: BriefRow;       Insert: Omit<BriefRow, 'id' | 'generated_at'>;     Update: Partial<BriefRow>; };
      arb_history:  { Row: ArbHistoryRow;  Insert: Omit<ArbHistoryRow, 'id' | 'spread_usd' | 'spread_pct'>; Update: Partial<ArbHistoryRow>; };
      cron_log:     { Row: CronLogRow;     Insert: Omit<CronLogRow, 'id' | 'ran_at'>;         Update: Partial<CronLogRow>; };
    };
  };
}
