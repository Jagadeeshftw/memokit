// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MemoKitTestBase} from "./base/MemoKitTestBase.sol";
import {MemoCodec} from "../contracts/libraries/MemoCodec.sol";
import {IPostConditions} from "../contracts/interfaces/IPostConditions.sol";
import {IPersonalAccount} from "../contracts/interfaces/IPersonalAccount.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

/// @notice A swap venue whose rate the test sets directly, so the bound is what is under test.
contract FixedRateSwap {
    IERC20 public immutable tokenIn;
    MockERC20 public immutable tokenOut;
    /// @dev Output per whole input unit, in the output token's base units.
    uint256 public ratePerWholeIn;

    constructor(IERC20 _in, MockERC20 _out, uint256 _rate) {
        tokenIn = _in;
        tokenOut = _out;
        ratePerWholeIn = _rate;
    }

    function setRate(uint256 _rate) external {
        ratePerWholeIn = _rate;
    }

    function swap(uint256 _amountIn, uint8 _decimalsIn) external {
        tokenIn.transferFrom(msg.sender, address(this), _amountIn);
        tokenOut.mint(msg.sender, (_amountIn * ratePerWholeIn) / (10 ** _decimalsIn));
    }
}

/**
 * @title FtsoRateBoundTest
 * @notice The FTSOv2 rate bound, across the decimal combinations that actually occur.
 *
 * @dev Two things vary independently and both have to be right:
 *
 *        token decimals -- FXRP 6, WFLR and WETH 18, committed in the payload;
 *        feed decimals  -- read from the feed on chain, because they differ per feed AND per
 *                          network. Live values at the time of writing: FLR/USD 8 on both,
 *                          XRP/USD 6 on both, ETH/USD 3 on both, BTC/USD 2 on both, but
 *                          USDT/USD 6 on Coston2 and 5 on Flare mainnet, and SGB/USD 9 vs 8.
 *
 *      Pinning feed decimals in the payload would have worked on Coston2 and silently
 *      mispriced everything by 10x on mainnet, so they are read, never committed.
 */
