// ─────────────────────────────────────────────────────────────────────────────
// Britannia Metals Desk — Mock Data
// All data is hardcoded for the frontend shell.
// Wave 2 will replace these exports with live Supabase/LME queries.
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────────────

export type SpreadType = 'contango' | 'backwardation'

export interface MetalData {
  id: string
  name: string
  symbol: string
  cashPrice: number
  threeMonthPrice: number
  spreadType: SpreadType
  spreadAmount: number
  dayChangePercent: number
  dayChangeDollar: number
  stockTonnes: number
  cancelledWarrantsPercent: number
  unit: 'tonne' | 'troy oz'
}

export interface ArbData {
  lme3m: number
  comexFront: number     // already in $/tonne (converted from $/lb × 2204.62)
  spreadDollar: number
  spreadPercent: number
  sparklineData: { day: number; spread: number }[]
}

export interface NewsItem {
  id: string
  source: string
  headline: string
  summary: string
  metalTags: string[]
  sentiment: 'bullish' | 'bearish' | 'neutral'
  minutesAgo: number
  url: string
}

export interface CalendarEvent {
  id: string
  dateLabel: string
  daysFromNow: number
  name: string
  impact: 'high' | 'medium' | 'low'
  relevantMetals: string[]
}

export interface MorningBriefData {
  publishedAt: string // ISO string
  body: string
}

export interface PricePoint {
  day: number
  price: number
}

// ── Base Metals ───────────────────────────────────────────────────────────────

export const mockBaseMetals: MetalData[] = [
  {
    id: 'copper',
    name: 'Copper',
    symbol: 'Cu',
    cashPrice: 11847,
    threeMonthPrice: 11820,
    spreadType: 'backwardation',
    spreadAmount: 27,
    dayChangePercent: 0.42,
    dayChangeDollar: 50,
    stockTonnes: 168225,
    cancelledWarrantsPercent: 8.4,
    unit: 'tonne',
  },
  {
    id: 'aluminium',
    name: 'Aluminium',
    symbol: 'Al',
    cashPrice: 2654,
    threeMonthPrice: 2691,
    spreadType: 'contango',
    spreadAmount: 37,
    dayChangePercent: -0.18,
    dayChangeDollar: -5,
    stockTonnes: 512450,
    cancelledWarrantsPercent: 12.1,
    unit: 'tonne',
  },
  {
    id: 'zinc',
    name: 'Zinc',
    symbol: 'Zn',
    cashPrice: 2912,
    threeMonthPrice: 2938,
    spreadType: 'contango',
    spreadAmount: 26,
    dayChangePercent: 0.85,
    dayChangeDollar: 25,
    stockTonnes: 221300,
    cancelledWarrantsPercent: 5.6,
    unit: 'tonne',
  },
  {
    id: 'nickel',
    name: 'Nickel',
    symbol: 'Ni',
    cashPrice: 17420,
    threeMonthPrice: 17580,
    spreadType: 'contango',
    spreadAmount: 160,
    dayChangePercent: -1.22,
    dayChangeDollar: -215,
    stockTonnes: 189600,
    cancelledWarrantsPercent: 3.2,
    unit: 'tonne',
  },
  {
    id: 'lead',
    name: 'Lead',
    symbol: 'Pb',
    cashPrice: 2156,
    threeMonthPrice: 2178,
    spreadType: 'contango',
    spreadAmount: 22,
    dayChangePercent: 0.31,
    dayChangeDollar: 7,
    stockTonnes: 267800,
    cancelledWarrantsPercent: 6.8,
    unit: 'tonne',
  },
  {
    id: 'tin',
    name: 'Tin',
    symbol: 'Sn',
    cashPrice: 38240,
    threeMonthPrice: 38100,
    spreadType: 'backwardation',
    spreadAmount: 140,
    dayChangePercent: 2.14,
    dayChangeDollar: 800,
    stockTonnes: 4680,
    cancelledWarrantsPercent: 18.7,
    unit: 'tonne',
  },
]

// ── Precious Metals ───────────────────────────────────────────────────────────

export const mockPreciousMetals: MetalData[] = [
  {
    id: 'gold',
    name: 'Gold',
    symbol: 'Au',
    cashPrice: 2847.5,
    threeMonthPrice: 2847.5,
    spreadType: 'contango',
    spreadAmount: 0,
    dayChangePercent: 0.62,
    dayChangeDollar: 17.5,
    stockTonnes: 0,
    cancelledWarrantsPercent: 0,
    unit: 'troy oz',
  },
  {
    id: 'silver',
    name: 'Silver',
    symbol: 'Ag',
    cashPrice: 33.18,
    threeMonthPrice: 33.18,
    spreadType: 'contango',
    spreadAmount: 0,
    dayChangePercent: 1.24,
    dayChangeDollar: 0.41,
    stockTonnes: 0,
    cancelledWarrantsPercent: 0,
    unit: 'troy oz',
  },
]

