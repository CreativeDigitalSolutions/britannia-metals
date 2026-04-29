import { cn } from '@/lib/utils'
import type { MetalDisplayData } from '@/lib/data'

interface MetalTileProps {
  metal: MetalDisplayData
  variant?: 'base' | 'precious'
  onClick?: () => void
}

function formatPrice(value: number, unit: 'tonne' | 'troy oz'): string {
  if (unit === 'troy oz') {
    return value.toLocaleString('en-GB', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

function formatStock(tonnes: number): string {
  if (tonnes >= 1_000_000) {
    return (tonnes / 1_000_000).toFixed(2) + 'Mt'
  }
  return tonnes.toLocaleString('en-GB') + ' t'
}

export default function MetalTile({ metal, variant = 'base', onClick }: MetalTileProps) {
  const priceUnit = metal.unit === 'troy oz' ? '$/oz' : '$/t'

  // ── Unavailable state (e.g. LME Cloudflare-blocked, no Yahoo fallback) ──────
  if (metal.unavailable || metal.cashPrice === null) {
    return (
      <div
        onClick={onClick}
        className={cn(
          'border border-[#D4D0C8] bg-[#FAF8F4] p-4',
          onClick && 'cursor-pointer transition-colors duration-100 hover:bg-[#F2EFE8] hover:border-[#0B2545] hover:ring-1 hover:ring-[#0B2545]/10',
        )}
      >
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="font-serif font-bold text-[#1A1A1A] text-base leading-none">
            {metal.name}
          </h3>
          <span
            className="font-mono text-[10px] text-[#6B6B6B] tracking-widest uppercase"
            style={{ fontVariant: 'small-caps' }}
          >
            {metal.symbol}
          </span>
        </div>

        <div className="flex items-baseline gap-1 mb-1">
          <span className="font-mono tabular-nums text-2xl font-semibold text-[#6B6B6B] leading-none">
            —
          </span>
          <span className="font-mono text-[11px] text-[#6B6B6B]">{priceUnit}</span>
        </div>

        <div className="mt-2">
          <span className="font-mono text-[10px] text-[#B5701A] border border-[#B5701A]/30 bg-[#B5701A]/5 px-1.5 py-0.5 leading-none">
            LME feed blocked
          </span>
        </div>
      </div>
    )
  }

  // ── Normal state ─────────────────────────────────────────────────────────────
  const isPositive = (metal.dayChangePercent ?? 0) >= 0
  const changeColour = isPositive ? 'text-[#1F6B47]' : 'text-[#A8322E]'
  const changeSign = isPositive ? '+' : ''
  const spreadLabel =
    metal.spreadType === 'contango' ? 'CONTANGO' : 'BACKWARDATION'
  const spreadColour =
    metal.spreadType === 'contango' ? 'text-[#1F6B47]' : 'text-[#A8322E]'

  return (
    <div
      onClick={onClick}
      className={cn(
        'group border border-[#D4D0C8] bg-[#FAF8F4] p-4',
        'transition-colors duration-100 hover:bg-[#F2EFE8] hover:border-[#0B2545]',
        onClick
          ? 'cursor-pointer hover:ring-1 hover:ring-[#0B2545]/10'
          : 'cursor-default',
      )}
    >
      {/* Metal name row */}
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="font-serif font-bold text-[#1A1A1A] text-base leading-none">
          {metal.name}
        </h3>
        <span
          className="font-mono text-[10px] text-[#6B6B6B] tracking-widest uppercase"
          style={{ fontVariant: 'small-caps' }}
        >
          {metal.symbol}
        </span>
      </div>

      {/* Cash price — the hero number */}
      <div className="mb-1">
        <div className="flex items-baseline gap-1">
          <span className="font-mono tabular-nums text-2xl font-semibold text-[#1A1A1A] leading-none">
            {formatPrice(metal.cashPrice, metal.unit)}
          </span>
          <span className="font-mono text-[11px] text-[#6B6B6B]">{priceUnit}</span>
          {/* Indicative badge for Yahoo fallback prices */}
          {metal.source === 'yahoo_fallback' && (
            <span className="font-mono text-[9px] text-[#B5701A] border border-[#B5701A]/30 bg-[#B5701A]/5 px-1 py-0 leading-none ml-1">
              indicative
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="font-mono text-[10px] text-[#6B6B6B] tracking-wider uppercase">Cash</span>
        </div>
      </div>

      {/* 3M price */}
      {variant === 'base' && metal.threeMonthPrice !== null && (
        <div className="flex items-center gap-2 mb-2">
          <span className="font-mono text-[10px] text-[#6B6B6B] tracking-wider uppercase">3M</span>
          <span className="font-mono tabular-nums text-sm text-[#4A4A4A]">
            {formatPrice(metal.threeMonthPrice, metal.unit)}
          </span>
          <span className="font-mono text-[10px] text-[#6B6B6B]">{priceUnit}</span>
        </div>
      )}

      {/* Hairline */}
      <div className="border-t border-[#D4D0C8] my-2" />

      {/* Day change */}
      {metal.dayChangePercent !== null ? (
        <div className="flex items-center gap-1 mb-1">
          <svg
            className={cn('w-3 h-3 flex-shrink-0', changeColour)}
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden="true"
          >
            {isPositive ? (
              <path d="M6 2L11 10H1L6 2Z" />
            ) : (
              <path d="M6 10L1 2H11L6 10Z" />
            )}
          </svg>
          <span className={cn('font-mono tabular-nums text-sm font-medium', changeColour)}>
            {changeSign}{metal.dayChangePercent.toFixed(2)}%
          </span>
          {metal.dayChangeDollar !== null && (
            <span className={cn('font-mono tabular-nums text-xs', changeColour)}>
              ({changeSign}{metal.unit === 'troy oz'
                ? `$${Math.abs(metal.dayChangeDollar).toFixed(2)}`
                : `$${Math.abs(metal.dayChangeDollar).toLocaleString('en-GB')}${isPositive ? '' : ' ↓'}`
              })
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1 mb-1">
          <span className="font-mono text-[11px] text-[#6B6B6B]">Change: —</span>
        </div>
      )}

      {/* Spread */}
      {variant === 'base' && metal.spreadType !== null && metal.spreadAmount !== null && metal.spreadAmount > 0 && (
        <div className="mb-2">
          <span className={cn('font-mono text-[11px] font-medium', spreadColour)}>
            {spreadLabel} ${Math.round(metal.spreadAmount)}
          </span>
        </div>
      )}

      {/* Stocks & cancelled warrants — base metals only, hidden if no stock data */}
      {variant === 'base' && metal.stockTonnes !== null && (
        <div className="mt-2 pt-2 border-t border-[#D4D0C8]">
          <div className="flex justify-between">
            <div>
              <div className="font-mono text-[10px] text-[#6B6B6B] tracking-wider uppercase mb-0.5">Stock</div>
              <div className="font-mono tabular-nums text-xs text-[#4A4A4A]">
                {formatStock(metal.stockTonnes)}
              </div>
            </div>
            {metal.cancelledWarrantsPercent !== null && (
              <div className="text-right">
                <div className="font-mono text-[10px] text-[#6B6B6B] tracking-wider uppercase mb-0.5">Cancelled</div>
                <div className={cn(
                  'font-mono tabular-nums text-xs',
                  metal.cancelledWarrantsPercent > 15 ? 'text-[#A8322E] font-medium' : 'text-[#4A4A4A]'
                )}>
                  {metal.cancelledWarrantsPercent.toFixed(1)}%
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
