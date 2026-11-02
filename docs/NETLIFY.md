# Deploy FLUXORA to Netlify

Everything the build needs is committed: `netlify.toml` (build command, publish folder, single-page routing, headers,
public token addresses) and `bun.lock` (exact dependency versions). No local `.env` file is needed.

## What the build does

- Installs with the same locked versions used in development: `npx bun@1.3.14 install --frozen-lockfile`.
  (`npm install` cannot be used: one dependency declares an older Vite peer range and npm refuses to resolve it.)
- Builds with `vite build` into `dist/`.
- Serves `index.html` for every route (`/send`, `/swap`, `/pay?request=1`), while real files keep being served as files.
- Studio preview tooling (request tracing, console capture) is **not** loaded outside the Arc Studio preview frame, so it
  does not touch `fetch` or your wallet provider on the live site.

## Environment variables

All are public (they are compiled into the page). Never put a private key or secret in a `VITE_` variable.
Set them in Netlify under Site configuration > Environment variables, then trigger a new deploy (values are read at build time).

| Variable | Needed | Value |
|---|---|---|
| `VITE_WALLETCONNECT_PROJECT_ID` | for WalletConnect | project id from https://cloud.reown.com |
| `VITE_ARC_RPC_URL` | recommended for heavy use | your own Arc RPC (the public one throttles bursts). A URL with a key is visible to every visitor, so use a key restricted to your domain |
| `VITE_ARC_EXPLORER_URL` | no | defaults to the built-in Arc explorer |
| `VITE_FLUXORA_*_ADDRESS`, `VITE_FLUXORA_DEPLOY_BLOCK` | after you deploy the contracts | see `docs/DEPLOYMENT.md` |
| `VITE_APP_URL` | **leave empty** | the app uses the domain that serves it |

Without the FLUXORA contract addresses the app shows "Contract Not Deployed" for Pay requests and receipts. That is expected.
A wrong or missing value shows a "Configuration problem" notice at the top of the app.

## Steps (you do these; nothing is deployed until you say so)

**Option A: from GitHub (recommended)**
1. Push the project to GitHub (`docs/GITHUB.md`).
2. In Netlify: Add new site > Import an existing project > pick the repository. The settings are read from `netlify.toml`
   (build command `npx --yes bun@1.3.14 install --frozen-lockfile && npx --yes bun@1.3.14 run build`, publish directory `dist`).
3. Add `VITE_WALLETCONNECT_PROJECT_ID` (and `VITE_ARC_RPC_URL` if you have one) in the environment variables, then deploy.

**Option B: from Arc Studio**
Open the Integrations menu (or the + menu in the chat), choose Connect Netlify, then ask me to "deploy this" when you are ready.

**Option C: manual upload**
Run `bun run build` locally, then drag the `dist` folder onto Netlify (Sites > Add new site > Deploy manually). SPA routing from
`netlify.toml` is not applied to a manual drag-and-drop of the folder alone, so add the file `dist/_redirects` containing
`/*  /index.html  200` first.

## After the first deploy: allow the new domain

1. **WalletConnect:** in your Reown project, add the site origin (for example `https://your-site.netlify.app`, and later your
   custom domain) to the allowed domains. The connect screen prints the exact origin it uses. Deploy previews get their own
   origin, so add them too if you test previews with WalletConnect.
2. **Your own RPC (if used):** allow the same origin in its dashboard.
3. **Custom domain:** Netlify > Domain management > Add a domain, then repeat step 1 for it. No code change is needed.

## Production checklist (about 5 minutes)

1. Open `https://<site>/send` directly and reload it: the page loads (not a 404).
2. Open `https://<site>/pay?to=0x...&amount=1&token=USDC`: the Pay page loads with the link's values.
3. The top of the app shows no "Configuration problem" notice. The status pill says "Connected" with a block number.
4. Follow `docs/MANUAL_WALLET_TEST.md` with a small amount (this is Arc mainnet).
5. In the browser console you should not see `[studio-trace]` lines.

## Troubleshooting

- **Build fails at install:** make sure the build command is the one in `netlify.toml` and `bun.lock` is committed.
- **Blank page:** open the console. A missing file under `/assets/` means the publish directory is not `dist`.
- **WalletConnect shows an origin error:** the site origin is missing from your Reown project's allowed domains.
- **Slow or failing balances:** the public RPC is rate limited; set `VITE_ARC_RPC_URL`.
