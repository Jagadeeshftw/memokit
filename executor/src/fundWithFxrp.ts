/**
 * Funds a memokit personal account with real FTestXRP, out of band.
 *
 * This is the setup step for the live-vault trace, and it is deliberately *not* part of the
 * protocol. memokit's whole claim is that an instruction acts on a balance that already
 * exists; something has to put that balance there first, and on Coston2 the only way to get
 * FTestXRP is to mint it through FAssets.
 *
 * Direct minting cannot be used here: Coston2 routes direct-mint targets by XRPL
 * DestinationTag (observed on live transactions), and tags are registered by Flare, not by
 * arbitrary callers. So this runs the classic path instead:
 *
 *   reserveCollateral -> XRPL payment to the agent -> Payment attestation -> executeMinting
 *   -> transfer the minted FTestXRP to the personal account
 *
 * The minted FXRP lands on the relayer EOA (the minter) and is then transferred in, which
 * keeps the funding visibly separate from anything memokit does.
 *
 * Note on the verifier: this script *does* use it, to encode the classic `Payment` request.
 * That is fine precisely because this is not the protocol path. memokit's own path
 * (`fdc/buildResponse.ts`) needs no verifier; replicating that for a second attestation type
 * would be work with no bearing on the thing being proven.
 *
 * Run: npm run fund -w @memokit/executor
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet as EvmWallet, AbiCoder, formatUnits } from "ethers";
import { Wallet as XrplWallet } from "xrpl";
import { toTransactionId } from "@memokit/sdk";
import { XrplSender } from "@memokit/sdk/xrpl";
import { DaLayerClient, RoundClock, b32 } from "@memokit/sdk/fdc";
import { COSTON2, NETWORK, SOURCE_ID_TESTNET, VERIFIER } from "./config.js";

const REPO = resolve(import.meta.dirname, "../..");
const coder = AbiCoder.defaultAbiCoder();

/** The classic `Payment` attestation type. Different shape from `XRPPayment`. */
const PAYMENT_RESPONSE_ABI =
  "tuple(bytes32 attestationType, bytes32 sourceId, uint64 votingRound, uint64 lowestUsedTimestamp," +
  "tuple(bytes32 transactionId, uint256 inUtxo, uint256 utxo) requestBody," +
  "tuple(uint64 blockNumber, uint64 blockTimestamp, bytes32 sourceAddressHash," +
  "bytes32 sourceAddressesRoot, bytes32 receivingAddressHash, bytes32 intendedReceivingAddressHash," +
  "int256 spentAmount, int256 intendedSpentAmount, int256 receivedAmount, int256 intendedReceivedAmount," +
  "bytes32 standardPaymentReference, bool oneToOne, uint8 status) responseBody)";

