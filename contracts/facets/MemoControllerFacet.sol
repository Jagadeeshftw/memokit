// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IXRPPayment} from "flare-periphery/coston2/IXRPPayment.sol";
import {IMemoController} from "../interfaces/IMemoController.sol";
import {IIPersonalAccount} from "../interfaces/IIPersonalAccount.sol";
import {IPersonalAccount} from "../interfaces/IPersonalAccount.sol";
import {Accounts} from "../libraries/Accounts.sol";
import {Execution} from "../libraries/Execution.sol";
import {MemoCodec} from "../libraries/MemoCodec.sol";
import {PostConditions} from "../libraries/PostConditions.sol";
import {IPostConditions} from "../interfaces/IPostConditions.sol";
import {Pause} from "../libraries/Pause.sol";
import {Proofs} from "../libraries/Proofs.sol";

/**
 * @title MemoControllerFacet
 * @notice Turns a proven XRPL Payment memo into calls against the sender's personal account.
 *
 * @dev This contract is the A2 drop-in unit. It is shaped so it can be cut into another
 *      EIP-2535 diamond -- Flare Smart Accounts' included -- without modification:
 *
 *        - every piece of state lives behind an ERC-7201 namespaced slot, so it cannot
 *          collide with a host diamond's layout;
 *        - it has no constructor and no immutables, so the deployed facet code is complete;
 *        - the only addresses in the execution path are two well-known constants (the Flare
 *          Contract Registry, via the periphery library, and the EIP-2470 singleton factory).
 *
 *      Ordering is deliberate and mirrors Flare's: the ignore flag is consumed *before* any
 *      memo parsing. If it were checked after, a memo that fails to parse could never be
 *      recovered from, because the recovery path itself would revert on the bad memo.
 *
 *      The executor fee is part of the committed payload, is paid in the token it names, and is
 *      paid only after every call has succeeded -- see `_payExecutor`. Nothing about it is
 *      configured on the controller, so an account never needs to hold an asset it is not moving.
 */
