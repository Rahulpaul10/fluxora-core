# Deploy FLUXORA from Remix with your own wallet (Arc)

Everything here is manual and sends real, irreversible transactions if you use Arc Mainnet. Arc Studio never deploys
for you. These contracts have **not** had an independent professional audit. Rehearse on Arc Testnet first, and
re-read every address before you confirm a transaction.

## What you are deploying

Two contracts. Send, Receive, Swap and Bridge need neither; they only power the FLUX token and the Pay page.

| Order | Contract | What the app uses it for |
|---|---|---|
| 1 | `FluxoraToken` | FLUX token: fixed 1,000,000,000 supply, burnable, gasless `permit` |
| 2 | `FluxoraPaymentsStandalone` | Pay, payment requests and receipts (Pay page) |

You (the wallet that deploys) are `msg.sender` for every deployment. There is no private key, hidden mint, hidden
transfer or upgrade backdoor in either contract.

Only need the Pay page? Skip the token and deploy the single payments contract instead:
`docs/PAYMENTS_REMIX_DEPLOYMENT.md`.

## Files and compiler settings

`contracts/remix/FluxoraToken.flat.sol` is self-contained (OpenZeppelin 5.6.1 is already inside it). Generate the single
file for the payments contract when you need it (see `contracts/remix/README.md`).

| Setting | Value |
|---|---|
| Compiler | `0.8.28` |
| Language | Solidity |
| EVM version | `cancun` (set it by hand, do not leave it on default) |
| Optimization | Enabled, **200** runs |

## Before you start
1. MetaMask is on the Arc network you intend to use (Arc Mainnet chain ID 5042, or Arc Testnet 5042002) and the
   wallet you deploy from is selected.
2. That wallet holds some USDC (on Arc, USDC is the gas token). Check the fee MetaMask shows before you confirm.
3. `YOUR_WALLET` below receives **all 1,000,000,000 FLUX** and becomes the Payments admin. Use a wallet you control
   well, ideally a hardware wallet or a multisig that can call contracts.
4. Open https://remix.ethereum.org, create a workspace, and upload `FluxoraToken.flat.sol` from `contracts/remix/` and the
   payments file you generate with `forge flatten contracts/src/FluxoraPaymentsStandalone.sol -o FluxoraPaymentsStandalone.flat.sol`.

## Deploy (Remix: Deploy & Run Transactions)
Environment: **Injected Provider - MetaMask**. For each step choose the contract in the dropdown, paste the values
next to its Deploy button, and confirm in MetaMask. Copy each deployed address into a notepad.

Array arguments are typed in brackets: `[]` is empty, `["0xabc..."]` has one entry, separated by commas.

**1. FluxoraToken**
- `initialHolder`: `YOUR_WALLET`

**2. FluxoraPaymentsStandalone**
- `adminTransferDelay`: `172800` (2 days; allowed range 86400 to 2592000). This is how long an admin handover must wait.
- `initialTokens`: `["0x3600000000000000000000000000000000000000","TOKEN_ADDRESS"]`
  (Arc USDC and FLUX)

The wallet that deploys becomes the admin and pauser.

## Check the deployment, then connect the app
Put the addresses in `.env` (locally) or in your host's environment settings, then run the read-only check:

```
VITE_FLUXORA_TOKEN_ADDRESS=0x...
VITE_FLUXORA_PAYMENTS_ADDRESS=0x...
VITE_FLUXORA_DEPLOY_BLOCK=<block of the FluxoraToken deployment transaction, from the explorer>
```

```
bun run verify:deployment --admin=YOUR_WALLET
```

It sends nothing and needs no wallet. It checks the chain, that both addresses have code, the token supply, the
Payments admin, the fee cap, and the payment token allowlist. Fix every FAIL before using the app. Then restart the
dev server (Vite reads `.env` only at start-up) or rebuild and redeploy the site. A missing or malformed address
shows a "Configuration problem" notice instead of failing silently.

## After deployment
- Move the admin role to a multisig when you are ready: `beginDefaultAdminTransfer(<multisig>)`, then `acceptDefaultAdminTransfer()` from the multisig after the delay. The pauser role follows the admin.
- The admin can change the payment fee (hard cap 1%) and allow more payment tokens. Only add standard,
  non-rebasing, non-fee-on-transfer tokens.

## Verify the source on the explorer
If the explorer's contract page offers a verification form:
1. Choose single-file Solidity, compiler `0.8.28`, EVM `cancun`, optimization **Yes**, **200** runs, license MIT.
2. Paste the `*.flat.sol` file for that contract.
3. Constructor arguments, ABI-encoded without `0x`:
   - Token `cast abi-encode "constructor(address)" YOUR_WALLET`
   - Payments `constructor(address,address,address[])`

## Security status
- Automated tests cover both contracts, including fuzz and invariant tests (`forge test`).
- **No independent professional audit has been done.** Get one before large amounts of value are involved.
- Known design limits: the admin and pauser are plain wallets until you move them to a multisig, and allowed payment
  tokens must be standard non-rebasing tokens.
