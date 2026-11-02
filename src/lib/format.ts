import { Amount } from '@/onchain-money'

export const shortAddr = (address: string, head = 6, tail = 4) =>
  address.length <= head + tail + 2 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`

export const shortHash = (hash: string) => shortAddr(hash, 8, 6)

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Formats a raw token amount with thousands separators and at most `maxFrac` decimals (trailing zeros trimmed). */
export function fmtToken(raw: bigint, decimals: number, maxFrac = 4): string {
  const fixed = Amount.fromRaw(raw, decimals).toFixed(Math.min(maxFrac, decimals))
  const [i, f = ''] = fixed.split('.')
  const frac = f.replace(/0+$/, '')
  return frac ? `${group(i)}.${frac}` : group(i)
}

/** Fixed two-decimal currency string for USDC-denominated values. */
export function fmtUsd(raw: bigint, decimals: number): string {
  const [i, f = '00'] = Amount.fromRaw(raw, decimals).toFixed(2).split('.')
  return `${group(i)}.${f}`
}

export function timeAgo(unixSeconds: number, now = Date.now()): string {
  const diff = Math.max(0, Math.floor(now / 1000) - unixSeconds)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function fmtDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
