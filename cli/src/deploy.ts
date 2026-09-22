// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import { bootstrap, shutdown } from './bootstrap.js';
import { NETWORK_CONFIGS, networkFromArgv, repoRoot, writeDeploymentRecord } from './network.js';
import { deployAuction, hex, makeCompiledContract, phaseName, readAuctionLedger } from './auction.js';
import { initialPrivateState, toHex } from './private-state.js';
import { intFromEnv, lotDigestOf, renderLotDocument, type AuctionTerms } from './lot.js';

const CONTRACT_PACKAGE_VERSION = '1.0.0';
const COMPILER_VERSION = '0.31.1';
const LANGUAGE_VERSION = '0.23.0';

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

const main = async (): Promise<void> => {
  const network = networkFromArgv();
  const config = NETWORK_CONFIGS[network];

  console.log('');
  console.log('  ── SealedBid deploy ───────────────────────────────────────────');
  console.log(`  Deploying the sealed-bid auction to ${network}.`);
  console.log('');

  const session = await bootstrap(network);

  // Build the lot. The on-chain state is only the digest, so the document is
  // written next to the deployment record for anyone to verify against.
  const bidWindow = intFromEnv('SEALEDBID_BID_WINDOW_SECONDS', 900n);
  const revealWindow = intFromEnv('SEALEDBID_REVEAL_WINDOW_SECONDS', 900n);
  const bidDeadline = nowSeconds() + bidWindow;
  const terms: AuctionTerms = {
    title: process.env.SEALEDBID_LOT_TITLE ?? 'Supply of 40 rack-mount compute nodes',
    scope:
      process.env.SEALEDBID_LOT_SCOPE ??
      [
        'Supply, deliver and install 40 rack-mount compute nodes to the specification',
        'published with this lot. Award is on lowest conforming price; the buyer may',
        'reject any price above the reserve price.',
      ].join(' '),
    reservePrice: intFromEnv('SEALEDBID_RESERVE', 1_000_000n),
    bidDeadline,
    revealDeadline: bidDeadline + revealWindow,
    requiredBidders: intFromEnv('SEALEDBID_REQUIRED_BIDDERS', 1n),
    unit: process.env.SEALEDBID_UNIT ?? 'tNIGHT',
  };

  const lotDocument = renderLotDocument(terms, network);
  const lotDigest = lotDigestOf(lotDocument);
  console.log(`  Lot digest: ${hex(lotDigest)}`);

  const compiled = makeCompiledContract(session.zkConfigPath);
  const privateState = initialPrivateState();

  console.log('');
  console.log('  Deploying contract...');
  const auction = await deployAuction(session.providers, compiled, privateState);
  console.log(`  Contract address: ${auction.contractAddress}`);

  console.log('  Initialising the auction...');
  const initTx = await auction.callTx.initializeAuction(
    lotDigest,
    terms.reservePrice,
    terms.bidDeadline,
    terms.revealDeadline,
    terms.requiredBidders,
  );

  const ledger = await readAuctionLedger(session.providers, auction.contractAddress);
  if (ledger === null) {
    throw new Error('The auction was deployed but its ledger state could not be read back from the indexer.');
  }

  // Records are public on-chain data, so they are committed to the repository.
  const record = {
    network,
    contractAddress: auction.contractAddress,
    deployedAt: new Date().toISOString(),
    deployer: session.address,
    deploymentTxId: auction.deploymentTxId,
    deploymentBlockHeight: auction.deploymentBlockHeight,
    initializeTxId: initTx.public.txId,
    initializeBlockHeight: initTx.public.blockHeight,
    lotDigest: hex(lotDigest),
    lotDocument: `deployments/lot-${network}.md`,
    lotTitle: terms.title,
    reservePrice: terms.reservePrice.toString(),
    unit: terms.unit,
    bidDeadline: terms.bidDeadline.toString(),
    revealDeadline: terms.revealDeadline.toString(),
    requiredBidders: terms.requiredBidders.toString(),
    auctioneerKey: hex(ledger.auctioneer),
    phase: phaseName(ledger.phase),
    compilerVersion: COMPILER_VERSION,
    languageVersion: LANGUAGE_VERSION,
    packageVersion: CONTRACT_PACKAGE_VERSION,
    indexerEndpoint: config.indexer,
  };

  const recordFile = writeDeploymentRecord(record );
  const lotFile = `${repoRoot}/deployments/lot-${network}.md`;
  fs.writeFileSync(lotFile, lotDocument);

  console.log('');
  console.log('  ── Deployed ───────────────────────────────────────────────────');
  console.log(`  Network:          ${network} (${config.description})`);
  console.log(`  Contract address: ${auction.contractAddress}`);
  console.log(`  Phase:            ${phaseName(ledger.phase)}`);
  console.log(`  Auctioneer key:   ${hex(ledger.auctioneer)}`);
  console.log(`  Lot digest:       ${hex(lotDigest)}`);
  console.log(`  Deploy record:    ${recordFile.replace(`${repoRoot}/`, '')}`);
  console.log(`  Lot document:     deployments/lot-${network}.md`);
  console.log('');
  console.log('  Verify with:      npm --workspace @sealedbid/cli run verify -- --network ' + network);
  console.log('');

  await shutdown(session);
};

main().catch((error: unknown) => {
  console.error(`\nDeploy failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
