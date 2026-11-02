# Security audit: contracts/Fluxora.sol

Date: 2026-11-02. Compiler: Solidity 0.8.28 (cancun, optimizer 200 runs). OpenZeppelin 5.6.1.
Scope: `contracts/Fluxora.sol` (360 lines when first audited, 469 lines after the fixes), an ERC-20 escrow with optional arbiter, owner-managed token allowlist, fee capped at 1%, pause, two-step ownership.
Out of scope: OpenZeppelin code, the Fluxora app and UI, the other FLUXORA contracts, any deployed state. The first audit changed no source. Revision 2 changed `contracts/Fluxora.sol` and the two security test files only. Nothing was deployed and no transaction was sent.

## Revision 2 (fixes applied)

You approved fixing the three confirmed Medium findings (F-01, F-02, F-03). They are implemented in `contracts/Fluxora.sol` and re-checked. The design is in [`fluxora-fixes-design.md`](fluxora-fixes-design.md). The sections below marked "original audit" describe the contract as it was before the fixes.

### What changed

| Finding | Fix |
| --- | --- |
| F-01 Dispute lock | `dispute` now stores a deadline 14 days out (`ARBITRATION_WINDOW`). The arbiter can resolve any time while the escrow is `Disputed`. After the deadline anyone can call `resolveExpired`: the seller gets half minus a proportional fee, the buyer gets the other half (odd unit to the buyer). Neither party can take all of it. New status `Split`. |
| F-02 Failed payout | Every payout (seller, fee collector, buyer refund, split) tries a direct transfer; if it fails, the amount is credited to that account (`claimable`, `totalPending`) and the escrow still settles. The owner of the credit withdraws it with `claim(token, to)` to any address. |
| F-03 Fairness | `createEscrow` makes a `Pending` escrow. Only the seller can `acceptEscrow` (before the release deadline). The buyer or seller can `cancel` a Pending escrow for a full refund. The arbiter can no longer release or refund a `Funded` escrow (this also removes F-05); it acts only through disputes. A new `releaseOnExpiry` term, visible before the seller accepts, decides who wins when nothing happens by the refund deadline: the buyer can refund (false), or anyone can pay the seller via `releaseExpired` (true). |

### Breaking changes

`createEscrow` has a new `releaseOnExpiry` argument and creates a `Pending` escrow. The `Status` enum has new values (`Pending`, `Split`), so numeric values shifted. The `Escrow` struct gained `disputeDeadline` and `releaseOnExpiry`. The `EscrowCreated` event gained `releaseOnExpiry`. The arbiter lost direct `release` and `refund`. Any frontend or script that uses the old ABI must be updated. Nothing is deployed, so no onchain migration is needed.

### Remaining risks after the fixes

Not fixed, by your scope: F-04 (fee and collector front-run), F-07 (token issuer dependency), F-08 to F-13 (Informational). F-06 (last-second dispute) is now bounded by the 14-day window.

New or changed residual risks to be aware of:

- **Arbiter liveness is part of the accepted terms.** A buyer can name an arbiter who never acts (for example a dead address) and open a dispute just before the refund deadline. After 14 days the escrow splits 50/50. The seller consented by accepting the terms, but a seller who does not check the arbiter can lose half. The same applies in reverse when the seller opens the dispute. Sellers and UIs must show the arbiter and the expiry rule before accepting. (Demonstrated by `test_Residual_DeadArbiter_LastSecondDisputeForcesSplit`.)
- **A deferred payout is the recipient's to claim.** If the contract's own address is blocklisted by the token issuer, payouts accrue as claims but cannot be transferred out until the issuer allows it (`test_Residual_F07_...`).
- **The arbiter still has real power inside a dispute**: it can send the whole amount to either side before the window ends or before the split is executed. Choosing an arbiter is a trust decision.
- **`releaseOnExpiry`** shifts the risk to the buyer when true (the seller can be paid even if the buyer did not release), and to the seller when false. Both are explicit terms.
- **The contract is new, and the fix code is new code.** It has not had an independent human audit.

## Overall risk assessment

**Moderate to low for the issues found, but not proven secure. Get an independent audit before real funds.**

