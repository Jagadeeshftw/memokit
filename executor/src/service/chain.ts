/**
 * Everything the pipeline does to a chain, behind one interface.
 *
 * Not indirection for its own sake: the interesting behaviour of an executor is what it does
 * when a submission reverts, when another executor wins, when an attestation never confirms.
 * Driving those against a live network is slow, expensive and unrepeatable, and mocking
 * `ethers` at the provider level tests `ethers`. Seven methods can be faked exactly.
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
  /** The account's next nonce: an instruction bound to anything lower can never execute. */
  nonceOf(account: string): Promise<bigint>;
  /**
   * Has FDC finalised this voting round on Flare? Once it has, a proof the DA Layer does not
   * serve for a request in that round is never going to be served.
   */
  isRoundFinalized(votingRoundId: number): Promise<boolean>;
}

/** FDC's protocol id on the Relay. */
const FDC_PROTOCOL_ID = 200;

export function controllerChain(args: {
  controller: string;
  provider: JsonRpcProvider;
  wallet: Wallet;
  network: Network;
}): ExecutorChain {
  const read = new Contract(args.controller, CONTROLLER_ABI, args.provider);
  const write = new Contract(args.controller, CONTROLLER_ABI, args.wallet);
  const registry = new Contract(
    args.network.contractRegistry,
    ["function getContractAddressByName(string) view returns (address)"],
    args.provider,
  );
  // Resolved once, from Flare's registry, rather than pinned: the Relay is Flare's to replace.
  let relay: Contract | undefined;

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
    nonceOf: async (account) => BigInt(await read.nonceOf(account)),
    isRoundFinalized: async (votingRoundId) => {
      relay ??= new Contract(
        await registry.getContractAddressByName("Relay"),
        ["function isFinalized(uint256 protocolId, uint256 votingRoundId) view returns (bool)"],
        args.provider,
      );
      return relay.isFinalized(FDC_PROTOCOL_ID, votingRoundId);
    },
  };
}
