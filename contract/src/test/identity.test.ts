// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { actorFromLabel, AuctionSimulation } from './auction-simulation.js';
import { actors, nonceOf } from './fixtures.js';

const fresh = () => new AuctionSimulation(actorFromLabel('unused'), 0);

describe('identity derivation', () => {
  it('derives a 32-byte identity from a 32-byte secret', () => {
    const sim = fresh();
    const alice = actorFromLabel('alice');
    expect(sim.bidderKeyOf(alice)).toHaveLength(32);
    expect(sim.auctioneerKeyOf(alice)).toHaveLength(32);
  });

  it('is deterministic for the same secret', () => {
    const sim = fresh();
    const alice = actorFromLabel('alice');
    expect(sim.bidderKeyOf(alice)).toEqual(sim.bidderKeyOf(alice));
  });

  it('maps distinct secrets to distinct identities', () => {
    const sim = fresh();
    const { alice, bob } = actors();
    expect(sim.bidderKeyOf(alice)).not.toEqual(sim.bidderKeyOf(bob));
  });

  it('domain-separates the bidder role from the auctioneer role', () => {
    // The same 32-byte secret must not yield the same identity for two
    // different roles, otherwise a supplier could inherit the buyer role.
    const sim = fresh();
    const alice = actorFromLabel('alice');
    expect(sim.bidderKeyOf(alice)).not.toEqual(sim.auctioneerKeyOf(alice));
  });

  it('never exposes the raw secret through a derived identity', () => {
    const sim = fresh();
    const alice = actorFromLabel('alice');
    expect(sim.bidderKeyOf(alice)).not.toEqual(alice.secret);
    expect(sim.auctioneerKeyOf(alice)).not.toEqual(alice.secret);
  });
});

describe('bid sealing', () => {
  it('seals to a 32-byte digest', () => {
    const sim = fresh();
    const sealed = sim.seal(825n, nonceOf(1));
    expect(sealed).toHaveLength(32);
  });

  it('is deterministic for the same amount and nonce', () => {
    const sim = fresh();
    expect(sim.seal(825n, nonceOf(1))).toEqual(sim.seal(825n, nonceOf(1)));
  });

  it('changes when the amount changes', () => {
    const sim = fresh();
    expect(sim.seal(825n, nonceOf(1))).not.toEqual(sim.seal(826n, nonceOf(1)));
  });

  it('changes when the nonce changes', () => {
    // Nonces stop a competitor from brute-forcing a committed price.
    const sim = fresh();
    expect(sim.seal(825n, nonceOf(1))).not.toEqual(sim.seal(825n, nonceOf(2)));
  });

  it('does not embed the amount in the digest', () => {
    const sim = fresh();
    const amount = 0x0102030405060708n;
    const sealed = sim.seal(amount, nonceOf(3));
    const littleEndian = Uint8Array.from({ length: 8 }, (_, i) => Number((amount >> BigInt(8 * i)) & 0xffn));
    expect(sealed.slice(0, 8)).not.toEqual(littleEndian);
  });
});
