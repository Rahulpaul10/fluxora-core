# Pushing FLUXORA to GitHub

## Before you push

1. Check that no secret is tracked. `.gitignore` already excludes `.env`, `.env.*` (except `.env.example`), keystores, `broadcast/`, build output and logs.
2. Make sure `.env` holds only public `VITE_` values. A private key, seed phrase, API secret or keystore password must never be in the repository, in `.env.example`, or in any `VITE_` variable.
3. Run the checks:

```bash
bun install
bun run check          # lint and typecheck
bun run build          # production build
forge test             # contract tests (needs: bun run setup:contracts once)
```

## Create the repository and push

```bash
git init
git add .
git status             # read this list: no .env, no keys, no broadcast/ folder
git commit -m "FLUXORA: wallet app and smart contracts"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

Or with the GitHub CLI: `gh repo create <your-repo> --private --source=. --push`.

If you ever commit a secret by mistake, treat it as leaked: rotate it first, then remove it from history.

## After you deploy the contracts

1. `bun run deploy:record` writes `contracts/deployments/arc-mainnet.json` (public addresses only, safe to commit).
2. Set the `VITE_FLUXORA_*_ADDRESS` variables where the app is built (your `.env` locally, your host's settings in production). See [CONFIGURATION.md](CONFIGURATION.md).
3. Push the deployment record: `git add contracts/deployments && git commit -m "Record deployment" && git push`.

## Repository layout

```
src/                 React app (config/ holds networks, wallet and contract addresses)
contracts/           Solidity (src, test, script, deployments) with its own foundry.toml
docs/                Deployment, configuration, hosting and GitHub guides
scripts/             ABI generator and deployment recorder
.env.example         Every environment variable, documented
vercel.json, netlify.toml   Hosting configuration
```

After changing a contract, rebuild and regenerate the app's ABIs: `forge build && bun run gen:abis`.
