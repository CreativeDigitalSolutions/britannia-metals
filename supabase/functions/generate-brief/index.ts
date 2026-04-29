/**
 * generate-brief — Supabase Edge Function
 *
 * Wave 3 / Session J: Generates a daily morning metals market brief using
 * Claude Sonnet 4.6. Runs once per weekday at 06:00 UTC via pg_cron.
 *
 * events.json is a build-time copy of /lib/events.json — keep them in sync
 * manually or via a build script whenever /lib/events.json is updated.
 *
 * HTTP endpoint: POST /functions/v1/generate-brief
 * Auth:          Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 * Scheduled:     pg_cron at '0 6 * * 1-5' (weekdays 06:00 UTC)
 * Cost:          ~$0.008–0.012 per call (Sonnet 4.6, ~2k input / 150 output tokens)
 *
 * IDEMPOTENCY
 * -----------
 * pg_cron can occasionally fire twice. The briefs.for_date unique constraint
 * protects the DB, but we check first to avoid burning an API call on a
 * duplicate. On skip, returns status='skipped' immediately.
 *
 * HEADLINE FALLBACK
 * -----------------
 * On first deploy, classify-news may not have caught up. If fewer than 5
 * relevant=true headlines exist in the last 24 h, we fall back to all
 * recent headlines regardless of classification. The brief prompt is robust
 * to partially-classified data — unclassified rows default to metals=[] and
 * sentiment='neutral'.
 */

import { createSupabaseServiceClient } from '../_shared/supabase-client.ts';
import { callAnthropicWithRetry, extractText } from '../_shared/anthropic-client.ts';
import {
  BRIEF_PROMPT,
  type BriefInput,
  type BriefPriceMove,
  type BriefArbSnapshot,
  type BriefHeadline,
  type BriefEvent,
  type Sentiment,
} from '../_shared/prompts.ts';
import type { CronLogInsert } from '../_shared/types.ts';

// ── Response shape ────────────────────────────────────────────────────────────

