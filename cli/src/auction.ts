// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from 'node:buffer';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { assertIsContractAddress } from '@midnight-ntwrk/midnight-js-utils';
import type { ContractAddress } from '@midnight-ntwrk/compact-runtime';
import { SealedBidAuction, witnesses } from '@sealedbid/contract';
import type { AuctionPrivateState } from './private-state.js';
import type { Providers } from './providers.js';

/** Identifier the wallet's private state is stored under. */
export const PRIVATE_STATE_ID = 'sealedBidPrivateState';

/**
 * The compiled contract, bound to its witnesses and its on-disk proving
 * artifacts. Built once per process against the artifacts the CLI resolved so
 * that deployment and proving always use the same keys.
 */
export const makeCompiledContract = (zkConfigPath: string) =>
  CompiledContract.make('SealedBid', SealedBidAuction.Contract).pipe(
    CompiledContract.withWitnesses(witnesses as never),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

export type CompiledAuction = ReturnType<typeof makeCompiledContract>;

/**
 * A circuit invoker as exposed by the contract binding.
 *
 * The generated `callTx` is a plain object of functions whose parameters vary
 * per circuit, so it is typed structurally here rather than re-deriving the
 * full conditional type from the SDK.
 */
export type CircuitCallTx = Record<
  string,
  (...args: unknown[]) => Promise<{ public: { txId: string; blockHeight: number } }>
>;

export interface DeployedAuction {
  readonly contractAddress: string;
  readonly deploymentTxId: string | null;
  readonly deploymentBlockHeight: number | null;
  readonly callTx: CircuitCallTx;
}

/**
 * Deploy a new auction. The Compact constructor takes no arguments and pins the
 * auctioneer role to this wallet's identity secret, so the deployer is the
 * auctioneer by construction.
 */
export const deployAuction = async (
  providers: Providers,
  compiled: CompiledAuction,
  privateState: AuctionPrivateState,
): Promise<DeployedAuction> => {
  const contract = await deployContract(providers as never, {
    compiledContract: compiled,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: privateState,
  } as never);

  const deployed = contract.deployTxData.public;
  return {
    contractAddress: deployed.contractAddress,
    deploymentTxId: (deployed as { txId?: string }).txId ?? null,
    deploymentBlockHeight: (deployed as { blockHeight?: number }).blockHeight ?? null,
    callTx: (contract as unknown as DeployedAuction).callTx,
  };
};

/** Attach to an auction that is already deployed. */
export const joinAuction = async (
  providers: Providers,
  compiled: CompiledAuction,
  contractAddress: string,
  privateState: AuctionPrivateState,
): Promise<DeployedAuction> => {
  assertIsContractAddress(contractAddress);
  const contract = await findDeployedContract(providers as never, {
    contractAddress,
    compiledContract: compiled,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: privateState,
  } as never);

  const deployed = contract.deployTxData.public;
  return {
    contractAddress: deployed.contractAddress,
    deploymentTxId: null,
    deploymentBlockHeight: (deployed as { blockHeight?: number }).blockHeight ?? null,
    callTx: (contract as unknown as DeployedAuction).callTx,
  };
};

/** Read the public ledger state of a deployed auction. */
export const readAuctionLedger = async (
  providers: Providers,
  contractAddress: ContractAddress,
): Promise<SealedBidAuction.Ledger | null> => {
  assertIsContractAddress(contractAddress);
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (state === null) return null;
  return SealedBidAuction.ledger(state.data);
};

/** Human-readable phase name. */
export const phaseName = (phase: SealedBidAuction.AuctionPhase): string =>
  SealedBidAuction.AuctionPhase[phase] ?? `Unknown(${phase})`;

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
