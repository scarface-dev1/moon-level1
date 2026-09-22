// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import 'dotenv/config';
import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { bootstrap, shutdown, type Session } from './bootstrap.js';
import { NETWORK_CONFIGS, networkFromArgv, readDeploymentRecord, repoRoot } from './network.js';
import {
  deployAuction,
  hex,
  joinAuction,
  makeCompiledContract,
  phaseName,
  readAuctionLedger,
  type CircuitCallTx,
} from './auction.js';
import {
  bidderKeyOf,
  findOpenableBid,
  fromHex,
  initialPrivateState,
  markBidOpened,
  newNonce,
  recordSealedBid,
  sealBid,
  toHex,
  type AuctionPrivateState,
  type SealedBid,
} from './private-state.js';
import { intFromEnv, lotDigestOf, renderLotDocument } from './lot.js';
import { PRIVATE_STATE_ID } from './auction.js';

const rl = readline.createInterface({ input, output });

const ask = async (question: string): Promise<string> => (await rl.question(`  ${question} `)).trim();

const askBigInt = async (question: string): Promise<bigint> => {
  while (true) {
    const raw = await ask(question);
    if (/^[0-9]+$/.test(raw)) return BigInt(raw);
    console.log('  Please enter a whole number.');
  }
};

const readPrivateState = async (session: Session, fallback: AuctionPrivateState): Promise<AuctionPrivateState> => {
  const stored = (await session.providers.privateStateProvider.get(PRIVATE_STATE_ID)) as AuctionPrivateState | null;
  if (stored && stored.identitySecret && stored.identitySecret.length === 32) {
    return { identitySecret: stored.identitySecret, sealedBids: stored.sealedBids ?? [] };
  }
  await session.providers.privateStateProvider.set(PRIVATE_STATE_ID, fallback );
  return fallback;
};

const savePrivateState = async (session: Session, state: AuctionPrivateState): Promise<void> => {
  await session.providers.privateStateProvider.set(PRIVATE_STATE_ID, state );
};

const printLedger = async (session: Session, address: string): Promise<void> => {
  const ledger = await readAuctionLedger(session.providers, address);
  if (ledger === null) {
    console.log(`  No contract state at ${address} on ${session.network}.`);
    return;
  }
  console.log('');
  console.log(`  Contract:          ${address}`);
  console.log(`  Phase:             ${phaseName(ledger.phase)}`);
  console.log(`  Auctioneer key:    ${hex(ledger.auctioneer)}`);
  console.log(`  Lot digest:        ${hex(ledger.lotHash)}`);
  console.log(`  Reserve price:     ${ledger.reservePrice.toLocaleString()}`);
  console.log(`  Bid deadline:      ${ledger.bidDeadline.toString()}`);
  console.log(`  Reveal deadline:   ${ledger.revealDeadline.toString()}`);
  console.log(`  Required bidders:  ${ledger.requiredBidders.toString()}`);
  console.log(`  Sealed bids:       ${ledger.commitments.size().toString()} (${ledger.bidCount.toString()} distinct)  <- prices hidden`);
  console.log(`  Lowest opened bid: ${ledger.lowestBid.toString()}`);
  console.log(`  Winner:            ${ledger.hasWinner ? hex(ledger.winner) : '<none yet>'}`);
  console.log('');
};

