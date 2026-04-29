'use client'

import { useState, useMemo } from 'react'
import MetalTile from '@/components/MetalTile'
import { PriceChart } from '@/components/PriceChart'
import type { MetalDisplayData } from '@/lib/data'
import type { PriceRow } from '@/types/database'
import type { Metal } from '@/lib/metals'

interface MetalsStripWithDrilldownProps {
  baseMetals: MetalDisplayData[]
  preciousMetals: MetalDisplayData[]
  priceHistories: Record<string, PriceRow[]>
}

export default function MetalsStripWithDrilldown({
  baseMetals,
  preciousMetals,
  priceHistories,
}: MetalsStripWithDrilldownProps) {
  const [selectedMetal, setSelectedMetal] = useState<Metal | null>(null)

  const selectedHistory = useMemo(
    () => (selectedMetal ? (priceHistories[selectedMetal] ?? []) : []),
    [selectedMetal, priceHistories],
  )

  return (
    <>
      {/* LME Base Metals Strip */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <span
            className="font-mono text-xs text-[#6B6B6B] tracking-widest uppercase"
            style={{ fontVariant: 'small-caps' }}
          >
            LME Base Metals&ensp;·&ensp;Official Cash &amp; 3M
          </span>
          <span className="font-mono text-[11px] text-[#6B6B6B]">USD/tonne</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-[1px] bg-[#D4D0C8] border border-[#D4D0C8]">
          {baseMetals.map((metal) => (
            <MetalTile
              key={metal.id}
              metal={metal}
              variant="base"
              onClick={() => setSelectedMetal(metal.id as Metal)}
            />
          ))}
        </div>
      </section>

      {/* Precious Metals Strip */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <span
            className="font-mono text-xs text-[#6B6B6B] tracking-widest uppercase"
            style={{ fontVariant: 'small-caps' }}
          >
            Precious Metals&ensp;·&ensp;Spot
          </span>
          <span className="font-mono text-[11px] text-[#6B6B6B]">USD/troy oz</span>
        </div>
        <div className="grid grid-cols-2 gap-[1px] bg-[#D4D0C8] border border-[#D4D0C8]">
          {preciousMetals.map((metal) => (
            <MetalTile
              key={metal.id}
              metal={metal}
              variant="precious"
              onClick={() => setSelectedMetal(metal.id as Metal)}
            />
          ))}
        </div>
      </section>

      {/* Price chart drilldown modal */}
      <PriceChart
        metal={selectedMetal}
        priceHistory={selectedHistory}
        onClose={() => setSelectedMetal(null)}
      />
    </>
  )
}
