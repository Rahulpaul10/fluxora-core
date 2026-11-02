import { parseAbiItem, stringToHex, type Address, type Hex, type PublicClient } from 'viem'
import { FLUXORA } from '@/config/contracts'

export const REQUEST_STATUS = ['None', 'Open', 'Paid', 'Cancelled'] as const
export type RequestStatusName = (typeof REQUEST_STATUS)[number]

export interface ReceiptData {
  id: bigint
  payer: Address
  recipient: Address
  token: Address
  amount: bigint
  fee: bigint
  timestamp: number
  requestId: bigint
  ref: Hex
}

export interface RequestData {
  id: bigint
  creator: Address
  token: Address
  amount: bigint
  expiry: number
  status: RequestStatusName
  ref: Hex
  paidBy: Address
  paymentId: bigint
}

/** Short free-text reference -> bytes32 (max 31 bytes). Empty -> zero bytes. */
export function refToBytes32(text: string): Hex {
  const trimmed = text.trim()
  if (!trimmed) return `0x${'0'.repeat(64)}`
  const hex = stringToHex(trimmed.slice(0, 31), { size: 32 })
  return hex
}

export function bytes32ToRef(ref: Hex): string {
  if (/^0x0+$/.test(ref)) return ''
  try {
    const bytes = ref.slice(2).match(/.{2}/g) ?? []
    const chars = bytes.map((b) => parseInt(b, 16)).filter((n) => n !== 0)
    return new TextDecoder().decode(new Uint8Array(chars))
  } catch {
    return ''
  }
}

const paymentMade = parseAbiItem(
  'event PaymentMade(uint256 indexed paymentId, address indexed payer, address indexed recipient, address token, uint256 amount, uint256 fee, uint256 requestId, bytes32 ref, string memo)',
)

/**
 * The payments contract does not store transaction hashes. To show one, find the first block at or after
 * the receipt timestamp (binary search) and read the PaymentMade event for that id in a narrow window.
 */
export async function findPaymentTx(client: PublicClient, paymentId: bigint, timestamp: number): Promise<Hex | null> {
  if (!FLUXORA.payments) return null
  let lo = FLUXORA.deployBlock ? BigInt(FLUXORA.deployBlock) : 0n
  let hi = await client.getBlockNumber()
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const block = await client.getBlock({ blockNumber: mid })
    if (Number(block.timestamp) < timestamp) lo = mid + 1n
    else hi = mid
  }
  const from = lo > 20n ? lo - 20n : 0n
  const logs = await client.getLogs({
    address: FLUXORA.payments,
    event: paymentMade,
    args: { paymentId },
    fromBlock: from,
    toBlock: lo + 20n,
  })
  return logs[0]?.transactionHash ?? null
}