- No Critical or High vulnerabilities that let a third party steal funds were found, before or after the fixes.
- The three confirmed Medium findings are fixed and covered by regression tests. A second automated review of the changed contract returned no new findings; that does not prove there are none.
- Remaining risks are mostly trust and design choices (arbiter, token issuer, fee front-run), listed above.
- This is not a guarantee of security. Passing tests and a clean Slither run show the absence of the specific problems checked, not the absence of problems. The contract has had no independent human audit.

## Overall risk assessment (original audit, before fixes)

**Moderate. Not ready for real funds without addressing the Medium findings and an independent audit.**

- No Critical or High vulnerabilities that let a third party steal funds were found.
- No reentrancy, overflow, unauthorized-transfer or accounting flaw was found, in review or in 83 security tests (80 unit/fuzz/POC plus 3 invariants).
- The real risks were **availability and fairness**: funds could become stuck or settle unfairly through the arbiter, the fee collector, or the one-sided design. These were confirmed by working proof-of-concept tests.

## Summary of findings

| ID | Severity | Status | Title |
| --- | --- | --- | --- |
| F-01 | Medium | **Fixed** (regression tests) | A disputed escrow has no timeout; an inactive arbiter locks funds forever |
| F-02 | Medium | **Fixed** (regression tests) | A fee collector or seller that cannot receive the token blocks release |
| F-03 | Medium | **Fixed** (regression tests) | One-sided design: seller has no consent, buyer picks the arbiter, no seller pull path |
| F-04 | Low | Open (residual test) | Fee and fee recipient can be front-run; buyer cannot set a maximum |
| F-05 | Low | **Fixed** with F-03 | Arbiter can release or refund a Funded escrow without any dispute |
| F-06 | Low | Mitigated | A party can open a dispute in the last second to block the buyer's refund; now ends in a 50/50 split after 14 days |
| F-07 | Low | Potential | Escrowed funds depend on the token issuer (blocklist, pause, upgrade) |
| F-08 | Informational | Confirmed (code, test) | A pending ownership transfer cannot be cancelled with the zero address |
| F-09 | Informational | Confirmed (code) | Anyone can add dust escrows to another account's history |
| F-10 | Informational | Confirmed (code) | Fee rounds down; small escrows can pay no fee |
| F-11 | Informational | Confirmed (Slither) | Timestamp comparisons (4 sites) |
| F-12 | Informational | Confirmed (code) | Parameterless errors give little diagnostic context |
| F-13 | Informational | Confirmed (tooling) | The default Foundry build does not compile this file |

Severity note: the functional review rated F-01 Critical and F-02 High, and the test review rated both Medium. I rate both Medium because no third party can trigger either one for profit, the buyer keeps a recovery path in every case, and the arbiter risk is stated in the contract's own documentation. If you plan to hold large balances or deploy for strangers, treat both as High and fix them first.

Confirmed means shown by a passing test or direct code reading. Potential means it depends on conditions outside this contract.

## Findings (original audit text; line numbers refer to the version before the fixes)

### F-01 Medium (confirmed): a disputed escrow has no timeout

- **Location:** `dispute` (lines 277-284), `resolve` (289-294), `release` (254-259), `refund` (265-272).
- **Description:** Once `dispute` sets the status to `Disputed`, `release` and `refund` revert with `InvalidStatus` for everyone. Only the arbiter can call `resolve`, and there is no deadline and no fallback.
- **Impact:** If the arbiter loses its key, disappears, or refuses to act, the escrowed amount is locked permanently. The buyer's right to a refund after `refundDeadline` is lost as soon as a dispute is opened. Either party can open the dispute.
- **Proof:** `test_POC_DisputedEscrowLockedForeverIfArbiterInactive` warps 10 years; every buyer, seller and arbiter path except `resolve` still reverts.
- **Fix:** Store a dispute deadline when the dispute opens (for example `disputedAt + ARBITRATION_WINDOW`). After it, allow a defined fallback (refund to the buyer, or an even split) callable by either party. Optionally let the owner replace an unresponsive arbiter only on escrows that opted into that.

### F-02 Medium (confirmed): an unusable fee collector or seller blocks release

