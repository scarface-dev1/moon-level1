// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import 'dotenv/config';
import * as fs from 'node:fs';
import { assertIsContractAddress } from '@midnight-ntwrk/midnight-js-utils';
import { NETWORK_CONFIGS, networkFromArgv, readDeploymentRecord, repoRoot } from './network.js';
import { hex, phaseName, readAuctionLedger } from './auction.js';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { WebSocket } from 'ws';

// @ts-expect-error the indexer provider's GraphQL client needs a global WebSocket
globalThis.WebSocket = WebSocket;

/**
 * Verify a deployment from first principles: read the public ledger state
 * straight from the network indexer, recompute the lot digest from the
 * published document, and compare both against the recorded deployment.
 *
 * Deliberately does not require a wallet, a proof server or any private
 * material — anyone can run this against a contract address.
 */
const main = async (): Promise<void> => {
  const network = networkFromArgv();
  const config = NETWORK_CONFIGS[network];
  const record = readDeploymentRecord(network);

  const addressFromArg = process.argv.find((arg) => arg.startsWith('--contract='))?.split('=')[1];
  const contractAddress = addressFromArg ?? record?.contractAddress;
  if (!contractAddress) {
    throw new Error(`No deployment recorded for ${network}. Pass --contract=<address> or deploy first.`);
  }
  assertIsContractAddress(contractAddress);

  setNetworkId(config.networkId);
  const provider = indexerPublicDataProvider(config.indexer, config.indexerWS);
  const ledger = await readAuctionLedger(
    { publicDataProvider: provider } as never,
    contractAddress as never,
  );

  if (ledger === null) {
    throw new Error(`No contract state found at ${contractAddress} on ${network}.`);
  }

  console.log('');
  console.log('  ── SealedBid verification ─────────────────────────────────────');
  console.log(`  Network:            ${network} (${config.description})`);
  console.log(`  Indexer:            ${config.indexer}`);
  console.log(`  Contract address:   ${contractAddress}`);
  console.log('');
  console.log(`  Phase:              ${phaseName(ledger.phase)}`);
  console.log(`  Auctioneer key:     ${hex(ledger.auctioneer)}`);
  console.log(`  Lot digest:         ${hex(ledger.lotHash)}`);
  console.log(`  Reserve price:      ${ledger.reservePrice.toLocaleString()}`);
  console.log(`  Bid deadline:       ${ledger.bidDeadline.toString()}`);
  console.log(`  Reveal deadline:    ${ledger.revealDeadline.toString()}`);
  console.log(`  Required bidders:   ${ledger.requiredBidders.toString()}`);
  console.log(`  Sealed bids:        ${ledger.commitments.size().toString()} (${ledger.bidCount.toString()} distinct suppliers)`);
  console.log(`  Lowest opened bid:  ${ledger.lowestBid.toString()}`);
  console.log(`  Winner:             ${ledger.hasWinner ? hex(ledger.winner) : '<none>'}`);

  const lotFile = `${repoRoot}/deployments/lot-${network}.md`;
  if (fs.existsSync(lotFile)) {
    const { lotDigestOf } = await import('./lot.js');
    const recomputed = hex(lotDigestOf(fs.readFileSync(lotFile, 'utf8')));
    const matches = recomputed === hex(ledger.lotHash);
    console.log('');
    console.log(`  Lot document:       deployments/lot-${network}.md`);
    console.log(`  Recomputed digest:  ${recomputed}`);
    console.log(`  Matches on chain:   ${matches ? 'YES' : 'NO'}`);
    if (!matches) process.exitCode = 1;
  }

  if (record) {
    const addressMatches = record.contractAddress === contractAddress;
    const digestMatches = record.lotDigest === hex(ledger.lotHash);
    console.log('');
    console.log(`  Recorded deployer:  ${record.deployer}`);
    console.log(`  Recorded at:        ${record.deployedAt}`);
    console.log(`  Address matches deploy record: ${addressMatches ? 'YES' : 'NO'}`);
    console.log(`  Lot digest matches deploy record: ${digestMatches ? 'YES' : 'NO'}`);
    if (!addressMatches || !digestMatches) process.exitCode = 1;
  }
  console.log('');
  console.log('  To reproduce this read directly, POST to the indexer:');
  console.log(`    curl -s ${config.indexer} -H 'Content-Type: application/json' \\`);
  console.log(`      -d '{"query":"{ contractAction(address:\\"${contractAddress}\\") { state } }"}'`);
  console.log('');
};

main().catch((error: unknown) => {
  console.error(`\nVerification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
