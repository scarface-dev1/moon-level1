// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { AuctionSimulation, actorFromLabel } from './auction-simulation.js';
import { AuctionPhase } from '../managed/sealed-bid-auction/contract/index.js';
import { BID_END, OPENED_AT, RESERVE, REVEAL_END, nonceOf, openAuction, scalarLedger, seal } from './fixtures.js';

const AFTER_BID_END = Number(BID_END) + 1;

describe('impersonation', () => {
  it('makes a copied sealed digest useless without the nonce', () => {
    // A sealed digest is public. Copying it into your own slot must not let
    // you open the original bid: the digest is not the bid, it is a hiding
    // commitment, and the nonce is private.
    const { sim, auctioneer, alice, mallory } = openAuction();
    const aliceSealed = seal(sim, 900n, nonceOf(1));
    sim.submitBid(alice, OPENED_AT, aliceSealed);
    // Mallory copies the digest verbatim; she does not know its preimage.
    sim.submitBid(mallory, OPENED_AT, aliceSealed);
    sim.openReveal(auctioneer, AFTER_BID_END);

    // Guessing the amount is not enough: the nonce is private.
    expect(() => sim.revealBid(mallory, AFTER_BID_END, 900n, nonceOf(99))).toThrow(
      /does not match the sealed commitment/i,
    );
    expect(sim.getLedger().hasWinner).toBe(false);
  });

  it("never writes into another supplier's slot", () => {
    // `submitBid` addresses the ledger by the caller's derived identity, so a
    // rival that echoes a victim's digest lands in its own slot. The victim's
    // commitment is untouched and remains openable by the victim alone.
    const { sim, alice, mallory } = openAuction();
    const aliceSealed = seal(sim, 900n, nonceOf(1));
    sim.submitBid(alice, OPENED_AT, aliceSealed);
    sim.submitBid(mallory, OPENED_AT, aliceSealed);

    const l = sim.getLedger();
    expect(l.commitments.size()).toBe(2n);
    expect(l.commitments.lookup(sim.bidderKeyOf(alice))).toEqual(aliceSealed);
    expect(l.commitments.lookup(sim.bidderKeyOf(mallory))).toEqual(aliceSealed);
    expect(l.bidCount).toBe(2n);
  });

  it('refuses a rival trying to open a bid it never sealed', () => {
    const { sim, auctioneer, alice, mallory } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.openReveal(auctioneer, AFTER_BID_END);

    expect(() => sim.revealBid(mallory, AFTER_BID_END, 900n, nonceOf(1))).toThrow(
      /No sealed bid is registered/i,
    );
  });

  it('refuses an attacker acting as the auctioneer', () => {
    const { sim, auctioneer, mallory } = openAuction();
    expect(() => sim.openReveal(mallory, AFTER_BID_END)).toThrow(/Only the auctioneer/i);

    sim.openReveal(auctioneer, AFTER_BID_END);
    expect(() => sim.settle(mallory, AFTER_BID_END)).toThrow(/Only the auctioneer/i);
    expect(() => sim.cancel(mallory, AFTER_BID_END)).toThrow(/Only the auctioneer/i);
    expect(sim.getPhase()).toBe(AuctionPhase.Reveal);
  });

  it('does not authenticate on a caller-supplied public key', () => {
    // Authorisation derives from the private secret alone — `ownPublicKey()`
    // is never consulted. A different secret therefore yields a different
    // auctioneer and cannot borrow another contract's role.
    const realAuctioneer = actorFromLabel('auctioneer');
    const impostor = actorFromLabel('auctioneer-impostor');

    const genuine = new AuctionSimulation(realAuctioneer, OPENED_AT);
    const forged = new AuctionSimulation(impostor, OPENED_AT);
    forged.initializeAuction(impostor, OPENED_AT, new Uint8Array(32), RESERVE, BID_END, REVEAL_END, 1n);

    expect(genuine.getLedger().auctioneer).not.toEqual(forged.getLedger().auctioneer);
    expect(() => forged.cancel(realAuctioneer, OPENED_AT)).toThrow(/Only the auctioneer/i);
    expect(forged.getPhase()).toBe(AuctionPhase.Bidding);
  });
});

