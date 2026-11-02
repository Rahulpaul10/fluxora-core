# FLUXORA final audit (pre-deployment)

Date: 2 November 2026. Scope: the whole repository, Arc mainnet configuration, nothing deployed or pushed.

## Result

Ready to deploy as a wallet front end. The Pay requests and receipts need the payments contract, which is not deployed yet
(see "Before you go live"). Two real mobile layout bugs were found and fixed during the audit.

## Checks that were run

| Check | Result |
| --- | --- |
| `bun run check` (lint + typecheck) | 0 errors, 0 warnings |
| `bun run build` | passes |
| `forge build` | passes (lint notes only, e.g. `block.timestamp` use that is intended) |
| `forge test` | 216 passed, 0 failed (11 suites, includes fuzz and invariant tests) |
| `bun run test:ui` (all routes, with and without a wallet) | all rendered, no console errors |
| `bun run test:wallet` | 43 of 43 |
| `bun run test:connect` | passed |
| `bun run test:tx` | 13 of 13 |
| Real Chromium run, 6 widths (320, 360, 390, 430, 768, 1440) x with/without wallet x 7 routes | 0 console or page errors, no horizontal scroll, no element past the right edge (after the fixes below) |
| Live Swap in Chromium (USDC to EURC, 1 USDC) | live quote shown: about 0.894 EURC, Uniswap v4, 0.00% impact |

The browser run used a simulated MetaMask that announces itself and returns an address. It never signs, so no transaction
was sent from it. Signing flows are covered by `test:wallet` (fake wallet) and were not run against a real wallet.

## Issues found and fixed in this audit

1. Header overflowed the screen on phones when a wallet was connected (confirmed at 320, 360 and 390 px; at 320 px even
   the "Connect wallet" button was cut off). Phones now show the symbol only, a short address and "Connect". The status
   dot hides below 380 px (the same status is in the "More" sheet).
2. Dashboard "USDC money flow" and "Recent transactions" cards were wider than the phone screen, which also pushed the
   bottom navigation out of line. Grid cells can now shrink.
3. Small tap targets: "Show all wallets", the "Max" balance buttons (Send, Swap, Bridge), the connection retry button,
   explorer links, "View all" and the History "Hash" button are now at least 44 px high.

## Secrets

- `.env` is git-ignored and holds only: the WalletConnect project id (public by design), and Arc Studio's own proxy settings.
- The WalletConnect id appears only in `.env` and the built bundle. It is not in any tracked file or in `.env.example`.
- The proxy token is not in the source or in the built bundle. No private keys, seed phrases or API keys were found in tracked
  or untracked files. `.gitignore` covers `.env*`, keystores, `broadcast/`, recovery files and the Studio log files.

## Before you go live (not bugs, but required)

1. Deploy the contracts yourself and set `VITE_FLUXORA_PAYMENTS_ADDRESS` (and `VITE_FLUXORA_TOKEN_ADDRESS` if you want
   FLUX). Until then the Pay page says "Contract Not Deployed" for requests and receipts. Payment links (a link that opens
   Send with the details filled in) and plain Send do not need a contract.
2. Set `VITE_WALLETCONNECT_PROJECT_ID` in your host's environment settings and add the site's domain to the project's
   allowlist at cloud.reown.com. Leave `VITE_APP_URL` empty.
3. Consider a private RPC for heavy use (`VITE_ARC_RPC_URL`); the public endpoint throttles bursts.
4. The contracts have not had an independent audit. Use a multisig as the payments admin.

## Remaining minor items (left alone on purpose)

- Platform helper files that FLUXORA does not use: `scripts/self-deploy.ts`, `scripts/compass-deploy*.ts`,
  `scripts/fetch-abi.ts`, `scripts/measure-tx-latency.ts`, `contracts/script/Create2Factory.sol`,
  `contracts/script/DeployCreate2.s.sol`, `src/onchain-wait.ts`. They are harmless and not in the bundle.
- Three Circle SDK packages are listed in `package.json` but never imported (`@circle-fin/modular-wallets-core`,
  `@circle-fin/user-controlled-wallets`, `@circle-fin/w3s-pw-web-sdk`). They add install time only, not bundle size.
- A few small exported helpers have no callers (for example `isSentinel`, `tokenBySymbol`).
- Two payments contracts exist (`FluxoraPayments`, `FluxoraPaymentsStandalone`). Deploy only the one you need.
- Swap is single-pool only. Pairs with a live pool today: USDC/EURC, USDC/WETH, USDC/cirBTC, WETH/cirBTC. The WETH pools
  are thin, so big trades show a high price-impact warning. Liquidity can change.
- Google Fonts loads from fonts.googleapis.com. There is no Content-Security-Policy header; `public/_headers` sets
  `X-Frame-Options: DENY`, `nosniff` and a referrer policy.
- `vercel.json` builds with `npm run build`. If Vercel does not pick up the Bun lockfile on its first build, set the install
  command to `bun install`.
- The UI smoke test logs one `eth_accounts` "method not supported" message from the public RPC. It comes from the
  test's read-only account, not from the app.
- The WalletConnect relay was not exercised end to end (it needs a phone wallet).
