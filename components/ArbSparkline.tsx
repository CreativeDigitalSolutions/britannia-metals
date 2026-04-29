'use client'

import { LineChart, Line, ResponsiveContainer } from 'recharts'
import type { ArbHistoryRow } from '@/types/database'

export interface ArbSparklineProps {
  history: ArbHistoryRow[]  // ascending by as_of; expects up to 14 rows
}

export function ArbSparkline({ history }: ArbSparklineProps) {
  if (history.length < 2) {
    return (
      <span className="font-mono text-xs text-[#6B6B6B]">
        — insufficient history —
      </span>
    )
  }

  const data = history.map((row, i) => ({ i, spread: row.spread_usd }))

  return (
    <div style={{ width: 120, height: 32 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            type="monotone"
            dataKey="spread"
            stroke="#0B2545"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default ArbSparkline
