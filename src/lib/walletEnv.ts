/**
 * Browser / wallet environment detection used by the connect screen.
 * Everything here reads the real browser; nothing is simulated.
 */

interface EthereumLike {
  isMetaMask?: boolean
  providers?: EthereumLike[]
}

/** A phone or tablet browser (iPadOS reports itself as a Mac, so touch support is checked too). */
export function isMobileBrowser(): boolean {
  const ua = navigator.userAgent
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/** MetaMask injected `window.ethereum` (desktop extension, or the MetaMask app's built-in browser on mobile). */
export function metamaskInjected(): boolean {
  const eth = (window as { ethereum?: EthereumLike }).ethereum
  if (!eth) return false
  return Boolean(eth.isMetaMask || eth.providers?.some((p) => p.isMetaMask))
}

/**
 * Link that opens THIS page inside the MetaMask mobile app's browser. Built from the current location,
 * so it follows whatever domain serves the app (no hardcoded domain).
 * Format documented by MetaMask: https://metamask.app.link/dapp/<host>/<path>
 */
export function metamaskDeepLink(): string {
  const { host, pathname, search } = window.location
  return `https://metamask.app.link/dapp/${host}${pathname}${search}`
}

let announcedMetaMask = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((cb) => cb())

if (typeof window !== 'undefined') {
  // EIP-6963: wallets announce themselves, possibly after the page has loaded
  window.addEventListener('eip6963:announceProvider', (event) => {
    const rdns = (event as CustomEvent<{ info?: { rdns?: string } }>).detail?.info?.rdns
    if (rdns === 'io.metamask' && !announcedMetaMask) {
      announcedMetaMask = true
      notify()
    }
  })
  // Legacy providers fire this when they finish injecting
  window.addEventListener('ethereum#initialized', notify)
}

/** useSyncExternalStore subscription: re-checks on wallet announcements and for a few seconds after load. */
export function subscribeMetaMask(cb: () => void): () => void {
  listeners.add(cb)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  // Some in-app and extension providers inject late; look again for ~5 seconds.
  let ticks = 0
  const timer = window.setInterval(() => {
    cb()
    if (++ticks >= 10) window.clearInterval(timer)
  }, 500)
  return () => {
    listeners.delete(cb)
    window.clearInterval(timer)
  }
}

export const metamaskDetectedSnapshot = (): boolean => announcedMetaMask || metamaskInjected()
