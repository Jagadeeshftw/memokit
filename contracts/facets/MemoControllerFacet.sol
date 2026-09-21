// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IXRPPayment} from "flare-periphery/coston2/IXRPPayment.sol";
import {IMemoController} from "../interfaces/IMemoController.sol";
import {IIPersonalAccount} from "../interfaces/IIPersonalAccount.sol";
import {IPersonalAccount} from "../interfaces/IPersonalAccount.sol";
import {Accounts} from "../libraries/Accounts.sol";
import {Execution} from "../libraries/Execution.sol";
import {Fees} from "../libraries/Fees.sol";
import {MemoCodec} from "../libraries/MemoCodec.sol";
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

        uint64 fee = Execution.resolveFee(address(account), transactionId, header.executorFee);
        _payExecutor(account, fee);

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
        bytes memory _payload
    ) private {
        (address sender, uint256 nonce, IPersonalAccount.Call[] memory calls) =
            MemoCodec.decodeInstruction(_payload);

        require(sender == address(_account), SenderMismatch(address(_account), sender));
        Execution.useNonce(address(_account), nonce);

        _account.executeUserOp{value: msg.value}(calls);

        emit InstructionExecuted(address(_account), _transactionId, _opcode, nonce, calls.length);
    }

    function _payExecutor(IIPersonalAccount _account, uint64 _fee) private {
        if (_fee == 0) {
            return;
        }
        address token = Fees.feeToken();
        require(token != address(0), FeeTokenNotSet(_fee));
        _account.payExecutorFee(token, msg.sender, _fee);
        emit ExecutorPaid(address(_account), msg.sender, token, _fee);
    }
}
