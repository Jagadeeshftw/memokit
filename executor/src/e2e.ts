/**
 * The Phase 1 acceptance test: one XRPL Testnet Payment, attested by FDC, executing a
 * deposit into a live Coston2 ERC-4626 vault out of assets the account already holds.
 *
 * No mint anywhere in the instruction path. The account is funded beforehand, deliberately
 * and visibly, and the script prints the balance before and after so the distinction is on
 * the record: this is Flare Smart Accounts' `0xFF`/`0xFE` capability without the
 * `executeDirectMintingWithData` coupling.
 *
 * The verifier is not used. The attestation request and its message integrity code are
 * built from ledger data by `fdc/buildResponse.ts`, proven equivalent to Flare's answer in
 * `test/buildResponse.test.ts`.
 *
 * Run: npm run e2e -w @memokit/executor
 *
 * Required env:
 *   PRIVATE_KEY            funded Coston2 EOA (pays the FDC fee and the execute gas)
 *   XRPL_SEED              XRPL Testnet wallet seed; the account owner
 *   MEMOKIT_DEPLOYMENT     path to deployment json (default fixtures/deployment.json)
 *   MEMOKIT_VAULT          ERC-4626 vault to deposit into
 *   MEMOKIT_DEPOSIT        amount in the asset's base units
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Contract,
  JsonRpcProvider,
  Wallet as EvmWallet,
  ZeroAddress,
  formatUnits,
  Interface,
} from "ethers";
import { Wallet as XrplWallet } from "xrpl";
import { encodeInstruction, encodeMemo, commitmentOf, type Instruction } from "@memokit/sdk";

import { COSTON2, SOURCE_ID_TESTNET } from "./config.js";
import { XrplTestnet, toTransactionId } from "./xrpl/pay.js";
import { buildXrpPaymentResponse } from "./fdc/buildResponse.js";
import { computeMic, encodeRequest } from "./fdc/encode.js";
import { DaLayerClient } from "./fdc/daLayer.js";
import { RoundClock } from "./fdc/rounds.js";

const REPO = resolve(import.meta.dirname, "../..");
const OUT = resolve(REPO, "fixtures/measurements/e2e-trace.json");

const ERC20 = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const ERC4626 = [
  "function asset() view returns (address)",
  "function deposit(uint256,address) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
];
const MEMOKIT = [
  "function execute(((bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,address),(uint64,uint64,string,bytes32,bytes32,bytes32,int256,int256,int256,int256,bool,bytes,bool,uint256,uint8)))) proof, bytes data) payable",
  "function nonceOf(address) view returns (uint256)",
  "function computeAccountAddress(string) view returns (address)",
  "function accountOf(string) view returns (address)",
];
const FDC_HUB = ["function requestAttestation(bytes) payable"];
const FEE_CONFIG = ["function getRequestFee(bytes) view returns (uint256)"];
const REGISTRY = ["function getContractAddressByName(string) view returns (address)"];

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

const marks: Array<{ stage: string; at: number }> = [];
function mark(stage: string) {
  marks.push({ stage, at: Date.now() });
  console.log(`  [${new Date().toISOString()}] ${stage}`);
}

async function main() {
  const provider = new JsonRpcProvider(COSTON2.rpc);
  const evm = new EvmWallet(need("PRIVATE_KEY"), provider);
  const deployment = JSON.parse(
    readFileSync(process.env.MEMOKIT_DEPLOYMENT ?? resolve(REPO, "fixtures/deployment.json"), "utf8"),
  );

  const memokit = new Contract(deployment.diamond, MEMOKIT, evm);
  const registry = new Contract(COSTON2.contractRegistry, REGISTRY, provider);
  const vaultAddress = need("MEMOKIT_VAULT");
  const vault = new Contract(vaultAddress, ERC4626, provider);
  const assetAddress: string = await vault.asset();
  const asset = new Contract(assetAddress, ERC20, provider);
  const decimals: number = Number(await asset.decimals());
  const depositAmount = BigInt(need("MEMOKIT_DEPOSIT"));

  const xrpl = new XrplTestnet();
  const xrplWallet = XrplWallet.fromSeed(need("XRPL_SEED"));

  console.log("memokit   ", deployment.diamond);
  console.log("vault     ", vaultAddress, await vault.symbol());
  console.log("asset     ", assetAddress, await asset.symbol(), `(${decimals} decimals)`);
  console.log("XRPL owner", xrplWallet.address);
  console.log("relayer   ", evm.address);

  const account: string = await memokit.computeAccountAddress(xrplWallet.address);
  console.log("account   ", account);

  // --- step 0: show that the account already holds the assets -------------------------
  const assetBefore: bigint = await asset.balanceOf(account);
  const sharesBefore: bigint = await vault.balanceOf(account);
  console.log(`\nbefore: ${formatUnits(assetBefore, decimals)} asset, ${formatUnits(sharesBefore, decimals)} shares`);
  if (assetBefore < depositAmount) {
    throw new Error(
      `account holds ${formatUnits(assetBefore, decimals)} but the instruction deposits ` +
        `${formatUnits(depositAmount, decimals)}. Fund ${account} with ${assetAddress} first -- ` +
        `funding is deliberately outside the instruction path.`,
    );
  }

  // --- step 1: build the instruction and the memo --------------------------------------
  const erc20 = new Interface(ERC20);
  const erc4626 = new Interface(ERC4626);
  const nonce: bigint = await memokit.nonceOf(account);
  const instruction: Instruction = {
    sender: account,
    nonce,
    calls: [
      { target: assetAddress, value: 0n, data: erc20.encodeFunctionData("approve", [vaultAddress, depositAmount]) },
      { target: vaultAddress, value: 0n, data: erc4626.encodeFunctionData("deposit", [depositAmount, account]) },
    ],
  };
  const payload = encodeInstruction(instruction);
  const memo = encodeMemo({
    kind: "execCommit",
    opcode: 0xfc,
    walletId: 1,
    executorFee: 0n,
    commitment: commitmentOf(instruction),
  });
  console.log(`\ninstruction nonce ${nonce}, memo ${(memo.length - 2) / 2} bytes: ${memo}`);

  // --- step 2: the XRPL payment ---------------------------------------------------------
  mark("xrpl:submit");
  const sent = await xrpl.sendMemoPayment(
    xrplWallet,
    deployment.receivingAddress,
    process.env.XRPL_DROPS ?? "1000000",
    memo,
  );
  mark("xrpl:validated");
  console.log(`  XRPL tx ${sent.hash} in ledger ${sent.ledgerIndex}`);

  const transactionId = toTransactionId(sent.hash);

  // --- step 3: build the request offline --------------------------------------------------
  const client = await xrpl.connect();
  const raw = (await client.request({ command: "tx", transaction: sent.hash } as never)) as {
    result: Record<string, unknown>;
  };
  const ledgerTx = { ...((raw.result.tx_json as object) ?? {}), ...raw.result };
  const response = buildXrpPaymentResponse(ledgerTx as never, SOURCE_ID_TESTNET, transactionId, ZeroAddress);
  const mic = computeMic(response);
  const abiEncodedRequest = encodeRequest(
    { transactionId, proofOwner: ZeroAddress },
    SOURCE_ID_TESTNET,
    mic,
  );
  mark("fdc:request-built-offline");
  console.log(`  MIC ${mic}`);

  // --- step 4: submit the attestation request ---------------------------------------------
  const hubAddress: string = await registry.getContractAddressByName("FdcHub");
  const feeConfigAddress: string = await registry.getContractAddressByName("FdcRequestFeeConfigurations");
  const fee: bigint = await new Contract(feeConfigAddress, FEE_CONFIG, provider).getRequestFee(abiEncodedRequest);
  console.log(`  FdcHub ${hubAddress}, fee ${fee} wei`);

  const hub = new Contract(hubAddress, FDC_HUB, evm);
  const requestTx = await hub.requestAttestation(abiEncodedRequest, { value: fee });
  const requestReceipt = await requestTx.wait();
  mark("fdc:request-submitted");
  console.log(`  requestAttestation ${requestReceipt.hash} in block ${requestReceipt.blockNumber}`);

  // --- step 5: wait for the round, then the proof -------------------------------------------
  const clock = new RoundClock(provider);
  const block = await provider.getBlock(requestReceipt.blockNumber);
  const votingRoundId = await clock.roundIdAt(Number(block!.timestamp));
  console.log(`  voting round ${votingRoundId}`);

  const da = new DaLayerClient();
  const proofResponse = await da.waitForProof(
    votingRoundId,
    abiEncodedRequest,
    Date.now() + 15 * 60_000,
    10_000,
  );
  mark("fdc:proof-available");

  // --- step 6: execute ----------------------------------------------------------------------
  const r = proofResponse.response as Record<string, any>;
  const rb = r.responseBody;
  const proofArg = [
    proofResponse.proof,
    [
      r.attestationType,
      r.sourceId,
      BigInt(r.votingRound),
      BigInt(r.lowestUsedTimestamp),
      [r.requestBody.transactionId, r.requestBody.proofOwner],
      [
        BigInt(rb.blockNumber), BigInt(rb.blockTimestamp), rb.sourceAddress,
        rb.sourceAddressHash, rb.receivingAddressHash, rb.intendedReceivingAddressHash,
        BigInt(rb.spentAmount), BigInt(rb.intendedSpentAmount),
        BigInt(rb.receivedAmount), BigInt(rb.intendedReceivedAmount),
        rb.hasMemoData, rb.firstMemoData, rb.hasDestinationTag,
        BigInt(rb.destinationTag), Number(rb.status),
      ],
    ],
  ];

  const execTx = await memokit.execute(proofArg, payload);
  const execReceipt = await execTx.wait();
  mark("memokit:executed");
  console.log(`  execute ${execReceipt.hash} in block ${execReceipt.blockNumber}`);

  // --- step 7: the result ---------------------------------------------------------------------
  const assetAfter: bigint = await asset.balanceOf(account);
  const sharesAfter: bigint = await vault.balanceOf(account);
  console.log(`\nafter:  ${formatUnits(assetAfter, decimals)} asset, ${formatUnits(sharesAfter, decimals)} shares`);
  console.log(`shares gained: ${formatUnits(sharesAfter - sharesBefore, decimals)}`);

  const legs: Record<string, number> = {};
  for (let i = 1; i < marks.length; i++) {
    legs[`${marks[i - 1].stage} -> ${marks[i].stage}`] = Math.round((marks[i].at - marks[i - 1].at) / 1000);
  }
  legs["total"] = Math.round((marks[marks.length - 1].at - marks[0].at) / 1000);

  const trace = {
    note: "Phase 1 acceptance trace. Generated by executor/src/e2e.ts.",
    capturedAt: new Date().toISOString(),
    network: { flare: "coston2", xrpl: "testnet" },
    memokit: deployment.diamond,
    xrplOwner: xrplWallet.address,
    account,
    receivingAddress: deployment.receivingAddress,
    vault: vaultAddress,
    asset: assetAddress,
    memo,
    instructionPayload: payload,
    xrplTransactionHash: sent.hash,
    xrplLedgerIndex: sent.ledgerIndex,
    transactionId,
    messageIntegrityCode: mic,
    abiEncodedRequest,
    attestationFeeWei: fee.toString(),
    votingRoundId,
    requestAttestationTx: requestReceipt.hash,
    executeTx: execReceipt.hash,
    balances: {
      assetBefore: assetBefore.toString(),
      assetAfter: assetAfter.toString(),
      sharesBefore: sharesBefore.toString(),
      sharesAfter: sharesAfter.toString(),
      sharesGained: (sharesAfter - sharesBefore).toString(),
      decimals,
    },
    latencySeconds: legs,
    explorer: {
      requestAttestation: `${COSTON2.explorer}/tx/${requestReceipt.hash}`,
      execute: `${COSTON2.explorer}/tx/${execReceipt.hash}`,
      xrpl: `https://testnet.xrpl.org/transactions/${sent.hash}`,
    },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(trace, null, 2) + "\n");
  console.log(`\nwrote ${OUT}`);
  console.log(`latency: ${JSON.stringify(legs)}`);

  await xrpl.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
