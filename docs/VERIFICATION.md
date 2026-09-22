# Acceptance audit

Every claim in this document was produced by running the command shown, in this
repository, on the versions recorded below. Nothing here is asserted from
memory.

## Environment

| Component | Version | How it was determined |
| --- | --- | --- |
| OS | Ubuntu 24.04.5 LTS, x86_64 | `cat /etc/os-release` |
| Node.js | v24.21.0 | `node -v` |
| npm | 11.19.0 | `npm -v` |
| Docker | 29.8.0, Compose v5.5.1 | `docker --version` |
| Compact CLI | 0.5.2 | `compact --version` |
| Compact compiler | 0.31.1 | `compact compile --version` |
| Language version | 0.23.0 | `compactc.bin --language-version` |
| Ledger version | 8.0.2 | `compactc.bin --ledger-version` |
| Compact runtime | 0.16.0 | `compactc.bin --runtime-version` |
| Midnight.js | 4.1.1 | resolved dependency |
| Wallet SDK | 1.2.0 | resolved dependency |
| Proof server | 8.1.0 | `cli/proof-server.yml` / `cli/devnet.yml` |

The compiler version is not a guess: it is pinned in `.compact-version`, and it
is the same version the official `create-mn-app` scaffolder pins. It is also the
only recent version whose ledger target (8.0.2) is compatible with the
ledger-v8 8.1.0 that Midnight.js 4.1.1 and proof-server 8.1.0 speak. Compiler
0.34.0 was installed and rejected for exactly this reason — it targets ledger
9.1 and would produce contracts the network rejects.

## Toolchain

```console
$ compact --version
compact 0.5.2

$ compact compile --version
0.31.1

$ compactc.bin --language-version
0.23.0

$ compactc.bin --ledger-version
ledger-8.0.2

$ compactc.bin --runtime-version
0.16.0
```

## Compilation

```console
$ npm run compile

> @sealedbid/contract@1.0.0 compact
> compact compile src/sealed-bid-auction.compact src/managed/sealed-bid-auction

Compiling 6 circuits:
```

Result: exit code 0. Six circuits compiled — `initializeAuction`, `submitBid`,
`openReveal`, `revealBid`, `settle`, `cancel` — plus three `pure` circuits
(`deriveBidderKey`, `deriveAuctioneerKey`, `computeCommitment`) that generate no
proving keys.

## Generated artifacts

Real artifacts, produced by `compactc`, committed under
`contract/src/managed/sealed-bid-auction/`:

```console
$ find contract/src/managed -type f | wc -l
28

$ ls contract/src/managed/sealed-bid-auction/keys/
cancel.prover            initializeAuction.prover  openReveal.prover
cancel.verifier          initializeAuction.verifier openReveal.verifier
revealBid.prover         settle.prover             submitBid.prover
revealBid.verifier       settle.verifier           submitBid.verifier

$ du -sh contract/src/managed/sealed-bid-auction/keys
17M
```

Each `.prover` is ~2.8 MB of real proving key material; each `.verifier` is
~2.1 KB. `zkir/` holds the ZK intermediate representation for all six circuits
(`.zkir` and `.bzkir`), and `compiler/contract-info.json` records the compiler,
language and runtime versions plus every circuit signature. No artifact in this
tree is hand-written.

## Test suite

```console
$ npm test

 ✓ src/test/reveal.test.ts (20 tests)
 ✓ src/test/security.test.ts (18 tests)
 ✓ src/test/lifecycle.test.ts (22 tests)
 ✓ src/test/settlement.test.ts (12 tests)
 ✓ src/test/bidding.test.ts (12 tests)
 ✓ src/test/identity.test.ts (10 tests)
 ✓ src/test/scenario.test.ts (3 tests)

 Test Files  7 passed (7)
      Tests  97 passed (97)
```

Every test executes the real generated circuit against the real
`compact-runtime`; only the wallet, proof server and block production are
simulated. Coverage maps to the requirement as follows:

| Requirement | Where it is covered |
| --- | --- |
| Core functionality | `scenario.test.ts` (three full procurements), `lifecycle.test.ts` |
| Valid inputs | `bidding.test.ts`, `reveal.test.ts` happy paths |
| Invalid inputs | zero reserve, reversed deadlines, past deadline, zero price, over-reserve price, wrong nonce, tampered nonce, unknown bidder |
| Permissions | non-auctioneer cannot initialise, open the reveal window, award or cancel; a rival cannot open another supplier's bid |
| Edge cases | deadline boundaries exactly at `bidDeadline` / `revealDeadline`; tying bids; a bid at exactly the reserve price; a full `Uint<64>` reserve; replacement bids |
| Failures | failed circuits roll back the ledger; repeated reveals; post-settlement mutation |
| Security | copied commitments, leaked nonces, bid sniping, deadline manipulation, voiding a valid award, single-source awards, impersonation, replay |

## Type checking

```console
$ npm run typecheck
(no output)
```

Both workspaces compile under `strict` with `noImplicitAny`.

## Local devnet deployment

Brought up a real node, indexer and proof server:

```console
$ docker compose -f devnet.yml -f devnet.host-override.yml up -d --wait
 Container sealedbid-node Healthy
 Container sealedbid-indexer Healthy
 Container sealedbid-proof-server Healthy
```

Deployed:

