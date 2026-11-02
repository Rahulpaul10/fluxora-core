# FLUXORA Payments - standalone

This folder holds the ABI of `../src/FluxoraPaymentsStandalone.sol`. The single-file Remix copy is no longer stored
here; generate it when needed:

```
forge flatten contracts/src/FluxoraPaymentsStandalone.sol -o FluxoraPaymentsStandalone.flat.sol
```

- Compiler 0.8.28, EVM `cancun`, optimizer on with 200 runs
- Constructor `(uint48 adminTransferDelay, address[] initialTokens)`; the deployer becomes admin and pauser
- ABI: `FluxoraPaymentsStandalone.abi.json`
- Instructions: `../../docs/PAYMENTS_REMIX_DEPLOYMENT.md`

Flatten again after any change to `../src/FluxoraPaymentsStandalone.sol`, and re-run the tests first.
