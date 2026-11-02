import type { Address } from 'viem'
import { useQuery } from '@tanstack/react-query'
import { useAccount, usePublicClient } from 'wagmi'
import { FLUXORA, fluxoraPaymentsAbi } from '@/config/contracts'
import { ARC_CHAIN_ID } from '@/config/networks'
import { REQUEST_STATUS, type ReceiptData, type RequestData } from '@/lib/payments'

const PAGE = 50n

/** Contract-level settings the payer must see before signing. */
export function usePaymentConfig() {
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })
  return useQuery({
    queryKey: ['payments-config'],
    enabled: Boolean(client && FLUXORA.payments),
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!client || !FLUXORA.payments) throw new Error('Payments contract is not configured')
      const address = FLUXORA.payments
      const [feeBps, feeRecipient, paused] = await Promise.all([
        client.readContract({ address, abi: fluxoraPaymentsAbi, functionName: 'feeBps' }),
        client.readContract({ address, abi: fluxoraPaymentsAbi, functionName: 'feeRecipient' }),
        client.readContract({ address, abi: fluxoraPaymentsAbi, functionName: 'paused' }),
      ])
      return { feeBps, feeRecipient, paused }
    },
  })
}

/** Receipts for payments the connected wallet sent or received, read directly from the contract. */
export function usePaymentReceipts() {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })
  return useQuery({
    queryKey: ['payment-receipts', address],
    enabled: Boolean(client && address && FLUXORA.payments),
    refetchInterval: 20_000,
    queryFn: async () => {
      if (!client || !address || !FLUXORA.payments) return [] as (ReceiptData & { direction: 'sent' | 'received' })[]
      const contract = FLUXORA.payments
      const read = async (fn: 'getSentIds' | 'getReceivedIds', count: 'sentCount' | 'receivedCount') => {
        const total = await client.readContract({ address: contract, abi: fluxoraPaymentsAbi, functionName: count, args: [address] })
        const offset = total > PAGE ? total - PAGE : 0n // newest page
        return client.readContract({ address: contract, abi: fluxoraPaymentsAbi, functionName: fn, args: [address, offset, PAGE] })
      }
      const [sent, received] = await Promise.all([read('getSentIds', 'sentCount'), read('getReceivedIds', 'receivedCount')])
      const ids = [...new Set([...sent, ...received])]
      const receipts = await Promise.all(
        ids.map((id) => client.readContract({ address: contract, abi: fluxoraPaymentsAbi, functionName: 'getReceipt', args: [id] })),
      )
      return receipts
        .map((r, i): ReceiptData & { direction: 'sent' | 'received' } => ({
          id: ids[i],
          payer: r.payer,
          recipient: r.recipient,
          token: r.token,
          amount: r.amount,
          fee: r.fee,
          timestamp: Number(r.timestamp),
          requestId: r.requestId,
          ref: r.ref,
          direction: r.payer.toLowerCase() === address.toLowerCase() ? 'sent' : 'received',
        }))
        .sort((a, b) => b.timestamp - a.timestamp)
    },
  })
}

/** Payment requests created by the connected wallet. */
export function useMyRequests() {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: ARC_CHAIN_ID })
  return useQuery({
    queryKey: ['my-requests', address],
    enabled: Boolean(client && address && FLUXORA.payments),
    refetchInterval: 20_000,
    queryFn: async () => {
      if (!client || !address || !FLUXORA.payments) return [] as RequestData[]
      const contract = FLUXORA.payments
      const total = await client.readContract({ address: contract, abi: fluxoraPaymentsAbi, functionName: 'requestCount', args: [address] })
      const offset = total > PAGE ? total - PAGE : 0n
      const ids = await client.readContract({ address: contract, abi: fluxoraPaymentsAbi, functionName: 'getRequestIds', args: [address, offset, PAGE] })
      const reqs = await Promise.all(
        ids.map((id) => client.readContract({ address: contract, abi: fluxoraPaymentsAbi, functionName: 'getRequest', args: [id] })),
      )
      return reqs.map((r, i): RequestData => toRequest(ids[i], r)).reverse()
    },
  })
}

export function toRequest(
  id: bigint,
  r: { creator: Address; token: Address; amount: bigint; expiry: bigint | number; status: number; ref: `0x${string}`; paidBy: Address; paymentId: bigint },
): RequestData {
  return {
    id,
    creator: r.creator,
    token: r.token,
    amount: r.amount,
    expiry: Number(r.expiry),
    status: REQUEST_STATUS[r.status] ?? 'None',
    ref: r.ref,
    paidBy: r.paidBy,
    paymentId: r.paymentId,
  }
}
