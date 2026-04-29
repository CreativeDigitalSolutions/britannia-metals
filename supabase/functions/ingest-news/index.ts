/**
 * ingest-news — Supabase Edge Function
 *
 * Wave 2 / Session G: Fetches all 13 RSS/HTML news sources, deduplicates
 * against existing URLs in the news table (14-day window), and bulk-inserts
 * new headlines with classification fields left null.
 *
 * Classification (relevant, metals, sentiment) is handled by Wave 3 / Session I.
 *
 * HTTP endpoint: POST /functions/v1/ingest-news
 * Auth:          Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 * Scheduled:     Called every 2 hours by pg_cron (Wave 4)
 *
 * KNOWN PARTIAL FAILURES (expected, not bugs):
 *   - Kitco Mining: malformed XML feed
 *   - Mining Weekly: 403
 *   - LME Press Releases: Cloudflare-blocked
 * These three always appear in source_stats with errors. The other 10 succeed.
 */

import { createSupabaseServiceClient } from '../_shared/supabase-client.ts';
import { fetchAllNews } from '../_shared/news-fetcher.ts';
import type { CronLogInsert } from '../_shared/types.ts';

// ─── Response shape ───────────────────────────────────────────────────────────

interface IngestNewsSummary {
  status: 'success' | 'partial' | 'failed';
  items_fetched: number;       // raw count across all sources (sum of source_stats.fetched)
  items_deduped_rss: number;   // after fetchAllNews own dedup + relevance filter
  items_deduped_db: number;    // after DB dedup — these are genuinely new to the system
  items_inserted: number;      // rows actually written to DB
  source_stats: Array<{ source: string; fetched: number; errors: string[] }>;
  duration_ms: number;
  errors: string[];
}

// ─── DB insert shape — classification fields intentionally null ───────────────

interface NewsInsert {
  source: string;
  headline: string;
  url: string;
  summary: string | null;
  published_at: string;
  metals: null;
  sentiment: null;
  sentiment_rationale: null;
  relevant: null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const errors: string[] = [];

