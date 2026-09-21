/**
 * Pins the selector set of Flare's live `MasterAccountController` on Coston2 and Flare mainnet.
 *
 * Why this exists. memokit's controller is meant to be cuttable into Flare's diamond. A
 * selector that memokit shares with that diamond is not a compile error and not a test failure
 * anywhere else in this repo: it surfaces as a reverted cut at best, and at worst -- if
 * someone cuts everything *except* the shared selector -- as callers silently reaching Flare's
 * implementation and reading Flare's state as if it were memokit's. Phase 1 found two of those
 * (`implementation()`, `isTransactionIdUsed(bytes32)`) by diffing by hand, once. This makes the
 * diff mechanical: `test/SelectorCollision.t.sol` compares every memokit external selector
 * against the fixtures this script writes.
 *
 *   npm run selectors:refresh -w @memokit/executor     rewrite fixtures/flare-selectors/*.json
 *   npm run selectors:check   -w @memokit/executor     exit 1 if the chain has moved on
 *
 * The read is `IDiamondLoupe.facets()` at one pinned block per network, so the fixture records
 * exactly which state it describes. Flare's diamond is upgradeable and timelocked; a `check`
 * that fails is the signal that a Flare upgrade changed the surface and the test's verdict may
 * have gone stale.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Contract, JsonRpcProvider } from "ethers";

const REPO = resolve(import.meta.dirname, "../../..");
const OUT_DIR = resolve(REPO, "fixtures/flare-selectors");

/** The controller is deployed at the same address on Coston2 and Flare mainnet (PHASE0). */
const CONTROLLER = "0x434936d47503353f06750Db1A444DBDC5F0AD37c";

const NETWORKS = [
  {
    name: "coston2",
    chainId: 114,
    rpc: process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc",
  },
  {
    name: "flare",
    chainId: 14,
    rpc: process.env.FLARE_RPC ?? "https://flare-api.flare.network/ext/C/rpc",
  },
] as const;

const LOUPE = [
  "function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])",
];

export interface SelectorFixture {
  network: string;
  chainId: number;
  controller: string;
  blockNumber: number;
  blockTimestamp: number;
  source: string;
  facetCount: number;
  selectorCount: number;
  facets: Array<{ address: string; selectors: string[] }>;
  /** Every selector the controller routes, sorted, lowercase. What the Solidity test reads. */
  selectors: string[];
}

async function capture(net: (typeof NETWORKS)[number]): Promise<SelectorFixture> {
  const provider = new JsonRpcProvider(net.rpc);
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== net.chainId) {
    throw new Error(`${net.name}: RPC reports chain ${chainId}, expected ${net.chainId}`);
  }
  if ((await provider.getCode(CONTROLLER)) === "0x") {
    throw new Error(`${net.name}: no contract at ${CONTROLLER}`);
  }

  // One block for the whole capture, so the fixture describes a single consistent state.
  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  const loupe = new Contract(CONTROLLER, LOUPE, provider);
  const raw: Array<{ facetAddress: string; functionSelectors: string[] }> = await loupe.facets({
    blockTag: blockNumber,
  });

  const facets = raw
    .map((f) => ({
      address: f.facetAddress,
      selectors: [...f.functionSelectors].map((s) => s.toLowerCase()).sort(),
    }))
    .sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));

  const all = facets.flatMap((f) => f.selectors);
  const unique = [...new Set(all)].sort();
  if (unique.length !== all.length) {
    throw new Error(`${net.name}: loupe returned a selector under two facets, which a diamond cannot do`);
  }

  return {
    network: net.name,
    chainId: net.chainId,
    controller: CONTROLLER,
    blockNumber,
    blockTimestamp: Number(block?.timestamp ?? 0),
    source: "IDiamondLoupe.facets() at blockNumber",
    facetCount: facets.length,
    selectorCount: unique.length,
    facets,
    selectors: unique,
  };
}

function pathFor(network: string): string {
  return resolve(OUT_DIR, `${network}.json`);
}

async function main() {
  const check = process.argv.includes("--check");
  let drifted = false;

  for (const net of NETWORKS) {
    const live = await capture(net);
    const file = pathFor(net.name);

    if (check) {
      if (!existsSync(file)) {
        console.error(`${net.name}: no pinned fixture at ${file}; run selectors:refresh`);
        drifted = true;
        continue;
      }
      const pinned = JSON.parse(readFileSync(file, "utf8")) as SelectorFixture;
      const added = live.selectors.filter((s) => !pinned.selectors.includes(s));
      const removed = pinned.selectors.filter((s) => !live.selectors.includes(s));
      if (added.length === 0 && removed.length === 0) {
        console.log(
          `${net.name}: unchanged. ${live.selectorCount} selectors across ${live.facetCount} facets ` +
            `(pinned at block ${pinned.blockNumber}, live at ${live.blockNumber})`,
        );
      } else {
        drifted = true;
        console.error(`${net.name}: Flare's selector set has CHANGED since block ${pinned.blockNumber}`);
        if (added.length) console.error(`  added:   ${added.join(" ")}`);
        if (removed.length) console.error(`  removed: ${removed.join(" ")}`);
        console.error(`  run selectors:refresh, then re-read test/SelectorCollision.t.sol's verdict`);
      }
      continue;
    }

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(live, null, 2) + "\n");
    console.log(
      `${net.name}: wrote ${live.selectorCount} selectors across ${live.facetCount} facets ` +
        `at block ${live.blockNumber} -> ${file}`,
    );
  }

  if (drifted) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
