// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4 <0.9;

/**
 * @title IPersonalAccount
 * @notice User-facing surface of a memokit personal account.
 * @dev One account per XRPL address, deployed deterministically via CREATE2. The account
 *      holds assets; the controller executes calls against them on the owner's instruction.
 */
interface IPersonalAccount {
    /// @notice A single call in a user operation.
    struct Call {
        /// @notice Target contract address.
        address target;
        /// @notice Native value (wei) to send with the call.
        uint256 value;
        /// @notice Calldata for the target.
        bytes data;
    }

    /// @notice Emitted once per successful `executeUserOp`.
    event UserOpExecuted(uint256 callCount);

    /// @notice Emitted when the controller moves a token out to pay an executor.
    event ExecutorFeePaid(address indexed token, address indexed to, uint256 amount);

    /// @notice Reverts when a caller other than the controller invokes a controller-only method.
    error OnlyController(address caller, address controller);

    /// @notice Reverts when a call inside a user operation fails.
    /// @param index Index of the failing call within the batch.
    /// @param returnData Raw revert data from the target.
    error CallFailed(uint256 index, bytes returnData);

    /// @notice Reverts when a batch contains no calls.
    error EmptyBatch();

    /// @notice The XRPL address that owns this account.
    function xrplOwner() external view returns (string memory);

    /// @notice The controller (memokit diamond) authorised to execute against this account.
    function controller() external view returns (address);
}
