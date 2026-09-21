// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IXRPPayment} from "flare-periphery/coston2/IXRPPayment.sol";

import {ForkBase} from "./ForkBase.t.sol";
import {IUniversalRouter, IQuoterV2} from "./ForkInterfaces.sol";
import {MemoCodec} from "../../contracts/libraries/MemoCodec.sol";
import {Execution} from "../../contracts/libraries/Execution.sol";
import {IMemoController} from "../../contracts/interfaces/IMemoController.sol";
import {IPersonalAccount} from "../../contracts/interfaces/IPersonalAccount.sol";

/**
 * @title SparkDexForkTest
 * @notice An FXRP -> USDT0 swap through SparkDEX V3's UniversalRouter, driven by one memokit
 *         instruction, on a fork of Flare mainnet. Verification is simulated; see `ForkBase`.
 *
 * @dev The instruction is two calls: move the input to the router, then `execute` a
 *      V3_SWAP_EXACT_IN with `payerIsUser = false` so the router spends what it was just sent and no
 *      Permit2 signature is involved (an account cannot sign). `amountOutMinimum` and `deadline` are
 *      arguments of those calls, so they sit inside the committed payload: an executor who reads the
 *      preimage still cannot loosen either.
 *
 *      Everything is in one transaction, so a swap that fails unwinds the transfer too: nothing is
 *      ever left in the router. The instruction stays unconsumed and the nonce unmoved -- see the
 *      recovery tests for what that means for the queue behind it.
 */
