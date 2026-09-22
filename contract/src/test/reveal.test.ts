// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { BID_END, OPENED_AT, RESERVE, REVEAL_END, nonceOf, openAuction, scalarLedger, seal } from './fixtures.js';

const AFTER_BID_END = Number(BID_END) + 1;

/** An auction in the reveal window with the given suppliers' bids sealed. */
const revealed = (
  bids: ReadonlyArray<{ actor: 'alice' | 'bob' | 'carol'; amount: bigint; nonce: number }>,
  reserve = RESERVE,
) => {
  const fixture = openAuction({ reserve });
  for (const bid of bids) {
    fixture.sim.submitBid(fixture[bid.actor], OPENED_AT, seal(fixture.sim, bid.amount, nonceOf(bid.nonce)));
  }
  fixture.sim.openReveal(fixture.auctioneer, AFTER_BID_END);
  return fixture;
};

describe('opening a bid', () => {
  it('records the winner and the lowest price', () => {
    const { sim, alice } = revealed([{ actor: 'alice', amount: 850n, nonce: 1 }]);
    sim.revealBid(alice, AFTER_BID_END, 850n, nonceOf(1));

    const l = sim.getLedger();
    expect(l.hasWinner).toBe(true);
    expect(l.lowestBid).toBe(850n);
    expect(l.winner).toEqual(sim.bidderKeyOf(alice));
  });

  it('accepts a bid at exactly the reserve price', () => {
    const { sim, alice } = revealed([{ actor: 'alice', amount: RESERVE, nonce: 1 }]);
    expect(() => sim.revealBid(alice, AFTER_BID_END, RESERVE, nonceOf(1))).not.toThrow();
    expect(sim.getLedger().lowestBid).toBe(RESERVE);
  });

  it('accepts a bid one unit below the reserve price', () => {
    const { sim, alice } = revealed([{ actor: 'alice', amount: RESERVE - 1n, nonce: 1 }]);
    sim.revealBid(alice, AFTER_BID_END, RESERVE - 1n, nonceOf(1));
    expect(sim.getLedger().lowestBid).toBe(RESERVE - 1n);
  });

  it('lets a cheaper bid take the lead', () => {
    const { sim, alice, bob } = revealed([
      { actor: 'alice', amount: 900n, nonce: 1 },
      { actor: 'bob', amount: 800n, nonce: 2 },
    ]);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));
    sim.revealBid(bob, AFTER_BID_END, 800n, nonceOf(2));

    const l = sim.getLedger();
    expect(l.lowestBid).toBe(800n);
    expect(l.winner).toEqual(sim.bidderKeyOf(bob));
  });

  it('accepts a bid up to the reveal deadline, exclusive', () => {
    const { sim, alice } = revealed([{ actor: 'alice', amount: 900n, nonce: 1 }]);
    sim.revealBid(alice, Number(REVEAL_END) - 1, 900n, nonceOf(1));
    expect(sim.getLedger().hasWinner).toBe(true);
  });
});

describe('commitment binding', () => {
  it('refuses an opened price that does not match the sealed digest', () => {
    const { sim, alice } = revealed([{ actor: 'alice', amount: 900n, nonce: 1 }]);
    expect(() => sim.revealBid(alice, AFTER_BID_END, 500n, nonceOf(1))).toThrow(
      /does not match the sealed commitment/i,
    );
    expect(sim.getLedger().hasWinner).toBe(false);
  });

  it('refuses a tampered nonce', () => {
    const { sim, alice } = revealed([{ actor: 'alice', amount: 900n, nonce: 1 }]);
    expect(() => sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(2))).toThrow(
      /does not match the sealed commitment/i,
    );
  });

  it('refuses a tampered nonce that is off by a single bit', () => {
    const { sim, alice } = revealed([{ actor: 'alice', amount: 900n, nonce: 1 }]);
    const tampered = nonceOf(1);
    tampered[31] = tampered[31] ^ 0x01;
    expect(() => sim.revealBid(alice, AFTER_BID_END, 900n, tampered)).toThrow(
      /does not match the sealed commitment/i,
    );
  });

  it('refuses a supplier with no sealed bid', () => {
    const { sim, alice } = revealed([]);
    expect(() => sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1))).toThrow(
      /No sealed bid is registered/i,
    );
  });

  it('refuses a supplier who only sealed a bid after the reveal window opened', () => {
    const { sim, auctioneer, alice, mallory } = revealed([{ actor: 'alice', amount: 900n, nonce: 1 }]);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));
    // Mallory cannot add a late bid, so cannot open one either.
    expect(() => sim.submitBid(mallory, AFTER_BID_END + 1, seal(sim, 1n, nonceOf(5)))).toThrow(
      /only accepted while the auction is open/i,
    );
    expect(() => sim.revealBid(mallory, AFTER_BID_END + 1, 1n, nonceOf(5))).toThrow(
      /No sealed bid is registered/i,
    );
    void auctioneer;
  });
});

