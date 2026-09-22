// SealedBid — privacy-preserving sealed-bid procurement auction
// Copyright (C) 2026 SealedBid contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Errors that mean "the network was not ready yet", not "the circuit refused".
 *
 * DUST is generated continuously from registered NIGHT, so the wallet's
 * reported balance is a projection of what the next block's timestamp will
 * account for. A transaction submitted at the wrong instant in that cycle is
 * rejected by the node with a fee error, and the same transaction succeeds a
 * few seconds later. Circuit assertions — the ones that carry a message we
 * wrote in the contract — must never be retried, because they are a genuine
 * refusal.
 */
const TRANSIENT_PATTERNS = [
  /not enough dust/i,
  /could not balance dust/i,
  /insufficient funds/i,
  /invalid transaction/i,
  /transaction submission failed/i,
  /submission error/i,
  /temporarily banned/i,
  /pool is full/i,
];

export const isTransientSubmissionError = (message: string): boolean => {
  // A contract assertion is never transient.
  if (/failed assert/i.test(message)) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  /** Delay applied before the first attempt, to let DUST accrue. */
  readonly settleMs?: number;
  readonly quiet?: boolean;
}

/**
 * Run a transaction-producing call, retrying only transient failures.
 *
 * `label` is used for progress output; the underlying error is preserved and
 * rethrown once the attempts are exhausted so nothing is swallowed.
 */
export const submitWithRetry = async <T>(
  label: string,
  call: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 6_000;
  const settleMs = options.settleMs ?? 6_000;
  const quiet = options.quiet ?? false;

  if (settleMs > 0) {
    if (!quiet) process.stdout.write(`  ${label}: waiting for DUST to accrue...`);
    await sleep(settleMs);
    if (!quiet) process.stdout.write('\r' + ' '.repeat(`  ${label}: waiting for DUST to accrue...`.length) + '\r');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isTransientSubmissionError(message) || attempt === attempts) break;
      const detail = message.split('\n')[0].slice(0, 120);
      console.log(`  ${label}: transient failure (attempt ${attempt}/${attempts}), retrying in ${delayMs / 1000}s`);
      if (attempt === 1) console.log(`    ${detail}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
};
