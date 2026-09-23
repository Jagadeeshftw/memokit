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
| `LOW_BALANCE_WEI` | `2000000000000000000` (2 C2FLR) | Below this, `/healthz` and `/metrics` flag the executor as low. About eight instructions of headroom. |
| `RATE_LIMIT_PER_IP_PER_MINUTE` | `30` | Per-caller request rate. |
| `RATE_LIMIT_PER_IP_BURST` | `10` | How many a caller may make back to back. |
| `RATE_LIMIT_GLOBAL_PER_MINUTE` | `300` | Across every caller, so a forged `x-forwarded-for` cannot multiply the limit. |
| `MAX_CONCURRENT_LOOKUPS` | `10` | `/status` lookups in flight before further ones get 429. |
| `CACHE_SECONDS` | `5` | How long `/instructions` and `/metrics` are reused for. |
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

## Public traffic cannot starve the executor

The status routes share a process, an event loop and an upstream rate limit with the thing that
moves money. The last of those is the one that does not show up in a latency graph: a `/status`
lookup wants the DA Layer, and the DA Layer allows about 20 requests a minute in total, so
enough public traffic would once have stopped execution while every health signal stayed green.

What is in place now:

- **The DA Layer budget is split.** Three quarters to the executor, which may wait; one quarter
  to public lookups, which may not. A lookup with no token skips the proof search and answers
  from the chain alone — which the classifier already reports honestly as "no proof in the
  scanned window", so the answer degrades rather than the service.
- **Per-caller rate limit**, 30/min with a burst of 10, answering 429 with `Retry-After`.
- **A global cap** of 300/min behind it, because `x-forwarded-for` is client-supplied: forging
  it spreads one caller across buckets without raising the total.
- **A concurrency cap** of 10 on `/status`, the only route that reads the chain. Past it,
  callers get 429 immediately rather than queueing behind RPC calls.
- **Five-second caching** on `/instructions` and `/metrics`, served with `Cache-Control`.

Measured rather than asserted, against a local instance with a real instruction in flight
([`http-load-test.json`](../fixtures/measurements/http-load-test.json)): 6,272,883 requests in
120 seconds — 52,274 a second — of which 69 were served and the rest refused with 429 and a
`Retry-After`. No socket errors. **The instruction executed normally throughout**, 132 seconds
from seen to executed against a 159-second unloaded baseline, and the poll loop held 15.4
seconds per tick against its 15-second target.

One request peaked at 6.5 seconds: a lookup that had already passed the limiter and was waiting
on chain reads. It is bounded by the concurrency cap rather than the rate limit, and it delayed
nobody but that caller.

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

The image carries no key and no configuration. `STATE_FILE` defaults to
`/data/executor-state.json`; mount a volume there.

The container starts as root only long enough for `docker-entrypoint.sh` to take ownership of
`/data`, then drops to the unprivileged `node` user before the service runs. That dance is
needed because a mounted volume arrives owned by root — see "What the first deploy got wrong"
below.

The build loads the service's whole module graph (`RUN node … import(…)`) before it finishes, so
a dependency that resolves wrongly fails the build rather than the boot.

## Railway

This is how the live deployment was made, with the CLI. Every step was run.

```bash
railway init --name memokit-executor
railway add --service memokit-executor
railway link --project memokit-executor --service memokit-executor --environment production

# The key goes straight from wherever you generated it into Railway. Never through a file in
# the repo, never echoed.
railway variables --skip-deploys \
  --set "PRIVATE_KEY=$KEY" \
  --set "MIN_FEE=0x0b6A3645c240605887a5532109323A3E12273dc7:100000" \
  --set "HTTP_PORT=8080" \
  --set "STATE_FILE=/data/executor-state.json" \
  --set "REFUSE_IF_SECRETS_PRESENT=1"

railway volume add --mount-path /data
railway up --detach          # builds the Dockerfile at the repository root
railway domain               # generates the public *.up.railway.app URL
```

