/**
 * rss.ts — Metals-industry news aggregator
 *
 * Fetches from 13 sources (11 RSS/Atom + 2 HTML scrapes) in parallel,
 * deduplicates by URL and normalised headline, applies a coarse relevance
 * filter, and returns clean NewsItem objects ready for Supabase insertion.
 *
 * Standalone:  npx tsx lib/sources/rss.ts
 * Imported by: Session G (Supabase Edge Function, Wave 2)
 *
 * No Supabase client. No metal-tagging. No sentiment. Pure fetch + normalise.
 */

import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import { FEED_SOURCES } from './feeds.config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NewsItem {
  source: string;
  source_type: 'rss' | 'html';
  headline: string;
  url: string;
  summary: string | null;
  published_at: string; // ISO 8601 UTC
}

export interface RssFetchResult {
  status: 'success' | 'partial' | 'failed';
  items: NewsItem[];
  source_stats: Array<{
    source: string;
    fetched: number;
    errors: string[];
  }>;
  fetched_at: string;
  errors: string[];
  reason?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const USER_AGENT =
  'Mozilla/5.0 (compatible; BritanniaMetalsDesk/1.0; +https://github.com/Britannia-metals/britannia-metals)';

const FETCH_TIMEOUT_MS = 12_000;
const SUMMARY_MAX_CHARS = 500;

// Tracking / session params to strip from URLs
const STRIP_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_reader', 'utm_name',
  'fbclid', 'gclid', '_ga', '_gl',
  'mc_cid', 'mc_eid',
  'ref', 'source',
]);

// ─── URL normalisation ────────────────────────────────────────────────────────

export function normaliseUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hostname = u.hostname.toLowerCase();
    // Remove tracking params
    for (const key of [...u.searchParams.keys()]) {
      if (STRIP_PARAMS.has(key) || key.startsWith('utm_')) {
        u.searchParams.delete(key);
      }
    }
    // Remove fragment
    u.hash = '';
    // Remove trailing slash on path (but keep bare "/")
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString();
  } catch {
    // Not a valid URL — return as-is, lowercased
    return rawUrl.toLowerCase().trim();
  }
}

// ─── Headline normalisation (for dedup) ──────────────────────────────────────

