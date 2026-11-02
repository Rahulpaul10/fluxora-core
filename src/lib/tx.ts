import { erc20Abi, type Address, type Hex, type PublicClient } from 'viem'
import { recordActivity } from './activity'
import { waitForReceipt } from './txTracker'
import { ARC_CHAIN_ID } from '@/config/networks'
import type { Fees } from './fees'

interface ApproveRequest {
  chainId: typeof ARC_CHAIN_ID
  address: Address
  abi: typeof erc20Abi
  functionName: 'approve'
  args: readonly [Address, bigint]
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}
type WriteFn = (req: ApproveRequest) => Promise<Hex>

/**
 * Approves EXACTLY the amount needed (never unlimited) when the current allowance is too low, and waits
 * for the approval to be confirmed onchain before returning. Returns true if an approval was sent.
 */
export async function ensureAllowance(opts: {
  client: PublicClient
  write: WriteFn
  token: Address
  symbol: string
  owner: Address
  spender: Address
  amount: bigint
  fees: Fees
}): Promise<boolean> {
  const { client, write, token, symbol, owner, spender, amount, fees } = opts
  const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
  if (allowance >= amount) return false
  const hash = await write({
    chainId: ARC_CHAIN_ID,
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  })
  recordActivity({ hash, kind: 'approve', chainId: ARC_CHAIN_ID, account: owner, summary: `Approved ${symbol}` })
  const receipt = await waitForReceipt(client, hash)
  if (receipt.status !== 'success') throw new Error('The approval transaction reverted.')
  return true
}
