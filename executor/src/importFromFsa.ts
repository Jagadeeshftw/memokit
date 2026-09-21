/**
 * Move FXRP from a Flare Smart Accounts personal account into the memokit account owned by
 * the same XRPL address, using Flare's own rail.
 *
 * One XRPL payment to Flare's provider wallet, carrying a 32-byte FSA payment reference that
 * names the memokit account as the recipient. FSA's `executeInstruction` does the transfer.
 * memokit relays the proof itself rather than waiting for Flare's operator, because
 * `executeInstruction` has no access control -- see `sdk/src/fsaImport.ts` for the full
 * verification.
 *
 * Run: npm run import-fsa -w @memokit/executor -- --drops 5000000
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet as EvmWallet, AbiCoder, formatUnits } from "ethers";
import { Wallet as XrplWallet } from "xrpl";
import {
  COSTON2,
  prepareImport,
  decodeImportReference,
  FSA_CONTROLLER,
} from "@memokit/sdk";
import { sendMemoPayment } from "@memokit/sdk/xrpl";
import { DaLayerClient, RoundClock } from "@memokit/sdk/fdc";
import { VERIFIER } from "./config.js";

const REPO = resolve(import.meta.dirname, "../..");
const OUT = resolve(REPO, "fixtures/measurements/fsa-import-trace.json");
const coder = AbiCoder.defaultAbiCoder();

/** The classic `Payment` attestation, which is what FSA's proof flow takes. */
const PAYMENT_RESPONSE_ABI =
  "tuple(bytes32 attestationType, bytes32 sourceId, uint64 votingRound, uint64 lowestUsedTimestamp," +
  "tuple(bytes32 transactionId, uint256 inUtxo, uint256 utxo) requestBody," +
  "tuple(uint64 blockNumber, uint64 blockTimestamp, bytes32 sourceAddressHash," +
  "bytes32 sourceAddressesRoot, bytes32 receivingAddressHash, bytes32 intendedReceivingAddressHash," +
  "int256 spentAmount, int256 intendedSpentAmount, int256 receivedAmount, int256 intendedReceivedAmount," +
  "bytes32 standardPaymentReference, bool oneToOne, uint8 status) responseBody)";

const FSA_EXECUTE_ABI = [
  `function executeInstruction((bytes32[],${PAYMENT_RESPONSE_ABI.replace("tuple", "")}) _proof, string _xrplAddress) payable`,
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const plain = (v: unknown): unknown => (Array.isArray(v) ? v.map(plain) : v);
const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`missing env ${n}`);
  return v;
};
const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const marks: Array<{ stage: string; at: number }> = [];
const mark = (s: string) => {
  marks.push({ stage: s, at: Date.now() });
  console.log(`  [${new Date().toISOString()}] ${s}`);
};

