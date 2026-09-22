// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { AuctionPhase } from '../managed/sealed-bid-auction/contract/index.js';
import { BID_END, LOT_DIGEST, OPENED_AT, RESERVE, REVEAL_END, nonceOf, openAuction, seal } from './fixtures.js';

describe('end-to-end procurement run', () => {
  it('runs a full sealed-bid cycle across every circuit', () => {
    const { sim, auctioneer, alice, bob, carol } = openAuction({ requiredBidCount: 3n });

    // 1. Bidding window: three suppliers seal three different prices.
    sim.submitBid(alice, OPENED_AT, seal(sim, 940n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT + 10, seal(sim, 1_000n, nonceOf(2)));
    sim.submitBid(carol, OPENED_AT + 20, seal(sim, 880n, nonceOf(3)));
    // Alice improves her offer before the deadline.
    sim.submitBid(alice, OPENED_AT + 30, seal(sim, 820n, nonceOf(4)));

    expect(sim.getLedger().phase).toBe(AuctionPhase.Bidding);
    expect(sim.getLedger().bidCount).toBe(3n);
    expect(sim.getLedger().commitments.size()).toBe(3n);
    expect(sim.getLedger().hasWinner).toBe(false);

    // 2. The window closes on the deadline, not at the buyer's convenience.
    expect(() => sim.openReveal(auctioneer, Number(BID_END) - 1)).toThrow(/has not closed yet/i);
    sim.openReveal(auctioneer, Number(BID_END) + 1);
    expect(sim.getLedger().phase).toBe(AuctionPhase.Reveal);

    // 3. Suppliers open their bids. Only successively cheaper prices land:
    //    Bob's 1,000 is beaten by Carol's 880, which is beaten by Alice's 820.
    sim.revealBid(bob, Number(BID_END) + 2, 1_000n, nonceOf(2));
    expect(sim.getLedger().lowestBid).toBe(1_000n);
    sim.revealBid(carol, Number(BID_END) + 3, 880n, nonceOf(3));
    expect(sim.getLedger().lowestBid).toBe(880n);
    sim.revealBid(alice, Number(BID_END) + 4, 820n, nonceOf(4));
    expect(sim.getLedger().lowestBid).toBe(820n);

    // 4. Award.
    sim.settle(auctioneer, Number(BID_END) + 5);

    const l = sim.getLedger();
    expect(l.phase).toBe(AuctionPhase.Settled);
    expect(l.hasWinner).toBe(true);
    expect(l.winner).toEqual(sim.bidderKeyOf(alice));
    expect(l.lowestBid).toBe(820n);
    expect(l.lotHash).toEqual(LOT_DIGEST);
    expect(l.reservePrice).toBe(RESERVE);
    expect(l.revealDeadline).toBe(REVEAL_END);
    expect(l.auctioneer).toEqual(sim.auctioneerKeyOf(auctioneer));
  });

  it('runs a voided procurement when the lot attracts no acceptable price', () => {
    const { sim, auctioneer, alice, bob } = openAuction();

    sim.submitBid(alice, OPENED_AT, seal(sim, RESERVE + 100n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, RESERVE + 200n, nonceOf(2)));
    sim.openReveal(auctioneer, Number(BID_END) + 1);

    // Both suppliers bid over the reserve, so neither can open a bid.
    expect(() => sim.revealBid(alice, Number(BID_END) + 2, RESERVE + 100n, nonceOf(1))).toThrow(/reserve/i);
    expect(() => sim.revealBid(bob, Number(BID_END) + 2, RESERVE + 200n, nonceOf(2))).toThrow(/reserve/i);

    sim.settle(auctioneer, Number(BID_END) + 3);
    expect(sim.getLedger().phase).toBe(AuctionPhase.Settled);
    expect(sim.getLedger().hasWinner).toBe(false);
  });

  it('runs a cancelled procurement', () => {
    const { sim, auctioneer, alice } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.cancel(auctioneer, OPENED_AT + 1);

    expect(sim.getLedger().phase).toBe(AuctionPhase.Cancelled);
    expect(sim.getLedger().hasWinner).toBe(false);
    // The sealed bid stays on the ledger but can never be opened.
    expect(sim.getLedger().commitments.size()).toBe(1n);
    expect(() => sim.openReveal(auctioneer, Number(BID_END) + 1)).toThrow(/not accepting bids/i);
  });
});
