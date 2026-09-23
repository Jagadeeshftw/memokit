/**
 * `memokit sign` -- turn an instruction into something a human can approve on a phone.
 *
 *   npm run sign -w @memokit/executor -- --owner r... --to 0x... --amount 1000000 [--fee 100000] [--inline] [--xaman]
 *   npm run sign -w @memokit/executor -- --owner r... --cash-out [--lots 1] [--fee 100000] [--xaman]
 *
 * Two instructions: a token transfer, or a cash-out that redeems FXRP back to XRP on the
 * payer's own XRPL address.
 *
 * Prints the unsigned XRPL Payment, renders it as a QR in the terminal and as a PNG, and --
 * with `--xaman` and credentials -- pushes it to Xaman and waits for the signature.
 *
 * Signs nothing itself and reads no seed. That is the point: every other script here holds a
 * key, and holding a key is exactly what a memokit user is not supposed to have to do.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import QRCode from "qrcode";
import { Contract, JsonRpcProvider, getAddress, Interface, formatUnits } from "ethers";
import {
  COSTON2,
  CONTROLLER_ABI,
  planCashOut,
  buildCashOutCalls,
  lotsLeavingFee,
  erc20BalanceAtLeast,
  Opcode,
  encodeMemo,
  encodeInstruction,
  commitmentOf,
  prepareInstruction,
  buildUnsignedPayment,
  toDataUri,
  AUTOFILLED_BY_THE_WALLET,
  CARRIER_DROPS,
  type Call,
  type Instruction,
  type PostCondition,
} from "@memokit/sdk";
import { XamanClient, xamanCredentials, isXamanConfigured } from "../xaman.js";

const REPO = resolve(import.meta.dirname, "../../..");
const ERC20 = new Interface(["function transfer(address,uint256) returns (bool)"]);

/** Coston2's FAssets AssetManager for FXRP -- the contract a cash-out calls `redeem` on. */
const COSTON2_ASSET_MANAGER = "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA";

/**
 * The deployed executor declines any fee below its MIN_FEE, which is 0.1 FTestXRP. A cash-out
 * built for it defaults to exactly that, so a QR scanned on camera is one it will pick up.
 */
const DEFAULT_CASH_OUT_FEE = 100_000n;

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (n: string): boolean => process.argv.includes(`--${n}`);
const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`missing env ${n}`);
  return v;
};

