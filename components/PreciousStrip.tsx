import MetalTile from './MetalTile'
import type { MetalDisplayData } from '@/lib/data'

interface PreciousStripProps {
  metals: MetalDisplayData[]
}

export default function PreciousStrip({ metals }: PreciousStripProps) {
  return (
    <section>
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <span
          className="font-mono text-xs text-[#6B6B6B] tracking-widest uppercase"
          style={{ fontVariant: 'small-caps' }}
        >
          Precious Metals&ensp;·&ensp;Spot
        </span>
        <span className="font-mono text-[11px] text-[#6B6B6B]">USD/troy oz</span>
      </div>

      {/* 2-col grid */}
      <div className="grid grid-cols-2 gap-[1px] bg-[#D4D0C8] border border-[#D4D0C8]">
        {metals.map((metal) => (
          <MetalTile key={metal.id} metal={metal} variant="precious" />
        ))}
      </div>
    </section>
  )
}
