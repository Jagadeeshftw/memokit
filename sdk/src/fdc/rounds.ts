import { Contract, type Provider } from "ethers";
import { COSTON2 } from "../networks.js";

/**
 * Voting-round arithmetic.
 *
 * An attestation request lands in the round covering its submission timestamp, and the
 * proof becomes available only once that round is finalised.
 *
 * The Relay contract is authoritative. An earlier version of this file guessed at
 * `firstVotingRoundStartTs()` and `votingEpochDurationSeconds()` accessors; neither exists
 * on the deployed Relay, and the call reverted with no revert data. Only
 * `getVotingRoundId(uint256)` is in `IRelay`, so that is what we use.
 */
const RELAY_ABI = ["function getVotingRoundId(uint256 _timestamp) view returns (uint256)"];

export class RoundClock {
  constructor(
    private readonly provider: Provider,
    private readonly relayAddress: string,
    private readonly daLayerUrl: string = COSTON2.daLayerUrl,
  ) {}

  /** The voting round covering `unixSeconds`, per the Relay contract. */
  async roundIdAt(unixSeconds: number): Promise<number> {
    const relay = new Contract(this.relayAddress, RELAY_ABI, this.provider);
    return Number(await relay.getVotingRoundId(unixSeconds));
  }

  /** The round covering the block a transaction landed in. */
  async roundIdOfBlock(blockNumber: number): Promise<number> {
    const block = await this.provider.getBlock(blockNumber);
    if (!block) throw new Error(`block ${blockNumber} not found`);
    return this.roundIdAt(Number(block.timestamp));
  }

  /**
   * The newest round the DA Layer has finalised, and when it started.
   * @dev Used to tell "the proof is not ready yet" apart from "the request was never
   *      attested", which otherwise look identical: both are a 400 from the proof endpoint.
   */
  async latestFinalisedRound(): Promise<{ votingRoundId: number; startTimestamp: number } | null> {
    const res = await fetch(`${this.daLayerUrl}/api/v0/fsp/latest-voting-round`);
    if (!res.ok) {
      await res.arrayBuffer();
      return null;
    }
    const body = (await res.json()) as { voting_round_id?: number; start_timestamp?: number };
    if (body.voting_round_id === undefined) return null;
    return { votingRoundId: body.voting_round_id, startTimestamp: body.start_timestamp ?? 0 };
  }
}
