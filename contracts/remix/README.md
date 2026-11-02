# Remix-ready sources

A self-contained (flattened) copy of `FluxoraToken` from `../src`, with OpenZeppelin 5.6.1 inlined, for pasting
into Remix. It is generated, not hand-edited:

```
forge flatten contracts/src/FluxoraToken.sol -o contracts/remix/FluxoraToken.flat.sol
```

For the payments contract, generate the single file when you need it (it is not stored here):
`forge flatten contracts/src/FluxoraPaymentsStandalone.sol -o FluxoraPaymentsStandalone.flat.sol`.

Compile with Solidity `0.8.28`, EVM `cancun`, optimizer on, 200 runs. Those settings give bytecode identical
to the Foundry build used by the tests. Regenerate these files after every change to `../src`.

Step-by-step deployment: `docs/REMIX_DEPLOYMENT.md`.
