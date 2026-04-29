import { cn } from '@/lib/utils'

type Sentiment = 'bullish' | 'bearish' | 'neutral'

interface SentimentPillProps {
  sentiment: Sentiment | null
}

const sentimentConfig: Record<Sentiment, { label: string; className: string }> = {
  bullish: {
    label: 'Bullish',
    className: 'bg-[#1F6B47]/10 text-[#1F6B47] border border-[#1F6B47]/30',
  },
  bearish: {
    label: 'Bearish',
    className: 'bg-[#A8322E]/10 text-[#A8322E] border border-[#A8322E]/30',
  },
  neutral: {
    label: 'Neutral',
    className: 'bg-[#D4D0C8]/40 text-[#6B6B6B] border border-[#D4D0C8]',
  },
}

export default function SentimentPill({ sentiment }: SentimentPillProps) {
  if (!sentiment) return null
  const { label, className } = sentimentConfig[sentiment]
  return (
    <span
      className={cn(
        'font-mono text-[10px] tracking-wider uppercase px-1.5 py-0.5 leading-none',
        className,
      )}
    >
      {label}
    </span>
  )
}