  // ── 1. Auth check — same JWT role + explicit key pattern as ingest-prices ──
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized — missing Bearer token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let jwtRole: string | null = null;
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = payloadB64 + '=='.slice((payloadB64.length + 3) & ~3);
      const payload = JSON.parse(atob(padded));
      jwtRole = payload.role ?? null;
    }
  } catch {
    // Invalid JWT structure — fall through to explicit key check
  }

  const explicitKey = Deno.env.get('INGEST_SERVICE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorized = jwtRole === 'service_role' || (explicitKey && token === explicitKey);

  if (!authorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized — service_role required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createSupabaseServiceClient();

  // ── 2. Fetch all 13 news sources ──────────────────────────────────────────
  console.log('[ingest-news] Starting — fetching all 13 sources…');

  let newsResult: Awaited<ReturnType<typeof fetchAllNews>>;
  try {
    newsResult = await fetchAllNews();
  } catch (err) {
    const msg = `fetchAllNews threw unexpectedly: ${String(err)}`;
    console.error(`[ingest-news] ${msg}`);
    errors.push(msg);

    const failedSummary: IngestNewsSummary = {
      status: 'failed',
      items_fetched: 0,
      items_deduped_rss: 0,
      items_deduped_db: 0,
      items_inserted: 0,
      source_stats: [],
      duration_ms: Date.now() - t0,
      errors,
    };
    const logRow: CronLogInsert = {
      job: 'ingest-news',
      status: 'failed',
      message: JSON.stringify(failedSummary),
    };
    await supabase.from('cron_log').insert(logRow);
    return new Response(JSON.stringify(failedSummary, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Collect top-level errors from fetcher
  errors.push(...newsResult.errors);
  // Collect per-source errors (the 3 known failing sources will appear here)
  for (const stat of newsResult.source_stats) {
    for (const e of stat.errors) {
      errors.push(`[${stat.source}] ${e}`);
    }
  }

  const items_fetched = newsResult.source_stats.reduce((sum, s) => sum + s.fetched, 0);
  const items_deduped_rss = newsResult.items.length;

  console.log(
    `[ingest-news] Fetch complete — ${items_fetched} raw, ${items_deduped_rss} after RSS dedup+filter`,
  );

  // ── 3. DB dedup — query existing URLs in last 14 days ────────────────────
  // 14-day window keeps the query cheap: RSS feeds never resurface older items.
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();

  const { data: existingData, error: existingError } = await supabase
    .from('news')
    .select('url')
    .gte('created_at', fourteenDaysAgo);

  if (existingError) {
    const msg = `news URL query failed: ${existingError.message}`;
    console.error(`[ingest-news] ${msg}`);
    errors.push(msg);
  }

  const existingUrls = new Set<string>(existingData?.map((r: { url: string }) => r.url) ?? []);
  console.log(`[ingest-news] ${existingUrls.size} URLs already in DB (last 14 days)`);

  const toInsert = newsResult.items.filter((item) => !existingUrls.has(item.url));
  const items_deduped_db = toInsert.length;

  console.log(`[ingest-news] ${items_deduped_db} genuinely new items to insert`);

  // ── 4. Bulk insert — classification fields null (Wave 3 classifies) ───────
  let items_inserted = 0;

  if (toInsert.length > 0) {
    const rows: NewsInsert[] = toInsert.map((item) => ({
      source: item.source,
      headline: item.headline,
      url: item.url,
      summary: item.summary,
      published_at: item.published_at,
      metals: null,
      sentiment: null,
      sentiment_rationale: null,
      relevant: null,
    }));

    // Use insert (not upsert) — we dedupe explicitly above for observability.
    // ignoreDuplicates is belt-and-suspenders; the explicit URL filter above
    // means conflicts should never occur in practice.
    // deno-lint-ignore no-explicit-any
    const insertOpts = { onConflict: 'url', ignoreDuplicates: true } as any;
    const { error: insertError, data: insertData } = await supabase
      .from('news')
      .insert(rows, insertOpts)
      .select('id');

    if (insertError) {
      const msg = `news insert failed: ${insertError.message}`;
      console.error(`[ingest-news] ${msg}`);
      errors.push(msg);
    } else {
      items_inserted = insertData?.length ?? rows.length;
      console.log(`[ingest-news] Inserted ${items_inserted} rows into news table`);
    }
  } else {
    console.log('[ingest-news] No new items — all already present in DB');
  }

  // ── 5. Write cron_log ─────────────────────────────────────────────────────
  const duration_ms = Date.now() - t0;

  // Overall status: failed only if zero items came back from all sources combined.
  // partial if any source errored (the 3 known failures make every run "partial").
  // success only if all sources returned items with no errors (unlikely in practice
  // until the 3 failing sources are fixed).
  let overallStatus: IngestNewsSummary['status'];
  if (newsResult.status === 'failed') {
    overallStatus = 'failed';
  } else if (errors.length > 0 || newsResult.status === 'partial') {
    overallStatus = 'partial';
  } else {
    overallStatus = 'success';
  }

  const summary: IngestNewsSummary = {
    status: overallStatus,
    items_fetched,
    items_deduped_rss,
    items_deduped_db,
    items_inserted,
    source_stats: newsResult.source_stats,
    duration_ms,
    errors,
  };

  const logRow: CronLogInsert = {
    job: 'ingest-news',
    status: overallStatus,
    message: JSON.stringify(summary),
  };

  const { error: logError } = await supabase.from('cron_log').insert(logRow);
  if (logError) {
    console.error(`[ingest-news] cron_log write failed: ${logError.message}`);
  }

  console.log(
    `[ingest-news] Done in ${duration_ms}ms — ` +
    `status=${overallStatus} | fetched=${items_fetched} | rss_deduped=${items_deduped_rss} | ` +
    `db_deduped=${items_deduped_db} | inserted=${items_inserted} | errors=${errors.length}`,
  );

  // ── 6. Return JSON summary ────────────────────────────────────────────────
  return new Response(JSON.stringify(summary, null, 2), {
    status: overallStatus === 'failed' ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