1. **Use a key made for the executor, and only for it.** Never the key that deployed the
   contracts: an executor is a machine on the public internet and a deployer key is an admin
   key. The live one is `0xD4dFA2b68d14fc71BF5940559Ad9F819c1b0350D`, generated for this and
   funded with 20 C2FLR.
2. **`HTTP_PORT` explicitly.** Railway injects `PORT`, which this service does not read. With
   `HTTP_PORT=8080` and the Dockerfile's `EXPOSE 8080`, Railway routes the domain to it without a
   target port being set.
3. **`REFUSE_IF_SECRETS_PRESENT=1`.** The service checks its own environment at boot for
   variables it must never hold — XRPL seeds, a deployer key, Xaman's secret — and with this set,
   refuses to start if it finds one. The result is published on `/healthz` as `secretAudit`, so
   anyone can check the claim instead of trusting it.
4. **A volume at `/data`.** Without one a redeploy starts with an empty state file: safe, but it
   re-reads the ledger and loses the status timestamps.
5. **Health check path `/healthz`.** 200 as soon as the service is up, with the balance.

### Funding it

Size it from what an instruction actually costs, not from habit. Coston2 charges **650 gwei**,
so one complete instruction is 0.25–0.28 C2FLR, not the fraction of a cent an EVM habit
suggests:

| | gas | C2FLR |
|---|---|---|
| `requestAttestation` | 82,947 | 0.054 |
| `execute` | 293,129–341,619 | 0.19–0.22 |
| **one instruction** | | **0.25–0.28** |

20 C2FLR is therefore about 75 instructions. `/healthz` flags `lowBalance` below 2 C2FLR — about
eight instructions of warning.

### What the first deploy got wrong

Three things, none of them visible in a local run. All three are fixed in the files; they are
recorded because each one is the kind of thing that recurs.

1. **Railway refuses `VOLUME` in a Dockerfile.** The first build failed at parse time:
   `dockerfile invalid: docker VOLUME at Line 41 is not supported, use Railway Volumes`. The
   Dockerfile now creates `/data` and leaves mounting to the platform.
2. **The container resolved the wrong ethers and died at boot.** Something in the Foundry-side
   toolchain depends on ethers 5, and npm was free to hoist that one to the root, in front of
   the ethers 6 the SDK imports: `SyntaxError: Named export 'AbiCoder' not found. The requested
   module 'ethers' is a CommonJS module`. Every local run goes through `tsx` and resolves from
   the workspace, so it never showed. The root `package.json` now names `ethers ^6` so the
   hoisted copy is the right one, and the build-time import check proves it on every build — it
   caught this very failure on the second attempt, at build time instead of boot.
3. **The volume arrived owned by root, and the service runs as `node`.** Every write of the
   state file failed with `EACCES`. That is not fatal, which is what made it dangerous: the
   service kept executing and silently lost its memory across restarts, which would have meant
   paying for attestations twice. The entrypoint now takes ownership of `/data` and then drops
   privileges.

### Running only the status API

No key, no fees, nothing signed:

```bash
READ_ONLY=1 npm run status-api -w @memokit/executor
```

Same image, same endpoints. Set `READ_ONLY=1` and leave `PRIVATE_KEY` unset.

## What it exposes

| Route | |
|---|---|
| `GET /healthz` | uptime, pending count, controller, seconds since the last tick, the executor wallet's balance with a `lowBalance` flag, and `secretAudit` — the boot-time check that the process holds no secret it should not |
| `GET /metrics` | Prometheus text: payments seen, attestations requested and reused, executions, races by outcome, declines, rate limits, errors by stage, HTTP requests by route and outcome, and `memokit_executor_balance_flr` / `memokit_executor_balance_low` |
| `GET /instructions?limit=&state=` | recent instructions, newest first |
| `GET /status/{xrplHash}` | one instruction's position in the state machine, with seconds in each state |

The live deployment is at **https://memokit-executor-production.up.railway.app**.

`/status` is the Phase 3 classifier, not a second implementation of it. The classifier decides
the state from the chain and the ledger; the service only adds the timestamps, and says so when
they are observations rather than a record of what it did.
