// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import 'dotenv/config';
import { NETWORK_CONFIGS, networkFromArgv, resolveWallet } from './network.js';
import { buildWallet, stopWallet } from './wallet.js';

/**
 * Print the address this CLI will use, so it can be funded before a deploy.
 *
 * Deliberately does not sync: deriving an address is local and instant, and the
 * whole point is to show it *before* a long sync. Does not need funds, DUST or
 * a proof server. If the wallet file does not exist yet, this is what creates
 * it, with 0600 permissions.
 */
const main = async (): Promise<void> => {
  const network = networkFromArgv();
  const config = NETWORK_CONFIGS[network];
  const resolved = resolveWallet(network);

  const wallet = await buildWallet(network, config, resolved.seed);
  const address = wallet.unshieldedKeystore.getBech32Address().toString();
  await stopWallet(wallet);

  console.log('');
  console.log(`  Network:  ${network} (${config.description})`);
  console.log(`  Seed:     ${resolved.source}`);
  console.log(`  Address:  ${address}`);
  if (config.faucet) {
    console.log(`  Faucet:   ${config.faucet}`);
  }
  console.log('');
  console.log('  Send tNIGHT to the address above, then run the deploy command.');
  console.log('');
};

main().catch((error: unknown) => {
  console.error(`\nAddress lookup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
