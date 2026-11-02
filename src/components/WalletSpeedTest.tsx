import { useState } from 'react'
import { runWalletDiagnostics, type DiagResult } from '@/lib/walletDiagnostics'
import { Spinner } from './ui'

/** On-demand comparison of this app's Arc RPC with the RPC your wallet uses. Read-only: nothing is signed or sent. */
export function WalletSpeedTest() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DiagResult>()

  const run = async () => {
    setRunning(true)
    try {
      setResult(await runWalletDiagnostics())
    } finally {
      setRunning(false)
    }
  }

  const slowest = result?.rows.reduce((m, r) => Math.max(m, r.walletMs ?? 0), 0) ?? 0
  const appSlowest = result?.rows.reduce((m, r) => Math.max(m, r.appMs ?? 0), 0) ?? 0

  return (
    <details className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-sm">
      <summary className="cursor-pointer text-slate-300">Wallet feels slow? Run a speed test</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-slate-400">
          Times the same read-only requests through this app's RPC and through your wallet's own network connection, so you can see which one is slow or behind. Nothing is signed or sent.
        </p>
        <button className="btn-ghost" disabled={running} onClick={() => void run()}>
          {running ? (
            <>
              <Spinner /> Testing…
            </>
          ) : (
            'Run speed test'
          )}
        </button>
        {result?.error && <p className="text-xs text-flux-pink">{result.error}</p>}
        {result && !result.error && (
          <div className="space-y-2">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[320px] text-left text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Request</th>
                    <th className="py-1 pr-2 font-medium">App RPC</th>
                    <th className="py-1 font-medium">Your wallet</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular text-slate-200">
                  {result.rows.map((r) => (
                    <tr key={r.call} className="border-t border-white/5">
                      <td className="py-1 pr-2">{r.call}</td>
                      <td className="py-1 pr-2">{r.appMs === null ? 'error' : `${r.appMs} ms`}</td>
                      <td className="py-1">{r.walletMs === null ? 'error' : `${r.walletMs} ms`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-300">
              App RPC: {result.appHost}. Wallet network chain id: {result.walletChainId ?? 'unknown'}.
              {result.blockLag !== undefined && ` Wallet RPC block compared with the app RPC: ${result.blockLag > 0 ? '+' : ''}${result.blockLag}.`}
            </p>
            {slowest > 1500 && slowest > appSlowest * 3 && (
              <p className="text-xs text-amber-300">
                Your wallet's own connection to Arc is much slower than this app's. Open the wallet's network settings for Arc and switch its RPC URL to the one shown above.
              </p>
            )}
          </div>
        )}
      </div>
    </details>
  )
}
