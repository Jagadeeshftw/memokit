/**
 * One-off: move the FTestXRP held by the PHASE 1 account into the PHASE 2 account.
 *
 * Phase 2 redeploys the diamond (the fee redesign changes the payload format and the selector
 * set), so the same XRPL owner derives a new account address. The 5.0 FTestXRP that funded
 * Phase 1 sits at the old one. Rather than mint again, this spends it with a real instruction
 * on the OLD diamond, in the OLD payload format -- (sender, nonce, Call[]), no fee fields --
 * through the same SDK path as everything else. It doubles as a check that the SDK's attestation
 * path is independent of the payload format: only `prepareInstruction` is format-specific, and
 * this script does not use it.
 *
 * Run: MIGRATE_AMOUNT=5000000 npm run migrate -w @memokit/executor
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
  const oldD = JSON.parse(readFileSync(resolve(REPO, "fixtures/deployment-phase1.json"), "utf8"));
  const newD = JSON.parse(readFileSync(resolve(REPO, "fixtures/deployment.json"), "utf8"));
  const token: string = need("MEMOKIT_FXRP");
  const amount = BigInt(need("MIGRATE_AMOUNT"));

  const oldC = new Contract(oldD.diamond, CONTROLLER_ABI, provider);
  const newC = new Contract(newD.diamond, CONTROLLER_ABI, provider);
  const from: string = await oldC.computeAccountAddress(owner.address);
  const to: string = await newC.computeAccountAddress(owner.address);
  const nonce: bigint = await oldC.nonceOf(from);
  const fx = new Contract(token, ERC20, provider);
  console.log(`old account ${from} (nonce ${nonce}) holds ${await fx.balanceOf(from)}`);
  console.log(`new account ${to} holds ${await fx.balanceOf(to)}`);

  // The Phase 1 payload: abi.encode(address sender, uint256 nonce, Call[] calls).
  const payload = AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "tuple(address target, uint256 value, bytes data)[]"],
    [from, nonce, [[token, 0n, ERC20.encodeFunctionData("transfer", [to, amount])]]],
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