// ── LME–COMEX Arbitrage ───────────────────────────────────────────────────────

// 30 days of synthetic spread data — realistic range around current $65 spread
function generateSparkline(): { day: number; spread: number }[] {
  const base = [
    72, 68, 75, 81, 78, 65, 59, 55, 61, 68,
    74, 80, 84, 77, 70, 63, 58, 62, 69, 74,
    79, 83, 76, 71, 66, 61, 64, 67, 63, 65,
  ]
  return base.map((spread, i) => ({ day: i + 1, spread }))
}

export const mockArbData: ArbData = {
  lme3m: 11847,
  comexFront: 11912,
  spreadDollar: 65,
  spreadPercent: 0.55,
  sparklineData: generateSparkline(),
}

// ── Morning Brief ─────────────────────────────────────────────────────────────

export const mockMorningBrief: MorningBriefData = {
  publishedAt: new Date().toISOString().replace(/T.*/, 'T07:00:00.000Z'),
  body: `Copper extended yesterday's gains in Asian trading as Chilean supply concerns persist. Codelco reported a fresh disruption at Chuquicamata overnight, with production estimates revised down by approximately 15,000 tonnes for the quarter. Aluminium traded sideways despite a build in LME stocks, with the market focused on tomorrow's Chinese industrial production data. Nickel remains volatile following Indonesian export quota changes announced late Tuesday, with the three-month contract briefly touching $17,200 before recovering. Tin continues its strong run on acute stock depletion — cancelled warrants now stand at 18.7%. Watch today: LME weekly stocks at 09:00 BST; US CPI at 13:30 BST.`,
}

// ── News Feed ─────────────────────────────────────────────────────────────────

export const mockNewsItems: NewsItem[] = [
  {
    id: 'n1',
    source: 'Reuters',
    headline: 'Codelco reports overnight disruption at Chuquicamata; 15,000t quarterly output at risk',
    summary: 'Chile\'s state copper producer confirmed mechanical failures in the smelter affecting near-term production guidance.',
    metalTags: ['Copper'],
    sentiment: 'bearish',
    minutesAgo: 47,
    url: '#',
  },
  {
    id: 'n2',
    source: 'Bloomberg',
    headline: 'LME tin stocks hit four-year low as Indonesia tightens export quotas',
    summary: 'Available inventory fell to 4,680 tonnes; cancelled warrants at 18.7% signal further drawdown ahead.',
    metalTags: ['Tin'],
    sentiment: 'bullish',
    minutesAgo: 112,
    url: '#',
  },
  {
    id: 'n3',
    source: 'Metal Bulletin',
    headline: 'Chinese aluminium smelters restart delayed by power rationing in Yunnan',
    summary: 'Approximately 800,000 tonnes of annualised capacity remains curtailed following hydro shortfall.',
    metalTags: ['Aluminium'],
    sentiment: 'bullish',
    minutesAgo: 155,
    url: '#',
  },
  {
    id: 'n4',
    source: 'Fastmarkets',
    headline: 'COMEX copper open interest surges to three-month high ahead of CPI print',
    summary: 'Speculative net long positions at highest since January; options skew remains tilted to upside.',
    metalTags: ['Copper'],
    sentiment: 'bullish',
    minutesAgo: 203,
    url: '#',
  },
  {
    id: 'n5',
    source: 'FT',
    headline: 'Nickel market braces for Indonesian NPI capacity expansion data',
    summary: 'HPAL output growth in Q1 exceeded forecasts; surplus concerns drag on the three-month price.',
    metalTags: ['Nickel'],
    sentiment: 'bearish',
    minutesAgo: 278,
    url: '#',
  },
  {
    id: 'n6',
    source: 'S&P Global',
    headline: 'Zinc treatment charges slide to multi-year lows as concentrate tightness persists',
    summary: 'TC/RC negotiations between miners and smelters remain deadlocked; spot market TCs hit $5/t in Asia.',
    metalTags: ['Zinc'],
    sentiment: 'bullish',
    minutesAgo: 341,
    url: '#',
  },
  {
    id: 'n7',
    source: 'Platts',
    headline: 'Gold holds above $2,840 as dollar weakens on softer US labour data',
    summary: 'Fed futures now price 68bps of cuts by year-end, underpinning bullion demand.',
    metalTags: ['Gold'],
    sentiment: 'bullish',
    minutesAgo: 392,
    url: '#',
  },
  {
    id: 'n8',
    source: 'Reuters',
    headline: 'Lead battery recycling margins under pressure as scrap prices rise',
    summary: 'Secondary lead spreads tighten in Europe; recyclers flag cost pressures heading into H2.',
    metalTags: ['Lead'],
    sentiment: 'neutral',
    minutesAgo: 445,
    url: '#',
  },
  {
    id: 'n9',
    source: 'Bloomberg',
    headline: 'Silver industrial demand forecast raised by Silver Institute for 2025',
    summary: 'Solar panel manufacturing drives record off-take; above-ground stocks remain ample.',
    metalTags: ['Silver'],
    sentiment: 'bullish',
    minutesAgo: 512,
    url: '#',
  },
  {
    id: 'n10',
    source: 'CRU',
    headline: 'Copper scrap arbitrage tightens as Chinese buyers return post-holiday',
    summary: 'Grade A equivalent scrap at 97% of cathode equivalent; refined imports expected to ease.',
    metalTags: ['Copper'],
    sentiment: 'neutral',
    minutesAgo: 601,
    url: '#',
  },
]

