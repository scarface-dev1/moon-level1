// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { actorFromLabel } from './auction-simulation.js';
import { AuctionPhase } from '../managed/sealed-bid-auction/contract/index.js';
import {
  BID_END,
  LOT_DIGEST,
  OPENED_AT,
  REQUIRED_BIDDERS,
  RESERVE,
  REVEAL_END,
  freshSimulation,
  nonceOf,
  openAuction,
  scalarLedger,
  seal,
} from './fixtures.js';

describe('deployment', () => {
  it('starts uninitialised with the auctioneer fixed by the constructor', () => {
    const { sim, auctioneer } = freshSimulation();
    const l = sim.getLedger();

    expect(l.phase).toBe(AuctionPhase.Uninitialized);
    expect(l.auctioneer).toEqual(sim.auctioneerKeyOf(auctioneer));
    expect(l.hasWinner).toBe(false);
    expect(l.bidCount).toBe(0n);
    expect(l.commitments.size()).toBe(0n);
    expect(l.reservePrice).toBe(0n);
    expect(l.lowestBid).toBe(0n);
  });

  it('produces identical initial ledger state on repeated deployments', () => {
    const { sim } = freshSimulation();
    const other = freshSimulation();
    expect(scalarLedger(other.sim)).toEqual(scalarLedger(sim));
  });

  it('binds the auctioneer role to the deployer secret', () => {
    const { sim } = freshSimulation();
    const impostor = actorFromLabel('impostor');
    expect(sim.getLedger().auctioneer).not.toEqual(sim.auctioneerKeyOf(impostor));
  });
});

describe('initialisation', () => {
  it('publishes the lot and terms, and opens bidding', () => {
    const { sim, auctioneer } = freshSimulation();
    sim.initializeAuction(auctioneer, OPENED_AT, LOT_DIGEST, RESERVE, BID_END, REVEAL_END, REQUIRED_BIDDERS);

    const l = sim.getLedger();
    expect(l.phase).toBe(AuctionPhase.Bidding);
    expect(l.lotHash).toEqual(LOT_DIGEST);
    expect(l.reservePrice).toBe(RESERVE);
    expect(l.bidDeadline).toBe(BID_END);
    expect(l.revealDeadline).toBe(REVEAL_END);
    expect(l.requiredBidders).toBe(REQUIRED_BIDDERS);
  });

  it('refuses to initialise twice', () => {
    const { sim, auctioneer } = openAuction();
    const before = sim.getLedger();
    expect(() =>
      sim.initializeAuction(auctioneer, OPENED_AT, new Uint8Array(32).fill(1), 5n, 10n, 20n, 1n),
    ).toThrow(/already been initialized/i);
    expect(sim.getLedger().lotHash).toEqual(before.lotHash);
    expect(sim.getLedger().reservePrice).toBe(RESERVE);
  });

  it('rejects a non-auctioneer', () => {
    const { sim, mallory } = freshSimulation();
    expect(() =>
      sim.initializeAuction(mallory, OPENED_AT, LOT_DIGEST, RESERVE, BID_END, REVEAL_END, REQUIRED_BIDDERS),
    ).toThrow(/Only the auctioneer/i);
    expect(sim.getPhase()).toBe(AuctionPhase.Uninitialized);
  });

  it('rejects a zero reserve price', () => {
    const { sim, auctioneer } = freshSimulation();
    expect(() => sim.initializeAuction(auctioneer, OPENED_AT, LOT_DIGEST, 0n, BID_END, REVEAL_END, 1n)).toThrow(
      /Reserve price must be greater than zero/i,
    );
  });

  it('rejects a bid deadline that is not before the reveal deadline', () => {
    const { sim, auctioneer } = freshSimulation();
    expect(() => sim.initializeAuction(auctioneer, OPENED_AT, LOT_DIGEST, RESERVE, 2_000n, 2_000n, 1n)).toThrow(
      /Bid deadline must be before the reveal deadline/i,
    );
    expect(() => sim.initializeAuction(auctioneer, OPENED_AT, LOT_DIGEST, RESERVE, 3_000n, 2_000n, 1n)).toThrow(
      /Bid deadline must be before the reveal deadline/i,
    );
  });

  it('rejects a bidding window that has already closed', () => {
    const { sim, auctioneer } = freshSimulation();
    expect(() => sim.initializeAuction(auctioneer, OPENED_AT, LOT_DIGEST, RESERVE, 50n, REVEAL_END, 1n)).toThrow(
      /Bid deadline must be in the future/i,
    );
  });

  it('rejects a bidding window that closes at exactly the current block time', () => {
    const { sim, auctioneer } = freshSimulation();
    expect(() =>
      sim.initializeAuction(auctioneer, OPENED_AT, LOT_DIGEST, RESERVE, BigInt(OPENED_AT), REVEAL_END, 1n),
    ).toThrow(/Bid deadline must be in the future/i);
  });

  it('rejects requiring zero bidders', () => {
    const { sim, auctioneer } = freshSimulation();
    expect(() => sim.initializeAuction(auctioneer, OPENED_AT, LOT_DIGEST, RESERVE, BID_END, REVEAL_END, 0n)).toThrow(
      /At least one bidder must be required/i,
    );
  });

  it('accepts a reserve price as large as the full Uint<64> range', () => {
    const { sim, auctioneer } = freshSimulation();
    const max = 2n ** 64n - 1n;
    expect(() => sim.initializeAuction(auctioneer, OPENED_AT, LOT_DIGEST, max, BID_END, REVEAL_END, 1n)).not.toThrow();
    expect(sim.getLedger().reservePrice).toBe(max);
  });
});

