import MetalTile from './MetalTile'
import type { MetalDisplayData } from '@/lib/data'

interface MetalsStripProps {
  metals: MetalDisplayData[]
}

export default function MetalsStrip({ metals }: MetalsStripProps) {
  return (
    <section>
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <span
          className="font-mono text-xs text-[#6B6B6B] tracking-widest uppercase"
          style={{ fontVariant: 'small-caps' }}
        >
          LME Base Metals&ensp;·&ensp;Official Cash &amp; 3M
        </span>
        <span className="font-mono text-[11px] text-[#6B6B6B]">USD/tonne</span>
      </div>

      {/* 3-col on desktop, 2-col on tablet */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-[1px] bg-[#D4D0C8] border border-[#D4D0C8]">
        {metals.map((metal) => (
          <MetalTile key={metal.id} metal={metal} variant="base" />
        ))}
      </div>
    </section>
  )
}
