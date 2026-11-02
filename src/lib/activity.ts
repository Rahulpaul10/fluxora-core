import { useSyncExternalStore } from 'react'
import type { Address, Hex } from 'viem'

/**
 * Local log of transactions that were submitted FROM this app, so history can label them
 * (send, swap, bridge, payment...). It stores only public data (hashes, labels). Status is never trusted:
 * it is set from real receipts, and onchain history is shown alongside it.
 */
export type ActivityKind = 'send' | 'swap' | 'bridge' | 'payment' | 'request' | 'approve'
/** dropped = the network never knew this hash after a long wait (replaced, dropped or never broadcast) */
export type ActivityStatus = 'pending' | 'success' | 'failed' | 'dropped'

export interface ActivityRecord {
  hash: Hex
  kind: ActivityKind
  chainId: number
  account: Address
  summary: string
  /** Free-form extra line, e.g. destination chain for a bridge */
  note?: string
  createdAt: number
  status: ActivityStatus
}

const KEY = 'fluxora:activity:v1'
const listeners = new Set<() => void>()
let cache: ActivityRecord[] | null = null

function read(): ActivityRecord[] {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    cache = raw ? (JSON.parse(raw) as ActivityRecord[]) : []
  } catch {
    cache = []
  }
  return cache
}

function write(next: ActivityRecord[]) {
  cache = next.slice(0, 300)
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    // storage full or blocked: keep the in-memory copy
  }
  listeners.forEach((l) => l())
}

export function recordActivity(entry: Omit<ActivityRecord, 'createdAt' | 'status'> & { status?: ActivityStatus }) {
  const list = read()
  if (list.some((r) => r.hash === entry.hash && r.chainId === entry.chainId)) return
  write([{ ...entry, status: entry.status ?? 'pending', createdAt: Math.floor(Date.now() / 1000) }, ...list])
}

export function updateActivity(hash: Hex, chainId: number, status: ActivityStatus) {
  const list = read()
  const idx = list.findIndex((r) => r.hash === hash && r.chainId === chainId)
  if (idx === -1 || list[idx].status === status) return
  const next = list.slice()
  next[idx] = { ...next[idx], status }
  write(next)
}

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useAllActivity(): ActivityRecord[] {
  return useSyncExternalStore(subscribe, read, read)
}

export function useActivityLog(account: Address | undefined): ActivityRecord[] {
  const all = useSyncExternalStore(subscribe, read, read)
  return account ? all.filter((r) => r.account.toLowerCase() === account.toLowerCase()) : []
}