function normaliseHeadline(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/<[^>]+>/g, '') // strip any HTML tags
    .replace(/[^\w\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

// ─── Strip HTML from text ─────────────────────────────────────────────────────

function stripHtml(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseSummary(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = stripHtml(raw).trim();
  if (!clean) return null;
  if (clean.length <= SUMMARY_MAX_CHARS) return clean;
  return clean.slice(0, SUMMARY_MAX_CHARS - 1) + '…';
}

function normaliseHeadlineText(raw: string | null | undefined): string {
  if (!raw) return '';
  return stripHtml(raw).replace(/\s+/g, ' ').trim();
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

/** Parse any reasonable date string to ISO 8601 UTC. Returns null on failure. */
function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {
    // fall through
  }
  // UK-style "DD Month YYYY" e.g. "24 April 2026"
  const ukMatch = raw.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (ukMatch) {
    try {
      const d = new Date(`${ukMatch[2]} ${ukMatch[1]}, ${ukMatch[3]} UTC`);
      if (!isNaN(d.getTime())) return d.toISOString();
    } catch {
      // fall through
    }
  }
  return null;
}

// ─── Relevance filter ─────────────────────────────────────────────────────────

// Patterns that indicate clearly irrelevant items (case-insensitive)
const IRRELEVANT_PATTERNS: RegExp[] = [
  /\bannounces\s+closing\s+of\b/i,
  /\bannounces\s+private\s+placement\b/i,
  /\bcompletes\s+acquisition\s+of\b/i,
  /\bgrants\s+stock\s+options\b/i,
  /\bfiles\s+NI\s+43[-–]101\b/i,
  /\bbuy\s+gold\s+now\b/i,
  /\bbest\s+gold\s+IRA\b/i,
  /\bgold\s+coins\s+for\s+sale\b/i,
];

// Keywords that indicate metals relevance
const METALS_KEYWORDS = [
  'copper', 'alumin', 'zinc', 'nickel', 'lead', 'tin', 'cobalt', 'lithium',
  'lme', 'comex', 'metal', 'mining', 'smelter', 'refinery', 'ore',
  'concentrate', 'warehouse stocks', 'codelco', 'freeport', 'glencore',
  'bhp', 'rio tinto', 'anglo american', 'china demand', 'supply chain',
  'iron ore', 'steel', 'scrap metal', 'base metal', 'precious metal',
  'gold', 'silver', 'platinum', 'palladium',
];

const CRYPTO_ONLY_PATTERNS = [/\bbitcoin\b/i, /\bethereum\b/i, /\bcrypto\b/i];

/**
 * Returns true if an item should be EXCLUDED (is obviously irrelevant).
 * When in doubt, keep — the AI classifier does the real work.
 */
export function isObviouslyIrrelevant(item: NewsItem): boolean {
  const text = `${item.headline} ${item.summary ?? ''}`;

  // Check boilerplate irrelevance patterns
  for (const pattern of IRRELEVANT_PATTERNS) {
    if (pattern.test(item.headline)) return true;
  }

  const lowerText = text.toLowerCase();

  // Crypto-only: exclude only if no metals keyword present
  const hasCrypto = CRYPTO_ONLY_PATTERNS.some((p) => p.test(item.headline));
  if (hasCrypto) {
    const hasMetals = METALS_KEYWORDS.some((kw) => lowerText.includes(kw));
    if (!hasMetals) return true;
  }

  // When in doubt, keep
  return false;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

/** Fetch with timeout and User-Agent header */
async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── RSS / Atom fetcher ───────────────────────────────────────────────────────

const rssParser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { 'User-Agent': USER_AGENT },
  customFields: {
    item: ['summary', 'media:content', 'media:thumbnail'],
  },
});

/**
 * Attempt to clean up common XML issues found in the wild:
 * - Attribute without value  (e.g. `<tag attr />` → `<tag attr="" />`)
 * - Bare ampersands in text nodes
 */
function sanitiseXml(xml: string): string {
  // Fix valueless attributes: `attr /` or `attr>` → `attr=""`
  return xml
    .replace(/(<[^>]*)\s([\w:-]+)([\s/>])/g, (_m, before, attr, after) => {
      // If attr looks like a lone word not followed by =, add ="true"
      return `${before} ${attr}="${attr}"${after}`;
    })
    // Replace bare & not already part of an entity reference
    .replace(/&(?!(?:#\d+|#x[\da-fA-F]+|[\w]+);)/g, '&amp;');
}

export async function fetchRssFeed(url: string, sourceName: string): Promise<NewsItem[]> {
  const t0 = Date.now();

  // Primary attempt: let rss-parser fetch directly
  let feed: Awaited<ReturnType<typeof rssParser.parseURL>>;
  try {
    feed = await rssParser.parseURL(url);
  } catch (primaryErr) {
    // Fallback: raw fetch → sanitise XML → parseString
    let raw: string;
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.text();
    } catch (fetchErr) {
      throw new Error(`${String(primaryErr)} | fetch fallback: ${String(fetchErr)}`);
    }
    try {
      feed = await rssParser.parseString(sanitiseXml(raw));
    } catch (parseErr) {
      throw new Error(`${String(primaryErr)} | sanitised parse: ${String(parseErr)}`);
    }
  }

  const elapsed = Date.now() - t0;

  const items: NewsItem[] = [];

  for (const entry of feed.items ?? []) {
    const rawHeadline = entry.title ?? '';
    const headline = normaliseHeadlineText(rawHeadline);
    if (!headline) continue;

    const rawUrl = entry.link ?? entry.guid ?? '';
    if (!rawUrl) continue;
    const normUrl = normaliseUrl(rawUrl);

    // Pick the best available summary field
    const rawSummary =
      (entry as Record<string, unknown>).summary as string ??
      entry.contentSnippet ??
      entry.content ??
      null;
    const summary = normaliseSummary(rawSummary);

    const rawDate = entry.isoDate ?? entry.pubDate ?? null;
    const published_at = parseDate(rawDate) ?? new Date().toISOString();

    items.push({
      source: sourceName,
      source_type: 'rss',
      headline,
      url: normUrl,
      summary,
      published_at,
    });
  }

  console.log(`[rss] ${sourceName}: ${items.length} items in ${elapsed}ms`);
  return items;
}

// ─── HTML scrape: LME Press Releases ─────────────────────────────────────────

export async function scrapeLmePressReleases(): Promise<NewsItem[]> {
  const SOURCE = 'LME Press Releases';
  const url = 'https://www.lme.com/en/News/Press-releases';
  const t0 = Date.now();

  // Throw on HTTP failure — caller (fetchAllNews) captures it into source_stats
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  const items: NewsItem[] = [];
  const fetchedAt = new Date().toISOString();

  // LME uses a list of press release articles.
  // We try several selector strategies in priority order.
  const candidates = [
    // Strategy A: article cards with a heading and link
    $('article').toArray(),
    // Strategy B: list items containing links
    $('li').has('a[href*="/News/Press-releases/"]').toArray(),
    // Strategy C: any link that looks like a press-release path
    $('a[href*="/News/Press-releases/"]').toArray(),
  ];

  const seen = new Set<string>();

  for (const els of candidates) {
    if (items.length > 0) break; // first strategy that yields results wins

    for (const el of els) {
      const elem = $(el);

      // Find the link
      const linkEl = el.tagName === 'a' ? elem : elem.find('a[href*="/News/Press-releases/"]').first();
      let href = linkEl.attr('href') ?? '';
      if (!href) continue;
      if (!href.startsWith('http')) {
        href = `https://www.lme.com${href}`;
      }
      const normUrl = normaliseUrl(href);
      if (seen.has(normUrl)) continue;

      // Find the headline
      const headline =
        normaliseHeadlineText(
          elem.find('h1, h2, h3, h4, .title, .headline').first().text() ||
          linkEl.text()
        );
      if (!headline || headline.length < 5) continue;

      // Find the date — look for a visible date string near the element
      const rawDateText =
        elem.find('time').attr('datetime') ??
        elem.find('time').text() ??
        elem.find('.date, .published, [class*="date"], [class*="Date"]').first().text() ??
        null;
      const published_at = parseDate(rawDateText) ?? fetchedAt;

      seen.add(normUrl);
      items.push({
        source: SOURCE,
        source_type: 'html',
        headline,
        url: normUrl,
        summary: null,
        published_at,
      });
    }
  }

  console.log(`[rss] ${SOURCE}: ${items.length} items in ${Date.now() - t0}ms`);
  return items;
}

// ─── HTML scrape: Kitco Base Metals ──────────────────────────────────────────

export async function scrapeKitcoBaseMetals(): Promise<NewsItem[]> {
  const SOURCE = 'Kitco Base Metals';
  const url = 'https://www.kitco.com/news/category/base-metals';
  const t0 = Date.now();

  // Throw on HTTP failure — caller (fetchAllNews) captures it into source_stats
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  const items: NewsItem[] = [];
  const fetchedAt = new Date().toISOString();
  const fetchedAtErrors: string[] = [];
  const seen = new Set<string>();

  // Kitco article cards — try multiple known selector patterns
  const articleEls = $('article, .article-card, .news-item, [class*="article"], [class*="Article"]').toArray();

  // Fallback: any link pointing to /news/ paths
  const linkEls = articleEls.length > 0
    ? articleEls
    : $('a[href*="/news/"]').has('h2, h3, h4, .title').toArray();

  for (const el of linkEls) {
    const elem = $(el);

    // Primary link
    const linkEl = el.tagName === 'a' ? elem : elem.find('a[href*="/news/"]').first();
    let href = linkEl.attr('href') ?? '';
    if (!href) {
      // Try any link in the card
      href = elem.find('a').first().attr('href') ?? '';
    }
    if (!href || href === '#') continue;
    if (!href.startsWith('http')) {
      href = `https://www.kitco.com${href}`;
    }
    const normUrl = normaliseUrl(href);
    if (seen.has(normUrl)) continue;

    const headline = normaliseHeadlineText(
      elem.find('h1, h2, h3, h4, .title, .headline').first().text() ||
      (el.tagName === 'a' ? elem.text() : '')
    );
    if (!headline || headline.length < 5) continue;

    // Timestamp
    const rawDate =
      elem.find('time').attr('datetime') ??
      elem.find('time').text() ??
      elem.find('.date, .timestamp, [class*="date"], [class*="Date"], [class*="time"]').first().text() ??
      null;
    let published_at: string;
    const parsed = parseDate(rawDate);
    if (parsed) {
      published_at = parsed;
    } else {
      published_at = fetchedAt;
      fetchedAtErrors.push(`No timestamp for: "${headline.slice(0, 60)}"`);
    }

    seen.add(normUrl);
    items.push({
      source: SOURCE,
      source_type: 'html',
      headline,
      url: normUrl,
      summary: null,
      published_at,
    });
  }

  if (fetchedAtErrors.length > 0) {
    console.warn(`[rss] ${SOURCE}: used fetch time for ${fetchedAtErrors.length} items with no timestamp`);
  }

  console.log(`[rss] ${SOURCE}: ${items.length} items in ${Date.now() - t0}ms`);
  return items;
}

// ─── Main aggregator ──────────────────────────────────────────────────────────

export async function fetchAllNews(): Promise<RssFetchResult> {
  const fetchedAt = new Date().toISOString();
  const t0 = Date.now();

  const rssSources = FEED_SOURCES.filter((s) => s.type === 'rss');
  const htmlSources = FEED_SOURCES.filter((s) => s.type === 'html');

  // Build one promise per source
  type SourceResult = { source: string; items: NewsItem[]; error?: string };

  const rssPromises: Promise<SourceResult>[] = rssSources.map((src) =>
    fetchRssFeed(src.url, src.name)
      .then((items) => ({ source: src.name, items }))
      .catch((err) => ({
        source: src.name,
        items: [],
        error: String(err),
      }))
  );

  const scrapePromises: Promise<SourceResult>[] = [];

  for (const src of htmlSources) {
    if (src.name === 'LME Press Releases') {
      scrapePromises.push(
        scrapeLmePressReleases()
          .then((items) => ({ source: src.name, items }))
          .catch((err) => ({ source: src.name, items: [], error: String(err) }))
      );
    } else if (src.name === 'Kitco Base Metals') {
      scrapePromises.push(
        scrapeKitcoBaseMetals()
          .then((items) => ({ source: src.name, items }))
          .catch((err) => ({ source: src.name, items: [], error: String(err) }))
      );
    }
  }

  const allPromises = [...rssPromises, ...scrapePromises];
  const settled = await Promise.allSettled(allPromises);

  // ── Collect results ───────────────────────────────────────────────────────
  const allItems: NewsItem[] = [];
  const sourceStats: RssFetchResult['source_stats'] = [];
  const topLevelErrors: string[] = [];

  for (const result of settled) {
    if (result.status === 'rejected') {
      topLevelErrors.push(`Unexpected rejection: ${String(result.reason)}`);
      continue;
    }
    const { source, items, error } = result.value;
    const errors = error ? [error] : [];
    sourceStats.push({ source, fetched: items.length, errors });
    allItems.push(...items);
  }

  const rawCount = allItems.length;

  // ── Deduplication ─────────────────────────────────────────────────────────
  // PRIMARY: by normalised URL
  // SECONDARY: by normalised headline (catches same story with different URLs)
  const seenUrls = new Set<string>();
  const seenHeadlines = new Set<string>();
  const deduped: NewsItem[] = [];

  // Sort newest-first before dedup so we keep the earliest-seen (best) version
  allItems.sort((a, b) =>
    new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );

  for (const item of allItems) {
    const normUrl = normaliseUrl(item.url);
    const normHead = normaliseHeadline(item.headline);

    if (seenUrls.has(normUrl)) continue;
    if (normHead.length >= 10 && seenHeadlines.has(normHead)) continue;

    seenUrls.add(normUrl);
    if (normHead.length >= 10) seenHeadlines.add(normHead);
    deduped.push(item);
  }

  const dedupedCount = deduped.length;

  // ── Relevance filter ──────────────────────────────────────────────────────
  const filtered = deduped.filter((item) => !isObviouslyIrrelevant(item));
  const filteredCount = filtered.length;

  // ── Summary log ───────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[rss] Fetched ${FEED_SOURCES.length} sources, ${rawCount} items raw, ` +
    `${dedupedCount} after dedup, ${filteredCount} after filter, in ${elapsed}s`
  );

  // ── Build result ──────────────────────────────────────────────────────────
  let status: RssFetchResult['status'];
  let reason: string | undefined;

  if (filteredCount === 0) {
    status = 'failed';
    reason = 'Zero items after dedup and filter — all sources may have failed or returned nothing.';
  } else {
    const failedSources = sourceStats.filter((s) => s.fetched === 0 && s.errors.length > 0);
    status = failedSources.length > 0 ? 'partial' : 'success';
  }

  return {
    status,
    items: filtered,
    source_stats: sourceStats,
    fetched_at: fetchedAt,
    errors: topLevelErrors,
    ...(reason ? { reason } : {}),
  };
}

// ─── Standalone runner ────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchAllNews().then((result) => {
    const { items, source_stats, status, errors } = result;
    console.log(
      JSON.stringify(
        {
          status,
          total_items: items.length,
          sample: items.slice(0, 5),
          source_stats,
          errors,
        },
        null,
        2
      )
    );
    process.exit(status === 'failed' ? 1 : 0);
  });
}
