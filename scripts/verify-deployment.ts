/**
 * Read-only check of a FLUXORA deployment on Arc. It sends NO transactions and needs NO wallet or key.
 *
 *   bun run verify:deployment                       reads the VITE_FLUXORA_*_ADDRESS values from .env
 *   bun run verify:deployment --admin=0xYou...      also checks that address holds the Payments admin role
 *
 * Run it after the Remix steps in docs/REMIX_DEPLOYMENT.md and BEFORE you announce or fund anything.
 * Exit code 0 means every check passed; 1 means at least one FAIL (details are printed).
 */
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem'
import { fluxoraPaymentsAbi, fluxoraTokenAbi } from '../src/config/abis.generated'
import { ARC_CHAIN_ID, HOME_NETWORK } from '../src/config/networks'
import { getUsdc } from '../src/onchain-facts'

const results: { status: 'PASS' | 'FAIL' | 'WARN'; name: string; detail: string }[] = []
const record = (status: 'PASS' | 'FAIL' | 'WARN', name: string, detail = '') => results.push({ status, name, detail })
const check = (ok: boolean, name: string, detail = '') => record(ok ? 'PASS' : 'FAIL', name, detail)

function addressFromEnv(name: string): Address | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  if (!isAddress(raw)) {
    record('FAIL', name, `"${raw}" is not a valid address`)
    return undefined
  }
  return getAddress(raw)
}

const adminArg = process.argv.find((a) => a.startsWith('--admin='))?.slice('--admin='.length)
const admin = adminArg && isAddress(adminArg) ? getAddress(adminArg) : undefined
if (adminArg && !admin) record('FAIL', '--admin', `"${adminArg}" is not a valid address`)

const addrs = {
  token: addressFromEnv('VITE_FLUXORA_TOKEN_ADDRESS'),
  payments: addressFromEnv('VITE_FLUXORA_PAYMENTS_ADDRESS'),
}

const rpcUrl = process.env.VITE_ARC_RPC_URL?.trim() || HOME_NETWORK.rpcUrls[0]
if (!rpcUrl) throw new Error('No Arc RPC URL is configured.')
const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 15_000 }) })

async function main() {
  console.log(`RPC: ${new URL(rpcUrl).host}`)
  const chainId = await client.getChainId()
  check(chainId === ARC_CHAIN_ID, 'RPC serves Arc Mainnet', `chain id ${chainId}, expected ${ARC_CHAIN_ID}`)
  if (chainId !== ARC_CHAIN_ID) return

  const missing = Object.entries(addrs).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    record('FAIL', 'Contract addresses configured', `missing in .env: ${missing.join(', ')} (see docs/REMIX_DEPLOYMENT.md)`)
    return
  }
  const { token, payments } = addrs as Record<keyof typeof addrs, Address>
  for (const [name, address] of Object.entries(addrs)) {
    const code = await client.getCode({ address: address as Address })
    check(Boolean(code && code !== '0x'), `${name} has contract code`, address)
  }
  if (results.some((r) => r.status === 'FAIL')) return

  const usdc = getUsdc(ARC_CHAIN_ID)?.address as Address | undefined

  // ── Token ────────────────────────────────────────────────────────────────
  const [name, symbol, decimals, supply, maxSupply] = await Promise.all([
    client.readContract({ address: token, abi: fluxoraTokenAbi, functionName: 'name' }),
    client.readContract({ address: token, abi: fluxoraTokenAbi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: fluxoraTokenAbi, functionName: 'decimals' }),
    client.readContract({ address: token, abi: fluxoraTokenAbi, functionName: 'totalSupply' }),
    client.readContract({ address: token, abi: fluxoraTokenAbi, functionName: 'INITIAL_SUPPLY' }),
  ])
  check(name === 'FLUXORA' && symbol === 'FLUX' && decimals === 18, 'Token is FLUXORA / FLUX / 18 decimals', `${name} / ${symbol} / ${decimals}`)
  check(supply <= maxSupply && maxSupply === 1_000_000_000n * 10n ** 18n, 'Token supply never exceeds the fixed 1,000,000,000 FLUX', `total supply ${supply}`)
  // ── Payments ─────────────────────────────────────────────────────────────
  const pay = <F extends 'DEFAULT_ADMIN_ROLE' | 'PAUSER_ROLE' | 'feeBps' | 'MAX_FEE_BPS' | 'paused'>(functionName: F) =>
    client.readContract({ address: payments, abi: fluxoraPaymentsAbi, functionName })
  const [pAdminRole, pPauserRole, feeBps, maxFee, pPaused] = await Promise.all([
    pay('DEFAULT_ADMIN_ROLE'), pay('PAUSER_ROLE'), pay('feeBps'), pay('MAX_FEE_BPS'), pay('paused'),
  ])
  const payHas = (role: `0x${string}`, account: Address) =>
    client.readContract({ address: payments, abi: fluxoraPaymentsAbi, functionName: 'hasRole', args: [role, account] })
  const payTokenOk = (t: Address) =>
    client.readContract({ address: payments, abi: fluxoraPaymentsAbi, functionName: 'supportedTokens', args: [t] })
  if (admin) check(await payHas(pAdminRole, admin), 'Payments admin role is held by the expected admin', admin)
  else record('WARN', 'Payments admin not checked', 'pass --admin=0xYourAdmin to confirm who holds the admin role')
  check(feeBps <= maxFee, 'Payment fee is within the hard cap', `${feeBps} bps (cap ${maxFee})`)
  check(!pPaused, 'Payments is not paused', '')
  if (usdc) check(await payTokenOk(usdc), 'Payments accepts Arc USDC', usdc)
  check(await payTokenOk(token), 'Payments accepts FLUX', token)
  if (admin && (await payHas(pPauserRole, admin))) record('WARN', 'Admin is also the Payments pauser', 'intended if one wallet runs the contract; use a separate pauser for stricter separation')
}

await main().catch((error: unknown) => {
  record('FAIL', 'Verification could not finish', error instanceof Error ? error.message.split('\n')[0] ?? 'error' : 'error')
})

const icon = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN' } as const
for (const r of results) console.log(`${icon[r.status]}  ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`)
const fails = results.filter((r) => r.status === 'FAIL').length
console.log(`\n${results.filter((r) => r.status === 'PASS').length} passed, ${fails} failed, ${results.filter((r) => r.status === 'WARN').length} warnings`)
process.exit(fails ? 1 : 0)
