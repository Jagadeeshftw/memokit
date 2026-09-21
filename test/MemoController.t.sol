// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IXRPPayment} from "flare-periphery/coston2/IXRPPayment.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MemoKitTestBase} from "./base/MemoKitTestBase.sol";
import {MemoCodec} from "../contracts/libraries/MemoCodec.sol";
import {Execution} from "../contracts/libraries/Execution.sol";
import {Proofs} from "../contracts/libraries/Proofs.sol";
import {Pause} from "../contracts/libraries/Pause.sol";
import {IMemoController} from "../contracts/interfaces/IMemoController.sol";
import {IPersonalAccount} from "../contracts/interfaces/IPersonalAccount.sol";
import {RevertingTarget} from "../contracts/mocks/RevertingTarget.sol";

/**
 * @title MemoControllerTest
 * @notice The walking skeleton, end to end in the EVM: a proven XRPL memo moves assets the
 *         account already holds into an ERC-4626 vault, with no mint anywhere in the path.
 */
contract MemoControllerTest is MemoKitTestBase {
    bytes32 internal constant TX_ID = bytes32(uint256(0xa1));
    uint256 internal constant DEPOSIT = 25_000_000; // 25 FXRP at 6 decimals

    address internal account;

    function setUp() public override {
        super.setUp();
        account = _accountFor(XRPL_SENDER);
        // Fund the account deliberately and visibly. This is the whole positioning: the
        // instruction acts on a balance that already exists.
        _fund(account, 100_000_000);
    }

    // --- the depositing path -------------------------------------------------------------

    function _depositCalls() internal view returns (IPersonalAccount.Call[] memory _calls) {
        _calls = new IPersonalAccount.Call[](2);
        _calls[0] = IPersonalAccount.Call({
            target: address(fxrp),
            value: 0,
            data: abi.encodeCall(IERC20.approve, (address(vault), DEPOSIT))
        });
        _calls[1] = IPersonalAccount.Call({
            target: address(vault),
            value: 0,
            data: abi.encodeWithSignature("deposit(uint256,address)", DEPOSIT, account)
        });
    }

    function _commitMemo(uint64 _fee, bytes memory _payload) internal pure returns (bytes memory) {
        return abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, _fee), keccak256(_payload));
    }

    function _inlineMemo(uint64 _fee, bytes memory _payload) internal pure returns (bytes memory) {
        return abi.encodePacked(_header(MemoCodec.OP_EXEC_INLINE, 1, _fee), _payload);
    }

    function test_executeCommit_depositsHeldAssetsIntoVault() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());
        uint256 supplyBefore = fxrp.totalSupply();

        vm.prank(executor);
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);

        assertEq(vault.balanceOf(account), DEPOSIT, "vault shares");
        assertEq(fxrp.balanceOf(account), 100_000_000 - DEPOSIT, "remaining balance");
        assertEq(controller.nonceOf(account), 1, "nonce advanced");
        assertTrue(controller.isXrplTransactionConsumed(TX_ID), "txid consumed");

        // No mint anywhere in the path -- the capability Flare's 0xFF/0xFE cannot reach.
        assertEq(fxrp.totalSupply(), supplyBefore, "no FXRP minted");
    }

    function test_executeInline_depositsHeldAssetsIntoVault() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());

        vm.prank(executor);
        controller.execute(_proof(TX_ID, _inlineMemo(0, payload)), "");

        assertEq(vault.balanceOf(account), DEPOSIT);
        assertEq(controller.nonceOf(account), 1);
    }

    function test_accountIsDeployedOnFirstUse() public {
        assertEq(account.code.length, 0, "not yet deployed");

        bytes memory payload = _instruction(account, 0, _depositCalls());
        vm.prank(executor);
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);

        assertGt(account.code.length, 0, "deployed");
        assertEq(accounts.accountOf(XRPL_SENDER), account, "cached");
        assertEq(IPersonalAccount(account).xrplOwner(), XRPL_SENDER, "owner recorded");
        assertEq(IPersonalAccount(account).controller(), address(diamond), "controller recorded");
    }

    function test_emitsInstructionExecuted() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());

        vm.expectEmit(true, true, false, true, address(diamond));
        emit IMemoController.InstructionExecuted(account, TX_ID, MemoCodec.OP_EXEC_COMMIT, 0, 2);

        vm.prank(executor);
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);
    }

    // --- executor fee --------------------------------------------------------------------

    function test_executorIsPaidFromHeldAssets() public {
        uint64 fee = 200_000;
        bytes memory payload = _instruction(account, 0, _depositCalls());

        vm.prank(executor);
        controller.execute(_proof(TX_ID, _commitMemo(fee, payload)), payload);

        assertEq(fxrp.balanceOf(executor), fee, "executor paid");
        assertEq(fxrp.balanceOf(account), 100_000_000 - DEPOSIT - fee, "account debited");
    }

    function test_revertsWhenFeeRequestedButNoFeeToken() public {
        vm.startPrank(owner);
        admin.setFeeToken(address(0)); // schedule
        vm.warp(block.timestamp + TIMELOCK_SECONDS);
        admin.setFeeToken(address(0)); // execute
        vm.stopPrank();

        bytes memory payload = _instruction(account, 0, _depositCalls());
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(IMemoController.FeeTokenNotSet.selector, uint64(1)));
        controller.execute(_proof(TX_ID, _commitMemo(1, payload)), payload);
    }

    // --- proof validation ------------------------------------------------------------------

    function test_revertsOnWrongSourceId() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());
        ProofOverrides memory o = _defaults();
        o.sourceId = bytes32("XRP");

        vm.expectRevert(
            abi.encodeWithSelector(Proofs.InvalidSourceId.selector, SOURCE_ID, bytes32("XRP"))
        );
        controller.execute(_proofWith(TX_ID, _commitMemo(0, payload), o), payload);
    }

    function test_revertsOnUnsuccessfulTransaction() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());
        ProofOverrides memory o = _defaults();
        o.status = 1;

        vm.expectRevert(abi.encodeWithSelector(Proofs.UnsuccessfulTransaction.selector, uint8(1)));
        controller.execute(_proofWith(TX_ID, _commitMemo(0, payload), o), payload);
    }

    function test_revertsOnExpiredProof() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());
        ProofOverrides memory o = _defaults();
        o.blockTimestamp = uint64(block.timestamp);

        vm.warp(block.timestamp + VALIDITY_SECONDS + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                Proofs.ProofExpired.selector, o.blockTimestamp, o.blockTimestamp + VALIDITY_SECONDS
            )
        );
        controller.execute(_proofWith(TX_ID, _commitMemo(0, payload), o), payload);
    }

    /// @dev Flare forbids destination tags by convention because buying the tag upstream
    ///      enables front-running. XRPPayment carries the flag, so we assert it on chain.
    function test_revertsOnDestinationTag() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());
        ProofOverrides memory o = _defaults();
        o.hasDestinationTag = true;
        o.destinationTag = 7;

        vm.expectRevert(abi.encodeWithSelector(Proofs.DestinationTagNotAllowed.selector, uint256(7)));
        controller.execute(_proofWith(TX_ID, _commitMemo(0, payload), o), payload);
    }

    function test_revertsOnUnregisteredReceivingAddress() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());
        ProofOverrides memory o = _defaults();
        o.receivingAddress = "rSomeoneElsesWalletAddressXXXXXXXXX";

        vm.expectRevert(
            abi.encodeWithSelector(
                Proofs.ReceivingAddressNotRegistered.selector, keccak256(bytes(o.receivingAddress))
            )
        );
        controller.execute(_proofWith(TX_ID, _commitMemo(0, payload), o), payload);
    }

    function test_revertsWhenSourceAddressDoesNotMatchItsHash() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());
        ProofOverrides memory o = _defaults();
        o.useSourceAddressHashOverride = true;
        o.sourceAddressHashOverride = keccak256("someone else");

        vm.expectRevert(
            abi.encodeWithSelector(
                Proofs.SourceAddressMismatch.selector,
                keccak256("someone else"),
                keccak256(bytes(XRPL_SENDER))
            )
        );
        controller.execute(_proofWith(TX_ID, _commitMemo(0, payload), o), payload);
    }

    function test_revertsWhenNoMemo() public {
        ProofOverrides memory o = _defaults();
        o.hasMemoData = false;

        vm.expectRevert(Proofs.NoMemoData.selector);
        controller.execute(_proofWith(TX_ID, "", o), "");
    }

    function test_revertsWhenFdcRejectsTheProof() public {
        fdc.setResult(false);
        bytes memory payload = _instruction(account, 0, _depositCalls());

        vm.expectRevert(Proofs.InvalidProof.selector);
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);
    }

    // --- replay and nonces -------------------------------------------------------------

    function test_revertsOnReplayOfSameTransactionId() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());
        vm.prank(executor);
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);

        bytes memory second = _instruction(account, 1, _depositCalls());
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Execution.TransactionAlreadyUsed.selector, TX_ID));
        controller.execute(_proof(TX_ID, _commitMemo(0, second)), second);
    }

    function test_revertsOnWrongNonce() public {
        bytes memory payload = _instruction(account, 5, _depositCalls());
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Execution.InvalidNonce.selector, 0, 5));
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);
    }

    function test_noncesAreIndependentPerAccount() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());
        vm.prank(executor);
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);

        string memory other = "rOtherSenderAddressXXXXXXXXXXXXXXXX";
        assertEq(controller.nonceOf(_accountFor(other)), 0, "other account untouched");
        assertEq(controller.nonceOf(account), 1);
    }

    // --- instruction binding -------------------------------------------------------------

    function test_revertsWhenInstructionSenderIsNotTheProvenAccount() public {
        address impostor = makeAddr("impostor");
        bytes memory payload = _instruction(impostor, 0, _depositCalls());

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(IMemoController.SenderMismatch.selector, account, impostor)
        );
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);
    }

    function test_revertsWhenCommitmentDoesNotMatchData() public {
        bytes memory committed = _instruction(account, 0, _depositCalls());
        bytes memory substituted = _instruction(account, 0, _oneCall(address(fxrp), 0, ""));

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IMemoController.CommitmentMismatch.selector,
                keccak256(committed),
                keccak256(substituted)
            )
        );
        controller.execute(_proof(TX_ID, _commitMemo(0, committed)), substituted);
    }

    function test_failingCallUnwindsTheWholeInstruction() public {
        RevertingTarget target = new RevertingTarget();
        IPersonalAccount.Call[] memory calls = new IPersonalAccount.Call[](2);
        calls[0] = IPersonalAccount.Call({
            target: address(fxrp),
            value: 0,
            data: abi.encodeCall(IERC20.approve, (address(vault), DEPOSIT))
        });
        calls[1] = IPersonalAccount.Call({
            target: address(target),
            value: 0,
            data: abi.encodeCall(RevertingTarget.boom, ())
        });
        bytes memory payload = _instruction(account, 0, calls);

        vm.prank(executor);
        vm.expectRevert();
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);

        assertEq(controller.nonceOf(account), 0, "nonce not advanced");
        assertFalse(controller.isXrplTransactionConsumed(TX_ID), "txid not consumed");
        assertEq(fxrp.allowance(account, address(vault)), 0, "approval rolled back");
    }

    // --- opcode discipline ---------------------------------------------------------------

    function test_revertsOnReservedOpcode() public {
        for (uint8 op = 0xf8; op <= 0xfb; ++op) {
            bytes memory memo = abi.encodePacked(_header(op, 1, uint64(0)), bytes32(0));
            vm.expectRevert(abi.encodeWithSelector(MemoCodec.ReservedOpcode.selector, op));
            controller.execute(_proof(bytes32(uint256(op)), memo), "");
        }
    }

    function test_revertsOnFsaOpcodes() public {
        uint8[4] memory fsa = [0xff, 0xfe, 0xd0, 0xd1];
        for (uint256 i = 0; i < fsa.length; ++i) {
            bytes memory memo = abi.encodePacked(_header(fsa[i], 1, uint64(0)), bytes32(0));
            vm.expectRevert(abi.encodeWithSelector(MemoCodec.UnknownOpcode.selector, fsa[i]));
            controller.execute(_proof(bytes32(uint256(0x100 + i)), memo), "");
        }
    }

    // --- pause ---------------------------------------------------------------------------

    function test_pauseBlocksExecution() public {
        vm.prank(pauser);
        admin.pause();

        bytes memory payload = _instruction(account, 0, _depositCalls());
        vm.prank(executor);
        vm.expectRevert(Pause.ContractPaused.selector);
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);

        vm.prank(pauser);
        admin.unpause();

        vm.prank(executor);
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);
        assertEq(vault.balanceOf(account), DEPOSIT);
    }

    // --- account isolation -----------------------------------------------------------------

    function test_onlyControllerMayDriveAnAccount() public {
        bytes memory payload = _instruction(account, 0, _depositCalls());
        vm.prank(executor);
        controller.execute(_proof(TX_ID, _commitMemo(0, payload)), payload);

        // The account only ever takes orders from the diamond, never from whoever relayed.
        vm.prank(executor);
        (bool feeOk, bytes memory feeErr) = account.call(
            abi.encodeWithSignature(
                "payExecutorFee(address,address,uint256)", address(fxrp), executor, uint256(1)
            )
        );
        assertFalse(feeOk, "direct payExecutorFee must fail");
        assertEq(
            feeErr,
            abi.encodeWithSelector(
                IPersonalAccount.OnlyController.selector, executor, address(diamond)
            ),
            "wrong revert"
        );

        vm.prank(executor);
        (bool opOk,) = account.call(
            abi.encodeWithSelector(
                bytes4(keccak256("executeUserOp((address,uint256,bytes)[])")), _depositCalls()
            )
        );
        assertFalse(opOk, "direct executeUserOp must fail");
    }
}
