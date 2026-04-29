/**
 * classify-news — Supabase Edge Function
 *
 * Wave 3 / Session I: Picks up unclassified news rows (relevant IS NULL),
 * runs them through two Haiku calls (relevance filter → sentiment + metal tagging),
 * and writes results back to the news table.
 *
 * HTTP endpoint: POST /functions/v1/classify-news
 * Auth:          Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 * Scheduled:     pg_cron every 2 hours — do not expose publicly
 *
 * Throughput note:
 *   Anthropic Haiku rate limit ~50 RPM at low tier.
 *   We process 30 rows × up to 2 calls each = up to 60 calls/run.
 *   With 100ms delay between calls + ~1s API response time, a full run
 *   takes ~50–70s. Edge Function hard timeout is 150s; this fits comfortably.
 *   134-row backlog clears in ~5 invocations (~10h on 2h cron).
 *
 * Session J (generate-brief) shares _shared/anthropic-client.ts and prompts.ts.
 */

import { createSupabaseServiceClient } from '../_shared/supabase-client.ts';
import type { NewsRow, CronLogInsert } from '../_shared/types.ts';
import {
  RELEVANCE_PROMPT,
  CLASSIFY_PROMPT,
  parseRelevanceResponse,
  parseClassifyResponse,
} from '../_shared/prompts.ts';
import {
  callAnthropicWithRetry,
  extractText,
  AnthropicError,
} from '../_shared/anthropic-client.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FUNCTION_NAME = 'classify-news';
const BATCH_SIZE = 30;          // rows per invocation (stays well within 150s timeout)
const INTER_CALL_DELAY_MS = 100; // pause between Anthropic calls to stay under RPM
const MAX_ERRORS_LOGGED = 20;   // cap on errors[] array to avoid runaway payloads

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

interface ClassifySummary {
  status: 'success' | 'partial' | 'failed';
  rows_picked: number;
  relevance_called: number;
  relevance_relevant: number;
  relevance_irrelevant: number;
  classify_called: number;
  classify_succeeded: number;
  rows_updated: number;
  rows_skipped: number;
  api_input_tokens: number;
  api_output_tokens: number;
  duration_ms: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const t0 = Date.now();

