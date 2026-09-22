// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type CircuitContext,
  type ContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  ledger,
  pureCircuits,
  AuctionPhase,
  type Ledger,
} from '../managed/sealed-bid-auction/contract/index.js';
import { privateStateFromSecret, witnesses, type SealedBidPrivateState } from '../witnesses.js';

/** An on-chain participant: a name plus the private secret that identifies it. */
export type Actor = {
  readonly name: string;
  readonly secret: Uint8Array;
};

/**
 * Deterministically derive a 32-byte identity secret from a label.
 *
 * Tests must be reproducible, and actors must be distinct, so secrets are
 * derived rather than randomly generated. The derivation is a plain SHA-256
 * over a domain-separated label and has nothing to do with the contract's own
 * hash functions.
 */
export const actorFromLabel = (label: string): Actor => ({
  name: label,
  secret: new Uint8Array(createHash('sha256').update(`sealedbid:test-actor:${label}`).digest()),
});

/**
 * An in-process simulation of the SealedBid contract.
 *
 * Every circuit call is executed by the real generated Compact circuit against
 * the real compact-runtime, so the assertions, the commitment check and the
 * ledger transitions under test are exactly the ones that run on chain. What is
 * simulated is only the surrounding machinery: there is no proof server, no
 * wallet and no block production, so we can drive time and switch caller
 * identity freely.
 *
 * A failed circuit throws, and — because the updated context is only stored on
 * success — it leaves the simulated ledger untouched, mirroring the atomicity
 * of a real transaction.
 */
export class AuctionSimulation {
  readonly contract: Contract<SealedBidPrivateState>;
  readonly address: ContractAddress;

  private context: CircuitContext<SealedBidPrivateState>;

  constructor(auctioneer: Actor, time = 0) {
    this.contract = new Contract<SealedBidPrivateState>(witnesses);
    this.address = sampleContractAddress();

    const { currentPrivateState, currentContractState, currentZswapLocalState } = this.contract.initialState(
      createConstructorContext(privateStateFromSecret(auctioneer.secret), '0'.repeat(64)),
    );

    this.context = createCircuitContext(
      this.address,
      currentZswapLocalState,
      currentContractState,
      currentPrivateState,
      undefined,
      undefined,
      time,
    );
  }

  // ------------------------------ reads -----------------------------------

  /** The current public ledger state. */
  getLedger(): Ledger {
    return ledger(this.context.currentQueryContext.state);
  }

  /** The current lifecycle phase. */
  getPhase(): AuctionPhase {
    return this.getLedger().phase;
  }

  /** The private secret currently loaded in the simulation (for the active caller). */
  getActiveSecret(): Uint8Array {
    return this.context.currentPrivateState.identitySecret;
  }

  // --------------------------- pure helpers --------------------------------

  /** Off-chain derivation of an actor's on-ledger identity. */
  bidderKeyOf(actor: Actor): Uint8Array {
    return pureCircuits.deriveBidderKey(actor.secret);
  }

  /** Off-chain derivation of the auctioneer identity. */
  auctioneerKeyOf(actor: Actor): Uint8Array {
    return pureCircuits.deriveAuctioneerKey(actor.secret);
  }

  /** Off-chain sealing of a bid, identical to what the circuit recomputes. */
  seal(amount: bigint, nonce: Uint8Array): Uint8Array {
    return pureCircuits.computeCommitment(amount, nonce);
  }

  // ------------------------------ circuits ---------------------------------

  initializeAuction(
    actor: Actor,
    time: number,
    lotDigest: Uint8Array,
    reserve: bigint,
    bidEnd: bigint,
    revealEnd: bigint,
    requiredBidCount: bigint,
  ): void {
    this.run(
      'initializeAuction',
      actor,
      time,
      (ctx) => this.contract.impureCircuits.initializeAuction(ctx, lotDigest, reserve, bidEnd, revealEnd, requiredBidCount),
    );
  }

  submitBid(actor: Actor, time: number, commitment: Uint8Array): void {
    this.run('submitBid', actor, time, (ctx) => this.contract.impureCircuits.submitBid(ctx, commitment));
  }

  openReveal(actor: Actor, time: number): void {
    this.run('openReveal', actor, time, (ctx) => this.contract.impureCircuits.openReveal(ctx));
  }

  revealBid(actor: Actor, time: number, amount: bigint, nonce: Uint8Array): void {
    this.run('revealBid', actor, time, (ctx) => this.contract.impureCircuits.revealBid(ctx, amount, nonce));
  }

  settle(actor: Actor, time: number): void {
    this.run('settle', actor, time, (ctx) => this.contract.impureCircuits.settle(ctx));
  }

  cancel(actor: Actor, time: number): void {
    this.run('cancel', actor, time, (ctx) => this.contract.impureCircuits.cancel(ctx));
  }

  // ------------------------------ internals --------------------------------

  /**
   * Execute one circuit call as `actor` at wall-clock `time`.
   *
   * `time` is the block time the circuit observes through `blockTimeLt` /
   * `blockTimeGt`, which is how the deadline logic is exercised without
   * waiting for real seconds to pass.
   */
  private run<R>(
    name: string,
    actor: Actor,
    time: number,
    call: (ctx: CircuitContext<SealedBidPrivateState>) => { context: CircuitContext<SealedBidPrivateState>; result: R },
  ): R {
    const prepared: CircuitContext<SealedBidPrivateState> = {
      ...this.context,
      // Swap in the caller's private state: this is what makes `actor` the
      // identity the circuit derives and authorises against.
      currentPrivateState: privateStateFromSecret(actor.secret),
    };
    const withTime = createCircuitContext(
      this.address,
      prepared.currentZswapLocalState,
      prepared.currentQueryContext.state,
      prepared.currentPrivateState,
      undefined,
      undefined,
      time,
    );

    let outcome: { context: CircuitContext<SealedBidPrivateState>; result: R };
    try {
      outcome = call(withTime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CircuitError(name, actor.name, time, message);
    }

    this.context = outcome.context;
    return outcome.result;
  }
}

/** A circuit failure, annotated with the caller and block time for diagnostics. */
export class CircuitError extends Error {
  constructor(
    readonly circuit: string,
    readonly actor: string,
    readonly time: number,
    readonly reason: string,
  ) {
    super(`${circuit} (actor=${actor}, time=${time}) failed: ${reason}`);
    this.name = 'CircuitError';
  }
}
