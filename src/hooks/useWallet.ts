import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useAccount, useAccountEffect, useConnect, useSwitchChain, type Connector } from 'wagmi'
import { toast } from 'sonner'
import { ARC_CHAIN_ID, asChainId, isSupportedChain, networkById } from '@/config/networks'
import { shortAddr } from '@/lib/format'
import { isMobileBrowser, metamaskDeepLink, metamaskDetectedSnapshot, subscribeMetaMask } from '@/lib/walletEnv'

/** Wallet state relative to Arc, the chain every FLUXORA feature except Bridge runs on. */
export function useArcWallet() {
  const { address, isConnected, isConnecting, isReconnecting, chainId, status } = useAccount()
  const { switchChainAsync, isPending: switching } = useSwitchChain()
  const onArc = chainId === ARC_CHAIN_ID
  /** Connected, but to a network FLUXORA has no configuration for */
  const unsupportedChain = isConnected && chainId !== undefined && !isSupportedChain(chainId)
  const switchToArc = async () => {
    await switchChainAsync({ chainId: asChainId(ARC_CHAIN_ID) })
  }
  return { address, isConnected, isConnecting: isConnecting || isReconnecting, status, chainId, onArc, unsupportedChain, switchToArc, switching }
}

/** Plain-language message for a failed wallet connection. */
export function describeConnectError(error: unknown): string {
  const o = (error ?? {}) as { name?: string; message?: string; code?: number; cause?: { code?: number; message?: string } }
  const code = o.code ?? o.cause?.code
  const msg = `${o.message ?? ''} ${o.cause?.message ?? ''}`.toLowerCase()
  if (code === -32002 || msg.includes('already pending') || msg.includes('resource unavailable')) {
    return 'Your wallet already has a connection request open. Open the wallet extension, approve or reject it, then try again.'
  }
  if (o.name === 'UserRejectedRequestError' || code === 4001 || msg.includes('rejected') || msg.includes('denied')) {
    return 'The connection was cancelled in your wallet. If a popup asked which wallet to use (you have several extensions), choose the wallet you want there.'
  }
  if (o.name === 'ProviderNotFoundError' || msg.includes('provider not found')) {
    return 'No wallet was found in this browser. Install MetaMask, or use WalletConnect with a mobile wallet.'
  }
  if (o.name === 'ConnectorAlreadyConnectedError') return 'This wallet is already connected.'
  if (msg.includes('origin') && (msg.includes('not allowed') || msg.includes('unauthorized'))) {
    return 'WalletConnect rejected this website. Add this domain to the allowed domains of your WalletConnect (Reown) project, then reload.'
  }
  if (msg.includes('project') && msg.includes('id')) {
    return 'WalletConnect rejected the project id. Check VITE_WALLETCONNECT_PROJECT_ID.'
  }
  return o.message?.split('\n')[0] || 'Could not connect. Please try again.'
}

/** Direct, per-wallet connection with real error reporting. Never fakes a connected state. */
export function useConnectWallet() {
  const { connectors, connectAsync, isPending, reset } = useConnect()
  const [error, setError] = useState<string>()
  // Live detection: EIP-6963 announcements, legacy injection events, and a short re-check after load
  const metamaskDetected = useSyncExternalStore(subscribeMetaMask, metamaskDetectedSnapshot, () => false)
  const mobile = isMobileBrowser()

  // Prefer the wallet that announced itself through EIP-6963; fall back to the targeted injected connector.
  const metamask: Connector | undefined = connectors.find((c) => c.id === 'io.metamask') ?? connectors.find((c) => c.id === 'metaMask')
  const metamaskInstalled = metamaskDetected || metamask?.id === 'io.metamask'

  /** Phone or tablet without MetaMask in the browser: continue inside the MetaMask app instead of a dead end. */
  const openInMetaMaskApp = () => {
    window.open(metamaskDeepLink(), '_self')
  }

  const connectWith = async (connector: Connector) => {
    setError(undefined)
    try {
      await connectAsync({ connector })
    } catch (e) {
      setError(describeConnectError(e))
    }
  }

  return {
    metamask,
    metamaskInstalled,
    mobile,
    openInMetaMaskApp,
    connectWith,
    connecting: isPending,
    error,
    clearError: () => {
      setError(undefined)
      reset()
    },
  }
}

/** Surfaces real wallet events: connect, disconnect, account switch, network change. Renders nothing. */
export function WalletEvents() {
  const { address, chainId, isConnected } = useAccount()
  const prevAddress = useRef<string | undefined>(undefined)
  const prevChain = useRef<number | undefined>(undefined)

  useAccountEffect({
    onConnect({ address: a, chainId: c, isReconnected }) {
      if (!isReconnected) toast.success(`Wallet connected: ${shortAddr(a)}`)
      if (!isSupportedChain(c)) toast.warning('This network is not supported by FLUXORA. Switch to Arc Mainnet.')
    },
    onDisconnect() {
      toast('Wallet disconnected')
    },
  })

  useEffect(() => {
    if (!isConnected) {
      prevAddress.current = undefined
      prevChain.current = undefined
      return
    }
    if (prevAddress.current && address && prevAddress.current !== address) toast(`Switched to account ${shortAddr(address)}`)
    if (prevChain.current !== undefined && chainId !== undefined && prevChain.current !== chainId) {
      const name = networkById(chainId)?.name
      if (!name) toast.warning(`Your wallet moved to an unsupported network (chain ${chainId}). Switch to Arc Mainnet.`)
      else if (chainId !== ARC_CHAIN_ID) toast(`Wallet network: ${name}. Switch to Arc Mainnet for Send, Swap and Pay.`)
      else toast.success('Wallet is on Arc Mainnet')
    }
    prevAddress.current = address
    prevChain.current = chainId
  }, [address, chainId, isConnected])

  return null
}