contract SparkDexForkTest is ForkBase {
    IUniversalRouter internal constant ROUTER = IUniversalRouter(0x0f3D8a38D4c74afBebc2c42695642f0e3acb15D3);
    IQuoterV2 internal constant QUOTER = IQuoterV2(0x5B5513c55fd06e2658010c121c37b07fC8e8B705);
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    /// @dev The deepest FXRP pool at the pinned block: FXRP/USDT0, 0.05% (liquidity ~5.4e11).
    uint24 internal constant POOL_FEE = 500;

    /// UniversalRouter command and sentinel recipients (Uniswap's, unchanged in SparkDEX's fork).
    bytes1 internal constant V3_SWAP_EXACT_IN = 0x00;
    address internal constant MSG_SENDER = address(1);

    /// @dev The reference deadline. Measured latency is 118-162 s; one missed 90 s FDC round on
    ///      top of the worst is 252 s; 900 s is ~3.5x that. Same constant as the SDK's
    ///      DEFAULT_DEADLINE_SECONDS, restated so a test fails if the two are ever meant to differ.
    uint256 internal constant DEADLINE_SECONDS = 900;
    /// @dev Tolerated slippage against the quote taken when the instruction is written.
    uint256 internal constant SLIPPAGE_BPS = 50; // 0.5%

    uint256 internal constant AMOUNT_IN = 1_000e6; // 1,000 FXRP
    uint256 internal constant FEE = 100_000; // 0.1 FXRP, paid to the executor in the moved asset

    address internal trader = makeAddr("trader");

    function setUp() public override {
        super.setUp();
        _fundFxrp(account, AMOUNT_IN + FEE);
    }

    // --- building the instruction ---------------------------------------------------------

    function _path() internal pure returns (bytes memory) {
        return abi.encodePacked(FXRP, POOL_FEE, USDT0);
    }

    function _quote(uint256 _amountIn) internal returns (uint256 out) {
        (out,,,) = QUOTER.quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: FXRP, tokenOut: USDT0, amountIn: _amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0
            })
        );
    }

    function _swapCalls(uint256 _amountIn, uint256 _minOut, uint256 _deadline)
        internal
        pure
        returns (IPersonalAccount.Call[] memory calls)
    {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(MSG_SENDER, _amountIn, _minOut, _path(), false);

        calls = new IPersonalAccount.Call[](2);
        calls[0] = _call(FXRP, abi.encodeCall(IERC20.transfer, (address(ROUTER), _amountIn)));
        calls[1] = _call(address(ROUTER), abi.encodeCall(IUniversalRouter.execute, (abi.encodePacked(V3_SWAP_EXACT_IN), inputs, _deadline)));
    }

    /// @return payload The instruction, quoted now, with a 0.5% floor and a 900 s deadline.
    /// @return minOut  The committed floor.
    function _swapPayload(uint256 _nonce) internal returns (bytes memory payload, uint256 minOut, uint256 deadline) {
        minOut = _quote(AMOUNT_IN) * (10_000 - SLIPPAGE_BPS) / 10_000;
        deadline = block.timestamp + DEADLINE_SECONDS;
        payload = _instructionWithFee(account, _nonce, FXRP, FEE, _swapCalls(AMOUNT_IN, minOut, deadline));
    }

    // --- moving the market ----------------------------------------------------------------

    /// @dev Sells FXRP into the pool as `trader` until the same swap would return less than `_minOut`.
    function _movePriceBelow(uint256 _minOut) internal returns (uint256 dumped) {
        uint256 chunk = 5_000e6;
        for (uint256 i = 0; i < 40 && _quote(AMOUNT_IN) >= _minOut; ++i) {
            _fundFxrp(trader, chunk);
            vm.startPrank(trader);
            IERC20(FXRP).transfer(address(ROUTER), chunk);
            bytes[] memory inputs = new bytes[](1);
            inputs[0] = abi.encode(trader, chunk, uint256(0), _path(), false);
            ROUTER.execute(abi.encodePacked(V3_SWAP_EXACT_IN), inputs, block.timestamp + 60);
            vm.stopPrank();
            dumped += chunk;
            chunk *= 2;
        }
        require(_quote(AMOUNT_IN) < _minOut, "could not move the price past the minimum");
    }

    // --- the integration ------------------------------------------------------------------

    function test_swapExecutesWithinTheCommittedMinimum() public {
        (bytes memory payload, uint256 minOut,) = _swapPayload(0);
        uint256 quoted = _quote(AMOUNT_IN);
        uint256 gasBefore = gasleft();
        _deliver(payload);
        emit log_named_uint("gas: successful swap instruction", gasBefore - gasleft());

        uint256 received = IERC20(USDT0).balanceOf(account);
        emit log_named_uint("quoted USDT0 out", quoted);
        emit log_named_uint("committed minimum", minOut);
        emit log_named_uint("received USDT0", received);

        assertGe(received, minOut, "at least the committed minimum");
        assertEq(received, quoted, "the pool did not move between quote and swap");
        assertEq(IERC20(FXRP).balanceOf(account), 0, "spent exactly the input and the fee");
        assertEq(IERC20(FXRP).balanceOf(executor), FEE, "executor paid in the moved asset");
        assertEq(IERC20(FXRP).balanceOf(address(ROUTER)), 0, "router holds none of the input");
        assertEq(IERC20(USDT0).balanceOf(address(ROUTER)), 0, "router holds none of the output");
        assertEq(controller.nonceOf(account), 1);
    }

    /// @dev The deadline must outlive the whole path, or the instruction is dead on arrival. Latency
    ///      at its measured worst (162 s) plus one missed FDC round (90 s) leaves ~650 s of margin.
    function test_deadlineSurvivesTheWorstMeasuredLatencyPlusAMissedRound() public {
        (bytes memory payload, uint256 minOut, uint256 deadline) = _swapPayload(0);
        vm.warp(block.timestamp + 162 + 90);
        assertLt(block.timestamp, deadline);
        _deliver(payload);
        assertGe(IERC20(USDT0).balanceOf(account), minOut);
        emit log_named_uint("margin left at 252 s (seconds)", deadline - block.timestamp);
    }

    // --- the price moves ------------------------------------------------------------------

    function test_priceMovingPastTheMinimumRevertsTheSwapCleanly() public {
        (bytes memory payload, uint256 minOut,) = _swapPayload(0);
        (bytes32 txId, IXRPPayment.Proof memory proof) = _prepare(payload);

        uint256 dumped = _movePriceBelow(minOut);
        emit log_named_uint("FXRP sold into the pool to move the price past the minimum (base units)", dumped);
        emit log_named_uint("swap would now return", _quote(AMOUNT_IN));

        uint256 gasBefore = gasleft();
        (uint256 callIndex, bytes memory reason) = _failureOf(proof, payload);
        emit log_named_uint("gas: reverted swap instruction", gasBefore - gasleft());
        emit log_named_uint("failing call index", callIndex);
        emit log_named_bytes("router's reason", reason);

        assertEq(callIndex, 1, "the swap, not the transfer to the router");
        assertEq(bytes4(reason), bytes4(keccak256("V3TooLittleReceived()")), "the router refused it on amountOutMinimum");

        // Clean: nothing consumed, nothing moved, nothing stranded.
        assertFalse(controller.isXrplTransactionConsumed(txId), "not consumed");
        assertEq(controller.nonceOf(account), 0, "nonce unchanged");
        assertEq(IERC20(FXRP).balanceOf(account), AMOUNT_IN + FEE, "the account still holds everything");
        assertEq(IERC20(FXRP).balanceOf(address(ROUTER)), 0, "the transfer to the router was unwound");
        assertEq(IERC20(FXRP).balanceOf(executor), 0, "no fee paid for a failure");
    }

    function test_anExpiredDeadlineRevertsCleanly() public {
        (bytes memory payload,, uint256 deadline) = _swapPayload(0);
        (bytes32 txId, IXRPPayment.Proof memory proof) = _prepare(payload);

        vm.warp(deadline + 1);
        (uint256 callIndex, bytes memory reason) = _failureOf(proof, payload);
        emit log_named_bytes("router's reason", reason);

        assertEq(callIndex, 1);
        assertEq(bytes4(reason), bytes4(keccak256("TransactionDeadlinePassed()")));
        assertFalse(controller.isXrplTransactionConsumed(txId));
        assertEq(IERC20(FXRP).balanceOf(account), AMOUNT_IN + FEE);
        assertEq(IERC20(FXRP).balanceOf(address(ROUTER)), 0);
    }

    /// @dev The executor sees the preimage and wants the swap to go through at any price (say, to
    ///      collect a fee on an instruction that would otherwise fail). It cannot: the floor is in
    ///      the hashed payload, so a payload with the floor removed does not match the memo.
    function test_anExecutorCannotLoosenTheCommittedFloor() public {
        (bytes memory honest, uint256 minOut, uint256 deadline) = _swapPayload(0);
        (, IXRPPayment.Proof memory proof) = _prepare(honest);
        _movePriceBelow(minOut);

        bytes memory tampered = _instructionWithFee(account, 0, FXRP, FEE, _swapCalls(AMOUNT_IN, 0, deadline));

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(IMemoController.CommitmentMismatch.selector, keccak256(honest), keccak256(tampered))
        );
        controller.execute(proof, tampered);
        assertEq(IERC20(USDT0).balanceOf(account), 0, "nothing swapped at the worse price");
    }

    // --- recovery: what "stuck" means and what gets it moving ------------------------------
    //
    // A failing instruction is NOT consumed: it reverts, so its transaction id stays unused and the
    // nonce stays put. What is stuck is the QUEUE: the account's nonce is now waiting for an
    // instruction that will not run again (its price is gone; its deadline is passing), and every
    // later instruction is refused until the nonce moves.

    function _stuckSwap() internal returns (bytes32 txId, IXRPPayment.Proof memory proof, bytes memory payload) {
        uint256 minOut;
        (payload, minOut,) = _swapPayload(0);
        (txId, proof) = _prepare(payload);
        _movePriceBelow(minOut);
        _failureOf(proof, payload);
    }

    function _laterInstruction(uint256 _nonce) internal returns (bytes memory) {
        // Something trivial and unrelated: pay the executor's fee-free transfer of 1 FXRP.
        return _instruction(
            account, _nonce, _oneCall(FXRP, 0, abi.encodeCall(IERC20.transfer, (makeAddr("payee"), 1e6)))
        );
    }

    function test_theQueueIsBlockedBehindTheStuckInstruction() public {
        _stuckSwap();
        bytes memory later = _laterInstruction(1);
        (, IXRPPayment.Proof memory proof) = _prepare(later);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Execution.InvalidNonce.selector, 0, 1));
        controller.execute(proof, later);
    }

    /// @dev 0xE1 skips the stuck slot. The old instruction can then never run, even if the price returns.
    function test_setNonceUnsticksTheQueue() public {
        (, IXRPPayment.Proof memory oldProof, bytes memory oldPayload) = _stuckSwap();

        _deliverMemo(abi.encodePacked(_header(MemoCodec.OP_SET_NONCE, 1, uint64(0)), bytes32(uint256(1))));
        assertEq(controller.nonceOf(account), 1, "moved past the stuck instruction");

        bytes memory later = _laterInstruction(1);
        _deliver(later);
        assertEq(controller.nonceOf(account), 2, "the queue is moving again");

        // The stuck swap is dead for good: its nonce is behind the account now.
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Execution.InvalidNonce.selector, 2, 0));
        controller.execute(oldProof, oldPayload);
    }

    /// @dev No opcode needed when the owner just wants to try again: a new instruction at the SAME
    ///      nonce is valid because the failed one never spent it. It supersedes the stuck one.
    function test_aFreshInstructionAtTheSameNonceSupersedesTheStuckOne() public {
        (, IXRPPayment.Proof memory oldProof, bytes memory oldPayload) = _stuckSwap();

        // Re-quote at today's (moved) price, accept it, new deadline, same nonce 0.
        (bytes memory fresh, uint256 minOut,) = _swapPayload(0);
        _deliver(fresh);
        assertGe(IERC20(USDT0).balanceOf(account), minOut, "the re-issued swap executed");
        assertEq(controller.nonceOf(account), 1);

        // And the original can no longer run.
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Execution.InvalidNonce.selector, 1, 0));
        controller.execute(oldProof, oldPayload);
    }

    /// @dev 0xE0 retires a transaction id without running its memo. Here it is NOT enough on its
    ///      own: the stuck instruction is retired but its nonce slot is still open, so the queue
    ///      stays blocked until 0xE1 (or a same-nonce re-issue). E0's job is the memo that cannot be
    ///      parsed at all (Recovery.t.sol); this pins that it does not advance the nonce.
    function test_ignoreRetiresTheStuckInstructionButDoesNotMoveTheNonce() public {
        (bytes32 txId, IXRPPayment.Proof memory oldProof, bytes memory oldPayload) = _stuckSwap();

        _deliverMemo(abi.encodePacked(_header(MemoCodec.OP_IGNORE, 1, uint64(0)), txId));
        assertTrue(controller.isIgnored(account, txId));

        // Submitting the stuck instruction again now retires it instead of reverting or swapping.
        vm.expectEmit(true, true, false, false, address(diamond));
        emit IMemoController.InstructionIgnored(account, txId);
        vm.prank(executor);
        controller.execute(oldProof, oldPayload);

        assertTrue(controller.isXrplTransactionConsumed(txId), "retired");
        assertEq(controller.nonceOf(account), 0, "but the nonce did not move");
        assertEq(IERC20(USDT0).balanceOf(account), 0, "and no swap ran");
        assertEq(IERC20(FXRP).balanceOf(account), AMOUNT_IN + FEE);
    }
}
