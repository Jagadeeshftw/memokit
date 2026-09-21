// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IXRPPayment} from "flare-periphery/coston2/IXRPPayment.sol";

import {ForkBase} from "./ForkBase.t.sol";
import {IKComptroller, IKToken} from "./ForkInterfaces.sol";
import {IPersonalAccount} from "../../contracts/interfaces/IPersonalAccount.sol";
import {IPostConditions} from "../../contracts/interfaces/IPostConditions.sol";
import {IMemoController} from "../../contracts/interfaces/IMemoController.sol";

/**
 * @title KineticForkTest
 * @notice Deposit collateral and borrow a stablecoin in ONE instruction, on Kinetic (Flare's
 *         Compound-v2-style lending market), on a fork of Flare mainnet. Verification is simulated;
 *         see `ForkBase`.
 *
 * @dev FXRP is not a Kinetic market (`test_fxrpIsNotAKineticMarket` records the seven that are),
 *      so this uses the most liquid collateral: sFLR, ~$5.0M supplied against ~$4.9M cash and a 0.71
 *      collateral factor at the pinned block. The stablecoin is USDT0, the deepest on offer (~$450k
 *      cash; USDC.e ~$180k). See PHASE2.md for the table.
 */
contract KineticForkTest is ForkBase {
    IKComptroller internal constant COMPTROLLER = IKComptroller(0x8041680Fb73E1Fe5F851e76233DCDfA0f2D2D7c8);
    IKToken internal constant K_SFLR = IKToken(0x291487beC339c2fE5D83DD45F0a15EFC9Ac45656);
    IKToken internal constant K_USDT0 = IKToken(0x76809aBd690B77488Ffb5277e0a8300a7e77B779);
    address internal constant SFLR = 0x12e605bc104e93B45e1aD99F9e555f659051c2BB;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;

    uint256 internal constant COLLATERAL = 200_000e18; // ~$2.5k of sFLR
    uint256 internal constant FEE = 100e18; // executor fee, in the asset the instruction moves
    uint256 internal constant BORROW = 1_000e6; // 1,000 USDT0, well inside capacity
    uint256 internal constant TOO_MUCH = 5_000e6; // far beyond what $2.5k of collateral supports

    function setUp() public override {
        super.setUp();
        deal(SFLR, account, COLLATERAL + FEE);
    }

    /// @dev approve -> mint -> enterMarkets -> borrow. Four calls, always the same four: what
    ///      the instruction is *for* is now stated separately, as a post-condition.
    function _borrowCalls(uint256 _borrow)
        internal
        view
        returns (IPersonalAccount.Call[] memory calls)
    {
        calls = new IPersonalAccount.Call[](4);
        calls[0] = _call(SFLR, abi.encodeCall(IERC20.approve, (address(K_SFLR), COLLATERAL)));
        calls[1] = _call(address(K_SFLR), abi.encodeCall(IKToken.mint, (COLLATERAL)));
        address[] memory enter = new address[](1);
        enter[0] = address(K_SFLR);
        calls[2] = _call(address(COMPTROLLER), abi.encodeCall(IKComptroller.enterMarkets, (enter)));
        calls[3] = _call(address(K_USDT0), abi.encodeCall(IKToken.borrow, (_borrow)));
    }

    /**
     * @dev Phase 2 asserted the borrow landed by appending a USDT0 self-transfer: a trick that
     *      reverts unless the account really holds the amount. It worked, but it cost a call, it
     *      only expressed one shape of claim, and reading the instruction gave no hint that the
     *      fifth call was an assertion rather than part of the operation.
     *
     *      A post-condition says the same thing directly, costs no call, and names the failure
     *      when it fires.
     */
    function _instructionFor(uint256 _borrow, bool _withAssertion) internal view returns (bytes memory) {
        IPostConditions.PostCondition[] memory conditions = _withAssertion
            ? _conditions(_pcErc20Delta(USDT0, account, _borrow))
            : new IPostConditions.PostCondition[](0);

        return _instructionWith(account, 0, SFLR, FEE, _borrowCalls(_borrow), conditions);
    }

    // --- what is on chain ----------------------------------------------------------------

    /// @dev The question the brief asked. Answer at the pinned block: no.
    function test_fxrpIsNotAKineticMarket() public {
        address[] memory markets = COMPTROLLER.getAllMarkets();
        assertEq(markets.length, 7, "Kinetic lists seven markets");
        bool found;
        for (uint256 i = 0; i < markets.length; ++i) {
            IKToken k = IKToken(markets[i]);
            address underlying;
            // kFLR is the native market and has no `underlying()`.
            try k.underlying() returns (address u) {
                underlying = u;
            } catch {}
            emit log_named_string(k.symbol(), vm.toString(underlying));
            if (underlying == FXRP) found = true;
        }
        assertFalse(found, "FXRP is not a Kinetic market");
    }

    // --- the integration -----------------------------------------------------------------

    function test_depositCollateralAndBorrowAStablecoinInOneInstruction() public {
        uint256 executorBefore = IERC20(SFLR).balanceOf(executor);
        uint256 gasBefore = gasleft();
        _deliver(_instructionFor(BORROW, true));
        emit log_named_uint("gas: execute (deposit + enter + borrow + post-condition + fee)", gasBefore - gasleft());

        // kToken balance: what `mint` credits is amount * 1e18 / exchangeRate, rounded down.
        uint256 kBalance = K_SFLR.balanceOf(account);
        assertGt(kBalance, 0, "holds kSFLR");
        uint256 underlyingValue = kBalance * K_SFLR.exchangeRateStored() / 1e18;
        assertApproxEqAbs(underlyingValue, COLLATERAL, 1e9, "kSFLR is worth the collateral deposited");

        // Borrow balance and the borrowed asset itself.
        assertEq(K_USDT0.borrowBalanceStored(account), BORROW, "owes exactly the borrow");
        assertEq(IERC20(USDT0).balanceOf(account), BORROW, "holds the borrowed USDT0");

        // The account is collateralised and inside its limit.
        assertTrue(COMPTROLLER.checkMembership(account, address(K_SFLR)), "collateral is enabled");
        (uint256 err, uint256 liquidity, uint256 shortfall) = COMPTROLLER.getAccountLiquidity(account);
        assertEq(err, 0);
        assertEq(shortfall, 0, "no shortfall");
        assertGt(liquidity, 0, "borrowing headroom remains");

        // The fee was paid in sFLR, the asset the instruction moved -- the account holds no FLR.
        assertEq(IERC20(SFLR).balanceOf(executor) - executorBefore, FEE, "executor paid in the moved asset");
        assertEq(IERC20(SFLR).balanceOf(account), 0, "no sFLR left over");
        assertEq(controller.nonceOf(account), 1);
    }

    // --- the interface surprise: soft failure ---------------------------------------------

    /// @dev Kinetic answers an over-large borrow with an error code, so the CALL SUCCEEDS. Without
    ///      an assertion memokit sees five successful calls, consumes the transaction id, advances
    ///      the nonce -- and the user has deposited collateral and borrowed nothing.
    function test_kineticRefusesAnOversizedBorrowWithACodeNotARevert() public {
        // Ask the market directly what it says, from the account's own context.
        vm.startPrank(account);
        IERC20(SFLR).approve(address(K_SFLR), COLLATERAL);
        assertEq(K_SFLR.mint(COLLATERAL), 0, "mint ok");
        address[] memory enter = new address[](1);
        enter[0] = address(K_SFLR);
        COMPTROLLER.enterMarkets(enter);
        uint256 code = K_USDT0.borrow(TOO_MUCH); // does not revert
        vm.stopPrank();
        emit log_named_uint("Kinetic borrow() return code for an over-limit borrow", code);
        assertGt(code, 0, "an error code, and no revert");
        assertEq(K_USDT0.borrowBalanceStored(account), 0);
    }

    function test_withoutAnAssertionAFailedBorrowIsConsumedAsSuccess() public {
        bytes32 txId = _deliver(_instructionFor(TOO_MUCH, false));

        assertTrue(controller.isXrplTransactionConsumed(txId), "the instruction is spent");
        assertEq(controller.nonceOf(account), 1, "and the nonce moved on");
        assertGt(K_SFLR.balanceOf(account), 0, "the collateral was deposited");
        assertEq(K_USDT0.borrowBalanceStored(account), 0, "but nothing was borrowed");
        assertEq(IERC20(USDT0).balanceOf(account), 0);
    }

    function test_withTheAssertionTheSameFailureUnwindsEverything() public {
        bytes memory payload = _instructionFor(TOO_MUCH, true);
        bytes32 txId = _nextTxId();
        IXRPPayment.Proof memory proof = _sdkProof(txId, _commitMemo(payload), block.timestamp - SIMULATED_LATENCY);

        vm.prank(executor);
        // The post-condition names the failure precisely: index 0, the USDT0 delta, wanted
        // TOO_MUCH and got nothing. Compare with Phase 2's opaque `CallFailed(4, ...)`.
        vm.expectRevert(
            abi.encodeWithSelector(
                IPostConditions.PostConditionFailed.selector,
                0,
                IPostConditions.Kind.Erc20DeltaAtLeast,
                TOO_MUCH,
                0
            )
        );
        controller.execute(proof, payload);

        assertFalse(controller.isXrplTransactionConsumed(txId), "not consumed: the proof stays usable");
        assertEq(controller.nonceOf(account), 0, "nonce unchanged");
        assertEq(K_SFLR.balanceOf(account), 0, "the deposit was unwound with it");
        assertEq(IERC20(SFLR).balanceOf(account), COLLATERAL + FEE, "collateral still in the account");
    }
}
