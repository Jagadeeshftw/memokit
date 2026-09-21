// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MemoKitTestBase} from "./base/MemoKitTestBase.sol";
import {MemoCodec} from "../contracts/libraries/MemoCodec.sol";
import {Execution} from "../contracts/libraries/Execution.sol";
import {IMemoController} from "../contracts/interfaces/IMemoController.sol";
import {IPersonalAccount} from "../contracts/interfaces/IPersonalAccount.sol";

/**
 * @title RecoveryTest
 * @notice The three recovery opcodes, and the ordering they depend on.
 *
 * @dev XRPL payments are irreversible. If an instruction can never execute, the account's
 *      nonce sequence is blocked behind it forever unless there is a way past. These tests
 *      pin the escape hatches, and in particular pin the rule that makes the escape hatch
 *      reachable at all: the ignore flag is consumed *before* the memo is parsed. Check it
 *      after, and a memo too malformed to parse could never be recovered from, because
 *      recovery would revert on the same bad bytes.
 */
contract RecoveryTest is MemoKitTestBase {
    bytes32 internal constant TX_BAD = bytes32(uint256(0xbad));
    bytes32 internal constant TX_FIX = bytes32(uint256(0xf11));
    bytes32 internal constant TX_NEXT = bytes32(uint256(0x2));

    address internal account;
    address internal recipient;

    function setUp() public override {
        super.setUp();
        account = _accountFor(XRPL_SENDER);
        recipient = makeAddr("recipient");
        _fund(account, 100_000_000);
    }

    function _ignoreMemo(bytes32 _target) internal pure returns (bytes memory) {
        return abi.encodePacked(_header(MemoCodec.OP_IGNORE, 1, uint64(0)), _target);
    }

    function _setNonceMemo(uint256 _newNonce) internal pure returns (bytes memory) {
        return abi.encodePacked(_header(MemoCodec.OP_SET_NONCE, 1, uint64(0)), bytes32(_newNonce));
    }

    function _replaceFeeMemo(bytes32 _target, uint64 _newFee) internal pure returns (bytes memory) {
        return abi.encodePacked(
            _header(MemoCodec.OP_REPLACE_FEE, 1, uint64(0)), _target, bytes8(_newFee)
        );
    }

    function _transferCalls(uint256 _amount) internal view returns (IPersonalAccount.Call[] memory) {
        return _oneCall(address(fxrp), 0, abi.encodeCall(IERC20.transfer, (recipient, _amount)));
    }

    // --- 0xE0, and the ordering that makes it work ---------------------------------------

    /// @dev A memo too short to even hold a header. Nothing can parse it.
    function test_ignoreRescuesAnUnparseableMemo() public {
        bytes memory garbage = hex"fd0001";

        // 1. The bad payment cannot execute: parsing fails before anything is persisted.
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(MemoCodec.MemoTooShort.selector, 3));
        controller.execute(_proof(TX_BAD, garbage), "");
        assertFalse(controller.isXrplTransactionConsumed(TX_BAD), "nothing persisted");

        // 2. A follow-up payment flags the stuck transaction id.
        vm.prank(executor);
        controller.execute(_proof(TX_FIX, _ignoreMemo(TX_BAD)), "");
        assertTrue(controller.isIgnored(account, TX_BAD), "flagged");

        // 3. Retrying the bad payment now retires it instead of reverting.
        vm.expectEmit(true, true, false, false, address(diamond));
        emit IMemoController.InstructionIgnored(account, TX_BAD);

        vm.prank(executor);
        controller.execute(_proof(TX_BAD, garbage), "");

        assertTrue(controller.isXrplTransactionConsumed(TX_BAD), "retired");
        assertFalse(controller.isIgnored(account, TX_BAD), "flag consumed");
        assertEq(controller.nonceOf(account), 0, "no instruction ran");
    }

    function test_ignoreAlsoRescuesAReservedOpcode() public {
        bytes memory reserved = abi.encodePacked(_header(0xfa, 1, uint64(0)), bytes32(0));

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(MemoCodec.ReservedOpcode.selector, uint8(0xfa)));
        controller.execute(_proof(TX_BAD, reserved), "");

        vm.prank(executor);
        controller.execute(_proof(TX_FIX, _ignoreMemo(TX_BAD)), "");

        vm.prank(executor);
        controller.execute(_proof(TX_BAD, reserved), "");
        assertTrue(controller.isXrplTransactionConsumed(TX_BAD));
    }

    function test_ignoreFlagIsScopedToOneAccountAndOneTransaction() public {
        vm.prank(executor);
        controller.execute(_proof(TX_FIX, _ignoreMemo(TX_BAD)), "");

        assertTrue(controller.isIgnored(account, TX_BAD));
        assertFalse(controller.isIgnored(account, TX_NEXT), "other txid unaffected");
        assertFalse(
            controller.isIgnored(_accountFor("rSomeoneElseXXXXXXXXXXXXXXXXXXXXXX"), TX_BAD),
            "other account unaffected"
        );
    }

    // --- 0xE1 ----------------------------------------------------------------------------

    /// @dev Stored nonce behind a stuck instruction: snapping forward releases the sequence.
    function test_setNonceUnblocksAnAheadOfStateInstruction() public {
        bytes memory payload = _instruction(account, 3, _transferCalls(1_000));
        bytes memory memo = abi.encodePacked(
            _header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(payload)
        );

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Execution.InvalidNonce.selector, 0, 3));
        controller.execute(_proof(TX_BAD, memo), payload);

        vm.prank(executor);
        controller.execute(_proof(TX_FIX, _setNonceMemo(3)), "");
        assertEq(controller.nonceOf(account), 3);

        vm.prank(executor);
        controller.execute(_proof(TX_BAD, memo), payload);
        assertEq(controller.nonceOf(account), 4, "instruction ran");
    }

    function test_setNonceMustStrictlyIncrease() public {
        vm.prank(executor);
        controller.execute(_proof(TX_FIX, _setNonceMemo(5)), "");

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Execution.InvalidNonceIncrease.selector, 5, 5));
        controller.execute(_proof(TX_NEXT, _setNonceMemo(5)), "");
    }

    /// @dev A single misconfigured payment must not be able to brick the account by jumping
    ///      the nonce out of reach.
    function test_setNonceJumpIsCappedAtUint32() public {
        uint256 tooFar = uint256(type(uint32).max) + 1;
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Execution.InvalidNonceIncrease.selector, 0, tooFar));
        controller.execute(_proof(TX_FIX, _setNonceMemo(tooFar)), "");

        vm.prank(executor);
        controller.execute(_proof(TX_NEXT, _setNonceMemo(uint256(type(uint32).max))), "");
        assertEq(controller.nonceOf(account), uint256(type(uint32).max));
    }

    // --- 0xE2 ----------------------------------------------------------------------------

    function test_replacementFeeOverridesTheMemoFeeAndIsConsumed() public {
        bytes memory payload = _instruction(account, 0, _transferCalls(1_000));
        bytes memory memo = abi.encodePacked(
            _header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(500_000)), keccak256(payload)
        );

        vm.prank(executor);
        controller.execute(_proof(TX_FIX, _replaceFeeMemo(TX_BAD, 1_000)), "");
        assertEq(controller.replacementFeeOf(account, TX_BAD), 1_000);

        vm.prank(executor);
        controller.execute(_proof(TX_BAD, memo), payload);

        assertEq(fxrp.balanceOf(executor), 1_000, "override applied, not the memo's 500000");
        assertEq(controller.replacementFeeOf(account, TX_BAD), 0, "override consumed");
    }

    /// @dev Lowering to zero is how an account with too small a balance gets unstuck.
    function test_replacementFeeCanLowerToZero() public {
        bytes memory payload = _instruction(account, 0, _transferCalls(1_000));
        bytes memory memo = abi.encodePacked(
            _header(MemoCodec.OP_EXEC_COMMIT, 1, type(uint64).max), keccak256(payload)
        );

        vm.prank(executor);
        vm.expectRevert(); // account cannot pay a uint64-max fee
        controller.execute(_proof(TX_BAD, memo), payload);

        vm.prank(executor);
        controller.execute(_proof(TX_FIX, _replaceFeeMemo(TX_BAD, 0)), "");

        vm.prank(executor);
        controller.execute(_proof(TX_BAD, memo), payload);
        assertEq(fxrp.balanceOf(executor), 0, "no fee charged");
        assertEq(controller.nonceOf(account), 1, "instruction ran");
    }

    /// @dev `execute` is permissionless, so an owner who cannot pay any executor is never
    ///      locked out -- they submit the recovery memo themselves for free.
    function test_ownerCanSelfExecuteRecoveryWithZeroFee() public {
        address self = makeAddr("accountOwnerEoa");
        vm.prank(self);
        controller.execute(_proof(TX_FIX, _ignoreMemo(TX_BAD)), "");
        assertTrue(controller.isIgnored(account, TX_BAD));
        assertEq(fxrp.balanceOf(self), 0, "no fee moved");
    }

    // --- recovery memos are themselves replay-protected ----------------------------------

    function test_recoveryMemosConsumeTheirOwnTransactionId() public {
        vm.prank(executor);
        controller.execute(_proof(TX_FIX, _ignoreMemo(TX_BAD)), "");
        assertTrue(controller.isXrplTransactionConsumed(TX_FIX));

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Execution.TransactionAlreadyUsed.selector, TX_FIX));
        controller.execute(_proof(TX_FIX, _ignoreMemo(TX_NEXT)), "");
    }
}
