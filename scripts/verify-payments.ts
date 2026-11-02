/**
 * Read-only check of a deployed FluxoraPaymentsStandalone contract on Arc Mainnet. Sends nothing.
 *
 *   bun run verify:payments --admin=0xYourWallet [--address=0xContract]
 *
 * The contract address comes from VITE_FLUXORA_PAYMENTS_ADDRESS in .env unless --address is given.
 * The RPC comes from VITE_ARC_RPC_URL or the default Arc RPC. Exit code 1 means at least one check failed.
 */
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem'
import { fluxoraPaymentsStandaloneAbi as abi } from '../src/config/abis.generated'
import { HOME_NETWORK } from '../src/config/networks'
import { getUsdc } from '../src/onchain-facts'

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

let failed = 0
let warned = 0
let passed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -  ${detail}` : ''}`)
}
function warn(name: string, detail = ''): void {
  warned++
  console.log(`WARN  ${name}${detail ? `  -  ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const adminArg = arg('admin')
  const contractArg = arg('address') ?? process.env.VITE_FLUXORA_PAYMENTS_ADDRESS
  if (!adminArg || !isAddress(adminArg)) {
    console.log('Usage: bun run verify:payments --admin=0xYourDeployerWallet [--address=0xContract]')
    process.exit(1)
  }
  if (!contractArg || !isAddress(contractArg)) {
    console.log('Set VITE_FLUXORA_PAYMENTS_ADDRESS in .env (or pass --address=0x...).')
    process.exit(1)
  }
  const admin = getAddress(adminArg)
  const contract = getAddress(contractArg)
  const rpc = process.env.VITE_ARC_RPC_URL?.trim() || HOME_NETWORK.rpcUrls[0]
  if (!rpc) throw new Error('No RPC URL configured')
  const client = createPublicClient({ transport: http(rpc) })
  console.log(`RPC: ${new URL(rpc).host}   contract: ${contract}   expected admin: ${admin}`)

  const chainId = await client.getChainId()
  check('RPC serves Arc Mainnet', chainId === HOME_NETWORK.id, `chain id ${chainId}, expected ${HOME_NETWORK.id}`)
  const code = await client.getCode({ address: contract })
  check('Contract has code at this address', Boolean(code && code !== '0x'), contract)
  if (!code || code === '0x') return

  const c = { address: contract, abi } as const
  const [defaultAdmin, pending, delay, pauserRole, adminRole, feeBps, feeRecipient, paused, maxFee, nextPayment, nextRequest] =
    await Promise.all([
      client.readContract({ ...c, functionName: 'defaultAdmin' }),
      client.readContract({ ...c, functionName: 'pendingDefaultAdmin' }),
      client.readContract({ ...c, functionName: 'defaultAdminDelay' }),
      client.readContract({ ...c, functionName: 'PAUSER_ROLE' }),
      client.readContract({ ...c, functionName: 'DEFAULT_ADMIN_ROLE' }),
      client.readContract({ ...c, functionName: 'feeBps' }),
      client.readContract({ ...c, functionName: 'feeRecipient' }),
      client.readContract({ ...c, functionName: 'paused' }),
      client.readContract({ ...c, functionName: 'MAX_FEE_BPS' }),
      client.readContract({ ...c, functionName: 'nextPaymentId' }),
      client.readContract({ ...c, functionName: 'nextRequestId' }),
    ])

  check('Admin is your wallet', getAddress(defaultAdmin) === admin, defaultAdmin)
  check('No admin transfer is pending', getAddress(pending[0]) === '0x0000000000000000000000000000000000000000', `pending admin ${pending[0]}`)
  const days = Number(delay) / 86_400
  check('Admin transfer delay is 1 to 30 days', delay >= 86_400 && delay <= 2_592_000, `${delay} s (${days} days)`)
  const hasAdmin = await client.readContract({ ...c, functionName: 'hasRole', args: [adminRole, admin] })
  const hasPauser = await client.readContract({ ...c, functionName: 'hasRole', args: [pauserRole, admin] })
  check('Your wallet holds DEFAULT_ADMIN_ROLE', hasAdmin)
  check('Your wallet is a pauser', hasPauser)
  check('Fee is within the hard cap', feeBps <= maxFee, `${feeBps} bps (cap ${maxFee})`)
  if (feeBps === 0n) check('Fee starts at 0', true, 'no fee is charged')
  else warn('A fee is active', `${feeBps} bps to ${feeRecipient}`)
  check('Contract is not paused', !paused)
  console.log(`  info: ${nextPayment - 1n} payments and ${nextRequest - 1n} requests so far`)

  const usdc = getUsdc(HOME_NETWORK.id)?.address as Address | undefined
  if (usdc) {
    const ok = await client.readContract({ ...c, functionName: 'supportedTokens', args: [usdc] })
    check('Arc USDC is accepted', ok, usdc)
  }
  console.log(`\n${passed} passed, ${failed} failed, ${warned} warnings`)
}

await main()
process.exit(failed > 0 ? 1 : 0)
