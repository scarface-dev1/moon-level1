// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { BID_END, OPENED_AT, nonceOf, openAuction, scalarLedger, seal } from './fixtures.js';

describe('sealing a bid', () => {
  it('records a commitment and nothing else', () => {
    const { sim, alice } = openAuction();
    const sealed = seal(sim, 850n, nonceOf(1));
    sim.submitBid(alice, OPENED_AT, sealed);

    const l = sim.getLedger();
    expect(l.commitments.size()).toBe(1n);
    expect(l.commitments.lookup(sim.bidderKeyOf(alice))).toEqual(sealed);
    expect(l.bidCount).toBe(1n);
  });

  it('does not publish the bid price', () => {
    const { sim, alice } = openAuction();
    const amount = 850n;
    sim.submitBid(alice, OPENED_AT, seal(sim, amount, nonceOf(1)));

    const l = sim.getLedger();
    // The only place a supplier's data lives is a 32-byte digest, and none of
    // the scalar ledger fields carries the price.
    expect(l.commitments.lookup(sim.bidderKeyOf(alice))).toHaveLength(32);
    expect(l.lowestBid).toBe(0n);
    expect(l.hasWinner).toBe(false);
    for (const field of [
      l.reservePrice,
      l.bidDeadline,
      l.revealDeadline,
      l.bidCount,
      l.requiredBidders,
      l.lowestBid,
    ]) {
      expect(field).not.toBe(amount);
    }
  });

  it('keeps one slot per supplier', () => {
    const { sim, alice, bob, carol } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, 800n, nonceOf(2)));
    sim.submitBid(carol, OPENED_AT, seal(sim, 700n, nonceOf(3)));

    expect(sim.getLedger().commitments.size()).toBe(3n);
    expect(sim.getLedger().bidCount).toBe(3n);
  });

  it('accepts a commitment right up to the deadline, exclusive', () => {
    const { sim, alice } = openAuction();
    sim.submitBid(alice, Number(BID_END) - 1, seal(sim, 900n, nonceOf(1)));
    expect(sim.getLedger().bidCount).toBe(1n);
  });

  it('refuses a commitment at the deadline', () => {
    const { sim, alice } = openAuction();
    expect(() => sim.submitBid(alice, Number(BID_END), seal(sim, 900n, nonceOf(1)))).toThrow(
      /bidding window has closed/i,
    );
    expect(sim.getLedger().bidCount).toBe(0n);
  });

  it('refuses a commitment after the deadline', () => {
    const { sim, alice } = openAuction();
    expect(() => sim.submitBid(alice, Number(BID_END) + 1, seal(sim, 900n, nonceOf(1)))).toThrow(
      /bidding window has closed/i,
    );
  });

  it('refuses a commitment once the auction has been cancelled', () => {
    const { sim, auctioneer, alice } = openAuction();
    sim.cancel(auctioneer, OPENED_AT);
    expect(() => sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)))).toThrow(
      /only accepted while the auction is open/i,
    );
  });
});

describe('improving a sealed bid', () => {
  it('replaces the previous commitment without inflating the bid count', () => {
    const { sim, alice } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    const second = seal(sim, 700n, nonceOf(2));
    sim.submitBid(alice, OPENED_AT + 1, second);

    const l = sim.getLedger();
    expect(l.commitments.size()).toBe(1n);
    expect(l.bidCount).toBe(1n);
    expect(l.commitments.lookup(sim.bidderKeyOf(alice))).toEqual(second);
  });

  it('leaves only the latest commitment valid for opening', () => {
    const { sim, auctioneer, alice } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(alice, OPENED_AT + 1, seal(sim, 700n, nonceOf(2)));
    sim.openReveal(auctioneer, Number(BID_END) + 1);

    expect(() => sim.revealBid(alice, Number(BID_END) + 2, 900n, nonceOf(1))).toThrow(
      /does not match the sealed commitment/i,
    );
    expect(() => sim.revealBid(alice, Number(BID_END) + 2, 700n, nonceOf(2))).not.toThrow();
    expect(sim.getLedger().lowestBid).toBe(700n);
  });

  it('refuses to improve a bid after the deadline', () => {
    const { sim, alice } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    const before = scalarLedger(sim);
    expect(() => sim.submitBid(alice, Number(BID_END), seal(sim, 700n, nonceOf(2)))).toThrow(
      /bidding window has closed/i,
    );
    expect(scalarLedger(sim)).toEqual(before);
  });
});

describe('commitment isolation', () => {
  it('gives each supplier a distinct ledger slot', () => {
    const { sim, alice, bob } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, 900n, nonceOf(1)));

    const aliceKey = sim.bidderKeyOf(alice);
    const bobKey = sim.bidderKeyOf(bob);
    expect(aliceKey).not.toEqual(bobKey);
    // Identical price and nonce still produce distinct slots per supplier.
    expect(sim.getLedger().commitments.lookup(aliceKey)).toEqual(sim.getLedger().commitments.lookup(bobKey));
    expect(sim.getLedger().commitments.size()).toBe(2n);
  });

  it('does not let one supplier overwrite another supplier commitment', () => {
    const { sim, alice, mallory } = openAuction();
    const aliceSealed = seal(sim, 900n, nonceOf(1));
    sim.submitBid(alice, OPENED_AT, aliceSealed);
    sim.submitBid(mallory, OPENED_AT, seal(sim, 1n, nonceOf(9)));

    // Mallory's write landed in Mallory's own slot; Alice's is untouched.
    expect(sim.getLedger().commitments.lookup(sim.bidderKeyOf(alice))).toEqual(aliceSealed);
    expect(sim.getLedger().commitments.size()).toBe(2n);
  });
});