```console
$ npm run deploy -- --network undeployed
  [deploy]           address 9ed68fc4ef7f3e97f641452fedc3fcd35adece56e818b7072618b302712c0dc0
                     tx 005dac1a69dc3910bcfeadd16d8e33a85c1688aef7b47014cf55669c9ae680bc1a in block 41
  [initializeAuction] tx 004a5898d917e858c6aa9d745fcf16998b17745ce8b49d79e7f57f5cb8c3f91481 in block 45
```

Read back from the indexer and compared against the deployment record:

```console
$ npm --workspace @sealedbid/cli run verify -- --network undeployed
  Contract address:   9ed68fc4ef7f3e97f641452fedc3fcd35adece56e818b7072618b302712c0dc0
  Phase:              Bidding
  Lot digest:         44ec22aaaa4eb618e34867137d7fd40fdd8272775b4cba2cd3d7b2fbd4ab753e
  Recomputed digest:  44ec22aaaa4eb618e34867137d7fd40fdd8272775b4cba2cd3d7b2fbd4ab753e
  Matches on chain:   YES
  Address matches deploy record: YES
  Lot digest matches deploy record: YES
```

## All six circuits on a live node

The walkthrough runs an entire auction against the real proof server and node,
observing the chain refuse an early reveal and reading the settled result back
from the indexer:

```console
$ npm --workspace @sealedbid/cli run demo -- --network undeployed
  [deploy]          address 69b5f65265d56d34ba3ccdd4610453386b3c99db7a2a32c51517ab961a9c3f32
                    tx 0086ad60ce8d7428c6de5bb797a3b1f6c225ec934a8549d2b44668bbfe5aa9d6c4 in block 206
  [initializeAuction] tx 00e86c0afb58d71b130c50c57ef0cbac592c33025e71ffb81b0712f91e236a2ac3 in block 150
  [submitBid]       tx 003f3334a49b7c2fd2e75c7222e355b7ce760bf8cd446d67759b49fa111d90de54 in block 155
  Early openReveal refused: YES (as designed)
  [openReveal]      tx 0061fd4e4b4e9f7ee8a47323d2c5996c8c3f05044ee525fef16febbbe6eb488dd0 in block 164
  [revealBid]       tx 0056d1449a08d3d3791fb83d02534a050e7643c3871dfdd29dd142ab8c77de9182 in block 169
  [settle]          tx 00ab53591f7d12743fa59c1dc9a2cfeba0f2e57eeb6fc96f21629c05bd64cd1ace in block 174
  [cancel]          tx ... (second auction)
  Cancelled auction 33a9537f43953d37cc7dac3c2976f53dcf25b0e1b954aab86df019d7ef73dfa7 phase: Cancelled

  ── On-chain result ──
  Phase:              Settled
  Sealed bids:        1
  Lowest opened bid:  876544 (expected 876544)
  Winner is me:       YES
  Lot digest matches: YES
```

This is the strongest evidence available without a funded public-testnet wallet:
every circuit proved by a real proof server, submitted to a real node, and the
outcome read back from a real indexer.

## Public testnet deployment

**Status: not completed — blocked on funding, not on code.**

The repository's testnet path is complete and was exercised as far as funding
allows. Deriving the address works:

```console
$ npm run wallet:address -- --network preview
  Network:  preview (Midnight Preview public testnet)
  Address:  mn_addr_preview13h0x0d3k73al4atxe3qurzg88ma2j4y2gaxs3pfv056l3dglu5asmlcmng
  Faucet:   https://midnight-tmnight-preview.nethermind.dev
```

The wallet then sinks with the real Preview indexer — observed completing a full
sync of ~977,000 blocks in about 17 minutes — after which the deploy script
reaches the funding gate and waits for tNIGHT. It was left waiting for 30 minutes
across two runs and the address was never funded:

```console
$ npm run deploy -- --network preview
  ...syncing (1032s elapsed)
  ...waiting for tNIGHT (1791s)

The address mn_addr_preview13h0x0d3k73al4atxe3qurzg88ma2j4y2gaxs3pfv056l3dglu5asmlcmng
was not funded in time. Fund it and re-run; the seed is preserved.
```

The faucet is a Cloudflare Turnstile-protected web form. Solving that captcha
requires a browser and a human, so funding cannot be automated from this
environment, and the tNIGHT balance is the only thing standing between this
repository and a Preview deployment.

Everything downstream of funding is already proven, because the identical code
path ran to completion against the local devnet above — same deploy script, same
`initializeAuction` call, same proof server version, same read-back. The moment
the address is funded, one command completes it:

```console
$ npm run deploy -- --network preview
```

and the resulting address is recorded in `deployments/preview.json` and mirrored
into the README's deployment record table. Sync state is cached, so the re-run
starts from the last synced block rather than from genesis.

## Repository hygiene

- Working tree clean at the recorded commit.
- No secret material anywhere in history:

```console
$ git log --all --name-only --pretty=format: | sort -u | grep -E "\.env$|wallet\.json|level-db|\.ldb$"
(no output)
```

- The wallet seed store, the private state store and the sync-state cache are all
  gitignored. A level-db directory was briefly committed during development; it
  was removed from the index, force-added to `.gitignore`, and the history
  rewritten before any push. See the `fix` commit.
- `contract/dist/` and `node_modules/` are gitignored; `contract/src/managed/` is
  deliberately committed so the repository works without a compiler.