interface GenerateBriefSummary {
  status: 'success' | 'skipped' | 'failed';
  brief_id: string | null;
  brief_word_count: number | null;
  for_date: string;                // YYYY-MM-DD UTC
  inputs_used: {
    price_moves_count: number;
    headlines_count: number;
    headlines_classified: number;  // how many had relevant=true
    events_count: number;
    arb_present: boolean;
  };
  api_input_tokens: number;
  api_output_tokens: number;
  duration_ms: number;
  reason?: string;
  errors: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONTRACT_PRIORITY: Record<string, number> = { cash: 0, '3m': 1, front_month: 2 };

/** Map DB price unit to the Unit type used by the brief prompt. 'lb' falls back to 'tonne'. */
function toUnit(u: string): 'tonne' | 'troy_oz' {
  return u === 'troy_oz' ? 'troy_oz' : 'tonne';
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const errors: string[] = [];

  // ── 1. Auth check — JWT role + explicit key, same pattern as ingest-prices ──
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
      const payload = JSON.parse(atob(padded));
      jwtRole = payload.role ?? null;
    }
  } catch {
    // Invalid JWT structure — fall through to explicit key check
  }

  const explicitKey =
    Deno.env.get('INGEST_SERVICE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorized = jwtRole === 'service_role' || (explicitKey && token === explicitKey);

  if (!authorized) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized — service_role required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── 2. Weekend check (defence in depth — cron schedule already handles this) ──
  const nowUtc = new Date();
  const dayOfWeek = nowUtc.getUTCDay(); // 0 = Sunday, 6 = Saturday

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    const skippedSummary: GenerateBriefSummary = {
      status: 'skipped',
      brief_id: null,
      brief_word_count: null,
      for_date: nowUtc.toISOString().slice(0, 10),
      inputs_used: { price_moves_count: 0, headlines_count: 0, headlines_classified: 0, events_count: 0, arb_present: false },
      api_input_tokens: 0,
      api_output_tokens: 0,
      duration_ms: Date.now() - t0,
      reason: 'no brief on weekends',
      errors: [],
    };
    return new Response(JSON.stringify(skippedSummary, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const today = nowUtc.toISOString().slice(0, 10); // YYYY-MM-DD
  const supabase = createSupabaseServiceClient();

  // ── 3. Idempotency check — skip if brief already exists for today ──────────
  const { data: existingBrief, error: existingError } = await supabase
    .from('briefs')
    .select('id')
    .eq('for_date', today)
    .maybeSingle();

  if (existingError) {
    // Transient error — log but continue rather than aborting
    errors.push(`idempotency check failed: ${existingError.message}`);
    console.warn(`[generate-brief] Idempotency check error (continuing): ${existingError.message}`);
  } else if (existingBrief) {
    const skippedSummary: GenerateBriefSummary = {
      status: 'skipped',
      brief_id: existingBrief.id,
      brief_word_count: null,
      for_date: today,
      inputs_used: { price_moves_count: 0, headlines_count: 0, headlines_classified: 0, events_count: 0, arb_present: false },
      api_input_tokens: 0,
      api_output_tokens: 0,
      duration_ms: Date.now() - t0,
      reason: 'already exists for today',
      errors: [],
    };
    console.log(`[generate-brief] Brief already exists for ${today} (id=${existingBrief.id}) — skipping`);
    return new Response(JSON.stringify(skippedSummary, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 4a. Price moves — latest row per metal, prefer cash > 3m > front_month ─
  const twentyFourHoursAgo = new Date(nowUtc.getTime() - 24 * 3_600_000).toISOString();

  const { data: priceRows, error: pricesError } = await supabase
    .from('prices')
    .select('metal,price,change_pct,contract,source,unit,currency,as_of')
    .gte('as_of', twentyFourHoursAgo)
    .order('as_of', { ascending: false });

  if (pricesError) {
    const msg = `prices query failed: ${pricesError.message}`;
    console.error(`[generate-brief] ${msg}`);
    errors.push(msg);
  }

  type PriceRow = {
    metal: string; price: number; change_pct: number | null;
    contract: string; source: string; unit: string; currency: string; as_of: string;
  };

  // Reduce to one row per metal — best contract (cash > 3m > front_month)
  // Rows are ordered desc by as_of, so first row per metal+contract is most recent
  const metalMap = new Map<string, PriceRow>();
  for (const row of (priceRows ?? []) as PriceRow[]) {
    const existing = metalMap.get(row.metal);
    const rowPriority = CONTRACT_PRIORITY[row.contract] ?? 99;
    const existingPriority = existing ? (CONTRACT_PRIORITY[existing.contract] ?? 99) : 999;
    if (!existing || rowPriority < existingPriority) {
      metalMap.set(row.metal, row);
    }
  }

  const priceMoves: BriefPriceMove[] = Array.from(metalMap.values()).map((r) => ({
    metal: r.metal,
    cash_price: r.price,
    change_pct: r.change_pct ?? 0, // default 0 when prev_close was unavailable
    unit: toUnit(r.unit),
  }));

  console.log(
    `[generate-brief] Price moves: ${priceMoves.length} metals ` +
    `(from ${(priceRows ?? []).length} raw rows, 24h window)`,
  );

  // ── 4b. Arb snapshot — most recent row from arb_history ───────────────────
  const { data: arbData, error: arbError } = await supabase
    .from('arb_history')
    .select('lme_copper_usd_tonne,comex_copper_usd_tonne,spread_usd,spread_pct,as_of')
    .order('as_of', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (arbError) {
    errors.push(`arb_history query failed: ${arbError.message}`);
    console.warn(`[generate-brief] arb_history query failed: ${arbError.message}`);
  }

  const arbPresent = arbData != null;
  // BriefInput.arb_snapshot is required (not nullable) — use zeros when unavailable.
  // The prompt treats spread_pct ≤ 0.5% as "not material" and won't mention it.
  const arbSnapshot: BriefArbSnapshot = arbData
    ? {
        lme_copper_usd_tonne: Number(arbData.lme_copper_usd_tonne),
        comex_copper_usd_tonne: Number(arbData.comex_copper_usd_tonne),
        spread_usd: Number(arbData.spread_usd),
        spread_pct: Number(arbData.spread_pct),
      }
    : {
        lme_copper_usd_tonne: 0,
        comex_copper_usd_tonne: 0,
        spread_usd: 0,
        spread_pct: 0,
      };

  if (!arbPresent) {
    errors.push('arb_history: no rows found — using zero spread placeholder');
  }

  console.log(
    `[generate-brief] Arb: ${arbPresent
      ? `LME $${arbSnapshot.lme_copper_usd_tonne.toFixed(0)}/t | COMEX $${arbSnapshot.comex_copper_usd_tonne.toFixed(0)}/t | spread ${arbSnapshot.spread_pct.toFixed(2)}%`
      : 'unavailable (zeros)'
    }`,
  );

  // ── 4c. Top headlines — classified first, fall back to all recent ──────────
  type NewsRow = {
    headline: string; source: string;
    metals: string[] | null; sentiment: string | null;
    published_at: string; relevant: boolean | null;
  };

  let headlineResult = await supabase
    .from('news')
    .select('headline,source,metals,sentiment,published_at,relevant')
    .eq('relevant', true)
    .gte('published_at', twentyFourHoursAgo)
    .order('published_at', { ascending: false })
    .limit(15);

  let usedFallback = false;
  if (!headlineResult.data || headlineResult.data.length < 5) {
    console.warn(
      `[generate-brief] Only ${headlineResult.data?.length ?? 0} classified headlines in last 24 h — ` +
      'falling back to all recent news (classification may be behind)',
    );
    headlineResult = await supabase
      .from('news')
      .select('headline,source,metals,sentiment,published_at,relevant')
      .gte('published_at', twentyFourHoursAgo)
      .order('published_at', { ascending: false })
      .limit(15);
    usedFallback = true;
  }

  if (headlineResult.error) {
    errors.push(`news query failed: ${headlineResult.error.message}`);
    console.error(`[generate-brief] news query failed: ${headlineResult.error.message}`);
  }

  const rawHeadlines = (headlineResult.data ?? []) as NewsRow[];
  const headlinesClassified = rawHeadlines.filter((h) => h.relevant === true).length;

  // Map to BriefHeadline — default unclassified to empty metals + neutral sentiment
  const topHeadlines: BriefHeadline[] = rawHeadlines.map((h) => ({
    headline: h.headline,
    source: h.source,
    metals: h.metals ?? [],
    sentiment: (h.sentiment as Sentiment) ?? 'neutral',
  }));

  console.log(
    `[generate-brief] Headlines: ${topHeadlines.length} total, ${headlinesClassified} classified` +
    (usedFallback ? ' (classification fallback used)' : ''),
  );

  // ── 4d. Upcoming events — filter events.json to next 48 h ─────────────────
  type EventRecord = {
    date: string; time: string | null; event: string;
    category: string; impact: 'high' | 'medium' | 'low'; metals: string[];
  };

  let upcomingEvents: BriefEvent[] = [];
  try {
    const eventsJson = await Deno.readTextFile(new URL('./events.json', import.meta.url));
    const allEvents = JSON.parse(eventsJson) as EventRecord[];
    const plus48h = new Date(nowUtc.getTime() + 48 * 3_600_000).toISOString().slice(0, 10);
    upcomingEvents = allEvents
      .filter((e) => e.date >= today && e.date <= plus48h)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => ({ date: e.date, event: e.event, impact: e.impact }));
  } catch (err) {
    const msg = `events.json read failed: ${String(err)}`;
    errors.push(msg);
    console.warn(`[generate-brief] ${msg}`);
  }

  console.log(`[generate-brief] Events in next 48 h: ${upcomingEvents.length}`);

  // ── 5. Build BriefInput ───────────────────────────────────────────────────
  const briefInput: BriefInput = {
    as_of: nowUtc.toISOString(),
    price_moves: priceMoves,
    arb_snapshot: arbSnapshot,
    top_headlines: topHeadlines,
    upcoming_events: upcomingEvents,
  };

  // Observability: log input counts before API call
  console.log(
    `[generate-brief] BriefInput summary — ` +
    `prices=${priceMoves.length}, headlines=${topHeadlines.length} (${headlinesClassified} classified), ` +
    `events=${upcomingEvents.length}, arb=${arbPresent ? 'present' : 'absent'}`,
  );

  // ── 6. Call Claude Sonnet 4.6 via BRIEF_PROMPT ───────────────────────────
  const userMessage = BRIEF_PROMPT.buildUserMessage(briefInput);
  let apiInputTokens = 0;
  let apiOutputTokens = 0;
  let rawBrief: string;

  try {
    const apiResponse = await callAnthropicWithRetry({
      model: BRIEF_PROMPT.model,          // 'claude-sonnet-4-6'
      system: BRIEF_PROMPT.system,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: BRIEF_PROMPT.max_tokens, // 300
      temperature: BRIEF_PROMPT.temperature, // 0.3
    });

    rawBrief = extractText(apiResponse);
    apiInputTokens = apiResponse.usage.input_tokens;
    apiOutputTokens = apiResponse.usage.output_tokens;

    console.log(`[generate-brief] API tokens: input=${apiInputTokens}, output=${apiOutputTokens}`);
    console.log(`[generate-brief] Brief preview: ${rawBrief.slice(0, 100)}…`);
  } catch (err) {
    const msg = `Anthropic API call failed: ${String(err)}`;
    console.error(`[generate-brief] ${msg}`);
    errors.push(msg);

    const failSummary: GenerateBriefSummary = {
      status: 'failed',
      brief_id: null,
      brief_word_count: null,
      for_date: today,
      inputs_used: {
        price_moves_count: priceMoves.length,
        headlines_count: topHeadlines.length,
        headlines_classified: headlinesClassified,
        events_count: upcomingEvents.length,
        arb_present: arbPresent,
      },
      api_input_tokens: 0,
      api_output_tokens: 0,
      duration_ms: Date.now() - t0,
      reason: msg,
      errors,
    };

    const logRow: CronLogInsert = {
      job: 'generate-brief',
      status: 'failed',
      message: JSON.stringify(failSummary),
    };
    await supabase.from('cron_log').insert(logRow);

    return new Response(JSON.stringify(failSummary, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── 7. Validate and clean the response ────────────────────────────────────
  // Strip any markdown code fences the model might have added
  let briefContent = rawBrief.trim();
  briefContent = briefContent.replace(/^```[\w]*\n?/gm, '').replace(/```\s*$/gm, '').trim();

  const wordCount = briefContent.split(/\s+/).filter(Boolean).length;

  if (wordCount < 40) {
    const warn = `Brief too short (${wordCount} words; expected 60–130) — writing anyway`;
    console.warn(`[generate-brief] ${warn}`);
    errors.push(warn);
  } else if (wordCount > 200) {
    const warn = `Brief too long (${wordCount} words; expected 60–130) — writing anyway`;
    console.warn(`[generate-brief] ${warn}`);
    errors.push(warn);
  } else {
    console.log(`[generate-brief] Brief validated: ${wordCount} words`);
  }

  // ── 8. Insert into briefs table (INSERT not UPSERT — idempotency at step 3) ─
  const { data: insertData, error: insertError } = await supabase
    .from('briefs')
    .insert({ content: briefContent, for_date: today })
    .select('id')
    .single();

  if (insertError) {
    const msg = `briefs insert failed: ${insertError.message}`;
    console.error(`[generate-brief] ${msg}`);
    errors.push(msg);
  } else {
    console.log(`[generate-brief] Brief written — id=${insertData.id}, ${wordCount} words, for_date=${today}`);
  }

  // ── 9. Write cron_log ─────────────────────────────────────────────────────
  const duration_ms = Date.now() - t0;
  const overallStatus: GenerateBriefSummary['status'] = insertError ? 'failed' : 'success';

  const summary: GenerateBriefSummary = {
    status: overallStatus,
    brief_id: insertData?.id ?? null,
    brief_word_count: wordCount,
    for_date: today,
    inputs_used: {
      price_moves_count: priceMoves.length,
      headlines_count: topHeadlines.length,
      headlines_classified: headlinesClassified,
      events_count: upcomingEvents.length,
      arb_present: arbPresent,
    },
    api_input_tokens: apiInputTokens,
    api_output_tokens: apiOutputTokens,
    duration_ms,
    errors,
  };

  // cron_log status: 'partial' if brief was written but minor issues occurred
  const logStatus: CronLogInsert['status'] = insertError
    ? 'failed'
    : errors.length > 0
    ? 'partial'
    : 'success';

  const logRow: CronLogInsert = {
    job: 'generate-brief',
    status: logStatus,
    message: JSON.stringify(summary),
  };

  const { error: logError } = await supabase.from('cron_log').insert(logRow);
  if (logError) {
    console.error(`[generate-brief] cron_log write failed: ${logError.message}`);
  }

  console.log(
    `[generate-brief] Complete in ${duration_ms}ms — ` +
    `status=${overallStatus}, words=${wordCount}, ` +
    `tokens in/out=${apiInputTokens}/${apiOutputTokens}, ` +
    `cost≈$${((apiInputTokens * 3 + apiOutputTokens * 15) / 1_000_000).toFixed(4)}, ` +
    `errors=${errors.length}`,
  );

  // ── 10. Return JSON summary ───────────────────────────────────────────────
  return new Response(JSON.stringify(summary, null, 2), {
    status: overallStatus === 'failed' ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
