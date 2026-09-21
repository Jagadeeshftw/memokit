# memokit

XRPL-originated arbitrary calls on Flare, acting on assets a personal account **already
holds**. No FAssets mint in the path.

## What this is

A user signs one XRPL Payment carrying an instruction in the memo. An executor proves that
payment onto Flare with the FDC `XRPPayment` attestation. A per-XRPL-address account on
Flare executes the instruction against its own balances.

Flare Smart Accounts already reaches arbitrary calls, via memo opcodes `0xFF`/`0xFE` — but
only as a side effect of `executeDirectMintingWithData`, so every instruction mints FXRP and
inherits FAssets' direct-minting limits. That coupling is the gap memokit fills.

memokit keeps the safety machinery rather than shedding it: a pause facet, an owner-managed
receiving-address registry, and a timelock on economic parameters, with the same
timelocked/immediate split Flare uses.

## Layout

```
contracts/    diamond, facets, libraries, account implementation
sdk/          memo codec (TypeScript), the wire format's reference encoder
executor/     attestation client, offline MIC, DA Layer, measurements, end-to-end runner
scripts/      deployment
test/         Solidity tests, including TS/Solidity codec conformance
fixtures/     golden wire vectors and live-infrastructure captures
```

## Wire format

Header, byte-identical to Flare's so an integrated wallet changes one byte:

```
byte  0    : opcode
byte  1    : walletId (uint8)
bytes 2..9 : executorFee (uint64, big-endian)
```

| Opcode | Payload | Length |
|---|---|---|
| `0xFD` | `abi.encode(sender, nonce, Call[])` inline | 10 + N |
| `0xFC` | `keccak256(payload)`, payload supplied out of band | 42 |
| `0xF8`–`0xFB` | reserved | — |
| `0xE0` | `targetTxId` — retire a stuck transaction | 42 |
| `0xE1` | `newNonce` — advance past a stuck instruction | 42 |
| `0xE2` | `targetTxId` + `newFee` — override the executor fee | 50 |

`0xE0`/`0xE1`/`0xE2` reuse Flare's opcodes at their original values and semantics. The
receiving XRPL address disambiguates which protocol a memo is addressed to.

## Getting started

```bash
npm install
forge build
forge test          # 68 Solidity tests
npm test            # 63 TypeScript tests
npm run fixtures    # regenerate golden wire vectors
```

Copy `.env.example` to `.env` and fill it in before deploying or running end to end.

```bash
forge script scripts/DeployMemoKit.s.sol:DeployMemoKit \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc --broadcast
npm run e2e -w @memokit/executor
```

### Measurements against live infrastructure

```bash
npm run verify:mic -w @memokit/executor   # confirms the offline MIC against Flare's verifier
npm run measure:da -w @memokit/executor   # DA Layer rate limits and finalisation lag
```

## Notes

- The Flare verifier is **not** on the critical path. The attestation request and its message
  integrity code are built from XRPL ledger data by `executor/src/fdc/buildResponse.ts`; the
  verifier is used only as a test oracle to prove that implementation correct.
- Networks: Coston2 (Flare) paired with XRPL Testnet, `sourceId = testXRP`.

See [PHASE1.md](PHASE1.md) for what is built, what is measured, and what is still open.
[phase0-report.md](phase0-report.md) has the investigation this is based on.
