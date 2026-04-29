/**
 * ingest-prices — Supabase Edge Function
 *
 * Wave 2 / Session F: Fetches metal prices from LME + Yahoo Finance, applies
 * fallback logic, and writes normalised rows to Supabase tables.
 *
 * IMPORTANT — LME CLOUDFLARE SITUATION (as of April 2026)
 * --------------------------------------------------------
 * lme.com is behind Cloudflare's managed-challenge (JS execution challenge).
 * Server-side HTTP clients (Deno fetch, Node fetch) CANNOT pass this challenge —
 * only a real browser runtime can. Therefore every call to fetchLmeData() will
 * return { status: 'failed', reason: 'Cloudflare...' }. This is a known,
 * accepted constraint. When LME fails:
 *   - copper + aluminium: use Yahoo Finance fallback (HG=F / ALI=F), marked
 *     source: 'yahoo_fallback' in the prices table
 *   - zinc, nickel, lead, tin: NO rows written (frontend renders "data unavailable")
 *   - lme_stocks: nothing written (frontend detects empty table and renders accordingly)
 *   - arb_history: written with both LME and COMEX values set to Yahoo HG=F
 *     (spread_usd = 0, which is technically correct; UI shows "n/a")
 *   - cron_log: LME failure reason logged clearly
 *
 * To restore LME functionality: inject a valid Cloudflare session cookie via
 * CF_CLEARANCE env var, request LME to whitelist Supabase IP ranges, or
 * upgrade to the LME XML feed subscription (~$2,565/year).
 *
 * HTTP endpoint: POST /functions/v1/ingest-prices
 * Auth:          Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 * Scheduled:     Called by pg_cron (Wave 4) — do not expose publicly
 */

import { createSupabaseServiceClient } from '../_shared/supabase-client.ts';
import {
  fetchLmeData,
  fetchYahooPrimary,
  fetchYahooFallback,
  type LmePriceRow,
  type LmeStockRow,
  type YahooPriceRow,
} from '../_shared/price-fetchers.ts';
import type { PriceInsert, LmeStockInsert, ArbHistoryInsert, CronLogInsert } from '../_shared/types.ts';

// ---------------------------------------------------------------------------
// Response shape (also written to cron_log.message as JSON)
// ---------------------------------------------------------------------------

interface IngestSummary {
  status: 'success' | 'partial' | 'failed';
  prices_written: number;
  stocks_written: number;
  arb_written: boolean;
  lme_status: 'success' | 'partial' | 'failed';
  yahoo_status: 'success' | 'partial' | 'failed';
  fallback_activated: boolean;
  duration_ms: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function lmePriceToInsert(row: LmePriceRow): PriceInsert {
  return {
    metal: row.metal,
    source: 'lme_official',
    contract: row.contract,
    price: row.price,
    currency: 'USD',
    unit: 'tonne',
    as_of: row.as_of,
    prev_close: row.prev_close,
    change_pct: row.change_pct,
  };
}

function yahooPriceToInsert(row: YahooPriceRow, forceSource?: 'yahoo' | 'yahoo_fallback'): PriceInsert {
  return {
    metal: row.metal,
    source: forceSource ?? (row.is_fallback ? 'yahoo_fallback' : 'yahoo'),
    contract: row.contract,
    price: row.price,
    currency: 'USD',
    unit: row.unit,
    as_of: row.as_of,
    prev_close: row.prev_close,
    change_pct: row.change_pct,
  };
}

function lmeStockToInsert(row: LmeStockRow): LmeStockInsert {
  return {
    metal: row.metal,
    on_warrant: row.on_warrant,
    cancelled_warrants: row.cancelled_warrants,
    total_stock: row.total_stock,
    as_of: row.as_of,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const errors: string[] = [];

  // ── 1. Auth check ─────────────────────────────────────────────────────────
  // Strategy: decode the JWT payload (no crypto needed — Supabase already
  // verified the signature at the platform level before the function runs).
  // We check that the JWT role claim is 'service_role' to block anon callers.
  // Additionally accept exact match against INGEST_SERVICE_KEY (our explicit secret)
  // as a belt-and-suspenders fallback.
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized — missing Bearer token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Decode JWT payload to check role claim
  let jwtRole: string | null = null;
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      // base64url decode the payload
      const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = payloadB64 + '=='.slice((payloadB64.length + 3) & ~3);
      const payloadJson = atob(padded);
      const payload = JSON.parse(payloadJson);
      jwtRole = payload.role ?? null;
    }
  } catch {
    // Invalid JWT structure — fall through to explicit key check
  }

