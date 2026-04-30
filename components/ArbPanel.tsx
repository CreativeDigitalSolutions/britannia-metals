'use client'

import type { ArbHistoryRow } from '@/lib/data'

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

export default function ArbPanel({ current, history }: ArbPanelProps) {
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
      </div>

      {current === null ? (
        <p className="font-mono text-[13px] text-[#6B6B6B]">
          No arbitrage data yet — populating on next ingest cycle.
        </p>
      ) : (
        <>
          <div className="flex flex-row gap-8 lg:gap-12 items-start">
            <BigNumber
              label="LME 3M"
              value={`$${current.lme_copper_usd_tonne.toLocaleString('en-GB')}`}
              sub="USD/tonne"
            />

            <div className="self-stretch w-px bg-[#D4D0C8] hidden sm:block" />

            <BigNumber
              label="COMEX Front"
              value={`$${current.comex_copper_usd_tonne.toLocaleString('en-GB')}`}
              sub="USD/tonne"
            />

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

          </div>

          <p className="mt-3 pt-3 border-t border-[#D4D0C8] font-mono text-[11px] text-[#6B6B6B]">
            Spread widens when COMEX trades at a premium to LME. COMEX price converted from $/lb × 2,204.62.
          </p>
        </>
      )}
    </section>
  )
}
