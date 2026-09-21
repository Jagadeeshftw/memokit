// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title Governance
 * @notice Owner plus a timelock on economic parameters.
 * @dev Mirrors the split Flare Smart Accounts uses deliberately: fee setters are timelocked
 *      because they are economic decisions, executor rotation is not because a compromised
 *      executor key must be replaceable immediately.
 *
 *      Timelocked calls are keyed by `keccak256(msg.data)`, so scheduling commits to the exact
 *      arguments. The first owner call schedules; a second identical call after the delay
 *      executes and clears the schedule.
 */
library Governance {
    /// @custom:storage-location erc7201:memokit.Governance.State
    struct State {
        address owner;
        uint64 timelockDurationSeconds;
        /// @notice Set by `AdminFacet.initializeMemoKit`; the diamond constructor sets the
        ///         owner before that, so owner != 0 is not a usable "already set up" signal.
        bool initialized;
        mapping(bytes32 callHash => uint256 allowedAt) scheduled;
    }

    bytes32 internal constant STATE_POSITION =
        keccak256(abi.encode(uint256(keccak256("memokit.Governance.State")) - 1)) & ~bytes32(uint256(0xff));

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TimelockDurationSet(uint64 durationSeconds);
    event CallScheduled(bytes32 indexed callHash, uint256 allowedAt);
    event CallExecuted(bytes32 indexed callHash);

    error OnlyOwner(address caller);
    error AddressZero();
    error TimelockNotElapsed(bytes32 callHash, uint256 allowedAt);

    function checkOwner() internal view {
        require(msg.sender == getState().owner, OnlyOwner(msg.sender));
    }

    function setOwner(address _owner) internal {
        require(_owner != address(0), AddressZero());
        State storage state = getState();
        emit OwnershipTransferred(state.owner, _owner);
        state.owner = _owner;
    }

    function setTimelockDuration(uint64 _durationSeconds) internal {
        getState().timelockDurationSeconds = _durationSeconds;
        emit TimelockDurationSet(_durationSeconds);
    }

    /**
     * @notice Schedule-or-run gate for a timelocked owner call.
     * @dev Returns false on the scheduling pass so the caller skips the body, true once the
     *      delay has elapsed. A zero duration executes immediately, which keeps local and
     *      test deployments usable without special-casing.
     * @return _ready True when the call body should run.
     */
    function checkTimelock() internal returns (bool _ready) {
        checkOwner();
        State storage state = getState();
        if (state.timelockDurationSeconds == 0) {
            return true;
        }
        bytes32 callHash = keccak256(msg.data);
        uint256 allowedAt = state.scheduled[callHash];
        if (allowedAt == 0) {
            uint256 at = block.timestamp + state.timelockDurationSeconds;
            state.scheduled[callHash] = at;
            emit CallScheduled(callHash, at);
            return false;
        }
        require(block.timestamp >= allowedAt, TimelockNotElapsed(callHash, allowedAt));
        delete state.scheduled[callHash];
        emit CallExecuted(callHash);
        return true;
    }

    function getState() internal pure returns (State storage _state) {
        bytes32 position = STATE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _state.slot := position
        }
    }
}
