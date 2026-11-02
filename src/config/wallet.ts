/**
 * Wallet and wagmi configuration for FLUXORA. Chains and RPC transports come from ./networks.
 *
 * Environment variables:
 *   VITE_WALLETCONNECT_PROJECT_ID  Enables WalletConnect (free id from https://cloud.walletconnect.com)
 *   VITE_APP_URL                   Optional. Public URL shown to wallets. Defaults to the page's own origin,
 *                                  so it follows your domain automatically after you deploy.
 * Built with Arc Studio — https://studio.arc.io
 */
import { createConfig } from 'wagmi'
import { UserRejectedRequestError } from 'viem'
import { arc, mainnet, base, arbitrum, optimism, polygon, avalanche } from 'viem/chains'
import { injected, walletConnect } from 'wagmi/connectors'
import { NETWORKS, rpcTransport } from '@/config/networks'
import { reportConfigIssue } from '@/lib/configIssues'

// Only inside the Arc Studio preview (see main.tsx): tell the request tracer which RPC URL belongs to which chain
if (window.parent !== window) {
  void import('../tracing').then((trace) => {
    for (const n of NETWORKS) trace.registerChain(n.id, n.rpcUrls[0])
  })
}

export const WALLETCONNECT_PROJECT_ID: string = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined)?.trim() ?? ''
export const walletConnectEnabled = WALLETCONNECT_PROJECT_ID.length > 0

/** The exact origin WalletConnect checks against the allowed domains of your Reown project. */
export const walletConnectOrigin = (): string => {
  try {
    return new URL(appUrl()).origin
  } catch {
    return window.location.origin
  }
}

/** The origin wallets see. Never hardcoded: it follows whatever domain serves the app. */
export const appUrl = (): string => {
  const configured = (import.meta.env.VITE_APP_URL as string | undefined)?.trim()
  return configured || window.location.origin
}

/**
 * wagmi needs the chain list as a literal tuple so contract calls stay fully typed. The values still come
 * from NETWORKS (RPC overrides included); the casts only restore each chain's literal type.
 * To add a network: add it to NETWORKS in ./networks AND to this tuple and the transports below.
 */
const net = (id: number) => {
  const found = NETWORKS.find((n) => n.id === id)
  if (!found) throw new Error(`Network ${id} is not configured in src/config/networks.ts`)
  return found
}
const chains = [
  net(arc.id).chain as typeof arc,
  net(mainnet.id).chain as typeof mainnet,
  net(base.id).chain as typeof base,
  net(arbitrum.id).chain as typeof arbitrum,
  net(optimism.id).chain as typeof optimism,
  net(polygon.id).chain as typeof polygon,
  net(avalanche.id).chain as typeof avalanche,
] as const

export const config = createConfig({
  chains,
  transports: {
    [arc.id]: rpcTransport(net(arc.id)),
    [mainnet.id]: rpcTransport(net(mainnet.id)),
    [base.id]: rpcTransport(net(base.id)),
    [arbitrum.id]: rpcTransport(net(arbitrum.id)),
    [optimism.id]: rpcTransport(net(optimism.id)),
    [polygon.id]: rpcTransport(net(polygon.id)),
    [avalanche.id]: rpcTransport(net(avalanche.id)),
  },
  // Every wallet that announces itself (EIP-6963: MetaMask, Rabby, Brave, ...) is added automatically by wagmi
  // as its own connector. We deliberately do NOT register a bare injected() connector: it talks to whatever
  // owns window.ethereum, and with several extensions installed (for example Coinbase Wallet plus MetaMask)
  // that opens a wallet-picker popup which fails the connection when dismissed.
  multiInjectedProviderDiscovery: true,
  // Arc blocks are ~0.5s; viem's default 4s polling would add seconds to every confirmation
  pollingInterval: 1_000,
  connectors: [
    injected({ target: 'metaMask' }),
    ...(walletConnectEnabled
      ? [
          walletConnect({
            projectId: WALLETCONNECT_PROJECT_ID,
            showQrModal: false,
            metadata: { name: 'FLUXORA', description: 'One Wallet. Every Possibility.', url: appUrl(), icons: [`${appUrl()}/fluxora-icon.svg`] },
          }),
        ]
      : []),
  ],
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}

/** Retry policy for read queries: transient RPC failures are retried, a rejected wallet prompt is not. */
export const queryRetry = (failureCount: number, error: unknown): boolean => {
  if (error instanceof UserRejectedRequestError) return false
  return failureCount < 3
}
export const queryRetryDelay = (attempt: number): number => Math.min(500 * 2 ** attempt, 6_000)

{
  const configured = (import.meta.env.VITE_APP_URL as string | undefined)?.trim()
  if (configured) {
    try {
      if (new URL(configured).origin !== window.location.origin) {
        reportConfigIssue(`VITE_APP_URL (${configured}) differs from this page's origin (${window.location.origin}). WalletConnect and share links will not match. Leave it empty unless you need it.`)
      }
    } catch {
      reportConfigIssue('VITE_APP_URL is not a valid URL.')
    }
  }
  if (!walletConnectEnabled) console.info('[FLUXORA] WalletConnect is off: set VITE_WALLETCONNECT_PROJECT_ID to enable it.')
  else if (!/^[a-f0-9]{32}$/i.test(WALLETCONNECT_PROJECT_ID)) {
    reportConfigIssue('VITE_WALLETCONNECT_PROJECT_ID does not look like a Reown/WalletConnect project id (32 hexadecimal characters). WalletConnect will be rejected until it is corrected.')
  }
}
