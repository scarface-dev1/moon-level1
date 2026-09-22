// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { bootstrap, shutdown } from './bootstrap.js';
import { NETWORK_CONFIGS, networkFromArgv } from './network.js';
import { deployAuction, hex, makeCompiledContract, phaseName, readAuctionLedger } from './auction.js';
import { bidderKeyOf, initialPrivateState, newNonce, sealBid } from './private-state.js';
import { intFromEnv, lotDigestOf, renderLotDocument } from './lot.js';
import { submitWithRetry } from './submit.js';

/**
 * Drive one complete auction on a live network, exercising all six circuits.
 *
 * This is the strongest end-to-end check the repository has: every circuit is
 * proved by the real proof server, submitted to a real node and read back from
 * the real indexer. Distinct suppliers are covered exhaustively by the contract
 * test suite; this script deliberately uses a single funded wallet so it can
 * run anywhere without a second funded account, which means it exercises the
 * auctioneer role and one supplier identity.
 *
 * The bidding window is short by design so the deadline rules can be observed
 * for real rather than mocked.
 */
const main = async (): Promise<void> => {
  const network = networkFromArgv();
  const config = NETWORK_CONFIGS[network];
  // The window has to survive deployment plus the DUST settle delay before
  // `initializeAuction` runs, so it defaults to a comfortable margin.
  const bidWindow = intFromEnv('SEALEDBID_DEMO_BID_WINDOW_SECONDS', 90n);

  console.log('');
  console.log('  ── SealedBid live walkthrough ─────────────────────────────────');
  console.log(`  Network: ${network} (${config.description})`);
  console.log('');

  const session = await bootstrap(network);
  const compiled = makeCompiledContract(session.zkConfigPath);
  const privateState = initialPrivateState();

  console.log(`  My bidder identity: ${hex(bidderKeyOf(privateState.identitySecret))}`);
  console.log('');

  // 1. Deploy.
  const auction = await deployAuction(session.providers, compiled, privateState);
  console.log(`  [deploy]          address ${auction.contractAddress}`);
  if (auction.deploymentTxId) console.log(`                    tx ${auction.deploymentTxId} in block ${auction.deploymentBlockHeight}`);

  // The lot terms are fixed only now: the bidding window must still be in the
  // future when `initializeAuction` lands, and deployment takes real time.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const terms = {
    title: 'Live walkthrough lot',
    scope: 'A short-lived lot used to exercise every SealedBid circuit on chain.',
    reservePrice: intFromEnv('SEALEDBID_RESERVE', 1_000_000n),
    bidDeadline: now + bidWindow,
    revealDeadline: now + bidWindow + 600n,
    requiredBidders: 1n,
    unit: process.env.SEALEDBID_UNIT ?? 'tNIGHT',
  };
  const document = renderLotDocument(terms, network);
  const digest = lotDigestOf(document);

  // 2. Initialize.
  const init = await submitWithRetry('initializeAuction', () =>
    auction.callTx.initializeAuction(
      digest,
      terms.reservePrice,
      terms.bidDeadline,
      terms.revealDeadline,
      terms.requiredBidders,
    ),
  );
  console.log(`  [initializeAuction] tx ${init.public.txId} in block ${init.public.blockHeight}`);

  // 3. Seal a bid. Only the digest reaches the ledger.
  const amount = terms.reservePrice - 123_456n;
  const nonce = newNonce();
  const commitment = sealBid(amount, nonce);
  const bidTx = await submitWithRetry('submitBid', () => auction.callTx.submitBid(commitment));
  console.log(`  [submitBid]       tx ${bidTx.public.txId} in block ${bidTx.public.blockHeight}`);
  console.log(`                    sealed ${amount} as ${hex(commitment)}`);

  // 4. The reveal window must not open before the deadline. Prove that on chain
  //    by trying early and checking the circuit refuses.
  let earlyRefusal: string | null = null;
  try {
    await submitWithRetry('openReveal (early)', () => auction.callTx.openReveal(), { settleMs: 6_000 });
    throw new Error('openReveal unexpectedly succeeded before the bid deadline');
  } catch (error) {
    earlyRefusal = error instanceof Error ? error.message : String(error);
  }
  console.log(`  Early openReveal refused: ${/not closed yet/i.test(earlyRefusal) ? 'YES (as designed)' : earlyRefusal}`);

  // 5. Wait for the deadline, then open the reveal window.
  console.log(`  Waiting for the ${bidWindow}s bidding window to close...`);
  let opened: { public: { txId: string; blockHeight: number } } | null = null;
  const deadline = Date.now() + Number(bidWindow) * 1000 + 20_000;
  while (Date.now() < deadline) {
    try {
      opened = await submitWithRetry('openReveal', () => auction.callTx.openReveal(), { settleMs: 0, attempts: 3 });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not closed yet/i.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  if (!opened) throw new Error('The bidding window never closed; openReveal was refused throughout.');
  console.log(`  [openReveal]      tx ${opened.public.txId} in block ${opened.public.blockHeight}`);

  // 6. Open the sealed bid. The circuit recomputes the commitment.
  const revealTx = await submitWithRetry('revealBid', () => auction.callTx.revealBid(amount, nonce));
  console.log(`  [revealBid]       tx ${revealTx.public.txId} in block ${revealTx.public.blockHeight}`);

  // 7. Award.
  const settleTx = await submitWithRetry('settle', () => auction.callTx.settle());
  console.log(`  [settle]          tx ${settleTx.public.txId} in block ${settleTx.public.blockHeight}`);

  // 8. Read the result back from the network, not from local state.
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const ledger = await readAuctionLedger(session.providers, auction.contractAddress);
  if (!ledger) throw new Error('Could not read the auction back from the indexer.');

  console.log('');
  console.log('  ── On-chain result ────────────────────────────────────────────');
  console.log(`  Contract address:   ${auction.contractAddress}`);
  console.log(`  Phase:              ${phaseName(ledger.phase)}`);
  console.log(`  Sealed bids:        ${ledger.commitments.size().toString()}`);
  console.log(`  Lowest opened bid:  ${ledger.lowestBid.toString()} (expected ${amount.toString()})`);
  console.log(`  Winner:             ${hex(ledger.winner)}`);
  console.log(`  Winner is me:       ${hex(ledger.winner) === hex(bidderKeyOf(privateState.identitySecret)) ? 'YES' : 'NO'}`);
  console.log(`  Lot digest matches: ${hex(ledger.lotHash) === hex(digest) ? 'YES' : 'NO'}`);
  console.log('');

  // 9. Cancellation on a separate auction, to cover the sixth circuit. This
  //    lot needs its own deadlines: the first lot's window has now closed.
  const secondNow = BigInt(Math.floor(Date.now() / 1000));
  const second = await deployAuction(session.providers, compiled, privateState);
  await submitWithRetry('initializeAuction (second lot)', () =>
    second.callTx.initializeAuction(digest, terms.reservePrice, secondNow + bidWindow, secondNow + bidWindow + 600n, 1n),
  );
  const cancelTx = await submitWithRetry('cancel', () => second.callTx.cancel());
  console.log(`  [cancel]          tx ${cancelTx.public.txId} in block ${cancelTx.public.blockHeight}`);
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const cancelled = await readAuctionLedger(session.providers, second.contractAddress);
  console.log(`  Cancelled auction ${second.contractAddress} phase: ${cancelled ? phaseName(cancelled.phase) : '?'}`);
  console.log('');

  await shutdown(session);
};

main().catch((error: unknown) => {
  console.error(`\nWalkthrough failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
