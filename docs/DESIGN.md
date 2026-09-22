# SealedBid — contract design

This document explains the contract's data model, the invariants it maintains,
the threats it defends against, and the limitations that are known and
deliberate.

## 1. Data model

### Public ledger state

| Field | Type | Meaning |
| --- | --- | --- |
| `phase` | `AuctionPhase` | `Uninitialized → Bidding → Reveal → Settled`, or `→ Cancelled` |
| `auctioneer` | `AuctioneerKey` (32 bytes) | Derived identity of the buyer; set by the constructor |
| `lotHash` | `Bytes<32>` | Digest of the published lot document |
| `reservePrice` | `Uint<64>` | Maximum acceptable price |
| `bidDeadline` | `Uint<64>` | Unix seconds after which sealing is refused |
| `revealDeadline` | `Uint<64>` | Unix seconds after which opening is refused |
| `bidCount` | `Counter` | Distinct suppliers that have sealed a bid |
| `requiredBidders` | `Uint<64>` | Distinct suppliers required before a result may be awarded |
| `commitments` | `Map<BidderKey, Commitment>` | The sealed bids: 32-byte digests only |
| `lowestBid` | `Uint<64>` | Running lowest opened price |
| `winner` | `BidderKey` | Supplier currently holding the lowest opened price |
| `hasWinner` | `Boolean` | Whether any bid has been opened |

### Private state

Only one value is read by the circuit:

```ts
type SealedBidPrivateState = { identitySecret: Uint8Array /* 32 bytes */ };
```

The CLI extends this with a list of sealed bids `(amount, nonce, openedAt)` so a
supplier can open their bid later. The circuit never reads that list; it lives in
the same encrypted blob so nonces are encrypted at rest.

### Identity derivation

```
bidderKey     = persistentHash<KeyPreimage>({ tag: 1, secret })
auctioneerKey = persistentHash<KeyPreimage>({ tag: 2, secret })
commitment    = persistentHash<CommitmentPreimage>({ tag: 3, amount, nonce })
```

The distinct `tag` values give domain separation: the same 32-byte secret cannot
yield the same identity in two roles, which is asserted by a test.

## 2. Invariants

These are the properties the contract is built to guarantee. Each is backed by at
least one test in `contract/src/test/`.

| # | Invariant | Enforced by |
| --- | --- | --- |
| I1 | A supplier's sealed price never reaches the ledger while bidding is open. | `submitBid` writes only the commitment digest. |
| I2 | A bid can only be opened with the exact `(amount, nonce)` that was sealed. | `revealBid` recomputes the commitment and asserts equality. |
| I3 | A bid can only be opened by the identity that sealed it. | The ledger slot is keyed by the caller's derived identity. |
| I4 | Only the successive running minima, and finally the winner's price, are ever published. | `revealBid` asserts `!hasWinner \|\| amount < lowestBid`. |
| I5 | The sealed bidding window cannot be shortened. | `openReveal` asserts `blockTimeGt(bidDeadline)`. |
| I6 | The sealed bidding window cannot be extended. | `submitBid` asserts `blockTimeLt(bidDeadline)`. |
| I7 | No bid may be opened outside the reveal window. | `revealBid` asserts `blockTimeLt(revealDeadline)`. |
| I8 | A result is only awarded when at least `requiredBidders` distinct suppliers bid. | `settle` asserts the quorum. |
| I9 | The buyer cannot void an awardable result. | `cancel` is refused while a valid result is public. |
| I10 | Only the auctioneer can initialise, open the reveal window, award or cancel. | Every such circuit asserts the derived auctioneer identity. |
| I11 | A failed circuit leaves the ledger untouched. | Compact execution is atomic; verified by before/after comparisons. |
| I12 | A settled auction's outcome can never change. | Phase gating on every mutating circuit. |

## 3. Threat model

### Defended against

**Bid sniping.** A rival watching the ledger during the bidding window sees only
a digest. They cannot derive the price (the commitment is hiding), cannot
re-seal after the deadline (I6), and cannot react to a price they see during the
reveal window because sealing is already closed.

**Opening someone else's bid.** Copying a rival's public commitment is useless:
`submitBid` addresses the ledger by the caller's derived identity, so a copy
lands in the copier's own slot, and `revealBid` only ever looks up the caller's
own slot (I3). Without the nonce there is nothing to open (I2).

