// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export type NetworkId = 'undeployed' | 'preview' | 'preprod';

export const NETWORK_IDS: readonly NetworkId[] = ['undeployed', 'preview', 'preprod'] as const;

export interface NetworkConfig {
  readonly networkId: NetworkId;
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
  /** Public testnet faucet, or null for the local devnet (pre-minted). */
  readonly faucet: string | null;
  /** Human-readable description used in logs and the deployment record. */
  readonly description: string;
}

/**
 * Endpoints for each supported network.
 *
 * `undeployed` is the local devnet stood up by `cli/devnet.yml`. Its node runs
 * the `dev` preset, which pre-mints NIGHT to the genesis seed, so no faucet is
 * involved. `preview` and `preprod` are the public testnets, where the node and
 * indexer are operated by the network and only the proof server runs locally.
 */
export const NETWORK_CONFIGS: Record<NetworkId, NetworkConfig> = {
  undeployed: {
    networkId: 'undeployed',
    indexer: 'http://127.0.0.1:8088/api/v4/graphql',
    indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
    node: 'http://127.0.0.1:9944',
    proofServer: 'http://127.0.0.1:6300',
    faucet: null,
    description: 'local devnet (docker compose -f devnet.yml up -d --wait)',
  },
  preview: {
    networkId: 'preview',
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preview.midnight.network',
    proofServer: 'http://127.0.0.1:6300',
    faucet: 'https://midnight-tmnight-preview.nethermind.dev',
    description: 'Midnight Preview public testnet',
  },
  preprod: {
    networkId: 'preprod',
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preprod.midnight.network',
    proofServer: 'http://127.0.0.1:6300',
    faucet: 'https://midnight-tmnight-preprod.nethermind.dev',
    description: 'Midnight Preprod public testnet',
  },
};

export const isNetworkId = (value: string): value is NetworkId =>
  (NETWORK_IDS as readonly string[]).includes(value);

/** Parse `--network <id>` from argv, defaulting to the local devnet. */
export const networkFromArgv = (argv: readonly string[] = process.argv): NetworkId => {
  const index = argv.indexOf('--network');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined) return 'undeployed';
  if (!isNetworkId(value)) {
    throw new Error(`Unknown network "${value}". Expected one of: ${NETWORK_IDS.join(', ')}`);
  }
  return value;
};

export const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(cliRoot, '..');

/** Local wallet store. Gitignored — it holds the seed, a spending secret. */
export const WALLET_STORE_PATH = path.join(cliRoot, '.midnight-wallet.json');

/** Public deployment records. Committed; contains only on-chain data. */
export const deploymentsDir = path.join(repoRoot, 'deployments');

interface WalletStore {
  version: 1;
  seeds: Partial<Record<NetworkId, string>>;
}

const readWalletStore = (): WalletStore => {
  if (!fs.existsSync(WALLET_STORE_PATH)) return { version: 1, seeds: {} };
  const parsed = JSON.parse(fs.readFileSync(WALLET_STORE_PATH, 'utf8')) as WalletStore;
  if (parsed.version !== 1 || typeof parsed.seeds !== 'object' || parsed.seeds === null) {
    throw new Error(`${WALLET_STORE_PATH} is not a recognised wallet store; move it aside and retry.`);
  }
  return parsed;
};

const writeWalletStore = (store: WalletStore): void => {
  fs.writeFileSync(WALLET_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(WALLET_STORE_PATH, 0o600);
};

/**
 * The seed the local devnet's `dev` preset pre-mints NIGHT to.
 *
 * The devnet has no faucet, so the only funded wallet is this one. It is a
 * public, well-known constant that exists purely so local development needs no
 * funding step — it must never be used on a public network.
 */
export const LOCAL_DEVNET_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

export interface ResolvedWallet {
  readonly seed: string;
  readonly source: 'MIDNIGHT_SEED' | 'wallet store' | 'newly generated' | 'local devnet genesis';
  readonly created: boolean;
}

/**
 * Resolve the wallet seed for a network.
 *
 * Precedence: `MIDNIGHT_SEED` env var (for CI and disposable runs) over a seed
 * already stored in the local wallet file over a freshly generated one. A new
 * seed is written to disk with 0600 permissions so the same address is reused
 * on the next run; funding a fresh address on every run would be unusable.
 */
export const resolveWallet = (network: NetworkId): ResolvedWallet => {
  const fromEnv = process.env.MIDNIGHT_SEED?.trim();
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error('MIDNIGHT_SEED must be 64 hex characters (32 bytes).');
    }
    return { seed: fromEnv.toLowerCase(), source: 'MIDNIGHT_SEED', created: false };
  }

  // The local devnet pre-mints to one known wallet; generating a fresh seed
  // there would produce an unfunded address with no faucet to fix it.
  if (network === 'undeployed') {
    return { seed: LOCAL_DEVNET_SEED, source: 'local devnet genesis', created: false };
  }

  const store = readWalletStore();
  const stored = store.seeds[network];
  if (stored) return { seed: stored, source: 'wallet store', created: false };

  const seed = randomBytes(32).toString('hex');
  store.seeds[network] = seed;
  writeWalletStore(store);
  return { seed, source: 'newly generated', created: true };
};

export interface DeploymentRecord {
  readonly network: NetworkId;
  readonly contractAddress: string;
  readonly deployedAt: string;
  readonly deployer: string;
  readonly deploymentTxId: string | null;
  readonly deploymentBlockHeight: number | null;
  readonly initializeTxId?: string | null;
  readonly initializeBlockHeight?: number | null;
  readonly lotDigest?: string;
  readonly lotDocument?: string;
  readonly lotTitle?: string;
  readonly reservePrice?: string;
  readonly unit?: string;
  readonly bidDeadline?: string;
  readonly revealDeadline?: string;
  readonly requiredBidders?: string;
  readonly auctioneerKey?: string;
  readonly phase?: string;
  readonly indexerEndpoint?: string;
  readonly compilerVersion: string;
  readonly languageVersion: string;
  readonly packageVersion: string;
}

export const writeDeploymentRecord = (record: DeploymentRecord): string => {
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const file = path.join(deploymentsDir, `${record.network}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
};

export const readDeploymentRecord = (network: NetworkId): DeploymentRecord | null => {
  const file = path.join(deploymentsDir, `${network}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as DeploymentRecord;
};

/** Where the auctioneer's off-chain lot document lives (published by hash). */
export const lotDocumentPath = (network: NetworkId): string =>
  path.join(deploymentsDir, `lot-${network}.md`);
