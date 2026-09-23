/**
 * Has anybody already asked FDC for this exact attestation?
 *
 * On mainnet a request costs 20 FLR (docs/fdc-fees.md). It is worth one scan of FdcHub's events
 * to avoid paying it twice. And paying twice is not hypothetical: in both live FSA imports, an
 * identical request from another address landed a few seconds before ours, so ours bought
 * nothing.
 *
 * FdcHub emits `AttestationRequest(bytes data, uint256 fee)` for every request, with the full
 * request bytes as unindexed data. Those bytes are a pure function of the XRPL payment -- type,
 * source, MIC and body are all derivable offline -- so "has anyone requested this" is a
 * byte-for-byte comparison against FdcHub's logs, starting from the block in which the XRPL
 * payment could first have been requested.
 *
 * This answers "requested", not "confirmed". A request is confirmed only when its voting round
 * finalises, which is what the DA Layer tells you, and that is minutes too late to decide whether
 * to pay.
 */
import { AbiCoder, id, type Provider } from "ethers";

/** `keccak256("AttestationRequest(bytes,uint256)")`, checked against a live FdcHub log. */
export const ATTESTATION_REQUEST_TOPIC = id("AttestationRequest(bytes,uint256)");

export interface FoundRequest {
  txHash: string;
  blockNumber: number;
  /** Fee paid by that request, in wei. */
  feeWei: bigint;
}

export interface RequestLogSource {
  /** Current head. */
  head(): Promise<number>;
  /** Block timestamp, unix seconds. */
  timestampOf(block: number): Promise<number>;
  /** FdcHub AttestationRequest logs in [from, to], inclusive. */
  logs(from: number, to: number): Promise<Array<{ data: string; transactionHash: string; blockNumber: number }>>;
}

/** The real source: an ethers provider pointed at the chain FdcHub lives on. */
export function providerRequestLog(provider: Provider, fdcHub: string): RequestLogSource {
  return {
    head: () => provider.getBlockNumber(),
    timestampOf: async (block) => (await provider.getBlock(block))!.timestamp,
    logs: async (from, to) =>
      (await provider.getLogs({ address: fdcHub, topics: [ATTESTATION_REQUEST_TOPIC], fromBlock: from, toBlock: to })).map(
        (l) => ({ data: l.data, transactionHash: l.transactionHash, blockNumber: l.blockNumber }),
      ),
  };
}

/**
 * The first block whose timestamp is at or after `unixSeconds`.
 *
 * A binary search rather than an estimate from an assumed block time: an estimate that guesses
 * blocks too slow starts the scan too late and misses exactly the early requests this exists
 * to find.
 */
export async function firstBlockAtOrAfter(src: RequestLogSource, unixSeconds: number): Promise<number> {
  const head = await src.head();
  if ((await src.timestampOf(head)) < unixSeconds) return head;

  // Find a lower bound that is strictly before the target, doubling back from the head.
  let span = 64;
  let lo = Math.max(0, head - span);
  while (lo > 0 && (await src.timestampOf(lo)) >= unixSeconds) {
    span *= 2;
    lo = Math.max(0, head - span);
  }
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await src.timestampOf(mid)) >= unixSeconds) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The earliest request whose bytes are identical to `abiEncodedRequest`, made at or after
 * `sinceUnixSeconds` -- or null, with the exact range that was searched.
 *
 * Compared as decoded bytes, never as a substring of the log data: a longer request that happened
 * to contain ours as a prefix is a different request.
 *
 * @param pageSize Blocks per `eth_getLogs` call. The public Coston2 RPC refuses more than 30.
 */
export async function findIdenticalRequest(args: {
  source: RequestLogSource;
  abiEncodedRequest: string;
  sinceUnixSeconds: number;
  pageSize?: number;
  /** Stop here instead of at the head. For replaying a past window. */
  untilBlock?: number;
}): Promise<{ found: FoundRequest | null; searched: { fromBlock: number; toBlock: number } }> {
  const pageSize = args.pageSize ?? 30;
  const want = args.abiEncodedRequest.toLowerCase();
  const fromBlock = await firstBlockAtOrAfter(args.source, args.sinceUnixSeconds);
  const toBlock = args.untilBlock ?? (await args.source.head());
  const coder = AbiCoder.defaultAbiCoder();

  for (let start = fromBlock; start <= toBlock; start += pageSize) {
    const end = Math.min(start + pageSize - 1, toBlock);
    const logs = await args.source.logs(start, end);
    const matches = logs
      .map((l) => {
        const [data, fee] = coder.decode(["bytes", "uint256"], l.data) as unknown as [string, bigint];
        return { ...l, data: (data as string).toLowerCase(), fee };
      })
      .filter((l) => l.data === want)
      .sort((a, b) => a.blockNumber - b.blockNumber);
    if (matches.length > 0) {
      const m = matches[0];
      return {
        found: { txHash: m.transactionHash, blockNumber: m.blockNumber, feeWei: m.fee },
        searched: { fromBlock, toBlock: end },
      };
    }
  }
  return { found: null, searched: { fromBlock, toBlock } };
}