**Forging a better price.** A supplier cannot claim a price other than the one
they sealed: the commitment is recomputed and compared inside the proof (I2).

**Deadline manipulation by the buyer.** The deadline is a block-time bound, not
a button the buyer presses. `openReveal` cannot be called early and `submitBid`
cannot be called late, so the window is exactly `[initialisation, bidDeadline]`.

**Voiding an unfavourable result.** Once a valid price is public, `cancel` is
refused forever (I9), and there is no parameter anywhere that lets the buyer
choose a different winner.

**Single-source awards.** `settle` refuses to award unless the quorum of distinct
suppliers was met (I8).

**Role impersonation.** Authorisation is a ZK constraint on knowledge of a
preimage, not a comparison against a prover-supplied public key. `ownPublicKey()`
is never consulted.

**Replay.** A successful reveal cannot be repeated (it would have to be strictly
lower than the price it just set), and the phase gate blocks it after settlement.

### Not defended against

**A leaked nonce.** The commitment is hiding, so the digest alone is useless —
but `(amount, nonce)` *is* the bid. A supplier who shares both before the reveal
window opens can have the bid opened by whoever received it, under that
recipient's identity, and the first opener wins a tie. This is why the CLI keeps
nonces in encrypted private state and never logs them. Pinned as a test in
`security.test.ts`.

**Withdrawal by omission.** A sealed bid is not a firm offer: declining to open it
withdraws it at no cost. The quorum rule and the cancellation path are the
mitigations — an auction that loses its competition can be cancelled rather than
awarded.

**Collusion.** Nothing prevents suppliers from agreeing prices off chain. That is
out of scope for any on-chain mechanism.

**A buyer who never concludes the auction.** The auctioneer can leave an auction
in `Reveal` indefinitely. Suppliers' commitments stay sealed and no award is
made. A production system would add a permissionless settlement path, which this
contract deliberately does not have — see below.

## 4. Deliberate design decisions

**No clock accessor.** Compact exposes `blockTimeLt` / `blockTimeGt` rather than
the current time. This is an improvement: a circuit proves "the deadline has
passed" without revealing *when* the transaction ran. It also means deadlines are
strictly one-sided — bidding is refused at exactly `bidDeadline`, and the reveal
window opens only on the next block. Tests pin that boundary.

**A commitment rather than an encryption.** A commitment hides the price with
information-theoretic hiding and computational binding, which is what an auction
needs. Encryption would require a key-holder to decrypt at settlement.

**The quorum is checked at award time, not at reveal time.** Putting the check in
`revealBid` would let an under-subscribed auction trap a supplier who had already
opened a valid bid. Checking it in `settle` keeps that information public without
blocking the reveal.

**Cancellation is the escape hatch, not a second settlement path.** `settle` and
`cancel` are deliberately duals:

| State | `settle` | `cancel` |
| --- | --- | --- |
| No bid opened | Allowed (concludes unsold) | Allowed |
| Bid opened, quorum unmet | Refused | **Allowed** |
| Bid opened, quorum met | Allowed (awards) | Refused |

This is what makes the auction impossible to deadlock: every reachable state in
`Reveal` has at least one permitted transition, while an awardable result can
never be voided. Both rows are covered by tests.

**The lot is committed by digest.** The contract stores `sha256(document)`
instead of the text, so terms are fixed at initialisation and can be verified by
anyone holding the document, without the contract carrying arbitrary bytes.

## 5. Test strategy

`contract/src/test/auction-simulation.ts` is the harness. It executes the real
generated circuits against the real `compact-runtime`; only the wallet, proof
server and block production are simulated. Two capabilities make the deadline and
permission rules testable:

- **Caller switching.** Each circuit call is executed with a chosen actor's
  private state loaded, so `deriveBidderKey(getUserSecret())` yields that actor's
  identity and the authorisation assertions are genuinely exercised.
- **Block time.** `createCircuitContext` accepts a time, set per call, so
  `blockTimeLt` / `blockTimeGt` can be driven across every boundary without
  waiting.

A failed call throws and the updated context is discarded, so the simulated
ledger is only advanced on success — mirroring the atomicity of a real
transaction, which is itself asserted (I11).

The live walkthrough in `cli/src/demo.ts` complements this by executing all six
circuits against a real node and proof server, observing the chain refuse an
early `openReveal`, and reading the settled result back from the indexer.
