# Acceptance audit

Every claim in this document was produced by running the command shown, in this
repository, on the versions recorded below. Nothing here is asserted from
memory.

The raw stdout of every run quoted here is committed under
[`verification/`](verification/), and the images in
[`screenshots/`](screenshots/) are rendered from those transcripts by
`scripts/render-screenshots.py`. Re-run `npm run evidence`, `npm test`,
`npm run deploy` and `npm run verify` to reproduce them.

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
  Contract address: 37fcad3a26dc5dec1564b638c3554b819131c39e4ea95294a0463209605db2f5
  Deploy tx:        005050cbed4ac228f497cafe418ef052421dff591edadb86aee00d5a2d49d6b58f in block 1238
  initializeAuction: 003b54337dc7dd47262a50de68c4ad87266300246632a8a8e3ae325d1aa839c3e6 in block 1243
  Phase:            Bidding
```

Read back from the indexer and compared against the deployment record:

```console
$ npm --workspace @sealedbid/cli run verify -- --network undeployed
  Contract address:   37fcad3a26dc5dec1564b638c3554b819131c39e4ea95294a0463209605db2f5
  Phase:              Bidding
  Lot digest:         73a9761d9f3a11a9f0ec1635b7438d585b1739aeaf102b47eea65b35f0ceb1cb
  Recomputed digest:  73a9761d9f3a11a9f0ec1635b7438d585b1739aeaf102b47eea65b35f0ceb1cb
  Matches on chain:   YES
  Address matches deploy record: YES
  Lot digest matches deploy record: YES
```

Full transcripts: [`verification/deploy.txt`](verification/deploy.txt),
[`verification/verify.txt`](verification/verify.txt).

## All six circuits on a live node

The walkthrough runs an entire auction against the real proof server and node,
observing the chain refuse an early reveal and reading the settled result back
from the indexer:

```console
$ npm --workspace @sealedbid/cli run demo -- --network undeployed
  [deploy]          address 762aab3c16dd7f3126e58857407b92b7e4ab97619b5672312dda08d33defe623
                    tx 00824ab48a70d3a8ff1531e867e45b7c576f36f9358d8d2e620b73c9c4496b461d in block 1327
  [initializeAuction] tx 00bd7637ed35355fab0d2124c607b3d1f3654f7632de9b0f15155916734cc0694a in block 1332
  [submitBid]       tx 00e19a8c8cbc2ed0d320f0e79bd79d23b793608d629f0cc835912ed25b51b3ad94 in block 1337
                    sealed 876544 as 9355f8fb2d30264d403a4fcc68bb3c796c94d31713898abc5ba343fa82513387
  Early openReveal refused: YES (as designed)
  [openReveal]      tx 0064542aaf8f4f05e9fd4212c150ce35add8e2dde1a3cb68dfb7e2475ec3519054 in block 1347
  [revealBid]       tx 0082577a2e22ca3da406619b80c676dbd9be375e6ba93af1abc65eb3acb2edbc5d in block 1352
  [settle]          tx 00c3df4be39c885cd1126f429df0e3123e9320b3bef43f42f3de75eb7c1c74b8cc in block 1357
  [cancel]          tx 006ca740402ea47a800d8bfe4da797df583a2899b631b5de8404b976cd098cbf08 in block 1371
  Cancelled auction 0e826ff3ba9d1201825427dde8fc75ea14c65f73d3d678632357e78e966f07ee phase: Cancelled

  ── On-chain result ──
  Contract address:   762aab3c16dd7f3126e58857407b92b7e4ab97619b5672312dda08d33defe623
  Phase:              Settled
  Sealed bids:        1
  Lowest opened bid:  876544 (expected 876544)
  Winner is me:       YES
  Lot digest matches: YES
```

Every one of the six circuits produced a real transaction here. Note the two
negative results the node itself enforced: `Early openReveal refused: YES` (the
contract will not open the window before `bidDeadline`) and the second lot
reaching `Cancelled` only because no valid bid had been opened. Full transcript:
[`verification/demo.txt`](verification/demo.txt),
screenshot: [`screenshots/demo.png`](screenshots/demo.png).

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
