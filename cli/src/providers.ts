// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type { NetworkConfig } from './network.js';
import type { WalletContext } from './wallet.js';

// Apollo (used by the indexer provider) needs a global WebSocket in Node.
// @ts-expect-error the wallet SDK expects a browser-shaped global
globalThis.WebSocket = WebSocket;

export const PRIVATE_STATE_STORE_NAME = 'sealedbid-private-state';

/**
 * Directory holding the compiled contract: `contract/`, `keys/` and `zkir/`.
 *
 * Resolved from the built `@sealedbid/contract` workspace so the CLI always
 * proves against the artifacts that were actually compiled, never a stale
 * copy. `SEALEDBID_ZK_CONFIG_PATH` overrides it.
 */
export const resolveZkConfigPath = (): string => {
  const override = process.env.SEALEDBID_ZK_CONFIG_PATH?.trim();
  if (override) return path.resolve(override);

  const require = createRequire(import.meta.url);
  const entry = require.resolve('@sealedbid/contract');
  return path.join(path.dirname(entry), 'managed', 'sealed-bid-auction');
};

export const assertArtifactsPresent = (zkConfigPath: string): void => {
  const required = [
    path.join(zkConfigPath, 'contract', 'index.js'),
    path.join(zkConfigPath, 'keys', 'revealBid.prover'),
    path.join(zkConfigPath, 'zkir', 'revealBid.zkir'),
  ];
  const missing = required.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `Compiled contract artifacts are missing from ${zkConfigPath}:\n` +
        missing.map((file) => `  - ${file}`).join('\n') +
        '\nBuild them first:  cd contract && npm run compact && npm run build',
    );
  }
};

/** Refuse to run against a proof server that is not answering. */
export const assertProofServerReady = async (url: string, attempts = 30, delayMs = 2_000): Promise<void> => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3_000) });
      return;
    } catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
      if (code !== 'ECONNREFUSED' && code !== 'UND_ERR_CONNECT_TIMEOUT' && code !== 'UND_ERR_SOCKET') return;
      if (attempt < attempts) {
        process.stdout.write(`\r  Waiting for the proof server... (${attempt}/${attempts})   `);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  process.stdout.write('\n');
  throw new Error(`The proof server at ${url} is not responding. Start it with: npm run proof-server:up`);
};

const privateStatePassword = (): string => {
  const password = process.env.MIDNIGHT_STORAGE_PASSWORD?.trim();
  if (!password) {
    throw new Error(
      'MIDNIGHT_STORAGE_PASSWORD is not set. Copy cli/.env.example to cli/.env and set it.\n' +
        '  It encrypts the sealed bid amounts and nonces stored on disk.',
    );
  }
  if (password.length < 16) {
    throw new Error('MIDNIGHT_STORAGE_PASSWORD must be at least 16 characters.');
  }
  return password;
};

export interface Providers {
  readonly privateStateProvider: ReturnType<typeof levelPrivateStateProvider>;
  readonly publicDataProvider: ReturnType<typeof indexerPublicDataProvider>;
  readonly zkConfigProvider: NodeZkConfigProvider<string>;
  readonly proofProvider: ReturnType<typeof httpClientProofProvider>;
  readonly walletProvider: WalletProviderLike;
  readonly midnightProvider: WalletProviderLike;
  readonly zkConfigPath: string;
}

interface WalletProviderLike {
  getCoinPublicKey(): ledger.CoinPublicKey;
  getEncryptionPublicKey(): ledger.EncPublicKey;
  balanceTx(tx: unknown, ttl?: Date): Promise<ledger.FinalizedTransaction>;
  submitTx(tx: ledger.FinalizedTransaction): Promise<ledger.TransactionId>;
}

export const configureProviders = async (
  ctx: WalletContext,
  config: NetworkConfig,
  zkConfigPath: string,
): Promise<Providers> => {
  setNetworkId(config.networkId);
  privateStatePassword(); // fail fast, before any network work
  assertArtifactsPresent(zkConfigPath);

  const walletProvider: WalletProviderLike = {
    getCoinPublicKey: () => ctx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => ctx.shieldedSecretKeys.encryptionPublicKey,
    // balanceUnboundTransaction -> finalizeRecipe is the complete balancing
    // path in wallet-sdk 1.x; there is no separate signing step.
    async balanceTx(tx: unknown, ttl?: Date) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return ctx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: ledger.FinalizedTransaction) => ctx.wallet.submitTransaction(tx),
  };

  const zkConfigProvider = new NodeZkConfigProvider<string>(zkConfigPath);
  const accountId = ctx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: PRIVATE_STATE_STORE_NAME,
      privateStoragePasswordProvider: privateStatePassword,
      accountId,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
    zkConfigPath,
  };
};