- **Location:** `_settle` (lines 325-336), collector snapshot in `createEscrow` (line 238), `setFeeRecipient` (180-185).
- **Description:** Release sends the seller's share and the fee in one transaction. If either `safeTransfer` reverts (an issuer-blocklisted address, a token that rejects the recipient), the whole release reverts. The collector is saved at creation, so changing `feeRecipient` later does not help escrows that already exist.
- **Impact:** For affected escrows, `release` and `resolve(id, true)` cannot succeed. The buyer can still recover funds through `refund` (seller, arbiter, or buyer after `refundDeadline`) and `resolve(id, false)`, so funds are not lost, but the seller's payment is blocked. A blocklisted seller can only hurt their own escrow.
- **Proof:** `test_POC_BlocklistedFeeCollectorBricksReleaseForExistingEscrow`, `test_POC_BlocklistedSellerBricksRelease` and their recovery tests.
- **Fix:** Do not let the fee transfer block the seller. For example accrue fees in a `feesOwed[token][collector]` balance and let the collector withdraw, or send the seller's share first and skip the fee when it cannot be delivered. Consider letting the seller nominate a payout address.

### F-03 Medium (confirmed): the design favors the buyer and gives the seller no say

- **Location:** `createEscrow` (212-250), `release` (254-259), `refund` (265-272).
- **Description:** The buyer alone chooses the seller, the arbiter, the deadlines, and whether disputes exist. The seller never accepts the terms. The arbiter is not required to be neutral. After `releaseDeadline` the seller has no way to claim the funds, and the buyer can take everything back at `refundDeadline` even after receiving the goods. With no arbiter, the seller cannot dispute.
- **Impact:** Not a loss to the buyer, but a loss risk and a griefing risk for any seller who relies on the escrow. A buyer can name an arbiter they control, then refund at any time through them (see F-05). Sellers could be misled by a UI that presents this as protection.
- **Proof:** `test_POC_SellerCannotPullFundsAfterReleaseDeadlineIfBuyerSilent`, `test_POC_NoArbiterEscrowDisablesDisputes`.
- **Fix:** Decide the intended trust model and state it clearly in the UI. Options: require seller acceptance (`acceptEscrow`) before the funds are locked or before the arbiter gets power; require the arbiter to be on an owner-approved list or accepted by both parties; add a seller claim path after a delay when no dispute was opened.

### F-04 Low (confirmed): fee and collector front-running

- **Location:** `createEscrow` (lines 237-238), `setFeeBps` (172-176), `setFeeRecipient` (180-185).
- **Description:** The fee and collector are read when `createEscrow` executes. The owner can change them in an earlier transaction in the same block window, and the buyer has no `maxFeeBps` or expected collector argument.
- **Impact:** A buyer can be charged up to the 1% cap instead of the fee they saw, and the fee can be sent to a different collector. The cap and the owner's trust bound the damage. The fee is only taken from the seller's share on release.
- **Proof:** `test_POC_OwnerFeeFrontRunChargesNewFee`, `test_POC_OwnerFeeRecipientFrontRunRedirectsFee`.
- **Fix:** Add `maxFeeBps` (and optionally `expectedFeeRecipient`) parameters to `createEscrow` and revert if the live values differ. Consider a delay on fee changes.

### F-05 Low (confirmed): the arbiter can settle a Funded escrow with no dispute

- **Location:** `release` (line 256) and `refund` (267).
- **Description:** The arbiter is allowed in both functions on a `Funded` escrow. It can pay the seller early or refund the buyer at any time, with no dispute and no waiting period.
- **Impact:** This is a trust assumption rather than a bug, but it widens the arbiter's power beyond "resolve disputes". Combined with F-03, a buyer-chosen arbiter gives the buyer a refund at will.
- **Proof:** `test_POC_ArbiterCanUnilaterallyReleaseFundedEscrowWithoutDispute`, `test_POC_ArbiterCanUnilaterallyRefundFundedEscrowAnytime`.
- **Fix:** If intended, document it. Otherwise limit the arbiter to `resolve` after a dispute.

### F-06 Low (confirmed): last-second dispute blocks the buyer's refund

