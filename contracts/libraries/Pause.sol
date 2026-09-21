// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title Pause
 * @notice Emergency stop with separate pauser and unpauser sets.
 * @dev Kept deliberately. Removing Flare's safety controls is not memokit's differentiator --
 *      the uncoupling from FAssets is.
 */
library Pause {
    /// @custom:storage-location erc7201:memokit.Pause.State
    struct State {
        bool paused;
        mapping(address => bool) pausers;
        mapping(address => bool) unpausers;
    }

    bytes32 internal constant STATE_POSITION =
        keccak256(abi.encode(uint256(keccak256("memokit.Pause.State")) - 1)) & ~bytes32(uint256(0xff));

    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event PauserSet(address indexed account, bool allowed);
    event UnpauserSet(address indexed account, bool allowed);

    error ContractPaused();
    error NotPauser(address caller);
    error NotUnpauser(address caller);

    function checkNotPaused() internal view {
        require(!getState().paused, ContractPaused());
    }

    function pause() internal {
        State storage state = getState();
        require(state.pausers[msg.sender], NotPauser(msg.sender));
        state.paused = true;
        emit Paused(msg.sender);
    }

    function unpause() internal {
        State storage state = getState();
        require(state.unpausers[msg.sender], NotUnpauser(msg.sender));
        state.paused = false;
        emit Unpaused(msg.sender);
    }

    function setPauser(address _account, bool _allowed) internal {
        getState().pausers[_account] = _allowed;
        emit PauserSet(_account, _allowed);
    }

    function setUnpauser(address _account, bool _allowed) internal {
        getState().unpausers[_account] = _allowed;
        emit UnpauserSet(_account, _allowed);
    }

    function getState() internal pure returns (State storage _state) {
        bytes32 position = STATE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _state.slot := position
        }
    }
}
