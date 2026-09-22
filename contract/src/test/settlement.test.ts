// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { AuctionPhase } from '../managed/sealed-bid-auction/contract/index.js';
import { BID_END, OPENED_AT, nonceOf, openAuction, seal } from './fixtures.js';

const AFTER_BID_END = Number(BID_END) + 1;

describe('awarding the auction', () => {
  it('settles once enough suppliers have bid and a winner is known', () => {
    const { sim, auctioneer, alice, bob } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, 800n, nonceOf(2)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));
    sim.revealBid(bob, AFTER_BID_END, 800n, nonceOf(2));
    sim.settle(auctioneer, AFTER_BID_END);

    const l = sim.getLedger();
    expect(l.phase).toBe(AuctionPhase.Settled);
    expect(l.winner).toEqual(sim.bidderKeyOf(bob));
    expect(l.lowestBid).toBe(800n);
  });

  it('settles an under-subscribed auction as unsold', () => {
    const { sim, auctioneer } = openAuction({ requiredBidCount: 3n });
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.settle(auctioneer, AFTER_BID_END);

    const l = sim.getLedger();
    expect(l.phase).toBe(AuctionPhase.Settled);
    expect(l.hasWinner).toBe(false);
    expect(l.lowestBid).toBe(0n);
  });

  it('refuses to award a single-source auction', () => {
    // A procurement control: one sealed bid is not competition.
    const { sim, auctioneer, alice } = openAuction({ requiredBidCount: 2n });
    sim.submitBid(alice, OPENED_AT, seal(sim, 500n, nonceOf(1)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.revealBid(alice, AFTER_BID_END, 500n, nonceOf(1));
    expect(() => sim.settle(auctioneer, AFTER_BID_END)).toThrow(/did not attract enough bidders/i);
    expect(sim.getPhase()).toBe(AuctionPhase.Reveal);
  });

  it('counts distinct suppliers, not bids, towards the quorum', () => {
    const { sim, auctioneer, alice } = openAuction({ requiredBidCount: 2n });
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(alice, OPENED_AT, seal(sim, 700n, nonceOf(2)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.revealBid(alice, AFTER_BID_END, 700n, nonceOf(2));
    expect(() => sim.settle(auctioneer, AFTER_BID_END)).toThrow(/did not attract enough bidders/i);
  });

  it('freezes the outcome after settlement', () => {
    const { sim, auctioneer, alice, bob } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, 800n, nonceOf(2)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));
    sim.settle(auctioneer, AFTER_BID_END);

    const before = sim.getLedger();
    expect(() => sim.revealBid(bob, AFTER_BID_END, 800n, nonceOf(2))).toThrow(/reveal window/i);
    expect(() => sim.settle(auctioneer, AFTER_BID_END)).toThrow(/only be settled from the reveal window/i);
    expect(sim.getLedger().lowestBid).toBe(before.lowestBid);
    expect(sim.getLedger().winner).toEqual(before.winner);
  });

  it('rejects a non-auctioneer', () => {
    const { sim, auctioneer, alice, bob, mallory } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, 800n, nonceOf(2)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    expect(() => sim.settle(mallory, AFTER_BID_END)).toThrow(/Only the auctioneer/i);
    expect(sim.getPhase()).toBe(AuctionPhase.Reveal);
  });
});

describe('cancelling the auction', () => {
  it('cancels while bidding', () => {
    const { sim, auctioneer } = openAuction();
    sim.cancel(auctioneer, OPENED_AT);
    expect(sim.getPhase()).toBe(AuctionPhase.Cancelled);
  });

  it('cancels during the reveal window while no bid has been opened', () => {
    const { sim, auctioneer, alice } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.cancel(auctioneer, AFTER_BID_END);
    expect(sim.getPhase()).toBe(AuctionPhase.Cancelled);
  });

  it('refuses to cancel once a valid price has been opened', () => {
    // The buyer must not be able to void an auction that produced an
    // unfavourable but awardable price.
    const { sim, auctioneer, alice, bob } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, 800n, nonceOf(2)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));

    expect(() => sim.cancel(auctioneer, AFTER_BID_END)).toThrow(
      /cannot be cancelled once a valid bid has been opened/i,
    );
    expect(sim.getPhase()).toBe(AuctionPhase.Reveal);
    expect(sim.getLedger().winner).toEqual(sim.bidderKeyOf(alice));
  });

  it('lets the buyer escape an auction it cannot award', () => {
    // The quorum rule must not be able to lock an auction forever. Here a
    // price was opened (so the auction cannot be settled, because only one
    // supplier ever bid) — cancellation is the only way out.
    const { sim, auctioneer, alice } = openAuction({ requiredBidCount: 2n });
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));
    expect(sim.getLedger().hasWinner).toBe(true);

    expect(() => sim.settle(auctioneer, AFTER_BID_END)).toThrow(/did not attract enough bidders/i);
    sim.cancel(auctioneer, AFTER_BID_END);
    expect(sim.getPhase()).toBe(AuctionPhase.Cancelled);
  });

  it('rejects a non-auctioneer', () => {
    const { sim, mallory } = openAuction();
    expect(() => sim.cancel(mallory, OPENED_AT)).toThrow(/Only the auctioneer/i);
    expect(sim.getPhase()).toBe(AuctionPhase.Bidding);
  });

  it('freezes the ledger after cancellation', () => {
    const { sim, auctioneer, alice } = openAuction();
    sim.cancel(auctioneer, OPENED_AT);
    expect(() => sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)))).toThrow(/auction is open/i);
    expect(() => sim.openReveal(auctioneer, AFTER_BID_END)).toThrow(/not accepting bids/i);
    expect(() => sim.cancel(auctioneer, OPENED_AT)).toThrow(/before it is settled/i);
  });
});
