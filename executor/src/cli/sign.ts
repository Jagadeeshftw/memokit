/**
 * `memokit sign` -- turn an instruction into something a human can approve on a phone.
 *
 *   npm run sign -w @memokit/executor -- --to 0x... --amount 1000000 [--fee 100000] [--xaman]
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
import { Contract, JsonRpcProvider, getAddress, Interface } from "ethers";
import {
  COSTON2,
  CONTROLLER_ABI,
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
} from "@memokit/sdk";
import { XamanClient, xamanCredentials, isXamanConfigured } from "../xaman.js";

const REPO = resolve(import.meta.dirname, "../../..");
const ERC20 = new Interface(["function transfer(address,uint256) returns (bool)"]);

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

  // One transfer, because this CLI exists to demonstrate the signing path rather than to be a
  // general instruction builder -- that is what the SDK is for.
  const token = getAddress(arg("token") ?? need("MEMOKIT_FXRP"));
  const to = getAddress(arg("to") ?? need("SIGN_RECIPIENT"));
  const amount = BigInt(arg("amount") ?? "1000000");
  const feeAmount = BigInt(arg("fee") ?? "0");

  const calls: Call[] = [
    { target: token, value: 0n, data: ERC20.encodeFunctionData("transfer", [to, amount]) },
  ];
  const instruction: Instruction = {
    sender: account,
    nonce,
    feeToken: feeAmount > 0n ? token : "0x0000000000000000000000000000000000000000",
    feeAmount,
    calls,
  };

  // Inline (0xFD) or commit (0xFC), and for a QR the difference matters more than anywhere
  // else. A commit memo is 42 bytes whatever the instruction, but `execute` needs the preimage,
  // and the preimage is keyed by a transaction id that does not exist until after signing --
  // so somebody has to hand it to an executor out of band. An inline memo carries the whole
  // instruction, so a scanned payment is self-contained: any executor watching can run it with
  // nothing but the ledger. That is the right default for a QR, and the wrong one for a large
  // instruction, which is why it is a flag and not a decision made here.
  const inline = flag("inline");
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
  console.log(`instruction       transfer ${amount} of ${token} to ${to}`);
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

  const uri = toDataUri(unsigned);
  console.log(`\n${await QRCode.toString(uri, { type: "terminal", small: true })}`);
  const png = resolve(outDir, `${stem}.png`);
  await QRCode.toFile(png, uri, { width: 512, margin: 2 });
  console.log(`QR      ${png}`);
  console.log(`payload ${resolve(outDir, `${stem}.json`)}  (keep it: execute needs the preimage)`);

  if (!flag("xaman")) {
    console.log(`\nPass --xaman to push this to a phone. ${isXamanConfigured() ? "Credentials are present." : "Credentials are NOT set; see .env.example."}`);
    return;
  }

  // Throws with the exact missing variable names rather than half-working.
  const client = new XamanClient(xamanCredentials());
  const created = await client.create(unsigned as unknown as Record<string, unknown>, {
    expireMinutes: Number(arg("expire") ?? 10),
    instruction: `memokit: transfer ${amount} to ${to}`,
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
