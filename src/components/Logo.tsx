import { useId } from 'react'
import clsx from 'clsx'

/**
 * FLUXORA brand marks. All artwork is inline SVG, so nothing is fetched and it scales cleanly.
 *
 * The symbol is an "F" drawn as one flowing line: the stem rises and bends into the top arm like a
 * stream, and the middle arm ends in a detached node (a point on the network). Stroke-based, so it stays
 * legible down to favicon size.
 *
 *   LogoMark     symbol only (optionally on a dark tile)
 *   Wordmark     symbol + FLUXORA lettering (sidebar, headers)
 *   LogoLockup   stacked symbol over wordmark and tagline (connect and loading screens)
 *   LoadingScreen full-viewport loader built on the lockup
 *
 * The same geometry is saved as static files in /public (fluxora-icon.svg, fluxora-mark.svg).
 */

const STEM = 'M12.5 41V21C12.5 13 18 8 26.5 8C30.5 8 33.5 9.2 36.5 11.2'
const ARM = 'M12.5 27H25'

interface MarkProps {
  size?: number
  /** Draw the symbol on a dark rounded tile (app icon style). Default: symbol only. */
  tile?: boolean
  className?: string
  title?: string
}

export function LogoMark({ size = 36, tile = false, className, title }: MarkProps) {
  const uid = useId().replace(/:/g, '')
  const main = `fx-main-${uid}`
  const accent = `fx-accent-${uid}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={clsx('shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={main} x1="10" y1="6" x2="40" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#9B7BFF" />
          <stop offset="1" stopColor="#27D9FF" />
        </linearGradient>
        <linearGradient id={accent} x1="12" y1="27" x2="38" y2="27" gradientUnits="userSpaceOnUse">
          <stop stopColor="#27D9FF" />
          <stop offset="1" stopColor="#20D6A0" />
        </linearGradient>
      </defs>
      {tile && (
        <>
          <rect x="1" y="1" width="46" height="46" rx="14" fill="#0A1030" />
          <rect x="1.75" y="1.75" width="44.5" height="44.5" rx="13.25" stroke={`url(#${main})`} strokeOpacity="0.35" strokeWidth="1.5" />
        </>
      )}
      <path d={STEM} stroke={`url(#${main})`} strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d={ARM} stroke={`url(#${accent})`} strokeWidth="5.2" strokeLinecap="round" />
      <circle cx="34.5" cy="27" r="3.6" fill={`url(#${accent})`} />
    </svg>
  )
}

interface WordmarkProps {
  /** Symbol size in px; the lettering scales with it. */
  size?: number
  className?: string
  /** Extra classes for the lettering only (for example to hide it on very narrow screens). */
  textClassName?: string
}

/** Symbol + FLUXORA lettering. */
export function Wordmark({ size = 36, className, textClassName }: WordmarkProps) {
  return (
    <span className={clsx('inline-flex items-center', className)} style={{ gap: size * 0.3 }}>
      <LogoMark size={size} />
      <span className={clsx('font-display font-bold leading-none text-white', textClassName)} style={{ fontSize: size * 0.56, letterSpacing: '0.16em' }}>
        FLUXORA
      </span>
    </span>
  )
}

/** Stacked lockup for centered screens: symbol, lettering, optional tagline. */
export function LogoLockup({ size = 64, tagline = false, className }: { size?: number; tagline?: boolean; className?: string }) {
  return (
    <div className={clsx('flex flex-col items-center text-center', className)} style={{ gap: size * 0.22 }}>
      <LogoMark size={size} />
      <span className="font-display font-bold leading-none text-white" style={{ fontSize: size * 0.34, letterSpacing: '0.2em', paddingLeft: '0.2em' }}>
        FLUXORA
      </span>
      {tagline && <span className="text-xs text-slate-400">One Wallet. Every Possibility.</span>}
    </div>
  )
}

/** Full-viewport loading screen with the animated lockup. */
export function LoadingScreen({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="fixed inset-0 z-[60] flex min-h-dvh flex-col items-center justify-center bg-navy-950" role="status" aria-live="polite">
      <div className="fx-pulse">
        <LogoLockup size={72} />
      </div>
      <p className="mt-6 text-xs uppercase tracking-[0.18em] text-slate-500">{label}</p>
    </div>
  )
}

/** Compact in-page loader used while a lazy page loads. */
export function PageLoader() {
  return (
    <div className="flex h-64 w-full items-center justify-center" role="status" aria-busy="true" aria-label="Loading">
      <div className="fx-pulse">
        <LogoMark size={48} />
      </div>
    </div>
  )
}