describe('phase gating', () => {
  it('refuses to open the reveal window before initialisation', () => {
    const { sim, auctioneer } = freshSimulation();
    expect(() => sim.openReveal(auctioneer, 5_000)).toThrow(/not accepting bids/i);
  });

  it('refuses to open the reveal window before the bid deadline has passed', () => {
    const { sim, auctioneer } = openAuction();
    expect(() => sim.openReveal(auctioneer, OPENED_AT)).toThrow(/has not closed yet/i);
    expect(() => sim.openReveal(auctioneer, Number(BID_END))).toThrow(/has not closed yet/i);
    expect(sim.getPhase()).toBe(AuctionPhase.Bidding);
  });

  it('opens the reveal window once the bid deadline has passed', () => {
    // The deadline is exclusive: bidding is refused at exactly `BID_END`, so
    // the reveal window opens on the first subsequent block.
    const { sim, auctioneer } = openAuction();
    sim.openReveal(auctioneer, Number(BID_END) + 1);
    expect(sim.getPhase()).toBe(AuctionPhase.Reveal);
  });

  it('refuses a second transition into the reveal window', () => {
    const { sim, auctioneer } = openAuction();
    sim.openReveal(auctioneer, Number(BID_END) + 1);
    expect(() => sim.openReveal(auctioneer, Number(BID_END) + 2)).toThrow(/not accepting bids/i);
  });

  it('rejects sealed bids outside the bidding phase', () => {
    const { sim, auctioneer, alice } = openAuction();
    sim.openReveal(auctioneer, Number(BID_END) + 1);
    expect(() => sim.submitBid(alice, Number(BID_END) + 2, seal(sim, 500n, nonceOf(1)))).toThrow(
      /only accepted while the auction is open/i,
    );
  });

  it('rejects opening a bid outside the reveal phase', () => {
    const { sim, alice } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 500n, nonceOf(1)));
    expect(() => sim.revealBid(alice, OPENED_AT, 500n, nonceOf(1))).toThrow(/only be opened during the reveal window/i);
  });

  it('rejects settlement outside the reveal phase', () => {
    const { sim, auctioneer } = openAuction();
    expect(() => sim.settle(auctioneer, OPENED_AT)).toThrow(/only be settled from the reveal window/i);
  });

  it('rejects a bid before the auction has been initialised', () => {
    const { sim, alice } = freshSimulation();
    expect(() => sim.submitBid(alice, OPENED_AT, seal(sim, 500n, nonceOf(1)))).toThrow(
      /only accepted while the auction is open/i,
    );
  });

  it('rejects cancellation from a settled auction', () => {
    const { sim, auctioneer, alice, bob } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, 800n, nonceOf(2)));
    sim.openReveal(auctioneer, Number(BID_END) + 1);
    sim.revealBid(alice, Number(BID_END) + 2, 900n, nonceOf(1));
    sim.settle(auctioneer, Number(BID_END) + 3);
    expect(() => sim.cancel(auctioneer, Number(BID_END) + 4)).toThrow(/before it is settled/i);
  });
});

describe('determinism', () => {
  it('reaches the same final state from the same scripted run', () => {
    const script = () => {
      const { sim, auctioneer, alice } = openAuction({ requiredBidCount: 1n });
      sim.submitBid(alice, OPENED_AT, seal(sim, 700n, nonceOf(1)));
      sim.openReveal(auctioneer, Number(BID_END) + 1);
      sim.revealBid(alice, Number(BID_END) + 2, 700n, nonceOf(1));
      sim.settle(auctioneer, Number(BID_END) + 3);
      return scalarLedger(sim);
    };
    expect(script()).toEqual(script());
  });
});
