// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import 'dotenv/config';
import { NETWORK_CONFIGS, resolveWallet, type NetworkConfig, type NetworkId } from './network.js';
import { buildWallet, ensureDust, nightBalance, stopWallet, waitForFunds, waitForSync } from './wallet.js';
import { assertProofServerReady, configureProviders, resolveZkConfigPath, type Providers } from './providers.js';

export interface Session {
  readonly network: NetworkId;
  readonly config: NetworkConfig;
  readonly seed: string;
  readonly address: string;
  readonly wallet: Awaited<ReturnType<typeof buildWallet>>;
  readonly providers: Providers;
  readonly zkConfigPath: string;
}

export interface BootstrapOptions {
  /** Skip the DUST wait (the address and verify commands do not submit). */
  readonly needsDust?: boolean;
  /** Skip funding checks entirely. */
  readonly needsFunds?: boolean;
}

/**
 * Bring up everything a command needs: wallet, sync, funds, DUST and providers.
 *
 * Every step prints what it is doing and fails with an actionable message
 * rather than hanging, because the most common failure modes on Midnight are
 * external (no proof server, unfunded address, no DUST yet).
 */
export const bootstrap = async (network: NetworkId, options: BootstrapOptions = {}): Promise<Session> => {
  const config = NETWORK_CONFIGS[network];
  const zkConfigPath = resolveZkConfigPath();

  const resolved = resolveWallet(network);
  console.log(`  Network:  ${network} (${config.description})`);
  console.log(`  Wallet:   ${resolved.source === 'newly generated' ? 'newly generated seed' : `seed from ${resolved.source}`}`);
  if (resolved.created) {
    console.log('            stored in cli/.midnight-wallet.json (gitignored, mode 0600)');
  }

  if (options.needsFunds !== false) {
    await assertProofServerReady(config.proofServer);
    process.stdout.write('\r  Proof server is ready.                                 \n');
  }

  const wallet = await buildWallet(network, config, resolved.seed);
  const address = wallet.unshieldedKeystore.getBech32Address().toString();
  console.log(`  Address:  ${address}`);

  await waitForSync(wallet.wallet);

  if (options.needsFunds !== false) {
    const before = await nightBalance(wallet.wallet);
    if (before === 0n) {
      printFundingInstructions(network, config, address);
      const funded = await waitForFunds(wallet.wallet);
      if (funded === 0n) {
        await stopWallet(wallet);
        throw new Error(
          `The address ${address} was not funded in time. Fund it and re-run; the seed is preserved.`,
        );
      }
      console.log(`\n  Funded: ${funded.toLocaleString()} tNIGHT.`);
    } else {
      console.log(`  Balance:  ${before.toLocaleString()} tNIGHT`);
    }
  }

  if (options.needsDust !== false && options.needsFunds !== false) {
    const dust = await ensureDust(wallet);
    console.log(`  DUST:     ${dust.toLocaleString()}`);
  }

  const providers = await configureProviders(wallet, config, zkConfigPath);

  return { network, config, seed: resolved.seed, address, wallet, providers, zkConfigPath };
};

export const printFundingInstructions = (network: NetworkId, config: NetworkConfig, address: string): void => {
  console.log('');
  console.log('  ── Fund this address ──────────────────────────────────────────');
  console.log(`  Address: ${address}`);
  if (config.faucet) {
    console.log(`  Faucet:  ${config.faucet}`);
  } else {
    console.log('  The local devnet pre-mints NIGHT to the genesis seed, so this');
    console.log('  address should already be funded. If it is not, check:');
    console.log('    docker compose -f devnet.yml ps');
  }
  console.log('  ───────────────────────────────────────────────────────────────');
  console.log('');
  void network;
};

export const shutdown = async (session: Session): Promise<void> => {
  await stopWallet(session.wallet);
};
