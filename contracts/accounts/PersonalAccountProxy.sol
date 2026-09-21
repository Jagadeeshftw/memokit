// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

/**
 * @title PersonalAccountProxy
 * @notice Beacon proxy for one personal account.
 *
 * @dev The beacon and the controller are deliberately separate addresses. Making the
 *      controller its own beacon -- Flare Smart Accounts' approach -- puts `implementation()`
 *      on the controller, which collides with any host diamond that already has one, and
 *      Flare's does. See {PersonalAccountBeacon} for the full reasoning.
 *
 *      All three constructor arguments are part of the CREATE2 init code, so the account
 *      address is a function of (beacon, controller, XRPL owner). Changing this contract, or
 *      anything it imports, moves every not-yet-deployed account;
 *      `test/AccountDerivation.t.sol` pins `keccak256(creationCode)` so that cannot happen
 *      silently.
 */
contract PersonalAccountProxy is BeaconProxy {
    bytes4 private constant INITIALIZE_SELECTOR = bytes4(keccak256("initialize(address,string)"));

    constructor(address _beacon, address _controller, string memory _xrplOwner)
        BeaconProxy(_beacon, abi.encodeWithSelector(INITIALIZE_SELECTOR, _controller, _xrplOwner))
    {}
}