// ── Events Calendar ───────────────────────────────────────────────────────────

export const mockCalendarEvents: CalendarEvent[] = [
  {
    id: 'e1',
    dateLabel: 'Tomorrow · 09:00 BST',
    daysFromNow: 1,
    name: 'LME weekly stock report',
    impact: 'high',
    relevantMetals: ['All metals'],
  },
  {
    id: 'e2',
    dateLabel: 'Tomorrow · 09:30 BST',
    daysFromNow: 1,
    name: 'LBMA gold price auction (AM)',
    impact: 'medium',
    relevantMetals: ['Gold'],
  },
  {
    id: 'e3',
    dateLabel: 'Friday · 07:00 BST',
    daysFromNow: 3,
    name: 'Chinese industrial production (Mar)',
    impact: 'high',
    relevantMetals: ['Copper', 'Aluminium', 'Nickel'],
  },
  {
    id: 'e4',
    dateLabel: 'Friday · 13:30 BST',
    daysFromNow: 3,
    name: 'US CPI (Mar)',
    impact: 'high',
    relevantMetals: ['Copper', 'Gold', 'Silver'],
  },
  {
    id: 'e5',
    dateLabel: 'Mon +3 · 07:00 BST',
    daysFromNow: 5,
    name: 'Chilean copper production (Feb)',
    impact: 'high',
    relevantMetals: ['Copper'],
  },
  {
    id: 'e6',
    dateLabel: 'Mon +3 · 07:00 BST',
    daysFromNow: 5,
    name: 'Chinese CPI (Mar)',
    impact: 'medium',
    relevantMetals: ['Aluminium', 'Zinc'],
  },
  {
    id: 'e7',
    dateLabel: 'Wed +7 · 19:00 BST',
    daysFromNow: 7,
    name: 'FOMC minutes release',
    impact: 'high',
    relevantMetals: ['Gold', 'Copper'],
  },
  {
    id: 'e8',
    dateLabel: 'Thu +8 · 12:00 BST',
    daysFromNow: 8,
    name: 'LME monthly metals seminar',
    impact: 'low',
    relevantMetals: ['All metals'],
  },
]

// ── 30-Day Copper Price Chart ─────────────────────────────────────────────────

export const mockCopper30d: PricePoint[] = [
  { day: 1, price: 11420 },
  { day: 2, price: 11380 },
  { day: 3, price: 11445 },
  { day: 4, price: 11510 },
  { day: 5, price: 11488 },
  { day: 6, price: 11530 },
  { day: 7, price: 11612 },
  { day: 8, price: 11575 },
  { day: 9, price: 11540 },
  { day: 10, price: 11490 },
  { day: 11, price: 11555 },
  { day: 12, price: 11620 },
  { day: 13, price: 11680 },
  { day: 14, price: 11720 },
  { day: 15, price: 11695 },
  { day: 16, price: 11740 },
  { day: 17, price: 11810 },
  { day: 18, price: 11780 },
  { day: 19, price: 11760 },
  { day: 20, price: 11720 },
  { day: 21, price: 11745 },
  { day: 22, price: 11790 },
  { day: 23, price: 11820 },
  { day: 24, price: 11870 },
  { day: 25, price: 11840 },
  { day: 26, price: 11810 },
  { day: 27, price: 11830 },
  { day: 28, price: 11795 },
  { day: 29, price: 11820 },
  { day: 30, price: 11847 },
]
