import { BaseError, ContractFunctionRevertedError } from 'viem'

export interface ParsedError {
  /** True when the user simply closed the wallet prompt. Not a failure. */
  rejected: boolean
  message: string
}

/** Typed failures raised by the transaction guard before anything is sent. */
export type TxErrorCode = 'wallet-disconnected' | 'wrong-network' | 'rpc-wrong-chain' | 'rpc-unavailable' | 'busy'

export class TxError extends Error {
  code: TxErrorCode
  constructor(code: TxErrorCode, message: string) {
    super(message)
    this.name = 'TxError'
    this.code = code
  }
}

/** Known FLUXORA custom errors mapped to plain language. */
const CUSTOM: Record<string, string> = {
  UnsupportedToken: 'This token is not enabled for FLUXORA payments.',
  FeeTooHigh: 'The payment fee changed and is now higher than you allowed. Review and try again.',
  RequestExpired: 'This payment request has expired.',
  RequestNotOpen: 'This payment request is no longer open.',
  UnknownRequest: 'That payment request does not exist.',
  NotRequestCreator: 'Only the creator of a request can cancel it.',
  InvalidRecipient: 'That recipient is not allowed.',
  ZeroAmount: 'The amount must be greater than zero.',
  MemoTooLong: 'The note is too long (140 bytes maximum).',
  EnforcedPause: 'This feature is paused by the contract admins.',
  ERC20InsufficientBalance: 'Insufficient token balance.',
  ERC20InsufficientAllowance: 'Token approval is too low. Approve and try again.',
}

interface Link {
  name: string
  message: string
  code?: number | string
}

/** Flattens an error and its causes so wallet, wagmi and viem errors can all be recognised the same way. */
function links(error: unknown): Link[] {
  const out: Link[] = []
  let cur: unknown = error
  for (let i = 0; i < 8 && cur; i++) {
    if (typeof cur === 'object') {
      const o = cur as { name?: unknown; message?: unknown; shortMessage?: unknown; code?: unknown; cause?: unknown; details?: unknown }
      out.push({
        name: typeof o.name === 'string' ? o.name : '',
        message: [o.shortMessage, o.message, o.details].filter((x): x is string => typeof x === 'string').join(' | '),
        code: typeof o.code === 'number' || typeof o.code === 'string' ? o.code : undefined,
      })
      cur = o.cause
    } else {
      out.push({ name: '', message: typeof cur === 'string' ? cur : '' })
      break
    }
  }
  return out
}

const has = (ls: Link[], test: (l: Link) => boolean) => ls.some(test)
const text = (ls: Link[]) => ls.map((l) => l.message).join(' ').toLowerCase()

export function parseTxError(error: unknown): ParsedError {
  const ls = links(error)
  const all = text(ls)

  if (error instanceof TxError) return { rejected: false, message: error.message }

  // The user closed or declined the wallet prompt
  if (
    has(ls, (l) => l.name === 'UserRejectedRequestError' || l.code === 4001 || l.code === 'ACTION_REJECTED') ||
    all.includes('user rejected') || all.includes('user denied') || all.includes('request rejected') || all.includes('rejected the request')
  ) {
    return { rejected: true, message: 'You cancelled the request in your wallet. Nothing was sent.' }
  }

  // A previous wallet request is still open (commonly a hidden extension popup)
  if (has(ls, (l) => l.code === -32002) || all.includes('already pending') || all.includes('resource unavailable')) {
    return { rejected: false, message: 'Your wallet already has a request open. Open the wallet extension, approve or reject it, then try again.' }
  }

  // Wallet connection problems
  if (has(ls, (l) => ['ConnectorNotConnectedError', 'ConnectorAccountNotFoundError'].includes(l.name)) || all.includes('connector not connected') || all.includes('no account')) {
    return { rejected: false, message: 'Your wallet is disconnected. Reconnect it and try again.' }
  }
  if (has(ls, (l) => ['ConnectorChainMismatchError', 'ChainNotConfiguredError', 'SwitchChainError', 'SwitchChainNotSupportedError', 'ChainMismatchError'].includes(l.name)) || all.includes('chain mismatch') || all.includes('does not match the target chain')) {
    return { rejected: false, message: 'Your wallet is on the wrong network. Switch to Arc Mainnet (chain 5042) and try again.' }
  }
  if (has(ls, (l) => l.code === 4902) || all.includes('unrecognized chain')) {
    return { rejected: false, message: 'Your wallet does not know the Arc network yet. Approve adding it when your wallet asks.' }
  }

  // Contract reverts, including custom errors
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName
      if (name && CUSTOM[name]) return { rejected: false, message: CUSTOM[name] }
      if (name) return { rejected: false, message: `The contract rejected this transaction (${name}). Nothing was sent.` }
      if (revert.reason) return { rejected: false, message: `The contract rejected this transaction: ${revert.reason}. Nothing was sent.` }
      return { rejected: false, message: 'The transaction would revert, so it was not sent.' }
    }
  }

  // Balance and gas
  if (has(ls, (l) => l.name === 'InsufficientFundsError') || all.includes('insufficient funds') || all.includes('exceeds balance') || all.includes('transfer amount exceeds balance')) {
    return { rejected: false, message: 'Insufficient balance: you need enough USDC for the amount plus the network fee.' }
  }
  if (all.includes('gas required exceeds') || all.includes('intrinsic gas too low') || all.includes('out of gas') || all.includes('gas limit') || all.includes('exceeds block gas')) {
    return { rejected: false, message: 'Insufficient gas: the gas limit is too low for this transaction. Try again, or raise the gas limit in your wallet.' }
  }
  if (all.includes('underpriced') || all.includes('max fee per gas less than block base fee') || all.includes('fee cap')) {
    return { rejected: false, message: 'The network fee was too low for Arc. Retry and keep the suggested fee.' }
  }
  if (all.includes('nonce too low') || all.includes('already known') || all.includes('replacement transaction')) {
    return { rejected: false, message: 'Your wallet has an earlier transaction still pending or already known. Wait for it to finish, then try again.' }
  }

  // RPC trouble
  if (
    has(ls, (l) => ['HttpRequestError', 'TimeoutError', 'WebSocketRequestError', 'RpcRequestError'].includes(l.name)) ||
    all.includes('failed to fetch') || all.includes('network error') || all.includes('timed out') || all.includes('http request failed') || all.includes('503') || all.includes('429')
  ) {
    return { rejected: false, message: 'The Arc RPC is not responding right now. Check your connection and try again. Nothing was sent.' }
  }

  const base = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : ''
  return { rejected: false, message: base || 'Something went wrong. Please try again.' }
}
