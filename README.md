# SealedBid

**A privacy-preserving sealed-bid procurement auction, built as a Compact smart contract on the Midnight Network.**

SealedBid lets a buyer publish a lot and a reserve price, and lets suppliers
submit bids whose prices stay **off the public ledger**. Only a 32-byte
commitment to each price is written on chain. When the bidding window closes,
suppliers open their bids inside a zero-knowledge circuit — and a bid is only
accepted if it strictly beats the running lowest. The result is that **exactly
one price is ever published: the winner's**. Every losing price stays sealed
forever.

This is the property that real procurement auctions need and that a transparent
chain destroys: if your competitors can see your price while the window is open,
they undercut you. SealedBid restores sealed bidding without trusting an
auctioneer or an escrow server.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Repository structure](#repository-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Compiling the contract](#compiling-the-contract)
- [Running the tests](#running-the-tests)
- [Generating artifacts](#generating-artifacts)
- [Deploying](#deploying)
- [Verification](#verification)
- [Deployment record](#deployment-record)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [License](#license)

---

## Why this exists

A reverse (procurement) auction is a routine piece of commerce: a buyer needs
something delivered and asks suppliers to bid for the work, lowest price wins.
Doing that on a transparent blockchain breaks it. Bids are visible while the
auction is open, so the last bidder to write simply undercuts everyone, and the
buyer learns every supplier's floor price — information that is commercially
sensitive and often contractually confidential.

The usual fix is to trust a central operator to keep bids hidden until the
close. Midnight's Kachina model removes that requirement: a contract can hold
private state on the participant's own machine and prove things about it
on chain without revealing it.

SealedBid uses that to build a sealed-bid auction where:

- **Prices are hidden while bidding is open.** A bid is a commitment; the ledger
  stores the digest, not the number.
- **Only the winner's price is published.** Because a reveal is only accepted if
  it strictly beats the current lowest, a supplier whose price is not winning
  simply cannot open their bid — so their price never appears.
- **The bidding window cannot be gamed.** It is bounded by a deadline the buyer
  can neither shorten nor extend.
- **The buyer cannot escape a valid result.** Once a valid price is public the
  auction can never be cancelled.

## How it works

### Lifecycle

```
  Uninitialized ──initializeAuction──▶ Bidding ──openReveal──▶ Reveal ──settle──▶ Settled
                                         │                       │
                                         └────────cancel─────────┴──▶ Cancelled
                                              (until a valid bid is opened)
```

### The six circuits

| Circuit | Who | What it proves |
| --- | --- | --- |
| `initializeAuction` | auctioneer | Publishes the lot digest, reserve and deadlines; refuses a bidding window that is already closed or a reserve of zero. |
| `submitBid` | any supplier | Writes a 32-byte commitment addressed by the caller's derived identity. Re-calling before the deadline replaces it, letting a supplier improve their offer. |
| `openReveal` | auctioneer | Refused until `bidDeadline` has actually passed, so the sealed window can be neither shortened nor extended. |
| `revealBid` | the supplier who sealed it | Recomputes the commitment from `(amount, nonce)` and asserts it equals the sealed digest, that the amount is positive and within the reserve, and that it strictly beats the running lowest. |
| `settle` | auctioneer | Awards the ledger's recorded leader, but only once at least `requiredBidders` distinct suppliers have bid — the usual procurement control against single-source awards. |
| `cancel` | auctioneer | Voids the auction while no *valid* result is public. |

### Why only the winner's price is published

`revealBid` asserts `!hasWinner || amount < lowestBid`. The circuit executes off
chain and its constraints are enforced by the proof, so a supplier whose price
is not lower than the current best genuinely *cannot* produce a valid
transaction. Their price is never written anywhere. The only prices that ever
reach the ledger are the successive running minima — and the final one is the
winning bid.

### Authorisation

Every role is derived from a private 32-byte secret that never leaves the
participant's machine:

```
bidderKey     = persistentHash(tag=1, secret)
auctioneerKey = persistentHash(tag=2, secret)
commitment    = persistentHash(tag=3, amount, nonce)
```

`ownPublicKey()` is deliberately **never** used. It returns a value the prover
merely claims, with no cryptographic binding to the transaction signer, so any
authorisation that depends on it is bypassable. Authorisation here means "prove
you know the preimage of the identity stored on the ledger", which the ZK proof
enforces.

### Privacy summary

| Data | Where it lives | Public? |
| --- | --- | --- |
| Identity secret | Private state, encrypted at rest | No |
| Bid nonce | Private state, encrypted at rest | No |
| Bid amount | Private state until opened | Only if it takes the lead |
| Bid commitment | Ledger | Yes (a 32-byte digest) |
| Lot text | Published as a file, committed by digest | Yes |

## Repository structure

```
.
├── contract/                            Compact smart contract + tests
│   ├── src/
│   │   ├── sealed-bid-auction.compact   The contract
│   │   ├── witnesses.ts                 Private state + witness implementations
│   │   ├── index.ts                     Package entry point
│   │   ├── managed/                     GENERATED by `compact compile` (committed)
│   │   │   └── sealed-bid-auction/
│   │   │       ├── contract/            TypeScript bindings
│   │   │       ├── keys/                Prover + verifier keys, one pair per circuit
│   │   │       ├── zkir/                ZK intermediate representation
│   │   │       └── compiler/            contract-info.json
│   │   └── test/                        Unit + security test suite (97 tests)
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
├── cli/                                 Deploy and interaction tooling
│   ├── src/
│   │   ├── network.ts                   Endpoints, seed persistence, deploy records
│   │   ├── wallet.ts                    Wallet lifecycle, sync, DUST registration
│   │   ├── providers.ts                 Midnight.js provider set
│   │   ├── auction.ts                   Deploy / join / query helpers
│   │   ├── lot.ts                       Lot document + its on-chain digest
│   │   ├── private-state.ts             Private state shape + sealed-bid bookkeeping
│   │   ├── submit.ts                    Transient-failure retry policy
│   │   ├── address.ts                   Print the address to fund
│   │   ├── deploy.ts                    Non-interactive deploy
│   │   ├── demo.ts                      Live walkthrough of all six circuits
│   │   ├── verify.ts                    Read-only verification from the indexer
│   │   └── cli.ts                       Interactive menu
│   ├── devnet.yml                       Local devnet (node + indexer + proof server)
│   ├── devnet.host-override.yml         Host-network variant for broken Docker bridges
│   ├── proof-server.yml                 Proof server only, for public testnets
│   └── .env.example
├── deployments/                         Public deployment records (committed)
├── docs/
│   ├── DESIGN.md                        Contract design, invariants and threat model
│   └── VERIFICATION.md                  Acceptance-audit evidence
├── .compact-version                     Pinned compiler version (0.31.1)
├── .nvmrc
└── package.json                         npm workspaces root
```

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | 22 or newer | `node --version` |
| Docker + Compose v2 | recent | Runs the proof server (required to submit anything) |
| Compact toolchain | 0.31.1 | Installed below |

The toolchain versions in this repository are a deliberate, tested combination —
Compact 0.31.1 targets ledger 8.0.2 and runtime 0.16.0, which is what Midnight.js
4.1.1 and proof-server 8.1.0 speak. Changing one without the others will produce
contracts the network rejects.

### Install the Compact toolchain

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh

# Add the CLI to PATH for this shell
export PATH="$HOME/.local/bin:$PATH"

# Install the exact compiler this project uses
compact update 0.31.1

# Verify — must print 0.31.1
compact compile --version
```

If you already have the devtools, `compact self update` updates the CLI itself
and `compact clean` resets a broken `~/.compact` directory.

## Installation

```bash
git clone <your-fork-url> sealedbid
cd sealedbid
npm install
```

`npm install` sets up both workspaces. Note the `overrides` block in the root
`package.json`: it pins the protocol packages to a single copy each. Midnight.js
otherwise resolves `@midnight-ntwrk/onchain-runtime-v3` twice, and the
`instanceof StateValue` check inside `midnight-js-contracts` then fails on every
circuit call with `expected instance of StateValue`. Leave those overrides alone.

## Compiling the contract

```bash
npm run compile
# or: cd contract && npm run compact
```

Expected output:

```
Compiling 6 circuits:
```

The first compile generates the prover keys and may take a minute. It needs no
network access and produces no fake artifacts — everything under
`contract/src/managed/` is emitted by `compactc`.

## Running the tests

```bash
npm test
```

Expected: **97 passing tests across 7 files**. The suite runs entirely in
process — no proof server, no wallet, no network — because it drives the *real
generated circuits* against the real `compact-runtime`, swapping caller
identity and block time per call:

| File | Covers |
| --- | --- |
| `identity.test.ts` | Identity derivation, domain separation, commitment binding |
| `lifecycle.test.ts` | Deployment, initialisation, the phase machine, deadlines |
| `bidding.test.ts` | Sealing, replacement, deadline boundaries, slot isolation |
| `reveal.test.ts` | Commitment verification, reserve checks, monotonic lowest bid, privacy |
| `settlement.test.ts` | Awarding, the supplier quorum, cancellation rules |
| `security.test.ts` | Impersonation, bid sniping, deadline integrity, rollback, known limitations |
| `scenario.test.ts` | End-to-end runs: awarded, unsold and cancelled procurements |

Also useful:

```bash
npm run typecheck        # both workspaces
npm run ci               # compile + build + test, as CI runs it
```

## Generating artifacts

`contract/src/managed/` is committed so the repository is usable without a
compiler, but it is regenerated, never hand-written:

```bash
npm run compile
git status contract/src/managed
```

For the record, the artifacts produced for this contract are:

```
contract/src/managed/sealed-bid-auction/
├── compiler/contract-info.json          Compiler/language/runtime versions, circuit signatures
├── contract/index.js, index.d.ts        TypeScript bindings
├── keys/<circuit>.prover                17 MB total across 6 circuits
├── keys/<circuit>.verifier
└── zkir/<circuit>.zkir, <circuit>.bzkir
```

## Deploying

The deployment is a two-step flow (`deploy.ts` does both in one run): the
contract is deployed, then `initializeAuction` publishes the lot.

### 1. Configure

```bash
cp cli/.env.example cli/.env
# edit cli/.env and set MIDNIGHT_STORAGE_PASSWORD
```

The password encrypts the contract's private state on disk — the identity secret
and the bid nonces. There is no recovery mechanism: lose it and you lose the
ability to open your sealed bids.

### 2. Start a proof server

Every transaction needs a proof, and the proof server runs locally.

For a public testnet (Preview/Preprod):

```bash
npm run proof-server:up          # docker compose -f proof-server.yml up -d
```

For the fully local devnet (node + indexer + proof server, pre-minted NIGHT, no
faucet):

```bash
npm run devnet:up                # docker compose -f devnet.yml up -d --wait
```

### 3. Get the address and fund it

```bash
npm run wallet:address -- --network preview
```

This creates `cli/.midnight-wallet.json` (mode `0600`, gitignored) on first run
and prints the address. Send testnet tNIGHT from the faucet, then deploy:

| Network | Faucet |
| --- | --- |
| Preview | https://midnight-tmnight-preview.nethermind.dev |
| Preprod | https://midnight-tmnight-preprod.nethermind.dev |

The local devnet needs no funding: its `dev` preset pre-mints NIGHT to the
well-known genesis seed, which `network.ts` uses automatically.

### 4. Deploy

```bash
npm run deploy -- --network preview     # or: deploy -- --network preprod
npm run deploy -- --network undeployed  # local devnet
```

The script syncs the wallet, waits for funds, registers NIGHT for DUST
generation (DUST is the fee resource), deploys, initialises, writes
`deployments/<network>.json` and `deployments/lot-<network>.md`, and prints the
contract address.

Auction terms are configurable via environment variables (see `cli/.env.example`):
`SEALEDBID_RESERVE`, `SEALEDBID_BID_WINDOW_SECONDS`,
`SEALEDBID_REVEAL_WINDOW_SECONDS`, `SEALEDBID_REQUIRED_BIDDERS`,
`SEALEDBID_LOT_TITLE`, `SEALEDBID_LOT_SCOPE`, `SEALEDBID_UNIT`.

### 5. Drive an auction

Interactive:

```bash
npm run cli -- --network preview
```

Or run the whole lifecycle non-interactively, which is also the strongest
end-to-end check in the repository — it exercises all six circuits against a
real node and proof server and reads the result back from the indexer:

```bash
npm run --workspace @sealedbid/cli run demo -- --network preview
```

### Reproducing the entire workflow from scratch

```bash
npm install
npm run compile
npm run build
npm test
npm run devnet:up            # or: npm run proof-server:up for a public testnet
npm run deploy -- --network undeployed
npm run --workspace @sealedbid/cli run verify -- --network undeployed
```

## Verification

`verify` reads the deployed contract's state directly from the network indexer,
recomputes the lot digest from the published document, and compares both against
the deployment record. It needs no wallet, no proof server and no private
material, so anyone can run it against any contract address.

```bash
npm run --workspace @sealedbid/cli run verify -- --network preview
npm run --workspace @sealedbid/cli run verify -- --contract=<address> --network preprod
```

You can also read the raw state yourself with a single GraphQL query:

```bash
curl -s https://indexer.preview.midnight.network/api/v4/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ contractAction(address:\"<address>\") { state } }"}'
```

### What "verified" means here

- The deployment record's address and lot digest match what the indexer serves.
- The lot digest recomputed from `deployments/lot-<network>.md` matches the
  `lotHash` on chain, so the published terms are the terms that were committed.
- The recorded auctioneer key matches the deployer's derived identity.
- The phase, sealed-bid count, lowest opened bid and winner are reported straight
  from chain state.

## Deployment record

### Preview (public testnet)

| Field | Value |
| --- | --- |
| Network | `preview` (Midnight Preview public testnet) |
| Contract address | _see `deployments/preview.json`_ |
| Deployed at | _see `deployments/preview.json`_ |
| Deployer address | _see `deployments/preview.json`_ |
| Indexer | https://indexer.preview.midnight.network/api/v4/graphql |
| Node | https://rpc.preview.midnight.network |
| Compiler | 0.31.1 (language 0.23.0) |
| Lot document | `deployments/lot-preview.md` |

### Local devnet (fully local, no faucet)

| Field | Value |
| --- | --- |
| Network | `undeployed` |
| Contract address | `9ed68fc4ef7f3e97f641452fedc3fcd35adece56e818b7072618b302712c0dc0` |
| Deployment tx | `005dac1a69dc3910bcfeadd16d8e33a85c1688aef7b47014cf55669c9ae680bc1a` (block 41) |
| Initialise tx | `004a5898d917e858c6aa9d745fcf16998b17745ce8b49d79e7f57f5cb8c3f91481` (block 45) |
| Phase at deploy | `Bidding` |
| Auctioneer key | `0424ca3ebf0451ca41ce10fd6ad664c552c220c4f57f511738c06fa1c64c9692` |
| Lot digest | `44ec22aaaa4eb618e34867137d7fd40fdd8272775b4cba2cd3d7b2fbd4ab753e` |
| Record | `deployments/undeployed.json` |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `compact: command not found` | The devtools install to `~/.local/bin`. Run `export PATH="$HOME/.local/bin:$PATH"`. |
| `compact compile` says the language version is unsupported | You are on the wrong compiler. `compact update 0.31.1` and check `.compact-version`. |
| Compile fails with `unbound identifier blockTime` | Compact has no clock accessor. Compare with the block instead: `blockTimeLt(t)` / `blockTimeGt(t)`. |
| Compile fails with "potential witness-value disclosure must be declared" | Wrap the value in `disclose(...)` — the compiler is telling you a private value is about to reach the ledger. |
| `expected instance of StateValue` on every circuit call | `@midnight-ntwrk/onchain-runtime-v3` resolved twice. The root `overrides` pins it; delete `node_modules` and reinstall. |
| `connect ECONNREFUSED 127.0.0.1:6300` | No proof server. `npm run proof-server:up`. |
| Proof server exits 1 with `Failed to fetch data from https://srs.midnight.network` | The container cannot resolve or reach the SRS host. It needs working DNS and IPv4 egress; both compose files pin a public resolver and put the service on Docker's default bridge for exactly this reason. See the comments in `proof-server.yml`. |
| Indexer logs `chain-indexer exited with ERROR ... Connection timeout exceeded` | Docker's user-defined bridge cannot carry traffic between containers in your environment. Use the host-network variant: `docker compose -f devnet.yml -f devnet.host-override.yml up -d --wait`. Note this is a Linux feature. |
| Deploy stalls on `...syncing` forever | The wallet syncs from the indexer. If the indexer has no blocks (`{ block { height } }` returns `null`), fix the indexer first — the wallet cannot make progress. |
| `Invalid Transaction: Custom error: 104` / `Insufficient Funds` | DUST timing race, not a contract refusal. The CLI retries these automatically; a fresh wallet needs a minute after registering NIGHT. |
| `Failed to clone intent` on submit | Wallet SDK signing issue. Ensure you are on `wallet-sdk` 1.2.0 and have not reintroduced an older facade. |
| Tests fail with `Cannot find module '../managed/...'` | Artifacts are missing. `npm run compile` first. |
| `npm run wallet:address` shows a different address than before | `cli/.midnight-wallet.json` was deleted, or `MIDNIGHT_SEED` is set and taking precedence. |
| `MIDNIGHT_STORAGE_PASSWORD is not set` | `cp cli/.env.example cli/.env` and set it. |

## Security

- **No secret is committed.** Wallet seeds live in `cli/.midnight-wallet.json`
  (mode `0600`) and private state in `cli/midnight-level-db/`; both are
  gitignored, and the repository history contains neither.
- **The wallet seed is the wallet.** Anyone with it controls the funds. Back up
  `cli/.midnight-wallet.json` if you care about the testnet balance.
- **Bid nonces are the bid.** A commitment is useless to a rival without the
  nonce, but `(amount, nonce)` *is* the bid. The CLI keeps nonces in the
  encrypted private state and never logs them.
- **The storage password is unrecoverable.** Losing it means losing the ability
  to open sealed bids stored under it.
- **Testnet only.** This repository targets Midnight's test networks. The
  contract has not been audited; see [docs/DESIGN.md](docs/DESIGN.md) for the
  known limitations, which are also pinned as tests.

## License

Apache-2.0. See [LICENSE](LICENSE).
