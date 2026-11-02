# FLUXORA

> Built with Arc Studio - money-powered apps in minutes

Project memory for future agents. FLUXORA is a DeFi wallet on Arc mainnet (chain 5042). Tagline: One Wallet. Every Possibility.

## Rules that must hold

- Real data only: balances, quotes, history and transaction status come from the chain or Circle/Uniswap. Never simulate.
- Never invent contract addresses. FLUXORA contract addresses come only from `VITE_FLUXORA_*_ADDRESS` in the environment. Unset shows "Contract Not Deployed" (`NotDeployed` in `components/Gate.tsx`).
- No hardcoded domains or localhost URLs. Wallet metadata and share links use the page origin. RPC/explorer come from `src/config/networks.ts`.
- Design: palette Electric Purple #8257FF, Neon Cyan #27D9FF, Vibrant Pink #FF55B8, Emerald #20D6A0, Navy #090D1C, Card #141A2E. Each page sets `data-theme` (see `index.css`), so buttons, fields and titles pick up per-page colors.
- Arc mainnet moves real funds. Arc Studio does not deploy to or sign on mainnet; the user deploys with `contracts/script/DeployFluxora.s.sol`.
- USDC on Arc is one pool shown through its 6-decimal ERC-20 view. Use `@/onchain-money` for conversions. Gas is USDC, with a 20 gwei maxFeePerGas floor (`src/lib/fees.ts`).
- Arc logs every USDC Transfer from the system emitter (18 decimals) and again from the USDC contract. History reads only the emitter for USDC.
- The public RPC rejects wide getLogs ranges; scan in small windows with halving fallback (`src/hooks/useOnchainTransfers.ts`).
- Links users share must use `buildShareLink` from `src/lib/share.ts`. No secrets in paths or queries.

## Layout

- `contracts/src/` Solidity (FluxoraToken, FluxoraPaymentsStandalone). `contracts/archive/v1/` holds backups of the retired first payments contract and the files changed with it. `contracts/test/` tests (+ helpers). `contracts/script/DeployFluxora.s.sol` deploy script. `contracts/deployments/` records written by `bun run deploy:record`. `contracts/foundry.toml` standalone config; root `foundry.toml` points at the same folders.
- `src/config/` centralized config: `networks.ts` (chains, RPC overrides via env, retry/failover, explorer links), `wallet.ts` (wagmi, connectors, query retry), `contracts.ts` (addresses from `VITE_FLUXORA_*_ADDRESS`, ABIs), `abis.generated.ts` (run `forge build && bun run gen:abis`).
- `src/lib/` tokens, Uniswap routing (`uniswap-arc.ts`), fees, activity log, payments helpers, theme (per-page colors).
- `src/hooks/` balances, prices, on-chain transfers, history, payments.
- `src/pages/` Dashboard, Send, Receive, Swap, Bridge, Pay, History. `src/components/` shared UI; `src/components/Logo.tsx` holds the FLUXORA marks (symbol, wordmark, lockup, loaders).
- `docs/` DEPLOYMENT, CONFIGURATION, GITHUB, HOSTING guides.

## Status

- Contracts: written, reviewed three rounds, tested. Not deployed (no addresses yet).
- Performance: pages are lazy chunks listed once in `src/lib/viewLoaders.ts` and prefetched on idle and on nav hover/touch. The Circle bridge kit loads on demand through `src/lib/bridgeKit.ts` (never import it at module level). `App.tsx` keeps always-on services (wallet warmup, pending reconciler) outside the keyed page wrapper, so navigation does not restart them. Dashboard charts are a separate chunk (`DashboardCharts.tsx`). Do not add `placeholderData` to queries keyed by wallet address.
- Swap uses Uniswap Universal Router 2.1.2 on Arc through Permit2. Bridge uses Circle App Kit (CCTP) with the forwarding service.

## Run

```bash
bun install
bun run dev
bun run check
```
