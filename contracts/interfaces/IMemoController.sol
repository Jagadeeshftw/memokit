// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4 <0.9;

import {IXRPPayment} from "flare-periphery/coston2/IXRPPayment.sol";

/**
 * @title IMemoController
 * @notice The memokit execution entry point: an XRPL-originated instruction, proven by FDC,
 *         executed against assets the account already holds.
 */
interface IMemoController {
    /// @notice Emitted when an instruction executes successfully.
    event InstructionExecuted(
        address indexed account,
        bytes32 indexed transactionId,
        uint8 opcode,
        uint256 nonce,
        uint256 callCount
    );

    /// @notice Emitted when a previously flagged transaction id is retired without dispatch.
    event InstructionIgnored(address indexed account, bytes32 indexed transactionId);

    /// @notice Emitted when a management opcode (0xE0/0xE1/0xE2) is applied.
    event ManagementApplied(address indexed account, bytes32 indexed transactionId, uint8 opcode);

    /// @notice Emitted when an executor is paid for submitting.
    event ExecutorPaid(address indexed account, address indexed executor, address token, uint256 amount);

    /// @notice Reverts when the instruction's declared sender is not the proven account.
    error SenderMismatch(address expected, address actual);

    /// @notice Reverts when the out-of-band payload does not match the memo's commitment.
    error CommitmentMismatch(bytes32 expected, bytes32 actual);

    /// @notice Reverts when a memo asks for a fee but no fee token is configured.
    error FeeTokenNotSet(uint64 requestedFee);

    /**
     * @notice Execute an XRPL-originated instruction.
     * @dev Permissionless: anyone may submit. The attestation, not the caller, is the authority.
     * @param _proof FDC `XRPPayment` attestation of the XRPL Payment carrying the memo.
     * @param _data For opcode 0xFC, the ABI-encoded instruction the memo commits to. Ignored
     *              for every other opcode.
     */
    function execute(IXRPPayment.Proof calldata _proof, bytes calldata _data) external payable;

    /// @notice Current instruction nonce for an account.
    function nonceOf(address _account) external view returns (uint256);

    /// @notice Whether an XRPL transaction id has already driven an action.
    function isTransactionIdUsed(bytes32 _transactionId) external view returns (bool);

    /// @notice Whether a transaction id is flagged to be skipped for an account.
    function isIgnored(address _account, bytes32 _transactionId) external view returns (bool);

    /// @notice Pending fee override for `(account, transactionId)`, or 0 when unset.
    function replacementFeeOf(address _account, bytes32 _transactionId) external view returns (uint64);
}
