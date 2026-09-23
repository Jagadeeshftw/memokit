/**
 * Cash out: redeem FXRP held by a memokit account back to XRP on the XRP Ledger.
 *
 * This closes the loop. An XRPL payment carrying a memo instructs the account to call
 * FAssets' `redeem`, which burns the FXRP and obliges an agent to send XRP to an XRPL
 * address. The user starts on XRPL and ends on XRPL, having never held an EVM key.
 *
 * Two things about it are not like the rest of memokit, and both matter.
 *
 * **It is not atomic.** Every other memokit instruction finishes inside one Flare
 * transaction. A redemption finishes when an *agent* sends an XRPL payment, minutes to hours
 * later, or fails to and is defaulted. `redemptionTracker.ts` follows it; nothing in the
 * instruction itself can wait for it.
 *
 * **It is denominated in lots, not amounts.** `redeem(uint256 _lots, ...)` takes whole lots,
 * and the lot size on Coston2 is 1e7 base units -- 10 FXRP. Anything below a lot boundary
 * cannot be redeemed at all. See {@link planCashOut}, which computes the dust rather than
 * rounding silently.
 *
 * **What arrives is less than the lot**, twice over. See {@link CASH_OUT_SHRINKAGE}.
 */
import { Contract, getAddress, type Provider } from "ethers";
import type { Call } from "./types.js";

