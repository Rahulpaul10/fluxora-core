# Archive v1: backups, not compiled

These `.bak` files are exact copies of what existed before FluxoraPayments was retired in favour of
FluxoraPaymentsStandalone (the one payments contract). Foundry ignores them (no `.sol` extension), so they cannot
affect builds, tests or deployments. `SHA256SUMS` lets you check they are unchanged.

| Backup | Original location |
| --- | --- |
| `FluxoraPayments.sol.bak` | `contracts/src/FluxoraPayments.sol` (retired) |
| `FluxoraPayments.flat.sol.bak` | `contracts/remix/FluxoraPayments.flat.sol` (retired) |
| `FluxoraPayments.{Admin,Base,Invariant,Pay}.t.sol.bak` | `contracts/test/` (retired with the contract) |
| `DeployFluxora.s.sol.bak`, `DeployFluxora*.t.sol.bak` | `contracts/script/`, `contracts/test/` (rewritten for the new contract) |
| `FluxoraPaymentsStandalone.Abi.t.sol.bak` | `contracts/test/` (was a side-by-side test against the retired contract; now checks golden values) |
| `gen-abis.ts.bak`, `broadcast-to-env.ts.bak` | `scripts/` (updated) |

To bring the old contract back: copy `FluxoraPayments.sol.bak` to `contracts/src/FluxoraPayments.sol` (and the tests
you want to `contracts/test/`), and add `FluxoraPayments` back to `scripts/gen-abis.ts`.

Why it was safe to retire: the app calls only functions that FluxoraPaymentsStandalone also has with identical
selectors, event topics, errors, enum values and struct layouts, and a recorded run of the old contract produced
byte-identical view and revert data (`FluxoraPaymentsStandalone.Abi.t.sol`). Every behavioural test of the old
contract has an equivalent in the Standalone tests.