describe('bid sniping', () => {
  it('refuses a reactionary counter-bid once the sealed window has closed', () => {
    const { sim, auctioneer, alice, mallory } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(mallory, OPENED_AT, seal(sim, 500n, nonceOf(2)));
    sim.openReveal(auctioneer, AFTER_BID_END);

    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));
    expect(sim.getLedger().lowestBid).toBe(900n);

    // Mallory has just seen Alice's price. She cannot re-seal a cheaper bid.
    expect(() => sim.submitBid(mallory, AFTER_BID_END + 1, seal(sim, 100n, nonceOf(3)))).toThrow(
      /only accepted while the auction is open/i,
    );
    // Her original sealed price stands, and opening it is not sniping: it was
    // committed before any price was public.
    sim.revealBid(mallory, AFTER_BID_END + 1, 500n, nonceOf(2));
    expect(sim.getLedger().lowestBid).toBe(500n);
  });

  it('refuses a sealed bid that arrives after the deadline', () => {
    const { sim, mallory } = openAuction();
    expect(() => sim.submitBid(mallory, Number(BID_END), seal(sim, 1n, nonceOf(1)))).toThrow(
      /bidding window has closed/i,
    );
  });
});

describe('deadline integrity', () => {
  it('does not let the auctioneer shorten the sealed window', () => {
    const { sim, auctioneer } = openAuction();
    expect(() => sim.openReveal(auctioneer, OPENED_AT + 1)).toThrow(/has not closed yet/i);
    expect(sim.getPhase()).toBe(AuctionPhase.Bidding);
  });

  it('does not let the auctioneer extend the sealed window', () => {
    const { sim, alice } = openAuction();
    expect(() => sim.submitBid(alice, Number(BID_END) + 10_000, seal(sim, 1n, nonceOf(1)))).toThrow(
      /bidding window has closed/i,
    );
  });

  it('does not let anyone open a bid after the reveal window closes', () => {
    const { sim, auctioneer, alice } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    expect(() => sim.revealBid(alice, Number(REVEAL_END), 900n, nonceOf(1))).toThrow(
      /reveal window has closed/i,
    );
    expect(sim.getLedger().hasWinner).toBe(false);
  });
});

describe('atomicity', () => {
  it('rolls back the whole ledger when a circuit fails', () => {
    const { sim, auctioneer } = openAuction();
    const before = scalarLedger(sim);
    expect(() =>
      sim.initializeAuction(auctioneer, OPENED_AT, new Uint8Array(32).fill(9), 12n, 20n, 30n, 1n),
    ).toThrow(/already been initialized/i);
    expect(scalarLedger(sim)).toEqual(before);
  });

  it('rolls back a partially applied reveal', () => {
    const { sim, auctioneer, alice, bob } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, RESERVE + 1n, nonceOf(2)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));

    const before = scalarLedger(sim);
    expect(() => sim.revealBid(bob, AFTER_BID_END, RESERVE + 1n, nonceOf(2))).toThrow(/reserve/i);
    expect(scalarLedger(sim)).toEqual(before);
  });

  it('keeps the bid count stable across a failed submission', () => {
    const { sim, alice } = openAuction();
    expect(() => sim.submitBid(alice, Number(BID_END), seal(sim, 900n, nonceOf(1)))).toThrow(/closed/i);
    expect(sim.getLedger().bidCount).toBe(0n);
    expect(sim.getLedger().commitments.size()).toBe(0n);
  });
});

