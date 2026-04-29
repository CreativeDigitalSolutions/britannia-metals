'use client'

import { useEffect, useState } from 'react'

function LondonClock() {
  const [time, setTime] = useState<string>('')
  const [date, setDate] = useState<string>('')

  useEffect(() => {
    function update() {
      const now = new Date()
      const londonTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(now)

      const londonDate = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(now)

      setTime(londonTime)
      setDate(londonDate)
    }

    update()
    const id = setInterval(update, 60_000)
    return () => clearInterval(id)
  }, [])

  if (!time) return null

  return (
    <span className="font-mono text-sm text-[#4A4A4A] tabular-nums">
      {date}&ensp;·&ensp;{time}&ensp;BST
    </span>
  )
}

export default function Header() {
  return (
    <header className="w-full h-16 border-b border-[#D4D0C8] bg-[#FAF8F4] flex items-center px-6">
      <div className="w-full max-w-[1440px] mx-auto flex items-center justify-between">
        {/* Left: firm name */}
        <div className="flex items-center gap-3">
          <div
            className="w-6 h-6 border border-[#0B2545] flex items-center justify-center"
            aria-hidden="true"
          >
            <span className="font-serif font-bold text-[#0B2545] text-[10px] leading-none">B</span>
          </div>
          <span className="font-serif font-bold text-[#0B2545] tracking-widest uppercase text-sm"
            style={{ fontVariant: 'small-caps', letterSpacing: '0.15em' }}>
            Britannia Metals Desk
          </span>
        </div>

        {/* Centre: London clock */}
        <div className="absolute left-1/2 -translate-x-1/2">
          <LondonClock />
        </div>

        {/* Right: data freshness indicator */}
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full bg-[#1F6B47]"
            aria-label="Data fresh"
          />
          <span className="font-mono text-xs text-[#6B6B6B] tracking-wide">
            End-of-day LME official prices
          </span>
        </div>
      </div>
    </header>
  )
}