describe('reveal validation', () => {
  it('refuses a price above the reserve', () => {
    const { sim, alice } = revealed([{ actor: 'alice', amount: RESERVE + 1n, nonce: 1 }]);
    expect(() => sim.revealBid(alice, AFTER_BID_END, RESERVE + 1n, nonceOf(1))).toThrow(
      /exceeds the reserve price/i,
    );
    expect(sim.getLedger().hasWinner).toBe(false);
  });

  it('refuses a zero price', () => {
    const { sim, alice } = revealed([{ actor: 'alice', amount: 0n, nonce: 1 }]);
    expect(() => sim.revealBid(alice, AFTER_BID_END, 0n, nonceOf(1))).toThrow(
      /Bid must be greater than zero/i,
    );
  });

  it('refuses a price equal to the standing lowest bid', () => {
    const { sim, alice, bob } = revealed([
      { actor: 'alice', amount: 900n, nonce: 1 },
      { actor: 'bob', amount: 900n, nonce: 2 },
    ]);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));
    expect(() => sim.revealBid(bob, AFTER_BID_END, 900n, nonceOf(2))).toThrow(
      /not lower than the current lowest bid/i,
    );
  });

  it('refuses a price above the standing lowest bid', () => {
    const { sim, alice, bob } = revealed([
      { actor: 'alice', amount: 700n, nonce: 1 },
      { actor: 'bob', amount: 950n, nonce: 2 },
    ]);
    sim.revealBid(alice, AFTER_BID_END, 700n, nonceOf(1));
    const before = scalarLedger(sim);
    expect(() => sim.revealBid(bob, AFTER_BID_END, 950n, nonceOf(2))).toThrow(
      /not lower than the current lowest bid/i,
    );
    // The failed attempt changed nothing.
    expect(scalarLedger(sim)).toEqual(before);
  });

  it('keeps the first supplier as winner when a rival ties the price', () => {
    const { sim, alice, bob } = revealed([
      { actor: 'alice', amount: 900n, nonce: 1 },
      { actor: 'bob', amount: 900n, nonce: 2 },
    ]);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));
    expect(() => sim.revealBid(bob, AFTER_BID_END, 900n, nonceOf(2))).toThrow(/not lower/i);
    expect(sim.getLedger().winner).toEqual(sim.bidderKeyOf(alice));
  });

  it('refuses a second opening after the reveal deadline', () => {
    const { sim, alice, bob } = revealed([
      { actor: 'alice', amount: 900n, nonce: 1 },
      { actor: 'bob', amount: 800n, nonce: 2 },
    ]);
    sim.revealBid(alice, Number(REVEAL_END) - 1, 900n, nonceOf(1));
    expect(() => sim.revealBid(bob, Number(REVEAL_END), 800n, nonceOf(2))).toThrow(
      /reveal window has closed/i,
    );
  });

  it('refuses a repeated opening by the standing winner', () => {
    const { sim, alice } = revealed([{ actor: 'alice', amount: 900n, nonce: 1 }]);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));
    expect(() => sim.revealBid(alice, AFTER_BID_END + 1, 900n, nonceOf(1))).toThrow(
      /not lower than the current lowest bid/i,
    );
  });
});

describe('privacy of losing bids', () => {
  it('never publishes a price that does not take the lead', () => {
    const { sim, alice, bob } = revealed([
      { actor: 'alice', amount: 800n, nonce: 1 },
      { actor: 'bob', amount: 950n, nonce: 2 },
    ]);
    sim.revealBid(alice, AFTER_BID_END, 800n, nonceOf(1));

    // Bob's losing price cannot be opened at all, so it can never reach the
    // ledger. The standing lowest price is Alice's, not Bob's.
    expect(() => sim.revealBid(bob, AFTER_BID_END, 950n, nonceOf(2))).toThrow(/not lower/i);
    const l = sim.getLedger();
    expect(l.lowestBid).toBe(800n);
    expect(l.lowestBid).not.toBe(950n);
    expect(l.winner).toEqual(sim.bidderKeyOf(alice));
  });

  it('leaves losing commitments as opaque digests', () => {
    const { sim, alice, bob } = revealed([
      { actor: 'alice', amount: 800n, nonce: 1 },
      { actor: 'bob', amount: 950n, nonce: 2 },
    ]);
    sim.revealBid(alice, AFTER_BID_END, 800n, nonceOf(1));
    expect(sim.getLedger().commitments.lookup(sim.bidderKeyOf(bob))).toEqual(seal(sim, 950n, nonceOf(2)));
    expect(sim.getLedger().commitments.lookup(sim.bidderKeyOf(bob))).toHaveLength(32);
  });

  it('publishes only the winning price after a competitive auction', () => {
    const { sim, alice, bob, carol } = revealed([
      { actor: 'alice', amount: 900n, nonce: 1 },
      { actor: 'bob', amount: 600n, nonce: 2 },
      { actor: 'carol', amount: 750n, nonce: 3 },
    ]);
    // The running minimum can only move downwards, so the only prices that
    // ever become public are the successive leaders.
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));
    sim.revealBid(bob, AFTER_BID_END + 1, 600n, nonceOf(2));
    expect(() => sim.revealBid(carol, AFTER_BID_END + 2, 750n, nonceOf(3))).toThrow(/not lower/i);
    expect(sim.getLedger().lowestBid).toBe(600n);
    expect(sim.getLedger().winner).toEqual(sim.bidderKeyOf(bob));
  });
});
