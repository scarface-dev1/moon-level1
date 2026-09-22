// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from './managed/sealed-bid-auction/contract/index.js';

/**
 * Private state for the SealedBid contract.
 *
 * It holds exactly one value: a 32-byte identity secret. Everything the
 * contract knows about *who is calling* — both the auctioneer role and each
 * supplier's sealed-bid identity — is derived from this secret inside the
 * zero-knowledge circuit via domain-separated hashes.
 *
 * The secret is never sent to the network. It is not the wallet key and it is
 * not derived from it, so an identity in this contract is unlinkable to the
 * wallet that paid for the transaction.
 */
export type SealedBidPrivateState = {
  readonly identitySecret: Uint8Array;
};

export const IDENTITY_SECRET_LENGTH = 32;

/**
 * Witness implementations. A witness is the bridge between private state and a
 * circuit that declares `witness getUserSecret(): Bytes<32>;`.
 */
export const witnesses = {
  getUserSecret: ({
    privateState,
  }: WitnessContext<Ledger, SealedBidPrivateState>): [SealedBidPrivateState, Uint8Array] => {
    const secret = privateState.identitySecret;
    if (!(secret instanceof Uint8Array)) {
      throw new Error('getUserSecret: identitySecret must be a Uint8Array');
    }
    if (secret.length !== IDENTITY_SECRET_LENGTH) {
      throw new Error(
        `getUserSecret: identitySecret must be ${IDENTITY_SECRET_LENGTH} bytes, received ${secret.length}`,
      );
    }
    return [privateState, secret];
  },
};

/** Build a private state from a raw 32-byte identity secret. */
export const privateStateFromSecret = (identitySecret: Uint8Array): SealedBidPrivateState => {
  if (!(identitySecret instanceof Uint8Array) || identitySecret.length !== IDENTITY_SECRET_LENGTH) {
    throw new Error(`identity secret must be a ${IDENTITY_SECRET_LENGTH}-byte Uint8Array`);
  }
  return { identitySecret };
};
