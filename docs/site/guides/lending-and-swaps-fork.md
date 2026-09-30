---
title: "Lending and swaps, on a mainnet fork"
description: "Kinetic and SparkDEX, run on a Foundry fork of Flare mainnet with FDC verification simulated."
---

> **Fork only.** Everything on this page runs on a Foundry fork of Flare mainnet: the real Kinetic
> and SparkDEX V3 contracts and the real FTSOv2 oracle, at a pinned block, with FDC verification
> **simulated**. None of it is a live transaction, and none of it has passed real attestation.

The same memokit instruction that deposits into a vault can borrow against collateral or swap on a
DEX. Those are the places where an instruction's safety machinery matters most, so they are
exercised against the real contracts rather than mocks.

**What you'll do:** run the fork suites for lending and for swaps, and read what each test shows.

## Before you start

- [Foundry](https://book.getfoundry.sh/getting-started/installation) and Node 20 or later.
- A clone of the memokit repo with its submodules (`git clone --recurse-submodules`), then
  `npm install && npm run build`. The fork tests build their proofs with the SDK through Foundry's
  ffi, which only the fork profile enables.
- Network access. The tests fork Flare mainnet through the archive endpoint named `flare_archive`
  in `foundry.toml`.

The first run compiles the fork profile and prints compiler warnings. Later runs are quiet.

## Lending on Kinetic

```bash
FOUNDRY_PROFILE=fork forge test --match-contract KineticForkTest -vv
```

```text
[PASS] test_depositCollateralAndBorrowAStablecoinInOneInstruction()
[PASS] test_fxrpIsNotAKineticMarket()
[PASS] test_kineticRefusesAnOversizedBorrowWithACodeNotARevert()
[PASS] test_withTheAssertionTheSameFailureUnwindsEverything()
[PASS] test_withoutAnAssertionAFailedBorrowIsConsumedAsSuccess()
Suite result: ok. 5 passed; 0 failed; 0 skipped
```

What they show:

- **One instruction deposits collateral, enters the market and borrows a stablecoin**, with a
  post-condition and the executor fee, in a single `execute`.
- **FXRP is not a Kinetic market.** The test lists the markets that exist on Flare mainnet; FXRP is not
  among them, so the collateral in these tests is another asset.
- **A Compound-style market reports some failures as a return value, not a revert.** Kinetic refuses
  an oversized borrow with an error code. Without a post-condition, that failed borrow is consumed as
  a success. With one, the same failure unwinds the whole instruction. This is why post-conditions
  exist: see [Post-conditions](/docs/concepts/post-conditions).

## Swaps on SparkDEX V3

```bash
FOUNDRY_PROFILE=fork forge test --match-contract SparkDexForkTest -vv
```

Twelve tests pass. The ones that matter most:

- `test_swapExecutesWithinTheCommittedMinimum`: a swap with a minimum output committed inside the
  instruction.
- `test_priceMovingPastTheMinimumRevertsTheSwapCleanly` and `test_anExpiredDeadlineRevertsCleanly`:
  the minimum and the deadline in the committed calldata do their job, and the instruction reverts
  cleanly.
- `test_anExecutorCannotLoosenTheCommittedFloor`: the executor cannot change what was signed.
- `test_aManipulatedPoolPassesTheLooseFloorAndFailsTheOracleBound`: the FTSOv2 rate bound, below.
- The rescue tests: a stuck instruction blocks the account's queue; `0xE1` advances the nonce past it,
  a fresh instruction at the same nonce supersedes it, and `0xE0` retires it without moving the nonce.

## The oracle bound, on its own

```bash
FOUNDRY_PROFILE=fork forge test --match-test test_aManipulatedPoolPassesTheLooseFloorAndFailsTheOracleBound -vv
```

```text
[PASS] test_aManipulatedPoolPassesTheLooseFloorAndFailsTheOracleBound() (gas: 2099361)
Logs:
  SIMULATED FDC VERIFICATION: verifyXRPPayment mocked to true (see ForkBase)
  FXRP dumped into the pool to move it: 35000000000
  fair out (USDT0): 1408788917
  manipulated out (USDT0): 975864088
  accepted with the floor alone (USDT0): 975864088
```

Someone dumps 35,000 FXRP into the real pool. A 1,000 FXRP swap now returns 975.86 USDT0 instead of a
fair 1,408.79, a move of about 31%. With only the signed minimum output (704.39), the manipulated swap
is accepted. With an FTSOv2 bound of 1% against the real oracle, the same swap is refused, and the
proof stays usable. The first log line says the attestation was simulated.

The bound catches pool manipulation. It does not catch genuine market movement during the wait for
an attestation, because the oracle moves with the market; that is what the deadline is for. See
[Price protection](/docs/concepts/price-protection).

## If something goes wrong

- **`missing trie node` or another RPC error:** the archive endpoint is having trouble. Retry in a
  minute.
- **`No tests found`:** the contract or test name is mistyped.
- **`ffi` is disabled:** you ran without `FOUNDRY_PROFILE=fork`.

To run every fork test: `npm run test:fork`.
