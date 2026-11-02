import { getAddress, isAddress, type Address } from 'viem'

/** Reads a public VITE_ address. Returns undefined when it is missing or not a valid address. */
export function envAddress(value: unknown): Address | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || !isAddress(trimmed, { strict: false })) return undefined
  return getAddress(trimmed)
}

export function envNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}
