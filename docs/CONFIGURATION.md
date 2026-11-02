# Configuration: network, RPC, wallet and contract addresses

All frontend configuration lives in three files and a set of environment variables. Nothing is hardcoded in components.

| File | Purpose |
| --- | --- |
| `src/config/networks.ts` | Networks, chain ids, RPC URLs, explorer URLs, RPC retry and failover |
| `src/config/wallet.ts` | wagmi setup, MetaMask and WalletConnect, query retry policy |
| `src/config/contracts.ts` | FLUXORA contract addresses (from the environment) and their ABIs |

## Environment variables

Copy `.env.example` to `.env`. Every variable is public (`VITE_` values ship to the browser). Never put a private key, seed
phrase or API secret in any of them.

| Variable | Required | Meaning |
| --- | --- | --- |
| `VITE_WALLETCONNECT_PROJECT_ID` | no | Enables WalletConnect. Free project id from https://cloud.reown.com (formerly WalletConnect Cloud). 32 hex characters |
| `VITE_APP_URL` | no | URL wallets see. Leave empty to use the page's own origin (recommended) |
| `VITE_ARC_RPC_URL` | no | Override the Arc mainnet RPC (for example a private or paid endpoint) |
| `VITE_ARC_EXPLORER_URL` | no | Override the Arc explorer base URL |
| `VITE_RPC_URL_<chainId>` | no | Override the RPC for any other configured network, e.g. `VITE_RPC_URL_8453` |
| `VITE_EXPLORER_URL_<chainId>` | no | Override the explorer for any other network |
| `VITE_FLUXORA_TOKEN_ADDRESS` | after you deploy | FLUXORA token |
| `VITE_FLUXORA_PAYMENTS_ADDRESS` | after you deploy | FLUXORA Payments |
| `VITE_FLUXORA_DEPLOY_BLOCK` | no | Block of the deployment |

Vite reads `.env` only at startup: restart `bun run dev` after editing it. On Vercel or Netlify, set the same names in the
project's environment settings and redeploy, because values are baked in at build time.

## Network and RPC

The home network is Arc mainnet: chain id 5042, native gas USDC (18-decimal native view, 6-decimal ERC-20 view), explorer
https://explorer.arc.io. Defaults come from the built-in onchain registry. The RPC layer adds:

- **Overrides**: set `VITE_ARC_RPC_URL` to use your own endpoint. It is tried first and the registry default stays as a fallback.
- **Retries**: each request retries up to 3 times with backoff and a 12 second timeout. Read queries retry up to 3 times, but never after the user rejects a wallet prompt.
- **Failover**: with more than one URL configured, a stuck endpoint hands over to the next.
- **Status**: the header and sidebar show Connected / Slow / Unreachable with block height and latency, and a retry button.
- **Validation**: the app detects the wallet's network. On an unsupported or non-Arc network, transaction pages tell you and offer "Switch to Arc"; nothing is sent until you switch.

To add a network later, add its viem chain to `NETWORKS` in `src/config/networks.ts` and to the chain tuple and transports in
`src/config/wallet.ts`. Features that need liquidity or contracts (Send, Swap, Pay) stay on the home network; other
networks appear in the selector as bridge endpoints.

## Contract addresses

Set the `VITE_FLUXORA_TOKEN_ADDRESS` and `VITE_FLUXORA_PAYMENTS_ADDRESS` variables after you deploy (see [DEPLOYMENT.md](DEPLOYMENT.md)). Invalid or empty values
are treated as not configured. The app then:

- shows **Contract Not Deployed** (with the variable name) on the payment-receipt and request tools,
- marks the contract as not deployed on the Dashboard,
- never uses a placeholder address and never fakes data.

Payments with a plain transfer (Send) and everything on Swap and Bridge work without any FLUXORA contract.

## Swap and Bridge scope

- **Swap** uses Uniswap v3/v4 pools on Arc through the Universal Router. It needs real liquidity: pairs with no live pool say so. Swappable tokens are USDC, EURC, WETH and cirBTC (fixed, verified Arc addresses in `src/lib/tokens.ts`, no environment variables). The pairs that had live pools when last checked are USDC/EURC, USDC/WETH, USDC/cirBTC and WETH/cirBTC; EURC has no pool with WETH or cirBTC. FLUX joins the list only if you deploy your own token.
- **Bridge** uses Circle CCTP (App Kit) between Arc, Ethereum, Base, Arbitrum One, OP Mainnet, Polygon and Avalanche. Routes, fees and timing come from Circle's live quote.


## Wallet connection and pending transactions: troubleshooting

**MetaMask**
- FLUXORA connects to the wallet that announces itself to the browser (EIP-6963), so MetaMask is used even when
  other extensions are installed. If your browser shows a popup asking which wallet to use, pick the wallet there.
- If you see "already has a request open", open the wallet extension and approve or reject the waiting request.
- The app checks your wallet's live network (chain 5042) and the RPC's chain before every transaction. A wrong
  network or a wrong RPC stops the transaction before anything is signed.

**WalletConnect**
1. Create a project at https://cloud.reown.com (formerly WalletConnect Cloud) and copy its project id.
2. Set `VITE_WALLETCONNECT_PROJECT_ID` in `.env` (local) or in your host's environment settings, then restart or rebuild.
3. In the project's allowed domains, add the exact origin of every place you run the app (the connect screen prints it):
   your Vercel/Netlify URL, your custom domain, and `localhost` for local work. Wallets reject unlisted origins.
4. Leave `VITE_APP_URL` empty unless you know you need it: it must equal the page's real origin.

**A transaction stays "Pending"**
- Pending always means "no receipt on the chain yet". After 45 seconds the app explains why (queued behind an
  earlier transaction from your wallet, RPC not answering, or the network not knowing the hash).
- Never send the same transaction again while it is pending. Use "Check again" or the explorer link.
- A hash the network has never recorded for 30 minutes is shown as "Not found" in History instead of "Pending".
- `bun run test:tx` runs the tracker tests. `bun run test:tx live-init` and `bun run test:tx live` do a real
  transfer on Arc Testnet with a throwaway key (fund the printed address from the faucet in between).

## Connecting a wallet

- **MetaMask in a desktop browser:** detected automatically (the extension announces itself, also if it loads after the page). One click connects.
- **MetaMask on a phone:** phone browsers have no extensions. The MetaMask tile then says "Open in the MetaMask app" and opens this exact page inside MetaMask's own browser (`https://metamask.app.link/dapp/<your-domain>/...`, built from the current address, never a hardcoded domain). Inside the MetaMask app browser the wallet is detected like on desktop.
- **WalletConnect (any mobile wallet, QR code on desktop):** needs your own project id.
  1. Create a free project at https://cloud.reown.com and copy the Project ID (32 hexadecimal characters).
  2. Put it in `.env` as `VITE_WALLETCONNECT_PROJECT_ID=<your id>`, then restart the dev server. On Netlify or Vercel add it under Environment variables and redeploy (it is read at build time).
  3. In the Reown project, add every domain that serves the app to the allowed domains: the Arc Studio preview address, your `*.netlify.app` address and your own domain later. The connect screen prints the exact origin to allow.
  Without a project id the tile says "Needs a project id" and nothing is faked. A malformed id raises a "Configuration problem" notice.
- Test it: `bun run test:connect` (and `WC=1 bun run test:connect` for the configured-WalletConnect screen). These use a fake EIP-1193 provider, so they prove FLUXORA's code, not a real wallet or the WalletConnect relay.