- **Location:** `dispute` (lines 277-284), check at line 281.
- **Description:** A dispute can be opened up to one second before `refundDeadline`. The seller can do this exactly when the buyer's unilateral refund would become available, which forces the arbiter's involvement and, with F-01, can lock the funds.
- **Impact:** Griefing and delay, bounded by the arbiter's honesty.
- **Proof:** `test_POC_DisputeBoundary_LastSecondBeforeRefundDeadline`.
- **Fix:** Close the dispute window earlier than the buyer's refund time, or fix F-01 so a dispute cannot last forever.

### F-07 Low (potential): dependence on the token issuer

- **Location:** whole contract; assets held by all open escrows.
- **Description:** The contract holds pooled token balances. If the issuer blocklists the contract address, pauses the token, or upgrades it in a harmful way, every open escrow in that token is frozen or changed. The owner admits tokens; the contract only checks exact receipt on funding (`InexactFunding`), so a token that changes behavior later (a rebase, a fee) is not detected.
- **Impact:** Out of the contract's control. Arc's USDC has an issuer blocklist.
- **Fix:** Only allowlist reputable standard tokens, document the risk, and consider per-token deposit caps.

### F-08 Informational (confirmed): the pending owner cannot be cleared with the zero address

- **Location:** `transferOwnership` (lines 189-193).
- **Description:** OpenZeppelin lets the owner cancel a pending transfer with `transferOwnership(address(0))`. This override rejects the zero address, so a cancel is only possible by naming another address (for example the current owner). The ownership tests confirm the zero address reverts.
- **Impact:** Minor. A mistaken pending owner still has to call `acceptOwnership`.
- **Fix:** Allow zero for cancelling, or add a `cancelOwnershipTransfer` function.

### F-09 Informational (confirmed): history spam

- **Location:** `createEscrow` (lines 241-242).
- **Description:** Anyone with an allowlisted token can create a tiny escrow naming any seller, which adds an id to that account's list. The lists are unbounded and paged by `escrowsOf` (100 per page), so there is no on-chain denial of service.
- **Impact:** Noise in an account's history in the UI.
- **Fix:** Add a minimum amount, or have the UI hide unaccepted escrows.

### F-10 Informational (confirmed): fee rounds down

- **Location:** line 237 (`Math.mulDiv(amount, feeBps, 10_000)`).
- **Description:** For small amounts the fee rounds to 0. Splitting a payment into small escrows avoids the fee.
- **Impact:** Minor revenue loss only. The fee never exceeds 1% (fuzzed).
- **Fix:** Round up, or set a minimum fee.

### F-11 Informational (Slither): timestamp comparisons

- **Location:** `createEscrow` (223-224), `release` (257), `refund` (269), `dispute` (281).
- **Description:** Slither's `timestamp` detector flags deadline checks. Block producers can shift timestamps slightly. Deadlines here are days long (grace 7 days), so the effect is negligible.
- **Fix:** None needed.

### F-12 Informational: parameterless errors

- **Location:** `InexactFunding` (line 105), `Unauthorized` (111).
- **Description:** Reported by the rule-based review as Low. These errors carry no context, which makes failures harder to diagnose. No effect on safety.
- **Fix:** Add parameters such as the token and balances, or the caller and id.

### F-13 Informational: the default build does not include this file

- **Location:** `foundry.toml` (`src = "contracts/src"`), `contracts/foundry.toml`.
- **Description:** `contracts/Fluxora.sol` lies outside the configured source folder, so a plain `forge build` does not compile it by itself. It is only built when something imports it (the new tests do) or when built by path. I left the config unchanged as requested.
- **Fix:** Move the source folder, or build explicitly in CI.

## Checks that found no issue

