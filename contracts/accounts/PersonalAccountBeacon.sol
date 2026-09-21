// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IBeacon} from "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";

/**
 * @title PersonalAccountBeacon
 * @notice The upgrade beacon every personal account proxy reads from.
 *
 * @dev This exists as a standalone contract rather than a facet for one specific reason.
 *      The obvious design -- and the one Flare Smart Accounts uses -- is to make the
 *      controller diamond its own beacon, so account proxies call `implementation()` on it.
 *      That works right up until you try to cut memokit's facets into a diamond that already
 *      has an `implementation()` selector. Flare's does: `0x5c60da1b` is already taken on
 *      the live `MasterAccountController`. Cut memokit in there and every memokit account
 *      would silently delegate to Flare's `PersonalAccount`, which has neither
 *      `executeUserOp` nor `payExecutorFee` in the shape memokit calls them.
 *
 *      Splitting the beacon out removes `implementation()` from memokit's facet surface
 *      entirely, which is what makes `MemoControllerFacet` genuinely cuttable into a
 *      foreign diamond. Being a standalone contract, it may hold constructor state; the
 *      facets may not.
 *
 *      The beacon address is part of every account's CREATE2 init code, so replacing the
 *      beacon would move every account. It is therefore fixed at construction on memokit's
 *      side: upgrades go through {setImplementation}, never through a new beacon.
 */
contract PersonalAccountBeacon is IBeacon {
    /// @notice The memokit diamond. The only address allowed to upgrade the implementation.
    address public immutable controller;

    address private _implementation;

    event ImplementationSet(address indexed implementation);

    error OnlyController(address caller, address controller);
    error InvalidImplementation(address implementation);

    constructor(address _controller, address _initialImplementation) {
        require(_controller != address(0), InvalidImplementation(_controller));
        require(_initialImplementation.code.length > 0, InvalidImplementation(_initialImplementation));
        controller = _controller;
        _implementation = _initialImplementation;
        emit ImplementationSet(_initialImplementation);
    }

    /// @inheritdoc IBeacon
    function implementation() external view returns (address) {
        return _implementation;
    }

    /**
     * @notice Point every existing and future account at a new implementation.
     * @dev Reached only through the diamond's timelocked `setAccountImplementation`.
     */
    function setImplementation(address _newImplementation) external {
        require(msg.sender == controller, OnlyController(msg.sender, controller));
        require(_newImplementation.code.length > 0, InvalidImplementation(_newImplementation));
        _implementation = _newImplementation;
        emit ImplementationSet(_newImplementation);
    }
}
