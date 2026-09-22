// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

export interface AuctionTerms {
  /** Human-readable title of the procurement. */
  readonly title: string;
  /** What the supplier is being asked to deliver. */
  readonly scope: string;
  /** Maximum acceptable price, in the auction's unit. */
  readonly reservePrice: bigint;
  /** Unix seconds at which sealed bidding closes. */
  readonly bidDeadline: bigint;
  /** Unix seconds at which opening bids closes. */
  readonly revealDeadline: bigint;
  /** Distinct suppliers required before the auction may be awarded. */
  readonly requiredBidders: bigint;
  /** Name of the unit prices are expressed in (e.g. "tNIGHT"). */
  readonly unit: string;
}

/**
 * Render the lot as a Markdown document.
 *
 * The contract never stores this text — it stores `sha256(document)`. Publishing
 * the document alongside the digest lets any bidder verify that the terms they
 * are bidding against are the terms the auctioneer committed to, without the
 * auctioneer being able to change them after bids are sealed.
 */
export const renderLotDocument = (terms: AuctionTerms, network: string): string =>
  [
    `# SealedBid lot — ${terms.title}`,
    '',
    `Network: ${network}`,
    `Unit: ${terms.unit}`,
    '',
    '## Scope',
    '',
    terms.scope,
    '',
    '## Terms',
    '',
    `| Term | Value |`,
    `| --- | --- |`,
    `| Reserve price (maximum acceptable) | ${terms.reservePrice.toLocaleString()} ${terms.unit} |`,
    `| Bidding closes (unix seconds) | ${terms.bidDeadline.toLocaleString()} |`,
    `| Bidding closes (UTC) | ${new Date(Number(terms.bidDeadline) * 1000).toISOString()} |`,
    `| Opening closes (unix seconds) | ${terms.revealDeadline.toLocaleString()} |`,
    `| Opening closes (UTC) | ${new Date(Number(terms.revealDeadline) * 1000).toISOString()} |`,
    `| Suppliers required to award | ${terms.requiredBidders.toLocaleString()} |`,
    '',
    '## Rules',
    '',
    '1. A bid is sealed by committing to `sha256`-based digest of `(amount, nonce)`;',
    '   the amount never touches the ledger while bidding is open.',
    '2. Bidding closes at the deadline above. The buyer cannot close it early.',
    '3. During the opening window a supplier may open their bid only if the price',
    '   matches the sealed digest, is at or below the reserve, and is strictly',
    '   lower than every price opened so far. Prices that do not take the lead are',
    '   never published.',
    '4. The auction is awarded to the lowest opened price once the supplier quorum',
    '   is met. It cannot be cancelled once a valid price is public.',
    '',
  ].join('\n');

/** The on-chain commitment to the lot document. */
export const lotDigestOf = (document: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(document, 'utf8').digest());

/** Read an integer environment variable with a default. */
export const intFromEnv = (name: string, fallback: bigint): bigint => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, received "${raw}"`);
  return BigInt(raw);
};
