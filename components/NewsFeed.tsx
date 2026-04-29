'use client'

import { useState } from 'react'
import type { NewsRow } from '@/lib/data'
import NewsItemComponent from './NewsItem'

const ALL_METALS = ['All metals', 'Copper', 'Aluminium', 'Zinc', 'Nickel', 'Lead', 'Tin', 'Gold', 'Silver']

interface NewsFeedProps {
  items: NewsRow[]
}

export default function NewsFeed({ items }: NewsFeedProps) {
  const [filter, setFilter] = useState('All metals')

  const filtered =
    filter === 'All metals'
      ? items
      : items.filter((item) =>
          item.metals?.some((m) => m.toLowerCase() === filter.toLowerCase())
        )

  return (
    <section className="border border-[#D4D0C8] bg-[#FAF8F4]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#D4D0C8] flex items-center justify-between">
        <span
          className="font-mono text-xs text-[#6B6B6B] tracking-widest uppercase"
          style={{ fontVariant: 'small-caps' }}
        >
          News &amp; Analysis
        </span>

        {/* Filter dropdown */}
        <div className="relative">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="font-mono text-[11px] text-[#4A4A4A] bg-[#FAF8F4] border border-[#D4D0C8] px-2 py-1 pr-6 appearance-none cursor-pointer focus:outline-none focus:border-[#0B2545] hover:border-[#0B2545] transition-colors"
          >
            {ALL_METALS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {/* Custom caret */}
          <svg
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#6B6B6B] pointer-events-none"
            viewBox="0 0 12 12"
            fill="currentColor"
          >
            <path d="M6 9L1 3h10L6 9z" />
          </svg>
        </div>
      </div>

      {/* News list */}
      <div className="px-4 divide-y divide-[#D4D0C8]">
        {items.length === 0 ? (
          <p className="py-6 font-sans text-sm text-[#6B6B6B] text-center">
            No news yet — populating on next ingest cycle.
          </p>
        ) : filtered.length === 0 ? (
          <p className="py-6 font-sans text-sm text-[#6B6B6B] text-center">
            No news for {filter}
          </p>
        ) : (
          filtered.map((item) => (
            <NewsItemComponent key={item.id} item={item} />
          ))
        )}
      </div>
    </section>
  )
}
