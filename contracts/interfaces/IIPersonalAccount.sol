// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4 <0.9;

import {IPersonalAccount} from "./IPersonalAccount.sol";

/**
 * @title IIPersonalAccount
 * @notice Controller-only surface of a personal account. Not for external consumers.
 */
interface IIPersonalAccount is IPersonalAccount {
    /**
     * @notice Initialise a freshly deployed account proxy.
     * @param _controller The controller (also the beacon).
     * @param _xrplOwner The XRPL address that owns this account.
     */
    function initialize(address _controller, string calldata _xrplOwner) external;

    /**
     * @notice Execute a batch of calls from the account's own context.
     * @dev Reverts the whole batch if any call fails.
     * @param _calls The calls to execute, in order.
     */
    function executeUserOp(Call[] calldata _calls) external payable;

    /**
     * @notice Transfer an ERC-20 out of the account. Used only to pay the executor fee.
     * @param _token The token to transfer.
     * @param _to The recipient.
     * @param _amount The amount, in the token's base units.
     */
    function payExecutorFee(address _token, address _to, uint256 _amount) external;
}
