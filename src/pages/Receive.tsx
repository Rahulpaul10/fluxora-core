import { useAccount } from 'wagmi'
import { QRCodeSVG } from 'qrcode.react'
import { Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { ConnectKitButton } from 'connectkit'
import { ARC_CHAIN_ID, explorerAddress } from '@/config/networks'
import { Card, CopyButton, ExplorerLink, Notice, PageTitle } from '@/components/ui'

export function Receive() {
  const { address, isConnected } = useAccount()

  const share = async () => {
    if (!address) return
    const text = `My wallet address on Arc: ${address}`
    try {
      if (navigator.share) await navigator.share({ title: 'My FLUXORA address', text })
      else {
        await navigator.clipboard.writeText(address)
        toast.success('Address copied')
      }
    } catch {
      // user dismissed the share sheet
    }
  }

  return (
    <>
      <PageTitle title="Receive" subtitle="Share your address or QR code to receive USDC and other tokens on Arc." />
      {!isConnected || !address ? (
        <Card className="mx-auto flex max-w-xl flex-col items-center gap-4 py-12 text-center">
          <p className="text-slate-300">Connect a wallet to see your receiving address.</p>
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button className="btn-primary" onClick={show}>
                Connect wallet
              </button>
            )}
          </ConnectKitButton.Custom>
        </Card>
      ) : (
        <div className="mx-auto grid max-w-3xl gap-5 md:grid-cols-2">
          <Card className="flex flex-col items-center gap-4">
            <div className="rounded-3xl bg-white p-4 shadow-glow">
              <QRCodeSVG value={address} size={208} level="M" bgColor="#FFFFFF" fgColor="#070B1F" />
            </div>
            <p className="break-all text-center font-mono text-sm text-slate-200">{address}</p>
            <div className="grid w-full grid-cols-2 gap-2">
              <CopyButton value={address} label="Copy address" />
              <button className="btn-ghost" onClick={() => void share()}>
                <Share2 size={16} /> Share
              </button>
            </div>
            <ExplorerLink href={explorerAddress(ARC_CHAIN_ID, address)}>View on explorer</ExplorerLink>
          </Card>

          <Card className="space-y-4">
            <h2 className="font-display text-lg font-semibold">Receiving instructions</h2>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300">
              <li>Send only assets on Arc mainnet to this address.</li>
              <li>USDC is Arc&apos;s native asset, so incoming USDC shows up as your balance and pays your network fees.</li>
              <li>Funds on another network (Ethereum, Base, and others)? Use Bridge to move USDC to Arc first.</li>
              <li>Incoming transfers appear in History after they are confirmed onchain.</li>
            </ol>
            <Notice tone="warn">Tokens sent from a different network to this address will not arrive on Arc and may be lost.</Notice>
          </Card>
        </div>
      )}
    </>
  )
}