describe('the auctioneer cannot force an outcome', () => {
  it('leaves the auction unsold when no bid was opened', () => {
    const { sim, auctioneer, alice } = openAuction({ requiredBidCount: 1n });
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.settle(auctioneer, AFTER_BID_END);

    expect(sim.getLedger().hasWinner).toBe(false);
    expect(sim.getLedger().winner).toEqual(new Uint8Array(32));
    expect(sim.getPhase()).toBe(AuctionPhase.Settled);
  });

  it('refuses an over-reserve bid even when it is the only bid', () => {
    const { sim, auctioneer, alice } = openAuction({ requiredBidCount: 1n });
    sim.submitBid(alice, OPENED_AT, seal(sim, RESERVE + 5n, nonceOf(1)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    expect(() => sim.revealBid(alice, AFTER_BID_END, RESERVE + 5n, nonceOf(1))).toThrow(/reserve/i);
    expect(sim.getLedger().hasWinner).toBe(false);
    sim.settle(auctioneer, AFTER_BID_END);
    expect(sim.getLedger().phase).toBe(AuctionPhase.Settled);
    expect(sim.getLedger().hasWinner).toBe(false);
  });

  it('cannot reverse a winner once a valid price is public', () => {
    const { sim, auctioneer, alice, bob } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, 800n, nonceOf(2)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1));

    // The auctioneer would rather award to Bob, but a valid price is public:
    // cancellation is refused, and settling does not accept a substitute
    // winner — the ledger's recorded leader is the only possible award.
    expect(() => sim.cancel(auctioneer, AFTER_BID_END)).toThrow(/cannot be cancelled once a valid bid has been opened/i);
    sim.settle(auctioneer, AFTER_BID_END);
    expect(sim.getLedger().winner).toEqual(sim.bidderKeyOf(alice));

    // After settlement Bob can no longer undercut the award.
    expect(() => sim.revealBid(bob, AFTER_BID_END, 800n, nonceOf(2))).toThrow(
      /only be opened during the reveal window/i,
    );
    expect(sim.getLedger().lowestBid).toBe(900n);
  });
});

describe('documented limitations', () => {
  it('cannot protect a supplier who leaks their nonce', () => {
    // The digest alone is useless, but the (amount, nonce) pair *is* the bid.
    // A supplier who shares it before the reveal window opens can have the bid
    // opened by whoever received it, under that recipient's own identity, and
    // the first opener wins a tie. The CLI therefore keeps the nonce in
    // private state and never logs it.
    const { sim, auctioneer, alice, mallory } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    // Mallory sealed the *same* commitment, which she can only do because Alice
    // leaked the preimage to her. This is the leaked-nonce scenario.
    sim.submitBid(mallory, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.openReveal(auctioneer, AFTER_BID_END);

    sim.revealBid(mallory, AFTER_BID_END, 900n, nonceOf(1)); // nonce leaked
    expect(sim.getLedger().winner).toEqual(sim.bidderKeyOf(mallory));
    expect(sim.getLedger().lowestBid).toBe(900n);
    expect(() => sim.revealBid(alice, AFTER_BID_END, 900n, nonceOf(1))).toThrow(/not lower/i);
  });

  it('cannot compel a supplier to open a bid they sealed', () => {
    // A sealed bid is not a firm offer: declining to open it withdraws it for
    // free. The quorum rule and the cancellation path are the mitigation.
    const { sim, auctioneer, alice, bob } = openAuction();
    sim.submitBid(alice, OPENED_AT, seal(sim, 900n, nonceOf(1)));
    sim.submitBid(bob, OPENED_AT, seal(sim, 800n, nonceOf(2)));
    sim.openReveal(auctioneer, AFTER_BID_END);
    sim.revealBid(bob, AFTER_BID_END, 800n, nonceOf(2));
    sim.settle(auctioneer, AFTER_BID_END);

    expect(sim.getLedger().winner).toEqual(sim.bidderKeyOf(bob));
    // Alice sealed a bid but never opened it; her price was never published.
    expect(sim.getLedger().bidCount).toBe(2n);
    expect(sim.getLedger().lowestBid).toBe(800n);
  });
});
