# Running the open executor

The executor is a long-running process anyone can run. It watches the memokit receiving
addresses on XRPL, pays for attestations, waits for the Data Availability Layer, simulates, and
submits `execute`. It is paid the fee the instruction committed to, in the asset the instruction
moves.

Nothing about it is privileged. There is no allowlist, no registration, and no coordination
between executors — which is also why racing is normal and is handled rather than avoided.

## The short version

```bash
cp .env.example .env            # fill in PRIVATE_KEY at least
npm install && npm run build
MIN_FEE=0x0b6A3645c240605887a5532109323A3E12273dc7:100000 \
  npm run service -w @memokit/executor
```

It prints what it is doing, one JSON object per line. `LOG_PRETTY=1` makes it readable.

## Configuration

Everything is an environment variable, and the service refuses to start with a list of what is
missing rather than failing forty minutes in.

| Variable | Default | What it is |
|---|---|---|
| `PRIVATE_KEY` | — | **Required.** The Flare EOA that pays attestation fees and gas, and is paid the executor fee. Not required with `READ_ONLY=1`. |
| `MIN_FEE` | empty | `token:amount` pairs, comma separated. The minimum fee, in base units, that makes an instruction worth working. **A token not listed here is declined.** |
| `MEMOKIT_CONTROLLER` | from `fixtures/deployment.json` | The diamond. |
| `RECEIVING_ADDRESSES` | read from the controller | Override the addresses to watch. Rarely wanted: the controller is where they are authoritative. |
| `RELAY_RESCUES` | `true` | Relay `0xE0`/`0xE1`/`0xE2`/`0xFB` rescue memos, which pay nothing. Costs a little gas; it is how users unstick their own queues. |
| `UNKNOWN_PAYLOAD` | `wait` | What to do with a `0xFC` commit memo whose preimage you do not have: keep watching, or forget it. |
| `PAYLOADS_FILE` | none | JSON map of transaction id to payload, for commit memos. Re-read on every lookup, so you can add one without a restart. |
| `STATE_FILE` | `.executor-state.json` | Where progress is persisted. **Put this on a volume.** |
| `POLL_INTERVAL_MS` | `15000` | Ledger poll cadence. |
| `DA_REQUESTS_PER_MINUTE` | `20` | The measured public DA Layer limit. Lower it if you share an endpoint. |
| `BACKFILL_LIMIT` | `50` | How many ledger entries to read per address per poll. |
| `MAX_ATTEMPTS` | `8` | Attempts at a stage before an instruction is parked as `stuck`. |
| `HTTP_PORT` | off (`8080` in read-only) | Serves `/healthz`, `/metrics`, `/instructions`, `/status/{hash}`. |
| `READ_ONLY` | off | Watch and serve the status API, never sign. No key needed. |
| `DRY_RUN` | off | Do everything except spend: no attestation request, no submit. |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / off | |

### What the fee policy is really doing

The executor fee is in whatever token the instruction moves; the executor's cost is gas in
C2FLR. Bridging those needs a price, and a service that fetches prices to decide whether to work
for a penny has a new dependency and a new failure mode. So it does not: **you say what each
token is worth to you**, and anything unlisted is declined. An unlisted token may be worthless,
may revert on transfer, or may not exist.

Start strict:

```bash
# FTestXRP has 6 decimals, so 100000 is 0.1 FTestXRP.
MIN_FEE=0x0b6A3645c240605887a5532109323A3E12273dc7:100000
```

### The one thing an executor cannot do

A `0xFC` commit memo carries only a hash, and `execute` takes the preimage as an argument. An
executor that does not have the preimage **cannot** run the instruction — not "will not". Either
the instruction author hands it over (`PAYLOADS_FILE`), or the instruction is sent as `0xFD`
inline, which carries everything and is self-contained. `npm run sign -- --inline` does that.

## Racing other executors

Every executor sees the proof at the same moment, and the first `execute` mined consumes the
transaction id. Losing is normal and is logged as an outcome, not an error. What it costs:

| Where it is lost | Cost |
|---|---|
| At the simulation, before submitting | The attestation fee, if you were the one who paid it. Nothing else — a simulation is free. |
| After submitting, mined second | The gas of a reverted transaction, plus the attestation fee if you paid it. |

The pipeline simulates before **every** submission, which is what keeps the common case in the
first row. The second row is not preventable: the window is between the `eth_call` and the block
your transaction lands in. `memokit_executor_races_total{outcome="lost-after-submit"}` is the
number to watch — if it is climbing, you are consistently arriving second and should look at your
RPC's latency before your gas price.

## Restarting

State is written after every stage, and every stage is safe to repeat. **The chain is the real
guard**: an XRPL transaction id can be consumed exactly once, so even a lost state file cannot
produce a duplicate execution — it can only make you pay for an attestation somebody already
bought. Before requesting one, the service rebuilds the request offline and asks the DA Layer
whether a proof already exists, so even that is usually avoided.

Mount a volume on `STATE_FILE` anyway. It is cheap, and it keeps the timestamps the status API
publishes.

## Docker

```bash
docker build -t memokit-executor .
docker run --rm \
  -e PRIVATE_KEY=0x... \
  -e MIN_FEE=0x0b6A3645c240605887a5532109323A3E12273dc7:100000 \
  -e HTTP_PORT=8080 -p 8080:8080 \
  -v memokit-state:/data \
  memokit-executor
```

The image carries no key and no configuration. `STATE_FILE` defaults to `/data/executor-state.json`
inside it, and `/data` is a volume.

## Railway

Railway builds the Dockerfile at the repository root without further configuration.

1. **New Project → Deploy from GitHub repo**, point it at this repository. It detects the
   `Dockerfile`; no build command or start command is needed.
2. **Variables**: `PRIVATE_KEY`, `MIN_FEE`, and `HTTP_PORT=8080`. Railway injects `PORT`, which
   this service does not read — set `HTTP_PORT` explicitly so the health check and the public
   URL agree.
3. **Volume**: add one mounted at `/data`. Without it a redeploy starts with an empty state
   file, which is safe but re-reads the ledger and loses the status timestamps.
4. **Health check path**: `/healthz`. It returns 200 with the pending count as soon as the
   service is up.
5. **Networking**: generate a domain if you want the status API reachable. Everything it serves
   is already public information on two public chains; there is nothing there to protect.

A funded key is the only prerequisite. On Coston2 an attestation costs 1000 wei and an execute
costs about 300,000 gas, so a few C2FLR from the faucet runs it for a long time.

### Running only the status API

No key, no fees, nothing signed:

```bash
READ_ONLY=1 npm run status-api -w @memokit/executor
```

Same image, same endpoints. Set `READ_ONLY=1` and leave `PRIVATE_KEY` unset.

## What it exposes

| Route | |
|---|---|
| `GET /healthz` | uptime, pending count, controller |
| `GET /metrics` | Prometheus text: payments seen, attestations requested and reused, executions, races by outcome, declines, rate limits, errors by stage |
| `GET /instructions?limit=&state=` | recent instructions, newest first |
| `GET /status/{xrplHash}` | one instruction's position in the state machine, with seconds in each state |

`/status` is the Phase 3 classifier, not a second implementation of it. The classifier decides
the state from the chain and the ledger; the service only adds the timestamps, and says so when
they are observations rather than a record of what it did.
