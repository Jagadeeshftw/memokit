/**
 * `memokit rescue` -- show every XRPL payment an owner sent to the receiving address, where
 * each one got to, and what to do about the ones that are not finished.
 *
 *   npm run rescue -w @memokit/executor -- --owner rPT1... [--json]
 *
 * Read-only. It never signs anything and never sends an XRPL payment: it prints the memo to
 * send, so the owner signs it themselves in whatever wallet holds the key.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JsonRpcProvider, Contract } from "ethers";
import {
  classifyPayments,
  fetchPaymentsToReceivers,
  RESCUE_STATES,
  COSTON2,
  toXrplMemoData,
  type ClassifiedPayment,
} from "@memokit/sdk";
import {
  DaLayerClient,
  RoundClock,
  buildXrpPaymentResponse,
  computeMic,
  encodeRequest,
} from "@memokit/sdk/fdc";
import { Client as XrplClient } from "xrpl";

const REPO = resolve(import.meta.dirname, "../../..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const COLOUR: Record<string, string> = {
  executed: "\x1b[32m",
  retired: "\x1b[90m",
  "awaiting-attestation": "\x1b[33m",
  "attested-not-executed": "\x1b[36m",
  "execution-failed": "\x1b[31m",
  expired: "\x1b[35m",
  "not-an-instruction": "\x1b[90m",
};
const RESET = "\x1b[0m";
const plain = process.env.NO_COLOR !== undefined || process.argv.includes("--no-color");
const tint = (s: string, state: string) => (plain ? s : `${COLOUR[state] ?? ""}${s}${RESET}`);

function human(seconds: number): string {
  const a = Math.abs(seconds);
  if (a < 90) return `${a}s`;
  if (a < 5400) return `${Math.round(a / 60)}m`;
  if (a < 172800) return `${Math.round(a / 3600)}h`;
  return `${Math.round(a / 86400)}d`;
}

function render(rows: ClassifiedPayment[]): void {
  if (rows.length === 0) {
    console.log("No payments from this owner to the receiving address.");
    return;
  }

  for (const r of rows) {
    const badge = tint(r.state.toUpperCase().padEnd(22), r.state);
    console.log(`\n${badge} ${r.xrplHash}`);
    console.log(`  ledger ${r.ledgerIndex}  ${r.reason}`);
    if (r.nonce !== null) {
      console.log(`  instruction nonce ${r.nonce}, account at ${r.accountNonce}`);
    }
    if (!RESCUE_STATES[r.state].final) {
      const remaining = r.validitySecondsRemaining;
      console.log(
        remaining > 0
          ? `  proof window: ${human(remaining)} left`
          : `  proof window: closed ${human(remaining)} ago`,
      );
    }
    console.log(`  loss if ignored: ${RESCUE_STATES[r.state].loss}`);

    if (r.rescue) {
      console.log(`  -> ${r.rescue.action}: ${r.rescue.summary}`);
      if (r.rescue.memo) {
        console.log(`     send an XRPL payment to the receiving address with MemoData:`);
        console.log(`     ${toXrplMemoData(r.rescue.memo)}`);
      }
    }
  }

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.state] = (acc[r.state] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `\n${rows.length} payment(s): ` +
      Object.entries(counts)
        .map(([s, n]) => tint(`${n} ${s}`, s))
        .join(", "),
  );
}

async function main() {
  const owner = arg("owner");
  if (!owner) {
    console.error("usage: rescue --owner <xrpl address> [--controller 0x..] [--json]");
    process.exit(2);
  }

  const deployment = JSON.parse(
    readFileSync(arg("deployment") ?? resolve(REPO, "fixtures/deployment.json"), "utf8"),
  );
  const controllerAddress = arg("controller") ?? deployment.diamond;
  const provider = new JsonRpcProvider(COSTON2.rpc);

  const controller = new Contract(
    controllerAddress,
    ["function receivingAddresses() view returns (string[])"],
    provider,
  );
  const receivingAddresses: string[] = await controller.receivingAddresses();

  // Resolved from the registry rather than pinned, so the CLI follows a Relay redeploy.
  const registry = new Contract(
    COSTON2.contractRegistry,
    ["function getContractAddressByName(string) view returns (address)"],
    provider,
  );
  const relayAddress: string = await registry.getContractAddressByName("Relay");

  const payments = await fetchPaymentsToReceivers({
    network: COSTON2,
    xrplOwner: owner,
    receivingAddresses,
    limit: Number(arg("limit") ?? 100),
  });

  // Telling "not attested yet" from "attested, nobody delivered" needs the DA Layer, and the
  // DA Layer is keyed by (round, requestBytes) rather than by XRPL transaction. So for each
  // payment we rebuild the exact request offline from ledger data -- the same code path the
  // executor uses, no verifier involved -- and search a short window of rounds from the XRPL
  // close. See `DaLayerClient.findProofNear` for why the window is short and what a negative
  // answer does and does not mean.
  const da = new DaLayerClient(COSTON2.daLayerUrl);
  const clock = new RoundClock(provider, relayAddress, COSTON2.daLayerUrl);
  const xrplClient = new XrplClient(COSTON2.xrpl.websocket);
  await xrplClient.connect();

  const hasProof = async (transactionId: string, closedAt: number) => {
    try {
      const raw = (await xrplClient.request({
        command: "tx",
        transaction: transactionId.replace(/^0x/, "").toUpperCase(),
      } as never)) as { result: Record<string, unknown> };
      const ledgerTx = { ...((raw.result.tx_json as object) ?? {}), ...raw.result };

      const response = buildXrpPaymentResponse(
        ledgerTx as never,
        COSTON2.sourceId,
        transactionId,
      );
      const request = encodeRequest(
        { transactionId, proofOwner: "0x" + "00".repeat(20) },
        COSTON2.sourceId,
        computeMic(response),
      );
      const from = await clock.roundIdAt(closedAt);
      return (await da.findProofNear(request, from, Number(arg("rounds") ?? 8))) !== null;
    } catch {
      // Unknown means "propose requesting an attestation", which is idempotent and cheap.
      return false;
    }
  };

  const rows = await classifyPayments(payments, {
    network: COSTON2,
    controller: controllerAddress,
    xrplOwner: owner,
    provider,
    hasProof,
  });

  await xrplClient.disconnect();

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    );
  } else {
    console.log(`owner       ${owner}`);
    console.log(`controller  ${controllerAddress}`);
    console.log(`receiving   ${receivingAddresses.join(", ")}`);
    render(rows);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
