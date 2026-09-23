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
 * The worst observed has since risen. The first FSA import took 173 s from XRPL ledger close to
 * execution -- about 180 s from submit -- and the open executor's runs take 165-167 s from ledger
 * close, because it polls rather than waits. Redone with 180 s the path is 270 s, and 900 s is a
 * factor of about 3.3 rather than 3.5. Still comfortable, so the constant stands; the margin is
 * recorded here so it is not quietly assumed to be larger than it is.
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
