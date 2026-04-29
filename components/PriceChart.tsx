'use client'

import { useMemo } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getMetal } from '@/lib/metals'
import type { Metal } from '@/lib/metals'
import type { PriceRow } from '@/types/database'

export interface PriceChartProps {
  metal: Metal | null        // null = modal closed
  priceHistory: PriceRow[]   // server-fetched, passed via props
  onClose: () => void
}

function fmtAxisDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

function fmtTooltipDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtPrice(value: number, unit: 'tonne' | 'troy_oz'): string {
  if (unit === 'troy_oz') {
    return `$${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  return `$${value.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

interface ChartPoint {
  label: string
  isoDate: string
  price: number
  unit: 'tonne' | 'troy_oz'
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: ChartPoint }>
}) {
  if (!active || !payload?.length) return null
  const { isoDate, price, unit } = payload[0].payload
  return (
    <div className="bg-[#0B2545] px-3 py-1.5">
      <span className="font-mono text-[12px] text-white whitespace-nowrap">
        {fmtTooltipDate(isoDate)}&ensp;·&ensp;{fmtPrice(price, unit)}
      </span>
    </div>
  )
}

export function PriceChart({ metal, priceHistory, onClose }: PriceChartProps) {
  const metalConfig = metal ? getMetal(metal) : null

  const chartData = useMemo<ChartPoint[]>(() => {
    if (!metalConfig) return []
    return priceHistory.map((row) => ({
      label: fmtAxisDate(row.as_of),
      isoDate: row.as_of,
      price: row.price,
      unit: metalConfig.unit,
    }))
  }, [priceHistory, metalConfig])

  const priceMin = useMemo(
    () => (chartData.length ? Math.min(...chartData.map((d) => d.price)) : 0),
    [chartData],
  )
  const priceMax = useMemo(
    () => (chartData.length ? Math.max(...chartData.map((d) => d.price)) : 0),
    [chartData],
  )

  // Y-axis domain with breathing room
  const yPad = Math.max((priceMax - priceMin) * 0.08, 10)
  const yDomain: [number, number] = [priceMin - yPad, priceMax + yPad]

  const unitLabel = metalConfig?.unit === 'troy_oz' ? 'USD/oz' : 'USD/tonne'

  const yTickFormatter = (v: number) => {
    if (metalConfig?.unit === 'troy_oz') {
      return `$${Math.round(v).toLocaleString('en-GB')}`
    }
    return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`
  }

  // Thin out X-axis ticks so they don't crowd
  const xInterval = Math.max(0, Math.floor(chartData.length / 8) - 1)

  const sourceRow = priceHistory[priceHistory.length - 1] ?? null
  const sourceLabel =
    sourceRow?.source === 'lme_official'
      ? 'LME official'
      : 'Yahoo Finance (indicative)'

  const dateFrom = priceHistory[0]?.as_of ? fmtAxisDate(priceHistory[0].as_of) : '—'
  const dateTo = priceHistory[priceHistory.length - 1]?.as_of
    ? fmtAxisDate(priceHistory[priceHistory.length - 1].as_of)
    : '—'

  return (
    <Dialog open={metal !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {metalConfig?.display_name}&ensp;·&ensp;30-day price history
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 py-6">
          {/* ── Empty state: no data at all ── */}
          {priceHistory.length === 0 && (
            <p className="font-mono text-[13px] text-[#6B6B6B] leading-relaxed">
              Historical price data unavailable for this metal. The LME public data feed is
              blocked at runtime; brokers typically access this via licensed feeds.
            </p>
          )}

          {/* ── Edge case: only one data point ── */}
          {priceHistory.length === 1 && (
            <div>
              <p className="font-mono text-[13px] text-[#6B6B6B] mb-5">
                Limited history available — first data point captured {fmtAxisDate(priceHistory[0].as_of)}.
              </p>
              <div className="h-[320px] flex items-center justify-center">
                <div className="text-center">
                  <div className="font-mono tabular-nums text-3xl font-semibold text-[#1A1A1A]">
                    {metalConfig ? fmtPrice(priceHistory[0].price, metalConfig.unit) : '—'}
                  </div>
                  <div className="font-mono text-xs text-[#6B6B6B] mt-1">{unitLabel}</div>
                </div>
              </div>
            </div>
          )}

          {/* ── Full chart ── */}
          {priceHistory.length >= 2 && (
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
                >
                  {/* Single faint horizontal rule at the lowest price */}
                  <ReferenceLine
                    y={priceMin}
                    stroke="#D4D0C8"
                    strokeWidth={1}
                  />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={{ stroke: '#D4D0C8', strokeWidth: 1 }}
                    tick={{
                      fontFamily: 'var(--font-ibm-plex-mono)',
                      fontSize: 10,
                      fill: '#6B6B6B',
                    }}
                    interval={xInterval}
                  />
                  <YAxis
                    domain={yDomain}
                    tickLine={false}
                    axisLine={false}
                    tick={{
                      fontFamily: 'var(--font-ibm-plex-mono)',
                      fontSize: 10,
                      fill: '#6B6B6B',
                    }}
                    tickFormatter={yTickFormatter}
                    width={54}
                  />
                  <Tooltip
                    content={<CustomTooltip />}
                    cursor={{ stroke: '#D4D0C8', strokeWidth: 1 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="price"
                    stroke={metalConfig?.accent_color ?? '#0B2545'}
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={{
                      r: 3,
                      fill: metalConfig?.accent_color ?? '#0B2545',
                      strokeWidth: 0,
                    }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Footer: source + date range */}
          {priceHistory.length > 0 && (
            <div className="mt-4 pt-3 border-t border-[#D4D0C8]">
              <span className="font-mono text-[10px] text-[#6B6B6B]">
                Source: {sourceLabel}&ensp;·&ensp;{dateFrom} – {dateTo}
              </span>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default PriceChart
