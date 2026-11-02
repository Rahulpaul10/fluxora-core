# Deploying the FLUXORA contracts

> Prefer deploying by hand from Remix with your own wallet? Follow `docs/REMIX_DEPLOYMENT.md` (self-contained sources in `contracts/remix/`). The Foundry steps below do the same thing in one script.


You deploy these contracts yourself, from your own wallet. Arc Studio does not deploy to, sign for, or fund anything on mainnet,
and this repository contains no deployed addresses. Deployments are irreversible and move real funds. Do the whole process on
Arc Testnet first (chain id 5042002), get an independent professional audit, and review every address and parameter before you
broadcast on mainnet (chain id 5042).

## What gets deployed

| Contract | File | Role |
| --- | --- | --- |
| `FluxoraToken` | `contracts/src/FluxoraToken.sol` | FLUX, fixed supply of 1,000,000,000, burn, permit. No mint, no owner. |
| `FluxoraPaymentsStandalone` | `contracts/src/FluxoraPaymentsStandalone.sol` | Payments, payment requests, receipts. Never holds user funds. Optional fee, capped at 1%. Delayed two-step admin transfer. |

`contracts/script/DeployFluxora.s.sol` deploys both in order and confirms the payments roles. It only runs on chain 5042 or
5042002, and it checks that the USDC predeploy reports `USDC` with 6 decimals.

## 1. Prerequisites

- Foundry (`forge`, `cast`). Arc Foundry is recommended: https://docs.arc.io/arc/tutorials/install-arc-foundry.md
- Dependencies: `bun install` and `bun run setup:contracts` (installs forge-std without git submodules).
- A funded deployer wallet on Arc. Gas is paid in USDC.
- A hardware wallet or an encrypted Foundry keystore. **Never pass a private key on the command line or put one in a file.**

```bash
cast wallet import fluxora-deployer --interactive      # prompts for the key and a password; stored encrypted
```

## 2. Configure the run

Find the Arc RPC URL in `src/config/networks.ts` (it comes from the built-in registry) or in the Arc docs, then:

```bash
export ARC_RPC_URL=<Arc RPC URL>

# Optional overrides (defaults in brackets)
export FLUX_INITIAL_HOLDER=<address that receives the 1B FLUX>        # [the deployer]
export PAYMENTS_ADMIN_TRANSFER_DELAY=<seconds, 86400 to 2592000>        # [172800 = 2 days] wait before an admin handover can finish
```

The deployer becomes the Payments admin and pauser (the contract uses its deployer). To hand admin power to a multisig, call
`beginDefaultAdminTransfer(<multisig>)` after deploying, then `acceptDefaultAdminTransfer()` from the multisig once the delay has passed.

The script checks these values before it sends anything and reverts with a named error if one is unsafe (a zero holder address, or a delay outside 1 to 30 days). After deploying, it confirms the admin and pauser roles on Payments, so a half-wired
deployment reverts.

## 3. Test and rehearse

```bash
forge build
forge test                                      # run all contract tests

# Simulation only: no --broadcast, nothing is sent
forge script contracts/script/DeployFluxora.s.sol:DeployFluxora --rpc-url $ARC_RPC_URL --account fluxora-deployer
```

Read the printed addresses and role table. Confirm the admin and pauser are the addresses you intended.

## 4. Broadcast (only when you are ready)

```bash
forge script contracts/script/DeployFluxora.s.sol:DeployFluxora --rpc-url $ARC_RPC_URL --account fluxora-deployer --broadcast
```

Arc enforces a minimum `maxFeePerGas` of 20 gwei. If a transaction is rejected as underpriced, retry with a gas price of at
least 20 gwei.

## 5. Record the addresses and connect the app

```bash
bun run deploy:record            # reads broadcast/DeployFluxora.s.sol/5042/run-latest.json
```

It writes `contracts/deployments/arc-mainnet.json` and prints the variables to set. Add them to your local `.env` and to your
hosting provider's environment settings (see [CONFIGURATION.md](CONFIGURATION.md)):

```
VITE_FLUXORA_TOKEN_ADDRESS=
VITE_FLUXORA_PAYMENTS_ADDRESS=
VITE_FLUXORA_DEPLOY_BLOCK=        # optional
```

Restart the dev server (Vite reads `.env` at startup) or redeploy the site. Until a variable is set, the matching feature shows
"Contract Not Deployed".

## 6. Verify the contracts

See "Verify on the explorer" in [`contracts/README.md`](../contracts/README.md). In short: generate the Standard JSON input with
`forge verify-contract --show-standard-json-input`, then submit it on the contract's page at the Arc explorer with the compiler
settings from `contracts/foundry.toml` (solc 0.8.28, optimizer 200 runs, EVM `cancun`).

## 7. After deployment

1. **Enable more payment tokens.** Payments accepts USDC and FLUX. The admin adds a token by calling `setTokenSupported`. Only add standard, non-rebasing tokens.
2. **Hand over the admin role carefully.** If the admin is your deployer wallet, move it to a multisig when you are ready with `beginDefaultAdminTransfer` / `acceptDefaultAdminTransfer` (the pauser role follows the admin).
3. **Check the result.** `bun run verify:deployment --admin=<your admin>` is read-only and sends nothing.
