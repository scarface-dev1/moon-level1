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
import {
  CHILD_KINDS,
  loadWalletState,
  saveWalletState,
  type ChildKind,
  type PersistedWalletState,
} from './wallet-state.js';

/** How long to wait for DUST to be generated from registered NIGHT. */
const DUST_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export interface WalletContext {
  readonly wallet: Awaited<ReturnType<typeof WalletFacade.init>>;
  readonly shieldedSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  readonly dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  readonly unshieldedKeystore: ReturnType<typeof createKeystore>;
  /** Which child wallets resumed from cached sync state. */
  readonly restored: Record<ChildKind, boolean>;
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

export interface BuildWalletOptions {
  /** Set false to force a from-seed sync, ignoring any cached state. */
  readonly restore?: boolean;
}

export const buildWallet = async (
  network: NetworkId,
  config: NetworkConfig,
  seed: string,
  options: BuildWalletOptions = {},
): Promise<WalletContext> => {
  setNetworkId(config.networkId);

  const saved: PersistedWalletState = options.restore === false ? {} : loadWalletState(network);
  const restored: Record<ChildKind, boolean> = { shielded: false, unshielded: false, dust: false };

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

  // Each child wallet tries to resume from its cached state and falls back to a
  // from-seed start if the cache is absent or no longer loadable (which happens
  // after an SDK upgrade). A fallback costs one slow sync, never a crash.
  const tryRestore = async <T>(kind: ChildKind, cls: unknown, start: () => Promise<T>): Promise<T> => {
    const cached = saved[kind];
    if (cached === undefined) return start();
    try {
      const value = await (cls as { restore: (s: unknown) => Promise<T> }).restore(cached);
      restored[kind] = true;
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\n  Could not restore the ${kind} wallet (${message}); syncing from seed instead.\n`);
      return start();
    }
  };

  const wallet = await WalletFacade.init({
    configuration: walletConfig,
    shielded: async (cfg) => {
      const cls = ShieldedWallet(cfg);
      return tryRestore('shielded', cls, async () => cls.startWithSecretKeys(shieldedSecretKeys));
    },
    unshielded: async (cfg) => {
      const cls = UnshieldedWallet(cfg);
      return tryRestore('unshielded', cls, async () => cls.startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)));
    },
    dust: async (cfg) => {
      const cls = DustWallet(cfg);
      return tryRestore('dust', cls, async () =>
        cls.startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
      );
    },
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, restored };
};

/**
 * Serialise each child wallet's sync progress so the next run resumes instead of
 * starting over. Individual failures are reported but not fatal: losing one
 * child's cache means that child re-syncs, nothing more.
 */
export const persistWalletState = async (network: NetworkId, ctx: WalletContext): Promise<void> => {
  const next: PersistedWalletState = {};
  for (const kind of CHILD_KINDS) {
    try {
      const child = (ctx.wallet as unknown as Record<ChildKind, { serializeState: () => Promise<unknown> }>)[kind];
      next[kind] = await child.serializeState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\n  Could not cache the ${kind} wallet (${message}); the next run will re-sync it.\n`);
    }
  }
  if (Object.keys(next).length > 0) saveWalletState(network, next);
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
