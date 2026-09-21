# @memokit/sdk

> Package name is provisional. It is one field in `package.json`; rename it there and in the
> workspace imports before publishing. Not published.

Execute calls on Flare from a single XRPL payment, acting on assets a Flare account **already
holds**. There is no FAssets mint in the path, no Flare-assigned destination tag and no wallet
registration: the account is derived from your XRPL address, and the memo is a 42-byte commitment
to what it should do.

```
npm i @memokit/sdk ethers xrpl      # xrpl is only needed to *send* the payment
```

Node 20+, ESM. `ethers` v6 is a peer dependency.

## Quickstart: a vault deposit

The Phase 1 acceptance run, in 29 lines. The account must already hold the asset; funding it is
deliberately outside the instruction path.

```ts
import { JsonRpcProvider, Wallet, Contract, Interface, ZeroAddress } from "ethers";
import { Wallet as XrplWallet } from "xrpl";
import { COSTON2, CONTROLLER_ABI, prepareInstruction, requestAttestation, waitForProof, submit } from "@memokit/sdk";
import { sendMemoPayment } from "@memokit/sdk/xrpl";

const { DIAMOND, RECEIVING, VAULT, ASSET } = process.env as Record<string, string>;
const relayer = new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(COSTON2.rpc));
const owner = XrplWallet.fromSeed(process.env.XRPL_SEED!);
const memokit = new Contract(DIAMOND, CONTROLLER_ABI, relayer);
const account = await memokit.computeAccountAddress(owner.address); // holds the assets already
const amount = 1_000_000n;

// 1. What the account should do: approve, then deposit into an ERC-4626 vault.
const { payload, memo } = prepareInstruction({
  sender: account, nonce: await memokit.nonceOf(account), feeToken: ZeroAddress, feeAmount: 0n,
  calls: [
    { target: ASSET, value: 0n, data: new Interface(["function approve(address,uint256)"]).encodeFunctionData("approve", [VAULT, amount]) },
    { target: VAULT, value: 0n, data: new Interface(["function deposit(uint256,address)"]).encodeFunctionData("deposit", [amount, account]) },
  ],
});

// 2. One XRPL payment carrying the 42-byte memo, then FDC attests it (~150 s, one FDC round).
const sent = await sendMemoPayment({ network: COSTON2, wallet: owner, destination: RECEIVING, drops: "1000000", memo });
const request = await requestAttestation({ signer: relayer, xrplHash: sent.hash, network: COSTON2 });
const { proof } = await waitForProof({ request, network: COSTON2 });

// 3. Anyone can deliver the proof and the preimage; the account executes exactly what was committed.
const receipt = await submit({ signer: relayer, controller: DIAMOND, proof, payload });
console.log("executed", receipt.hash);
```

Expect about **150 s** from the XRPL payment to `execute`. That is the FDC voting round finalising
and reaching the Data Availability Layer, a property of the protocol's cadence rather than of this
library; polling faster does not shorten it.

## API

| Step | Call | Notes |
| --- | --- | --- |
| build | `prepareInstruction(instruction)` | Returns `{ payload, commitment, memo }`. Keep `payload`; the memo carries only its hash. |
| build | `encodeMemo`, `decodeMemo`, `encodeInstruction`, `commitmentOf` | The wire format underneath. Byte-compatible with Flare's memo header. |
| send | `sendMemoPayment` from `@memokit/sdk/xrpl` | One memo, no destination tag: both enforced. |
| attest | `requestAttestation({ signer, xrplHash })` | Builds the request and its MIC from the ledger record. Never calls Flare's verifier. |
| attest | `waitForProof({ request })` | Polls the DA Layer (no API key). Checks the attested memo is the one sent. |
| execute | `submit({ signer, controller, proof, payload })` | Callable by anyone. The caller earns the instruction's fee and cannot change what runs. |

Also exported: `COSTON2` and `FLARE` network presets (plain data; pass your own to override),
`DEFAULT_DEADLINE_SECONDS` and `deadlineFromNow` (see below), and `@memokit/sdk/fdc` for the
lower-level pieces (ABI shapes, `buildXrpPaymentResponse`, MIC construction, DA Layer client).

FdcHub, the request-fee configuration and the Relay are read from Flare's Contract Registry at call
time, so nothing here pins a Flare contract address.

## The executor fee

The fee is part of the instruction, in the asset the instruction moves:

```ts
prepareInstruction({ sender, nonce, feeToken: FXRP, feeAmount: 100_000n, calls })
```

It is inside the hashed payload, so whoever calls `submit` cannot change it, and it is paid only
after every call succeeded. The header's `executorFee` field is reserved: leave it at zero.

## Deadlines

An instruction that touches a price should commit to a deadline in its own calldata. Attestation
takes minutes and the market does not wait. `DEFAULT_DEADLINE_SECONDS` is 900, derived from the
measured 152-162 s (see `src/deadline.ts`); `deadlineFromNow()` turns it into a timestamp.

## What can go wrong

A reverting `submit` leaves the XRPL transaction unconsumed and the account's nonce unchanged, so the
same proof can be resubmitted once the cause clears. A memo that can never execute is retired with a
`0xE0` memo, and a stuck nonce is skipped with `0xE1`. See the repository's `PHASE2.md`.
