import MorningBrief from '@/components/MorningBrief'
import ArbPanel from '@/components/ArbPanel'
import MetalsStripWithDrilldown from '@/components/MetalsStripWithDrilldown'
import NewsFeed from '@/components/NewsFeed'
import EventsCalendar from '@/components/EventsCalendar'
import {
  getLatestPrices,
  getLatestStocks,
  getLatestArb,
  getArbHistory,
  getRecentNews,
  getTodaysBrief,
  getUpcomingEvents,
  getPriceHistory,
  buildMetalDisplayData,
  BASE_METAL_CONFIGS,
  PRECIOUS_METAL_CONFIGS,
} from '@/lib/data'
import { METALS } from '@/lib/metals'

// Force dynamic rendering — page fetches live from Supabase on every request.
// ISR (revalidate) is unreliable here because env vars aren't available at build
// time, so the statically-baked version always has empty data.
export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const [prices, stocks, arb, arbHistory, news, brief, events] = await Promise.all([
    getLatestPrices(),
    getLatestStocks(),
    getLatestArb(),
    getArbHistory(30),
    getRecentNews(15),
    getTodaysBrief(),
    getUpcomingEvents(),
  ])

  const baseMetals = buildMetalDisplayData(BASE_METAL_CONFIGS, prices, stocks)
  const preciousMetals = buildMetalDisplayData(PRECIOUS_METAL_CONFIGS, prices, stocks)

  // Pre-fetch all 8 metals' 30-day history in parallel so the drilldown modal opens instantly
  const priceHistories = Object.fromEntries(
    await Promise.all(
      METALS.map(async (m) => [m.id, await getPriceHistory(m.id, 30)]),
    ),
  )

  return (
    <div className="flex flex-col gap-5">
      {/* 1. Morning Brief */}
      <MorningBrief brief={brief} />

      {/* 2. LME–COMEX Copper Arb Panel */}
      <ArbPanel current={arb} history={arbHistory} />

      {/* 3 & 4. Base Metals + Precious Metals (with drilldown modal) */}
      <MetalsStripWithDrilldown
        baseMetals={baseMetals}
        preciousMetals={preciousMetals}
        priceHistories={priceHistories}
      />

      {/* 5. News Feed (2/3) + Events Calendar (1/3) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <NewsFeed items={news} />
        </div>
        <div className="lg:col-span-1">
          <EventsCalendar events={events} />
        </div>
      </div>
    </div>
  )
}
