# Deploy the FLUXORA Payments contract from Remix (Arc Mainnet)

You deploy ONE contract, `FluxoraPaymentsStandalone`, with your own wallet. There is no token contract here. The wallet app only needs this contract for the **Pay** page: paying an address with a receipt, payment
requests, and payment history. Send, Swap and Bridge do not use any FLUXORA contract.

> Mainnet transactions are real and irreversible. Nothing here was deployed or sent by Arc Studio. You deploy it
> yourself, and you are responsible for reviewing the code and for any independent audit. This contract has
> **not** been audited by an independent firm.

## The file

| | |
|---|---|
| Source | `contracts/src/FluxoraPaymentsStandalone.sol` (imports OpenZeppelin 5.6.1 from `node_modules`) |
| Single file for Remix | not stored in the repository. Generate it when you need it: `forge flatten contracts/src/FluxoraPaymentsStandalone.sol -o FluxoraPaymentsStandalone.flat.sol` (OpenZeppelin 5.6.1 gets inlined) |
| Contract name in Remix | `FluxoraPaymentsStandalone` |
| ABI | `contracts/standalone/FluxoraPaymentsStandalone.abi.json` |
| Where FLUXORA's own code starts in the flattened file | the line `/// @title FLUXORA Payments (standalone, self-administered)`; everything above it is OpenZeppelin |

## Remix compiler settings

| Setting | Value |
|---|---|
| Compiler | `0.8.28` |
| EVM version | `cancun` (set it by hand under Advanced Configurations; do not leave "default") |
| Optimization | enabled, `200` runs |
| Language | Solidity |

These settings produce bytecode identical to the Foundry build that the tests ran against.

## Constructor

`constructor(uint48 adminTransferDelay, address[] initialTokens)`

| Parameter | Value to enter | Meaning |
|---|---|---|
| `adminTransferDelay` | `172800` | 2 days. How long an admin handover must wait before it can be accepted. Allowed range: 86400 (1 day) to 2592000 (30 days). |
| `initialTokens` | `["0x3600000000000000000000000000000000000000"]` | Tokens people can pay with: Arc USDC (6 decimals). The admin can add others later with `setTokenSupported`. |

There is no admin parameter: **the wallet that deploys it (`msg.sender`) becomes the only admin and the first pauser.** In
Remix, check that the "Account" shown is your wallet before you click Deploy. The fee starts at 0 and the fee recipient is
empty.

Remix passes the array as shown above (square brackets, double quotes, no spaces needed). ABI-encoded constructor
arguments, if an explorer asks for them:

```
0x000000000000000000000000000000000000000000000000000000000002a300000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000010000000000000000000000003600000000000000000000000000000000000000
```

(Generated with `cast abi-encode "constructor(uint48,address[])" 172800 "[0x3600000000000000000000000000000000000000]"`.)

## Step by step

1. **Generate the single file.** From the repository root run
   `forge flatten contracts/src/FluxoraPaymentsStandalone.sol -o FluxoraPaymentsStandalone.flat.sol`.
   **Open Remix** (remix.ethereum.org). Create a file named `FluxoraPaymentsStandalone.sol` and paste the full contents
   of the generated file (or upload it).
2. **Compile.** In the Solidity compiler tab choose `0.8.28`, open Advanced Configurations, set EVM version to
   `cancun`, tick Enable optimization with `200`. Compile. It should finish with no errors.
3. **Connect your wallet.** In Deploy & Run choose Environment: `Injected Provider - MetaMask`. Make MetaMask use
   **Arc Mainnet, chain ID 5042**. Remix should show "Custom (5042) network". Check that the Account is your wallet.
   Arc's gas is USDC, so the wallet needs a little USDC (see Cost).
4. **Select the contract** `FluxoraPaymentsStandalone` in the Contract dropdown, enter the two constructor values from
   the table, and click Deploy.
5. **Confirm in MetaMask.** Check the network, the fee, and that you are on chain 5042. MetaMask may not show a
   Network Fee for Arc (a MetaMask-side display issue seen earlier); the measured gas is below.
6. **Copy the address.** After the transaction confirms, copy the contract address from "Deployed Contracts" in Remix
   and note the deployment transaction hash and block number from the explorer.
7. **Check the deployment** (read-only, sends nothing):
   ```
   bun run verify:payments --admin=0xYourWallet --address=0xTheNewContract
   ```
   Every line should say PASS: it checks the chain, that you are the admin and a pauser, the 2-day delay, that no fee
   is active, that the contract is not paused, and that USDC is accepted.
8. **Connect the frontend** (next section), then **test with a very small payment** (for example 0.01 USDC)
   before sharing the app.

## Cost

Measured on a local copy of Arc Mainnet: the deployment uses about **2.7 million gas** (2,698,937). At 25 gwei that is
about 0.07 USDC; at 45 gwei about 0.12 USDC. Keep about 1 USDC in the deploying wallet. Later calls cost roughly:
pay about 290k gas, create a request about 200k, pay a request about 320k, admin settings about 50k.

## Connect it to the FLUXORA frontend

