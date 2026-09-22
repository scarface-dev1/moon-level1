# Verification evidence

These files are **captured stdout** from real runs, not hand-written summaries.
They are the raw material for the screenshots in [`../screenshots/`](../screenshots)
and for the numbers quoted in [`../../README.md`](../../README.md) and
[`../VERIFICATION.md`](../VERIFICATION.md).

| File | Produced by |
| --- | --- |
| `compile.txt` | `npm run evidence` — deletes `contract/src/managed/`, recompiles from the Compact source, and shows the result is byte-identical to what is committed |
| `tests.txt` | `npm test` |
| `deploy.txt` | `npm run deploy -- --network undeployed` |
| `verify.txt` | `npm run verify -- --network undeployed` |
| `demo.txt` | `npm --workspace @sealedbid/cli run demo -- --network undeployed` — all six circuits exercised on chain |

## Reproducing them

```bash
# Toolchain first — see the README for the installer.
export PATH="$HOME/.local/bin:$PATH"
compact update 0.31.1

npm install
npm run evidence        # -> compile.txt (also re-verifies the artifacts)
npm test                # -> tests.txt
```

For the deployment transcripts, start the proof server and the local devnet:

```bash
npm run devnet:up
npm run deploy -- --network undeployed
npm run verify -- --network undeployed
npm --workspace @sealedbid/cli run demo -- --network undeployed
```

The `demo` run takes a couple of minutes because it deliberately waits for the
bidding window to close before opening the reveal — that wait is the contract
refusing to let anyone reveal early, not a retry loop.

To re-render the PNG screenshots from these transcripts:

```bash
pip install Pillow
npm run screenshots
```

The renderer collapses carriage-return progress redraws the way a terminal
would, so the images show final state rather than every intermediate frame.