  // ── 1. Auth check ───────────────────────────────────────────────────────
  // Mirrors the JWT-decode pattern from ingest-prices (Session F).
  // Supabase already verifies the JWT signature at platform level before
  // the function runs; we just check the role claim to block anon callers.
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized — missing Bearer token' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let jwtRole: string | null = null;
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = payloadB64 + '=='.slice((payloadB64.length + 3) & ~3);
      const payloadJson = atob(padded);
      const payload = JSON.parse(payloadJson);
      jwtRole = payload.role ?? null;
    }
  } catch {
    // Invalid JWT structure — fall through to explicit key check
  }

  const explicitKey =
    Deno.env.get('CLASSIFY_SERVICE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorized =
    jwtRole === 'service_role' || (explicitKey != null && token === explicitKey);

  if (!authorized) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized — service_role required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── 2. Initialise ───────────────────────────────────────────────────────
  const supabase = createSupabaseServiceClient();
  const errors: string[] = [];

  let rowsPicked = 0;
  let relevanceCalled = 0;
  let relevanceRelevant = 0;
  let relevanceIrrelevant = 0;
  let classifyCalled = 0;
  let classifySucceeded = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const pushError = (msg: string) => {
    console.error(`[${FUNCTION_NAME}] ${msg}`);
    if (errors.length < MAX_ERRORS_LOGGED) errors.push(msg);
  };

  // ── 3. Fetch unclassified rows ─────────────────────────────────────────
  console.log(`[${FUNCTION_NAME}] Starting — querying up to ${BATCH_SIZE} unclassified rows…`);

  const { data: rows, error: fetchError } = await supabase
    .from('news')
    .select('id, source, headline, summary, published_at')
    .is('relevant', null)
    .order('published_at', { ascending: false })
    .limit(BATCH_SIZE);

  if (fetchError) {
    const msg = `DB fetch failed: ${fetchError.message}`;
    pushError(msg);
    return new Response(
      JSON.stringify({
        status: 'failed',
        rows_picked: 0,
        relevance_called: 0,
        relevance_relevant: 0,
        relevance_irrelevant: 0,
        classify_called: 0,
        classify_succeeded: 0,
        rows_updated: 0,
        rows_skipped: 0,
        api_input_tokens: 0,
        api_output_tokens: 0,
        duration_ms: Date.now() - t0,
        errors,
      } satisfies ClassifySummary),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const newsRows = (rows ?? []) as Pick<
    NewsRow,
    'id' | 'source' | 'headline' | 'summary' | 'published_at'
  >[];
  rowsPicked = newsRows.length;

  if (rowsPicked === 0) {
    console.log(`[${FUNCTION_NAME}] No unclassified rows found — nothing to do.`);
    const summary: ClassifySummary = {
      status: 'success',
      rows_picked: 0,
      relevance_called: 0,
      relevance_relevant: 0,
      relevance_irrelevant: 0,
      classify_called: 0,
      classify_succeeded: 0,
      rows_updated: 0,
      rows_skipped: 0,
      api_input_tokens: 0,
      api_output_tokens: 0,
      duration_ms: Date.now() - t0,
      errors: [],
    };
    await writeCronLog(supabase, 'success', summary);
    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log(`[${FUNCTION_NAME}] ${rowsPicked} rows to classify.`);

  // ── 4. Classify each row sequentially ──────────────────────────────────
  for (let i = 0; i < newsRows.length; i++) {
    const row = newsRows[i];

    // ── 4a. Relevance call ──────────────────────────────────────────────
    let relevanceRaw: string | null = null;
    try {
      const res = await callAnthropicWithRetry({
        model: RELEVANCE_PROMPT.model,
        system: RELEVANCE_PROMPT.system,
        messages: [
          {
            role: 'user',
            content: RELEVANCE_PROMPT.buildUserMessage({
              headline: row.headline,
              summary: row.summary,
              source: row.source,
            }),
          },
        ],
        max_tokens: RELEVANCE_PROMPT.max_tokens,
        temperature: RELEVANCE_PROMPT.temperature,
      });
      relevanceRaw = extractText(res);
      totalInputTokens += res.usage.input_tokens;
      totalOutputTokens += res.usage.output_tokens;
      relevanceCalled++;
    } catch (err) {
      const msg =
        err instanceof AnthropicError
          ? `row ${row.id} — relevance API error ${err.status}: ${err.message}`
          : `row ${row.id} — relevance unexpected error: ${String(err)}`;
      pushError(msg);
      rowsSkipped++;
      // Add delay even on error to avoid hammering a rate-limited API
      if (i < newsRows.length - 1) {
        await new Promise(r => setTimeout(r, INTER_CALL_DELAY_MS));
      }
      continue;
    }

    const relevanceResult = parseRelevanceResponse(relevanceRaw);
    if (!relevanceResult) {
      pushError(`row ${row.id} — relevance parse failure: ${relevanceRaw.slice(0, 120)}`);
      rowsSkipped++;
      if (i < newsRows.length - 1) {
        await new Promise(r => setTimeout(r, INTER_CALL_DELAY_MS));
      }
      continue;
    }

    // ── 4b. Branch: irrelevant → write + continue ───────────────────────
    if (!relevanceResult.relevant) {
      relevanceIrrelevant++;
      console.log(
        `[${FUNCTION_NAME}] row ${row.id} — relevance: irrelevant (${relevanceResult.confidence})`
      );

      const { error: updateErr } = await supabase
        .from('news')
        .update({ relevant: false })
        .eq('id', row.id);

      if (updateErr) {
        pushError(`row ${row.id} — DB update (irrelevant) failed: ${updateErr.message}`);
        rowsSkipped++;
      } else {
        rowsUpdated++;
      }

      if (i < newsRows.length - 1) {
        await new Promise(r => setTimeout(r, INTER_CALL_DELAY_MS));
      }
      continue;
    }

    // ── 4c. Relevant → classify call ────────────────────────────────────
    relevanceRelevant++;

    let classifyRaw: string | null = null;
    try {
      // Small additional delay between the two calls for the same row
      await new Promise(r => setTimeout(r, INTER_CALL_DELAY_MS));

      const res = await callAnthropicWithRetry({
        model: CLASSIFY_PROMPT.model,
        system: CLASSIFY_PROMPT.system,
        messages: [
          {
            role: 'user',
            content: CLASSIFY_PROMPT.buildUserMessage({
              headline: row.headline,
              summary: row.summary,
              source: row.source,
            }),
          },
        ],
        max_tokens: CLASSIFY_PROMPT.max_tokens,
        temperature: CLASSIFY_PROMPT.temperature,
      });
      classifyRaw = extractText(res);
      totalInputTokens += res.usage.input_tokens;
      totalOutputTokens += res.usage.output_tokens;
      classifyCalled++;
    } catch (err) {
      const msg =
        err instanceof AnthropicError
          ? `row ${row.id} — classify API error ${err.status}: ${err.message}`
          : `row ${row.id} — classify unexpected error: ${String(err)}`;
      pushError(msg);

      // Write relevant=true but leave sentiment/metals null — retryable next run
      // if we widen the query later; for now this marks it as classified-relevant
      const { error: updateErr } = await supabase
        .from('news')
        .update({ relevant: true })
        .eq('id', row.id);

      if (updateErr) {
        pushError(`row ${row.id} — DB update (relevant-only) failed: ${updateErr.message}`);
        rowsSkipped++;
      } else {
        rowsUpdated++;
      }

      if (i < newsRows.length - 1) {
        await new Promise(r => setTimeout(r, INTER_CALL_DELAY_MS));
      }
      continue;
    }

    const classifyResult = parseClassifyResponse(classifyRaw);
    if (!classifyResult) {
      pushError(`row ${row.id} — classify parse failure: ${classifyRaw.slice(0, 120)}`);

      // Same fallback: mark relevant=true, leave sentiment/metals null
      const { error: updateErr } = await supabase
        .from('news')
        .update({ relevant: true })
        .eq('id', row.id);

      if (updateErr) {
        pushError(`row ${row.id} — DB update (relevant-only after parse fail) failed: ${updateErr.message}`);
        rowsSkipped++;
      } else {
        rowsUpdated++;
      }

      if (i < newsRows.length - 1) {
        await new Promise(r => setTimeout(r, INTER_CALL_DELAY_MS));
      }
      continue;
    }

    // ── 4d. Write full classification ───────────────────────────────────
    classifySucceeded++;
    console.log(
      `[${FUNCTION_NAME}] row ${row.id} — relevance: relevant (${relevanceResult.confidence}), ` +
      `classify: ${classifyResult.metals.join('+')} ${classifyResult.sentiment} ` +
      `"${classifyResult.rationale.slice(0, 60)}"`
    );

    const { error: updateErr } = await supabase
      .from('news')
      .update({
        relevant: true,
        metals: classifyResult.metals,
        sentiment: classifyResult.sentiment,
        sentiment_rationale: classifyResult.rationale,
      })
      .eq('id', row.id);

    if (updateErr) {
      pushError(`row ${row.id} — DB update (full classify) failed: ${updateErr.message}`);
      rowsSkipped++;
    } else {
      rowsUpdated++;
    }

    // Delay before next row's relevance call
    if (i < newsRows.length - 1) {
      await new Promise(r => setTimeout(r, INTER_CALL_DELAY_MS));
    }
  }

  // ── 5. Build summary ────────────────────────────────────────────────────
  const durationMs = Date.now() - t0;
  const hasErrors = errors.length > 0;
  const status: ClassifySummary['status'] =
    rowsSkipped === 0
      ? 'success'
      : rowsUpdated > 0
      ? 'partial'
      : 'failed';

  const summary: ClassifySummary = {
    status,
    rows_picked: rowsPicked,
    relevance_called: relevanceCalled,
    relevance_relevant: relevanceRelevant,
    relevance_irrelevant: relevanceIrrelevant,
    classify_called: classifyCalled,
    classify_succeeded: classifySucceeded,
    rows_updated: rowsUpdated,
    rows_skipped: rowsSkipped,
    api_input_tokens: totalInputTokens,
    api_output_tokens: totalOutputTokens,
    duration_ms: durationMs,
    errors: hasErrors ? errors : [],
  };

  console.log(
    `[${FUNCTION_NAME}] ${rowsPicked} picked / ${relevanceCalled} relevance OK / ` +
    `${relevanceRelevant} relevant / ${classifySucceeded} classify OK / ` +
    `${rowsUpdated} updated / ${relevanceIrrelevant} irrelevant / ` +
    `${rowsSkipped} skipped in ${(durationMs / 1000).toFixed(1)}s`
  );

  // ── 6. Write to cron_log ─────────────────────────────────────────────
  await writeCronLog(supabase, status, summary);

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
async function writeCronLog(supabase: any, status: CronLogInsert['status'], summary: ClassifySummary) {
  const log: CronLogInsert = {
    job: 'classify-news',
    status,
    message: JSON.stringify(summary),
  };
  const { error } = await supabase.from('cron_log').insert(log);
  if (error) {
    console.error(`[classify-news] Failed to write cron_log: ${error.message}`);
  }
}

