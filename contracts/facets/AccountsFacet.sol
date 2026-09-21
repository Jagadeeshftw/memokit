// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Accounts} from "../libraries/Accounts.sol";
import {PersonalAccountProxy} from "../accounts/PersonalAccountProxy.sol";

/**
 * @title AccountsFacet
 * @notice Account address derivation.
 *
 * @dev Deliberately does **not** expose `implementation()`. That selector belongs to
 *      {PersonalAccountBeacon}, a separate contract, precisely so memokit's facet surface
 *      does not collide with a host diamond that already has one -- Flare's does.
 */
contract AccountsFacet {
    /// @notice Beacon every account proxy reads its implementation from.
    function accountBeacon() external view returns (address) {
        return Accounts.getState().beacon;
    }

    /// @notice The deployed account for `_xrplOwner`, or the zero address if never used.
    function accountOf(string calldata _xrplOwner) external view returns (address) {
        return Accounts.getState().accounts[_xrplOwner];
    }

    /// @notice The address `_xrplOwner`'s account will have, whether or not it is deployed.
    function computeAccountAddress(string calldata _xrplOwner) external view returns (address) {
        return Accounts.computeAddress(_xrplOwner);
    }

    /**
     * @notice `keccak256` of the account proxy creation code.
     * @dev Every account address derives from this, so it is pinned in
     *      `test/AccountDerivation.t.sol`.
     */
    function accountProxyCodeHash() external pure returns (bytes32) {
        return keccak256(type(PersonalAccountProxy).creationCode);
    }
}
