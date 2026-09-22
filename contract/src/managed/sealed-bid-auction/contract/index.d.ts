import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export enum AuctionPhase { Uninitialized = 0,
                           Bidding = 1,
                           Reveal = 2,
                           Settled = 3,
                           Cancelled = 4
}

export type BidderKey = Uint8Array;

export type AuctioneerKey = Uint8Array;

export type Commitment = Uint8Array;

export type Witnesses<PS> = {
  getUserSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  initializeAuction(context: __compactRuntime.CircuitContext<PS>,
                    lotDigest_0: Uint8Array,
                    reserve_0: bigint,
                    bidEnd_0: bigint,
                    revealEnd_0: bigint,
                    requiredBidCount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  submitBid(context: __compactRuntime.CircuitContext<PS>,
            commitment_0: Commitment): __compactRuntime.CircuitResults<PS, []>;
  openReveal(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  revealBid(context: __compactRuntime.CircuitContext<PS>,
            amount_0: bigint,
            nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  settle(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  cancel(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  initializeAuction(context: __compactRuntime.CircuitContext<PS>,
                    lotDigest_0: Uint8Array,
                    reserve_0: bigint,
                    bidEnd_0: bigint,
                    revealEnd_0: bigint,
                    requiredBidCount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  submitBid(context: __compactRuntime.CircuitContext<PS>,
            commitment_0: Commitment): __compactRuntime.CircuitResults<PS, []>;
  openReveal(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  revealBid(context: __compactRuntime.CircuitContext<PS>,
            amount_0: bigint,
            nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  settle(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  cancel(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
  deriveBidderKey(secret_0: Uint8Array): BidderKey;
  deriveAuctioneerKey(secret_0: Uint8Array): AuctioneerKey;
  computeCommitment(amount_0: bigint, nonce_0: Uint8Array): Commitment;
}

export type Circuits<PS> = {
  deriveBidderKey(context: __compactRuntime.CircuitContext<PS>,
                  secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, BidderKey>;
  deriveAuctioneerKey(context: __compactRuntime.CircuitContext<PS>,
                      secret_0: Uint8Array): __compactRuntime.CircuitResults<PS, AuctioneerKey>;
  computeCommitment(context: __compactRuntime.CircuitContext<PS>,
                    amount_0: bigint,
                    nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, Commitment>;
  initializeAuction(context: __compactRuntime.CircuitContext<PS>,
                    lotDigest_0: Uint8Array,
                    reserve_0: bigint,
                    bidEnd_0: bigint,
                    revealEnd_0: bigint,
                    requiredBidCount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  submitBid(context: __compactRuntime.CircuitContext<PS>,
            commitment_0: Commitment): __compactRuntime.CircuitResults<PS, []>;
  openReveal(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  revealBid(context: __compactRuntime.CircuitContext<PS>,
            amount_0: bigint,
            nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  settle(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  cancel(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  readonly phase: AuctionPhase;
  readonly auctioneer: AuctioneerKey;
  readonly lotHash: Uint8Array;
  readonly reservePrice: bigint;
  readonly bidDeadline: bigint;
  readonly revealDeadline: bigint;
  readonly bidCount: bigint;
  readonly requiredBidders: bigint;
  commitments: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: BidderKey): boolean;
    lookup(key_0: BidderKey): Commitment;
    [Symbol.iterator](): Iterator<[BidderKey, Commitment]>
  };
  readonly lowestBid: bigint;
  readonly winner: BidderKey;
  readonly hasWinner: boolean;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
