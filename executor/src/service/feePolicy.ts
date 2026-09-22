/**
 * Whether an instruction is worth working, from the operator's side.
 *
 * The executor fee is denominated in whatever token the instruction moves, and the executor's
 * own cost is gas in the network's native token. Bridging those needs a price, and a service
 * that fetches prices to decide whether to work for a penny has a new failure mode and a new
 * dependency for no gain. So it does not: **the operator states what each token is worth to
 * them**, as a minimum acceptable fee per token, and anything not on the list is declined.
 *
 * That default is deliberately the strict one. An unlisted token may be worthless, may be a
 * honeypot that reverts on transfer, or may not exist; accepting it by default would make the
 * first surprise the operator's problem.
 */
import { getAddress } from "ethers";

export type FeeVerdict =
  | { work: true; reason: string; feeToken: string | null; feeAmount: bigint }
  | { work: false; reason: string };

export interface FeePolicyConfig {
  /** Minimum acceptable fee, in base units, keyed by lowercase token address. */
  minimumByToken: Record<string, bigint>;
  /**
   * Whether to relay rescue memos (`0xE0`/`0xE1`/`0xE2`/`0xFB`), which pay nothing.
   *
   * They are how a user unsticks their own queue. Relaying them costs the operator a little
   * gas and earns nothing, which is a choice, not an oversight -- hence a flag rather than a
   * hidden default.
   */
  relayRescues: boolean;
  /**
   * What to do with a `0xFC` commit memo whose preimage the service does not have.
   *
   * It cannot be executed at all without the preimage -- `execute` takes it as an argument --
   * so this only decides whether the service keeps watching for one or forgets the payment.
   */
  unknownPayload: "skip" | "wait";
}

export const RESCUE_OPCODES = new Set([0xe0, 0xe1, 0xe2, 0xfb]);
export const EXEC_OPCODES = new Set([0xfd, 0xfc]);

/**
 * @param opcode     From the memo header.
 * @param fee        The committed fee, or null when the payload is not visible yet.
 */
export function evaluate(
  policy: FeePolicyConfig,
  opcode: number | null,
  fee: { token: string; amount: bigint } | null,
): FeeVerdict {
  if (opcode === null) {
    return { work: false, reason: "no memokit memo" };
  }
  if (RESCUE_OPCODES.has(opcode)) {
    return policy.relayRescues
      ? { work: true, reason: "rescue memo, relayed unpaid by policy", feeToken: null, feeAmount: 0n }
      : { work: false, reason: "rescue memo, and relayRescues is off" };
  }
  if (!EXEC_OPCODES.has(opcode)) {
    return { work: false, reason: `opcode 0x${opcode.toString(16)} is not executable` };
  }
  if (fee === null) {
    return {
      work: false,
      reason:
        policy.unknownPayload === "wait"
          ? "commit memo, preimage not supplied yet"
          : "commit memo, preimage not supplied",
    };
  }

  // A zero fee is a valid instruction that simply does not pay. It is the owner submitting
  // their own work, and it is not this service's job.
  if (fee.amount === 0n) {
    return { work: false, reason: "fee is zero: nothing in it for an executor" };
  }

  const key = fee.token.toLowerCase();
  const minimum = policy.minimumByToken[key];
  if (minimum === undefined) {
    return { work: false, reason: `fee token ${fee.token} is not on the accepted list` };
  }
  if (fee.amount < minimum) {
    return { work: false, reason: `fee ${fee.amount} is below the ${minimum} minimum for ${fee.token}` };
  }
  return { work: true, reason: `fee ${fee.amount} meets the ${minimum} minimum`, feeToken: fee.token, feeAmount: fee.amount };
}

/**
 * Parse `MIN_FEE` -- `token:amount` pairs, comma separated.
 *
 * Addresses are checksummed on the way in so a typo fails at startup rather than silently
 * never matching an instruction at run time.
 */
export function parseMinimums(spec: string | undefined): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  if (!spec) return out;
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [token, amount] = part.split(":");
    if (!token || !amount) throw new Error(`MIN_FEE entry "${part}" is not token:amount`);
    out[getAddress(token.trim()).toLowerCase()] = BigInt(amount.trim());
  }
  return out;
}