| Area | Result |
| --- | --- |
| Reentrancy | All fund-moving functions use `nonReentrant`; state is written before transfers. A malicious token that re-enters `release`, `refund`, `dispute`, `resolve` and `createEscrow` was blocked in 10 tests. |
| Access control | Only the owner can pause, set fees, the allowlist and the fee recipient. Release, refund, dispute and resolve each check the caller and the status. Ownership is two-step; renouncing is disabled. |
| Unauthorized transfers | Funds move only to the stored buyer, seller or collector. The owner has no path to escrowed funds. No `delegatecall`, no `selfdestruct`, no arbitrary call, no native-currency path (no `receive` or `fallback`). |
| Overflow / underflow | Solidity 0.8.28 checked arithmetic. Fuzzed deadline bounds including `uint256.max`. `release` subtracts `fee` from `amount`, and `fee <= amount / 100` always. |
| Payment accounting | Funding verifies the exact balance increase, which rejects fee-on-transfer and rebasing tokens. Invariant tests show the token balance equals the sum of open escrows. |
| Unsafe external calls | Only `SafeERC20` calls on allowlisted tokens. |
| DoS | No loops over user data in state-changing functions. Paging is bounded at 100. |
| Pause | Blocks only `createEscrow`; settlement continues while paused. |
| Input validation | Zero addresses, self-deals, arbiter overlap, zero amounts, deadline range, fee cap and token code checks all present and tested. |
| Allowlist removal | Removing a token does not block settlement of existing escrows. |

## Tools and tests

### Original audit (before the fixes, 360-line contract)

| Tool | Result |
| --- | --- |
| Slither (direct solc mode) | 4 results, all `timestamp` (F-11). No High or Medium. The Foundry-mode run gave 0 results with AST warnings and was treated as low assurance. |
| Rule-based review / functional review | One Low (F-12); two findings (F-01, F-02). |
| Foundry tests | 83 new tests passed; full suite 239 passed. |

### After the fixes (current 469-line contract)

| Tool | Result |
| --- | --- |
| Compiler | Solc 0.8.28, no warnings. |
| Slither (direct solc mode, 102 detectors) | Ran. 7 results, all Low `timestamp` (one per deadline comparison). No High, Medium, reentrancy or unchecked-transfer findings. Slither in project (Foundry) mode was not repeated because it gave unreliable AST output last time. |
| Rule-based review (balanced) | Ran. No material findings. |
| Functional / adversary review (balanced) | Ran. No material findings. These reviews are automated and source-based, so they are not proof that no issue exists. |
| Foundry tests, security file | **129 passed, 0 failed** (124 unit, fuzz and regression tests, plus 5 invariants at 256 runs x 500 calls). |
| Foundry tests, full project | **285 passed, 0 failed** across 15 suites. |
| Echidna, Mythril, formal verification | Not available or not run. |
| Independent human audit | **Not done.** Required before real funds. |

Test files (both edited in this revision; no other existing file was changed):

- `contracts/test/Fluxora.Security.t.sol`
- `contracts/test/helpers/FluxoraSecurityMocks.sol`

Run them with `forge test --match-path contracts/test/Fluxora.Security.t.sol`.

All `test_POC_*` tests were rewritten. They now assert the safe behavior:

- **F-01:** `test_Fixed_F01_*` (split not available before the window ends, anyone splits after it, neither party can take all, not locked after ten years, arbiter can still resolve, no double settlement, odd amounts, and a fuzz test that seller amount + fee + buyer amount equals the escrow).
- **F-02:** `test_Fixed_F02_*` and `test_Claim_*` (a blocked fee collector, seller or buyer no longer blocks release, resolve, refund, cancel or the timeout split; credits and `claim` behave correctly; a fuzz test over all blocklist combinations; an accounting invariant that the contract balance covers open escrows plus pending claims).
- **F-03:** `test_Fixed_F03_*` and `test_Regression_F03_*` (a Pending escrow cannot be settled; only the seller accepts; cancel by either party; the arbiter cannot release or refund; both `releaseOnExpiry` rules; terms and fee snapshot are immutable).
- **Residual risks:** `test_Residual_*` tests pass by demonstrating F-04, the dead-arbiter split, F-07 and F-08. They are expected to keep passing until those risks are addressed.

## Recommended next steps

1. Update the frontend and ABIs for the new `createEscrow` signature and the accept step before any use.
2. Decide whether to add a `maxFeeBps` argument to `createEscrow` (F-04) and show the arbiter and expiry rule prominently to sellers.
3. Consider letting the buyer or seller replace an inactive arbiter by mutual agreement, to avoid the 50/50 split in the dead-arbiter case.
4. Get an independent audit before deploying with real funds. This contract has not been deployed, and nothing in this report claims it is secure.
