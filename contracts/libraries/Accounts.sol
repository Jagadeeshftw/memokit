// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IIPersonalAccount} from "../interfaces/IIPersonalAccount.sol";
import {ISingletonFactory} from "../interfaces/ISingletonFactory.sol";
import {PersonalAccountProxy} from "../accounts/PersonalAccountProxy.sol";

/**
 * @title Accounts
 * @notice Deterministic per-XRPL-address account derivation and deployment.
 *
 * @dev Same construction Flare Smart Accounts uses: CREATE2 through the EIP-2470 singleton
 *      factory with a zero salt, where the XRPL owner string is part of the init code.
 *      Unlike Flare, the beacon is a separate contract rather than the controller itself.
 *
 *      The controller address is inside the init code, so a memokit account and an FSA account
 *      for the same XRPL address are different addresses. That is intended, but it does mean
 *      a user can hold balances in both.
 *
 *      The account address is a function of (beacon, controller, XRPL owner). Flare instead
 *      derives from (controller, XRPL owner) and makes the controller its own beacon; that
 *      is what forces `implementation()` onto the controller and breaks the drop-in path.
 *
 *      Flare freezes the proxy creation code as a hex constant so the derivation cannot drift.
 *      memokit instead builds with `bytecode_hash = "none"`, which removes the CBOR metadata
 *      that made their constant necessary, and pins `keccak256(creationCode)` in
 *      `test/AccountDerivation.t.sol`. Freezing to a literal is a pre-mainnet task; see PHASE1.md.
 */
library Accounts {
    /// @custom:storage-location erc7201:memokit.Accounts.State
    struct State {
        /// @notice Beacon every account proxy reads its implementation from.
        /// @dev Part of the CREATE2 init code, so it is fixed at initialisation: replacing
        ///      it would move every account address. Upgrades go through the beacon itself.
        address beacon;
        /// @notice Cache of XRPL owner string to deployed account.
        mapping(string xrplOwner => address account) accounts;
    }

    bytes32 internal constant STATE_POSITION =
        keccak256(abi.encode(uint256(keccak256("memokit.Accounts.State")) - 1)) & ~bytes32(uint256(0xff));

    /// @notice EIP-2470 singleton factory, present at this address on every Flare network.
    address internal constant SINGLETON_FACTORY = 0xce0042B868300000d44A59004Da54A005ffdcf9f;

    event AccountCreated(address indexed account, string xrplOwner);
    event BeaconSet(address indexed beacon);

    error InvalidBeacon(address beacon);
    error BeaconAlreadySet(address beacon);
    error AccountNotDeployed(address expected);

    /// @dev Settable once. See the note on {State.beacon}.
    function setBeacon(address _beacon) internal {
        State storage state = getState();
        require(state.beacon == address(0), BeaconAlreadySet(state.beacon));
        require(_beacon.code.length > 0, InvalidBeacon(_beacon));
        state.beacon = _beacon;
        emit BeaconSet(_beacon);
    }

    /// @notice Init code for the account proxy owned by `_xrplOwner`.
    /// @dev `address(this)` resolves to the diamond, because facets run by delegatecall.
    function initCode(string memory _xrplOwner) internal view returns (bytes memory) {
        return abi.encodePacked(
            type(PersonalAccountProxy).creationCode,
            abi.encode(getState().beacon, address(this), _xrplOwner)
        );
    }

    /// @notice Address the account for `_xrplOwner` will have, whether or not it is deployed.
    function computeAddress(string memory _xrplOwner) internal view returns (address) {
        return Create2.computeAddress(bytes32(0), keccak256(initCode(_xrplOwner)), SINGLETON_FACTORY);
    }

    /// @notice Return the account for `_xrplOwner`, deploying it on first use.
    function getOrCreate(string memory _xrplOwner) internal returns (IIPersonalAccount) {
        State storage state = getState();
        address cached = state.accounts[_xrplOwner];
        if (cached != address(0)) {
            return IIPersonalAccount(payable(cached));
        }

        bytes memory code = initCode(_xrplOwner);
        address account = Create2.computeAddress(bytes32(0), keccak256(code), SINGLETON_FACTORY);
        if (account.code.length == 0) {
            ISingletonFactory(SINGLETON_FACTORY).deploy(code, bytes32(0));
            require(account.code.length > 0, AccountNotDeployed(account));
        }

        state.accounts[_xrplOwner] = account;
        emit AccountCreated(account, _xrplOwner);
        return IIPersonalAccount(payable(account));
    }

    function getState() internal pure returns (State storage _state) {
        bytes32 position = STATE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _state.slot := position
        }
    }
}
