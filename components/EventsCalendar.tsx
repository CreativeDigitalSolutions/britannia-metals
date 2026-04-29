import type { Event } from '@/lib/data'
import { cn } from '@/lib/utils'

interface EventsCalendarProps {
  events: Event[]
}

const impactConfig = {
  high: { dot: 'bg-[#A8322E]', label: 'HIGH' },
  medium: { dot: 'bg-[#B5701A]', label: 'MED' },
  low: { dot: 'bg-[#D4D0C8]', label: 'LOW' },
}

export default function EventsCalendar({ events }: EventsCalendarProps) {
  return (
    <section className="border border-[#D4D0C8] bg-[#FAF8F4]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#D4D0C8]">
        <span
          className="font-mono text-xs text-[#6B6B6B] tracking-widest uppercase"
          style={{ fontVariant: 'small-caps' }}
        >
          Economic Calendar
        </span>
      </div>

      {/* Events */}
      <div className="divide-y divide-[#D4D0C8]">
        {events.length === 0 ? (
          <p className="px-4 py-6 font-sans text-sm text-[#6B6B6B] text-center">
            No upcoming events.
          </p>
        ) : (
          events.map((event) => {
            const impact = impactConfig[event.impact]
            return (
              <div
                key={event.id}
                className="px-4 py-3 flex items-start gap-3 hover:bg-[#F2EFE8] transition-colors duration-100 cursor-default"
              >
                {/* Impact dot */}
                <div className="flex flex-col items-center gap-1 pt-0.5 flex-shrink-0">
                  <span className={cn('w-2 h-2 rounded-full flex-shrink-0', impact.dot)} />
                  <span className="font-mono text-[9px] text-[#6B6B6B] tracking-wider">
                    {impact.label}
                  </span>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="font-sans text-[13px] text-[#1A1A1A] leading-snug font-medium mb-0.5">
                    {event.name}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] text-[#6B6B6B] tabular-nums">
                      {event.dateLabel}
                    </span>
                    {event.relevantMetals.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {event.relevantMetals.map((m) => (
                          <span
                            key={m}
                            className="font-mono text-[9px] text-[#6B6B6B] border border-[#D4D0C8] px-1 py-0 leading-none bg-[#FAF8F4]"
                          >
                            {m}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Legend */}
      <div className="px-4 py-2 border-t border-[#D4D0C8] flex items-center gap-4">
        {Object.entries(impactConfig).map(([key, val]) => (
          <div key={key} className="flex items-center gap-1.5">
            <span className={cn('w-1.5 h-1.5 rounded-full', val.dot)} />
            <span className="font-mono text-[10px] text-[#6B6B6B] tracking-wider">{val.label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