contract FtsoRateBoundTest is MemoKitTestBase {
    bytes32 internal constant TX_ID = bytes32(uint256(0xf7));

    bytes21 internal FEED_IN;
    bytes21 internal FEED_OUT;

    address internal account;
    MockERC20 internal usd;
    FixedRateSwap internal venue;

    function setUp() public override {
        super.setUp();
        FEED_IN = _feedId("XRP/USD");
        FEED_OUT = _feedId("USDT/USD");
        account = _accountFor(XRPL_SENDER);
        _fund(account, 1_000_000_000); // fxrp: 6 decimals
    }

    function _deploy(uint8 _outDecimals, uint256 _rate) internal {
        usd = new MockERC20("Test USD", "tUSD", _outDecimals);
        venue = new FixedRateSwap(fxrp, usd, _rate);
    }

    function _setFeeds(uint256 _priceIn, int8 _decIn, uint256 _priceOut, int8 _decOut) internal {
        ftso.setFeed(FEED_IN, _priceIn, _decIn, uint64(block.timestamp));
        ftso.setFeed(FEED_OUT, _priceOut, _decOut, uint64(block.timestamp));
    }

    function _swapCalls(uint256 _amountIn) internal view returns (IPersonalAccount.Call[] memory _c) {
        _c = new IPersonalAccount.Call[](2);
        _c[0] = IPersonalAccount.Call(
            address(fxrp), 0, abi.encodeCall(IERC20.approve, (address(venue), _amountIn))
        );
        _c[1] = IPersonalAccount.Call(
            address(venue), 0, abi.encodeCall(FixedRateSwap.swap, (_amountIn, 6))
        );
    }

    function _bound(uint256 _amountIn, uint8 _decOut, uint16 _bps, uint64 _maxAge)
        internal
        view
        returns (IPostConditions.FtsoBound memory)
    {
        return IPostConditions.FtsoBound({
            feedIdIn: FEED_IN,
            feedIdOut: FEED_OUT,
            decimalsIn: 6,
            decimalsOut: _decOut,
            amountIn: _amountIn,
            maxDeviationBps: _bps,
            maxFeedAgeSeconds: _maxAge
        });
    }

    function _run(uint256 _amountIn, uint8 _decOut, uint16 _bps, uint64 _maxAge) internal {
        bytes memory payload = _instructionWithConditions(
            account,
            0,
            _swapCalls(_amountIn),
            _conditions(_pcFtsoRate(address(usd), account, _bound(_amountIn, _decOut, _bps, _maxAge)))
        );
        vm.prank(executor);
        controller.execute(
            _proof(TX_ID, abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(payload))),
            payload
        );
    }

    // --- decimal combinations -------------------------------------------------------------

    /// @dev XRP at $1.479808 (6 feed decimals), USDT at $0.999748 (6), both tokens 6 decimals.
    ///      Fair out for 100 XRP is ~100.0374 USD.
    function test_sixDecimalTokensSixDecimalFeeds() public {
        _deploy(6, 1_480_180); // ~fair
        _setFeeds(1_479_808, 6, 999_748, 6);
        _run(100_000_000, 6, 100, 300);
        assertGt(usd.balanceOf(account), 0);
    }

    /// @dev The mainnet case: USDT/USD reports 5 decimals there, not 6.
    function test_theSameTradeWithMainnetFeedDecimals() public {
        _deploy(6, 1_480_180);
        _setFeeds(1_479_808, 6, 99_989, 5);
        _run(100_000_000, 6, 100, 300);
        assertGt(usd.balanceOf(account), 0);
    }

    /// @dev 6-decimal input, 18-decimal output: the combination that appears whenever FXRP is
    ///      swapped for WFLR or WETH.
    function test_sixInEighteenOut() public {
        // 1 FXRP -> ~1.4801e18 out
        _deploy(18, 1_480_180_000_000_000_000);
        _setFeeds(1_479_808, 6, 999_748, 6);
        _run(100_000_000, 18, 100, 300);
        assertGt(usd.balanceOf(account), 1e18);
    }

    /// @dev 18-decimal input against an 8-decimal feed (FLR/USD) and a 2-decimal one (BTC/USD):
    ///      the widest spread between feed decimals on a live network.
    function test_eighteenInTwoDecimalFeedOut() public {
        _deploy(8, 0);
        ftso.setFeed(FEED_IN, 68_193_800, 8, uint64(block.timestamp)); // FLR/USD, 8 dp
        ftso.setFeed(FEED_OUT, 8_448_487, 2, uint64(block.timestamp)); // BTC/USD, 2 dp

        // 1000 FLR at $0.681938 -> $681.938; at $84,484.87/BTC that is ~0.00807 BTC.
        uint256 fairOut = 807_178; // 8 decimals
        _deployVenueWithExactOut(8, fairOut);

        bytes memory payload = _instructionWithConditions(
            account,
            0,
            _swapCalls(1_000_000), // amountIn is fxrp (6dp) here; decimalsIn below says so
            _conditions(
                _pcFtsoRate(
                    address(usd),
                    account,
                    IPostConditions.FtsoBound({
                        feedIdIn: FEED_IN,
                        feedIdOut: FEED_OUT,
                        decimalsIn: 6,
                        decimalsOut: 8,
                        amountIn: 1_000_000,
                        maxDeviationBps: 200,
                        maxFeedAgeSeconds: 300
                    })
                )
            )
        );
        vm.prank(executor);
        controller.execute(
            _proof(TX_ID, abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(payload))),
            payload
        );
        assertGt(usd.balanceOf(account), 0);
    }

    function _deployVenueWithExactOut(uint8 _decOut, uint256 _outPerWholeIn) private {
        usd = new MockERC20("Test out", "tOUT", _decOut);
        venue = new FixedRateSwap(fxrp, usd, _outPerWholeIn);
    }

    // --- the bound itself --------------------------------------------------------------------

    function test_aFillJustInsideTheBoundPasses() public {
        _deploy(6, 1_465_378); // ~1% below fair
        _setFeeds(1_479_808, 6, 999_748, 6);
        _run(100_000_000, 6, 120, 300); // 1.2% tolerance
        assertGt(usd.balanceOf(account), 0);
    }

    function test_aFillJustOutsideTheBoundReverts() public {
        _deploy(6, 1_420_000); // ~4% below fair
        _setFeeds(1_479_808, 6, 999_748, 6);
        vm.expectRevert();
        _run(100_000_000, 6, 100, 300); // 1% tolerance
    }

    /// @dev One-sided by design: a fill better than the oracle is not the user's problem.
    function test_aFillBetterThanTheOracleIsAccepted() public {
        _deploy(6, 2_000_000); // ~35% above fair
        _setFeeds(1_479_808, 6, 999_748, 6);
        _run(100_000_000, 6, 1, 300); // 0.01% tolerance, still fine
        assertGt(usd.balanceOf(account), 0);
    }

    function test_zeroDeviationDemandsAtLeastTheOracleRate() public {
        _setFeeds(1_479_808, 6, 999_748, 6);

        _deploy(6, 1_480_180); // a hair above fair
        _run(100_000_000, 6, 0, 300);
        assertGt(usd.balanceOf(account), 0);
    }

    // --- feed health ---------------------------------------------------------------------------

    function test_aStaleFeedReverts() public {
        _deploy(6, 1_480_180);
        _setFeeds(1_479_808, 6, 999_748, 6);
        vm.warp(block.timestamp + 301);
        vm.expectRevert();
        _run(100_000_000, 6, 100, 300);
    }

    function test_afeedInsideTheAgeWindowIsAccepted() public {
        _deploy(6, 1_480_180);
        _setFeeds(1_479_808, 6, 999_748, 6);
        vm.warp(block.timestamp + 299);
        _run(100_000_000, 6, 100, 300);
        assertGt(usd.balanceOf(account), 0);
    }

    function test_aZeroPriceReverts() public {
        _deploy(6, 1_480_180);
        _setFeeds(0, 6, 999_748, 6);
        vm.expectRevert(
            abi.encodeWithSelector(IPostConditions.FeedPriceZero.selector, 0, FEED_IN)
        );
        _run(100_000_000, 6, 100, 300);
    }

    /// @dev Negative feed decimals are refused rather than guessed at. No live feed reports
    ///      them today, but the interface returns `int8` and a wrong guess would misprice by
    ///      orders of magnitude.
    function test_negativeFeedDecimalsAreRefused() public {
        _deploy(6, 1_480_180);
        _setFeeds(1_479_808, -1, 999_748, 6);
        vm.expectRevert(
            abi.encodeWithSelector(IPostConditions.FeedDecimalsNegative.selector, 0, FEED_IN, int8(-1))
        );
        _run(100_000_000, 6, 100, 300);
    }

    // --- composition with the absolute floor ------------------------------------------------

    /**
     * @dev The two protections catch different things, which is why both exist.
     *
     *      Here the market itself has moved: the oracle AND the pool both say XRP is worth 30%
     *      less than when the user signed. The FTSO bound is satisfied -- the fill matches the
     *      oracle -- because the oracle moved too. Only the absolute floor, committed at signing
     *      time, catches it. That is the ~150 s exposure the user accepts, and it is exactly
     *      what `Erc20DeltaAtLeast` is for.
     */
    function test_ftsoBoundAloneDoesNotCatchGenuineMarketMovement() public {
        _deploy(6, 1_036_000); // pool moved down 30%
        _setFeeds(1_035_866, 6, 999_748, 6); // and so did the oracle

        // FTSO bound alone: passes, because the fill is fair at the new price.
        _run(100_000_000, 6, 100, 300);
        assertGt(usd.balanceOf(account), 0);
    }

    function test_theAbsoluteFloorCatchesWhatTheOracleBoundCannot() public {
        _deploy(6, 1_036_000);
        _setFeeds(1_035_866, 6, 999_748, 6);

        bytes memory payload = _instructionWithConditions(
            account,
            0,
            _swapCalls(100_000_000),
            _conditions(
                _pcFtsoRate(address(usd), account, _bound(100_000_000, 6, 100, 300)),
                _pcErc20Delta(address(usd), account, 140_000_000) // signed when XRP was ~$1.48
            )
        );
        vm.prank(executor);
        vm.expectRevert();
        controller.execute(
            _proof(TX_ID, abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(payload))),
            payload
        );
    }

    /**
     * @dev And the mirror: the pool is manipulated but the oracle is not. The absolute floor
     *      was set generously (the user only wanted protection from a catastrophic fill), so it
     *      passes. The FTSO bound is what catches the sandwich.
     */
    function test_theOracleBoundCatchesWhatTheAbsoluteFloorLetsThrough() public {
        _deploy(6, 1_100_000); // pool manipulated ~26% below fair
        _setFeeds(1_479_808, 6, 999_748, 6); // oracle unmoved

        // Floor alone at 100 USD: satisfied by the manipulated fill of ~110 USD.
        bytes memory floorOnly = _instructionWithConditions(
            account, 0, _swapCalls(100_000_000), _conditions(_pcErc20Delta(address(usd), account, 100_000_000))
        );
        vm.prank(executor);
        controller.execute(
            _proof(TX_ID, abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(floorOnly))),
            floorOnly
        );
        assertGt(usd.balanceOf(account), 0, "the loose floor let it through");

        // The same fill with an oracle bound would have been refused.
        bytes32 tx2 = bytes32(uint256(0xf8));
        bytes memory bounded = _instructionWithConditions(
            account, 1, _swapCalls(100_000_000), _conditions(_pcFtsoRate(address(usd), account, _bound(100_000_000, 6, 100, 300)))
        );
        vm.prank(executor);
        vm.expectRevert();
        controller.execute(
            _proof(tx2, abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(bounded))),
            bounded
        );
    }
}
