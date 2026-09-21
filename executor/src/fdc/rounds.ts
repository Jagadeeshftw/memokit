import { Contract, JsonRpcProvider } from "ethers";
import { COSTON2 } from "../config.js";

/**
 * Voting-round arithmetic.
 *
 * An attestation request lands in the round covering its submission timestamp; the proof
 * becomes available only once that round is finalised. Both numbers are read from the Relay
 * contract rather than hardcoded, because they differ across Flare networks.
 */
const RELAY_ABI = [
  "function getVotingRoundId(uint256 _timestamp) view returns (uint256)",
  "function firstVotingRoundStartTs() view returns (uint64)",
  "function votingEpochDurationSeconds() view returns (uint64)",
];

export interface RoundTiming {
  firstVotingRoundStartTs: number;
  votingEpochDurationSeconds: number;
}

export class RoundClock {
  private timing?: RoundTiming;

  constructor(
    private readonly provider: JsonRpcProvider = new JsonRpcProvider(COSTON2.rpc),
    private readonly relayAddress: string = COSTON2.relay,
  ) {}

  async load(): Promise<RoundTiming> {
    if (this.timing) return this.timing;
    const relay = new Contract(this.relayAddress, RELAY_ABI, this.provider);
    const [start, duration] = await Promise.all([
      relay.firstVotingRoundStartTs(),
      relay.votingEpochDurationSeconds(),
    ]);
    this.timing = {
      firstVotingRoundStartTs: Number(start),
      votingEpochDurationSeconds: Number(duration),
    };
    return this.timing;
  }

  async roundIdAt(unixSeconds: number): Promise<number> {
    const t = await this.load();
    return Math.floor((unixSeconds - t.firstVotingRoundStartTs) / t.votingEpochDurationSeconds);
  }

  /** Wall-clock instant at which `roundId` starts. */
  async roundStart(roundId: number): Promise<number> {
    const t = await this.load();
    return t.firstVotingRoundStartTs + roundId * t.votingEpochDurationSeconds;
  }
}
