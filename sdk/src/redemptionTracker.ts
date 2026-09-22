/**
 * Follow a redemption from the Flare request through to the XRPL payout, or to default.
 *
 * A redemption is the one memokit instruction that does not finish when the Flare
 * transaction does. `redeem` creates an obligation; an agent discharges it by sending XRP
 * and calling `confirmRedemptionPayment`, or fails to and is defaulted, at which point the
 * redeemer is paid out of the agent's collateral in FLR and vault collateral instead of XRP.
 *
 * Every deadline below is read from the `RedemptionRequested` event itself rather than from
 * documentation, because the event carries the exact XRPL block and timestamp the agent is
 * held to -- `lastUnderlyingBlock` and `lastUnderlyingTimestamp`. Those are the contract's
 * own view of "late", and they are per-request, not a global constant.
 */
import { Contract, type Provider, type Log } from "ethers";

export const ASSET_MANAGER_EVENTS = [
  "event RedemptionRequested(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, string paymentAddress, uint256 valueUBA, uint256 feeUBA, uint256 firstUnderlyingBlock, uint256 lastUnderlyingBlock, uint256 lastUnderlyingTimestamp, bytes32 paymentReference, address executor, uint256 executorFeeNatWei)",
  "event RedemptionPerformed(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, bytes32 transactionHash, uint256 redemptionAmountUBA, int256 spentUnderlyingUBA)",
  "event RedemptionDefault(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, uint256 redemptionAmountUBA, uint256 redeemedVaultCollateralWei, uint256 redeemedPoolCollateralWei)",
  "event RedemptionPaymentFailed(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, bytes32 transactionHash, int256 spentUnderlyingUBA, string failureReason)",
  "event RedemptionPaymentBlocked(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, bytes32 transactionHash, uint256 redemptionAmountUBA, int256 spentUnderlyingUBA)",
  "event RedemptionRequestIncomplete(address indexed redeemer, uint256 remainingLots)",
];

export interface RedemptionRequest {
  requestId: bigint;
  agentVault: string;
  redeemer: string;
  /** The XRPL address the agent must pay. */
  paymentAddress: string;
  /** Gross amount in base units, before the redemption fee. */
  valueUBA: bigint;
  feeUBA: bigint;
  /** XRPL ledger index after which the agent is late. */
  lastUnderlyingBlock: bigint;
  /** XRPL close time after which the agent is late. */
  lastUnderlyingTimestamp: bigint;
  /** 32-byte reference the agent must put in its XRPL payment memo. */
  paymentReference: string;
  /** Flare block and transaction the request came from. */
  blockNumber: number;
  transactionHash: string;
}

export type RedemptionOutcome =
  | { status: "pending"; request: RedemptionRequest; secondsUntilLate: number }
  | { status: "performed"; request: RedemptionRequest; xrplTransactionHash: string; redemptionAmountUBA: bigint }
  | { status: "defaulted"; request: RedemptionRequest; redeemedVaultCollateralWei: bigint; redeemedPoolCollateralWei: bigint }
  | { status: "failed"; request: RedemptionRequest; reason: string; xrplTransactionHash: string }
  | { status: "blocked"; request: RedemptionRequest; xrplTransactionHash: string };

/** Pull the `RedemptionRequested` (and any incomplete warning) out of a redeem receipt. */
export function parseRedemptionRequests(
  assetManager: string,
  logs: readonly Log[],
): { requests: RedemptionRequest[]; remainingLots: bigint | null } {
  const iface = new Contract(assetManager, ASSET_MANAGER_EVENTS).interface;
  const requests: RedemptionRequest[] = [];
  let remainingLots: bigint | null = null;

  for (const log of logs) {
    if (log.address.toLowerCase() !== assetManager.toLowerCase()) continue;
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;

    if (parsed.name === "RedemptionRequested") {
      requests.push({
        requestId: parsed.args.requestId,
        agentVault: parsed.args.agentVault,
        redeemer: parsed.args.redeemer,
        paymentAddress: parsed.args.paymentAddress,
        valueUBA: parsed.args.valueUBA,
        feeUBA: parsed.args.feeUBA,
        lastUnderlyingBlock: parsed.args.lastUnderlyingBlock,
        lastUnderlyingTimestamp: parsed.args.lastUnderlyingTimestamp,
        paymentReference: parsed.args.paymentReference,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      });
    } else if (parsed.name === "RedemptionRequestIncomplete") {
      // The soft failure: fewer lots were redeemed than asked for, without a revert.
      remainingLots = parsed.args.remainingLots;
    }
  }
  return { requests, remainingLots };
}

