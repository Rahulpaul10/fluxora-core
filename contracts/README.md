# FLUXORA smart contracts

Solidity 0.8.28, OpenZeppelin 5.6.1, Foundry. These are FLUXORA's own contracts. **Nothing here is deployed.** There are no
contract addresses in this repository, and the deployment script never runs on its own.

```
contracts/
  src/
    FluxoraToken.sol        FLUX, fixed-supply ERC-20 (burn, permit)
    FluxoraPaymentsStandalone.sol  payments, payment requests, receipts (the payments contract); ABI and Remix steps in standalone/README.md
  test/                     unit, fuzz and invariant tests (+ test/helpers mocks)
  script/DeployFluxora.s.sol  deployment script (token + payments)
  archive/v1/               backups of the retired first payments contract, its tests and the files changed with it (see archive/v1/README.md)
  deployments/              your own record of deployed addresses (empty until you deploy)
  foundry.toml
```

## Contracts

| Contract | What it does |
| --- | --- |
| `FluxoraToken` | 1,000,000,000 FLUX minted once to the initial holder. Burnable and EIP-2612 permit. No mint function, no owner, no voting. |
| `FluxoraPaymentsStandalone` | `pay`, `createRequest`, `payRequest`, `cancelRequest`. Direct transfers from payer to recipient (it never holds funds), per-user receipt and request indexes, token allowlist, optional fee on top capped at 1%, pausable, and a delayed two-step admin transfer. It needs no token, so it can be deployed on its own for the Pay page. |

The deployer becomes the payments admin and pauser. To move admin power to a multisig, call `beginDefaultAdminTransfer(multisig)` and, once the delay has passed, `acceptDefaultAdminTransfer()` from the multisig. The delay is set at deployment (`PAYMENTS_ADMIN_TRANSFER_DELAY`, 1 to 30 days, default 2 days).

## Build and test

From the repository root or from this folder (both have a `foundry.toml`):

```bash
# one time: dependencies
bun install                                 # OpenZeppelin comes from node_modules
forge install foundry-rs/forge-std          # test library, installs into ../lib (root of the repo)

cd contracts
forge build
forge test                                  # unit, fuzz and invariant tests
forge test --match-contract FluxoraPaymentsStandalone  # a subset
```

## Deploy (you do this, from your own wallet)

See [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) for the full walkthrough. In short:

```bash
cast wallet import fluxora-deployer --interactive     # encrypted keystore, never a raw key on the command line

# 1. simulate only (nothing is sent)
forge script script/DeployFluxora.s.sol:DeployFluxora --rpc-url $ARC_RPC_URL --account fluxora-deployer

# 2. broadcast (only after testnet rehearsal, an independent audit, and a careful review)
forge script script/DeployFluxora.s.sol:DeployFluxora --rpc-url $ARC_RPC_URL --account fluxora-deployer --broadcast
```

The script accepts only chain ids 5042 (Arc mainnet) and 5042002 (Arc Testnet) and checks that the USDC predeploy reports the
symbol `USDC` with 6 decimals before it deploys anything.

Afterwards, from the repository root:

```bash
bun run deploy:record        # writes contracts/deployments/arc-mainnet.json and prints the .env lines
```

## Verify on the explorer

Use the verification method that the Arc explorer (https://explorer.arc.io) offers on a contract's page. The inputs are always
the same. Generate the Standard JSON input for a contract, then submit it with the compiler settings from `foundry.toml`
(solc 0.8.28, optimizer on with 200 runs, EVM `cancun`):

```bash
forge verify-contract --show-standard-json-input <DEPLOYED_ADDRESS> src/FluxoraToken.sol:FluxoraToken > token.standard-json.json
```

Constructor arguments (ABI encoded) for each contract:

```bash
cast abi-encode "constructor(address)" <INITIAL_HOLDER>                                   # FluxoraToken
```

Payments takes addresses printed by the deployment script; read the exact values from
`broadcast/DeployFluxora.s.sol/<chainId>/run-latest.json` (`arguments` for each transaction). If the explorer supports
`forge verify-contract` with a verifier URL, use `--verifier` and `--verifier-url` from the explorer's own documentation.

## Safety notes

- Mainnet transactions are real and irreversible. Rehearse on Arc Testnet, get an independent audit, and review every parameter.
- Never commit private keys, seed phrases or keystore passwords. `.gitignore` already excludes `.env*` and `broadcast/`.
- Arc specifics: gas is USDC, `maxFeePerGas` has a 20 gwei floor, USDC blocklisting can make a transfer revert, and blocks arrive about every half second, so all timing in these contracts uses `block.timestamp`.
