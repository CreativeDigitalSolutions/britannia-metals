import type { BriefRow } from '@/lib/data'

interface MorningBriefProps {
  brief: BriefRow | null
}

function formatBriefTime(isoString: string): string {
  const date = new Date(isoString)
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
  return time
}

export default function MorningBrief({ brief }: MorningBriefProps) {
  return (
    <section className="border border-[#D4D0C8] bg-[#F2EFE8] p-5">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3 pb-3 border-b border-[#D4D0C8]">
        <span
          className="font-mono text-xs text-[#6B6B6B] tracking-widest uppercase"
          style={{ fontVariant: 'small-caps' }}
        >
          Today&apos;s Brief&ensp;·&ensp;07:00 BST
        </span>
        <span className="font-mono text-[11px] text-[#6B6B6B]">Morning note</span>
      </div>

      {brief ? (
        <>
          {/* Brief prose */}
          <p className="font-serif text-[15px] leading-relaxed text-[#1A1A1A] max-w-4xl">
            {brief.content}
          </p>

          {/* Timestamp */}
          <div className="mt-3 pt-3 border-t border-[#D4D0C8] flex justify-end">
            <span className="font-mono text-[11px] text-[#6B6B6B] tabular-nums">
              Published {formatBriefTime(brief.generated_at)}
            </span>
          </div>
        </>
      ) : (
        <p className="font-serif text-[15px] leading-relaxed text-[#6B6B6B] max-w-4xl italic">
          Morning brief generates at 07:00 BST. Check back shortly.
        </p>
      )}
    </section>
  )
}
