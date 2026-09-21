/**
 * Runs one instruction end to end against Coston2 and writes the trace, using only the SDK's
 * public API. A scenario says what to do; this says how, so the Phase 1 vault deposit and the
 * Phase 2 payout are the same code path and the same trace format.
 *
 *   prepareInstruction -> XRPL payment -> requestAttestation -> waitForProof -> submit
 *
 * Nothing here calls Flare's verifier.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet as EvmWallet, type ContractTransactionReceipt } from "ethers";
import { Wallet as XrplWallet } from "xrpl";
import {
  CONTROLLER_ABI,
  prepareInstruction,
  requestAttestation,
  submit,
  toTransactionId,
  waitForProof,
  type Call,
} from "@memokit/sdk";
import { XrplSender } from "@memokit/sdk/xrpl";
import { NETWORK } from "./config.js";

export const REPO = resolve(import.meta.dirname, "../..");

export interface Deployment {
  diamond: string;
  receivingAddress: string;
  [k: string]: unknown;
}

export interface Ctx {
  provider: JsonRpcProvider;
  account: string;
  nonce: bigint;
  relayer: string;
  deployment: Deployment;
}

export interface Built {
  feeToken: string;
  feeAmount: bigint;
  calls: Call[];
}

export interface Scenario {
  /** Trace filename: fixtures/measurements/e2e-trace-<label>.json. */
  label: string;
  note: string;
  /** Called once the account and nonce are known. Throw to refuse to send (e.g. unfunded). */
  build(ctx: Ctx): Promise<Built>;
  /**
   * Read whatever the scenario cares about. Called at the start (`latest`), at the block before
   * the execute and at the execute block, so a delta is measured across exactly one transaction.
   */
  snapshot(ctx: Ctx, blockTag: number | "latest"): Promise<Record<string, unknown>>;
  /** Extra trace fields, computed from the two snapshots and the execute receipt. */
  analyse?(ctx: Ctx, at: { before: Record<string, unknown>; after: Record<string, unknown>; receipt: ContractTransactionReceipt }): Promise<Record<string, unknown>>;
}

const marks: Array<{ stage: string; at: number }> = [];
function mark(stage: string) {
  marks.push({ stage, at: Date.now() });
  console.log(`  [${new Date().toISOString()}] ${stage}`);
}