async function main() {
  const provider = new JsonRpcProvider(COSTON2.rpc);
  const evm = new EvmWallet(need("PRIVATE_KEY"), provider);
  const deployment = JSON.parse(readFileSync(resolve(REPO, "fixtures/deployment.json"), "utf8"));
  const owner = XrplWallet.fromSeed(need("XRPL_SEED"));
  const amountDrops = BigInt(arg("drops") ?? "5000000");

  const plan = await prepareImport({
    xrplOwner: owner.address,
    memokitController: deployment.diamond,
    provider,
    amountDrops,
  });

  const fxrp = new Contract(
    need("FXRP") ?? "0x0b6A3645c240605887a5532109323A3E12273dc7",
    ERC20,
    provider,
  );
  const decimals = Number(await fxrp.decimals());

  console.log(`XRPL owner        ${owner.address}`);
  console.log(`FSA account       ${plan.accounts.fsa}`);
  console.log(`memokit account   ${plan.accounts.memokit}`);
  console.log(`FSA provider      ${plan.receivingAddress}`);
  console.log(`reference         ${plan.reference}`);
  console.log(`  decodes to      ${JSON.stringify(decodeImportReference(plan.reference), (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  console.log(`min carrier drops ${plan.minCarrierDrops}`);

  const before = {
    fsa: (await fxrp.balanceOf(plan.accounts.fsa)) as bigint,
    memokit: (await fxrp.balanceOf(plan.accounts.memokit)) as bigint,
    totalSupply: (await fxrp.totalSupply?.()) ?? 0n,
  };
  console.log(
    `\nbefore: FSA ${formatUnits(before.fsa, decimals)}, memokit ${formatUnits(before.memokit, decimals)}`,
  );
  if (before.fsa < amountDrops) {
    throw new Error(
      `the FSA account holds ${formatUnits(before.fsa, decimals)} but the import moves ${formatUnits(amountDrops, decimals)}`,
    );
  }

  // The carrier must deliver at least the protocol's instruction fee, read from FSA.
  const carrierDrops = plan.minCarrierDrops > 1_000_000n ? plan.minCarrierDrops : 1_000_000n;

  mark("xrpl:submit");
  const sent = await sendMemoPayment({
    network: COSTON2,
    wallet: owner,
    destination: plan.receivingAddress,
    drops: carrierDrops.toString(),
    memo: plan.reference,
  });
  mark("xrpl:validated");
  console.log(`  XRPL ${sent.hash} in ledger ${sent.ledgerIndex}`);

  const transactionId = "0x" + sent.hash.toLowerCase();

  // FSA's rail takes the classic `Payment` attestation, not `XRPPayment`, so this uses the
  // verifier to encode the request. memokit's own path needs no verifier; this is Flare's.
  let abiEncodedRequest: string | undefined;
  for (let i = 1; i <= 30 && !abiEncodedRequest; i++) {
    const res = await fetch(`${VERIFIER.testnet}/verifier/xrp/Payment/prepareRequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": VERIFIER.publicApiKey },
      body: JSON.stringify({
        attestationType: "0x5061796d656e7400000000000000000000000000000000000000000000000000",
        sourceId: "0x7465737458525000000000000000000000000000000000000000000000000000",
        requestBody: { transactionId, inUtxo: "0", utxo: "0" },
      }),
    });
    const body = (await res.json()) as { status: string; abiEncodedRequest?: string };
    if (body.status === "VALID" && body.abiEncodedRequest) abiEncodedRequest = body.abiEncodedRequest;
    else await new Promise((r) => setTimeout(r, 4_000));
  }
  if (!abiEncodedRequest) throw new Error("verifier never indexed the import payment");

  const registry = new Contract(
    COSTON2.contractRegistry,
    ["function getContractAddressByName(string) view returns (address)"],
    provider,
  );
  const [hubAddress, feeConfigAddress, relayAddress] = await Promise.all([
    registry.getContractAddressByName("FdcHub"),
    registry.getContractAddressByName("FdcRequestFeeConfigurations"),
    registry.getContractAddressByName("Relay"),
  ]);
  const fee: bigint = await new Contract(
    feeConfigAddress,
    ["function getRequestFee(bytes) view returns (uint256)"],
    provider,
  ).getRequestFee(abiEncodedRequest);

  const hub = new Contract(hubAddress, ["function requestAttestation(bytes) payable"], evm);
  const reqReceipt = await (await hub.requestAttestation(abiEncodedRequest, { value: fee })).wait();
  mark("fdc:request-submitted");
  console.log(`  requestAttestation ${reqReceipt.hash}`);

  const votingRoundId = await new RoundClock(provider, relayAddress, COSTON2.daLayerUrl)
    .roundIdOfBlock(reqReceipt.blockNumber);
  console.log(`  voting round ${votingRoundId}, waiting for the proof...`);

  const da = new DaLayerClient(COSTON2.daLayerUrl);
  const proofResponse = await da.waitForProof(
    votingRoundId,
    abiEncodedRequest,
    Date.now() + 15 * 60_000,
    10_000,
  );
  mark("fdc:proof-available");

  // `executeInstruction` has no access control, so we can relay it ourselves -- but Flare's
  // own operator watches the provider wallet and relays for ANY sender, so it usually gets
  // there first. Losing that race is a success, not a failure: the instruction executed.
  const [decoded] = coder.decode([PAYMENT_RESPONSE_ABI], proofResponse.response_hex);
  const fsa = new Contract(FSA_CONTROLLER, FSA_EXECUTE_ABI, evm);

  let execHash: string;
  let execBlock: number;
  let relayedByUs: boolean;
  try {
    const receipt = await (
      await fsa.executeInstruction([Array.from(proofResponse.proof), plain(decoded)], owner.address)
    ).wait();
    execHash = receipt.hash;
    execBlock = receipt.blockNumber;
    relayedByUs = true;
    console.log(`  FSA executeInstruction ${execHash} in block ${execBlock} (relayed by us)`);
  } catch (e) {
    // 0xdb5e659b == TransactionAlreadyExecuted()
    if (!JSON.stringify(e).includes("0xdb5e659b")) throw e;
    relayedByUs = false;
    const found = await findFsaExecution(provider, plan.accounts.fsa, plan.accounts.memokit, amountDrops);
    execHash = found.hash;
    execBlock = found.blockNumber;
    console.log(`  Flare's operator relayed it first: ${execHash} in block ${execBlock}`);
  }
  mark("fsa:executed");

  const after = {
    fsa: (await fxrp.balanceOf(plan.accounts.fsa)) as bigint,
    memokit: (await fxrp.balanceOf(plan.accounts.memokit)) as bigint,
  };
  console.log(
    `\nafter:  FSA ${formatUnits(after.fsa, decimals)}, memokit ${formatUnits(after.memokit, decimals)}`,
  );
  console.log(
    `moved:  ${formatUnits(before.fsa - after.fsa, decimals)} out of FSA, ` +
      `${formatUnits(after.memokit - before.memokit, decimals)} into memokit`,
  );

  const legs: Record<string, number> = {};
  for (let i = 1; i < marks.length; i++) {
    legs[`${marks[i - 1].stage} -> ${marks[i].stage}`] = Math.round((marks[i].at - marks[i - 1].at) / 1000);
  }
  legs.total = Math.round((marks[marks.length - 1].at - marks[0].at) / 1000);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        note: "Import from Flare Smart Accounts into memokit, via FSA payment-reference instruction 0x01. Live on Coston2 + XRPL Testnet.",
        capturedAt: new Date().toISOString(),
        xrplOwner: owner.address,
        fsaController: FSA_CONTROLLER,
        fsaAccount: plan.accounts.fsa,
        memokitController: deployment.diamond,
        memokitAccount: plan.accounts.memokit,
        fsaReceivingAddress: plan.receivingAddress,
        paymentReference: plan.reference,
        referenceDecoded: decodeImportReference(plan.reference),
        carrierDrops: carrierDrops.toString(),
        instructionFeeDrops: plan.minCarrierDrops.toString(),
        xrplTransactionHash: sent.hash,
        xrplLedgerIndex: sent.ledgerIndex,
        requestAttestationTx: reqReceipt.hash,
        votingRoundId,
        fsaExecuteTx: execHash,
        fsaExecuteBlock: execBlock,
        relayedBy: relayedByUs ? evm.address : "flare-operator",
        relayedByFlareOperator: !relayedByUs,
        balances: {
          fsaBefore: before.fsa.toString(),
          fsaAfter: after.fsa.toString(),
          memokitBefore: before.memokit.toString(),
          memokitAfter: after.memokit.toString(),
          decimals,
        },
        latencySeconds: legs,
        explorer: {
          fsaExecute: `${COSTON2.explorer}/tx/${execHash}`,
          xrpl: `https://testnet.xrpl.org/transactions/${sent.hash}`,
        },
      },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${OUT}`);
  console.log(`latency: ${JSON.stringify(legs)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Find the transfer Flare's operator produced, when it beat us to the relay.
 *
 * Matched on the transfer itself -- FSA account to memokit account, exact amount -- rather
 * than on an event signature, because what matters for the trace is that the funds moved,
 * not which of the two relayers moved them.
 */
async function findFsaExecution(
  provider: JsonRpcProvider,
  from: string,
  to: string,
  amount: bigint,
): Promise<{ hash: string; blockNumber: number }> {
  const res = await fetch(
    `${COSTON2.explorer}/api/v2/addresses/${to}/token-transfers`,
  );
  const body = (await res.json()) as { items?: Array<Record<string, any>> };
  const hit = (body.items ?? []).find(
    (t) =>
      (t.from?.hash ?? "").toLowerCase() === from.toLowerCase() &&
      BigInt(t.total?.value ?? 0) === amount,
  );
  if (!hit) throw new Error("the instruction was consumed but no matching transfer was found");
  return { hash: hit.transaction_hash, blockNumber: Number(hit.block_number ?? 0) };
}
