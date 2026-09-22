// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { SealedBidAuction, type SealedBidPrivateState } from '@sealedbid/contract';

/** A bid this wallet sealed, kept so it can be opened later. */
export interface SealedBid {
  /** Auction this bid belongs to (contract address, already normalised). */
  readonly auction: string;
  /** Amount that was sealed. */
  readonly amount: string;
  /** Nonce that was sealed. Must never leave this device unencrypted. */
  readonly nonce: string;
  /** Whether the bid has already been opened on chain. */
  readonly openedAt: string | null;
}

/**
 * The contract's private state, extended with this wallet's sealed-bid
 * bookkeeping.
 *
 * The circuit only ever reads `identitySecret` through `getUserSecret`; the
 * `sealedBids` list is local bookkeeping that lives in the same encrypted blob
 * so bid amounts and nonces are encrypted at rest by the level private state
 * provider.
 */
export type AuctionPrivateState = SealedBidPrivateState & {
  readonly sealedBids: readonly SealedBid[];
};

export const EMPTY_PRIVATE_STATE: AuctionPrivateState = {
  identitySecret: new Uint8Array(0),
  sealedBids: [],
};

export const newIdentitySecret = (): Uint8Array => new Uint8Array(randomBytes(32));

export const newNonce = (): Uint8Array => new Uint8Array(randomBytes(32));

export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'));

/** Build the identity secret + bookkeeping for a fresh wallet. */
export const initialPrivateState = (): AuctionPrivateState => ({
  identitySecret: newIdentitySecret(),
  sealedBids: [],
});

/** Seal a bid off chain exactly as the circuit will recompute it. */
export const sealBid = (amount: bigint, nonce: Uint8Array): Uint8Array =>
  SealedBidAuction.pureCircuits.computeCommitment(amount, nonce);

/** This wallet's on-ledger identity for a given auction. */
export const bidderKeyOf = (identitySecret: Uint8Array): Uint8Array =>
  SealedBidAuction.pureCircuits.deriveBidderKey(identitySecret);

/** Record a newly sealed bid in private state. */
export const recordSealedBid = (
  state: AuctionPrivateState,
  auction: string,
  amount: bigint,
  nonce: Uint8Array,
): AuctionPrivateState => ({
  ...state,
  sealedBids: [...state.sealedBids, { auction, amount: amount.toString(), nonce: toHex(nonce), openedAt: null }],
});

/** The latest still-unopened sealed bid registered for an auction. */
export const findOpenableBid = (state: AuctionPrivateState, auction: string): SealedBid | undefined =>
  [...state.sealedBids].reverse().find((bid) => bid.auction === auction && bid.openedAt === null);

/** Mark a sealed bid as opened. */
export const markBidOpened = (state: AuctionPrivateState, opened: SealedBid): AuctionPrivateState => ({
  ...state,
  sealedBids: state.sealedBids.map((bid) =>
    bid.auction === opened.auction && bid.nonce === opened.nonce
      ? { ...bid, openedAt: new Date().toISOString() }
      : bid,
  ),
});
