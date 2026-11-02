// Turns a Foundry broadcast file into (1) a deployments/<network>.json record and (2) the .env lines the app needs.
// It only READS the broadcast output and writes a JSON record. It never signs, sends or touches keys.
//
//   bun run deploy:record            # reads broadcast/DeployFluxora.s.sol/5042/run-latest.json
//   bun run deploy:record 5042002    # a different chain id
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface BroadcastTx {
  contractName?: string | null
  contractAddress?: string | null
  transactionType?: string
  hash?: string
}
interface BroadcastFile {
  transactions: BroadcastTx[]
  receipts?: { blockNumber?: string }[]
  timestamp?: number
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const chainId = process.argv[2] ?? '5042'
const file = join(root, 'broadcast', 'DeployFluxora.s.sol', chainId, 'run-latest.json')

if (!existsSync(file)) {
  console.error(`No broadcast file at ${file}.\nRun the deploy script with --broadcast first (docs/DEPLOYMENT.md).`)
  process.exit(1)
}

const data = JSON.parse(readFileSync(file, 'utf8')) as BroadcastFile
const addressOf = (name: string): string => {
  const hit = data.transactions.find((t) => t.contractName === name && t.contractAddress)
  if (!hit?.contractAddress) throw new Error(`${name} was not found in the broadcast. Did the deployment finish?`)
  return hit.contractAddress
}

const contracts = {
  token: addressOf('FluxoraToken'),
  payments: addressOf('FluxoraPaymentsStandalone'),
}
const blocks = (data.receipts ?? []).map((r) => (r.blockNumber ? Number(BigInt(r.blockNumber)) : 0)).filter((n) => n > 0)
const deployBlock = blocks.length ? Math.min(...blocks) : undefined

const names: Record<string, string> = { '5042': 'arc-mainnet', '5042002': 'arc-testnet' }
const label = names[chainId] ?? `chain-${chainId}`
const outDir = join(root, 'contracts', 'deployments')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, `${label}.json`)
writeFileSync(out, JSON.stringify({ chainId: Number(chainId), network: label, deployBlock: deployBlock ?? null, contracts }, null, 2) + '\n')

console.log(`Wrote ${out}\n`)
console.log('Add these to your .env (and to your host\'s environment settings), then restart / redeploy:\n')
console.log(`VITE_FLUXORA_TOKEN_ADDRESS=${contracts.token}`)
console.log(`VITE_FLUXORA_PAYMENTS_ADDRESS=${contracts.payments}`)
if (deployBlock) console.log(`VITE_FLUXORA_DEPLOY_BLOCK=${deployBlock}`)
if (chainId !== '5042') {
  console.log('\nNote: the app is configured for Arc mainnet (5042). Addresses from another chain will not work in it.')
}
