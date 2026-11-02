import { useMemo } from 'react'
import type { Hex } from 'viem'
import { useAccount } from 'wagmi'
import { useActivityLog, type ActivityKind, type ActivityStatus } from '@/lib/activity'
import { fmtToken, shortAddr } from '@/lib/format'
import { ARC_CHAIN_ID } from '@/config/networks'
import { tokenByAddress } from '@/lib/tokens'
import type { ReceiptData } from '@/lib/payments'
import { useOnchainTransfers, type TransferLeg } from './useOnchainTransfers'
import { usePaymentReceipts } from './usePaymentData'

export type HistoryKind = ActivityKind | 'receive' | 'transfer'

export interface HistoryRow {
  key: string
  hash?: Hex
  chainId: number
  kind: HistoryKind
  summary: string
  note?: string
  status: ActivityStatus
  timestamp: number
  legs: TransferLeg[]
  receipt?: ReceiptData & { direction: 'sent' | 'received' }
}

const money = (l: TransferLeg) => `${fmtToken(l.amount, l.token.decimals, 4)} ${l.token.symbol}`

function describe(legs: TransferLeg[], kind?: HistoryKind): { kind: HistoryKind; summary: string } {
  const outs = legs.filter((l) => l.direction === 'out')
  const ins = legs.filter((l) => l.direction === 'in')
  if (outs.length && ins.length) {
    return { kind: kind ?? 'swap', summary: `${money(outs[0])} → ${money(ins[0])}` }
  }
  if (outs.length) return { kind: kind ?? 'send', summary: `Sent ${money(outs[0])} to ${shortAddr(outs[0].counterparty)}` }
  if (ins.length) return { kind: kind ?? 'receive', summary: `Received ${money(ins[0])} from ${shortAddr(ins[0].counterparty)}` }
  return { kind: kind ?? 'transfer', summary: 'Transaction' }
}

/**
 * One list for the whole app: real onchain Transfer logs on Arc, labelled with what FLUXORA knows it
 * submitted (swap, bridge, payment...) and joined with payment receipts read from the contract.
 */
export function useHistoryRows() {
  const { address } = useAccount()
  const local = useActivityLog(address)
  const transfers = useOnchainTransfers()
  const receipts = usePaymentReceipts()

  const rows = useMemo(() => {
    const out: HistoryRow[] = []
    const localByHash = new Map(local.map((r) => [r.hash.toLowerCase(), r]))
    const seen = new Set<string>()
    const remainingReceipts = [...(receipts.data ?? [])]

    for (const tx of transfers.txs) {
      const l = localByHash.get(tx.hash.toLowerCase())
      seen.add(tx.hash.toLowerCase())
      let kind: HistoryKind | undefined = l?.kind
      let receipt: HistoryRow['receipt']
      const idx = remainingReceipts.findIndex(
        (r) =>
          r.timestamp === tx.timestamp &&
          tx.legs.some(
            (leg) =>
              leg.amount === r.amount &&
              tokenByAddress(r.token)?.symbol === leg.token.symbol &&
              leg.counterparty.toLowerCase() === (leg.direction === 'out' ? r.recipient : r.payer).toLowerCase(),
          ),
      )
      if (idx !== -1) {
        receipt = remainingReceipts[idx]
        remainingReceipts.splice(idx, 1)
        kind = 'payment'
      }
      const d = describe(tx.legs, kind)
      out.push({
        key: tx.hash,
        hash: tx.hash,
        chainId: ARC_CHAIN_ID,
        kind: d.kind,
        summary: l?.summary ?? d.summary,
        note: l?.note,
        status: l?.status ?? 'success',
        timestamp: tx.timestamp,
        legs: tx.legs,
        receipt,
      })
    }

    for (const l of local) {
      if (seen.has(l.hash.toLowerCase())) continue
      out.push({
        key: `${l.chainId}:${l.hash}`,
        hash: l.hash,
        chainId: l.chainId,
        kind: l.kind,
        summary: l.summary,
        note: l.note,
        status: l.status,
        timestamp: l.createdAt,
        legs: [],
      })
    }

    for (const r of remainingReceipts) {
      const token = tokenByAddress(r.token)
      const amount = token ? `${fmtToken(r.amount, token.decimals, 4)} ${token.symbol}` : 'tokens'
      const other = r.direction === 'sent' ? r.recipient : r.payer
      out.push({
        key: `receipt:${r.id}`,
        chainId: ARC_CHAIN_ID,
        kind: 'payment',
        summary: `${r.direction === 'sent' ? 'Paid' : 'Received'} ${amount} ${r.direction === 'sent' ? 'to' : 'from'} ${shortAddr(other)}`,
        status: 'success',
        timestamp: r.timestamp,
        legs: [],
        receipt: r,
      })
    }

    return out.sort((a, b) => b.timestamp - a.timestamp)
  }, [local, transfers.txs, receipts.data])

  return { rows, transfers, receipts }
}
