// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { cliRoot, type NetworkId } from './network.js';

/**
 * Cached sync state for each child wallet.
 *
 * A full sync of a public testnet walks the whole chain and takes many minutes.
 * The wallet SDK can serialise each child wallet's progress, so a re-run resumes
 * from where the last one stopped instead of starting over. The file is
 * gitignored: it is derived from the wallet keys and is as sensitive as they
 * are.
 */
export const WALLET_STATE_PATH = path.join(cliRoot, '.midnight-wallet-state.json');

export const WALLET_STATE_VERSION = 1;

export const CHILD_KINDS = ['shielded', 'unshielded', 'dust'] as const;
export type ChildKind = (typeof CHILD_KINDS)[number];

export type PersistedWalletState = Partial<Record<ChildKind, unknown>>;

interface WalletStateFile {
  version: number;
  networks: Partial<Record<NetworkId, PersistedWalletState>>;
}

const read = (): WalletStateFile => {
  if (!fs.existsSync(WALLET_STATE_PATH)) return { version: WALLET_STATE_VERSION, networks: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(WALLET_STATE_PATH, 'utf8')) as WalletStateFile;
    if (parsed.version !== WALLET_STATE_VERSION || typeof parsed.networks !== 'object') {
      return { version: WALLET_STATE_VERSION, networks: {} };
    }
    return parsed;
  } catch {
    // A corrupt cache must never block a deployment: the cost of ignoring it is
    // one slow sync, the cost of trusting it is a crash.
    return { version: WALLET_STATE_VERSION, networks: {} };
  }
};

export const loadWalletState = (network: NetworkId): PersistedWalletState => read().networks[network] ?? {};

export const saveWalletState = (network: NetworkId, state: PersistedWalletState): void => {
  const file = read();
  file.networks[network] = state;
  fs.writeFileSync(WALLET_STATE_PATH, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  fs.chmodSync(WALLET_STATE_PATH, 0o600);
};

export const clearWalletState = (network: NetworkId): void => {
  const file = read();
  delete file.networks[network];
  fs.writeFileSync(WALLET_STATE_PATH, `${JSON.stringify(file)}\n`, { mode: 0o600 });
};
