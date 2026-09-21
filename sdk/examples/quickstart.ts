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
