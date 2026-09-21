/**
 * How long an instruction that carries a time bound should stay valid.
 *
 * Instructions that touch a price (a swap, a borrow against a moving collateral factor) should
 * commit to a deadline, because the instruction sits on chain-side for however long attestation
 * takes and the market does not wait. Too short and a slow round makes the instruction
 * unexecutable; too long and it stays exploitable after the user has stopped caring.
 *
 * Measured, not guessed. Phase 1 saw 152 s and 162 s from XRPL submission to `execute`, about
 * 90% of it the FDC round finalising and reaching the DA Layer. So:
 *
 *     worst observed                  162 s
 *   + one missed 90 s FDC round      +  90 s
 *   = a slow-but-ordinary path        252 s
 *   x a safety factor of 3.5          ~ 900 s
 *
 * 900 s (15 min) leaves the executor several rounds of slack for RPC hiccups and DA Layer
 * lag while keeping the window short enough that a stale swap is not a standing offer.
 * Callers with a tighter tolerance should pass their own; this is a default, not a rule.
 */
export const DEFAULT_DEADLINE_SECONDS = 900;

/** Unix seconds `seconds` from now, for a `deadline` argument. */
export function deadlineFromNow(seconds: number = DEFAULT_DEADLINE_SECONDS, nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) + seconds;
}