contract MemoControllerFacet is IMemoController {
    /// @inheritdoc IMemoController
    function execute(IXRPPayment.Proof calldata _proof, bytes calldata _data) external payable {
        Pause.checkNotPaused();

        bytes32 transactionId = _proof.data.requestBody.transactionId;

        // Validate the attestation first: nothing below may trust unproven data.
        (string calldata sourceAddress, bytes calldata memo) = Proofs.verify(_proof);

        IIPersonalAccount account = Accounts.getOrCreate(sourceAddress);

        // One XRPL transaction drives at most one action, whatever the outcome below.
        Execution.consume(transactionId);

        // Before any parsing -- see the note on ordering above.
        if (Execution.takeIgnoreFlag(address(account), transactionId)) {
            emit InstructionIgnored(address(account), transactionId);
            return;
        }

        MemoCodec.Header memory header = MemoCodec.readHeader(memo);
        require(!MemoCodec.isReserved(header.opcode), MemoCodec.ReservedOpcode(header.opcode));

        // Header bytes 2..9 are reserved. Rejecting rather than ignoring is deliberate: a wallet
        // built for Flare that puts a fee there would otherwise sign a payment that promises an
        // executor money the contract never intends to pay. This sits AFTER the ignore flag
        // above, so a memo rejected here can still be retired with 0xE0.
        require(header.executorFee == 0, HeaderFeeReserved(header.executorFee));

        if (header.opcode == MemoCodec.OP_EXEC_INLINE) {
            _executeInstruction(account, transactionId, header.opcode, memo[MemoCodec.HEADER_LENGTH:]);
        } else if (header.opcode == MemoCodec.OP_EXEC_COMMIT) {
            bytes32 expected = MemoCodec.commitment(memo);
            bytes32 actual = keccak256(_data);
            require(expected == actual, CommitmentMismatch(expected, actual));
            _executeInstruction(account, transactionId, header.opcode, _data);
        } else if (header.opcode == MemoCodec.OP_IGNORE) {
            Execution.setIgnore(address(account), MemoCodec.ignoreTarget(memo));
            emit ManagementApplied(address(account), transactionId, header.opcode);
        } else if (header.opcode == MemoCodec.OP_SET_NONCE) {
            Execution.setNonce(address(account), MemoCodec.newNonce(memo));
            emit ManagementApplied(address(account), transactionId, header.opcode);
        } else if (header.opcode == MemoCodec.OP_REPLACE_FEE) {
            (bytes32 target, uint64 newFee) = MemoCodec.replacementFee(memo);
            Execution.setReplacementFee(address(account), target, newFee);
            emit ManagementApplied(address(account), transactionId, header.opcode);
        } else {
            revert MemoCodec.UnknownOpcode(header.opcode);
        }
    }

    /// @inheritdoc IMemoController
    function nonceOf(address _account) external view returns (uint256) {
        return Execution.getState().nonces[_account];
    }

    /// @inheritdoc IMemoController
    function isXrplTransactionConsumed(bytes32 _transactionId) external view returns (bool) {
        return Execution.getState().usedTransactionIds[_transactionId];
    }

    /// @inheritdoc IMemoController
    function isIgnored(address _account, bytes32 _transactionId) external view returns (bool) {
        return Execution.getState().ignored[_account][_transactionId];
    }

    /// @inheritdoc IMemoController
    function replacementFeeOf(address _account, bytes32 _transactionId) external view returns (uint64) {
        uint64 stored = Execution.getState().replacementFee[_account][_transactionId];
        return stored == 0 ? 0 : stored - 1;
    }

    function _executeInstruction(
        IIPersonalAccount _account,
        bytes32 _transactionId,
        uint8 _opcode,
        bytes calldata _payload
    ) private {
        (
            address sender,
            uint256 nonce,
            address feeToken,
            uint256 feeAmount,
            IPersonalAccount.Call[] memory calls,
            IPostConditions.PostCondition[] memory postConditions
        ) = MemoCodec.decodeInstruction(_payload);

        require(sender == address(_account), SenderMismatch(address(_account), sender));
        Execution.useNonce(address(_account), nonce);

        // Resolved and validated before the calls run so a malformed fee fails cheaply, but paid
        // only after them: see `_payExecutor`.
        uint256 fee = Execution.resolveFee(address(_account), _transactionId, feeAmount);
        require(fee == 0 || feeToken != address(0), InvalidFee(feeToken, fee));

        // Balances any delta condition is measured against, read before anything moves.
        uint256[] memory before = PostConditions.snapshot(postConditions);

        _account.executeUserOp{value: msg.value}(calls);

        // Between the calls and the fee. A post-condition that fails reverts the whole
        // execution -- calls, nonce, replay mark and all -- and the executor is not paid for
        // having delivered an instruction that did not do what it promised.
        PostConditions.check(postConditions, before);

        _payExecutor(_account, feeToken, fee);

        emit InstructionExecuted(
            address(_account), _transactionId, _opcode, nonce, calls.length, postConditions.length
        );
    }

    /**
     * @dev Paid AFTER the calls, not before, for two reasons that both come from the fee being in
     *      the moved asset. First, the asset may not exist in the account until the calls have
     *      run: a swap or a borrow produces the token the fee is denominated in. Second, it makes
     *      "the executor is paid only if the instruction succeeded" structural rather than
     *      procedural: there is no ordering in which a failing call could leave the fee paid.
     *
     *      The cost is that an instruction which spends its whole balance leaves nothing for the
     *      fee, and then the whole execution reverts. That is the correct outcome -- the alternative
     *      is an executor working for free -- but it means a payload author must leave room.
     */
    function _payExecutor(IIPersonalAccount _account, address _token, uint256 _fee) private {
        if (_fee == 0) {
            return;
        }
        _account.payExecutorFee(_token, msg.sender, _fee);
        emit ExecutorPaid(address(_account), msg.sender, _token, _fee);
    }
}
