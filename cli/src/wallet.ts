// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from 'node:buffer';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  DustWallet,
  HDWallet,
  NoOpTransactionHistoryStorage,
  PublicKey,
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  WalletFacade,
  createKeystore,
} from '@midnight-ntwrk/wallet-sdk';
import * as Rx from 'rxjs';
import type { NetworkConfig, NetworkId } from './network.js';

/** How long to wait for DUST to be generated from registered NIGHT. */
const DUST_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export interface WalletContext {
  readonly wallet: Awaited<ReturnType<typeof WalletFacade.init>>;
  readonly shieldedSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  readonly dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  readonly unshieldedKeystore: ReturnType<typeof createKeystore>;
}

const deriveKeys = (seed: string) => {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid wallet seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();
  return result.keys;
};

export const buildWallet = async (network: NetworkId, config: NetworkConfig, seed: string): Promise<WalletContext> => {
  setNetworkId(config.networkId);

  const keys = deriveKeys(seed);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], config.networkId as never);

  const walletConfig = {
    networkId: config.networkId,
    indexerClientConnection: {
      indexerHttpUrl: config.indexer,
      indexerWsUrl: config.indexerWS,
    },
    provingServerUrl: new URL(config.proofServer),
    relayURL: new URL(config.node.replace(/^http/, 'ws')),
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };

  const wallet = await WalletFacade.init({
    configuration: walletConfig,
    shielded: async (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: async (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: async (cfg) =>
      DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);
  void network;

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
};

/** Wait until the wallet has caught up with the chain, with progress output. */
export const waitForSync = async (wallet: WalletContext['wallet']): Promise<void> => {
  const started = Date.now();
  const ticker = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`\r  ...syncing (${elapsed}s elapsed)   `);
  }, 5_000);
  try {
    await wallet.waitForSyncedState();
  } finally {
    clearInterval(ticker);
    process.stdout.write('\r  synced with the network.                          \n');
  }
};

export const nightBalance = async (wallet: WalletContext['wallet']): Promise<bigint> => {
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  return state.unshielded.balances[unshieldedToken().raw] ?? 0n;
};

export const dustBalance = async (wallet: WalletContext['wallet']): Promise<bigint> => {
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  return state.dust.balance(new Date());
};

/**
 * Poll until NIGHT arrives. On the local devnet the genesis seed is already
 * funded, so this returns immediately; on a public testnet it waits for the
 * faucet transaction to land.
 */
export const waitForFunds = async (
  wallet: WalletContext['wallet'],
  timeoutMs = Number(process.env.MIDNIGHT_FAUCET_TIMEOUT_MS) || 600_000,
): Promise<bigint> => {
  const balance = await nightBalance(wallet);
  if (balance > 0n) return balance;

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const current = await nightBalance(wallet);
    if (current > 0n) return current;
    const elapsed = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`\r  ...waiting for tNIGHT (${elapsed}s)   `);
  }
  process.stdout.write('\n');
  return 0n;
};

/**
 * Register the wallet's NIGHT UTXOs so they generate DUST, then wait for DUST
 * to appear. DUST is the non-transferable fee resource; nothing can be
 * submitted without it.
 */
export const ensureDust = async (ctx: WalletContext): Promise<bigint> => {
  const state = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const unregistered = state.unshielded.availableCoins.filter(
    (coin: { meta?: { registeredForDustGeneration?: boolean } }) => !coin.meta?.registeredForDustGeneration,
  );

  if (unregistered.length > 0) {
    console.log(`  Registering ${unregistered.length} NIGHT UTXO(s) for DUST generation...`);
    // The signature callback already produces one signature per input. Signing
    // the recipe a second time would fail on chain with a signature-count
    // mismatch, so we go straight from recipe to finalize to submit.
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
      unregistered,
      ctx.unshieldedKeystore.getPublicKey(),
      (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload),
    );
    const finalized = await ctx.wallet.finalizeRecipe(recipe);
    await ctx.wallet.submitTransaction(finalized);
  }

  if ((await dustBalance(ctx.wallet)) > 0n) return dustBalance(ctx.wallet);

  console.log('  Waiting for DUST to be generated...');
  try {
    await Rx.firstValueFrom(
      ctx.wallet.state().pipe(
        Rx.throttleTime(5_000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
        Rx.timeout({ first: DUST_WAIT_TIMEOUT_MS }),
      ),
    );
  } catch {
    const minutes = Math.round(DUST_WAIT_TIMEOUT_MS / 60_000);
    throw new Error(
      `No DUST was generated within ${minutes} minutes. DUST comes from registered NIGHT UTXOs.\n` +
        '  Check that the wallet holds NIGHT and that the network is producing blocks.',
    );
  }
  return dustBalance(ctx.wallet);
};

export const stopWallet = async (ctx: WalletContext): Promise<void> => {
  await ctx.wallet.stop();
};