/**
 * Current outcome of a redemption.
 *
 * @dev Scans forward from the request block for the terminal event. The public Coston2 RPC
 *      caps `eth_getLogs` at 30 blocks, so this walks in windows rather than asking for the
 *      whole range at once -- the same constraint that shaped the rescue classifier.
 */
export async function checkRedemption(args: {
  assetManager: string;
  provider: Provider;
  request: RedemptionRequest;
  /** Where to stop looking. Defaults to the chain head. */
  toBlock?: number;
  /** Blocks per `eth_getLogs` call. Coston2's public RPC allows 30. */
  windowSize?: number;
}): Promise<RedemptionOutcome> {
  const { assetManager, provider, request } = args;
  const contract = new Contract(assetManager, ASSET_MANAGER_EVENTS, provider);
  const head = args.toBlock ?? (await provider.getBlockNumber());
  const windowSize = args.windowSize ?? 30;

  const terminal = ["RedemptionPerformed", "RedemptionDefault", "RedemptionPaymentFailed", "RedemptionPaymentBlocked"];

  for (let from = request.blockNumber; from <= head; from += windowSize) {
    const to = Math.min(from + windowSize - 1, head);
    for (const name of terminal) {
      const events = await contract.queryFilter(
        contract.filters[name](null, null, request.requestId),
        from,
        to,
      );
      const hit = events[0] as unknown as { args: Record<string, unknown> } | undefined;
      if (!hit) continue;

      switch (name) {
        case "RedemptionPerformed":
          return {
            status: "performed",
            request,
            xrplTransactionHash: String(hit.args.transactionHash),
            redemptionAmountUBA: hit.args.redemptionAmountUBA as bigint,
          };
        case "RedemptionDefault":
          return {
            status: "defaulted",
            request,
            redeemedVaultCollateralWei: hit.args.redeemedVaultCollateralWei as bigint,
            redeemedPoolCollateralWei: hit.args.redeemedPoolCollateralWei as bigint,
          };
        case "RedemptionPaymentFailed":
          return {
            status: "failed",
            request,
            reason: String(hit.args.failureReason),
            xrplTransactionHash: String(hit.args.transactionHash),
          };
        default:
          return {
            status: "blocked",
            request,
            xrplTransactionHash: String(hit.args.transactionHash),
          };
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    status: "pending",
    request,
    secondsUntilLate: Number(request.lastUnderlyingTimestamp) - now,
  };
}

/** Poll until the redemption reaches a terminal state or the deadline passes. */
export async function waitForRedemption(args: {
  assetManager: string;
  provider: Provider;
  request: RedemptionRequest;
  deadlineMs: number;
  intervalMs?: number;
  onPoll?: (outcome: RedemptionOutcome) => void;
}): Promise<RedemptionOutcome> {
  const interval = args.intervalMs ?? 15_000;
  let last: RedemptionOutcome | undefined;

  while (Date.now() < args.deadlineMs) {
    const outcome = await checkRedemption(args);
    args.onPoll?.(outcome);
    last = outcome;
    if (outcome.status !== "pending") return outcome;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last ?? (await checkRedemption(args));
}

/**
 * What happens if the agent never pays, in the contract's own terms.
 *
 * The redeemer is not left holding nothing. Once `lastUnderlyingBlock` AND
 * `lastUnderlyingTimestamp` have both passed, anyone can prove the non-payment to the
 * AssetManager -- via an FDC `ReferencedPaymentNonexistence` attestation -- and the
 * AssetManager pays the redeemer out of the agent's collateral. `RedemptionDefault` carries
 * the two amounts: `redeemedVaultCollateralWei` from the agent's vault collateral and
 * `redeemedPoolCollateralWei` from the collateral pool.
 *
 * Two consequences worth stating plainly, because they are easy to miss:
 *
 *   1. The compensation is paid **on Flare, in collateral**, not in XRP on XRPL. A user who
 *      cashed out to get XRP and hit a default gets FLR-denominated value in their memokit
 *      account instead, and has to cash out again.
 *   2. The default is **not automatic**. Somebody has to submit the non-existence proof.
 *      Agents are economically motivated to pay rather than default, and executors are paid
 *      to push defaults through, but a redeemer with no executor should expect to have to
 *      do it themselves.
 */
export const REDEMPTION_DEFAULT_NOTE = {
  trigger:
    "both request.lastUnderlyingBlock and request.lastUnderlyingTimestamp have passed without a confirmed payment",
  proof: "FDC ReferencedPaymentNonexistence over the request's paymentReference",
  paidIn: "agent vault collateral plus pool collateral, on Flare -- not XRP on XRPL",
  automatic: false,
} as const;