  // Accept if role is service_role OR if token matches the explicit secret
  const explicitKey = Deno.env.get('INGEST_SERVICE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorized = jwtRole === 'service_role' || (explicitKey && token === explicitKey);

  if (!authorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized — service_role required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createSupabaseServiceClient();

  // ── 2. Fetch LME (expected to fail with Cloudflare block) ─────────────────
  console.log('[ingest-prices] Starting — fetching LME data…');
  const lmeResult = await fetchLmeData();

  if (lmeResult.status === 'failed' || lmeResult.status === 'partial') {
    const reason = lmeResult.reason ?? `LME returned status: ${lmeResult.status}`;
    console.warn(`[ingest-prices] LME failed: ${reason}`);
    errors.push(`LME: ${reason}`);
    errors.push(...lmeResult.errors);
  }

  // ── 3. Fetch Yahoo primary (always — COMEX copper, gold, silver) ──────────
  console.log('[ingest-prices] Fetching Yahoo primary (HG=F, GC=F, SI=F)…');
  const yahooResult = await fetchYahooPrimary();

  if (yahooResult.status !== 'success') {
    errors.push(...yahooResult.errors.map((e) => `Yahoo primary: ${e}`));
  }

  // ── 4. Fallback for copper + aluminium when LME failed ────────────────────
  let fallbackActivated = false;
  let fallbackResult: Awaited<ReturnType<typeof fetchYahooFallback>> | null = null;

  if (lmeResult.status === 'failed' || lmeResult.status === 'partial') {
    console.warn('[ingest-prices] LME failed — activating Yahoo fallback for copper + aluminium');
    fallbackActivated = true;
    fallbackResult = await fetchYahooFallback(['copper', 'aluminium']);
    if (fallbackResult.status !== 'success') {
      errors.push(...fallbackResult.errors.map((e) => `Yahoo fallback: ${e}`));
    }
    // zinc, nickel, lead, tin: intentionally no fallback — see file header
    console.log('[ingest-prices] No Yahoo fallback for zinc/nickel/lead/tin — those tiles will show "data unavailable"');
  }

  // ── 5. Compose price rows ─────────────────────────────────────────────────
  const priceRows: PriceInsert[] = [];

  // LME rows (if LME succeeded fully or partially)
  for (const row of lmeResult.prices) {
    priceRows.push(lmePriceToInsert(row));
  }

  // Yahoo primary rows (COMEX copper, gold, silver) — de-duplicate by metal+contract
  // (copper from Yahoo primary may overlap with LME copper; they are different sources, so both can coexist)
  for (const row of yahooResult.prices) {
    priceRows.push(yahooPriceToInsert(row));
  }

  // Yahoo fallback rows for copper + aluminium (LME failed path only)
  if (fallbackResult) {
    for (const row of fallbackResult.prices) {
      // Ensure source is explicitly 'yahoo_fallback'
      priceRows.push(yahooPriceToInsert(row, 'yahoo_fallback'));
    }
  }

  // ── 6. Upsert prices ──────────────────────────────────────────────────────
  let pricesWritten = 0;
  if (priceRows.length > 0) {
    const { error: pricesError, data: pricesData } = await supabase
      .from('prices')
      .upsert(priceRows, { onConflict: 'metal,source,contract,as_of' })
      .select('id');

    if (pricesError) {
      const msg = `prices upsert failed: ${pricesError.message}`;
      console.error(`[ingest-prices] ${msg}`);
      errors.push(msg);
    } else {
      pricesWritten = pricesData?.length ?? priceRows.length;
      console.log(`[ingest-prices] Wrote ${pricesWritten} price rows`);
    }
  } else {
    console.warn('[ingest-prices] No price rows to write — both LME and Yahoo returned nothing');
    errors.push('No price rows written — all data sources returned empty results');
  }

  // ── 7. Upsert LME stocks (only when LME succeeded) ────────────────────────
  let stocksWritten = 0;
  if (lmeResult.status === 'success' || lmeResult.status === 'partial') {
    const stockRows: LmeStockInsert[] = lmeResult.stocks.map(lmeStockToInsert);
    if (stockRows.length > 0) {
      const { error: stocksError, data: stocksData } = await supabase
        .from('lme_stocks')
        .upsert(stockRows, { onConflict: 'metal,as_of' })
        .select('id');

      if (stocksError) {
        const msg = `lme_stocks upsert failed: ${stocksError.message}`;
        console.error(`[ingest-prices] ${msg}`);
        errors.push(msg);
      } else {
        stocksWritten = stocksData?.length ?? stockRows.length;
        console.log(`[ingest-prices] Wrote ${stocksWritten} stock rows`);
      }
    }
  } else {
    console.log('[ingest-prices] LME failed — skipping lme_stocks write (frontend will detect empty table)');
  }

  // ── 8. Compute and write arb ───────────────────────────────────────────────
  let arbWritten = false;

  // Determine the LME 3M copper price for arb
  // Prefer LME official; fall back to Yahoo HG=F (which is COMEX copper, USD/tonne)
  const lme3mCopper = lmeResult.prices.find((r) => r.metal === 'copper' && r.contract === '3m');
  const yahooCopperRow = yahooResult.prices.find((r) => r.metal === 'copper');

  // COMEX copper is always Yahoo HG=F converted to USD/tonne
  const comexCopperUsdTonne = yahooCopperRow?.price ?? null;

  let lmeCopperUsdTonne: number | null = null;
  let arbDegenerateCase = false;

  if (lme3mCopper) {
    lmeCopperUsdTonne = lme3mCopper.price;
    console.log(`[ingest-prices] Arb: using LME 3M copper = $${lmeCopperUsdTonne.toFixed(2)}/t`);
  } else if (comexCopperUsdTonne != null) {
    // LME failed — use Yahoo HG=F as a stand-in for LME (degenerate: spread = 0)
    lmeCopperUsdTonne = comexCopperUsdTonne;
    arbDegenerateCase = true;
    const msg = 'Arb: LME 3M copper unavailable — using Yahoo HG=F for both slots. spread_usd = 0 (degenerate case). Frontend should show "n/a".';
    console.warn(`[ingest-prices] ${msg}`);
    errors.push(msg);
  }

  if (lmeCopperUsdTonne != null && comexCopperUsdTonne != null) {
    const today = new Date().toISOString().slice(0, 10);
    const arbRow: ArbHistoryInsert = {
      as_of: today,
      lme_copper_usd_tonne: lmeCopperUsdTonne,
      comex_copper_usd_tonne: comexCopperUsdTonne,
    };

    const { error: arbError } = await supabase
      .from('arb_history')
      .upsert(arbRow, { onConflict: 'as_of' });

    if (arbError) {
      const msg = `arb_history upsert failed: ${arbError.message}`;
      console.error(`[ingest-prices] ${msg}`);
      errors.push(msg);
    } else {
      arbWritten = true;
      const spread = comexCopperUsdTonne - lmeCopperUsdTonne;
      console.log(
        `[ingest-prices] Arb written: LME $${lmeCopperUsdTonne.toFixed(2)}, COMEX $${comexCopperUsdTonne.toFixed(2)}, spread $${spread.toFixed(2)}${arbDegenerateCase ? ' (degenerate — LME unavailable)' : ''}`,
      );
    }
  } else {
    const msg = 'Arb skipped — insufficient copper price data (both LME and Yahoo copper are null)';
    console.warn(`[ingest-prices] ${msg}`);
    errors.push(msg);
  }

  // ── 9. Write cron_log ──────────────────────────────────────────────────────
  const duration_ms = Date.now() - t0;

  // Determine overall status
  let overallStatus: IngestSummary['status'];
  if (yahooResult.status === 'failed' && lmeResult.status === 'failed') {
    overallStatus = 'failed';
  } else if (errors.length > 0 || lmeResult.status === 'failed') {
    overallStatus = 'partial';
  } else {
    overallStatus = 'success';
  }

  const summary: IngestSummary = {
    status: overallStatus,
    prices_written: pricesWritten,
    stocks_written: stocksWritten,
    arb_written: arbWritten,
    lme_status: lmeResult.status,
    yahoo_status: yahooResult.status,
    fallback_activated: fallbackActivated,
    duration_ms,
    errors,
  };

  const logRow: CronLogInsert = {
    job: 'ingest-prices',
    status: overallStatus,
    message: JSON.stringify(summary),
  };

  const { error: logError } = await supabase.from('cron_log').insert(logRow);
  if (logError) {
    console.error(`[ingest-prices] cron_log write failed: ${logError.message}`);
  }

  console.log(
    `[ingest-prices] Complete in ${duration_ms}ms — ` +
    `status=${overallStatus}, prices=${pricesWritten}, stocks=${stocksWritten}, arb=${arbWritten}, ` +
    `lme=${lmeResult.status}, yahoo=${yahooResult.status}, fallback=${fallbackActivated}, errors=${errors.length}`,
  );

  // ── 10. Return JSON summary ────────────────────────────────────────────────
  return new Response(JSON.stringify(summary, null, 2), {
    status: overallStatus === 'failed' ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
