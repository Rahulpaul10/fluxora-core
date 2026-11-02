# Fluxora.sol: design for the three Medium fixes (F-01, F-02, F-03)

Status: proposed before implementation. Nothing here is deployed. Fluxora.sol has no deployed instance, so no onchain migration is needed, but the ABI changes (listed at the end).

## Fix 1: dispute lock (F-01)

Problem: a disputed escrow can only be settled by the arbiter, with no deadline.

Design:
- When `dispute` is called, store `disputeDeadline = now + ARBITRATION_WINDOW` (14 days, constant).
- The arbiter can still call `resolve(id, toSeller)` at any time while the escrow is `Disputed`, including after the window, until someone settles it.
- New `resolveExpired(id)`: callable by anyone once `disputeDeadline` has passed. It splits the escrow 50/50: the seller gets half (minus the proportional fee), the buyer gets the other half. The odd base unit goes to the buyer.
- Neither party can take the whole amount alone: the buyer cannot refund himself, the seller cannot release to himself, and a split gives each side half, so waiting out an inactive arbiter is never a way to win.
- No new trust: the outcome is fixed by the contract and fully visible when the dispute opens. Anyone can trigger it, so no key is needed.
- A new terminal status `Split` records this outcome.

## Fix 2: failed payout (F-02)

Problem: seller share and fee were pushed in one transaction, so one failing transfer reverted the whole release.

Design (push first, pull as fallback):
- Every payout (seller, fee collector, buyer refund) goes through one internal function. It tries a direct transfer with `SafeERC20.trySafeTransfer` (bounded return data, no revert on failure).
- If the transfer fails (for example the issuer blocklisted the recipient), the amount is credited to `claimable[token][account]` and `totalPending[token]` instead, and the escrow still settles. A `PayoutDeferred` event is emitted.
- New `claim(token, to)`: the account owner withdraws its credit to any address `to` (so a blocklisted account can pick another address). State is cleared before the transfer, and the function is `nonReentrant`.
- Normal case is unchanged: one transaction, funds arrive immediately. Only a failed payout needs a second transaction (`claim`).
- Because the fee is no longer able to block the seller, an unusable fee collector can only delay the collector's own fee.
- No new trust. Credits can only be withdrawn by the account they belong to. The owner has no access to them.

## Fix 3: escrow fairness (F-03, and F-05 which is the same root cause)

Problems: the seller never agreed to the terms, the buyer alone picked the arbiter, the arbiter could refund or release without any dispute, and without an arbiter the buyer could always take the money back after the deadline.

Design:
- `createEscrow` now creates a `Pending` escrow. The buyer's funds are locked in the contract, but nothing is promised yet.
- New `acceptEscrow(id)`: only the seller, only while `Pending` and before `releaseDeadline`. It moves the escrow to `Funded`. By accepting, the seller consents to the exact on-chain terms: arbiter, deadlines, fee, expiry rule.
- New `cancel(id)`: while `Pending`, either the buyer (withdraw the offer) or the seller (reject it) can cancel, and the buyer is refunded in full. So funds are never stuck waiting for acceptance.
- Arbiter powers are limited to resolving a dispute. The arbiter can no longer call `release` or `refund` on a `Funded` escrow. The seller sees and accepts the arbiter before it has any power.
- Explicit expiry rule, chosen by the buyer and visible to the seller before accepting: new parameter `releaseOnExpiry`.
  - `false` (previous behavior): if nothing happened by `refundDeadline`, the buyer can refund.
  - `true`: after `refundDeadline` anyone can call new `releaseExpired(id)` and the seller is paid. The buyer can no longer reclaim after the deadline.
  - Either way the seller knowingly accepted it, so neither side is surprised.
- Everything else is kept: seller can refund at any time, buyer releases before the release deadline, disputes need an arbiter and are allowed before `refundDeadline`.
- No new trust: acceptance is by the seller's own address, and the new rules only add constraints.

## Breaking changes

| Change | Effect |
| --- | --- |
| `createEscrow` gains a `releaseOnExpiry` argument | Callers and the ABI must be updated |
| `createEscrow` makes a `Pending` escrow; funds are not final until `acceptEscrow` | Frontends need an accept step |
| `Status` enum gains `Pending` and `Split` (numeric values shift) | Decoders must be regenerated |
| `Escrow` struct gains `disputeDeadline` and `releaseOnExpiry` | `getEscrow` output changes |
| Arbiter can no longer `release` or `refund` a `Funded` escrow | Removes F-05; arbiters act only through disputes |
| New functions `acceptEscrow`, `cancel`, `releaseExpired`, `resolveExpired`, `claim`, `claimable`, `totalPending`; new events | Additive |
| `release` and `refund` behaviors otherwise unchanged | Existing tests updated, not removed |

## Out of scope (still open after these fixes)

F-04 fee front-running, F-06 last-second dispute (now bounded by the 14-day window), F-07 token issuer dependency, and the Informational items. The contract still has no independent audit.