const main = async (): Promise<void> => {
  const network = networkFromArgv();
  console.log('');
  console.log('  ── SealedBid CLI ──────────────────────────────────────────────');
  console.log('');

  const session = await bootstrap(network);
  const compiled = makeCompiledContract(session.zkConfigPath);

  const record = readDeploymentRecord(network);
  let activeAddress = record?.contractAddress ?? null;
  const callTx: { current: CircuitCallTx | null } = { current: null };
  let privateState: AuctionPrivateState = await readPrivateState(session, initialPrivateState());

  console.log(`  My bidder key: ${hex(bidderKeyOf(privateState.identitySecret))}`);
  if (activeAddress) console.log(`  Known auction: ${activeAddress} (from deployments/${network}.json)`);

  const attach = async (address: string): Promise<void> => {
    const joined = await joinAuction(session.providers, compiled, address, privateState);
    activeAddress = joined.contractAddress;
    callTx.current = joined.callTx;
    console.log(`  Attached to ${activeAddress}`);
  };

  const requireAttached = (): string => {
    if (!activeAddress || !callTx.current) {
      throw new Error('No auction is attached. Deploy or join one first (options 1 or 2).');
    }
    return activeAddress;
  };

  for (;;) {
    const ledger = activeAddress ? await readAuctionLedger(session.providers, activeAddress) : null;
    console.log('  ───────────────────────────────────────────────────────────────');
    console.log(`  Auction: ${activeAddress ?? '<none attached>'}   Phase: ${ledger ? phaseName(ledger.phase) : '-'}`);
    console.log('  ───────────────────────────────────────────────────────────────');
    console.log('   [1] Deploy a new auction');
    console.log('   [2] Join an existing auction');
    console.log('   [3] Seal a bid (supplier)');
    console.log('   [4] Open a sealed bid (supplier)');
    console.log('   [5] Show auction state');
    console.log('   [6] Close bidding / open the reveal window (auctioneer)');
    console.log('   [7] Award the auction (auctioneer)');
    console.log('   [8] Cancel the auction (auctioneer)');
    console.log('   [9] Show wallet and my sealed bids');
    console.log('   [0] Exit');
    const choice = await ask('Choose:');

    try {
      switch (choice) {
        case '1': {
          const bidWindow = intFromEnv('SEALEDBID_BID_WINDOW_SECONDS', 900n);
          const revealWindow = intFromEnv('SEALEDBID_REVEAL_WINDOW_SECONDS', 900n);
          const now = BigInt(Math.floor(Date.now() / 1000));
          const terms = {
            title: process.env.SEALEDBID_LOT_TITLE ?? 'Supply of 40 rack-mount compute nodes',
            scope: process.env.SEALEDBID_LOT_SCOPE ?? 'Supply, deliver and install 40 rack-mount compute nodes.',
            reservePrice: intFromEnv('SEALEDBID_RESERVE', 1_000_000n),
            bidDeadline: now + bidWindow,
            revealDeadline: now + bidWindow + revealWindow,
            requiredBidders: intFromEnv('SEALEDBID_REQUIRED_BIDDERS', 1n),
            unit: process.env.SEALEDBID_UNIT ?? 'tNIGHT',
          };
          const document = renderLotDocument(terms, network);
          const digest = lotDigestOf(document);
          const deployed = await deployAuction(session.providers, compiled, privateState);
          callTx.current = deployed.callTx;
          activeAddress = deployed.contractAddress;
          await deployed.callTx.initializeAuction(
            digest,
            terms.reservePrice,
            terms.bidDeadline,
            terms.revealDeadline,
            terms.requiredBidders,
          );
          fs.mkdirSync(`${repoRoot}/deployments`, { recursive: true });
          fs.writeFileSync(`${repoRoot}/deployments/lot-${network}.md`, document);
          console.log(`  Deployed and initialised at ${activeAddress}`);
          console.log(`  Lot digest ${hex(digest)} (document in deployments/lot-${network}.md)`);
          break;
        }
        case '2': {
          const address = await ask('Contract address:');
          await attach(address);
          break;
        }
        case '3': {
          const address = requireAttached();
          const amount = await askBigInt('Bid amount (hidden until you open it):');
          const nonce = newNonce();
          const commitment = sealBid(amount, nonce);
          await callTx.current!.submitBid(commitment);
          privateState = recordSealedBid(privateState, address, amount, nonce);
          await savePrivateState(session, privateState);
          console.log(`  Sealed. Commitment ${hex(commitment)}`);
          console.log('  The price did not go on chain. Keep this wallet — it holds the nonce.');
          break;
        }
        case '4': {
          const address = requireAttached();
          const sealed = findOpenableBid(privateState, address);
          if (!sealed) throw new Error('This wallet has no unopened sealed bid for that auction.');
          const tx = await callTx.current!.revealBid(BigInt(sealed.amount), fromHex(sealed.nonce));
          privateState = markBidOpened(privateState, sealed);
          await savePrivateState(session, privateState);
          console.log(`  Opened bid: ${sealed.amount}`);
          console.log(`  Transaction ${tx.public.txId} in block ${tx.public.blockHeight}`);
          break;
        }
        case '5': {
          await printLedger(session, requireAttached());
          break;
        }
        case '6': {
          requireAttached();
          const tx = await callTx.current!.openReveal();
          console.log(`  Reveal window open. Transaction ${tx.public.txId}`);
          break;
        }
        case '7': {
          requireAttached();
          const tx = await callTx.current!.settle();
          console.log(`  Awarded. Transaction ${tx.public.txId}`);
          break;
        }
        case '8': {
          requireAttached();
          const tx = await callTx.current!.cancel();
          console.log(`  Cancelled. Transaction ${tx.public.txId}`);
          break;
        }
        case '9': {
          console.log('');
          console.log(`  Address:       ${session.address}`);
          console.log(`  Network:       ${network} (${NETWORK_CONFIGS[network].description})`);
          console.log(`  My bidder key: ${hex(bidderKeyOf(privateState.identitySecret))}`);
          console.log(`  Sealed bids:   ${privateState.sealedBids.length}`);
          for (const bid of privateState.sealedBids as readonly SealedBid[]) {
            console.log(`    - ${bid.auction} amount=${bid.amount} opened=${bid.openedAt ?? 'no'}`);
          }
          console.log('  Nonces are never printed; they live in encrypted private state.');
          console.log('');
          break;
        }
        case '0':
          await shutdown(session);
          rl.close();
          console.log('  Bye.');
          return;
        default:
          console.log('  Unknown option.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  Failed: ${message}`);
      console.log('  (A failed circuit changes nothing on chain.)');
    }
  }
};

main().catch(async (error: unknown) => {
  console.error(`\nCLI failed: ${error instanceof Error ? error.message : String(error)}\n`);
  rl.close();
  process.exit(1);
});
