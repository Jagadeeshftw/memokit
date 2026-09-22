/**
 * The executor's own balance, watched.
 *
 * A drained executor does not crash. It keeps polling the ledger, keeps classifying, and
 * fails at the one moment that costs somebody something: the attestation request, or the
 * execute. From outside it looks like a service that is running and simply never finishing
 * anything, which is the worst failure to diagnose because every other signal says healthy.
 *
 * So the balance is a first-class health field rather than something an operator is expected
 * to go and check. It is read on a timer rather than per request, because `/healthz` is
 * polled by a platform health check and an RPC call per probe is a way to be rate-limited by
 * your own monitoring.
 */
import { formatEther, type JsonRpcProvider } from "ethers";

export interface BalanceReading {
  address: string;
  wei: bigint;
  flr: string;
  /** True when the balance is below the configured floor. */
  low: boolean;
  /** Unix ms of the reading, so a stale one can be recognised as stale. */
  at: number;
  /** Set when the most recent read failed; the reading is then the last good one. */
  error?: string;
}

/**
 * The default floor: 2 C2FLR, which is about eight instructions of headroom.
 *
 * Measured, not guessed, and the measurement is the point. Coston2 charges **650 gwei**, not
 * the tens of gwei an EVM habit expects, so one complete instruction costs far more than it
 * looks like it should:
 *
 *   requestAttestation    82,947 gas  =  0.0539 C2FLR   (plus a 1000 wei attestation fee)
 *   execute              293,129 gas  =  0.1905 C2FLR
 *   ----------------------------------------------------
 *   one instruction                      0.2445 C2FLR
 *
 * Both figures are from the Phase 4 live run, not from an estimate. A second instruction,
 * measured end to end as a balance delta on the deployed key, cost 0.2760 C2FLR -- its execute
 * burned 341,619 gas rather than 293,129, because gas scales with the instruction, and an
 * inline memo carries more calldata than a commit. So 0.25 to 0.28 is the working range, and
 * the constant below is the low end of it: a floor sized on the cheap case is the conservative
 * direction to be wrong in.
 *
 * A floor of 1 C2FLR would leave four instructions -- an alarm that fires with nothing left to
 * spend. Two leaves eight, which is a working day of warning at testnet volume and still quiet
 * on a funded service.
 *
 * The gas price is the number to re-check if this ever looks wrong: at 650 gwei the cost is
 * dominated by gas, so a change there moves the whole figure.
 */
export const DEFAULT_LOW_BALANCE_WEI = 2n * 10n ** 18n;

/** One complete instruction at the measured price, for sizing a top-up. */
export const MEASURED_INSTRUCTION_COST_WEI = 244_450_000_000_000_000n;

export class BalanceWatch {
  private reading: BalanceReading | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly address: string,
    private readonly lowWatermarkWei: bigint = DEFAULT_LOW_BALANCE_WEI,
    private readonly intervalMs = 60_000,
  ) {}

  /** Read once now. Called at startup so the first `/healthz` is not empty. */
  async refresh(): Promise<BalanceReading> {
    try {
      const wei = await this.provider.getBalance(this.address);
      this.reading = {
        address: this.address,
        wei,
        flr: formatEther(wei),
        low: wei < this.lowWatermarkWei,
        at: Date.now(),
      };
    } catch (error) {
      // A failed read is not a zero balance, and reporting it as one would trigger exactly the
      // alarm this exists to make meaningful. Keep the last good reading and mark it.
      this.reading = this.reading
        ? { ...this.reading, error: (error as Error).message.slice(0, 200) }
        : {
            address: this.address,
            wei: 0n,
            flr: "unknown",
            low: false,
            at: Date.now(),
            error: (error as Error).message.slice(0, 200),
          };
    }
    return this.reading;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    // Nothing should be held open by a balance poll at shutdown.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current(): BalanceReading | null {
    return this.reading;
  }

  /** Seconds since the last successful reading, or null when there has never been one. */
  ageSeconds(now = Date.now()): number | null {
    return this.reading ? Math.round((now - this.reading.at) / 1000) : null;
  }
}
