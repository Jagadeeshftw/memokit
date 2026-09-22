/**
 * The full loop: one XRPL Testnet payment instructs a memokit account to redeem its FXRP,
 * and XRP arrives back on XRPL. The user starts and ends on the XRP Ledger and never holds
 * an EVM key.
 *
 * The second half is not ours and not atomic. `redeem` creates an obligation; an FAssets
 * agent discharges it by sending XRP minutes later, or is defaulted and the redeemer is paid
 * in collateral on Flare instead. This script follows the redemption through to whichever
 * happens and records both XRPL hashes.
 *
 * Run: npm run cash-out -w @memokit/executor -- [--lots 1] [--to r... --i-know]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet as EvmWallet, formatUnits } from "ethers";
import { Wallet as XrplWallet, Client as XrplClient } from "xrpl";
import {
  COSTON2,
  planCashOut,
  buildCashOutCalls,
  parseRedemptionRequests,
  waitForRedemption,
  REDEMPTION_DEFAULT_NOTE,
  prepareInstruction,
  requestAttestation,
  waitForProof,
  submit,
  CONTROLLER_ABI,
  erc20BalanceAtLeast,
} from "@memokit/sdk";
import { sendMemoPayment } from "@memokit/sdk/xrpl";

const REPO = resolve(import.meta.dirname, "../..");
const OUT = resolve(REPO, "fixtures/measurements/cash-out-trace.json");
const ASSET_MANAGER = process.env.ASSET_MANAGER ?? "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA";

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
  const relayer = new EvmWallet(need("PRIVATE_KEY"), provider);
  const deployment = JSON.parse(readFileSync(resolve(REPO, "fixtures/deployment.json"), "utf8"));
  const owner = XrplWallet.fromSeed(need("XRPL_SEED"));

  const memokit = new Contract(deployment.diamond, CONTROLLER_ABI, relayer);
  const account: string = await memokit.computeAccountAddress(owner.address);

  // Sending elsewhere needs both flags, so it cannot happen by accident.
  const redirectTo = arg("to");
  const redirect =
    redirectTo && process.argv.includes("--i-know")
      ? { xrplDestination: redirectTo, iAcknowledgeThisSendsToSomeoneElse: true as const }
      : undefined;
  if (redirectTo && !redirect) {
    throw new Error("--to also requires --i-know: the redeemed XRP goes there irreversibly");
  }

  const plan = await planCashOut({
    assetManager: ASSET_MANAGER,
    account,
    provider,
    xrplOwner: owner.address,
    maxLots: arg("lots") ? BigInt(arg("lots")!) : undefined,
    redirect,
  });

  console.log(`memokit account  ${account}`);
  console.log(`FXRP balance     ${formatUnits(plan.balance, 6)}`);
  console.log(`lot size         ${formatUnits(plan.lotSize, 6)}`);
  console.log(`redeeming        ${plan.lots} lot(s) = ${formatUnits(plan.redeemableAmount, 6)}`);
  console.log(`dust left behind ${formatUnits(plan.dust, 6)}  (below one lot, not redeemable)`);
  console.log(`XRP goes to      ${plan.xrplDestination}${plan.redirected ? "  [REDIRECTED]" : "  (the payer's own address)"}`);

  const xrpl = new XrplClient(COSTON2.xrpl.websocket);
  await xrpl.connect();
  const xrpBefore = await xrpBalance(xrpl, plan.xrplDestination);
  console.log(`\nXRPL balance before: ${xrpBefore / 1e6} XRP`);

  // --- the instruction -------------------------------------------------------------------
  const nonce: bigint = await memokit.nonceOf(account);
  const { payload, memo } = prepareInstruction({
    sender: account,
    nonce,
    feeToken: "0x0000000000000000000000000000000000000000",
    feeAmount: 0n,
    calls: buildCashOutCalls(ASSET_MANAGER, plan),
    // A floor, not a ceiling: all we can assert is that the dust is still there afterwards,
    // which at least catches an instruction that emptied the account unexpectedly. See
    // CASH_OUT_POST_CONDITION_NOTE for why the real claim is not expressible.
    postConditions: plan.dust > 0n ? [erc20BalanceAtLeast(plan.fAsset, account, plan.dust)] : [],
  });
  console.log(`instruction nonce ${nonce}, memo ${(memo.length - 2) / 2} bytes`);

  mark("xrpl:submit");
  const sent = await sendMemoPayment({
    network: COSTON2,
    wallet: owner,
    destination: deployment.receivingAddress,
    drops: "1000000",
    memo,
  });
  mark("xrpl:validated");
  console.log(`  XRPL in  ${sent.hash}`);

  const request = await requestAttestation({ signer: relayer, xrplHash: sent.hash, network: COSTON2 });
  mark("fdc:request-submitted");
  const { proof } = await waitForProof({ request, network: COSTON2 });
  mark("fdc:proof-available");

  const receipt = await submit({ signer: relayer, controller: deployment.diamond, proof, payload });
  mark("memokit:executed");
  console.log(`  execute  ${receipt.hash} in block ${receipt.blockNumber}`);

  // --- the half that is not ours -----------------------------------------------------------
  const { requests, remainingLots } = parseRedemptionRequests(ASSET_MANAGER, receipt.logs);
  if (remainingLots !== null) {
    console.log(`  WARNING: RedemptionRequestIncomplete, ${remainingLots} lot(s) not redeemed`);
  }
  if (requests.length === 0) throw new Error("no RedemptionRequested in the execute receipt");

  const req = requests[0];
  console.log(`\nredemption request ${req.requestId}`);
  console.log(`  agent          ${req.agentVault}`);
  console.log(`  pays           ${formatUnits(req.valueUBA - req.feeUBA, 6)} XRP to ${req.paymentAddress}`);
  console.log(`  redemption fee ${formatUnits(req.feeUBA, 6)}`);
  console.log(`  agent is late after XRPL ledger ${req.lastUnderlyingBlock} / ts ${req.lastUnderlyingTimestamp}`);

  const outcome = await waitForRedemption({
    assetManager: ASSET_MANAGER,
    provider,
    request: req,
    deadlineMs: Date.now() + 20 * 60_000,
    intervalMs: 15_000,
    onPoll: (o) => {
      if (o.status === "pending") process.stdout.write(".");
    },
  });
  console.log("");
  mark(`redemption:${outcome.status}`);

  let xrplPayoutHash: string | null = null;
  if (outcome.status === "performed") {
    xrplPayoutHash = outcome.xrplTransactionHash;
    console.log(`  agent paid on XRPL: ${xrplPayoutHash}`);
  } else {
    console.log(`  outcome: ${outcome.status}`);
    console.log(`  default path: ${JSON.stringify(REDEMPTION_DEFAULT_NOTE)}`);
  }

  const xrpAfter = await xrpBalance(xrpl, plan.xrplDestination);
  console.log(`\nXRPL balance after: ${xrpAfter / 1e6} XRP  (+${(xrpAfter - xrpBefore) / 1e6})`);
  await xrpl.disconnect();

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
        note: "Full loop: XRPL Testnet payment -> memokit redeem -> XRP back on XRPL Testnet.",
        capturedAt: new Date().toISOString(),
        xrplOwner: owner.address,
        memokitController: deployment.diamond,
        account,
        assetManager: ASSET_MANAGER,
        plan: {
          balanceBefore: plan.balance.toString(),
          lotSize: plan.lotSize.toString(),
          lots: plan.lots.toString(),
          redeemableAmount: plan.redeemableAmount.toString(),
          dustLeftBehind: plan.dust.toString(),
          xrplDestination: plan.xrplDestination,
          redirected: plan.redirected,
        },
        xrplPaymentIn: sent.hash,
        executeTx: receipt.hash,
        executeBlock: receipt.blockNumber,
        redemption: {
          requestId: req.requestId.toString(),
          agentVault: req.agentVault,
          paymentAddress: req.paymentAddress,
          valueUBA: req.valueUBA.toString(),
          feeUBA: req.feeUBA.toString(),
          lastUnderlyingBlock: req.lastUnderlyingBlock.toString(),
          lastUnderlyingTimestamp: req.lastUnderlyingTimestamp.toString(),
          paymentReference: req.paymentReference,
          remainingLotsWarning: remainingLots?.toString() ?? null,
          outcome: outcome.status,
        },
        xrplPayoutHash,
        xrplBalanceBeforeDrops: xrpBefore.toString(),
        xrplBalanceAfterDrops: xrpAfter.toString(),
        defaultPath: REDEMPTION_DEFAULT_NOTE,
        latencySeconds: legs,
        explorer: {
          execute: `${COSTON2.explorer}/tx/${receipt.hash}`,
          xrplIn: `https://testnet.xrpl.org/transactions/${sent.hash}`,
          xrplOut: xrplPayoutHash ? `https://testnet.xrpl.org/transactions/${xrplPayoutHash}` : null,
        },
      },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${OUT}`);
  console.log(`latency: ${JSON.stringify(legs)}`);
}

async function xrpBalance(client: XrplClient, address: string): Promise<number> {
  try {
    const r = (await client.request({ command: "account_info", account: address } as never)) as {
      result: { account_data: { Balance: string } };
    };
    return Number(r.result.account_data.Balance);
  } catch {
    return 0;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
