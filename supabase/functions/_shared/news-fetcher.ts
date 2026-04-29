/**
 * news-fetcher.ts — Deno-adapted metals news aggregator for Supabase Edge Functions.
 *
 * Adapted from /lib/sources/rss.ts (Wave 1, frozen).
 * Key changes from the Node.js original:
 *   - npm: specifiers for rss-parser and cheerio
 *   - fetchRssFeed uses Deno's native fetch + parseString (skips parseURL to
 *     avoid Node.js http/https compat layer in Deno)
 *   - FEED_SOURCES inlined from feeds.config.ts (no separate file needed in bundle)
 *   - Standalone runner (import.meta.url gate) removed
 *
 * Known failing sources (kept in config — failures handled gracefully):
 *   - Kitco Mining: malformed XML
 *   - Mining Weekly: 403
 *   - LME Press Releases: Cloudflare-blocked
 */

import Parser from 'npm:rss-parser@3';
import * as cheerio from 'npm:cheerio@1';

// ─── Feed configuration (inlined from /lib/sources/feeds.config.ts) ──────────

type FeedType = 'rss' | 'html';

interface FeedSource {
  name: string;
  url: string;
  type: FeedType;
  notes?: string;
}

const FEED_SOURCES: FeedSource[] = [
  // ── RSS / Atom feeds ──────────────────────────────────────────────────────
  { name: 'Mining.com', url: 'https://www.mining.com/feed/', type: 'rss' },
  {
    name: 'Kitco Mining',
    url: 'https://www.kitco.com/news/category/mining/rss',
    type: 'rss',
    notes: 'Known malformed XML — expected to fail gracefully.',
  },
  { name: 'Northern Miner', url: 'https://www.northernminer.com/feed/', type: 'rss' },
  { name: 'Mining Technology', url: 'https://www.mining-technology.com/feed', type: 'rss' },
  { name: 'Engineering & Mining Journal', url: 'https://www.e-mj.com/feed/', type: 'rss' },
  { name: 'Canadian Mining Journal', url: 'https://www.canadianminingjournal.com/feed/', type: 'rss' },
  {
    name: 'Mining Weekly',
    url: 'https://www.miningweekly.com/rss',
    type: 'rss',
    notes: '403 — expected to fail gracefully.',
  },
  {
    name: 'Hellenic Shipping Commodities',
    url: 'https://www.hellenicshippingnews.com/category/commodities/commodity-news/feed/',
    type: 'rss',
  },
  {
    name: 'Google News — LME metals',
    url: 'https://news.google.com/rss/search?q=LME+base+metals&hl=en-GB&gl=GB&ceid=GB:en',
    type: 'rss',
    notes: 'Items link via Google News redirect URL; dedup by headline handles overlaps.',
  },
  {
    name: 'Google News — copper market',
    url: 'https://news.google.com/rss/search?q=%22copper+market%22+OR+%22copper+price%22&hl=en-GB&gl=GB&ceid=GB:en',
    type: 'rss',
    notes: 'Overlaps with LME feed — dedup handles it.',
  },
  {
    name: 'MarketWatch metals',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',
    type: 'rss',
    notes: 'Broader feed; AI classifier (Wave 3) filters for metals relevance.',
  },

  // ── HTML scrapes ─────────────────────────────────────────────────────────
  {
    name: 'LME Press Releases',
    url: 'https://www.lme.com/en/News/Press-releases',
    type: 'html',
    notes: 'Cloudflare-blocked — expected to fail gracefully.',
  },
  {
    name: 'Kitco Base Metals',
    url: 'https://www.kitco.com/news/category/base-metals',
    type: 'html',
  },
];

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
  source_stats: Array<{ source: string; fetched: number; errors: string[] }>;
  fetched_at: string;
  errors: string[];
  reason?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const USER_AGENT =
  'Mozilla/5.0 (compatible; BritanniaMetalsDesk/1.0; +https://github.com/Britannia-metals/britannia-metals)';

const FETCH_TIMEOUT_MS = 12_000;
const SUMMARY_MAX_CHARS = 500;

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
    for (const key of [...u.searchParams.keys()]) {
      if (STRIP_PARAMS.has(key) || key.startsWith('utm_')) {
        u.searchParams.delete(key);
      }
    }
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString();
  } catch {
    return rawUrl.toLowerCase().trim();
  }
}

// ─── Headline normalisation (for dedup) ──────────────────────────────────────

function normaliseHeadline(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s]/g, '')
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

const METALS_KEYWORDS = [
  'copper', 'alumin', 'zinc', 'nickel', 'lead', 'tin', 'cobalt', 'lithium',
  'lme', 'comex', 'metal', 'mining', 'smelter', 'refinery', 'ore',
  'concentrate', 'warehouse stocks', 'codelco', 'freeport', 'glencore',
  'bhp', 'rio tinto', 'anglo american', 'china demand', 'supply chain',
  'iron ore', 'steel', 'scrap metal', 'base metal', 'precious metal',
  'gold', 'silver', 'platinum', 'palladium',
];

