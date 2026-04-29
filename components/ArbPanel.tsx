'use client'

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { ArbHistoryRow } from '@/lib/data'
import { ArbSparkline } from '@/components/ArbSparkline'

interface ArbPanelProps {
  current: ArbHistoryRow | null
  history: ArbHistoryRow[]
}

function BigNumber({
  label,
  value,
  sub,
  coloured,
}: {
  label: string
  value: string
  sub?: string
  coloured?: 'gain' | 'loss' | null
}) {
  const colour =
    coloured === 'gain'
      ? 'text-[#1F6B47]'
      : coloured === 'loss'
      ? 'text-[#A8322E]'
      : 'text-[#1A1A1A]'

  return (
    <div className="flex flex-col gap-1">
      <span
        className="font-mono text-[10px] tracking-widest uppercase text-[#6B6B6B]"
        style={{ fontVariant: 'small-caps' }}
      >
        {label}
      </span>
      <span className={`font-mono tabular-nums text-3xl font-semibold leading-none ${colour}`}>
        {value}
      </span>
      {sub && (
        <span className="font-mono text-xs text-[#6B6B6B] tabular-nums">{sub}</span>
      )}
    </div>
  )
}

function SpreadTooltip({ active, payload }: {
  active?: boolean
  payload?: { value: number }[]
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-[#FAF8F4] border border-[#D4D0C8] px-2 py-1">
      <span className="font-mono text-xs text-[#1A1A1A]">
        ${payload[0].value}/t
      </span>
    </div>
  )
}

export default function ArbPanel({ current, history }: ArbPanelProps) {
  const sparklineData = history.map((row, i) => ({ day: i + 1, spread: row.spread_usd }))

  const lmeUnavailable = current !== null && current.spread_usd === 0

  return (
    <section className="border border-[#D4D0C8] bg-[#F2EFE8] p-5">
      {/* Section header */}
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-[#D4D0C8]">
        <span
          className="font-mono text-xs text-[#6B6B6B] tracking-widest uppercase"
          style={{ fontVariant: 'small-caps' }}
        >
          LME–COMEX Copper Arbitrage
        </span>
        <span className="font-mono text-[11px] text-[#6B6B6B]">30-day spread</span>
      </div>

      {current === null ? (
        <p className="font-mono text-[13px] text-[#6B6B6B]">
          No arbitrage data yet — populating on next ingest cycle.
        </p>
      ) : (
        <>
          {/* Main content: big numbers left, sparkline right */}
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Big numbers */}
            <div className="flex flex-row gap-8 lg:gap-12 items-start">
              <BigNumber
                label="LME 3M"
                value={`$${current.lme_copper_usd_tonne.toLocaleString('en-GB')}`}
                sub="USD/tonne"
              />

              {/* Vertical divider */}
              <div className="self-stretch w-px bg-[#D4D0C8] hidden sm:block" />

              <BigNumber
                label="COMEX Front"
                value={`$${current.comex_copper_usd_tonne.toLocaleString('en-GB')}`}
                sub="USD/tonne"
              />

              {/* Vertical divider */}
              <div className="self-stretch w-px bg-[#D4D0C8] hidden sm:block" />

              {lmeUnavailable ? (
                <div className="flex flex-col gap-1">
                  <span
                    className="font-mono text-[10px] tracking-widest uppercase text-[#6B6B6B]"
                    style={{ fontVariant: 'small-caps' }}
                  >
                    Spread
                  </span>
                  <span className="font-mono text-sm text-[#6B6B6B]">
                    n/a — LME feed unavailable
                  </span>
                </div>
              ) : (
                <BigNumber
                  label="Spread"
                  value={`${current.spread_usd >= 0 ? '+' : ''}$${Math.abs(current.spread_usd).toLocaleString('en-GB')}`}
                  sub={`${current.spread_pct >= 0 ? '+' : ''}${current.spread_pct.toFixed(2)}%`}
                  coloured={current.spread_usd >= 0 ? 'gain' : 'loss'}
                />
              )}

              {/* Vertical divider */}
              <div className="self-stretch w-px bg-[#D4D0C8] hidden sm:block" />

              {/* Inline spread sparkline — 14-day slice */}
              <div className="flex flex-col justify-center">
                <ArbSparkline history={history.slice(-14)} />
              </div>
            </div>

            {/* Sparkline */}
            {sparklineData.length > 0 && (
              <div className="flex-1 min-w-0 h-20">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={sparklineData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <XAxis dataKey="day" hide />
                    <YAxis
                      domain={['dataMin - 10', 'dataMax + 10']}
                      hide
                    />
                    <Tooltip content={<SpreadTooltip />} />
                    <Line
                      type="monotone"
                      dataKey="spread"
                      stroke="#0B2545"
                      strokeWidth={1.5}
                      dot={false}
                      activeDot={{ r: 3, fill: '#0B2545', strokeWidth: 0 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Footnote */}
          <p className="mt-3 pt-3 border-t border-[#D4D0C8] font-mono text-[11px] text-[#6B6B6B]">
            Spread widens when COMEX trades at a premium to LME. COMEX price converted from $/lb × 2,204.62.
          </p>
        </>
      )}
    </section>
  )
}