const ASSET_MANAGER_ABI = [
  "function redeem(uint256 _lots, string _redeemerUnderlyingAddressString, address _executor) payable returns (uint256)",
  "function lotSize() view returns (uint256)",
  "function fAsset() view returns (address)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

/**
 * Sending the redeemed XRP somewhere other than the payer's own XRPL address.
 *
 * Deliberately awkward. The destination is a plain string inside a memo the user signs
 * blind on a phone; a wrong one sends their money to a stranger, irreversibly, and nothing
 * downstream can catch it because a valid-looking XRPL address is indistinguishable from
 * the right one. Defaulting to the payer's own address makes the safe case the silent one,
 * and the unsafe case impossible to reach by accident or by a typo'd field name.
 */
export interface RedirectToDifferentXrplAddress {
  xrplDestination: string;
  /** Must be literally `true`. Present so the override cannot be set by a spread or a typo. */
  iAcknowledgeThisSendsToSomeoneElse: true;
}

export interface CashOutPlan {
  /** Whole lots that will be redeemed. */
  lots: bigint;
  /** Base units those lots represent. */
  redeemableAmount: bigint;
  /** Base units left behind because they do not fill a lot. */
  dust: bigint;
  lotSize: bigint;
  /** Where the XRP will land. */
  xrplDestination: string;
  /** True when the destination is not the payer's own address. */
  redirected: boolean;
  fAsset: string;
  balance: bigint;
}

/**
 * Work out how much of an account's FXRP can actually be redeemed.
 *
 * @param maxLots Cap the redemption; omit to redeem everything that fills a lot.
 */
export async function planCashOut(args: {
  assetManager: string;
  account: string;
  provider: Provider;
  /** The XRPL address that owns the account. The default destination. */
  xrplOwner: string;
  maxLots?: bigint;
  redirect?: RedirectToDifferentXrplAddress;
}): Promise<CashOutPlan> {
  const am = new Contract(args.assetManager, ASSET_MANAGER_ABI, args.provider);
  const [lotSize, fAsset] = await Promise.all([am.lotSize(), am.fAsset()]);
  const balance: bigint = await new Contract(fAsset, ERC20_ABI, args.provider).balanceOf(
    args.account,
  );

  let lots = balance / lotSize;
  if (args.maxLots !== undefined && args.maxLots < lots) lots = args.maxLots;

  const redeemableAmount = lots * lotSize;

  return {
    lots,
    redeemableAmount,
    dust: balance - redeemableAmount,
    lotSize,
    xrplDestination: resolveDestination(args.xrplOwner, args.redirect),
    redirected: args.redirect !== undefined,
    fAsset,
    balance,
  };
}

/**
 * How many whole lots can be redeemed while still leaving `fee` behind to pay the executor.
 *
 * The executor fee is paid AFTER the calls, out of what the redemption leaves in the account. A
 * cash-out that redeems every lot the balance covers leaves only the dust, and if the dust is
 * smaller than the fee the whole instruction reverts on chain -- after the user has paid for
 * the XRPL carrier. So the lot count is decided with the fee already set aside.
 */
export function lotsLeavingFee(balance: bigint, lotSize: bigint, fee: bigint): bigint {
  if (lotSize <= 0n) throw new Error(`lot size must be positive, got ${lotSize}`);
  if (fee < 0n) throw new Error(`fee cannot be negative, got ${fee}`);
  return balance > fee ? (balance - fee) / lotSize : 0n;
}

/** Exported so the safety rule can be tested directly; it is the part that loses money. */
export function resolveDestination(
  xrplOwner: string,
  redirect?: RedirectToDifferentXrplAddress,
): string {
  if (!redirect) return xrplOwner;
  if (redirect.iAcknowledgeThisSendsToSomeoneElse !== true) {
    throw new Error(
      "redirecting a cash-out requires iAcknowledgeThisSendsToSomeoneElse: true -- " +
        "the redeemed XRP goes to this address irreversibly",
    );
  }
  if (!redirect.xrplDestination || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(redirect.xrplDestination)) {
    throw new Error(`not a plausible XRPL address: ${redirect.xrplDestination}`);
  }
  return redirect.xrplDestination;
}

/**
 * The calls that redeem `plan.lots` to `plan.xrplDestination`.
 *
 * No approval is needed: FAssets burns the fAsset from `msg.sender`, which is the account.
 * `_executor` is the zero address, so no executor fee is owed and the call needs no value --
 * a memokit account is not required to hold native FLR.
 */
export function buildCashOutCalls(assetManager: string, plan: CashOutPlan): Call[] {
  if (plan.lots <= 0n) {
    throw new Error(
      `nothing to redeem: the account holds ${plan.balance} base units and a lot is ${plan.lotSize}`,
    );
  }
  const am = new Contract(assetManager, ASSET_MANAGER_ABI);
  return [
    {
      target: getAddress(assetManager),
      value: 0n,
      data: am.interface.encodeFunctionData("redeem", [
        plan.lots,
        plan.xrplDestination,
        "0x0000000000000000000000000000000000000000",
      ]),
    },
  ];
}

/**
 * The two deductions between a burned lot and the XRP that lands, both measured live.
 *
 * `plan.redeemableAmount` is what leaves the account. It is NOT what arrives. On the live
 * Coston2 trace, one 10.000000 FXRP lot produced 9.948010 XRP on XRPL:
 *
 *   1. `redeem` burns the full lot from the account but mints a small FAsset fee to the
 *      agent's collateral pool in the same transaction -- 2,000 base units of 10,000,000,
 *      visible as a mint to 0x6e815bb968e32f91c7e273b9e1cdae2825bf8f3a in the receipt. The
 *      obligation the agent takes on (`valueUBA`) is the remainder, 9.998000.
 *   2. The agent then keeps `feeUBA`, 0.049990 -- 50 bips of valueUBA on Coston2 -- and pays
 *      the difference.
 *
 * Neither deduction is memokit's, neither is configurable from here, and both are per-network
 * settings that can change. The honest thing a caller can do is quote `valueUBA - feeUBA`
 * from the `RedemptionRequested` event rather than predicting it from the lot size.
 */
export const CASH_OUT_SHRINKAGE = {
  measuredOn: "coston2, 2026-09-22, fixtures/measurements/cash-out-trace.json",
  burnedFromAccount: 10_000_000n,
  mintedToAgentPool: 2_000n,
  valueUBA: 9_998_000n,
  feeUBA: 49_990n,
  deliveredDrops: 9_948_010n,
  quoteFrom: "RedemptionRequested.valueUBA - RedemptionRequested.feeUBA",
} as const;

/**
 * Why a cash-out carries no post-condition, stated rather than left as an omission.
 *
 * memokit's post-conditions are all floors: "this balance is at least X", "this balance rose
 * by at least X". That shape fits every instruction that *acquires* something. A redemption
 * is the opposite: the meaningful claim is that the account's FXRP went DOWN by a lot, and
 * that a redemption request now exists -- neither of which a floor can express.
 *
 * What protects a cash-out instead:
 *
 *   - `redeem` reverts on failure. Unlike Compound-family markets it does not report refusal
 *     as a return value, so the Phase 2 silent-success problem does not arise here.
 *   - `RedemptionRequestIncomplete(redeemer, remainingLots)` is emitted when fewer lots were
 *     redeemed than asked for. That IS a soft failure, and it is the one case a post-condition
 *     would help with. The tracker reports it instead.
 *
 * A `BalanceAtMost` / `DeltaDownAtLeast` pair would close this properly and is the obvious
 * next addition to `IPostConditions`.
 */
export const CASH_OUT_POST_CONDITION_NOTE =
  "post-conditions are floors; a redemption needs a ceiling. See CASH_OUT_POST_CONDITION_NOTE.";