/** Replace bigints so a snapshot survives JSON.stringify. */
export function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export async function runScenario(scenario: Scenario): Promise<void> {
  const provider = new JsonRpcProvider(NETWORK.rpc);
  const evm = new EvmWallet(need("PRIVATE_KEY"), provider);
  const deployment: Deployment = JSON.parse(
    readFileSync(process.env.MEMOKIT_DEPLOYMENT ?? resolve(REPO, "fixtures/deployment.json"), "utf8"),
  );
  const xrplWallet = XrplWallet.fromSeed(need("XRPL_SEED"));

  const controller = new Contract(deployment.diamond, CONTROLLER_ABI, provider);
  const account: string = await controller.computeAccountAddress(xrplWallet.address);
  const nonce: bigint = await controller.nonceOf(account);
  const ctx: Ctx = { provider, account, nonce, relayer: evm.address, deployment };

  console.log("memokit   ", deployment.diamond);
  console.log("XRPL owner", xrplWallet.address);
  console.log("relayer   ", evm.address);
  console.log("account   ", account, `(nonce ${nonce})`);

  const startedAt = await scenario.snapshot(ctx, "latest");
  console.log("\nbefore:", JSON.stringify(jsonSafe(startedAt)));

  // 1. build ---------------------------------------------------------------------------
  const built = await scenario.build(ctx);
  const prepared = prepareInstruction({ sender: account, nonce, ...built });
  console.log(`\ninstruction: ${built.calls.length} call(s), fee ${built.feeAmount} of ${built.feeToken}`);
  console.log(`memo ${(prepared.memo.length - 2) / 2} bytes: ${prepared.memo}`);

  // 2. XRPL payment ----------------------------------------------------------------------
  const xrpl = new XrplSender(NETWORK.xrpl.websocket);
  mark("xrpl:submit");
  const sent = await xrpl.sendMemoPayment(xrplWallet, deployment.receivingAddress, process.env.XRPL_DROPS ?? "1000000", prepared.memo);
  await xrpl.disconnect();
  mark("xrpl:validated");
  console.log(`  XRPL tx ${sent.hash} in ledger ${sent.ledgerIndex}`);

  // 3-4. attestation request (built offline) ----------------------------------------------
  const request = await requestAttestation({ signer: evm, xrplHash: sent.hash, network: NETWORK });
  mark("fdc:request-submitted");
  console.log(`  MIC ${request.messageIntegrityCode}`);
  console.log(`  requestAttestation ${request.txHash} in block ${request.blockNumber}, voting round ${request.votingRoundId}`);

  // 5. proof ------------------------------------------------------------------------------
  const attested = await waitForProof({ request, network: NETWORK });
  mark("fdc:proof-available");
  console.log(`  attested memo matches, voting round ${attested.response.votingRound}`);

  // 6. execute ----------------------------------------------------------------------------
  // A revert leaves the transaction id unconsumed and the nonce unchanged, so retrying with the
  // same proof is safe. Phase 1 saw FXRP transfers revert transiently; the attempt count goes
  // in the trace so a retry can never be mistaken for a clean first try.
  const submitErrors: string[] = [];
  let receipt: ContractTransactionReceipt | undefined;
  for (let attempt = 1; attempt <= 3 && !receipt; attempt++) {
    try {
      receipt = await submit({ signer: evm, controller: deployment.diamond, proof: attested.proof, payload: prepared.payload });
    } catch (e) {
      submitErrors.push(String((e as Error).message).slice(0, 300));
      console.log(`  execute attempt ${attempt} reverted: ${submitErrors.at(-1)}`);
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  if (!receipt) throw new Error("unreachable");
  mark("memokit:executed");
  console.log(`  execute ${receipt.hash} in block ${receipt.blockNumber}`);

  // 7. result -----------------------------------------------------------------------------
  const before = await scenario.snapshot(ctx, receipt.blockNumber - 1);
  const after = await scenario.snapshot(ctx, receipt.blockNumber);
  const extra = (await scenario.analyse?.(ctx, { before, after, receipt })) ?? {};

  const legs: Record<string, number> = {};
  for (let i = 1; i < marks.length; i++) {
    legs[`${marks[i - 1].stage} -> ${marks[i].stage}`] = Math.round((marks[i].at - marks[i - 1].at) / 1000);
  }
  legs["total"] = Math.round((marks[marks.length - 1].at - marks[0].at) / 1000);

  const trace = {
    note: scenario.note,
    capturedAt: new Date().toISOString(),
    network: { flare: NETWORK.name, xrpl: "testnet" },
    memokit: deployment.diamond,
    xrplOwner: xrplWallet.address,
    account,
    relayer: evm.address,
    receivingAddress: deployment.receivingAddress,
    memo: prepared.memo,
    instructionPayload: prepared.payload,
    instruction: jsonSafe({ sender: account, nonce, ...built }),
    xrplTransactionHash: sent.hash,
    xrplLedgerIndex: sent.ledgerIndex,
    transactionId: toTransactionId(sent.hash),
    messageIntegrityCode: request.messageIntegrityCode,
    abiEncodedRequest: request.abiEncodedRequest,
    attestationFeeWei: request.feeWei.toString(),
    votingRoundId: request.votingRoundId,
    requestAttestationTx: request.txHash,
    executeTx: receipt.hash,
    executeBlock: receipt.blockNumber,
    executeGasUsed: receipt.gasUsed.toString(),
    executeAttempts: submitErrors.length + 1,
    executeRevertedAttempts: submitErrors,
    stateAtStart: jsonSafe(startedAt),
    stateBeforeExecuteBlock: jsonSafe(before),
    stateAtExecuteBlock: jsonSafe(after),
    ...jsonSafe(extra),
    latencySeconds: legs,
    explorer: {
      requestAttestation: `${NETWORK.explorer}/tx/${request.txHash}`,
      execute: `${NETWORK.explorer}/tx/${receipt.hash}`,
      xrpl: `${NETWORK.xrpl.explorer}/transactions/${sent.hash}`,
    },
  };

  const out = resolve(REPO, `fixtures/measurements/e2e-trace-${process.env.TRACE_LABEL ?? scenario.label}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(trace, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
  console.log(`latency: ${JSON.stringify(legs)}`);
}

export function runMain(scenario: Scenario): void {
  runScenario(scenario).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
