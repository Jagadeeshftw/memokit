# FTSOv2 reference feeds

The seven feeds memokit's tests and examples use, with their IDs and the decimals each one
reports on Coston2 and on Flare mainnet.

**Read on 2026-09-23 at 04:51 UTC**, Coston2 block 35723169 and Flare block 70422032. The raw
reading, including the value and timestamp of each feed, is in
[`fixtures/ftso-feeds.json`](../fixtures/ftso-feeds.json).

| Feed | Feed ID | Coston2 decimals | Mainnet decimals |
|---|---|---|---|
| FLR/USD | `0x01464c522f55534400000000000000000000000000` | 8 | 8 |
| XRP/USD | `0x015852502f55534400000000000000000000000000` | 6 | 6 |
| ETH/USD | `0x014554482f55534400000000000000000000000000` | 3 | 3 |
| USDT/USD | `0x01555344542f555344000000000000000000000000` | **6** | **5** |
| USDC/USD | `0x01555344432f555344000000000000000000000000` | **6** | **5** |
| BTC/USD | `0x014254432f55534400000000000000000000000000` | 2 | 2 |
| SGB/USD | `0x015347422f55534400000000000000000000000000` | **9** | **8** |

## Why this table matters

**Three of the seven report different decimals on the two networks.** A rate bound that pinned
decimals would pass every Coston2 test and misprice USDT, USDC and SGB by a factor of ten on
mainnet. So `PostConditions` reads a feed's decimals from the feed on every evaluation and
commits only the *token* decimals, which do not change. This table records the reason; it is not
an input to anything.

It is a snapshot. Flare can re-scale a feed at any time, which is exactly why the code does not
trust it. If the decimals below have changed when you re-read them, the code is still right and
this page is stale.

## What a feed ID is

21 bytes: a category byte, then the feed name in ASCII, zero-padded. Category `0x01` is crypto.

```
0x01 | "XRP/USD" | zero padding to 21 bytes
0x01   5852502f555344   00000000000000000000000000
```

`test/fork/FtsoFeeds.t.sol` builds IDs exactly this way (`_feedId`).

## How to re-read them

The test does it, read-only, against both networks:

```bash
FOUNDRY_PROFILE=fork forge test --match-contract FtsoFeedsTest -vv
```

It asserts each feed exists, reports a non-zero value and is fresh, and logs the decimals it saw.
It does not assert the exact count of mismatches, because Flare may re-scale a feed.

Or by hand, with nothing but `cast`. FtsoV2 is resolved from the Flare Contract Registry, which is
at the same address on every network:

```bash
REG=0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019
KEY=$(cast keccak $(cast abi-encode "f(string)" FtsoV2))
RPC=https://coston2-api.flare.network/ext/C/rpc     # or a Flare mainnet RPC

FTSO=$(cast call $REG "getContractAddressByHash(bytes32)(address)" $KEY --rpc-url $RPC)
cast call $FTSO "getFeedById(bytes21)(uint256,int8,uint64)" \
  0x01555344542f555344000000000000000000000000 --rpc-url $RPC
# -> value, decimals, timestamp
```

`getFeedById` is declared `payable`, not `view`. `cast call` does not care, but a Solidity caller
does: it cannot be evaluated from a static context, which is why `PostConditions.check()` is
non-view while `snapshot()` is.

On the reading above, FtsoV2 resolved to `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` on Coston2
and `0x7BDE3Df0624114eDB3A67dFe6753e62f4e7c1d20` on Flare mainnet.