async function main(): Promise<void> {
  const owner = arg("owner") ?? need("XRPL_OWNER_ADDRESS");
  const provider = new JsonRpcProvider(process.env.COSTON2_RPC ?? COSTON2.rpc);
  const deployment = JSON.parse(
    readFileSync(resolve(REPO, process.env.DEPLOYMENT_FILE ?? "fixtures/deployment.json"), "utf8"),
  ) as { diamond: string; receivingAddress: string };

  const controller = new Contract(deployment.diamond, CONTROLLER_ABI, provider);
  const account: string = await controller.computeAccountAddress(owner);
  const nonce: bigint = await controller.nonceOf(account);

  const cashOut = flag("cash-out");
  let token: string;
  let feeAmount: bigint;
  let calls: Call[];
  let postConditions: PostCondition[] = [];
  let describe: string;

  if (cashOut) {
    // Redeem whole lots of FXRP back to XRP on the payer's own XRPL address. The destination is
    // not a flag here on purpose: sending the XRP anywhere else is irreversible, and the SDK's
    // override for it needs an explicit acknowledgement this CLI does not offer.
    const assetManager = getAddress(arg("asset-manager") ?? process.env.ASSET_MANAGER ?? COSTON2_ASSET_MANAGER);
    feeAmount = BigInt(arg("fee") ?? DEFAULT_CASH_OUT_FEE);
    const probe = await planCashOut({ assetManager, account, provider, xrplOwner: owner });
    token = probe.fAsset;

    // The executor fee is paid AFTER the calls, out of what the redemption leaves behind. So the
    // lots redeemed must leave at least the fee, or the whole instruction reverts on chain.
    const affordable = lotsLeavingFee(probe.balance, probe.lotSize, feeAmount);
    const lots = arg("lots") ? BigInt(arg("lots")!) : affordable;
    if (lots === 0n || lots > affordable) {
      throw new Error(
        `cannot cash out ${lots === 0n ? "anything" : `${lots} lot(s)`}: the account holds ` +
          `${formatUnits(probe.balance, 6)} FXRP, one lot is ${formatUnits(probe.lotSize, 6)}, and ` +
          `${formatUnits(feeAmount, 6)} must be left over for the executor fee. ` +
          `Fund it (mints one lot): ASSET_MANAGER=${assetManager} npm run fund -w @memokit/executor`,
      );
    }
    const plan = await planCashOut({ assetManager, account, provider, xrplOwner: owner, maxLots: lots });
    calls = buildCashOutCalls(assetManager, plan);
    // A floor, not a ceiling -- see CASH_OUT_POST_CONDITION_NOTE. Checked before the fee is paid,
    // so the balance it sees is exactly the dust.
    postConditions = [erc20BalanceAtLeast(plan.fAsset, account, plan.dust)];
    describe =
      `cash out ${plan.lots} lot(s) = ${formatUnits(plan.redeemableAmount, 6)} FXRP, ` +
      `XRP to ${plan.xrplDestination} (the payer's own address); ` +
      `${formatUnits(plan.dust, 6)} FXRP stays, of which ${formatUnits(feeAmount, 6)} pays the executor`;
  } else {
    // One transfer, because this CLI exists to demonstrate the signing path rather than to be a
    // general instruction builder -- that is what the SDK is for.
    token = getAddress(arg("token") ?? need("MEMOKIT_FXRP"));
    const to = getAddress(arg("to") ?? need("SIGN_RECIPIENT"));
    const amount = BigInt(arg("amount") ?? "1000000");
    feeAmount = BigInt(arg("fee") ?? "0");
    calls = [{ target: token, value: 0n, data: ERC20.encodeFunctionData("transfer", [to, amount]) }];
    describe = `transfer ${amount} of ${token} to ${to}`;
  }

  const instruction: Instruction = {
    sender: account,
    nonce,
    feeToken: feeAmount > 0n ? token : "0x0000000000000000000000000000000000000000",
    feeAmount,
    calls,
    ...(postConditions.length > 0 ? { postConditions } : {}),
  };

  // Inline (0xFD) or commit (0xFC), and for a QR the difference matters more than anywhere
  // else. A commit memo is 42 bytes whatever the instruction, but `execute` needs the preimage,
  // and the preimage is keyed by a transaction id that does not exist until after signing --
  // so somebody has to hand it to an executor out of band. An inline memo carries the whole
  // instruction, so a scanned payment is self-contained: any executor watching can run it with
  // nothing but the ledger. That is the right default for a QR, and the wrong one for a large
  // instruction, which is why it is a flag and not a decision made here.
  // A cash-out is always inline: the point of building one here is for the open executor to run
  // it, and an executor cannot run a commit memo without being handed the preimage.
  const inline = flag("inline") || cashOut;
  const payload = encodeInstruction(instruction);
  const commitment = commitmentOf(instruction);
  const memo = inline
    ? encodeMemo({ kind: "execInline", opcode: Opcode.ExecInline, walletId: 1, executorFee: 0n, instruction })
    : prepareInstruction(instruction).memo;

  const unsigned = buildUnsignedPayment({
    owner,
    destination: deployment.receivingAddress,
    drops: arg("drops") ?? CARRIER_DROPS,
    memo,
  });

  console.log(`memokit account   ${account}`);
  console.log(`nonce             ${nonce}`);
  console.log(`instruction       ${describe}`);
  console.log(`executor fee      ${feeAmount}${feeAmount > 0n ? ` of ${token}` : "  (nobody is paid; you submit it yourself)"}`);
  console.log(`commitment        ${commitment}`);
  console.log(`memo              ${inline ? "0xFD inline" : "0xFC commit"}, ${(memo.length - 2) / 2} bytes${inline ? "  (self-contained: any executor can run it)" : "  (an executor also needs the preimage below)"}`);
  console.log(`\nUnsigned XRPL Payment:\n${JSON.stringify(unsigned, null, 2)}`);
  console.log(`\nYour wallet fills in:`);
  for (const field of AUTOFILLED_BY_THE_WALLET) console.log(`  - ${field}`);

  // The preimage. A 0xFC memo commits to it and `execute` needs it, so losing it strands the
  // instruction -- it is written out next to the QR rather than only printed.
  const outDir = resolve(REPO, arg("out") ?? "fixtures/measurements/signing");
  mkdirSync(outDir, { recursive: true });
  const stem = `${commitment.slice(2, 10)}`;
  writeFileSync(
    resolve(outDir, `${stem}.json`),
    JSON.stringify({ account, nonce: nonce.toString(), commitment, payload, memo, unsigned }, null, 2) + "\n",
  );

  // The whole transaction as a QR. Best effort, never fatal: an inline cash-out memo is 875
  // bytes, and the transaction around it does not fit in a QR code at any error-correction
  // level. That used to throw here -- after the payload was saved, but before `--xaman` ran, so
  // the one path that produces a scannable QR for a large instruction never got the chance.
  // Xaman's QR is a short link to a payload held server-side, so it has no such limit.
  const uri = toDataUri(unsigned);
  const payloadPath = resolve(outDir, `${stem}.json`);
  try {
    const terminalQr = await QRCode.toString(uri, { type: "terminal", small: true, errorCorrectionLevel: "L" });
    // A QR wider than the terminal wraps into noise. Say so rather than print it.
    const width = Math.max(...terminalQr.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length));
    const columns = process.stdout.columns ?? 100;
    if (width <= columns) console.log(`\n${terminalQr}`);
    else console.log(`\n(QR is ${width} columns wide, wider than this ${columns}-column terminal: open the PNG below instead)`);
    const png = resolve(outDir, `${stem}.png`);
    await QRCode.toFile(png, uri, { width: 768, margin: 2, errorCorrectionLevel: "L" });
    console.log(`QR      ${png}`);
  } catch {
    console.log(
      `\nNo local QR: this transaction is ${uri.length} characters as a QR payload, more than a QR code ` +
        `holds. Use --xaman, whose QR is a short link, or sign the saved payload with ` +
        `\`npm run sign-with-seed -w @memokit/executor -- <payload path below>\`.`,
    );
  }
  console.log(`payload ${payloadPath}  (keep it: execute needs the preimage)`);

  if (!flag("xaman")) {
    console.log(`\nPass --xaman to push this to a phone. ${isXamanConfigured() ? "Credentials are present." : "Credentials are NOT set; see .env.example."}`);
    return;
  }

  // Throws with the exact missing variable names rather than half-working.
  const client = new XamanClient(xamanCredentials());
  const created = await client.create(unsigned as unknown as Record<string, unknown>, {
    expireMinutes: Number(arg("expire") ?? 10),
    instruction: `memokit: ${describe}`,
  });
  console.log(`\nXaman payload ${created.uuid}`);
  console.log(`  open on the phone: ${created.deepLink}`);
  console.log(`\n${await QRCode.toString(created.deepLink, { type: "terminal", small: true })}`);
  console.log("waiting for a signature...");

  const resolution = await client.wait(created.uuid, { deadlineMs: Date.now() + 10 * 60_000 });
  if (!resolution.signed) {
    console.log(`not signed: ${resolution.cancelled ? "cancelled" : resolution.expired ? "expired" : "timed out"}`);
    process.exit(1);
  }
  if (resolution.account && resolution.account !== owner) {
    // Xaman signs with whichever account the user picked, and a memokit account is derived
    // from the signer. A different signer is a different account, and the instruction commits
    // to the one we computed, so it would fail on chain with SenderMismatch.
    console.log(`WARNING: signed by ${resolution.account}, not ${owner}. This instruction is for ${owner}'s account and will not execute.`);
  }
  console.log(`signed: XRPL ${resolution.txid}`);
  console.log(`the executor service will pick it up; follow it with:`);
  console.log(`  curl $STATUS_API/status/${resolution.txid}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
