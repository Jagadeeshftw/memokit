/**
 * Everything the pipeline does to a chain, behind one interface.
 *
 * Not indirection for its own sake: the interesting behaviour of an executor is what it does
 * when a submission reverts, when another executor wins, when an attestation never confirms.
 * Driving those against a live network is slow, expensive and unrepeatable, and mocking
 * `ethers` at the provider level tests `ethers`. Five methods can be faked exactly.
 *
 * `controllerChain` is the real one, and it is the only place in the service that builds a
 * contract object.
 */
import { Contract, JsonRpcProvider, Wallet, type TransactionReceipt } from "ethers";
import { CONTROLLER_ABI, requestAttestation, type Network } from "@memokit/sdk";

export interface ExecutedTx {
  hash: string;
  blockNumber: number;
  gasUsed: bigint;
}

export interface RequestedAttestation {
  txHash: string;
  votingRoundId: number;
  abiEncodedRequest: string;
  feeWei: bigint;
}

export interface ExecutorChain {
  /** Has this XRPL transaction already driven an execution? */
  isConsumed(transactionId: string): Promise<boolean>;
  /** The personal account an XRPL address owns. */
  accountFor(xrplOwner: string): Promise<string>;
  /** Run `execute` without sending it. Throws the revert. */
  simulate(proof: unknown[], payload: string): Promise<void>;
  /** Send `execute` and wait for the receipt. */
  execute(proof: unknown[], payload: string): Promise<ExecutedTx>;
  /** Pay FDC to attest an XRPL payment. */
  requestAttestation(xrplHash: string): Promise<RequestedAttestation>;
}

export function controllerChain(args: {
  controller: string;
  provider: JsonRpcProvider;
  wallet: Wallet;
  network: Network;
}): ExecutorChain {
  const read = new Contract(args.controller, CONTROLLER_ABI, args.provider);
  const write = new Contract(args.controller, CONTROLLER_ABI, args.wallet);

  return {
    isConsumed: (transactionId) => read.isXrplTransactionConsumed(transactionId),
    accountFor: (xrplOwner) => read.computeAccountAddress(xrplOwner),
    simulate: async (proof, payload) => {
      // From the executor's address, because the fee is paid to `msg.sender` and a simulation
      // from anywhere else would not exercise the transfer that could make it revert.
      await write.execute.staticCall(proof, payload);
    },
    execute: async (proof, payload) => {
      const tx = await write.execute(proof, payload);
      const receipt = (await tx.wait()) as TransactionReceipt;
      return { hash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
    },
    requestAttestation: async (xrplHash) => {
      const r = await requestAttestation({ signer: args.wallet, xrplHash, network: args.network });
      return {
        txHash: r.txHash,
        votingRoundId: r.votingRoundId,
        abiEncodedRequest: r.abiEncodedRequest,
        feeWei: r.feeWei,
      };
    },
  };
}
