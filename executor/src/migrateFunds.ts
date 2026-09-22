/**
 * Move an account's FTestXRP from a retired memokit deployment into the current one.
 *
 * Every payload-format change forces a redeploy, and a redeploy changes the diamond address,
 * which is inside each account's CREATE2 init code -- so the same XRPL owner derives a new
 * account and the old one still holds the funds. Rather than mint again, this spends them
 * with a real instruction on the OLD diamond, in whatever payload format that diamond
 * understands.
 *
 * It doubles as a standing check that the SDK's attestation path is independent of the
 * payload format: `prepareInstruction` is the only format-specific piece, and this script
 * deliberately does not use it. Everything else -- memo, request, proof, submit -- is shared.
 *
 * Used twice so far:
 *   phase1 -> phase2   the executor-fee redesign (3-field payload -> 5-field)
 *   phase2 -> phase3   payload v2 (5-field -> version byte + 6 fields)
 *
 * Run: FROM_DEPLOYMENT=fixtures/deployment-phase2.json LEGACY_FORMAT=phase2 \
 *      MIGRATE_AMOUNT=19100000 npm run migrate -w @memokit/executor
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AbiCoder, Contract, Interface, JsonRpcProvider, Wallet as EvmWallet, keccak256 } from "ethers";
import { Wallet as XrplWallet } from "xrpl";
import { CONTROLLER_ABI, Opcode, encodeMemo, requestAttestation, submit, waitForProof } from "@memokit/sdk";
import { XrplSender } from "@memokit/sdk/xrpl";
import { NETWORK } from "./config.js";
import { REPO, need } from "./run.js";

const ERC20 = new Interface(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

async function main() {
  const provider = new JsonRpcProvider(NETWORK.rpc);
  const evm = new EvmWallet(need("PRIVATE_KEY"), provider);
  const owner = XrplWallet.fromSeed(need("XRPL_SEED"));
  const fromPath = process.env.FROM_DEPLOYMENT ?? "fixtures/deployment-phase2.json";
  const toPath = process.env.TO_DEPLOYMENT ?? "fixtures/deployment.json";
  const oldD = JSON.parse(readFileSync(resolve(REPO, fromPath), "utf8"));
  const newD = JSON.parse(readFileSync(resolve(REPO, toPath), "utf8"));
  const token: string = need("MEMOKIT_FXRP");
  const amount = BigInt(need("MIGRATE_AMOUNT"));

  if (oldD.diamond.toLowerCase() === newD.diamond.toLowerCase()) {
    throw new Error(`${fromPath} and ${toPath} are the same deployment; nothing to migrate`);
  }

  const oldC = new Contract(oldD.diamond, CONTROLLER_ABI, provider);
  const newC = new Contract(newD.diamond, CONTROLLER_ABI, provider);
  const from: string = await oldC.computeAccountAddress(owner.address);
  const to: string = await newC.computeAccountAddress(owner.address);
  const nonce: bigint = await oldC.nonceOf(from);
  const fx = new Contract(token, ERC20, provider);
  console.log(`old account ${from} (nonce ${nonce}) holds ${await fx.balanceOf(from)}`);
  console.log(`new account ${to} holds ${await fx.balanceOf(to)}`);

  const payload = legacyPayload(
    process.env.LEGACY_FORMAT ?? "phase2",
    from,
    nonce,
    [[token, 0n, ERC20.encodeFunctionData("transfer", [to, amount])]],
  );
  const memo = encodeMemo({ kind: "execCommit", opcode: Opcode.ExecCommit, walletId: 1, executorFee: 0n, commitment: keccak256(payload) });

  const xrpl = new XrplSender(NETWORK.xrpl.websocket);
  const sent = await xrpl.sendMemoPayment(owner, oldD.receivingAddress, "1000000", memo);
  await xrpl.disconnect();
  console.log(`XRPL ${sent.hash}`);

  const request = await requestAttestation({ signer: evm, xrplHash: sent.hash, network: NETWORK });
  console.log(`requestAttestation ${request.txHash}, round ${request.votingRoundId}`);
  const { proof } = await waitForProof({ request, network: NETWORK });
  const receipt = await submit({ signer: evm, controller: oldD.diamond, proof, payload });
  console.log(`execute ${receipt.hash} block ${receipt.blockNumber}`);
  console.log(`old account now ${await fx.balanceOf(from)}, new account now ${await fx.balanceOf(to)}`);
}

const CALLS_ABI = "tuple(address target, uint256 value, bytes data)[]";

/**
 * Encode a payload the RETIRED deployment can decode.
 *
 * These formats are frozen history: the corresponding encoders no longer exist in the SDK,
 * because the SDK only ever emits the current one. They live here so a retired deployment
 * stays reachable, which is the difference between migrating funds and stranding them.
 *
 *   phase1  abi.encode(sender, nonce, Call[])
 *   phase2  abi.encode(sender, nonce, feeToken, feeAmount, Call[])
 *   (phase3 adds a leading version byte and PostCondition[]; that is the SDK's job)
 */
function legacyPayload(
  format: string,
  sender: string,
  nonce: bigint,
  calls: unknown[],
): string {
  const coder = AbiCoder.defaultAbiCoder();
  switch (format) {
    case "phase1":
      return coder.encode(["address", "uint256", CALLS_ABI], [sender, nonce, calls]);
    case "phase2":
      return coder.encode(
        ["address", "uint256", "address", "uint256", CALLS_ABI],
        [sender, nonce, "0x" + "00".repeat(20), 0n, calls],
      );
    default:
      throw new Error(`unknown LEGACY_FORMAT "${format}" (expected phase1 or phase2)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