const CRYPTO_ONLY_PATTERNS = [/\bbitcoin\b/i, /\bethereum\b/i, /\bcrypto\b/i];

export function isObviouslyIrrelevant(item: NewsItem): boolean {
  const text = `${item.headline} ${item.summary ?? ''}`;
  for (const pattern of IRRELEVANT_PATTERNS) {
    if (pattern.test(item.headline)) return true;
  }
  const lowerText = text.toLowerCase();
  const hasCrypto = CRYPTO_ONLY_PATTERNS.some((p) => p.test(item.headline));
  if (hasCrypto) {
    const hasMetals = METALS_KEYWORDS.some((kw) => lowerText.includes(kw));
    if (!hasMetals) return true;
  }
  return false;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

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

// Use parseString throughout — avoids the Node.js http/https compat layer
// that parseURL relies on. Deno's native fetch is used instead.
const rssParser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { 'User-Agent': USER_AGENT },
  customFields: { item: ['summary', 'media:content', 'media:thumbnail'] },
});

/**
 * Attempt to clean up common XML issues found in the wild:
 * - Attribute without value  (e.g. `<tag attr />`)
 * - Bare ampersands in text nodes
 */
function sanitiseXml(xml: string): string {
  return xml
    .replace(/(<[^>]*)\s([\w:-]+)([\s/>])/g, (_m, before, attr, after) => {
      return `${before} ${attr}="${attr}"${after}`;
    })
    .replace(/&(?!(?:#\d+|#x[\da-fA-F]+|[\w]+);)/g, '&amp;');
}

export async function fetchRssFeed(url: string, sourceName: string): Promise<NewsItem[]> {
  const t0 = Date.now();

  // Always use Deno's native fetch + parseString (not parseURL)
  let raw: string;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.text();
  } catch (fetchErr) {
    throw new Error(`fetch failed: ${String(fetchErr)}`);
  }

  let feed: Awaited<ReturnType<typeof rssParser.parseString>>;
  try {
    feed = await rssParser.parseString(raw);
  } catch {
    // Fallback: sanitise XML and retry
    try {
      feed = await rssParser.parseString(sanitiseXml(raw));
    } catch (parseErr) {
      throw new Error(`parse failed (raw + sanitised): ${String(parseErr)}`);
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

    const rawSummary =
      (entry as Record<string, unknown>).summary as string ??
      entry.contentSnippet ??
      entry.content ??
      null;
    const summary = normaliseSummary(rawSummary);

    const rawDate = entry.isoDate ?? entry.pubDate ?? null;
    const published_at = parseDate(rawDate) ?? new Date().toISOString();

    items.push({ source: sourceName, source_type: 'rss', headline, url: normUrl, summary, published_at });
  }

  console.log(`[news-fetcher] ${sourceName}: ${items.length} items in ${elapsed}ms`);
  return items;
}

// ─── HTML scrape: LME Press Releases ─────────────────────────────────────────

export async function scrapeLmePressReleases(): Promise<NewsItem[]> {
  const SOURCE = 'LME Press Releases';
  const url = 'https://www.lme.com/en/News/Press-releases';
  const t0 = Date.now();

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  const items: NewsItem[] = [];
  const fetchedAt = new Date().toISOString();
  const seen = new Set<string>();

  const candidates = [
    $('article').toArray(),
    $('li').has('a[href*="/News/Press-releases/"]').toArray(),
    $('a[href*="/News/Press-releases/"]').toArray(),
  ];

  for (const els of candidates) {
    if (items.length > 0) break;

    for (const el of els) {
      const elem = $(el);
      const linkEl = el.tagName === 'a' ? elem : elem.find('a[href*="/News/Press-releases/"]').first();
      let href = linkEl.attr('href') ?? '';
      if (!href) continue;
      if (!href.startsWith('http')) href = `https://www.lme.com${href}`;
      const normUrl = normaliseUrl(href);
      if (seen.has(normUrl)) continue;

      const headline = normaliseHeadlineText(
        elem.find('h1, h2, h3, h4, .title, .headline').first().text() || linkEl.text(),
      );
      if (!headline || headline.length < 5) continue;

      const rawDateText =
        elem.find('time').attr('datetime') ??
        elem.find('time').text() ??
        elem.find('.date, .published, [class*="date"], [class*="Date"]').first().text() ??
        null;
      const published_at = parseDate(rawDateText) ?? fetchedAt;

      seen.add(normUrl);
      items.push({ source: SOURCE, source_type: 'html', headline, url: normUrl, summary: null, published_at });
    }
  }

  console.log(`[news-fetcher] ${SOURCE}: ${items.length} items in ${Date.now() - t0}ms`);
  return items;
}

// ─── HTML scrape: Kitco Base Metals ──────────────────────────────────────────

export async function scrapeKitcoBaseMetals(): Promise<NewsItem[]> {
  const SOURCE = 'Kitco Base Metals';
  const url = 'https://www.kitco.com/news/category/base-metals';
  const t0 = Date.now();

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  const items: NewsItem[] = [];
  const fetchedAt = new Date().toISOString();
  const seen = new Set<string>();

  const articleEls = $('article, .article-card, .news-item, [class*="article"], [class*="Article"]').toArray();
  const linkEls = articleEls.length > 0
    ? articleEls
    : $('a[href*="/news/"]').has('h2, h3, h4, .title').toArray();

  for (const el of linkEls) {
    const elem = $(el);
    const linkEl = el.tagName === 'a' ? elem : elem.find('a[href*="/news/"]').first();
    let href = linkEl.attr('href') ?? '';
    if (!href) href = elem.find('a').first().attr('href') ?? '';
    if (!href || href === '#') continue;
    if (!href.startsWith('http')) href = `https://www.kitco.com${href}`;
    const normUrl = normaliseUrl(href);
    if (seen.has(normUrl)) continue;

    const headline = normaliseHeadlineText(
      elem.find('h1, h2, h3, h4, .title, .headline').first().text() ||
      (el.tagName === 'a' ? elem.text() : ''),
    );
    if (!headline || headline.length < 5) continue;

    const rawDate =
      elem.find('time').attr('datetime') ??
      elem.find('time').text() ??
      elem.find('.date, .timestamp, [class*="date"], [class*="Date"], [class*="time"]').first().text() ??
      null;
    const published_at = parseDate(rawDate) ?? fetchedAt;

    seen.add(normUrl);
    items.push({ source: SOURCE, source_type: 'html', headline, url: normUrl, summary: null, published_at });
  }

  console.log(`[news-fetcher] ${SOURCE}: ${items.length} items in ${Date.now() - t0}ms`);
  return items;
}

// ─── Main aggregator ──────────────────────────────────────────────────────────

export async function fetchAllNews(): Promise<RssFetchResult> {
  const fetchedAt = new Date().toISOString();
  const t0 = Date.now();

  const rssSources = FEED_SOURCES.filter((s) => s.type === 'rss');
  const htmlSources = FEED_SOURCES.filter((s) => s.type === 'html');

  type SourceResult = { source: string; items: NewsItem[]; error?: string };

  const rssPromises: Promise<SourceResult>[] = rssSources.map((src) =>
    fetchRssFeed(src.url, src.name)
      .then((items) => ({ source: src.name, items }))
      .catch((err) => ({ source: src.name, items: [], error: String(err) }))
  );

  const scrapePromises: Promise<SourceResult>[] = [];

  for (const src of htmlSources) {
    if (src.name === 'LME Press Releases') {
      scrapePromises.push(
        scrapeLmePressReleases()
          .then((items) => ({ source: src.name, items }))
          .catch((err) => ({ source: src.name, items: [], error: String(err) })),
      );
    } else if (src.name === 'Kitco Base Metals') {
      scrapePromises.push(
        scrapeKitcoBaseMetals()
          .then((items) => ({ source: src.name, items }))
          .catch((err) => ({ source: src.name, items: [], error: String(err) })),
      );
    }
  }

  const settled = await Promise.allSettled([...rssPromises, ...scrapePromises]);

  const allItems: NewsItem[] = [];
  const sourceStats: RssFetchResult['source_stats'] = [];
  const topLevelErrors: string[] = [];

  for (const result of settled) {
    if (result.status === 'rejected') {
      topLevelErrors.push(`Unexpected rejection: ${String(result.reason)}`);
      continue;
    }
    const { source, items, error } = result.value;
    sourceStats.push({ source, fetched: items.length, errors: error ? [error] : [] });
    allItems.push(...items);
  }

  const rawCount = allItems.length;

  // Dedup — primary: normalised URL; secondary: normalised headline
  // Sort newest-first so we keep the freshest version on URL collision
  allItems.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

  const seenUrls = new Set<string>();
  const seenHeadlines = new Set<string>();
  const deduped: NewsItem[] = [];

  for (const item of allItems) {
    const normUrl = normaliseUrl(item.url);
    const normHead = normaliseHeadline(item.headline);
    if (seenUrls.has(normUrl)) continue;
    if (normHead.length >= 10 && seenHeadlines.has(normHead)) continue;
    seenUrls.add(normUrl);
    if (normHead.length >= 10) seenHeadlines.add(normHead);
    deduped.push(item);
  }

  // Relevance filter
  const filtered = deduped.filter((item) => !isObviouslyIrrelevant(item));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[news-fetcher] ${FEED_SOURCES.length} sources | ${rawCount} raw | ` +
    `${deduped.length} after RSS dedup | ${filtered.length} after filter | ${elapsed}s`,
  );

  let status: RssFetchResult['status'];
  let reason: string | undefined;

  if (filtered.length === 0) {
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
