# Deployments

This folder is **empty on purpose**. FLUXORA has not been deployed by this repository, and no address in this project is a
real contract until you deploy it yourself.

After you deploy, run `bun run deploy:record` from the repository root. It reads Foundry's broadcast output and writes
`arc-mainnet.json` (or `arc-testnet.json`) here in this shape:

```json
{
  "chainId": 5042,
  "network": "arc-mainnet",
  "deployBlock": null,
  "contracts": {
    "token": "",
    "payments": ""
  }
}
```

These files contain only public addresses, so they are safe to commit once they hold real values. Put the same addresses in the
frontend environment variables listed in `.env.example`.
