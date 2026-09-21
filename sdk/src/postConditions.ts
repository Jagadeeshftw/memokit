/**
 * Builders for the post-conditions an instruction commits to.
 *
 * Hand-encoding these is easy to get subtly wrong -- a native condition with a token address
 * set, or an FTSO bound whose decimals belong to the wrong token -- and the failure shows up
 * as a reverted execution 150 seconds later. These helpers make the valid shapes the easy ones.
 */
import { encodeFtsoBound } from "./memo.js";
import { PostConditionKind, ZERO_ADDRESS, type FtsoBound, type PostCondition } from "./types.js";

/** `token.balanceOf(subject) >= atLeast` after the calls. */
export function erc20BalanceAtLeast(token: string, subject: string, atLeast: bigint): PostCondition {
  return { kind: PostConditionKind.Erc20BalanceAtLeast, token, subject, threshold: atLeast, extra: "0x" };
}

/** `token.balanceOf(subject)` rose by at least `atLeast`, against a pre-execution snapshot. */
export function erc20DeltaAtLeast(token: string, subject: string, atLeast: bigint): PostCondition {
  return { kind: PostConditionKind.Erc20DeltaAtLeast, token, subject, threshold: atLeast, extra: "0x" };
}

/** `subject.balance >= atLeast` after the calls. */
export function nativeBalanceAtLeast(subject: string, atLeast: bigint): PostCondition {
  return {
    kind: PostConditionKind.NativeBalanceAtLeast,
    token: ZERO_ADDRESS,
    subject,
    threshold: atLeast,
    extra: "0x",
  };
}

/** `subject.balance` rose by at least `atLeast`. */
export function nativeDeltaAtLeast(subject: string, atLeast: bigint): PostCondition {
  return {
    kind: PostConditionKind.NativeDeltaAtLeast,
    token: ZERO_ADDRESS,
    subject,
    threshold: atLeast,
    extra: "0x",
  };
}

/**
 * The realised rate of a swap is within `maxDeviationBps` of FTSOv2's, at execution time.
 *
 * @param tokenOut The token received; its delta on `subject` is the realised output.
 * @param subject Whose balance is measured, normally the account.
 *
 * This bounds *pool state*: manipulation, a sandwich, a thin or stale pool. It does not bound
 * genuine market movement during the ~150 s an attestation takes, because the oracle moves with
 * the market. Pair it with {@link erc20DeltaAtLeast} for an absolute floor, which is what caps
 * that second risk.
 */
export function ftsoRateAtLeast(
  tokenOut: string,
  subject: string,
  bound: FtsoBound,
): PostCondition {
  return {
    kind: PostConditionKind.FtsoRateAtLeast,
    token: tokenOut,
    subject,
    threshold: 0n,
    extra: encodeFtsoBound(bound),
  };
}

/** FTSOv2 feed id for a crypto pair name such as `XRP/USD`. */
export function feedId(name: string): string {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length > 20) throw new Error(`feed name too long: ${name}`);
  const out = new Uint8Array(21);
  out[0] = 0x01; // category: crypto
  out.set(bytes, 1);
  return "0x" + Buffer.from(out).toString("hex");
}
