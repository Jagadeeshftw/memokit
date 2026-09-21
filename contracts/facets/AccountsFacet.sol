// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IBeacon} from "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";
import {Accounts} from "../libraries/Accounts.sol";
import {PersonalAccountProxy} from "../accounts/PersonalAccountProxy.sol";

/**
 * @title AccountsFacet
 * @notice Account address derivation, and the beacon every account proxy reads from.
 * @dev `implementation()` is on the hot path: each account proxy calls it on every
 *      delegatecall, so it stays a single storage read.
 */
contract AccountsFacet is IBeacon {
    /// @inheritdoc IBeacon
    function implementation() external view returns (address) {
        return Accounts.getState().implementation;
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
     * @dev Every account address derives from this. It is pinned in
     *      `test/AccountDerivation.t.sol` so a change to the proxy -- or to anything it
     *      imports -- cannot silently move every not-yet-deployed account.
     */
    function accountProxyCodeHash() external pure returns (bytes32) {
        return keccak256(type(PersonalAccountProxy).creationCode);
    }
}
