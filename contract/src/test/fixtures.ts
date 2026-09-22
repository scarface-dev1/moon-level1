// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { AuctionSimulation, actorFromLabel, type Actor } from './auction-simulation.js';

/** Commitment to the (off-chain) lot specification. */
export const LOT_DIGEST = new Uint8Array(32).fill(0xab);

/** Maximum acceptable price. A lower price is better. */
export const RESERVE = 1_000n;

/** Unix seconds at which sealed bidding stops. */
export const BID_END = 1_000n;

/** Unix seconds at which opening bids stops. */
export const REVEAL_END = 2_000n;

/** Distinct suppliers required before the auction may be awarded. */
export const REQUIRED_BIDDERS = 2n;

/** Block time at which auctions are initialised in tests. */
export const OPENED_AT = 100;

/** A distinct 32-byte nonce per seed, so tests are reproducible. */
export const nonceOf = (seed: number): Uint8Array => new Uint8Array(32).fill(seed);

export type AuctionFixture = {
  readonly sim: AuctionSimulation;
  readonly auctioneer: Actor;
  readonly alice: Actor;
  readonly bob: Actor;
  readonly carol: Actor;
  readonly mallory: Actor;
};

/** Every actor a test might need, each with a distinct 32-byte secret. */
export const actors = () => ({
  auctioneer: actorFromLabel('auctioneer'),
  alice: actorFromLabel('alice'),
  bob: actorFromLabel('bob'),
  carol: actorFromLabel('carol'),
  mallory: actorFromLabel('mallory'),
});

/**
 * A deployment that has not been initialised yet — `phase` is `Uninitialized`.
 */
export const freshSimulation = (openedAt = OPENED_AT): AuctionFixture => {
  const { auctioneer, alice, bob, carol, mallory } = actors();
  return { sim: new AuctionSimulation(auctioneer, openedAt), auctioneer, alice, bob, carol, mallory };
};

/**
 * A simulation whose auction has been initialised and is open for sealed bids.
 */
export const openAuction = (
  overrides: Partial<{
    reserve: bigint;
    bidEnd: bigint;
    revealEnd: bigint;
    requiredBidCount: bigint;
    openedAt: number;
  }> = {},
): AuctionFixture => {
  const { auctioneer, alice, bob, carol, mallory } = actors();
  const openedAt = overrides.openedAt ?? OPENED_AT;
  const sim = new AuctionSimulation(auctioneer, openedAt);
  sim.initializeAuction(
    auctioneer,
    openedAt,
    LOT_DIGEST,
    overrides.reserve ?? RESERVE,
    overrides.bidEnd ?? BID_END,
    overrides.revealEnd ?? REVEAL_END,
    overrides.requiredBidCount ?? REQUIRED_BIDDERS,
  );
  return { sim, auctioneer, alice, bob, carol, mallory };
};

/** Seal a bid the way a supplier's client would, off chain. */
export const seal = (sim: AuctionSimulation, amount: bigint, nonce: Uint8Array): Uint8Array =>
  sim.seal(amount, nonce);

/** The scalar part of the ledger state, for before/after comparisons. */
export const scalarLedger = (sim: AuctionSimulation) => {
  const l = sim.getLedger();
  return {
    phase: l.phase,
    auctioneer: l.auctioneer,
    lotHash: l.lotHash,
    reservePrice: l.reservePrice,
    bidDeadline: l.bidDeadline,
    revealDeadline: l.revealDeadline,
    bidCount: l.bidCount,
    requiredBidders: l.requiredBidders,
    lowestBid: l.lowestBid,
    winner: l.winner,
    hasWinner: l.hasWinner,
    commitmentCount: l.commitments.size(),
  };
};
