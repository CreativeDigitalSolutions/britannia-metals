/**
 * feeds.config.ts
 * Single source of truth for all 13 news sources.
 * Edit this file to add/remove/adjust sources without touching rss.ts.
 */

export type FeedType = 'rss' | 'html';

export interface FeedSource {
  name: string;
  url: string;
  type: FeedType;
  notes?: string;
}

export const FEED_SOURCES: FeedSource[] = [
  // ── RSS / Atom feeds ──────────────────────────────────────────────────────
  {
    name: 'Mining.com',
    url: 'https://www.mining.com/feed/',
    type: 'rss',
  },
  {
    name: 'Kitco Mining',
    url: 'https://www.kitco.com/news/category/mining/rss',
    type: 'rss',
  },
  {
    name: 'Northern Miner',
    url: 'https://www.northernminer.com/feed/',
    type: 'rss',
  },
  {
    name: 'Mining Technology',
    url: 'https://www.mining-technology.com/feed',
    type: 'rss',
  },
  {
    name: 'Engineering & Mining Journal',
    url: 'https://www.e-mj.com/feed/',
    type: 'rss',
  },
  {
    name: 'Canadian Mining Journal',
    url: 'https://www.canadianminingjournal.com/feed/',
    type: 'rss',
  },
  {
    name: 'Mining Weekly',
    url: 'https://www.miningweekly.com/rss',
    type: 'rss',
    notes: 'URL occasionally restructured; verify if fetches fail.',
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
    notes:
      'Items link via Google News redirect URL; dedup by headline as primary key for this source.',
  },
  {
    name: 'Google News — copper market',
    url: 'https://news.google.com/rss/search?q=%22copper+market%22+OR+%22copper+price%22&hl=en-GB&gl=GB&ceid=GB:en',
    type: 'rss',
    notes:
      'Items link via Google News redirect URL; overlaps significantly with LME feed — dedup handles it.',
  },
  {
    name: 'MarketWatch metals',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',
    type: 'rss',
    notes:
      'Broader MarketWatch feed; AI classification (Session G) will filter for metals relevance.',
  },

  // ── HTML scrapes ─────────────────────────────────────────────────────────
  {
    name: 'LME Press Releases',
    url: 'https://www.lme.com/en/News/Press-releases',
    type: 'html',
    notes:
      'Scraped with cheerio. Selectors are fragile — see rss.README.md for current selector details.',
  },
  {
    name: 'Kitco Base Metals',
    url: 'https://www.kitco.com/news/category/base-metals',
    type: 'html',
    notes:
      'Base-metals category page; no dedicated RSS. Scraped with cheerio. Selectors are fragile.',
  },
];

/** RSS-only sources (convenience filter) */
export const RSS_SOURCES = FEED_SOURCES.filter((s) => s.type === 'rss');

/** HTML-scrape sources (convenience filter) */
export const HTML_SOURCES = FEED_SOURCES.filter((s) => s.type === 'html');
