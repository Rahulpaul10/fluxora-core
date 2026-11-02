import type { Address } from 'viem'
import type { ReceiptClient } from './txTracker'
import { getAccount, getPublicClient } from 'wagmi/actions'
import { config } from '@/config/wallet'
import { ARC_CHAIN_ID, HOME_NETWORK } from '@/config/networks'
import { TxError } from './errors'

export * from './txTracker'

/* ------------------------------------------------------------------ */
/* Pre-send guard                                                      */
/* ------------------------------------------------------------------ */

let rpcChainVerified = false

/** Confirms the configured Arc RPC really serves chain 5042 (once per session). */
export async function verifyRpcChain(): Promise<void> {
  if (rpcChainVerified) return
  const client = getPublicClient(config, { chainId: ARC_CHAIN_ID })
  if (!client) throw new TxError('rpc-unavailable', 'The Arc RPC client is not available.')
  let id: number
  try {
    id = await client.getChainId()
  } catch {
    throw new TxError('rpc-unavailable', 'The Arc RPC is not responding, so the transaction was not sent. Check your connection and try again.')
  }
  if (id !== ARC_CHAIN_ID) {
    throw new TxError('rpc-wrong-chain', `The configured RPC (${HOME_NETWORK.rpcUrls[0]}) serves chain ${id}, not Arc (${ARC_CHAIN_ID}). Fix VITE_ARC_RPC_URL. Nothing was sent.`)
  }
  rpcChainVerified = true
}

/**
 * Must pass before any wallet prompt. Uses the wallet's LIVE chain (asked from the wallet itself, not the
 * cached UI state) so a transaction can never be signed for the wrong network.
 */
export async function assertWalletReady(options: { chainId?: number } = {}): Promise<{ address: Address }> {
  const wanted = options.chainId ?? ARC_CHAIN_ID
  const account = getAccount(config)
  if (!account.isConnected || !account.address || !account.connector) {
    throw new TxError('wallet-disconnected', 'Your wallet is disconnected. Reconnect it and try again.')
  }
  let live: number
  try {
    live = await account.connector.getChainId()
  } catch {
    throw new TxError('wallet-disconnected', 'Could not reach your wallet. Unlock it or reconnect, then try again.')
  }
  if (live !== wanted) {
    throw new TxError('wrong-network', `Your wallet is on chain ${live}. Switch to ${wanted === ARC_CHAIN_ID ? 'Arc Mainnet' : `chain ${wanted}`} (chain ${wanted}) to continue.`)
  }
  if (wanted === ARC_CHAIN_ID) await verifyRpcChain()
  return { address: account.address }
}

/** How many transactions from this wallet are still waiting to be mined (pending nonce minus latest nonce). */
export async function countInFlight(client: Pick<ReceiptClient, 'getTransactionCount'>, address: Address): Promise<number> {
  try {
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address, blockTag: 'latest' }),
      client.getTransactionCount({ address, blockTag: 'pending' }),
    ])
    return Math.max(0, pending - latest)
  } catch {
    return 0
  }
}