1. **Address to add:** the contract address from step 6, as `VITE_FLUXORA_PAYMENTS_ADDRESS`. Nothing else is needed:
   `VITE_FLUXORA_TOKEN_ADDRESS` can stay empty; the FLUX token is then simply not listed. That is expected.
2. **Where:**
   - local / Arc Studio preview: add this line to `.env`, then restart the dev server:
     ```
     VITE_FLUXORA_PAYMENTS_ADDRESS=0xTheNewContract
     ```
   - Netlify (or Vercel): Site configuration > Environment variables, add the same name and value, then trigger a new
     deploy. `VITE_` values are baked in at build time.
3. **ABI:** the app already contains it. `fluxoraPaymentsAbi` in `src/config/abis.generated.ts` is a strict subset of the new
   contract's ABI (checked: all 66 items match, none missing), so no code change is needed. The full ABI of the
   standalone contract (including the extra admin functions) is exported as `fluxoraPaymentsStandaloneAbi` and in
   `contracts/standalone/FluxoraPaymentsStandalone.abi.json`.
4. **Wallet connection:** the contract is called through the wallet the user already connected (MetaMask or WalletConnect)
   on Arc Mainnet; the Pay page reads the contract with the app's RPC and sends `pay`, `createRequest`, `payRequest`
   and `cancelRequest` through the connected wallet after the user confirms. The frontend gates every send with the
   same wallet and chain checks as Send.
5. **Domain:** the contract does not depend on any domain. When you add your own domain later, change nothing in the
   contract. Redeploy the frontend, add the domain to your WalletConnect project's allowed domains, and (if you use
   your own RPC with an allowlist) to that allowlist. Payment links are built from the page's own address, so they use
   the new domain automatically (old links keep the old domain).

## Who can do what (admin = your deploying wallet)

- **Everyone:** pay, create a payment request, pay a request (not their own), cancel their own request, read history.
- **Admin:** allow or remove payment tokens, set the fee (hard cap 1%, charged on top of the payment) and fee
  recipient, grant or revoke the pauser role, start an admin handover, change the handover delay (1 to 30 days).
- **Pauser (you at first):** pause or unpause new payments and new requests. Cancelling a request always works.
- **Nobody** can move users' tokens, mint, upgrade the contract, or call an arbitrary address. The contract never holds
  user funds: payments go straight from payer to recipient (and fee recipient).
- **Admin handover:** `beginDefaultAdminTransfer(newAdmin)`, wait the delay, then the new admin calls
  `acceptDefaultAdminTransfer()`. The admin role cannot be renounced or sent to the zero address, so the contract
  always has an admin. The pauser role moves with the admin; extra pausers you granted stay until you revoke them.
- **Use a hardware wallet or a multisig** as the deployer if you can: whoever holds the admin key can change the fee
  (max 1%), allow tokens, and pause payments.

## Verify the source on the explorer

Whether `explorer.arc.io` accepts source verification is not confirmed by Arc's documentation. If the contract page
has "Verify & Publish":
- method: Solidity (single file), upload the flattened file generated from `contracts/src/FluxoraPaymentsStandalone.sol`
- compiler `0.8.28`, EVM version `cancun`, optimization yes, 200 runs, license MIT
- contract name `FluxoraPaymentsStandalone`
- constructor arguments: the hex string above
Remix's "Contract Verification" plugin can also submit to Etherscan-compatible or Sourcify services if Arc supports
them. If verification is not available, publish the file and its SHA-256 so others can compare the deployed bytecode.

## What was checked, and what was not

Checked: 133 Foundry tests for this contract pass (payments, requests, fees, pausing, the admin rules, ABI compatibility
with the frontend, fuzz tests, and "the contract never holds tokens" invariants). Together with the other contracts, the
suite is 341 tests. Static analysis (Slither) shows only timestamp-comparison notes, which are the intended request
expiry checks. Three review rounds by an AI security reviewer and a functional reviewer found issues that were fixed
(pauser role left behind after a handover, the admin being burnable, unbounded delay changes, documentation gaps).
The one-file version compiles with the Remix settings above to bytecode identical to the tested build, and a dry
run of the Remix steps on a local fork of Arc Mainnet passed (deployment, role checks, pay, receipt, request, fee,
rejected admin actions).

Not checked / remaining risks:
- **No independent audit.** Do not describe this contract as audited.
- **Real Arc USDC transfers were not exercised.** The local fork cannot execute Arc's native USDC, so token flows were
  tested with a standard 6-decimal token. Make your first real payment a very small one.
- **Allowed tokens must be standard.** Only add tokens that do not rebase and do not charge a fee on transfer.
- **USDC blocklist.** Circle can block addresses. A payment to or from a blocked address reverts. If the fee recipient
  is ever blocked, every payment reverts until the admin calls `setFeeBps(0)` or sets a new recipient.
- **Tokens sent directly to the contract address cannot be recovered** (there is deliberately no rescue function).
- **One admin key.** If it is lost, nobody can change settings (payments keep working); if it is stolen, the attacker
  can change the fee (max 1%), the allowlist and pause payments, but cannot take users' funds.
