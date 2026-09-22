# SealedBid lot — Supply of 40 rack-mount compute nodes

Network: undeployed
Unit: tNIGHT

## Scope

Supply, deliver and install 40 rack-mount compute nodes to the specification published with this lot. Award is on lowest conforming price; the buyer may reject any price above the reserve price.

## Terms

| Term | Value |
| --- | --- |
| Reserve price (maximum acceptable) | 1,000,000 tNIGHT |
| Bidding closes (unix seconds) | 1,790,092,754 |
| Bidding closes (UTC) | 2026-09-22T15:59:14.000Z |
| Opening closes (unix seconds) | 1,790,093,654 |
| Opening closes (UTC) | 2026-09-22T16:14:14.000Z |
| Suppliers required to award | 1 |

## Rules

1. A bid is sealed by committing to `sha256`-based digest of `(amount, nonce)`;
   the amount never touches the ledger while bidding is open.
2. Bidding closes at the deadline above. The buyer cannot close it early.
3. During the opening window a supplier may open their bid only if the price
   matches the sealed digest, is at or below the reserve, and is strictly
   lower than every price opened so far. Prices that do not take the lead are
   never published.
4. The auction is awarded to the lowest opened price once the supplier quorum
   is met. It cannot be cancelled once a valid price is public.
