# FDC attestation request fees

What it costs to ask FDC to attest an XRPL payment, per network.

**Read on 2026-09-23**, Flare block 70425801 and Coston2 block 35725152. The raw reading is in
[`fixtures/fdc-fees.json`](../fixtures/fdc-fees.json).

| Network | Attestation / source | Fee | Gas for `requestAttestation` | Total per request |
|---|---|---|---|---|
| Flare mainnet | `Payment` / `XRP` | **20 FLR** | ~83,000 at 650 gwei ≈ 0.054 FLR | **≈ 20.05 FLR** |
| Flare mainnet | `XRPPayment` / `XRP` | **20 FLR** | same | **≈ 20.05 FLR** |
| Coston2 | `Payment` / `testXRP` | 1000 wei | ~83,000 at 650 gwei ≈ 0.054 C2FLR | ≈ 0.054 C2FLR |
| Coston2 | `XRPPayment` / `testXRP` | 1000 wei | same | ≈ 0.054 C2FLR |

memokit instructions use `XRPPayment`, because it carries the memo. The FSA import uses `Payment`,
because that is what FSA's `0x01` instruction verifies.

On mainnet the fee dominates: gas is a quarter of a percent of it. On Coston2 it is the other way
round, and the fee is effectively nothing. **Every cost measured on Coston2 understates mainnet by a
factor of several hundred on the attestation leg**, which is why the fee is recorded here rather than
inferred from testnet runs.

A request that does not confirm is **burnt, not refunded**.

## Where these came from

Phase 0 read the same 20 FLR on 2026-09-20 (`phase0-report.md`, "Addresses and fees") but did not
record the block or how to re-read it. This page is that re-read. The value had not changed.

The gas figures are from real `requestAttestation` receipts: three recent mainnet requests by other
parties (83,256, 83,127 and 82,779 gas) and memokit's own on Coston2 (82,947 and 83,304). Both networks
charged 650 gwei at the time of reading.

## How to re-read them

The fee is keyed on the attestation type and source — the first 64 bytes of the request — so the rest
of the request can be zeros.

```bash
REG=0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019          # Flare Contract Registry, every network
RPC=https://flare-api.flare.network/ext/C/rpc          # Coston2: https://coston2-api.flare.network/ext/C/rpc
SRC=XRP                                                # Coston2: testXRP
Z=0x0000000000000000000000000000000000000000000000000000000000000000

FEES=$(cast call $REG "getContractAddressByName(string)(address)" FdcRequestFeeConfigurations --rpc-url $RPC)

# Payment
cast call $FEES "getRequestFee(bytes)(uint256)" $(cast abi-encode \
  "f(bytes32,bytes32,bytes32,(bytes32,uint256,uint256))" \
  $(cast format-bytes32-string Payment) $(cast format-bytes32-string $SRC) $Z "($Z,0,0)") --rpc-url $RPC

# XRPPayment
cast call $FEES "getRequestFee(bytes)(uint256)" $(cast abi-encode \
  "f(bytes32,bytes32,bytes32,(bytes32,address))" \
  $(cast format-bytes32-string XRPPayment) $(cast format-bytes32-string $SRC) $Z \
  "($Z,0x0000000000000000000000000000000000000000)") --rpc-url $RPC

cast gas-price --rpc-url $RPC
```

An unsupported pair reverts with `Type and source combination not supported`, so a zero is never
returned by mistake.
