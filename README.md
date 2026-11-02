# FLUXORA

One Wallet. Every Possibility.

A DeFi wallet for Arc mainnet: send, receive, swap, bridge, and request and receive payments. It comes with its own Solidity contracts (a token and a payments contract). The contracts are written and tested but **not deployed**: you deploy them yourself, then add their addresses to the app's environment.

Built with [Arc Studio](https://studio.arc.io)

## What works today

| Feature | Status |
| --- | --- |
| Wallet connection (MetaMask, WalletConnect with a project id), network switching, RPC status | Live |
| Dashboard: balances, live USDC valuation, allocation and money-flow charts, recent activity | Live, real chain data |
| Send USDC and supported tokens with address and amount validation, preview, wallet signing, receipt tracking | Live |
| Receive: address, QR code, copy and share | Live |
| Swap through Uniswap pools on Arc with live quotes, slippage and minimum received | Live for USDC/EURC, USDC/WETH, USDC/cirBTC and WETH/cirBTC (existing Arc tokens, no FLUXORA token needed). Other pairs say that no pool exists |
| Bridge USDC with Circle CCTP between Arc, Ethereum, Base, Arbitrum, OP, Polygon, Avalanche | Live, quotes from Circle |
| Pay: payment links and QR codes | Live |
| Pay: onchain requests and receipts | Needs your deployment ("Contract Not Deployed" until then) |
| History with search and filters | Live; scans recent Arc blocks, "Load older" goes further back |

Mainnet moves real funds and transactions cannot be reversed. Nothing in this project is simulated or faked.

## Tech stack

React, TypeScript, Vite, Tailwind CSS, wagmi, viem, ConnectKit, Recharts, Circle App Kit, Solidity 0.8.28, OpenZeppelin, Foundry.

## Development

Prerequisites: [Bun](https://bun.sh) and [Foundry](https://book.getfoundry.sh).

```bash
bun install
cp .env.example .env        # fill in what you need; every value is public
bun run dev                 # http://localhost:5173
bun run check               # lint and typecheck
bun run build               # production build into dist/
bun run preview             # serve the production build

bun run setup:contracts     # one time: installs forge-std
forge test                  # contract tests
bun run test:tx             # transaction tracker tests (no network)
bun run test:ui             # renders every page with a read-only test wallet against live Arc RPC
bun run test:wallet         # fake-wallet Send flow, account/network switching, duplicate-click guard
bun run gen:abis            # after changing contracts: refresh the app's ABIs
```

## Environment variables

All public. Full list and meaning in [`.env.example`](.env.example) and [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

- `VITE_WALLETCONNECT_PROJECT_ID` (optional) enables WalletConnect
- `VITE_APP_URL` (optional) public URL shown to wallets; empty uses the page's own origin
- `VITE_ARC_RPC_URL`, `VITE_ARC_EXPLORER_URL`, `VITE_RPC_URL_<chainId>`, `VITE_EXPLORER_URL_<chainId>` (optional) network overrides
- `VITE_FLUXORA_TOKEN_ADDRESS`, `VITE_FLUXORA_PAYMENTS_ADDRESS` set after you deploy
- `VITE_FLUXORA_DEPLOY_BLOCK` (optional)

## Documentation

- [Deploying the contracts](docs/DEPLOYMENT.md)
- [Configuration: network, RPC, wallet, addresses](docs/CONFIGURATION.md)
- [Pushing to GitHub](docs/GITHUB.md)
- [Hosting on Vercel or Netlify and adding your domain](docs/HOSTING.md)
- [Smart contracts](contracts/README.md)

## Security

Never commit private keys, seed phrases, API secrets or deployment credentials. FLUXORA never asks for them: every transaction is signed in your wallet. Get an independent audit before using the contracts with real funds.

## Deploying

Netlify: see `docs/NETLIFY.md`. Vercel and custom domains: see `docs/HOSTING.md`.

## Deploying the contracts by hand

See `docs/REMIX_DEPLOYMENT.md` for the Remix steps with your own wallet, and run `bun run verify:deployment` (read-only) afterwards to check roles and wiring.

Only need the Pay page? Deploy the single payments contract: `docs/PAYMENTS_REMIX_DEPLOYMENT.md` (source: `contracts/src/FluxoraPaymentsStandalone.sol`, flattened for Remix as described there), then check it with `bun run verify:payments`.
