import type { ReactNode } from 'react'
import { ConnectKitButton } from 'connectkit'
import { CircleSlash, QrCode, Wallet, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { useArcWallet, useConnectWallet } from '@/hooks/useWallet'
import { walletConnectEnabled, walletConnectOrigin } from '@/config/wallet'
import { CONTRACT_DEFINITIONS, type ContractName } from '@/config/contracts'
import { Card, Notice } from './ui'
import { LogoMark } from './Logo'

/** Wallet connection interface: MetaMask connects directly, everything else goes through the wallet modal. */
export function ConnectPanel() {
  const { metamask, metamaskInstalled, mobile, openInMetaMaskApp, connectWith, connecting, error, clearError } = useConnectWallet()
  return (
    <ConnectKitButton.Custom>
      {({ show }) => (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              disabled={connecting}
              onClick={() => {
                if (metamask && metamaskInstalled) void connectWith(metamask)
                else if (mobile) {
                  // Phone or tablet browsers have no extension: continue inside the MetaMask app's own browser.
                  toast.info('Opening FLUXORA inside the MetaMask app…')
                  openInMetaMaskApp()
                } else {
                  toast.info('MetaMask was not detected in this browser. Opening the install page.')
                  window.open('https://metamask.io/download/', '_blank', 'noopener,noreferrer')
                }
              }}
              className="lift glass-inner group relative flex min-h-[88px] items-center gap-4 overflow-hidden rounded-2xl p-4 text-left disabled:opacity-60"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white shadow-glow" style={{ background: 'linear-gradient(135deg,#FF8A3D,#FF55B8)' }}>
                <Wallet size={22} />
              </span>
              <span className="min-w-0">
                <span className="block font-display text-base font-semibold text-white">MetaMask</span>
                <span className="block text-xs text-slate-400">{connecting ? 'Check your wallet…' : metamaskInstalled ? 'Detected. Click to connect' : mobile ? 'Not in this browser. Open in the MetaMask app' : 'Not detected. Click to install'}</span>
              </span>
            </button>
            <button
              onClick={walletConnectEnabled ? show : () => toast.info('WalletConnect is off. Add VITE_WALLETCONNECT_PROJECT_ID to enable it.')}
              aria-disabled={!walletConnectEnabled}
              className="lift glass-inner group relative flex min-h-[88px] items-center gap-4 overflow-hidden rounded-2xl p-4 text-left aria-disabled:opacity-60"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white shadow-cyan" style={{ background: 'linear-gradient(135deg,#27D9FF,#8257FF)' }}>
                <QrCode size={22} />
              </span>
              <span className="min-w-0">
                <span className="block font-display text-base font-semibold text-white">WalletConnect</span>
                <span className="block text-xs text-slate-400">{walletConnectEnabled ? (mobile ? 'Pick a wallet app on this phone' : 'Scan with any mobile wallet') : 'Needs a project id (see .env.example)'}</span>
              </span>
            </button>
          </div>
          {error && (
            <Notice tone="error" action={<button className="underline" onClick={clearError}>Dismiss</button>}>
              {error}
            </Notice>
          )}
          <p className="text-center text-xs text-slate-500">
            Using another wallet?{' '}
            <button className="-my-3 inline-flex min-h-[44px] items-center px-1 text-[var(--a)] underline underline-offset-2" onClick={show}>
              Show all wallets
            </button>
            {walletConnectEnabled && <> · WalletConnect allowed domain: <span className="font-mono text-slate-400">{walletConnectOrigin()}</span></>}
          </p>
        </div>
      )}
    </ConnectKitButton.Custom>
  )
}

/** Renders children only when a wallet is connected AND on Arc mainnet. Otherwise guides the user. */
export function ArcGate({ children, feature }: { children: ReactNode; feature: string }) {
  const { isConnected, onArc, switchToArc, switching } = useArcWallet()

  if (!isConnected) {
    return (
      <Card className="space-y-5 py-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <LogoMark size={64} tile />
          <div>
            <h2 className="font-display text-xl font-semibold">Connect your wallet</h2>
            <p className="mt-1 text-sm text-slate-400">Connect a wallet to use {feature}.</p>
          </div>
        </div>
        <ConnectPanel />
      </Card>
    )
  }

  if (!onArc) {
    return (
      <Card className="space-y-4">
        <Notice tone="warn">
          {feature} runs on Arc mainnet. Your wallet is on a different network, so no transaction will be sent until you switch.
        </Notice>
        <button
          className="btn-primary w-full"
          disabled={switching}
          onClick={() => {
            switchToArc().catch(() => toast.error('Network switch was cancelled or failed.'))
          }}
        >
          <Zap size={18} />
          {switching ? 'Check your wallet…' : 'Switch to Arc'}
        </button>
      </Card>
    )
  }

  return <>{children}</>
}

/**
 * Shown when FLUXORA contract addresses are not configured. It never fakes data and never uses a
 * placeholder address: it says "Contract Not Deployed" and names the environment variable to set.
 */
export function NotDeployed({ contracts }: { contracts: ContractName[] }) {
  const missing = contracts.map((c) => CONTRACT_DEFINITIONS[c]).filter((c) => !c.address)
  if (missing.length === 0) return null
  return (
    <Card className="space-y-4">
      <div className="flex items-start gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/5 text-slate-300">
          <CircleSlash size={22} />
        </span>
        <div>
          <h2 className="font-display text-xl font-semibold text-white">Contract Not Deployed</h2>
          <p className="mt-1 text-sm text-slate-400">
            {missing.map((m) => m.label).join(', ')} {missing.length > 1 ? 'have' : 'has'} no address configured, so this feature is off. FLUXORA never
            invents contract addresses.
          </p>
        </div>
      </div>
      <div className="glass-inner space-y-1.5 rounded-2xl p-4 text-xs text-slate-300">
        <p className="label mb-1">After you deploy, set</p>
        {missing.map((m) => (
          <p key={m.name} className="font-mono">{m.envVar}=0x…</p>
        ))}
        <p className="pt-1 text-slate-500">Steps: docs/DEPLOYMENT.md, then restart the dev server or redeploy the site.</p>
      </div>
    </Card>
  )
}
