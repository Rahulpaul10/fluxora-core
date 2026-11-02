> Netlify has its own step-by-step guide: **docs/NETLIFY.md** (build command, environment variables, routing, checklist).

# Hosting FLUXORA on Vercel or Netlify, and adding your own domain

FLUXORA is a static single-page app. `bun run build` produces `dist/`. The app contains no hardcoded domain and no localhost
URL: wallet metadata, share links and payment links all use the address of whatever page serves the app, and RPC and explorer
URLs come from `src/config/networks.ts` and environment variables. Changing the domain therefore needs no code change.

## Vercel

1. Push the repository to GitHub ([GITHUB.md](GITHUB.md)).
2. In Vercel choose **Add New, Project**, import the repository. `vercel.json` already sets the build command, the `dist` output folder and the single-page-app rewrite.
3. Under **Settings, Environment Variables** add the variables from `.env.example` that you use (at least the contract addresses once deployed; optionally `VITE_WALLETCONNECT_PROJECT_ID`, `VITE_ARC_RPC_URL`).
4. Deploy. Any later change to an environment variable needs a redeploy because values are baked in at build time.

## Netlify

1. Push to GitHub, then **Add new site, Import an existing project**.
2. `netlify.toml` sets the build command, the `dist` publish folder and the redirect that sends every path to `index.html` (needed for payment links such as `/pay?request=1`).
3. Add the same environment variables under **Site configuration, Environment variables**, then trigger a deploy.

## Connect your own domain

1. Buy or pick a domain at your registrar.
2. **Vercel**: Project, Settings, Domains, Add. **Netlify**: Domain management, Add a domain. Follow the DNS records shown (an `A` record or `CNAME`). HTTPS certificates are issued automatically.
3. Wait for DNS to propagate, then open the site on the new domain.

## After the domain changes: checklist

- **Wallet connection**: injected wallets (MetaMask) work on any HTTPS domain. For WalletConnect, add the new domain to your project's allowed domains at https://cloud.walletconnect.com. Leave `VITE_APP_URL` empty so the app reports its real origin.
- **RPC**: browser requests go straight to the configured RPC. If you use your own `VITE_ARC_RPC_URL` with an allowlist, add the new domain there. The default public endpoint needs no change.
- **Links**: payment links and QR codes are generated from the current origin. Links created on the old domain keep that domain, so recreate any you still need.
- **Contract addresses**: unchanged. They live in the environment, not in the domain.
- **Testing**: connect a wallet, switch to Arc, confirm the header shows "Connected" with a block number, and send a small amount before announcing the site.

## Production build

```bash
bun run build      # outputs dist/
bun run preview    # serve dist/ locally to check it
```

If the build runs out of memory on a small machine, close other programs first or run it with `NODE_OPTIONS=--max-old-space-size=3072`.
