import type { NewsRow } from '@/lib/data'
import SentimentPill from './SentimentPill'

interface NewsItemProps {
  item: NewsRow
}

function formatAge(publishedAt: string): string {
  const minutesAgo = Math.round((Date.now() - new Date(publishedAt).getTime()) / 60_000)
  if (minutesAgo < 60) return `${minutesAgo}m ago`
  const hours = Math.floor(minutesAgo / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function NewsItem({ item }: NewsItemProps) {
  return (
    <article className="py-3 border-b border-[#D4D0C8] last:border-b-0">
      {/* Top row: source, time, sentiment */}
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="font-mono text-[10px] text-[#6B6B6B] tracking-widest uppercase"
          style={{ fontVariant: 'small-caps' }}
        >
          {item.source}
        </span>
        <span className="text-[#D4D0C8] select-none">·</span>
        <span className="font-mono text-[11px] text-[#6B6B6B]">
          {formatAge(item.published_at)}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {/* Metal tags — only shown when classification has run (Wave 3) */}
          {item.metals && item.metals.length > 0 && item.metals.map((tag) => (
            <span
              key={tag}
              className="font-mono text-[10px] text-[#4A4A4A] border border-[#D4D0C8] px-1.5 py-0.5 leading-none bg-[#F2EFE8]"
            >
              {tag.charAt(0).toUpperCase() + tag.slice(1)}
            </span>
          ))}
          {/* Sentiment pill — hidden when null (Wave 3 hasn't run yet) */}
          <SentimentPill sentiment={item.sentiment} />
        </div>
      </div>

      {/* Headline */}
      <a
        href={item.url}
        className="block font-serif text-[14px] font-semibold text-[#1A1A1A] leading-snug mb-1 hover:text-[#0B2545] transition-colors duration-100"
      >
        {item.headline}
      </a>

      {/* Summary */}
      {item.summary && (
        <p className="font-sans text-[12px] text-[#6B6B6B] leading-snug">
          {item.summary}
        </p>
      )}
    </article>
  )
}