const ASSET_MANAGER = [
  "function reserveCollateral(address,uint256,uint256,address) payable returns (uint256)",
  "function collateralReservationFee(uint256) view returns (uint256)",
  "function getAvailableAgentsList(uint256,uint256) view returns (address[],uint256)",
  "function executeMinting((bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,uint256,uint256),(uint64,uint64,bytes32,bytes32,bytes32,bytes32,int256,int256,int256,int256,bytes32,bool,uint8))) _payment, uint256 _collateralReservationId)",
  "function fAsset() view returns (address)",
  "event CollateralReserved(address indexed agentVault, address indexed minter, uint256 indexed collateralReservationId, uint256 valueUBA, uint256 feeUBA, uint256 firstUnderlyingBlock, uint256 lastUnderlyingBlock, uint256 lastUnderlyingTimestamp, string paymentAddress, bytes32 paymentReference, address executor, uint256 executorFeeNatWei)",
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

/**
 * ethers returns decoded tuples as a frozen `Result`. Passing one straight back into a
 * contract call fails with "Cannot assign to read only property", because ethers tries to
 * resolve arguments in place. Deep-copy to plain arrays first.
 */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  return value;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

async function main() {
  const provider = new JsonRpcProvider(COSTON2.rpc);
  const evm = new EvmWallet(need("PRIVATE_KEY"), provider);
  const deployment = JSON.parse(readFileSync(resolve(REPO, "fixtures/deployment.json"), "utf8"));

  const am = new Contract(need("ASSET_MANAGER"), ASSET_MANAGER, evm);
  const fAssetAddress: string = await am.fAsset();
  const fAsset = new Contract(fAssetAddress, ERC20, evm);
  const decimals = Number(await fAsset.decimals());

  const xrpl = new XrplSender(NETWORK.xrpl.websocket);
  const xrplWallet = XrplWallet.fromSeed(need("XRPL_SEED"));
  const memokit = new Contract(
    deployment.diamond,
    ["function computeAccountAddress(string) view returns (address)"],
    provider,
  );
  // FUND_TARGET exists for the FSA-import trace, which needs FXRP in the *Flare Smart
  // Accounts* account for the same XRPL owner rather than the memokit one.
  const account: string =
    process.env.FUND_TARGET ?? (await memokit.computeAccountAddress(xrplWallet.address));
  console.log(`funding account ${account} with ${await fAsset.symbol()}`);

  // Resume path. A reservation has an on-chain deadline, so when a run fails after the
  // XRPL payment there is no time to start over -- pick up from the existing one instead.
  const resumeCrtId = process.env.RESUME_CRT_ID;
  const resumeTxId = process.env.RESUME_XRPL_TXID;
  if (resumeCrtId && resumeTxId) {
    console.log(`resuming reservation ${resumeCrtId} with XRPL tx ${resumeTxId}`);
    await completeMint(
      am, fAsset, provider, evm, BigInt(resumeCrtId), resumeTxId, account, decimals,
    );
    await xrpl.disconnect();
    return;
  }

  // --- 1. reserve collateral -----------------------------------------------------------
  const [agents] = await am.getAvailableAgentsList(0, 20);
  if (agents.length === 0) throw new Error("no available FAssets agents on Coston2");
  const agent = process.env.AGENT_VAULT ?? agents[0];
  const lots = BigInt(process.env.LOTS ?? "1");
  const crf: bigint = await am.collateralReservationFee(lots);
  console.log(`agent ${agent}, ${lots} lot(s), collateral reservation fee ${formatUnits(crf, 18)} C2FLR`);

  const reserveTx = await am.reserveCollateral(agent, lots, 10_000, "0x" + "00".repeat(20), {
    value: (crf * 110n) / 100n, // a little slack for an FTSO price move between quote and call
  });
  const reserveReceipt = await reserveTx.wait();
  console.log(`  reserveCollateral ${reserveReceipt.hash}`);

  const parsed = reserveReceipt.logs
    .map((l: { topics: string[]; data: string }) => {
      try {
        return am.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l: { name: string } | null) => l?.name === "CollateralReserved");
  if (!parsed) throw new Error("CollateralReserved not found in receipt");

  const crtId: bigint = parsed.args.collateralReservationId;
  const valueUBA: bigint = parsed.args.valueUBA;
  const feeUBA: bigint = parsed.args.feeUBA;
  const paymentAddress: string = parsed.args.paymentAddress;
  const paymentReference: string = parsed.args.paymentReference;
  const totalDrops = valueUBA + feeUBA;
  console.log(
    `  crtId ${crtId}, pay ${formatUnits(totalDrops, 6)} XRP to ${paymentAddress} ref ${paymentReference}`,
  );

  // --- 2. pay the agent on XRPL ---------------------------------------------------------
  // FAssets keys the mint by the 32-byte payment reference in a single memo, which is
  // exactly the shape the classic `Payment` attestation requires.
  const sent = await xrpl.sendMemoPayment(
    xrplWallet,
    paymentAddress,
    totalDrops.toString(),
    paymentReference,
  );
  console.log(`  XRPL ${sent.hash} in ledger ${sent.ledgerIndex}`);
  const transactionId = toTransactionId(sent.hash);

  await completeMint(am, fAsset, provider, evm, crtId, transactionId, account, decimals);

  await xrpl.disconnect();
}

/** Attest the minting payment, execute the mint, and move the FXRP into the account. */
async function completeMint(
  am: Contract,
  fAsset: Contract,
  provider: JsonRpcProvider,
  evm: EvmWallet,
  crtId: bigint,
  transactionId: string,
  account: string,
  decimals: number,
): Promise<void> {
  // --- attest the minting payment ----------------------------------------------------------------------
  let abiEncodedRequest: string | undefined;
  for (let attempt = 1; attempt <= 30 && !abiEncodedRequest; attempt++) {
    const res = await fetch(`${VERIFIER.testnet}/verifier/xrp/Payment/prepareRequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": VERIFIER.publicApiKey },
      body: JSON.stringify({
        attestationType: b32("Payment"),
        sourceId: b32(SOURCE_ID_TESTNET),
        requestBody: { transactionId, inUtxo: "0", utxo: "0" },
      }),
    });
    const body = (await res.json()) as { status: string; abiEncodedRequest?: string };
    if (body.status === "VALID" && body.abiEncodedRequest) {
      abiEncodedRequest = body.abiEncodedRequest;
      break;
    }
    console.log(`  attempt ${attempt}: ${body.status}`);
    await new Promise((r) => setTimeout(r, 4_000));
  }
  if (!abiEncodedRequest) throw new Error("verifier never indexed the minting payment");

  const registry = new Contract(
    COSTON2.contractRegistry,
    ["function getContractAddressByName(string) view returns (address)"],
    provider,
  );
  const hubAddress: string = await registry.getContractAddressByName("FdcHub");
  const feeConfig = new Contract(
    await registry.getContractAddressByName("FdcRequestFeeConfigurations"),
    ["function getRequestFee(bytes) view returns (uint256)"],
    provider,
  );
  const fee: bigint = await feeConfig.getRequestFee(abiEncodedRequest);
  const hub = new Contract(hubAddress, ["function requestAttestation(bytes) payable"], evm);
  const reqReceipt = await (await hub.requestAttestation(abiEncodedRequest, { value: fee })).wait();
  console.log(`  requestAttestation ${reqReceipt.hash}`);

  const votingRoundId = await new RoundClock(provider, COSTON2.relay, NETWORK.daLayerUrl).roundIdOfBlock(reqReceipt.blockNumber);
  console.log(`  voting round ${votingRoundId}, waiting for the proof...`);
  const da = new DaLayerClient(NETWORK.daLayerUrl);
  const proofResponse = await da.waitForProof(
    votingRoundId,
    abiEncodedRequest,
    Date.now() + 15 * 60_000,
    10_000,
  );

  // --- execute the mint ----------------------------------------------------------------
  const [d] = coder.decode([PAYMENT_RESPONSE_ABI], proofResponse.response_hex);
  const proofArg = [Array.from(proofResponse.proof), plain(d)];
  const mintReceipt = await (await am.executeMinting(proofArg, crtId)).wait();
  console.log(`  executeMinting ${mintReceipt.hash}`);

  // --- move it into the account ----------------------------------------------------------
  const minted: bigint = await fAsset.balanceOf(evm.address);
  console.log(`  minter holds ${formatUnits(minted, decimals)} ${await fAsset.symbol()}`);
  if (minted === 0n) throw new Error("nothing minted");

  const transferReceipt = await (await fAsset.transfer(account, minted)).wait();
  console.log(`  transfer ${transferReceipt.hash}`);
  console.log(
    `\naccount ${account} now holds ${formatUnits(await fAsset.balanceOf(account), decimals)}`,
  );
  console.log(`fAsset address: ${await fAsset.getAddress()}`);

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
