// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

/**
 * @title PersonalAccountProxy
 * @notice Beacon proxy for one personal account. The controller is the beacon.
 *
 * @dev The constructor arguments are part of the CREATE2 init code, so the XRPL owner string
 *      is what makes each account address unique. Changing this contract -- or anything it
 *      imports -- changes every not-yet-deployed account address; `test/AccountDerivation.t.sol`
 *      pins `keccak256(creationCode)` so that can never happen silently.
 */
contract PersonalAccountProxy is BeaconProxy {
    bytes4 private constant INITIALIZE_SELECTOR = bytes4(keccak256("initialize(address,string)"));

    constructor(address _controller, string memory _xrplOwner)
        BeaconProxy(_controller, abi.encodeWithSelector(INITIALIZE_SELECTOR, _controller, _xrplOwner))
    {}
}
